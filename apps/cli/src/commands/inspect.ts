import { Command, InvalidArgumentError } from 'commander';
import type { ReportFormat } from '@opsense/report';

import { ExitCode, exitCodeForError } from '../exit-code.js';
import type { LoggerFactory } from '../logger.js';
import { createInteractiveSudoPasswordProvider } from '../sudo-password.js';
import { runInspectWorkflow } from '../workflows/inspect-workflow.js';
import { parseReportFormats } from '../workflows/report-workflow.js';
import { parsePort } from './scan.js';

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
      logger.info(`Word: ${result.report.artifacts.docxFile ?? '(not generated)'}`);
      logger.info(`HTML: ${result.report.artifacts.htmlFile ?? '(not generated)'}`);
      process.exitCode =
        result.analysis.result.run.status === 'degraded'
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
  try {
    return [...new Set<ReportFormat>([...parseReportFormats(value), 'docx', 'html'])];
  } catch (error) {
    throw new InvalidArgumentError(error instanceof Error ? error.message : String(error));
  }
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
