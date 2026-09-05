import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { hashFiles, hashJson } from '@opsense/collection-runtime';
import { candidateSetHash, compileGovernedProbePlan } from '@opsense/discovery';
import { redactForReport } from '@opsense/redaction';
import { generateV3Reports } from '@opsense/report';
import type { V3ReportArtifacts } from '@opsense/report';
import {
  BatchDiscoveryArtifactSchema,
  BatchDiscoveryInputSchema,
  BatchReconciliationInputSchema,
  DeploymentCandidateSetSchema,
  DeploymentInventorySchema,
  EvidenceRecordSchema,
  GovernedProbePlanSchema,
  PipelineRunSchema,
  ProbeBatchResultSchema,
  ResourceGraphSchema,
  RunMetricsSchema,
  ScanSnapshotSchema,
  WikiCompositionArtifactSchema,
  WikiProjectionV3Schema,
  assertSchema,
} from '@opsense/schema';
import type {
  BatchDiscoveryArtifact,
  BatchDiscoveryInput,
  BatchReconciliationInput,
  DeploymentCandidateSet,
  DeploymentInventory,
  EvidenceRecord,
  GovernedProbePlan,
  PipelineRun,
  ProbeBatchResult,
  ResourceGraph,
  RunMetrics,
  ScanSnapshot,
  WikiCompositionArtifact,
  WikiProjectionV3,
} from '@opsense/schema';
import {
  createReportDirectory,
  createRunWorkspaceLayout,
  loadConfig,
  readJsonLines,
  writeJsonAtomic,
} from '@opsense/workspace';

import { runDiscoveryWorkflow, type DiscoveryWorkflowResult } from './discovery-workflow.js';
import { runFinalizeWorkflow, type FinalizeWorkflowResult } from './finalize-workflow.js';
import { createReconciliationAdapter } from './probe-workflow.js';
import type { ScanStageHandler, ScanWorkflowResult } from './scan-workflow.js';

export interface ResumeWorkflowOptions {
  config?: string;
  maxRetries?: number;
  model?: string;
  provider: string;
  run: string;
  signal?: AbortSignal;
  timeoutMs: number;
  workspace?: string;
}

export interface ResumeWorkflowDependencies {
  now?: () => Date;
  runDiscovery?: typeof runDiscoveryWorkflow;
  runFinalize?: typeof runFinalizeWorkflow;
}

export interface ResumeWorkflowResult {
  pipelineRun: PipelineRun;
  reports: V3ReportArtifacts;
  runId: string;
  status: 'already_complete' | 'resumed';
}

export class ResumeNeedsSshError extends Error {
  public readonly code = 'RESUME_NEEDS_SSH';

  public constructor(requestCount: number) {
    super(
      `Run requires ${requestCount} governed SSH probe request(s). Resume did not rerun completed stages; rerun with an SSH-capable inspect session or complete the probes first.`,
    );
    this.name = 'ResumeNeedsSshError';
  }
}

