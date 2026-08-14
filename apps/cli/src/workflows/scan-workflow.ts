import { collectM3Snapshot, collectM4Snapshot, collectM5Snapshot } from '@opsense/collectors';
import { normalizeAndMergeServices } from '@opsense/core';
import { redactForAudit, redactSnapshot } from '@opsense/redaction';
import { SCHEMA_VERSION, ScanSnapshotSchema, assertSchema } from '@opsense/schema';
import type { OpsenseConfig, ScanSession, ScanSnapshot, ScanStage } from '@opsense/schema';
import { SafeCommandExecutor, connectSsh, detectPermissions } from '@opsense/ssh';
import type { SshConnection } from '@opsense/ssh';
import {
  appendJsonLine,
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
  retainConnection?: boolean;
  signal?: AbortSignal;
  user: string;
  workspace?: string;
}

export interface ScanWorkflowDependencies {
  connect?: typeof connectSsh;
  detectPermissions?: typeof detectPermissions;
  collectM3?: typeof collectM3Snapshot;
  collectM4?: typeof collectM4Snapshot;
  collectM5?: typeof collectM5Snapshot;
  now?: () => Date;
}

export interface ScanWorkflowResult {
  config: OpsenseConfig;
  connection?: SshConnection;
  executor?: SafeCommandExecutor;
  layout: RunWorkspaceLayout;
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
  let connection: SshConnection | undefined;
  let executor: SafeCommandExecutor | undefined;
  let currentStage = 'created';
  let auditWrite = Promise.resolve();
  const writeStage = async (
    stage: string,
    state: ScanSession['state'] = stage as ScanSession['state'],
  ): Promise<void> => {
    currentStage = stage;
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
    await writeJsonAtomic(layout.metaFile, session);
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
    const executorAudit = (record: unknown): Promise<void> => {
      auditWrite = auditWrite.then(() =>
        appendJsonLine(layout.auditFile, redactForAudit(record, now).value),
      );
      return auditWrite;
    };
    executor = new SafeCommandExecutor(connection, executorAudit);
    const permissionsProbe = dependencies.detectPermissions ?? detectPermissions;
    const collectM3 = dependencies.collectM3 ?? collectM3Snapshot;
    const collectM4 = dependencies.collectM4 ?? collectM4Snapshot;
    const collectM5 = dependencies.collectM5 ?? collectM5Snapshot;

    await writeStage('collecting');
    const permissions = await permissionsProbe(executor, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    throwIfAborted(options.signal);
    const useSudo = shouldUseSudo(
      loaded.config.scan.useSudo,
      permissions.uid,
      permissions.sudoNonInteractive,
    );
    const collectionOptions = {
      commandTimeoutMs: loaded.config.ssh.commandTimeoutMs,
      maxOutputBytes: loaded.config.scan.maxCommandOutputBytes,
      opsenseVersion: VERSION,
      useSudo,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    };
    const collected = await collectM3(executor, collectionOptions);
    throwIfAborted(options.signal);
    const services = await collectM4(executor, collectionOptions);
    throwIfAborted(options.signal);
    const directories = await collectM5(
      executor,
      {
        composeProjects: services.composeProjects,
        containers: services.containers,
        processes: services.processes,
        systemdUnits: services.systemdUnits,
      },
      {
        commandTimeoutMs: loaded.config.ssh.commandTimeoutMs,
        crossFileSystems: loaded.config.scan.crossFileSystems,
        maxConfigFileBytes: loaded.config.scan.maxConfigFileBytes,
        maxDirectoryDepth: loaded.config.scan.maxDirectoryDepth,
        maxFilesPerDirectory: loaded.config.scan.maxFilesPerDirectory,
        maxOutputBytes: loaded.config.scan.maxCommandOutputBytes,
        opsenseVersion: VERSION,
        useSudo,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    );
    throwIfAborted(options.signal);
    await auditWrite;

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
      writeJsonAtomic(layout.snapshotFile, redacted.value),
      writeJsonAtomic(layout.metaFile, redacted.value.session),
      writeJsonAtomic(layout.redactionReportFile, redacted.report),
    ]);
    await onStage?.(redacted.value.session.state);
    if (!options.retainConnection) connection.close();
    return {
      config: loaded.config,
      ...(options.retainConnection ? { connection, executor } : {}),
      layout,
      scanId,
      snapshot: redacted.value,
      workspaceRoot: layout.rootDirectory,
    };
  } catch (error) {
    await writeJsonAtomic(layout.metaFile, {
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
    }).catch(() => undefined);
    connection?.close();
    throw error;
  }
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
