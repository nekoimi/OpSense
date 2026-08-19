import { createInterface } from 'node:readline/promises';
import { readFile } from 'node:fs/promises';

import { Command, InvalidArgumentError } from 'commander';
import { generateReportArtifacts } from '@opsense/report';
import { AgentTurnSchema, assertSchema } from '@opsense/schema';
import type { AgentResponse, AgentSession, AgentTurn, InventoryProjection } from '@opsense/schema';
import { createReportDirectory } from '@opsense/workspace';

import { ExitCode, exitCodeForError } from '../exit-code.js';
import {
  buildAgentProgressSnapshot,
  formatAgentCompletionProgress,
  formatAgentHeartbeat,
  formatAgentProgress,
} from '../agent-progress.js';
import type { Logger, LoggerFactory } from '../logger.js';
import { createInteractiveSudoPasswordProvider } from '../sudo-password.js';
import {
  prepareAgentWorkflow,
  type AgentWorkflowOptions,
  type PreparedAgentWorkflow,
} from '../workflows/agent-workflow.js';
import { parsePort } from './scan.js';

interface AgentCommandOptions {
  acceptNewHostKey?: boolean;
  complete?: boolean;
  config?: string;
  focusService?: string;
  host?: string;
  identity?: string;
  maxAgentRounds: number;
  maxAgentRuns: number;
  maxProbes: number;
  model?: string;
  once?: boolean;
  password?: string;
  port: number;
  preflightTimeoutMs: number;
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

const AGENT_HEARTBEAT_INTERVAL_MS = 10_000;

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
    .option('--provider <provider>', 'AI provider (requires codex)', 'codex')
    .option('--model <model>', 'Codex model override')
    .option('--prompt <text>', 'initial natural-language request')
    .option('--once', 'run one bounded Agent session without opening the REPL')
    .option(
      '--complete',
      'scan once, complete Codex classification, then generate HTML, Word, and Markdown Wiki files',
    )
    .option('--focus-service <service-id>', 'prioritize one service candidate')
    .option(
      '--max-agent-rounds <count>',
      'maximum model turns per request',
      parsePositiveInteger,
      16,
    )
    .option(
      '--max-agent-runs <count>',
      'maximum automatic Agent runs for --complete',
      parsePositiveInteger,
      200,
    )
    .option(
      '--max-probes <count>',
      'maximum governed probes in the session',
      parseNonNegativeInteger,
      4,
    )
    .option(
      '--preflight-timeout-ms <milliseconds>',
      'hard timeout for the Codex availability check',
      parsePositiveInteger,
      120_000,
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
      const sudoPasswordProvider = createInteractiveSudoPasswordProvider();
      if (options.host !== undefined && sudoPasswordProvider !== undefined)
        workflowOptions.sudoPasswordProvider = sudoPasswordProvider;
      prepared = await prepareAgentWorkflow(workflowOptions);
      logger.info(`Agent session: ${prepared.runtime.currentSession.sessionId}`);
      logger.info(`Local run directory: ${prepared.layout.runDirectory}`);
      printStatus(logger, prepared);
      const progressRuntime = createProgressRuntime(prepared, logger);
      const initialPrompt = withFocus(
        options.prompt ?? '整理当前服务器的主要服务、部署位置和证据缺口。',
        options.focusService,
      );
      if (options.complete === true) {
        if (
          prepared.runtime.currentSession.state === 'completed' &&
          prepared.projection.wikiNarrative !== undefined
        ) {
          logger.info('[Agent] 服务调查与 AI Wiki 综合稿件均已完成，直接生成服务器 Wiki。');
        } else {
          const initial = await startAgentToCompletion(
            progressRuntime,
            initialPrompt,
            options.resume !== undefined,
            logger,
            options.maxAgentRuns,
          );
          printResponse(logger, initial.response);
          await runAgentToCompletion(
            progressRuntime,
            initial.response,
            logger,
            options.maxAgentRuns,
            initial.runsUsed,
          );
        }
        await generateWikiArtifacts(prepared, logger);
      } else {
        const response =
          options.resume === undefined
            ? await progressRuntime.start(initialPrompt)
            : await progressRuntime.resume(initialPrompt);
        printResponse(logger, response);
        if (options.once !== true) await runRepl(prepared, logger, controller.signal);
      }
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

interface CompletionRuntime {
  currentSession: Pick<
    AgentSession,
    'coverage' | 'state' | 'stopReason' | 'turnCount' | 'workflowVersion'
  >;
  progressSummary?(): string;
  resume(userMessage?: string): Promise<AgentResponse>;
}

interface CompletionStartRuntime extends CompletionRuntime {
  start(userMessage?: string): Promise<AgentResponse>;
}

interface CompletionAttempt {
  response: AgentResponse;
  runsUsed: number;
}

export async function startAgentToCompletion(
  runtime: CompletionStartRuntime,
  initialPrompt: string,
  resumeExisting: boolean,
  logger: Logger,
  maxRuns: number,
): Promise<CompletionAttempt> {
  return executeWithTimeoutRecovery(
    runtime,
    () => (resumeExisting ? runtime.resume(initialPrompt) : runtime.start(initialPrompt)),
    logger,
    maxRuns,
    1,
  );
}

export async function runAgentToCompletion(
  runtime: CompletionRuntime,
  initialResponse: AgentResponse,
  logger: Logger,
  maxRuns: number,
  initialRunsUsed = 1,
): Promise<AgentResponse> {
  let response = initialResponse;
  let runsUsed = initialRunsUsed;
  for (;;) {
    const session = runtime.currentSession;
    if (session.state === 'completed') return response;
    if (session.state !== 'partial')
      throw new Error(`自动编排无法继续，Agent 当前状态为 ${session.state}。`);
    if (runsUsed >= maxRuns) break;
    logger.info(
      `Auto-resume ${runsUsed + 1}/${maxRuns}: turns=${session.turnCount}, ${completionProgress(runtime, session)}.`,
    );
    const attempt = await executeWithTimeoutRecovery(
      runtime,
      () => runtime.resume(completionPrompt(session)),
      logger,
      maxRuns,
      runsUsed + 1,
    );
    response = attempt.response;
    runsUsed = attempt.runsUsed;
    printResponse(logger, response);
  }
  const session = runtime.currentSession;
  throw new Error(
    `自动编排达到 ${maxRuns} 次运行上限，工作流仍未完成：turns=${session.turnCount}, ${completionProgress(runtime, session)}。可使用 --resume 继续，或提高 --max-agent-runs。`,
  );
}

async function executeWithTimeoutRecovery(
  runtime: CompletionRuntime,
  initialAction: () => Promise<AgentResponse>,
  logger: Logger,
  maxRuns: number,
  firstRun: number,
): Promise<CompletionAttempt> {
  let action = initialAction;
  for (let run = firstRun; run <= maxRuns; run += 1) {
    try {
      return { response: await action(), runsUsed: run };
    } catch (error) {
      if (!isRecoverableTurnTimeout(error, runtime.currentSession) || run === maxRuns) throw error;
      logger.info(`Codex turn timed out; auto-resume ${run + 1}/${maxRuns} with a fresh thread.`);
      action = () => runtime.resume(completionPrompt(runtime.currentSession));
    }
  }
  throw new Error(`自动编排达到 ${maxRuns} 次运行上限。`);
}

function completionPrompt(session: Pick<AgentSession, 'workflowVersion'>): string {
  return session.workflowVersion === 'm20_evidence_driven'
    ? '继续完成证据筛选、按需调查、服务归并和 AI Wiki 综合撰写，直到可以生成服务器 Wiki。'
    : '继续审查未完成的服务候选和路径，并完成 AI Wiki 综合撰写。';
}

function isRecoverableTurnTimeout(
  error: unknown,
  session: Pick<AgentSession, 'state' | 'stopReason'>,
): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    session.state === 'failed' &&
    session.stopReason === 'codex_failed' &&
    /timeout|timed out|ETIMEDOUT/i.test(message)
  );
}

