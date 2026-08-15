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
    this.abortController = controller;
    try {
      const result = await this.callThread(
        this.session.threadId,
        this.prompt(userMessage, context),
        controller.signal,
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
      const message = error instanceof Error ? error.message : String(error);
      await this.fail(message);
      throw error;
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
        return await this.options.thread.run(
          threadId,
          prompt,
          signal === undefined ? {} : { signal },
        );
      } catch (error) {
        lastError = error;
        if (signal?.aborted) throw error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private prompt(userMessage: string, context: { l0: unknown; l1: unknown; hash: string }): string {
    return `OpSense Agent structured turn. Only use the five structured tools; never emit shell, network actions, secrets, or raw snapshot data. Return one JSON AgentDecision object.\nUser: ${userMessage}\nContext hash: ${context.hash}\nL0: ${JSON.stringify(context.l0)}\nL1 index: ${JSON.stringify(context.l1)}`;
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
