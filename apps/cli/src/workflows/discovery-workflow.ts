import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { CodexBatchDiscoveryAdapter } from '@opsense/ai-codex';
import { NoopBatchDiscoveryAdapter } from '@opsense/ai-provider';
import type { BatchDiscoveryAdapter } from '@opsense/ai-provider';
import { buildBatchDiscoveryInput } from '@opsense/discovery';
import {
  BatchDiscoveryArtifactSchema,
  DeploymentCandidateSetSchema,
  PipelineRunSchema,
  ResourceGraphSchema,
  RunMetricsSchema,
  ScanSnapshotSchema,
  assertSchema,
} from '@opsense/schema';
import type {
  BatchDiscoveryArtifact,
  BatchDiscoveryInput,
  DeploymentCandidateSet,
  PipelineRun,
  ResourceGraph,
  RunMetrics,
  ScanSnapshot,
} from '@opsense/schema';
import {
  createRunWorkspaceLayout,
  ensureRunWorkspace,
  loadConfig,
  writeJsonAtomic,
} from '@opsense/workspace';
import type { RunWorkspaceLayout } from '@opsense/workspace';

import type { ScanStageHandler } from './scan-workflow.js';

export interface DiscoveryWorkflowOptions {
  config?: string;
  maxRetries?: number;
  model?: string;
  provider: string;
  scan: string;
  signal?: AbortSignal;
  threadId?: string;
  timeoutMs: number;
  workspace?: string;
}

export interface DiscoveryWorkflowDependencies {
  createAdapter?: (name: string) => BatchDiscoveryAdapter;
  now?: () => Date;
}

export interface DiscoveryWorkflowResult {
  artifact: BatchDiscoveryArtifact;
  candidateSet: DeploymentCandidateSet;
  input: BatchDiscoveryInput;
  layout: RunWorkspaceLayout;
  metrics: RunMetrics;
  pipelineRun: PipelineRun;
}

export async function runDiscoveryWorkflow(
  options: DiscoveryWorkflowOptions,
  onStage?: ScanStageHandler,
  dependencies: DiscoveryWorkflowDependencies = {},
): Promise<DiscoveryWorkflowResult> {
  const now = dependencies.now ?? (() => new Date());
  const loaded = await loadConfig({
    ...(options.config === undefined ? {} : { explicitPath: options.config }),
    ...(options.workspace === undefined ? {} : { workspaceRoot: options.workspace }),
  });
  const workspaceRoot = options.workspace ?? loaded.config.workspace.rootDirectory;
  const layout = createRunWorkspaceLayout(options.scan, workspaceRoot);
  await ensureRunWorkspace(options.scan, workspaceRoot);
  const [snapshot, graph, candidateSet, pipelineRun, metrics] = await Promise.all([
    readJson<ScanSnapshot>(layout.snapshotFile, ScanSnapshotSchema),
    readJson<ResourceGraph>(layout.resourceGraphFile, ResourceGraphSchema),
    readJson<DeploymentCandidateSet>(layout.candidateSetFile, DeploymentCandidateSetSchema),
    readJson<PipelineRun>(layout.pipelineRunFile, PipelineRunSchema),
    readJson<RunMetrics>(layout.metricsFile, RunMetricsSchema),
  ]);
  assertConsistentSources(options.scan, snapshot, graph, candidateSet, pipelineRun);
  const input = buildBatchDiscoveryInput(snapshot, graph, candidateSet, pipelineRun.budgets);
  await writeJsonAtomic(layout.discoveryInputFile, input);
  await onStage?.('discovering');
  const adapter = (dependencies.createAdapter ?? createAdapter)(options.provider);
  const artifact = await adapter.discover(input, {
    maxCalls: pipelineRun.budgets.maxAiCalls,
    maxRetries: options.maxRetries ?? loaded.config.ai.maxRetries,
    timeoutMs: options.timeoutMs,
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.threadId === undefined ? {} : { threadId: options.threadId }),
  });
  assertSchema(BatchDiscoveryArtifactSchema, artifact);
  const updatedMetrics = applyDiscoveryMetrics(metrics, artifact, now);
  const updatedPipeline = applyDiscoveryCheckpoint(pipelineRun, layout, artifact, now);
  await Promise.all([
    writeJsonAtomic(layout.discoveryFile, artifact),
    writeJsonAtomic(layout.metricsFile, updatedMetrics),
    writeJsonAtomic(layout.pipelineRunFile, updatedPipeline),
  ]);
  return {
    artifact,
    candidateSet,
    input,
    layout,
    metrics: updatedMetrics,
    pipelineRun: updatedPipeline,
  };
}

export function createAdapter(name: string): BatchDiscoveryAdapter {
  if (name === 'codex') return new CodexBatchDiscoveryAdapter();
  if (name === 'noop' || name === 'baseline') return new NoopBatchDiscoveryAdapter();
  throw new Error(`Unsupported Batch Discovery provider '${name}'.`);
}

function applyDiscoveryMetrics(
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
  metrics.discovery.finalServiceCount = artifact.decision.services.length;
  metrics.stages = [
    ...metrics.stages.filter((stage) => stage.stage !== 'discovering'),
    {
      durationMs: artifact.run.durationMs,
      finishedAt: artifact.run.finishedAt,
      stage: 'discovering',
      startedAt: artifact.run.startedAt,
      status: artifact.run.status === 'completed' ? 'completed' : 'failed',
    },
  ];
  metrics.generatedAt = now().toISOString();
  assertSchema(RunMetricsSchema, metrics);
  return metrics;
}

function applyDiscoveryCheckpoint(
  source: PipelineRun,
  layout: RunWorkspaceLayout,
  artifact: BatchDiscoveryArtifact,
  now: () => Date,
): PipelineRun {
  const at = now().toISOString();
  const pipelineRun: PipelineRun = {
    ...structuredClone(source),
    completedStages: [
      ...source.completedStages.filter((stage) => stage.stage !== 'discovering'),
      {
        finishedAt: artifact.run.finishedAt,
        outputHash: hashJson(artifact.decision),
        sourceHash: artifact.decision.sourceCandidateSetHash,
        stage: 'discovering',
      },
    ],
    currentStage: 'discovering',
    outputFiles: [
      ...new Set([...source.outputFiles, layout.discoveryInputFile, layout.discoveryFile]),
    ],
    state: 'inventory_ready',
    updatedAt: at,
  };
  assertSchema(PipelineRunSchema, pipelineRun);
  return pipelineRun;
}

function assertConsistentSources(
  scanId: string,
  snapshot: ScanSnapshot,
  graph: ResourceGraph,
  candidateSet: DeploymentCandidateSet,
  pipelineRun: PipelineRun,
): void {
  const sourceIds = [
    snapshot.session.id,
    graph.sourceScanId,
    candidateSet.sourceScanId,
    pipelineRun.runId,
  ];
  if (sourceIds.some((id) => id !== scanId)) {
    throw new Error(`Mismatched v3 discovery sources for scan '${scanId}'.`);
  }
  if (candidateSet.graphId !== graph.graphId) {
    throw new Error('Candidate set does not reference the persisted Resource Graph.');
  }
}

async function readJson<TValue>(
  file: string,
  schema: Parameters<typeof assertSchema>[0],
): Promise<TValue> {
  const value = JSON.parse(await readFile(file, 'utf8')) as unknown;
  assertSchema(schema as Parameters<typeof assertSchema>[0], value);
  return value as TValue;
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
