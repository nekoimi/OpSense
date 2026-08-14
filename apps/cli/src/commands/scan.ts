import { Command, InvalidArgumentError } from 'commander';

import { ExitCode, exitCodeForError } from '../exit-code.js';
import type { LoggerFactory } from '../logger.js';
import { runScanWorkflow } from '../workflows/scan-workflow.js';

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
    .description(
      'Collect a read-only system, service, and targeted directory snapshot from one Linux server.',
    )
    .requiredOption('--host <host>', 'target host name or IP address')
    .option('--port <port>', 'SSH port', parsePort, 22)
    .requiredOption('--user <user>', 'SSH user name')
    .option('--identity <path>', 'SSH private key file')
    .option('--password <password>', 'SSH password (not persisted)')
    .option('--accept-new-host-key', 'trust and store the host key on first connection')
    .option('--config <path>', 'configuration file path')
    .option('--workspace <path>', 'local OpSense workspace directory');

  command.action(async (options: ScanOptions) => {
    const logger = loggerFactory(command.optsWithGlobals<GlobalOptions>());
    try {
      const result = await runScanWorkflow(options, (stage) => logger.info(`Stage: ${stage}`));
      logger.info(`Scan ${result.scanId} completed with state '${result.snapshot.session.state}'.`);
      logger.info(`Local run directory: ${result.layout.runDirectory}`);
      logger.info(`Snapshot: ${result.layout.snapshotFile}`);
      process.exitCode =
        result.snapshot.session.state === 'partial' ? ExitCode.ScanPartial : ExitCode.Success;
    } catch (error) {
      logger.error(`Scan failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = exitCodeForError(error);
    }
  });

  return command;
}

export function parsePort(value: string): number {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535 || String(port) !== value) {
    throw new InvalidArgumentError('SSH port must be an integer between 1 and 65535.');
  }
  return port;
}

export { createCliPasswordProvider } from '../workflows/scan-workflow.js';
