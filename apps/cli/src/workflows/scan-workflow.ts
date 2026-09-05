import { createHash } from 'node:crypto';

import {
  CollectionScheduler,
  PipelineRunTracker,
  RunMetricsCollector,
} from '@opsense/collection-runtime';
import {
  buildPathSeeds,
  collectM3Snapshot,
  collectM4Snapshot,
  collectM5Snapshot,
  collectPathMetadataSnapshot,
} from '@opsense/collectors';
import { buildResourceGraph } from '@opsense/correlation';
import { normalizeAndMergeServices } from '@opsense/core';
import { buildLocalDeploymentInventory, selectDeploymentCandidates } from '@opsense/discovery';
import { redactForAudit, redactSnapshot } from '@opsense/redaction';
import { SCHEMA_VERSION, ScanSnapshotSchema, assertSchema } from '@opsense/schema';
import type {
  DeploymentCandidateSet,
  DeploymentInventory,
  OpsenseConfig,
  PipelineProfile,
  PipelineRun,
  PipelineStage,
  RunMetrics,
  ResourceGraph,
  ScanSession,
  ScanSnapshot,
  ScanStage,
} from '@opsense/schema';
import { SafeCommandExecutor, connectSsh, detectPermissions } from '@opsense/ssh';
import type { CommandAuditRecord, SshConnection, SudoPasswordProvider } from '@opsense/ssh';
import {
  appendJsonLine,
  appendJsonLines,
  createScanId,
  ensureRunWorkspace,
  loadConfig,
  summarizeConfig,
  writeJsonAtomic,
} from '@opsense/workspace';
import type { RunWorkspaceLayout } from '@opsense/workspace';

import { WorkflowInterruptedError } from './errors.js';
import { VERSION } from '../version.js';

export interface ScanWorkflowOptions {
  acceptNewHostKey?: boolean;
  config?: string;
  host: string;
  identity?: string;
  password?: string;
  port: number;
  profile?: PipelineProfile;
  retainConnection?: boolean;
  signal?: AbortSignal;
  sudoPasswordProvider?: SudoPasswordProvider;
  user: string;
  workspace?: string;
}

export interface ScanWorkflowDependencies {
  connect?: typeof connectSsh;
  detectPermissions?: typeof detectPermissions;
  collectM3?: typeof collectM3Snapshot;
  collectM4?: typeof collectM4Snapshot;
  collectM5?: typeof collectM5Snapshot;
  collectPathMetadata?: typeof collectPathMetadataSnapshot;
  buildGraph?: typeof buildResourceGraph;
  buildInventory?: typeof buildLocalDeploymentInventory;
  now?: () => Date;
  selectCandidates?: typeof selectDeploymentCandidates;
}

export interface ScanWorkflowResult {
  candidateSet: DeploymentCandidateSet;
  config: OpsenseConfig;
  connection?: SshConnection;
  executor?: SafeCommandExecutor;
  layout: RunWorkspaceLayout;
  inventory: DeploymentInventory;
  metrics: RunMetrics;
  pipelineRun: PipelineRun;
  resourceGraph: ResourceGraph;
  scanId: string;
  snapshot: ScanSnapshot;
  workspaceRoot: string;
}

export type ScanStageHandler = (stage: string) => void | Promise<void>;

