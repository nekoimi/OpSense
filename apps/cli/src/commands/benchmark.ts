import { Command, InvalidArgumentError } from 'commander';

import type { BenchmarkComparison, RunBenchmark } from '@opsense/evaluation';

import { ExitCode } from '../exit-code.js';
import type { LoggerFactory } from '../logger.js';
import { runBenchmarkWorkflow } from '../workflows/benchmark-workflow.js';

interface BenchmarkOptions {
  compare?: string[];
  run?: string;
  workspace?: string;
}

interface GlobalOptions {
  quiet?: boolean;
  verbose?: boolean;
}

export function createBenchmarkCommand(loggerFactory: LoggerFactory): Command {
  const command = new Command('benchmark')
    .description('Evaluate v3 performance gates from persisted run metrics.')
    .option('--run <run-id>', 'benchmark one run')
    .option('--compare <run-ids...>', 'compare exactly two run IDs')
    .option('--workspace <path>', 'local OpSense workspace directory');

  command.action(async (options: BenchmarkOptions) => {
    const logger = loggerFactory(command.optsWithGlobals<GlobalOptions>());
    try {
      const normalized = validateOptions(options);
      const result = await runBenchmarkWorkflow(normalized);
      if ('delta' in result) printComparison(logger, result);
      else printBenchmark(logger, result);
      process.exitCode = ExitCode.Success;
    } catch (error) {
      logger.error(`Benchmark failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = ExitCode.InvalidUsage;
    }
  });
  return command;
}

function validateOptions(options: BenchmarkOptions) {
  if ((options.run === undefined) === (options.compare === undefined))
    throw new InvalidArgumentError('Specify exactly one of --run or --compare.');
  if (options.compare !== undefined && options.compare.length !== 2)
    throw new InvalidArgumentError('--compare requires exactly two run IDs.');
  return {
    ...(options.run === undefined ? {} : { run: options.run }),
    ...(options.compare === undefined
      ? {}
      : { compare: [options.compare[0]!, options.compare[1]!] as [string, string] }),
    ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
  };
}

function printBenchmark(logger: ReturnType<LoggerFactory>, result: RunBenchmark): void {
  logger.info(`Run ${result.runId}: ${result.passed ? 'PASS' : 'FAIL'}`);
  logger.info(JSON.stringify(result, null, 2));
}

function printComparison(logger: ReturnType<LoggerFactory>, result: BenchmarkComparison): void {
  logger.info(`Compare ${result.baseline.runId} -> ${result.candidate.runId}`);
  logger.info(JSON.stringify(result.delta, null, 2));
}
