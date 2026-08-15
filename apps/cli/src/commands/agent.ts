import { createInterface } from 'node:readline/promises';

import { Command, InvalidArgumentError } from 'commander';
import { generateReportArtifacts } from '@opsense/report';
import { createReportDirectory } from '@opsense/workspace';

import { ExitCode, exitCodeForError } from '../exit-code.js';
import type { Logger, LoggerFactory } from '../logger.js';
import {
  prepareAgentWorkflow,
  type AgentWorkflowOptions,
  type PreparedAgentWorkflow,
} from '../workflows/agent-workflow.js';
import { parsePort } from './scan.js';

interface AgentCommandOptions {
  acceptNewHostKey?: boolean;
  config?: string;
  focusService?: string;
  host?: string;
  identity?: string;
  maxAgentRounds: number;
  maxProbes: number;
  model?: string;
  once?: boolean;
  password?: string;
  port: number;
  prompt?: string;
  provider: string;
  resume?: string;
  scan?: string;
  turnTimeoutMs: number;
  user?: string;
  workspace?: string;
}

interface GlobalOptions {
  quiet?: boolean;
  verbose?: boolean;
}

export function createAgentCommand(loggerFactory: LoggerFactory): Command {
  const command = new Command('agent')
    .description('Start or resume the local Codex server-wiki agent.')
    .option('--host <host>', 'target host name or IP address')
    .option('--port <port>', 'SSH port', parsePort, 22)
    .option('--user <user>', 'SSH user name')
    .option('--identity <path>', 'SSH private key file')
    .option('--password <password>', 'SSH password (memory only)')
    .option('--accept-new-host-key', 'trust and store the host key on first connection')
    .option('--scan <scan-id>', 'start from an existing scan snapshot')
    .option('--resume <agent-session-id>', 'resume an existing Agent session')
    .option('--provider <provider>', 'AI provider (v2 requires codex)', 'codex')
    .option('--model <model>', 'Codex model override')
    .option('--prompt <text>', 'initial natural-language request')
    .option('--once', 'run to convergence once without opening the REPL')
    .option('--focus-service <service-id>', 'prioritize one service candidate')
    .option(
      '--max-agent-rounds <count>',
      'maximum model turns per request',
      parsePositiveInteger,
      8,
    )
    .option(
      '--max-probes <count>',
      'maximum governed probes in the session',
      parseNonNegativeInteger,
      4,
    )
    .option(
      '--turn-timeout-ms <milliseconds>',
      'hard timeout for each Codex turn',
      parsePositiveInteger,
      120_000,
    )
    .option('--config <path>', 'configuration file path')
    .option('--workspace <path>', 'local OpSense workspace directory');

  command.action(async (options: AgentCommandOptions) => {
    const logger = loggerFactory(command.optsWithGlobals<GlobalOptions>());
    const controller = new AbortController();
    let prepared: PreparedAgentWorkflow | undefined;
    const interrupt = (): void => {
      controller.abort();
      void prepared?.runtime.interrupt();
    };
    process.on('SIGINT', interrupt);
    try {
      const workflowOptions = validateOptions(options, controller.signal);
      prepared = await prepareAgentWorkflow(workflowOptions);
      logger.info(`Agent session: ${prepared.runtime.currentSession.sessionId}`);
      logger.info(`Local run directory: ${prepared.layout.runDirectory}`);
      const initialPrompt = withFocus(
        options.prompt ?? '整理当前服务器的主要服务、部署位置和证据缺口。',
        options.focusService,
      );
      const response =
        options.resume === undefined
          ? await prepared.runtime.start(initialPrompt)
          : await prepared.runtime.resume(initialPrompt);
      printResponse(logger, response);
      if (options.once !== true) await runRepl(prepared, logger, controller.signal);
      process.exitCode = ExitCode.Success;
    } catch (error) {
      logger.error(`Agent failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = controller.signal.aborted ? ExitCode.Interrupted : exitCodeForError(error);
    } finally {
      prepared?.close();
      process.off('SIGINT', interrupt);
    }
  });
  return command;
}

async function runRepl(
  prepared: PreparedAgentWorkflow,
  logger: Logger,
  signal: AbortSignal,
): Promise<void> {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  logger.info('Commands: status, services, show <service-id>, review, wiki, resume, exit');
  try {
    for (;;) {
      const input = (await terminal.question('opsense> ', { signal })).trim();
      if (input.length === 0) continue;
      if (input === 'exit') break;
      if (input === 'status') {
        printStatus(logger, prepared);
        continue;
      }
      if (input === 'services') {
        printServices(logger, prepared);
        continue;
      }
      if (input.startsWith('show ')) {
        printService(logger, prepared, input.slice(5).trim());
        continue;
      }
      if (input === 'review') {
        printReview(logger, prepared);
        continue;
      }
      if (input === 'wiki') {
        await generateWikiArtifacts(prepared, logger);
        continue;
      }
      const prompt = input === 'resume' ? '继续处理当前会话中尚未解决的问题。' : input;
      printResponse(logger, await prepared.runtime.resume(prompt));
    }
  } finally {
    terminal.close();
  }
}

async function generateWikiArtifacts(
  prepared: PreparedAgentWorkflow,
  logger: Logger,
): Promise<void> {
  const scannedAt = new Date(
    prepared.snapshot.session.finishedAt ?? prepared.snapshot.session.startedAt,
  );
  const outputDirectory = createReportDirectory(
    prepared.snapshot.session.target.host,
    scannedAt,
    prepared.layout.rootDirectory,
  );
  const artifacts = await generateReportArtifacts(prepared.projection, {
    formats: ['docx', 'html', 'markdown'],
    outputDirectory,
    sourceSnapshot: prepared.snapshot,
  });
  const files = [
    artifacts.docxFile,
    artifacts.htmlFile,
    ...artifacts.markdownFiles,
    artifacts.modelFile,
    artifacts.projectionFile,
    artifacts.qualityFile,
    artifacts.wikiProjectionFile,
  ].filter((file): file is string => file !== undefined);
  await prepared.runtime.addOutputFiles(files);
  logger.info(`Wiki artifacts generated: ${outputDirectory}`);
  printResponse(logger, {
    responseId: 'wiki-artifacts',
    sessionId: prepared.runtime.currentSession.sessionId,
    turnId: `turn-${prepared.runtime.currentSession.turnCount}`,
    message: '服务器 Wiki 文档已生成。',
    observations: files,
    toolActivity: [],
    evidenceReferences: [],
    updatedEntities: [],
    unresolvedQuestions: prepared.runtime.currentSession.unresolvedQuestions,
    wikiArtifacts: files,
    nextSuggestions: [],
    nextAction: '继续提问或执行 exit。',
  });
}

function printStatus(logger: Logger, prepared: PreparedAgentWorkflow): void {
  const session = prepared.runtime.currentSession;
  logger.info(
    `State=${session.state} Stage=${session.currentStage} Turns=${session.turnCount} Thread=${session.threadId ?? 'unavailable'}`,
  );
  logger.info(
    `Probes=${session.budgets.usedRequests}/${session.budgets.maxRequests} Bytes=${session.budgets.usedBytes}/${session.budgets.maxBytes} Duration=${session.budgets.usedDurationMs}/${session.budgets.maxDurationMs}ms`,
  );
}

function printServices(logger: Logger, prepared: PreparedAgentWorkflow): void {
  const assessment = new Map(
    prepared.projection.serviceAssessments.map((item) => [item.serviceId, item]),
  );
  const lines = prepared.projection.services
    .filter((service) => assessment.get(service.id)?.reportPlacement !== 'system_summary')
    .map((service) => {
      const current = assessment.get(service.id);
      return `${service.id}\t${service.displayName ?? service.name}\t${service.status}\t${current?.role ?? 'unknown'}\t${current?.reportPlacement ?? 'needs_review'}`;
    });
  logger.info(lines.length === 0 ? 'No visible service candidates.' : lines.join('\n'));
}

function printService(logger: Logger, prepared: PreparedAgentWorkflow, serviceId: string): void {
  const service = prepared.projection.services.find((item) => item.id === serviceId);
  if (service === undefined) {
    logger.error(`Unknown service: ${serviceId}`);
    return;
  }
  const assessment = prepared.projection.serviceAssessments.find(
    (item) => item.serviceId === serviceId,
  );
  logger.info(
    JSON.stringify(
      {
        id: service.id,
        name: service.displayName ?? service.name,
        status: service.status,
        deploymentType: service.deploymentType,
        deployDirectories: service.deployDirectories,
        configFiles: service.configFiles,
        dataDirectories: service.dataDirectories,
        logLocations: service.logLocations,
        evidenceIds: service.evidenceIds,
        assessment,
      },
      null,
      2,
    ),
  );
}

function printReview(logger: Logger, prepared: PreparedAgentWorkflow): void {
  logger.info(
    JSON.stringify(
      {
        findings: prepared.projection.findings,
        unknowns: prepared.runtime.currentSession.unresolvedQuestions,
        filteredCounts: prepared.projection.filteredCounts,
      },
      null,
      2,
    ),
  );
}

function printResponse(
  logger: Logger,
  response: Awaited<ReturnType<PreparedAgentWorkflow['runtime']['start']>>,
): void {
  logger.info(response.message);
  if (response.toolActivity.length > 0)
    logger.info(
      `Tools: ${response.toolActivity.map((item) => `${item.toolName}:${item.status}`).join(', ')}`,
    );
  const detail = response.observations.join('\n');
  if (detail.length > 0)
    logger.info(detail.length > 4_000 ? `${detail.slice(0, 4_000)}\n[output truncated]` : detail);
  if (response.unresolvedQuestions.length > 0)
    logger.info(`Unresolved: ${response.unresolvedQuestions.join('; ')}`);
}

function validateOptions(options: AgentCommandOptions, signal: AbortSignal): AgentWorkflowOptions {
  if (options.provider !== 'codex')
    throw new InvalidArgumentError('OpSense v2 Agent requires --provider codex.');
  const sources = [options.host, options.scan, options.resume].filter(
    (value) => value !== undefined,
  );
  if (sources.length !== 1)
    throw new InvalidArgumentError('Specify exactly one of --host, --scan, or --resume.');
  if (options.host !== undefined && options.user === undefined)
    throw new InvalidArgumentError('--host requires --user.');
  return {
    provider: 'codex',
    port: options.port,
    maxAgentRounds: options.maxAgentRounds,
    maxProbes: options.maxProbes,
    turnTimeoutMs: options.turnTimeoutMs,
    signal,
    ...(options.acceptNewHostKey === undefined
      ? {}
      : { acceptNewHostKey: options.acceptNewHostKey }),
    ...(options.config === undefined ? {} : { config: options.config }),
    ...(options.focusService === undefined ? {} : { focusService: options.focusService }),
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(options.identity === undefined ? {} : { identity: options.identity }),
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.password === undefined ? {} : { password: options.password }),
    ...(options.resume === undefined ? {} : { resume: options.resume }),
    ...(options.scan === undefined ? {} : { scan: options.scan }),
    ...(options.user === undefined ? {} : { user: options.user }),
    ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
  };
}

function withFocus(prompt: string, focusService: string | undefined): string {
  return focusService === undefined ? prompt : `${prompt}\n优先调查服务：${focusService}`;
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
