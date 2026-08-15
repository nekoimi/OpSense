import { Command, CommanderError } from 'commander';

import { createAnalyzeCommand } from './commands/analyze.js';
import { createAgentCommand } from './commands/agent.js';
import { createInspectCommand } from './commands/inspect.js';
import { createReportCommand } from './commands/report.js';
import { createScanCommand } from './commands/scan.js';
import { ExitCode } from './exit-code.js';
import { createLogger } from './logger.js';
import type { LoggerFactory } from './logger.js';
import { VERSION } from './version.js';

export interface ProgramDependencies {
  loggerFactory?: LoggerFactory;
}

export function createProgram({ loggerFactory = createLogger }: ProgramDependencies = {}): Command {
  const program = new Command()
    .name('opsense')
    .description('Inspect a Linux server and generate a local operations report.')
    .version(VERSION)
    .option('-v, --verbose', 'show diagnostic output')
    .option('-q, --quiet', 'suppress non-error output')
    .showHelpAfterError();

  program.addCommand(createScanCommand(loggerFactory));
  program.addCommand(createAnalyzeCommand(loggerFactory));
  program.addCommand(createReportCommand(loggerFactory));
  program.addCommand(createInspectCommand(loggerFactory));
  program.addCommand(createAgentCommand(loggerFactory));

  return program;
}

export async function run(argv: readonly string[] = process.argv): Promise<void> {
  const program = createProgram();
  program.exitOverride();

  try {
    await program.parseAsync([...argv]);
  } catch (error) {
    if (error instanceof CommanderError) {
      process.exitCode =
        error.exitCode === ExitCode.Success ? ExitCode.Success : ExitCode.InvalidUsage;
      return;
    }

    throw error;
  }
}
