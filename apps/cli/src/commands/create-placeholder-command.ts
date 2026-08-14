import { Command } from 'commander';

import { ExitCode } from '../exit-code.js';
import type { LoggerFactory } from '../logger.js';

interface GlobalOptions {
  quiet?: boolean;
  verbose?: boolean;
}

interface PlaceholderCommandOptions {
  configure?: (command: Command) => void;
  description: string;
  name: string;
}

export function createPlaceholderCommand(
  options: PlaceholderCommandOptions,
  loggerFactory: LoggerFactory,
): Command {
  const command = new Command(options.name).description(options.description);
  options.configure?.(command);

  command.action(() => {
    const globalOptions = command.optsWithGlobals<GlobalOptions>();
    const logger = loggerFactory(globalOptions);
    logger.debug(`Running M0 placeholder for '${options.name}'.`);
    logger.error(`The '${options.name}' command is not implemented yet (M0 skeleton).`);
    process.exitCode = ExitCode.NotImplemented;
  });

  return command;
}
