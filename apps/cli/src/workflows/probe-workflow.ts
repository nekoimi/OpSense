import { createHash } from 'node:crypto';

import { CodexBatchDiscoveryAdapter } from '@opsense/ai-codex';
import { NoopBatchDiscoveryAdapter } from '@opsense/ai-provider';
import type { BatchReconciliationAdapter } from '@opsense/ai-provider';
import { executeGovernedProbeBatch } from '@opsense/collectors';
import { normalizeAndMergeServices } from '@opsense/core';
import { compileGovernedProbePlan } from '@opsense/discovery';
import { redactSnapshot } from '@opsense/redaction';
import {
  BatchReconciliationInputSchema,
  PipelineRunSchema,
  RunMetricsSchema,
  ScanSnapshotSchema,
  assertSchema,
} from '@opsense/schema';
import type {
  BatchDiscoveryArtifact,
  BatchReconciliationInput,
  GovernedProbePlan,
  PipelineRun,
  ProbeBatchResult,
  RunMetrics,
  ScanSnapshot,
} from '@opsense/schema';
import { writeJsonAtomic } from '@opsense/workspace';

import type { DiscoveryWorkflowResult } from './discovery-workflow.js';
import type { ScanStageHandler, ScanWorkflowResult } from './scan-workflow.js';

export interface ProbeWorkflowOptions {
  maxRetries?: number;
  model?: string;
  provider: string;
  signal?: AbortSignal;
  timeoutMs: number;
}

export interface ProbeWorkflowDependencies {
  createReconciliationAdapter?: (name: string) => BatchReconciliationAdapter;
  executeBatch?: typeof executeGovernedProbeBatch;
  now?: () => Date;
}

export interface ProbeWorkflowResult {
  discovery: BatchDiscoveryArtifact;
  metrics: RunMetrics;
  pipelineRun: PipelineRun;
  plan: GovernedProbePlan;
  probeBatch: ProbeBatchResult;
  reconciliationInput?: BatchReconciliationInput;
  snapshot: ScanSnapshot;
}

