import { readFile } from 'node:fs/promises';

import { CodexProvider } from '@opsense/ai-codex';
import { BaselineRelevanceClassifier, NoopProvider, buildAiWorkspace } from '@opsense/ai-provider';
import type { AiProvider } from '@opsense/ai-provider';
import {
  AiAnalysisSchema,
  AiPlanSchema,
  AiProbeAuditSchema,
  AiRunSchema,
  ScanSnapshotSchema,
  assertSchema,
} from '@opsense/schema';
import type { ScanSnapshot } from '@opsense/schema';
import {
  createRunWorkspaceLayout,
  ensureRunWorkspace,
  loadConfig,
  writeJsonAtomic,
} from '@opsense/workspace';
import { Command, InvalidArgumentError } from 'commander';

import { ExitCode } from '../exit-code.js';
import type { LoggerFactory } from '../logger.js';

interface AnalyzeOptions {
  config?: string;
  maxRetries?: number;
  model?: string;
  provider: string;
  scan: string;
  threadId?: string;
  timeoutMs: number;
  workspace?: string;
}

interface GlobalOptions {
  quiet?: boolean;
  verbose?: boolean;
}

export function createAnalyzeCommand(loggerFactory: LoggerFactory): Command {
  const command = new Command('analyze')
    .description('Analyze an existing scan snapshot with Codex or the local baseline provider.')
    .requiredOption('--scan <scan-id>', 'scan ID to analyze')
    .option('--provider <provider>', 'AI provider: codex or noop', 'codex')
    .option('--model <model>', 'Codex model override')
    .option('--thread-id <thread-id>', 'resume an existing Codex thread')
    .option('--timeout-ms <milliseconds>', 'Codex turn timeout', parsePositiveInteger, 120_000)
    .option('--max-retries <count>', 'structured output repair retries', parseNonNegativeInteger)
    .option('--config <path>', 'configuration file path')
    .option('--workspace <path>', 'local OpSense workspace directory');

  command.action(async (options: AnalyzeOptions) => {
    const logger = loggerFactory(command.optsWithGlobals<GlobalOptions>());
    try {
      const loaded = await loadConfig({
        ...(options.config === undefined ? {} : { explicitPath: options.config }),
        ...(options.workspace === undefined ? {} : { workspaceRoot: options.workspace }),
      });
      const workspaceRoot = options.workspace ?? loaded.config.workspace.rootDirectory;
      const layout = createRunWorkspaceLayout(options.scan, workspaceRoot);
      await ensureRunWorkspace(options.scan, workspaceRoot);
      const snapshot = await readSnapshot(layout.snapshotFile);
      const baselinePlan = new BaselineRelevanceClassifier().classify(snapshot);
      await buildAiWorkspace(snapshot, layout.aiInputDirectory, () => new Date(), baselinePlan);
      const provider = createProvider(options.provider);
      logger.debug(`Analyzing ${options.scan} with provider '${provider.name}'.`);
      const result = await provider.analyze(
        { aiInputDirectory: layout.aiInputDirectory, baselinePlan, snapshot },
        {
          maxRetries: options.maxRetries ?? loaded.config.ai.maxRetries,
          timeoutMs: options.timeoutMs,
          ...(options.model === undefined ? {} : { model: options.model }),
          ...(options.threadId === undefined ? {} : { threadId: options.threadId }),
        },
      );
      assertSchema(AiPlanSchema, result.plan);
      assertSchema(AiProbeAuditSchema, result.probeAudit);
      assertSchema(AiAnalysisSchema, result.analysis);
      assertSchema(AiRunSchema, result.run);
      await Promise.all([
        writeJsonAtomic(layout.aiPlanFile, result.plan),
        writeJsonAtomic(layout.aiProbeAuditFile, result.probeAudit),
        writeJsonAtomic(layout.aiOutputFile, result.analysis),
        writeJsonAtomic(layout.aiRunFile, result.run),
      ]);
      logger.info(
        `Analysis ${options.scan} completed with state '${result.run.status}' using '${result.analysis.provider}'.`,
      );
      logger.info(layout.aiOutputFile);
      process.exitCode = ExitCode.Success;
    } catch (error) {
      logger.error(`Analysis failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = ExitCode.GeneralError;
    }
  });

  return command;
}

async function readSnapshot(file: string): Promise<ScanSnapshot> {
  const value = JSON.parse(await readFile(file, 'utf8')) as unknown;
  assertSchema(ScanSnapshotSchema, value);
  return value;
}

function createProvider(name: string): AiProvider {
  if (name === 'codex') return new CodexProvider();
  if (name === 'noop' || name === 'baseline') return new NoopProvider();
  throw new InvalidArgumentError(`Unsupported AI provider '${name}'.`);
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
