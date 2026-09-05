import { Command, InvalidArgumentError } from 'commander';
import type { ReportFormat } from '@opsense/report';
import type { PipelineProfile } from '@opsense/schema';

import { ExitCode, exitCodeForError } from '../exit-code.js';
import type { LoggerFactory } from '../logger.js';
import { createInteractiveSudoPasswordProvider } from '../sudo-password.js';
import { runInspectWorkflow } from '../workflows/inspect-workflow.js';
import { parsePort, parseScanProfile } from './scan.js';

interface InspectOptions {
  acceptNewHostKey?: boolean;
  config?: string;
  format?: ReportFormat[];
  host: string;
  identity?: string;
  maxRetries?: number;
  model?: string;
  password?: string;
  port: number;
  provider: string;
  profile: PipelineProfile;
  threadTimeoutMs: number;
  timeZone?: string;
  user: string;
  workspace?: string;
}

interface GlobalOptions {
  quiet?: boolean;
  verbose?: boolean;
}

export function createInspectCommand(loggerFactory: LoggerFactory): Command {
  const command = new Command('inspect')
    .description('Scan, analyze, and render a report in one local workflow.')
    .requiredOption('--host <host>', 'target host name or IP address')
    .option('--port <port>', 'SSH port', parsePort, 22)
    .requiredOption('--user <user>', 'SSH user name')
    .option('--identity <path>', 'SSH private key file')
    .option('--password <password>', 'SSH password (not persisted)')
    .option('--accept-new-host-key', 'trust and store the host key on first connection')
    .option(
      '--profile <profile>',
      'scan profile: fast, standard, or deep',
      parseScanProfile,
      'standard',
    )
    .option('--provider <provider>', 'AI provider: codex or noop', 'codex')
    .option('--model <model>', 'Codex model override')
    .option(
      '--thread-timeout-ms <milliseconds>',
      'Codex turn timeout',
      parsePositiveInteger,
      120_000,
    )
    .option('--max-retries <count>', 'structured output repair retries', parseNonNegativeInteger)
    .option('--format <formats>', 'additional report formats', parseFormats, ['docx', 'html'])
    .option('--time-zone <time-zone>', 'report display timezone')
    .option('--config <path>', 'configuration file path')
    .option('--workspace <path>', 'local OpSense workspace directory');

  command.action(async (options: InspectOptions) => {
    const logger = loggerFactory(command.optsWithGlobals<GlobalOptions>());
    const controller = new AbortController();
    let interrupted = false;
    let lastStage: string | undefined;
    const handleInterrupt = (): void => {
      if (interrupted) return;
      interrupted = true;
      logger.error('Interrupt requested; cancelling active work and closing SSH.');
      controller.abort();
    };
    process.on('SIGINT', handleInterrupt);
    try {
      if (!['codex', 'noop', 'baseline'].includes(options.provider)) {
        throw new InvalidArgumentError(`Unsupported AI provider '${options.provider}'.`);
      }
      const sudoPasswordProvider = createInteractiveSudoPasswordProvider();
      const result = await runInspectWorkflow(
        {
          ...options,
          formats: options.format ?? ['docx', 'html'],
          signal: controller.signal,
          ...(sudoPasswordProvider === undefined ? {} : { sudoPasswordProvider }),
        },
        (stage) => {
          lastStage = stage;
          logger.info(`Stage: ${stage}`);
        },
      );
      logger.info(
        `Scan ${result.scan.scanId} completed with state '${result.scan.snapshot.session.state}'.`,
      );
      logger.info(`Local deployment inventory: ${result.scan.layout.inventoryFile}`);
      logger.info(`Final inventory: ${result.scan.layout.inventoryFile}`);
      logger.info(`Word: ${result.finalization.reports.docxFile}`);
      logger.info(`HTML: ${result.finalization.reports.htmlFile}`);
      process.exitCode =
        result.finalization.pipelineRun.state === 'partial'
          ? ExitCode.AiDegraded
          : result.scan.snapshot.session.state === 'partial'
            ? ExitCode.ScanPartial
            : ExitCode.Success;
    } catch (error) {
      logger.error(`Inspect failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode =
        interrupted || lastStage === 'rendering'
          ? interrupted
            ? ExitCode.Interrupted
            : ExitCode.ReportFailed
          : exitCodeForError(error);
    } finally {
      process.off('SIGINT', handleInterrupt);
    }
  });

  return command;
}

function parseFormats(value: string): ReportFormat[] {
  const allowed = new Set<ReportFormat>(['docx', 'html', 'markdown']);
  const formats = value.split(',').map((item) => item.trim().toLowerCase());
  if (formats.some((item) => !allowed.has(item as ReportFormat))) {
    throw new InvalidArgumentError('Report formats must be docx, markdown, or html.');
  }
  return [...new Set<ReportFormat>([...(formats as ReportFormat[]), 'docx', 'html'])];
}

function parsePositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new InvalidArgumentError('Value must be a positive integer.');
  return parsed;
}

function parseNonNegativeInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0)
    throw new InvalidArgumentError('Value must be a non-negative integer.');
  return parsed;
}
