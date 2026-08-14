import { collectM3Snapshot } from '@opsense/collectors';
import { SCHEMA_VERSION, ScanSnapshotSchema, assertSchema } from '@opsense/schema';
import type { ScanSnapshot } from '@opsense/schema';
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
import { Command, InvalidArgumentError } from 'commander';

import { ExitCode } from '../exit-code.js';
import type { LoggerFactory } from '../logger.js';
import { VERSION } from '../version.js';

interface GlobalOptions {
  quiet?: boolean;
  verbose?: boolean;
}

interface ScanOptions {
  acceptNewHostKey?: boolean;
  config?: string;
  host: string;
  identity?: string;
  password?: string;
  port: number;
  user: string;
  workspace?: string;
}

export function createScanCommand(loggerFactory: LoggerFactory): Command {
  const command = new Command('scan')
    .description('Collect a read-only system, storage, and network snapshot from one Linux server.')
    .requiredOption('--host <host>', 'target host name or IP address')
    .option('--port <port>', 'SSH port', parsePort, 22)
    .requiredOption('--user <user>', 'SSH user name')
    .option('--identity <path>', 'SSH private key file')
    .option('--password <password>', 'SSH password (not persisted)')
    .option('--accept-new-host-key', 'trust and store the host key on first connection')
    .option('--config <path>', 'configuration file path')
    .option('--workspace <path>', 'local OpSense workspace directory');

  command.action(async (scanOptions: ScanOptions) => {
    const logger = loggerFactory(command.optsWithGlobals<GlobalOptions>());
    let connection: SshConnection | undefined;
    const startedAt = new Date();

    try {
      const loaded = await loadConfig({
        cliOverrides:
          scanOptions.identity === undefined ? {} : { ssh: { identityFile: scanOptions.identity } },
        ...(scanOptions.config === undefined ? {} : { explicitPath: scanOptions.config }),
        ...(scanOptions.workspace === undefined ? {} : { workspaceRoot: scanOptions.workspace }),
      });
      const workspaceRoot = scanOptions.workspace ?? loaded.config.workspace.rootDirectory;
      const scanId = createScanId(startedAt);
      const layout = await ensureRunWorkspace(scanId, workspaceRoot);
      let auditWrite = Promise.resolve();
      const executorAudit = (record: unknown): Promise<void> => {
        auditWrite = auditWrite.then(() => appendJsonLine(layout.auditFile, record));
        return auditWrite;
      };

      logger.debug(`Connecting to ${scanOptions.host}:${scanOptions.port}.`);
      const passwordProvider = createCliPasswordProvider(scanOptions.password);
      connection = await connectSsh({
        acceptNewHostKey: scanOptions.acceptNewHostKey ?? loaded.config.ssh.acceptNewHostKey,
        connectTimeoutMs: loaded.config.ssh.connectTimeoutMs,
        host: scanOptions.host,
        keepaliveCountMax: loaded.config.ssh.keepaliveCountMax,
        keepaliveIntervalMs: loaded.config.ssh.keepaliveIntervalMs,
        port: scanOptions.port,
        strictHostKeyChecking: loaded.config.ssh.strictHostKeyChecking,
        user: scanOptions.user,
        ...(loaded.config.ssh.identityFile === undefined
          ? {}
          : { identityFile: loaded.config.ssh.identityFile }),
        ...(loaded.config.ssh.knownHostsFile === undefined
          ? {}
          : { knownHostsFile: loaded.config.ssh.knownHostsFile }),
        ...(passwordProvider === undefined ? {} : { passwordProvider }),
        ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
      });
      const executor = new SafeCommandExecutor(connection, executorAudit);
      const permissions = await detectPermissions(executor);
      const useSudo = shouldUseSudo(
        loaded.config.scan.useSudo,
        permissions.uid,
        permissions.sudoNonInteractive,
      );
      const collected = await collectM3Snapshot(executor, {
        commandTimeoutMs: loaded.config.ssh.commandTimeoutMs,
        maxOutputBytes: loaded.config.scan.maxCommandOutputBytes,
        opsenseVersion: VERSION,
        useSudo,
      });
      await auditWrite;

      const finishedAt = new Date();
      const snapshot: ScanSnapshot = {
        artifacts: [],
        composeProjects: [],
        containers: [],
        evidence: collected.evidence,
        findings: [],
        host: collected.host,
        network: collected.network,
        processes: [],
        services: [],
        session: {
          configSummary: summarizeConfig(loaded.config),
          finishedAt: finishedAt.toISOString(),
          id: scanId,
          opsenseVersion: VERSION,
          permissionLevel: permissions.level,
          rulesVersion: VERSION,
          schemaVersion: SCHEMA_VERSION,
          startedAt: startedAt.toISOString(),
          state: collected.unknowns.length === 0 ? 'completed' : 'partial',
          target: { host: scanOptions.host, port: scanOptions.port, user: scanOptions.user },
        },
        sockets: [],
        storage: collected.storage,
        systemdUnits: [],
        unknowns: collected.unknowns,
      };
      assertSchema(ScanSnapshotSchema, snapshot);
      await Promise.all([
        writeJsonAtomic(layout.snapshotFile, snapshot),
        writeJsonAtomic(layout.metaFile, snapshot.session),
      ]);
      logger.info(`Scan ${scanId} completed with state '${snapshot.session.state}'.`);
      logger.info(layout.snapshotFile);
      process.exitCode = ExitCode.Success;
    } catch (error) {
      logger.error(`Scan failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = ExitCode.GeneralError;
    } finally {
      connection?.close();
    }
  });

  return command;
}

function parsePort(value: string): number {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535 || String(port) !== value) {
    throw new InvalidArgumentError('SSH port must be an integer between 1 and 65535.');
  }
  return port;
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
