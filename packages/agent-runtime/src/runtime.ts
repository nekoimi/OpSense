import { randomUUID } from 'node:crypto';

import { AgentDecisionSchema, AgentTurnSchema, assertSchema } from '@opsense/schema';
import type { AgentDecision, AgentResponse, AgentSession, AgentTurn } from '@opsense/schema';

import type { ContextBuilder } from './context.js';
import { createAgentSession, createTranscriptEntry, failSessionForCodex } from './index.js';
import type { AgentSessionStore, CodexPreflightProbe } from './index.js';
import type { ToolRouter } from './tools.js';

export interface AgentThreadAdapter {
  start(options: { model?: string; workingDirectory?: string }): Promise<{ threadId: string }>;
  resume(
    threadId: string,
    options: { model?: string; workingDirectory?: string },
  ): Promise<{ threadId: string }>;
  run(
    threadId: string,
    prompt: string,
    options?: { signal?: AbortSignal },
  ): Promise<{
    decision: unknown;
    threadId?: string;
    responseId?: string;
    tokenUsage?: number;
  }>;
}

export interface AgentRuntimeOptions {
  scanId: string;
  session?: AgentSession;
  store: AgentSessionStore;
  thread: AgentThreadAdapter;
  context: ContextBuilder;
  tools: ToolRouter;
  preflight?: CodexPreflightProbe;
  model?: string;
  workingDirectory?: string;
  maxTurns?: number;
  maxDurationMs?: number;
  maxTokens?: number;
  maxOutputBytes?: number;
  turnTimeoutMs?: number;
  now?: () => Date;
}

export class AgentRuntime {
  private session: AgentSession;
  private readonly options: AgentRuntimeOptions;
  private readonly now: () => Date;
  private abortController: AbortController | undefined;
  private unchangedRounds = 0;
  private usedTokens = 0;
  private usedOutputBytes = 0;
  private readonly recentResults: unknown[] = [];

  public constructor(options: AgentRuntimeOptions) {
    this.options = options;
    this.now = options.now ?? (() => new Date());
    this.session =
      options.session ??
      createAgentSession({
        scanId: options.scanId,
        ...(options.model === undefined ? {} : { model: options.model }),
        now: this.now,
      });
  }

  public get currentSession(): AgentSession {
    return this.session;
  }

  public async addOutputFiles(files: readonly string[]): Promise<AgentSession> {
    this.session.outputFiles = [...new Set([...this.session.outputFiles, ...files])];
    this.session.updatedAt = this.now().toISOString();
    await this.options.store.save(this.session);
    return this.session;
  }

  public async start(
    userMessage = '请开始整理服务器 Wiki，优先确认主要服务和证据缺口。',
  ): Promise<AgentResponse> {
    if (this.session.state !== 'created') return this.resume(userMessage);
    this.session = await this.bootstrap(false);
    this.options.tools.setSession(this.session);
    return this.runUntilSettled(userMessage);
  }

  public async resume(userMessage = '继续调查未解决的服务和证据缺口。'): Promise<AgentResponse> {
    this.session = await this.options.store.load();
    this.options.tools.setSession(this.session);
    this.session = await this.bootstrap(true);
    this.options.tools.setSession(this.session);
    return this.runUntilSettled(userMessage);
  }

