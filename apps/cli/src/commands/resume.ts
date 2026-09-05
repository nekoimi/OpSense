import { Command, InvalidArgumentError } from 'commander';

import { ExitCode, exitCodeForError } from '../exit-code.js';
import type { LoggerFactory } from '../logger.js';
import { ResumeNeedsSshError, runResumeWorkflow } from '../workflows/resume-workflow.js';

interface GlobalOptions {
  quiet?: boolean;
  verbose?: boolean;
}

interface ResumeOptions {
  config?: string;
  maxRetries?: number;
  model?: string;
  provider: string;
  run: string;
  timeoutMs: number;
  workspace?: string;
}

export function createResumeCommand(loggerFactory: LoggerFactory): Command {
  const command = new Command('resume')
    .description('Validate v3 checkpoints and continue an interrupted run without rescanning.')
    .requiredOption('--run <run-id>', 'v3 run ID to resume')
    .option('--provider <provider>', 'AI provider: codex or noop', 'codex')
    .option('--model <model>', 'Codex model override')
    .option('--timeout-ms <milliseconds>', 'Codex turn timeout', parsePositiveInteger, 120_000)
    .option('--max-retries <count>', 'structured output repair retries', parseNonNegativeInteger)
    .option('--config <path>', 'configuration file path')
    .option('--workspace <path>', 'local OpSense workspace directory');

  command.action(async (options: ResumeOptions) => {
    const logger = loggerFactory(command.optsWithGlobals<GlobalOptions>());
    try {
      if (!['codex', 'noop', 'baseline'].includes(options.provider))
        throw new InvalidArgumentError(`Unsupported AI provider '${options.provider}'.`);
      const result = await runResumeWorkflow(options, (stage) => logger.info(`Stage: ${stage}`));
      logger.info(
        result.status === 'already_complete'
          ? `Run ${result.runId} is already complete; no stages were rerun.`
          : `Run ${result.runId} resumed with state '${result.pipelineRun.state}'.`,
      );
      logger.info(`Word: ${result.reports.docxFile}`);
      logger.info(`HTML: ${result.reports.htmlFile}`);
      process.exitCode =
        result.pipelineRun.state === 'partial' ? ExitCode.AiDegraded : ExitCode.Success;
    } catch (error) {
      logger.error(`Resume failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode =
        error instanceof ResumeNeedsSshError ? ExitCode.ScanPartial : exitCodeForError(error);
    }
  });
  return command;
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