export async function runProbeWorkflow(
  options: ProbeWorkflowOptions,
  scan: ScanWorkflowResult,
  discovery: DiscoveryWorkflowResult,
  onStage?: ScanStageHandler,
  dependencies: ProbeWorkflowDependencies = {},
): Promise<ProbeWorkflowResult> {
  if (scan.executor === undefined)
    throw new Error('Probe workflow requires a retained SSH executor.');
  const now = dependencies.now ?? (() => new Date());
  const plan = compileGovernedProbePlan(
    discovery.input,
    discovery.artifact.decision,
    scan.snapshot,
    {
      limits: { maxRequests: discovery.pipelineRun.budgets.maxProbeRequests },
      now,
    },
  );
  await writeJsonAtomic(scan.layout.probePlanFile, plan);
  await onStage?.('probing');
  const executeBatch = dependencies.executeBatch ?? executeGovernedProbeBatch;
  const executed = await executeBatch(scan.executor, plan, {
    maxDurationMs: Math.min(options.timeoutMs, discovery.pipelineRun.budgets.maxSessionDurationMs),
    opsenseVersion: scan.snapshot.session.opsenseVersion,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  await writeJsonAtomic(scan.layout.probeResultFile, executed.batch);
  const snapshot = await persistProbeEvidence(scan, executed.execution, now);
  const metricsAfterProbe = applyProbeMetrics(discovery.metrics, plan, executed.batch, now);
  const pipelineAfterProbe = applyStageCheckpoint(
    discovery.pipelineRun,
    'probing',
    hashJson(plan),
    hashJson(executed.batch),
    [scan.layout.probePlanFile, scan.layout.probeResultFile],
    now,
  );
  await Promise.all([
    writeJsonAtomic(scan.layout.metricsFile, metricsAfterProbe),
    writeJsonAtomic(scan.layout.pipelineRunFile, pipelineAfterProbe),
  ]);

  if (plan.requests.length === 0 || executed.batch.evidenceIds.length === 0) {
    return {
      discovery: discovery.artifact,
      metrics: metricsAfterProbe,
      pipelineRun: pipelineAfterProbe,
      plan,
      probeBatch: executed.batch,
      snapshot,
    };
  }
  const remainingCalls = Math.max(
    0,
    pipelineAfterProbe.budgets.maxAiCalls - discovery.artifact.run.callCount,
  );
  if (remainingCalls === 0) {
    return {
      discovery: discovery.artifact,
      metrics: metricsAfterProbe,
      pipelineRun: pipelineAfterProbe,
      plan,
      probeBatch: executed.batch,
      snapshot,
    };
  }
  const reconciliationInput: BatchReconciliationInput = {
    contractVersion: 'batch-reconciliation-v1',
    discoveryInput: discovery.input,
    newEvidence: snapshot.evidence
      .filter((item) => executed.batch.evidenceIds.includes(item.id))
      .map((item) => ({
        id: item.id,
        kind: item.kind,
        source: item.source,
        status: item.status,
        value: item.value,
        ...(item.field === undefined ? {} : { field: item.field }),
      })),
    originalDecision: discovery.artifact.decision,
    probeBatch: executed.batch,
    probePlan: plan,
  };
  assertSchema(BatchReconciliationInputSchema, reconciliationInput);
  await writeJsonAtomic(scan.layout.reconciliationInputFile, reconciliationInput);
  await onStage?.('reconciling');
  const adapter = (dependencies.createReconciliationAdapter ?? createReconciliationAdapter)(
    options.provider,
  );
  const reconciled = await adapter.reconcile(reconciliationInput, {
    maxCalls: remainingCalls,
    timeoutMs: options.timeoutMs,
    ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(discovery.artifact.run.threadId === undefined
      ? {}
      : { threadId: discovery.artifact.run.threadId }),
  });
  await writeJsonAtomic(scan.layout.reconciliationFile, reconciled);
  const finalMetrics = applyReconciliationMetrics(metricsAfterProbe, reconciled, now);
  const finalPipeline = applyStageCheckpoint(
    pipelineAfterProbe,
    'reconciling',
    hashJson(reconciliationInput),
    hashJson(reconciled),
    [scan.layout.reconciliationInputFile, scan.layout.reconciliationFile],
    now,
  );
  await Promise.all([
    writeJsonAtomic(scan.layout.metricsFile, finalMetrics),
    writeJsonAtomic(scan.layout.pipelineRunFile, finalPipeline),
  ]);
  return {
    discovery: reconciled,
    metrics: finalMetrics,
    pipelineRun: finalPipeline,
    plan,
    probeBatch: executed.batch,
    reconciliationInput,
    snapshot,
  };
}

function createReconciliationAdapter(name: string): BatchReconciliationAdapter {
  if (name === 'codex') return new CodexBatchDiscoveryAdapter();
  if (name === 'noop' || name === 'baseline') return new NoopBatchDiscoveryAdapter();
  throw new Error(`Unsupported Reconciliation provider '${name}'.`);
}

async function persistProbeEvidence(
  scan: ScanWorkflowResult,
  execution: Awaited<ReturnType<typeof executeGovernedProbeBatch>>['execution'],
  now: () => Date,
): Promise<ScanSnapshot> {
  const normalized = normalizeAndMergeServices({
    artifacts: [...scan.snapshot.artifacts, ...execution.artifacts],
    collectedAt: now().toISOString(),
    composeProjects: scan.snapshot.composeProjects,
    containers: scan.snapshot.containers,
    evidence: [...scan.snapshot.evidence, ...execution.evidence],
    opsenseVersion: scan.snapshot.session.opsenseVersion,
    processes: scan.snapshot.processes,
    sockets: scan.snapshot.sockets,
    systemdUnits: scan.snapshot.systemdUnits,
    unknowns: scan.snapshot.unknowns,
  });
  const enriched: ScanSnapshot = {
    ...scan.snapshot,
    artifacts: normalized.artifacts,
    evidence: normalized.evidence,
    services: normalized.services,
    session: { ...scan.snapshot.session, finishedAt: now().toISOString() },
  };
  const redacted = redactSnapshot(enriched, now);
  assertSchema(ScanSnapshotSchema, redacted.value);
  await Promise.all([
    writeJsonAtomic(scan.layout.snapshotFile, redacted.value),
    writeJsonAtomic(scan.layout.metaFile, redacted.value.session),
    writeJsonAtomic(scan.layout.redactionReportFile, redacted.report),
  ]);
  return redacted.value;
}

function applyProbeMetrics(
  source: RunMetrics,
  plan: GovernedProbePlan,
  batch: ProbeBatchResult,
  now: () => Date,
): RunMetrics {
  const metrics = structuredClone(source);
  metrics.probes.requested += plan.audit.length;
  metrics.probes.accepted += plan.requests.length;
  metrics.probes.deduplicated += plan.audit.filter((item) => item.status === 'deduplicated').length;
  metrics.probes.rejected += plan.audit.filter((item) => item.status === 'rejected').length;
  metrics.probes.failed += batch.results.filter((item) => item.status === 'failed').length;
  metrics.probes.resolvedFields += batch.yield.resolvedFieldCount;
  metrics.probes.rounds = plan.requests.length > 0 ? 1 : metrics.probes.rounds;
  metrics.generatedAt = now().toISOString();
  assertSchema(RunMetricsSchema, metrics);
  return metrics;
}

function applyReconciliationMetrics(
  source: RunMetrics,
  artifact: BatchDiscoveryArtifact,
  now: () => Date,
): RunMetrics {
  const metrics = structuredClone(source);
  metrics.ai.calls += artifact.run.callCount;
  metrics.ai.cachedInputTokens += artifact.run.usage.cachedInputTokens;
  metrics.ai.durationMs += artifact.run.durationMs;
  metrics.ai.failedCalls += artifact.run.status === 'degraded' ? 1 : 0;
  metrics.ai.inputTokens += artifact.run.usage.inputTokens;
  metrics.ai.outputTokens += artifact.run.usage.outputTokens;
  metrics.ai.reasoningTokens += artifact.run.usage.reasoningTokens;
  metrics.ai.repairs += artifact.run.repairCount;
  metrics.generatedAt = now().toISOString();
  assertSchema(RunMetricsSchema, metrics);
  return metrics;
}

function applyStageCheckpoint(
  source: PipelineRun,
  stage: 'probing' | 'reconciling',
  sourceHash: string,
  outputHash: string,
  outputFiles: string[],
  now: () => Date,
): PipelineRun {
  const at = now().toISOString();
  const result: PipelineRun = {
    ...structuredClone(source),
    completedStages: [
      ...source.completedStages.filter((item) => item.stage !== stage),
      { finishedAt: at, outputHash, sourceHash, stage },
    ],
    currentStage: stage,
    outputFiles: [...new Set([...source.outputFiles, ...outputFiles])],
    state: 'inventory_ready',
    updatedAt: at,
  };
  assertSchema(PipelineRunSchema, result);
  return result;
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
