import { Command, InvalidArgumentError } from 'commander';

import { ExitCode, exitCodeForError } from '../exit-code.js';
import type { LoggerFactory } from '../logger.js';
import { runAgentWorkflow } from '../workflows/agent-workflow.js';

interface AgentCommandOptions {
  config?: string;
  inventory: string;
  maxRetries: number;
  model?: string;
  prompt: string;
  provider: string;
  threadId?: string;
  timeoutMs: number;
  workspace?: string;
}

interface GlobalOptions {
  quiet?: boolean;
  verbose?: boolean;
}

export function createAgentCommand(loggerFactory: LoggerFactory): Command {
  const command = new Command('agent')
    .description('Investigate a stable v3 Deployment Inventory after report generation.')
    .requiredOption('--inventory <inventory-id>', 'stable Deployment Inventory ID')
    .requiredOption('--prompt <text>', 'question or requested revision')
    .option('--provider <provider>', 'AI provider (requires codex)', 'codex')
    .option('--model <model>', 'Codex model override')
    .option('--thread-id <thread-id>', 'continue an existing Codex thread')
    .option('--timeout-ms <milliseconds>', 'Codex turn timeout', parsePositiveInteger, 120_000)
    .option('--max-retries <count>', 'structured output repair retries', parseNonNegativeInteger, 1)
    .option('--config <path>', 'configuration file path')
    .option('--workspace <path>', 'local OpSense workspace directory');

  command.action(async (options: AgentCommandOptions) => {
    const logger = loggerFactory(command.optsWithGlobals<GlobalOptions>());
    const controller = new AbortController();
    const interrupt = (): void => controller.abort();
    process.on('SIGINT', interrupt);
    try {
      if (options.provider !== 'codex')
        throw new InvalidArgumentError('OpSense v3 post-report Agent requires --provider codex.');
      const result = await runAgentWorkflow({ ...options, signal: controller.signal });
      logger.info(result.agent.proposal.message);
      for (const reference of result.agent.proposal.evidenceReferences)
        logger.info(`Evidence: ${reference}`);
      if (result.inventoryRevision !== undefined)
        logger.info(`Inventory revision: ${result.inventoryRevision.revisionId}`);
      if (result.wikiRevision !== undefined)
        logger.info(`Wiki revision: ${result.wikiRevision.revisionId}`);
      if (result.agent.run.threadId !== undefined)
        logger.info(`Codex thread: ${result.agent.run.threadId}`);
      process.exitCode = ExitCode.Success;
    } catch (error) {
      logger.error(`Agent failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = controller.signal.aborted ? ExitCode.Interrupted : exitCodeForError(error);
    } finally {
      process.off('SIGINT', interrupt);
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
