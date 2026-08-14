import { Command, InvalidArgumentError } from 'commander';

import { ExitCode, exitCodeForError } from '../exit-code.js';
import type { LoggerFactory } from '../logger.js';
import { runAnalysisWorkflow } from '../workflows/analysis-workflow.js';

interface AnalyzeOptions {
  config?: string;
  maxRetries?: number;
  model?: string;
  provider: string;
  scan: string;
  threadId?: string;
  timeoutMs: number;
  workspace?: string;
}

interface GlobalOptions {
  quiet?: boolean;
  verbose?: boolean;
}

export function createAnalyzeCommand(loggerFactory: LoggerFactory): Command {
  const command = new Command('analyze')
    .description('Analyze an existing scan snapshot with Codex or the local baseline provider.')
    .requiredOption('--scan <scan-id>', 'scan ID to analyze')
    .option('--provider <provider>', 'AI provider: codex or noop', 'codex')
    .option('--model <model>', 'Codex model override')
    .option('--thread-id <thread-id>', 'resume an existing Codex thread')
    .option('--timeout-ms <milliseconds>', 'Codex turn timeout', parsePositiveInteger, 120_000)
    .option('--max-retries <count>', 'structured output repair retries', parseNonNegativeInteger)
    .option('--config <path>', 'configuration file path')
    .option('--workspace <path>', 'local OpSense workspace directory');

  command.action(async (options: AnalyzeOptions) => {
    const logger = loggerFactory(command.optsWithGlobals<GlobalOptions>());
    try {
      validateProvider(options.provider);
      const result = await runAnalysisWorkflow(options, (stage) => logger.info(`Stage: ${stage}`));
      logger.info(
        `Analysis ${options.scan} completed with state '${result.result.run.status}' using '${result.result.analysis.provider}'.`,
      );
      logger.info(`AI output: ${result.layout.aiOutputFile}`);
      process.exitCode =
        result.result.run.status === 'degraded' ? ExitCode.AiDegraded : ExitCode.Success;
    } catch (error) {
      logger.error(`Analysis failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = exitCodeForError(error);
    }
  });

  return command;
}

function validateProvider(value: string): void {
  if (value !== 'codex' && value !== 'noop' && value !== 'baseline') {
    throw new InvalidArgumentError(`Unsupported AI provider '${value}'.`);
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
