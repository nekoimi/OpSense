import { readFile } from 'node:fs/promises';

import { CodexProvider } from '@opsense/ai-codex';
import { BaselineRelevanceClassifier, NoopProvider, buildAiWorkspace } from '@opsense/ai-provider';
import type { AiProvider, AnalysisOptions, AnalysisResult } from '@opsense/ai-provider';
import { scanForSecrets } from '@opsense/redaction';
import {
  AiAnalysisSchema,
  AiPlanSchema,
  AiProbeAuditSchema,
  AiRunSchema,
  ScanSnapshotSchema,
  assertSchema,
} from '@opsense/schema';
import type { AiProbeAudit, ScanSnapshot } from '@opsense/schema';
import {
  createRunWorkspaceLayout,
  ensureRunWorkspace,
  loadConfig,
  writeJsonAtomic,
} from '@opsense/workspace';
import type { RunWorkspaceLayout } from '@opsense/workspace';

import type { ScanStageHandler } from './scan-workflow.js';

export interface AnalyzeWorkflowOptions {
  config?: string;
  maxRetries?: number;
  model?: string;
  probeAuditOverride?: AiProbeAudit;
  provider: string;
  scan: string;
  signal?: AbortSignal;
  stageMode?: 'full' | 'planning-only' | 'analyzing-only';
  threadId?: string;
  timeoutMs: number;
  workspace?: string;
}

export interface AnalyzeWorkflowDependencies {
  createProvider?: (name: string) => AiProvider;
  now?: () => Date;
}

export interface AnalyzeWorkflowResult {
  config: Awaited<ReturnType<typeof loadConfig>>['config'];
  layout: RunWorkspaceLayout;
  result: AnalysisResult;
  snapshot: ScanSnapshot;
}

export async function runAnalysisWorkflow(
  options: AnalyzeWorkflowOptions,
  onStage?: ScanStageHandler,
  dependencies: AnalyzeWorkflowDependencies = {},
): Promise<AnalyzeWorkflowResult> {
  const loaded = await loadConfig({
    ...(options.config === undefined ? {} : { explicitPath: options.config }),
    ...(options.workspace === undefined ? {} : { workspaceRoot: options.workspace }),
  });
  const workspaceRoot = options.workspace ?? loaded.config.workspace.rootDirectory;
  const layout = createRunWorkspaceLayout(options.scan, workspaceRoot);
  await ensureRunWorkspace(options.scan, workspaceRoot);
  const snapshot = await readSnapshot(layout.snapshotFile);
  assertSnapshotReadyForAi(snapshot);
  const baselinePlan = new BaselineRelevanceClassifier().classify(snapshot);
  await buildAiWorkspace(snapshot, layout.aiInputDirectory, dependencies.now, baselinePlan);
  const mode = options.stageMode ?? 'full';
  if (mode !== 'analyzing-only') await onStage?.('planning');
  const provider = (dependencies.createProvider ?? createProvider)(options.provider);
  if (mode !== 'planning-only') await onStage?.('analyzing');
  const analysisOptions: AnalysisOptions = {
    maxRetries: options.maxRetries ?? loaded.config.ai.maxRetries,
    timeoutMs: options.timeoutMs,
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.threadId === undefined ? {} : { threadId: options.threadId }),
  };
  const result = await provider.analyze(
    { aiInputDirectory: layout.aiInputDirectory, baselinePlan, snapshot },
    analysisOptions,
  );
  if (options.signal?.aborted === true) throw new Error('Operation was interrupted.');
  const persistedResult: AnalysisResult =
    options.probeAuditOverride === undefined
      ? result
      : { ...result, probeAudit: options.probeAuditOverride };
  assertSchema(AiPlanSchema, persistedResult.plan);
  assertSchema(AiProbeAuditSchema, persistedResult.probeAudit);
  assertSchema(AiAnalysisSchema, persistedResult.analysis);
  assertSchema(AiRunSchema, persistedResult.run);
  await Promise.all([
    writeJsonAtomic(layout.aiPlanFile, persistedResult.plan),
    writeJsonAtomic(layout.aiProbeAuditFile, persistedResult.probeAudit),
    writeJsonAtomic(layout.aiOutputFile, persistedResult.analysis),
    writeJsonAtomic(layout.aiRunFile, persistedResult.run),
  ]);
  return { config: loaded.config, layout, result: persistedResult, snapshot };
}

export async function readSnapshotFile(file: string): Promise<ScanSnapshot> {
  return readSnapshot(file);
}

export function createProvider(name: string): AiProvider {
  if (name === 'codex') return new CodexProvider();
  if (name === 'noop' || name === 'baseline') return new NoopProvider();
  throw new Error(`Unsupported AI provider '${name}'.`);
}

function assertSnapshotReadyForAi(snapshot: ScanSnapshot): void {
  assertSchema(ScanSnapshotSchema, snapshot);
  if (snapshot.redaction?.secretScanPassed !== true) {
    throw new Error('Scan snapshot is not marked as successfully redacted.');
  }
  const findings = scanForSecrets(snapshot);
  if (findings.length > 0) {
    throw new Error(`Scan snapshot still contains ${findings.length} secret finding(s).`);
  }
}

async function readSnapshot(file: string): Promise<ScanSnapshot> {
  const value = JSON.parse(await readFile(file, 'utf8')) as unknown;
  assertSchema(ScanSnapshotSchema, value);
  return value;
}
