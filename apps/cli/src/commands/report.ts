import type { Command } from 'commander';

import type { LoggerFactory } from '../logger.js';
import { createPlaceholderCommand } from './create-placeholder-command.js';

export function createReportCommand(loggerFactory: LoggerFactory): Command {
  return createPlaceholderCommand(
    {
      name: 'report',
      description: 'Render a local report from an existing scan.',
      configure(command) {
        command
          .option('--scan <scan-id>', 'scan ID to render')
          .option('--format <format>', 'report format', 'docx');
      },
    },
    loggerFactory,
  );
}
