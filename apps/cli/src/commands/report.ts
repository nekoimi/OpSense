import { Command, InvalidArgumentError } from 'commander';
import type { ReportFormat } from '@opsense/report';

import { ExitCode } from '../exit-code.js';
import type { LoggerFactory } from '../logger.js';
import { parseReportFormats, runReportWorkflow } from '../workflows/report-workflow.js';

interface ReportOptions {
  config?: string;
  format?: ReportFormat[];
  scan: string;
  timeZone?: string;
  workspace?: string;
}

interface GlobalOptions {
  quiet?: boolean;
  verbose?: boolean;
}

export function createReportCommand(loggerFactory: LoggerFactory): Command {
  const command = new Command('report')
    .description('Render a local report from an existing scan.')
    .requiredOption('--scan <scan-id>', 'scan ID to render')
    .option('--format <formats>', 'comma-separated report formats', parseFormats, ['docx', 'html'])
    .option('--time-zone <time-zone>', 'report display timezone')
    .option('--config <path>', 'configuration file path')
    .option('--workspace <path>', 'local OpSense workspace directory');

  command.action(async (options: ReportOptions) => {
    const logger = loggerFactory(command.optsWithGlobals<GlobalOptions>());
    try {
      const result = await runReportWorkflow({
        ...options,
        formats: options.format ?? ['docx', 'html'],
      });
      logger.info(`Report generated in: ${result.artifacts.outputDirectory}`);
      if (result.artifacts.docxFile !== undefined)
        logger.info(`Word: ${result.artifacts.docxFile}`);
      if (result.artifacts.htmlFile !== undefined)
        logger.info(`HTML: ${result.artifacts.htmlFile}`);
      for (const file of result.artifacts.markdownFiles) logger.info(`Markdown: ${file}`);
      process.exitCode = ExitCode.Success;
    } catch (error) {
      logger.error(`Report failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = ExitCode.ReportFailed;
    }
  });

  return command;
}

function parseFormats(value: string): ReportFormat[] {
  try {
    return parseReportFormats(value);
  } catch (error) {
    throw new InvalidArgumentError(error instanceof Error ? error.message : String(error));
  }
}