async function runRepl(
  prepared: PreparedAgentWorkflow,
  logger: Logger,
  signal: AbortSignal,
): Promise<void> {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  const progressRuntime = createProgressRuntime(prepared, logger);
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
      printResponse(logger, await progressRuntime.resume(prompt));
    }
  } finally {
    terminal.close();
  }
}

async function generateWikiArtifacts(
  prepared: PreparedAgentWorkflow,
  logger: Logger,
): Promise<void> {
  const session = prepared.runtime.currentSession;
  if (session.state !== 'completed')
    throw new Error(`Wiki 只能从 completed AgentSession 生成，当前状态为 ${session.state}。`);
  assertWikiThreadAudit(
    session,
    prepared.projection,
    await readAgentTurns(prepared.layout.agentTurnsFile),
  );
  const scannedAt = new Date(
    prepared.snapshot.session.finishedAt ?? prepared.snapshot.session.startedAt,
  );
  const outputDirectory = createReportDirectory(
    prepared.snapshot.session.target.host,
    scannedAt,
    prepared.layout.rootDirectory,
  );
  logger.info('[Agent] 正在生成 HTML、Word 和 Markdown 服务器 Wiki。');
  let artifacts: Awaited<ReturnType<typeof generateReportArtifacts>>;
  try {
    artifacts = await generateReportArtifacts(prepared.projection, {
      formats: ['docx', 'html', 'markdown'],
      outputDirectory,
      requireCodexClassification: true,
      sourceSnapshot: prepared.snapshot,
    });
  } catch (error) {
    await prepared.runtime.recordQualityGateFailure(
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  }
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

async function readAgentTurns(file: string): Promise<AgentTurn[]> {
  const source = await readFile(file, 'utf8');
  return source
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const value = JSON.parse(line) as unknown;
      assertSchema(AgentTurnSchema, value);
      return value;
    });
}