  public async runTurn(userMessage: string): Promise<AgentResponse> {
    if (this.session.state !== 'running')
      throw new Error(`Agent 当前不可运行：${this.session.state}`);
    const turnId = `turn-${randomUUID()}`;
    const sequence = this.session.turnCount + 1;
    const context = this.options.context.build({
      stage: this.session.currentStage,
      round: sequence,
      budget: this.session.budgets,
      recent: this.recentResults.slice(-3),
    });
    await this.options.store.appendTranscript(
      createTranscriptEntry(this.session.sessionId, sequence, 'user', userMessage, this.now),
    );
    const startedAt = this.now().toISOString();
    let decision: AgentDecision;
    let responseId: string | undefined;
    let tokenUsage: number | undefined;
    const controller = new AbortController();
    const turnTimeoutMs = this.options.turnTimeoutMs ?? 120_000;
    const timeoutSignal = AbortSignal.timeout(turnTimeoutMs);
    const turnSignal = AbortSignal.any([controller.signal, timeoutSignal]);
    this.abortController = controller;
    try {
      const result = await this.callThread(
        this.session.threadId,
        this.prompt(userMessage, context),
        turnSignal,
      );
      decision = parseDecision(result.decision);
      decision.turnId = turnId;
      if (result.threadId !== undefined) this.session.threadId = result.threadId;
      responseId = result.responseId;
      tokenUsage = result.tokenUsage;
      this.usedTokens += result.tokenUsage ?? 0;
    } catch (error) {
      if (controller.signal.aborted) {
        this.session = this.finish('interrupted');
        this.options.tools.setSession(this.session);
        await this.options.store.save(this.session);
        throw error;
      }
      const failure = timeoutSignal.aborted
        ? new Error(`Codex turn timed out after ${turnTimeoutMs} ms.`, { cause: error })
        : error instanceof Error
          ? error
          : new Error(String(error));
      const message = failure.message;
      await this.fail(message);
      throw failure;
    } finally {
      if (this.abortController === controller) this.abortController = undefined;
    }
    const toolCalls: AgentTurn['toolCalls'] = [];
    let evidenceAdded: string[] = [];
    let projectionChanges: string[] = [];
    let message = decision.reason;
    let observations: string[] = [];
    if (decision.kind === 'tool_call') {
      const result = await this.options.tools.execute(
        decision.toolName,
        decision.arguments,
        turnId,
      );
      toolCalls.push(result.activity);
      evidenceAdded = result.evidenceIds;
      projectionChanges = result.changedIds;
      message = result.summary;
      observations =
        result.value === undefined ? [] : [JSON.stringify(result.value).slice(0, 2_000)];
      this.recentResults.push({
        toolName: decision.toolName,
        status: result.status,
        summary: result.summary,
        evidenceIds: result.evidenceIds,
        value: result.value,
      });
    } else if (decision.kind === 'projection_update') {
      const result = await this.options.tools.execute('update_projection', decision, turnId);
      toolCalls.push(result.activity);
      evidenceAdded = result.evidenceIds;
      projectionChanges = result.changedIds;
      message = result.summary;
      this.recentResults.push({
        toolName: 'update_projection',
        status: result.status,
        summary: result.summary,
        evidenceIds: result.evidenceIds,
        changedIds: result.changedIds,
      });
    } else if (decision.kind === 'final') {
      this.session = this.finish('completed');
      this.options.tools.setSession(this.session);
      message = decision.qualitySummary;
    } else {
      await this.fail(decision.error);
    }
    const changed = evidenceAdded.length > 0 || projectionChanges.length > 0;
    this.unchangedRounds = changed ? 0 : this.unchangedRounds + 1;
    this.session.turnCount = sequence;
    this.session.unresolvedQuestions = [...decision.unresolvedQuestions];
    this.session.updatedAt = this.now().toISOString();
    this.usedOutputBytes +=
      Buffer.byteLength(message) +
      observations.reduce((total, item) => total + Buffer.byteLength(item), 0);
    if (decision.kind !== 'final' && decision.kind !== 'failed' && this.unchangedRounds >= 2)
      this.session = this.finish('partial');
    this.options.tools.setSession(this.session);
    const turn: AgentTurn = {
      turnId,
      sessionId: this.session.sessionId,
      sequence,
      startedAt,
      finishedAt: this.now().toISOString(),
      inputContextHash: context.hash,
      userMessage,
      decisionKind: decision.kind,
      toolCalls,
      evidenceAdded,
      projectionChanges,
      ...(responseId === undefined ? {} : { responseId }),
      ...(tokenUsage === undefined ? {} : { tokenUsage }),
    };
    assertSchema(AgentTurnSchema, turn);
    await this.options.store.appendTurn(turn);
    await this.options.store.appendTranscript(
      createTranscriptEntry(
        this.session.sessionId,
        sequence,
        'agent',
        message,
        this.now,
        responseId,
      ),
    );
    await this.options.store.save(this.session);
    return this.response(
      message,
      observations,
      toolCalls,
      evidenceAdded,
      projectionChanges,
      decision,
      turnId,
    );
  }

  public async interrupt(): Promise<AgentSession> {
    this.abortController?.abort();
    this.session = this.finish('interrupted');
    this.options.tools.setSession(this.session);
    await this.options.store.save(this.session);
    return this.session;
  }

  private async runUntilSettled(userMessage: string): Promise<AgentResponse> {
    let response = await this.runTurn(userMessage);
    while (this.session.state === 'running' && this.canContinue())
      response = await this.runTurn('根据上一轮结果继续调查最有价值的证据，并在信息充分时结束。');
    if (this.session.state === 'running') {
      this.session = this.finish('partial');
      this.options.tools.setSession(this.session);
      await this.options.store.save(this.session);
    }
    return response;
  }

  private async bootstrap(resume: boolean): Promise<AgentSession> {
    const initial: AgentSession = {
      ...this.session,
      state: 'running',
      currentStage: 'bootstrapping',
      updatedAt: this.now().toISOString(),
    };
    await this.options.store.save(initial);
    try {
      if (this.options.preflight !== undefined) {
        const probe = await this.options.preflight.check();
        if (!probe.available) throw new Error(probe.error ?? 'Codex preflight failed.');
      }
      const threadOptions = {
        ...(this.options.model === undefined ? {} : { model: this.options.model }),
        ...(this.options.workingDirectory === undefined
          ? {}
          : { workingDirectory: this.options.workingDirectory }),
      };
      const thread =
        resume && initial.threadId !== undefined
          ? await this.options.thread.resume(initial.threadId, threadOptions)
          : await this.options.thread.start(threadOptions);
      const ready: AgentSession = {
        ...initial,
        threadId: thread.threadId,
        currentStage: 'investigating',
        updatedAt: this.now().toISOString(),
      };
      await this.options.store.save(ready);
      return ready;
    } catch (error) {
      const failed = failSessionForCodex(
        initial,
        error instanceof Error ? error.message : String(error),
        ['修复 Codex 环境后使用 resume 恢复会话。'],
        this.now,
      );
      await this.options.store.save(failed);
      this.session = failed;
      this.options.tools.setSession(this.session);
      throw error;
    }
  }

