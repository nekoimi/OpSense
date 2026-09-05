import { Command } from 'commander';

import { ExitCode } from '../exit-code.js';
import type { LoggerFactory } from '../logger.js';
import { runInventoryReportWorkflow } from '../workflows/inventory-report-workflow.js';

interface ReportOptions {
  config?: string;
  inventory: string;
  workspace?: string;
}

interface GlobalOptions {
  quiet?: boolean;
  verbose?: boolean;
}

export function createReportCommand(loggerFactory: LoggerFactory): Command {
  const command = new Command('report')
    .description('Regenerate v3 reports from a stable Deployment Inventory.')
    .requiredOption('--inventory <inventory-id>', 'stable Deployment Inventory ID')
    .option('--config <path>', 'configuration file path')
    .option('--workspace <path>', 'local OpSense workspace directory');

  command.action(async (options: ReportOptions) => {
    const logger = loggerFactory(command.optsWithGlobals<GlobalOptions>());
    try {
      const result = await runInventoryReportWorkflow(options);
      logger.info(`Report generated in: ${result.artifacts.outputDirectory}`);
      logger.info(`Word: ${result.artifacts.docxFile}`);
      logger.info(`HTML: ${result.artifacts.htmlFile}`);
      logger.info(`Markdown: ${result.artifacts.markdownFile}`);
      process.exitCode = ExitCode.Success;
    } catch (error) {
      logger.error(`Report failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = ExitCode.ReportFailed;
    }
  });

  return command;
}