export async function runResumeWorkflow(
  options: ResumeWorkflowOptions,
  onStage?: ScanStageHandler,
  dependencies: ResumeWorkflowDependencies = {},
): Promise<ResumeWorkflowResult> {
  const now = dependencies.now ?? (() => new Date());
  const loaded = await loadConfig({
    ...(options.config === undefined ? {} : { explicitPath: options.config }),
    ...(options.workspace === undefined ? {} : { workspaceRoot: options.workspace }),
  });
  const workspaceRoot = options.workspace ?? loaded.config.workspace.rootDirectory;
  const layout = createRunWorkspaceLayout(options.run, workspaceRoot);
  const [pipelineRun, metrics, snapshot, graph, candidateSet, inventory, evidence] =
    await Promise.all([
      readJson<PipelineRun>(layout.pipelineRunFile, PipelineRunSchema),
      readJson<RunMetrics>(layout.metricsFile, RunMetricsSchema),
      readJson<ScanSnapshot>(layout.snapshotFile, ScanSnapshotSchema),
      readJson<ResourceGraph>(layout.resourceGraphFile, ResourceGraphSchema),
      readJson<DeploymentCandidateSet>(layout.candidateSetFile, DeploymentCandidateSetSchema),
      readJson<DeploymentInventory>(layout.inventoryFile, DeploymentInventorySchema),
      readJsonLines<EvidenceRecord>(layout.evidenceFile, EvidenceRecordSchema),
    ]);
  assertBaseArtifacts(options.run, pipelineRun, snapshot, graph, candidateSet, inventory, evidence);
  const validComposition = await loadValidComposition(pipelineRun, layout, inventory);
  let discovery =
    validComposition === undefined
      ? await loadValidDiscovery(pipelineRun, layout, candidateSet, metrics)
      : undefined;
  if (validComposition === undefined && discovery === undefined)
    requireCheckpoint(pipelineRun, 'inventory_ready', hashJson(inventory));
  const completedReports =
    validComposition === undefined
      ? undefined
      : await loadValidReports(pipelineRun, validComposition);
  if (completedReports !== undefined)
    return {
      pipelineRun,
      reports: completedReports,
      runId: options.run,
      status: 'already_complete',
    };

  const scan: ScanWorkflowResult = {
    candidateSet,
    config: loaded.config,
    layout,
    inventory,
    metrics,
    pipelineRun,
    resourceGraph: graph,
    scanId: options.run,
    snapshot,
    workspaceRoot: layout.rootDirectory,
  };
  if (validComposition !== undefined) {
    const resumed = await resumeReportStage(
      scan,
      validComposition,
      metrics,
      pipelineRun,
      now,
      onStage,
    );
    return { ...resumed, runId: options.run, status: 'resumed' };
  }

  if (discovery === undefined) {
    discovery = await (dependencies.runDiscovery ?? runDiscoveryWorkflow)(
      {
        provider: options.provider,
        scan: options.run,
        timeoutMs: options.timeoutMs,
        ...(options.config === undefined ? {} : { config: options.config }),
        ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
        ...(options.model === undefined ? {} : { model: options.model }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
      },
      onStage,
    );
  }

  if (pipelineRun.profile !== 'fast' && discovery.artifact.run.status === 'completed') {
    const validReconciliation = await loadValidReconciliation(discovery.pipelineRun, layout);
    if (validReconciliation !== undefined) {
      discovery = { ...discovery, artifact: validReconciliation };
    }
    const validProbe = await loadValidProbe(discovery.pipelineRun, layout);
    if (validProbe === undefined && validReconciliation === undefined) {
      const plan = compileGovernedProbePlan(
        discovery.input,
        discovery.artifact.decision,
        snapshot,
        {
          limits: { maxRequests: discovery.pipelineRun.budgets.maxProbeRequests },
          now,
        },
      );
      if (plan.requests.length > 0) {
        const partial = markNeedsSsh(discovery.pipelineRun, plan.requests.length, now);
        await writeJsonAtomic(layout.pipelineRunFile, partial);
        throw new ResumeNeedsSshError(plan.requests.length);
      }
    } else if (validProbe !== undefined && validReconciliation === undefined) {
      discovery = await resumeReconciliation(
        options,
        discovery,
        validProbe,
        snapshot,
        now,
        onStage,
      );
    }
  }

  const finalization = await (dependencies.runFinalize ?? runFinalizeWorkflow)(
    {
      provider: options.provider,
      timeoutMs: options.timeoutMs,
      ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
    { ...scan, metrics: discovery.metrics, pipelineRun: discovery.pipelineRun },
    discovery,
    discovery.artifact,
    snapshot,
    onStage,
  );
  return {
    pipelineRun: finalization.pipelineRun,
    reports: finalization.reports,
    runId: options.run,
    status: 'resumed',
  };
}

function assertBaseArtifacts(
  runId: string,
  pipelineRun: PipelineRun,
  snapshot: ScanSnapshot,
  graph: ResourceGraph,
  candidateSet: DeploymentCandidateSet,
  inventory: DeploymentInventory,
  evidence: EvidenceRecord[],
): void {
  if (
    pipelineRun.runId !== runId ||
    snapshot.session.id !== runId ||
    graph.sourceScanId !== runId ||
    candidateSet.sourceScanId !== runId ||
    inventory.sourceScanId !== runId
  ) {
    throw new Error(`Resume artifacts do not belong to run '${runId}'.`);
  }
  if (candidateSet.graphId !== graph.graphId)
    throw new Error('Resume candidate set does not reference the persisted Resource Graph.');
  const evidenceIds = evidence.map((item) => item.id);
  if (new Set(evidenceIds).size !== evidenceIds.length)
    throw new Error('Evidence Store contains duplicate Evidence IDs.');
  if (hashJson(sortEvidence(evidence)) !== hashJson(sortEvidence(snapshot.evidence)))
    throw new Error('Evidence Store and snapshot Evidence are inconsistent.');
  const stages = pipelineRun.completedStages.map((item) => item.stage);
  if (new Set(stages).size !== stages.length)
    throw new Error('Pipeline run contains duplicate stage checkpoints.');
}

function sortEvidence(evidence: readonly EvidenceRecord[]): EvidenceRecord[] {
  return [...evidence].sort((left, right) => left.id.localeCompare(right.id));
}

async function loadValidDiscovery(
  pipelineRun: PipelineRun,
  layout: ReturnType<typeof createRunWorkspaceLayout>,
  candidateSet: DeploymentCandidateSet,
  metrics: RunMetrics,
): Promise<DiscoveryWorkflowResult | undefined> {
  const checkpoint = checkpointFor(pipelineRun, 'discovering');
  if (checkpoint === undefined) return undefined;
  try {
    const [input, artifact] = await Promise.all([
      readJson<BatchDiscoveryInput>(layout.discoveryInputFile, BatchDiscoveryInputSchema),
      readJson<BatchDiscoveryArtifact>(layout.discoveryFile, BatchDiscoveryArtifactSchema),
    ]);
    if (
      checkpoint.sourceHash !== candidateSetHash(candidateSet) ||
      checkpoint.sourceHash !== input.sourceCandidateSetHash ||
      checkpoint.sourceHash !== artifact.decision.sourceCandidateSetHash ||
      checkpoint.outputHash !== hashJson(artifact.decision)
    ) {
      return undefined;
    }
    return { artifact, candidateSet, input, layout, metrics, pipelineRun };
  } catch {
    return undefined;
  }
}

async function loadValidProbe(
  pipelineRun: PipelineRun,
  layout: ReturnType<typeof createRunWorkspaceLayout>,
): Promise<{ batch: ProbeBatchResult; plan: GovernedProbePlan } | undefined> {
  const checkpoint = checkpointFor(pipelineRun, 'probing');
  if (checkpoint === undefined) return undefined;
  try {
    const [plan, batch] = await Promise.all([
      readJson<GovernedProbePlan>(layout.probePlanFile, GovernedProbePlanSchema),
      readJson<ProbeBatchResult>(layout.probeResultFile, ProbeBatchResultSchema),
    ]);
    return checkpoint.sourceHash === hashJson(plan) && checkpoint.outputHash === hashJson(batch)
      ? { batch, plan }
      : undefined;
  } catch {
    return undefined;
  }
}

async function loadValidReconciliation(
  pipelineRun: PipelineRun,
  layout: ReturnType<typeof createRunWorkspaceLayout>,
): Promise<BatchDiscoveryArtifact | undefined> {
  const checkpoint = checkpointFor(pipelineRun, 'reconciling');
  if (checkpoint === undefined) return undefined;
  try {
    const [input, artifact] = await Promise.all([
      readJson<BatchReconciliationInput>(
        layout.reconciliationInputFile,
        BatchReconciliationInputSchema,
      ),
      readJson<BatchDiscoveryArtifact>(layout.reconciliationFile, BatchDiscoveryArtifactSchema),
    ]);
    return checkpoint.sourceHash === hashJson(input) && checkpoint.outputHash === hashJson(artifact)
      ? artifact
      : undefined;
  } catch {
    return undefined;
  }
}

async function resumeReconciliation(
  options: ResumeWorkflowOptions,
  discovery: DiscoveryWorkflowResult,
  probe: { batch: ProbeBatchResult; plan: GovernedProbePlan },
  snapshot: ScanSnapshot,
  now: () => Date,
  onStage?: ScanStageHandler,
): Promise<DiscoveryWorkflowResult> {
  const remainingCalls = Math.max(
    0,
    discovery.pipelineRun.budgets.maxAiCalls - discovery.metrics.ai.calls,
  );
  if (probe.batch.evidenceIds.length === 0 || remainingCalls === 0) return discovery;
  const input: BatchReconciliationInput = {
    contractVersion: 'batch-reconciliation-v1',
    discoveryInput: discovery.input,
    newEvidence: snapshot.evidence
      .filter((item) => probe.batch.evidenceIds.includes(item.id))
      .map((item) => ({
        id: item.id,
        kind: item.kind,
        source: item.source,
        status: item.status,
        value: item.value,
        ...(item.field === undefined ? {} : { field: item.field }),
      })),
    originalDecision: discovery.artifact.decision,
    probeBatch: probe.batch,
    probePlan: probe.plan,
  };
  assertSchema(BatchReconciliationInputSchema, input);
  await writeJsonAtomic(discovery.layout.reconciliationInputFile, input);
  await onStage?.('reconciling');
  const artifact = await createReconciliationAdapter(options.provider).reconcile(input, {
    maxCalls: remainingCalls,
    timeoutMs: options.timeoutMs,
    ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(discovery.artifact.run.threadId === undefined
      ? {}
      : { threadId: discovery.artifact.run.threadId }),
  });
  assertSchema(BatchDiscoveryArtifactSchema, artifact);
  const metrics = structuredClone(discovery.metrics);
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
  const at = now().toISOString();
  const pipelineRun: PipelineRun = {
    ...structuredClone(discovery.pipelineRun),
    completedStages: [
      ...discovery.pipelineRun.completedStages.filter((item) => item.stage !== 'reconciling'),
      {
        finishedAt: at,
        outputHash: hashJson(artifact),
        sourceHash: hashJson(input),
        stage: 'reconciling',
      },
    ],
    currentStage: 'reconciling',
    outputFiles: [
      ...new Set([
        ...discovery.pipelineRun.outputFiles,
        discovery.layout.reconciliationInputFile,
        discovery.layout.reconciliationFile,
      ]),
    ],
    state: 'inventory_ready',
    updatedAt: at,
  };
  delete pipelineRun.lastError;
  assertSchema(PipelineRunSchema, pipelineRun);
  await Promise.all([
    writeJsonAtomic(discovery.layout.reconciliationFile, artifact),
    writeJsonAtomic(discovery.layout.metricsFile, metrics),
    writeJsonAtomic(discovery.layout.pipelineRunFile, pipelineRun),
  ]);
  return { ...discovery, artifact, metrics, pipelineRun };
}

async function loadValidComposition(
  pipelineRun: PipelineRun,
  layout: ReturnType<typeof createRunWorkspaceLayout>,
  inventory: DeploymentInventory,
): Promise<WikiCompositionArtifact | undefined> {
  const checkpoint = checkpointFor(pipelineRun, 'composing');
  if (checkpoint === undefined) return undefined;
  try {
    const composition = await readJson<WikiCompositionArtifact>(
      layout.wikiCompositionFile,
      WikiCompositionArtifactSchema,
    );
    const projection = await readJson<WikiProjectionV3>(layout.wikiFile, WikiProjectionV3Schema);
    return checkpoint.sourceHash === hashJson(inventory) &&
      checkpoint.outputHash === hashJson(composition) &&
      hashJson(projection) === hashJson(composition.projection)
      ? composition
      : undefined;
  } catch {
    return undefined;
  }
}

async function loadValidReports(
  pipelineRun: PipelineRun,
  composition: WikiCompositionArtifact,
): Promise<V3ReportArtifacts | undefined> {
  const checkpoint = checkpointFor(pipelineRun, 'reporting');
  if (checkpoint === undefined) return undefined;
  const reports = reportArtifactsFromFiles(pipelineRun.outputFiles);
  if (reports === undefined || checkpoint.sourceHash !== hashJson(composition.projection))
    return undefined;
  try {
    const outputHash = await hashFiles([reports.markdownFile, reports.htmlFile, reports.docxFile]);
    return checkpoint.outputHash === outputHash ? reports : undefined;
  } catch {
    return undefined;
  }
}

function reportArtifactsFromFiles(files: readonly string[]): V3ReportArtifacts | undefined {
  const docxFile = files.find((file) => path.basename(file) === '服务器部署清单.docx');
  const htmlFile = files.find((file) => path.basename(file) === 'index.html');
  const markdownFile = files.find((file) => path.basename(file) === 'README.md');
  if (docxFile === undefined || htmlFile === undefined || markdownFile === undefined)
    return undefined;
  return { docxFile, htmlFile, markdownFile, outputDirectory: path.dirname(markdownFile) };
}

async function resumeReportStage(
  scan: ScanWorkflowResult,
  composition: WikiCompositionArtifact,
  sourceMetrics: RunMetrics,
  sourcePipeline: PipelineRun,
  now: () => Date,
  onStage?: ScanStageHandler,
): Promise<Pick<FinalizeWorkflowResult, 'pipelineRun' | 'reports'>> {
  await onStage?.('reporting');
  const startedAt = now();
  const redacted = redactForReport(
    { inventory: scan.inventory, wiki: composition.projection },
    now,
  );
  const reportDirectory = createReportDirectory(
    scan.inventory.host.hostname,
    new Date(scan.snapshot.session.startedAt),
    scan.workspaceRoot,
  );
  const reports = await generateV3Reports(
    redacted.value.inventory,
    redacted.value.wiki,
    reportDirectory,
  );
  const finishedAt = now();
  const metrics = structuredClone(sourceMetrics);
  metrics.report.durationMs += Math.max(0, finishedAt.getTime() - startedAt.getTime());
  metrics.report.generatedFiles += 3;
  metrics.report.qualityGateFailures += composition.quality.passed ? 0 : 1;
  metrics.generatedAt = finishedAt.toISOString();
  assertSchema(RunMetricsSchema, metrics);
  const pipelineRun: PipelineRun = {
    ...structuredClone(sourcePipeline),
    completedStages: [
      ...sourcePipeline.completedStages.filter((item) => item.stage !== 'reporting'),
      {
        finishedAt: finishedAt.toISOString(),
        outputHash: await hashFiles([reports.markdownFile, reports.htmlFile, reports.docxFile]),
        sourceHash: hashJson(redacted.value.wiki),
        stage: 'reporting',
      },
    ],
    currentStage: 'reporting',
    finishedAt: finishedAt.toISOString(),
    outputFiles: [
      ...new Set([
        ...sourcePipeline.outputFiles,
        reports.markdownFile,
        reports.htmlFile,
        reports.docxFile,
      ]),
    ],
    state: composition.quality.passed ? 'completed' : 'partial',
    updatedAt: finishedAt.toISOString(),
  };
  delete pipelineRun.lastError;
  assertSchema(PipelineRunSchema, pipelineRun);
  await Promise.all([
    writeJsonAtomic(scan.layout.reportRedactionFile, redacted.report),
    writeJsonAtomic(scan.layout.metricsFile, metrics),
    writeJsonAtomic(scan.layout.pipelineRunFile, pipelineRun),
  ]);
  return { pipelineRun, reports };
}

function requireCheckpoint(
  pipelineRun: PipelineRun,
  stage: PipelineRun['completedStages'][number]['stage'],
  outputHash: string,
): void {
  const checkpoint = checkpointFor(pipelineRun, stage);
  if (checkpoint?.outputHash !== outputHash)
    throw new Error(`Pipeline checkpoint '${stage}' is missing or its artifact hash is invalid.`);
}

function checkpointFor(
  pipelineRun: PipelineRun,
  stage: PipelineRun['completedStages'][number]['stage'],
): PipelineRun['completedStages'][number] | undefined {
  return pipelineRun.completedStages.find((item) => item.stage === stage);
}

function markNeedsSsh(source: PipelineRun, requestCount: number, now: () => Date): PipelineRun {
  const at = now().toISOString();
  const result: PipelineRun = {
    ...structuredClone(source),
    finishedAt: at,
    lastError: {
      code: 'RESUME_NEEDS_SSH',
      message: `${requestCount} governed probe request(s) require a live SSH connection.`,
      retryable: true,
      stage: 'probing',
    },
    state: 'partial',
    updatedAt: at,
  };
  assertSchema(PipelineRunSchema, result);
  return result;
}

async function readJson<T>(file: string, schema: Parameters<typeof assertSchema>[0]): Promise<T> {
  const value = JSON.parse(await readFile(file, 'utf8')) as unknown;
  assertSchema(schema, value);
  return value as T;
}