export async function runScanWorkflow(
  options: ScanWorkflowOptions,
  onStage?: ScanStageHandler,
  dependencies: ScanWorkflowDependencies = {},
): Promise<ScanWorkflowResult> {
  const now = dependencies.now ?? (() => new Date());
  const startedAt = now();
  const loaded = await loadConfig({
    cliOverrides: options.identity === undefined ? {} : { ssh: { identityFile: options.identity } },
    ...(options.config === undefined ? {} : { explicitPath: options.config }),
    ...(options.workspace === undefined ? {} : { workspaceRoot: options.workspace }),
  });
  const workspaceRoot = options.workspace ?? loaded.config.workspace.rootDirectory;
  const scanId = createScanId(startedAt);
  const layout = await ensureRunWorkspace(scanId, workspaceRoot);
  const profile = options.profile ?? 'standard';
  const metrics = new RunMetricsCollector(scanId, now);
  const scheduler = new CollectionScheduler({
    concurrency: 4,
    onConcurrencyChanged: (snapshot) => metrics.setSchedulerConcurrency(snapshot),
    onTaskCompleted: (result) => metrics.addSchedulerMetrics(result),
  });
  metrics.setSchedulerConcurrency(scheduler.concurrencySnapshot());
  const pipeline = new PipelineRunTracker({
    now,
    profile,
    runId: scanId,
    target: { host: options.host, port: options.port, user: options.user },
  });
  let connection: SshConnection | undefined;
  let executor: SafeCommandExecutor | undefined;
  let currentStage = 'created';
  let currentPipelineStage: PipelineStage | undefined;
  let auditWrite = Promise.resolve();
  let auditWriteError: unknown;
  const writeStage = async (
    stage: string,
    state: ScanSession['state'] = stage as ScanSession['state'],
  ): Promise<void> => {
    currentStage = stage;
    const nextPipelineStage = pipelineStageForScanStage(stage);
    if (nextPipelineStage !== currentPipelineStage) {
      if (currentPipelineStage !== undefined) {
        metrics.finishStage();
        pipeline.checkpoint(currentPipelineStage);
      }
      currentPipelineStage = nextPipelineStage;
      metrics.startStage(nextPipelineStage);
      pipeline.transition(nextPipelineStage);
    }
    await onStage?.(stage);
    const session: ScanSession = {
      configSummary: summarizeConfig(loaded.config),
      id: scanId,
      permissionLevel: 'unknown',
      rulesVersion: VERSION,
      schemaVersion: SCHEMA_VERSION,
      opsenseVersion: VERSION,
      startedAt: startedAt.toISOString(),
      state,
      target: { host: options.host, port: options.port, user: options.user },
      ...(stage === 'created' ? {} : { currentStage: stage as ScanStage }),
    };
    await Promise.all([
      writeJsonAtomic(layout.metaFile, session),
      writeJsonAtomic(layout.metricsFile, metrics.snapshot()),
      writeJsonAtomic(layout.pipelineRunFile, pipeline.snapshot()),
    ]);
  };

  try {
    await writeStage('created');
    await writeStage('connecting');
    const passwordProvider = createCliPasswordProvider(options.password);
    const connect = dependencies.connect ?? connectSsh;
    connection = await connect({
      acceptNewHostKey: options.acceptNewHostKey ?? loaded.config.ssh.acceptNewHostKey,
      connectTimeoutMs: loaded.config.ssh.connectTimeoutMs,
      host: options.host,
      keepaliveCountMax: loaded.config.ssh.keepaliveCountMax,
      keepaliveIntervalMs: loaded.config.ssh.keepaliveIntervalMs,
      port: options.port,
      strictHostKeyChecking: loaded.config.ssh.strictHostKeyChecking,
      user: options.user,
      ...(loaded.config.ssh.identityFile === undefined
        ? {}
        : { identityFile: loaded.config.ssh.identityFile }),
      ...(loaded.config.ssh.knownHostsFile === undefined
        ? {}
        : { knownHostsFile: loaded.config.ssh.knownHostsFile }),
      ...(passwordProvider === undefined ? {} : { passwordProvider }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
    });
    throwIfAborted(options.signal);
    const executorAudit = (record: CommandAuditRecord): void => {
      metrics.recordCommand(record);
      auditWrite = auditWrite
        .then(() => appendJsonLine(layout.auditFile, redactForAudit(record, now).value))
        .catch((error: unknown) => {
          auditWriteError ??= error;
        });
    };
    executor = new SafeCommandExecutor(connection, executorAudit);
    const permissionsProbe = dependencies.detectPermissions ?? detectPermissions;
    const collectM3 = dependencies.collectM3 ?? collectM3Snapshot;
    const collectM4 = dependencies.collectM4 ?? collectM4Snapshot;
    const collectM5 = dependencies.collectM5 ?? collectM5Snapshot;
    const collectPathMetadata = dependencies.collectPathMetadata ?? collectPathMetadataSnapshot;
    const buildGraph = dependencies.buildGraph ?? buildResourceGraph;
    const selectCandidates = dependencies.selectCandidates ?? selectDeploymentCandidates;
    const buildInventory = dependencies.buildInventory ?? buildLocalDeploymentInventory;

    await writeStage('collecting');
    const permissions = await permissionsProbe(executor, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    throwIfAborted(options.signal);
    let sudoPasswordAuthenticated = false;
    if (
      loaded.config.scan.useSudo !== 'never' &&
      permissions.uid !== 0 &&
      !permissions.sudoNonInteractive &&
      options.sudoPasswordProvider !== undefined
    ) {
      executor.setSudoPasswordProvider(options.sudoPasswordProvider);
      const sudoResult = await executor.executeById(
        'permission.sudo-auth',
        {},
        {
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          useSudo: true,
        },
      );
      permissions.results.push(sudoResult);
      if (sudoResult.status !== 'success') {
        throw new Error('Sudo authentication failed. Check the password and sudo permission.');
      }
      permissions.level = 'privileged';
      sudoPasswordAuthenticated = true;
    }
    const useSudo = shouldUseSudo(
      loaded.config.scan.useSudo,
      permissions.uid,
      permissions.sudoNonInteractive || sudoPasswordAuthenticated,
    );
    const collectionOptions = {
      commandTimeoutMs: loaded.config.ssh.commandTimeoutMs,
      maxOutputBytes: loaded.config.scan.maxCommandOutputBytes,
      opsenseVersion: VERSION,
      scheduler,
      useSudo,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    };
    const [collected, services] = await Promise.all([
      collectM3(executor, collectionOptions),
      collectM4(executor, collectionOptions),
    ]);
    throwIfAborted(options.signal);
    const pathInput = {
      composeProjects: services.composeProjects,
      containers: services.containers,
      processes: services.processes,
      systemdUnits: services.systemdUnits,
    };
    const directories =
      profile === 'deep'
        ? await collectM5(executor, pathInput, {
            commandTimeoutMs: loaded.config.ssh.commandTimeoutMs,
            crossFileSystems: loaded.config.scan.crossFileSystems,
            maxConfigFileBytes: loaded.config.scan.maxConfigFileBytes,
            maxDirectoryDepth: loaded.config.scan.maxDirectoryDepth,
            maxFilesPerDirectory: loaded.config.scan.maxFilesPerDirectory,
            maxOutputBytes: loaded.config.scan.maxCommandOutputBytes,
            opsenseVersion: VERSION,
            scheduler,
            useSudo,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
          })
        : await collectPathMetadata(executor, buildPathSeeds(pathInput), {
            commandTimeoutMs: loaded.config.ssh.commandTimeoutMs,
            maxOutputBytes: loaded.config.scan.maxCommandOutputBytes,
            opsenseVersion: VERSION,
            scheduler,
            useSudo,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
          });
    throwIfAborted(options.signal);
    await auditWrite;
    if (auditWriteError !== undefined) throw auditWriteError;

    await writeStage('normalizing');
    const normalized = normalizeAndMergeServices({
      artifacts: directories.artifacts,
      collectedAt: now().toISOString(),
      composeProjects: services.composeProjects,
      containers: services.containers,
      evidence: [...collected.evidence, ...services.evidence, ...directories.evidence],
      opsenseVersion: VERSION,
      processes: services.processes,
      sockets: services.sockets,
      systemdUnits: services.systemdUnits,
      unknowns: [...collected.unknowns, ...services.unknowns, ...directories.unknowns],
    });
    const finishedAt = now();
    const rawSnapshot: ScanSnapshot = {
      artifacts: normalized.artifacts,
      composeProjects: normalized.composeProjects,
      containers: normalized.containers,
      evidence: normalized.evidence,
      findings: [],
      host: collected.host,
      network: collected.network,
      pathSeeds: directories.pathSeeds,
      processes: normalized.processes,
      services: normalized.services,
      session: {
        configSummary: summarizeConfig(loaded.config),
        finishedAt: finishedAt.toISOString(),
        id: scanId,
        opsenseVersion: VERSION,
        permissionLevel: permissions.level,
        rulesVersion: VERSION,
        schemaVersion: SCHEMA_VERSION,
        startedAt: startedAt.toISOString(),
        state: normalized.unknowns.length === 0 ? 'completed' : 'partial',
        target: { host: options.host, port: options.port, user: options.user },
      },
      sockets: normalized.sockets,
      storage: collected.storage,
      systemdUnits: normalized.systemdUnits,
      unknowns: normalized.unknowns,
    };
    await writeStage('redacting');
    const redacted = redactSnapshot(rawSnapshot, now);
    assertSchema(ScanSnapshotSchema, redacted.value);
    await Promise.all([
      appendJsonLines(layout.evidenceFile, redacted.value.evidence),
      writeJsonAtomic(layout.snapshotFile, redacted.value),
      writeJsonAtomic(layout.metaFile, redacted.value.session),
      writeJsonAtomic(layout.redactionReportFile, redacted.report),
    ]);
    const resourceGraph = buildGraph(redacted.value, { now });
    const candidateSet = selectCandidates(resourceGraph, redacted.value, { now });
    const inventory = buildInventory(redacted.value, resourceGraph, candidateSet, { now });
    metrics.setDiscoveryMetrics({
      candidateCount: candidateSet.candidates.length,
      filteredGroupCount: candidateSet.filteredGroups.length,
      finalServiceCount: inventory.services.length,
      protectedCandidateCount: candidateSet.candidates.length,
      rawObjectCount: inventory.coverage.rawObjectCount,
    });
    await Promise.all([
      writeJsonAtomic(layout.resourceGraphFile, resourceGraph),
      writeJsonAtomic(layout.candidateSetFile, candidateSet),
      writeJsonAtomic(layout.inventoryFile, inventory),
    ]);
    if (currentPipelineStage !== undefined) {
      metrics.finishStage();
      pipeline.checkpoint(currentPipelineStage, {
        outputHash: hashJson(redacted.value),
      });
    }
    currentPipelineStage = 'inventory_ready';
    metrics.startStage(currentPipelineStage);
    pipeline.transition(currentPipelineStage);
    pipeline.addOutputFiles([
      layout.snapshotFile,
      layout.evidenceFile,
      layout.redactionReportFile,
      layout.resourceGraphFile,
      layout.candidateSetFile,
      layout.inventoryFile,
      layout.metricsFile,
    ]);
    metrics.finishStage();
    pipeline.checkpoint(currentPipelineStage, { outputHash: hashJson(inventory) });
    await Promise.all([
      writeJsonAtomic(layout.metricsFile, metrics.snapshot()),
      writeJsonAtomic(layout.pipelineRunFile, pipeline.snapshot()),
    ]);
    await onStage?.(redacted.value.session.state);
    if (!options.retainConnection) connection.close();
    return {
      candidateSet,
      config: loaded.config,
      ...(options.retainConnection ? { connection, executor } : {}),
      layout,
      inventory,
      metrics: metrics.snapshot(),
      pipelineRun: pipeline.snapshot(),
      resourceGraph,
      scanId,
      snapshot: redacted.value,
      workspaceRoot: layout.rootDirectory,
    };
  } catch (error) {
    metrics.finishStage(options.signal?.aborted === true ? 'interrupted' : 'failed');
    const message = error instanceof Error ? error.message : String(error);
    pipeline.finish(options.signal?.aborted === true ? 'interrupted' : 'failed', {
      code: options.signal?.aborted === true ? 'SCAN_INTERRUPTED' : 'SCAN_FAILED',
      message,
      retryable: options.signal?.aborted !== true,
      ...(currentPipelineStage === undefined ? {} : { stage: currentPipelineStage }),
    });
    await Promise.all([
      writeJsonAtomic(layout.metaFile, {
        configSummary: summarizeConfig(loaded.config),
        currentStage: currentStage as ScanStage,
        finishedAt: now().toISOString(),
        id: scanId,
        opsenseVersion: VERSION,
        permissionLevel: 'unknown',
        rulesVersion: VERSION,
        schemaVersion: SCHEMA_VERSION,
        startedAt: startedAt.toISOString(),
        state: 'failed',
        target: { host: options.host, port: options.port, user: options.user },
      }),
      writeJsonAtomic(layout.metricsFile, metrics.snapshot()),
      writeJsonAtomic(layout.pipelineRunFile, pipeline.snapshot()),
    ]).catch(() => undefined);
    connection?.close();
    throw error;
  }
}

function pipelineStageForScanStage(stage: string): PipelineStage {
  if (stage === 'created') return 'created';
  if (stage === 'connecting') return 'preflighting';
  if (stage === 'collecting') return 'collecting_baseline';
  return 'correlating';
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function createCliPasswordProvider(
  password: string | undefined,
): (() => Promise<string>) | undefined {
  return password === undefined ? undefined : async () => password;
}

function shouldUseSudo(
  mode: 'always' | 'auto' | 'never',
  uid: number | undefined,
  sudo: boolean,
): boolean {
  if (mode === 'always') return true;
  if (mode === 'never' || uid === 0) return false;
  return sudo;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new WorkflowInterruptedError();
}