export function assertWikiThreadAudit(
  session: Pick<AgentSession, 'sessionId' | 'threadId' | 'turnCount'>,
  projection: Pick<InventoryProjection, 'classificationThreadId' | 'wikiNarrative'>,
  turns: readonly AgentTurn[],
): void {
  if (session.threadId === undefined)
    throw new Error('Wiki 审计失败：completed AgentSession 缺少最终 Codex Thread ID。');
  if (projection.classificationThreadId === undefined)
    throw new Error('Wiki 审计失败：Projection 缺少 Codex 分类 Thread ID。');
  const sessionTurns = turns.filter((turn) => turn.sessionId === session.sessionId);
  const finalTurnAudited = sessionTurns.some(
    (turn) =>
      turn.sequence === session.turnCount &&
      turn.threadId === session.threadId &&
      turn.decisionKind === 'final',
  );
  if (!finalTurnAudited)
    throw new Error('Wiki 审计失败：最终 Session Thread 没有对应的 final Turn。');
  const classificationTurnAudited = sessionTurns.some(
    (turn) =>
      turn.threadId === projection.classificationThreadId &&
      turn.projectionChanges.length > 0 &&
      turn.toolCalls.some(
        (tool) =>
          tool.status === 'completed' &&
          (tool.toolName === 'plan_discovery' || tool.toolName === 'update_projection'),
      ),
  );
  if (!classificationTurnAudited)
    throw new Error('Wiki 审计失败：Projection 分类 Thread 没有对应的成功变更 Turn。');
  if (projection.wikiNarrative === undefined)
    throw new Error('Wiki 审计失败：Projection 缺少 Codex 撰写的服务器综合稿件。');
  const compositionTurnAudited = sessionTurns.some(
    (turn) =>
      turn.threadId === projection.wikiNarrative?.threadId &&
      turn.projectionChanges.some((id) => id.startsWith('wiki-narrative:')) &&
      turn.toolCalls.some(
        (tool) => tool.status === 'completed' && tool.toolName === 'compose_wiki',
      ),
  );
  if (!compositionTurnAudited)
    throw new Error('Wiki 审计失败：服务器综合稿件 Thread 没有对应的 compose_wiki Turn。');
}

