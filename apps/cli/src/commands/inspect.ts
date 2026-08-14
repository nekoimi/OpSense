import type { Command } from 'commander';

import type { LoggerFactory } from '../logger.js';
import { createPlaceholderCommand } from './create-placeholder-command.js';

export function createInspectCommand(loggerFactory: LoggerFactory): Command {
  return createPlaceholderCommand(
    {
      name: 'inspect',
      description: 'Scan, analyze, and render a report in one local workflow.',
      configure(command) {
        command
          .option('--host <host>', 'target host name or IP address')
          .option('--port <port>', 'SSH port', '22')
          .option('--user <user>', 'SSH user name')
          .option('--provider <provider>', 'AI provider', 'codex');
      },
    },
    loggerFactory,
  );
}
