import type { Command } from 'commander';

import type { LoggerFactory } from '../logger.js';
import { createPlaceholderCommand } from './create-placeholder-command.js';

export function createScanCommand(loggerFactory: LoggerFactory): Command {
  return createPlaceholderCommand(
    {
      name: 'scan',
      description: 'Collect a read-only snapshot from one Linux server.',
      configure(command) {
        command
          .option('--host <host>', 'target host name or IP address')
          .option('--port <port>', 'SSH port', '22')
          .option('--user <user>', 'SSH user name');
      },
    },
    loggerFactory,
  );
}