function printStatus(logger: Logger, prepared: PreparedAgentWorkflow): void {
  const session = prepared.runtime.currentSession;
  for (const line of formatAgentProgress(buildProgressSnapshot(prepared))) logger.info(line);
  logger.info(
    `  预算：${formatBytes(session.budgets.usedBytes)}/${formatBytes(session.budgets.maxBytes)}，${formatDuration(session.budgets.usedDurationMs)}/${formatDuration(session.budgets.maxDurationMs)}`,
  );
  logger.info(`  会话：${session.sessionId} | Thread ${session.threadId ?? '尚未创建'}`);
}

function createProgressRuntime(
  prepared: PreparedAgentWorkflow,
  logger: Logger,
): CompletionStartRuntime {
  return {
    get currentSession() {
      return prepared.runtime.currentSession;
    },
    progressSummary: () => formatAgentCompletionProgress(buildProgressSnapshot(prepared)),
    resume: (message) =>
      runWithAgentHeartbeat(prepared, logger, () => prepared.runtime.resume(message)),
    start: (message) =>
      runWithAgentHeartbeat(prepared, logger, () => prepared.runtime.start(message)),
  };
}

async function runWithAgentHeartbeat<T>(
  prepared: PreparedAgentWorkflow,
  logger: Logger,
  action: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  const report = (): void => {
    logger.info(formatAgentHeartbeat(buildProgressSnapshot(prepared), Date.now() - startedAt));
  };
  report();
  const heartbeat = setInterval(report, AGENT_HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();
  try {
    const result = await action();
    report();
    return result;
  } finally {
    clearInterval(heartbeat);
  }
}

function buildProgressSnapshot(prepared: PreparedAgentWorkflow) {
  return buildAgentProgressSnapshot(
    prepared.runtime.currentSession,
    prepared.projection,
    prepared.runtime.currentProgress,
  );
}

function printServices(logger: Logger, prepared: PreparedAgentWorkflow): void {
  const assessment = new Map(
    prepared.projection.serviceAssessments.map((item) => [item.serviceId, item]),
  );
  const lines = prepared.projection.services
    .filter(
      (service) =>
        assessment.has(service.id) &&
        assessment.get(service.id)?.reportPlacement !== 'system_summary',
    )
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
    logger.info(
      detail.length > 4_000
        ? `${detail.slice(0, 4_000)}\n[终端详情已截断至 4000 字符；不会截断已采集证据或生成的报告]`
        : detail,
    );
  if (response.unresolvedQuestions.length > 0)
    logger.info(`待确认（不代表运行失败）: ${response.unresolvedQuestions.join('; ')}`);
}

function validateOptions(options: AgentCommandOptions, signal: AbortSignal): AgentWorkflowOptions {
  if (options.provider !== 'codex')
    throw new InvalidArgumentError('OpSense Agent requires --provider codex.');
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
    preflightTimeoutMs: options.preflightTimeoutMs,
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

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(value: number): string {
  if (value < 1000) return `${value} ms`;
  const seconds = Math.round(value / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function completionProgress(
  runtime: CompletionRuntime,
  session: Pick<AgentSession, 'coverage' | 'workflowVersion'>,
): string {
  if (runtime.progressSummary !== undefined) return runtime.progressSummary();
  const value = session.coverage.classification;
  const coverage = value === undefined ? 'unknown' : `${(value * 100).toFixed(1)}%`;
  return `${session.workflowVersion === 'm20_evidence_driven' ? 'discovery' : 'classification'}=${coverage}`;
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
