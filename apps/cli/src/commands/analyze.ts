import { Command, InvalidArgumentError } from 'commander';

import { ExitCode, exitCodeForError } from '../exit-code.js';
import type { LoggerFactory } from '../logger.js';
import { runDiscoveryWorkflow } from '../workflows/discovery-workflow.js';

interface DiscoverOptions {
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

export function createDiscoverCommand(loggerFactory: LoggerFactory): Command {
  const command = new Command('discover')
    .description('Run v3 Batch Discovery for an existing scan with Codex or the local provider.')
    .requiredOption('--scan <scan-id>', 'scan ID to analyze')
    .option('--provider <provider>', 'AI provider: codex or noop', 'codex')
    .option('--model <model>', 'Codex model override')
    .option('--thread-id <thread-id>', 'resume an existing Codex thread')
    .option('--timeout-ms <milliseconds>', 'Codex turn timeout', parsePositiveInteger, 120_000)
    .option('--max-retries <count>', 'structured output repair retries', parseNonNegativeInteger)
    .option('--config <path>', 'configuration file path')
    .option('--workspace <path>', 'local OpSense workspace directory');

  command.action(async (options: DiscoverOptions) => {
    const logger = loggerFactory(command.optsWithGlobals<GlobalOptions>());
    try {
      validateProvider(options.provider);
      const result = await runDiscoveryWorkflow(options, (stage) => logger.info(`Stage: ${stage}`));
      logger.info(
        `Batch Discovery ${options.scan} completed with state '${result.artifact.run.status}' using '${result.artifact.run.provider}'.`,
      );
      logger.info(`Discovery output: ${result.layout.discoveryFile}`);
      process.exitCode =
        result.artifact.run.status === 'degraded' ? ExitCode.AiDegraded : ExitCode.Success;
    } catch (error) {
      logger.error(`Discovery failed: ${error instanceof Error ? error.message : String(error)}`);
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
