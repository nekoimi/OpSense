import type { Command } from 'commander';

import type { LoggerFactory } from '../logger.js';
import { createPlaceholderCommand } from './create-placeholder-command.js';

export function createAnalyzeCommand(loggerFactory: LoggerFactory): Command {
  return createPlaceholderCommand(
    {
      name: 'analyze',
      description: 'Analyze an existing scan snapshot with an AI provider.',
      configure(command) {
        command
          .option('--scan <scan-id>', 'scan ID to analyze')
          .option('--provider <provider>', 'AI provider', 'codex');
      },
    },
    loggerFactory,
  );
}
