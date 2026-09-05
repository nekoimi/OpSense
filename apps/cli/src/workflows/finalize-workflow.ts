import { createHash } from 'node:crypto';

import { CodexBatchDiscoveryAdapter } from '@opsense/ai-codex';
import { NoopBatchDiscoveryAdapter } from '@opsense/ai-provider';
import type { WikiComposer } from '@opsense/ai-provider';
import { buildFinalDeploymentInventory } from '@opsense/discovery';
import { generateV3Reports } from '@opsense/report';
import type { V3ReportArtifacts } from '@opsense/report';
import {
  DeploymentInventorySchema,
  PipelineRunSchema,
  RunMetricsSchema,
  WikiCompositionArtifactSchema,
  assertSchema,
} from '@opsense/schema';
import type {
  BatchDiscoveryArtifact,
  DeploymentInventory,
  PipelineRun,
  RunMetrics,
  WikiCompositionArtifact,
} from '@opsense/schema';
import { buildWikiProjectionV3 } from '@opsense/wiki';
import { createReportDirectory, writeJsonAtomic } from '@opsense/workspace';

import type { DiscoveryWorkflowResult } from './discovery-workflow.js';
import type { ScanStageHandler, ScanWorkflowResult } from './scan-workflow.js';

export interface FinalizeWorkflowOptions {
  maxRetries?: number;
  model?: string;
  provider: string;
  signal?: AbortSignal;
  timeoutMs: number;
}

export interface FinalizeWorkflowDependencies {
  createWikiComposer?: (name: string) => WikiComposer;
  generateReports?: typeof generateV3Reports;
  now?: () => Date;
}

export interface FinalizeWorkflowResult {
  composition: WikiCompositionArtifact;
  inventory: DeploymentInventory;
  metrics: RunMetrics;
  pipelineRun: PipelineRun;
  reports: V3ReportArtifacts;
}

export async function runFinalizeWorkflow(
  options: FinalizeWorkflowOptions,
  scan: ScanWorkflowResult,
  discoveryContext: DiscoveryWorkflowResult,
  decision: BatchDiscoveryArtifact,
  snapshot = scan.snapshot,
  onStage?: ScanStageHandler,
  dependencies: FinalizeWorkflowDependencies = {},
): Promise<FinalizeWorkflowResult> {
  const now = dependencies.now ?? (() => new Date());
  const inventory = buildFinalDeploymentInventory(
    snapshot,
    scan.resourceGraph,
    scan.candidateSet,
    decision,
    { now },
  );
  assertSchema(DeploymentInventorySchema, inventory);
  await writeJsonAtomic(scan.layout.inventoryFile, inventory);
  await onStage?.('composing');
  const composer = (dependencies.createWikiComposer ?? createWikiComposer)(options.provider);
  const remainingCalls = Math.max(
    0,
    discoveryContext.pipelineRun.budgets.maxAiCalls - discoveryContext.metrics.ai.calls,
  );
  const narrativeResult = await composer.compose(inventory, {
    maxCalls: remainingCalls,
    timeoutMs: options.timeoutMs,
    ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(decision.run.threadId === undefined ? {} : { threadId: decision.run.threadId }),
  });
  const wiki = buildWikiProjectionV3(inventory, narrativeResult.narrative, {
    now,
    requireNarrative: options.provider === 'codex',
  });
  const composition: WikiCompositionArtifact = {
    projection: wiki.projection,
    quality: wiki.quality,
    run: narrativeResult.run,
    schemaVersion: '3.0',
  };
  assertSchema(WikiCompositionArtifactSchema, composition);
  await Promise.all([
    writeJsonAtomic(scan.layout.wikiFile, wiki.projection),
    writeJsonAtomic(scan.layout.wikiCompositionFile, composition),
  ]);
  const afterComposition = applyCompositionMetrics(discoveryContext.metrics, composition, now);
  let pipelineRun = checkpoint(
    discoveryContext.pipelineRun,
    'composing',
    hashJson(inventory),
    hashJson(composition),
    [scan.layout.inventoryFile, scan.layout.wikiFile, scan.layout.wikiCompositionFile],
    now,
  );
  await onStage?.('reporting');
  const reportStartedAt = now();
  const reportDirectory = createReportDirectory(
    inventory.host.hostname,
    new Date(snapshot.session.startedAt),
    scan.workspaceRoot,
  );
  const reports = await (dependencies.generateReports ?? generateV3Reports)(
    inventory,
    wiki.projection,
    reportDirectory,
  );
  const reportFinishedAt = now();
  const metrics = structuredClone(afterComposition);
  metrics.report.durationMs += Math.max(0, reportFinishedAt.getTime() - reportStartedAt.getTime());
  metrics.report.generatedFiles += 3;
  metrics.report.qualityGateFailures += composition.quality.passed ? 0 : 1;
  metrics.generatedAt = reportFinishedAt.toISOString();
  assertSchema(RunMetricsSchema, metrics);
  pipelineRun = checkpoint(
    pipelineRun,
    'reporting',
    hashJson(wiki.projection),
    hashJson(reports),
    [reports.markdownFile, reports.htmlFile, reports.docxFile],
    now,
  );
  pipelineRun = {
    ...pipelineRun,
    finishedAt: now().toISOString(),
    state: composition.quality.passed ? 'completed' : 'partial',
    updatedAt: now().toISOString(),
  };
  assertSchema(PipelineRunSchema, pipelineRun);
  await Promise.all([
    writeJsonAtomic(scan.layout.metricsFile, metrics),
    writeJsonAtomic(scan.layout.pipelineRunFile, pipelineRun),
  ]);
  return { composition, inventory, metrics, pipelineRun, reports };
}

function createWikiComposer(name: string): WikiComposer {
  if (name === 'codex') return new CodexBatchDiscoveryAdapter();
  if (name === 'noop' || name === 'baseline') return new NoopBatchDiscoveryAdapter();
  throw new Error(`Unsupported Wiki Composer provider '${name}'.`);
}

function applyCompositionMetrics(
  source: RunMetrics,
  composition: WikiCompositionArtifact,
  now: () => Date,
): RunMetrics {
  const metrics = structuredClone(source);
  metrics.ai.calls += composition.run.callCount;
  metrics.ai.cachedInputTokens += composition.run.usage.cachedInputTokens;
  metrics.ai.durationMs += composition.run.durationMs;
  metrics.ai.failedCalls += composition.run.status === 'degraded' ? 1 : 0;
  metrics.ai.inputTokens += composition.run.usage.inputTokens;
  metrics.ai.outputTokens += composition.run.usage.outputTokens;
  metrics.ai.reasoningTokens += composition.run.usage.reasoningTokens;
  metrics.ai.repairs += composition.run.repairCount;
  metrics.discovery.finalServiceCount = composition.projection.services.length;
  metrics.generatedAt = now().toISOString();
  assertSchema(RunMetricsSchema, metrics);
  return metrics;
}

function checkpoint(
  source: PipelineRun,
  stage: 'composing' | 'reporting',
  sourceHash: string,
  outputHash: string,
  files: string[],
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
    outputFiles: [...new Set([...source.outputFiles, ...files])],
    state: 'running',
    updatedAt: at,
  };
  assertSchema(PipelineRunSchema, result);
  return result;
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