  private async callThread(
    threadId: string | undefined,
    prompt: string,
    signal?: AbortSignal,
  ): Promise<{
    decision: unknown;
    threadId?: string;
    responseId?: string;
    tokenUsage?: number;
  }> {
    if (threadId === undefined) throw new Error('Codex Thread 尚未建立。');
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await raceWithAbort(
          this.options.thread.run(threadId, prompt, signal === undefined ? {} : { signal }),
          signal,
        );
      } catch (error) {
        lastError = error;
        if (signal?.aborted) throw error;
        const maxAttempts = isTimeoutError(error) ? 2 : 3;
        if (!isTransientThreadError(error) || attempt + 1 >= maxAttempts) throw error;
        await waitForRetry(250 * (attempt + 1), signal);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private prompt(userMessage: string, context: { l0: unknown; l1: unknown; hash: string }): string {
    return `OpSense Agent structured turn. Return exactly one JSON AgentDecision object matching the supplied output schema.

You are not a coding agent in this thread. Do not inspect files, run shell commands, access the network, or use built-in Codex tools. The sandbox directory is intentionally empty. All server facts must come from L0/L1 below or later OpSense tool results.

Allowed toolName values and arguments:
- read_context: {"section":"host|storage|network|services|processes|containers|systemd_summary|path_candidates|findings|visibility_summary","offset"?:number,"limit"?:number}
- read_evidence: {"ids":["existing-evidence-id"]}
- list_candidates: {"section"?:"services|paths|network|storage|findings"}
- execute_governed_probe: {"request": ProbeRequest}; use only for a concrete evidence gap
- update_projection: {"changes":[...],"evidenceIds":[...],"reason"?:string}

Never invent aliases such as get_evidence. Prefer one focused tool call per turn. Use kind=final only when the server Wiki projection is sufficiently supported by evidence.

User: ${userMessage}
Context hash: ${context.hash}
L0: ${JSON.stringify(context.l0)}
L1 index: ${JSON.stringify(context.l1)}`;
  }

  private canContinue(): boolean {
    const maxTurns = this.options.maxTurns ?? 8;
    const maxDurationMs = this.options.maxDurationMs ?? 300_000;
    const maxTokens = this.options.maxTokens ?? 100_000;
    const maxOutputBytes = this.options.maxOutputBytes ?? 2_000_000;
    const elapsed = Math.max(0, this.now().getTime() - new Date(this.session.startedAt).getTime());
    return (
      this.session.turnCount < maxTurns &&
      elapsed < maxDurationMs &&
      this.usedTokens < maxTokens &&
      this.usedOutputBytes < maxOutputBytes
    );
  }

  private async fail(message: string): Promise<void> {
    this.session = failSessionForCodex(
      this.session,
      message,
      ['检查 Codex 输出是否符合 AgentDecision Schema 后 resume。'],
      this.now,
    );
    this.options.tools.setSession(this.session);
    await this.options.store.save(this.session);
  }
  private finish(state: 'completed' | 'partial' | 'interrupted'): AgentSession {
    const at = this.now().toISOString();
    return {
      ...this.session,
      state,
      currentStage: state === 'completed' ? 'completed' : state,
      finishedAt: at,
      updatedAt: at,
    };
  }
  private response(
    message: string,
    observations: string[],
    activities: AgentTurn['toolCalls'],
    evidenceReferences: string[],
    updatedEntities: string[] = [],
    decision?: AgentDecision,
    turnId = `turn-${this.session.turnCount}`,
  ): AgentResponse {
    return {
      responseId: `response-${randomUUID()}`,
      sessionId: this.session.sessionId,
      turnId,
      message,
      observations,
      toolActivity: activities,
      evidenceReferences,
      updatedEntities,
      unresolvedQuestions: this.session.unresolvedQuestions,
      wikiArtifacts: this.session.outputFiles,
      nextSuggestions: decision?.nextSuggestions ?? [],
      nextAction: decision?.nextAction ?? '继续提问或执行 resume。',
    };
  }
}

function parseDecision(value: unknown): AgentDecision {
  assertSchema(AgentDecisionSchema, value);
  return value;
}

function isTransientThreadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /overload|temporar|try again|stream disconnected|connection|ECONN|rate limit|socket hang up|ETIMEDOUT|timeout/i.test(
    message,
  );
}

function isTimeoutError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /timeout|timed out|ETIMEDOUT/i.test(message);
}

function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort);
      reject(abortReason(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function waitForRetry(durationMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.reject(abortReason(signal));
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, durationMs);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(signal === undefined ? new Error('Codex turn aborted.') : abortReason(signal));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('Codex turn aborted.');
}
