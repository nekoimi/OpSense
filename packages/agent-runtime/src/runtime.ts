import { randomUUID } from 'node:crypto';

import { AgentDecisionSchema, AgentTurnSchema, assertSchema } from '@opsense/schema';
import type { AgentDecision, AgentResponse, AgentSession, AgentTurn } from '@opsense/schema';

import type { ContextBuilder } from './context.js';
import { AGENT_DECISION_PROMPT_CONTRACT } from './decision-contract.js';
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
  maxTurnsPerThread?: number;
  turnTimeoutMs?: number;
  requireClassificationComplete?: boolean;
  now?: () => Date;
}

export class AgentRuntime {
  private session: AgentSession;
  private readonly options: AgentRuntimeOptions;
  private readonly now: () => Date;
  private abortController: AbortController | undefined;
  private usedTokens = 0;
  private usedOutputBytes = 0;
  private threadTurnCount = 0;
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

  public async recordQualityGateFailure(message: string): Promise<AgentSession> {
    const at = this.now().toISOString();
    this.session = {
      ...this.session,
      currentStage: 'reviewing',
      lastError: message,
      finishedAt: at,
      state: 'partial',
      stopReason: 'quality_gate_failed',
      updatedAt: at,
    };
    this.options.tools.setSession(this.session);
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
      this.threadTurnCount += 1;
    } catch (error) {
      if (controller.signal.aborted) {
        this.session = this.finish('interrupted', 'user_interrupted');
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
        ...(decision.toolName === 'plan_discovery' || decision.toolName === 'update_projection'
          ? {}
          : {
              arguments: decision.arguments,
              value: compactRecentValue(
                result.value,
                this.session.workflowVersion === 'm20_evidence_driven' ? 12 : 2,
              ),
            }),
      });
      if (decision.toolName === 'compose_wiki' && result.status === 'completed')
        this.session.currentStage = 'reviewing';
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
      const classification = this.options.tools.classificationStatus();
      const composition = this.options.tools.wikiCompositionStatus();
      if (this.options.requireClassificationComplete === true && !classification.completed) {
        const evidenceDriven = this.session.workflowVersion === 'm20_evidence_driven';
        message = evidenceDriven
          ? `Codex 证据调查尚未完成：有效服务 ${classification.reviewedServiceCount}/${classification.candidateServiceCount}，请继续完成调查计划或明确待确认项，不能生成 v2 Wiki。`
          : `Codex 语义审查尚未完成：服务 ${classification.reviewedServiceCount}/${classification.candidateServiceCount}，路径 ${classification.reviewedPathCount}/${classification.candidatePathCount}。继续审查未处理候选，不能生成 v2 Wiki。`;
        this.session.currentStage = 'validating';
        this.recentResults.push({
          toolName: 'completion_gate',
          status: 'rejected',
          summary: message,
          unreviewedServiceIds: classification.unreviewedServiceIds.slice(0, 40),
        });
      } else if (this.options.requireClassificationComplete === true && !composition.completed) {
        message =
          'Codex 服务调查已完成，但尚未通过 compose_wiki 撰写服务器 Wiki 综合稿件，不能生成最终报告。';
        this.session.currentStage = 'composing';
        this.recentResults.push({
          toolName: 'composition_gate',
          status: 'rejected',
          summary: message,
        });
      } else {
        this.session = this.finish('completed', 'classification_complete');
        this.options.tools.setSession(this.session);
        message = decision.qualitySummary;
      }
    } else {
      const classification = this.options.tools.classificationStatus();
      if (this.options.requireClassificationComplete === true && !classification.completed) {
        message = `Codex 请求终止，但证据调查尚未完成；本轮已作为可恢复的完成门禁拒绝处理。模型说明：${decision.error}`;
        this.session.currentStage = 'investigating';
        this.recentResults.push({
          toolName: 'model_failed_decision',
          status: 'rejected',
          summary: message,
          unreviewedServiceIds: classification.unreviewedServiceIds.slice(0, 40),
          unreviewedPathKeys: classification.unreviewedPathKeys.slice(0, 40),
        });
      } else {
        await this.fail(decision.error);
      }
    }
    this.session.turnCount = sequence;
    const classification = this.options.tools.classificationStatus();
    const totalClassificationItems =
      classification.candidateServiceCount + classification.candidatePathCount;
    this.session.coverage.classification =
      totalClassificationItems === 0
        ? classification.completed
          ? 1
          : 0
        : (classification.reviewedServiceCount + classification.reviewedPathCount) /
          totalClassificationItems;
    this.session.coverage.wikiComposition = this.options.tools.wikiCompositionStatus().completed
      ? 1
      : 0;
    this.session.unresolvedQuestions = [
      ...decision.unresolvedQuestions,
      ...(classification.completed || this.options.requireClassificationComplete !== true
        ? []
        : [
            `仍有 ${classification.unreviewedServiceIds.length} 个有效服务和 ${classification.unreviewedPathKeys.length} 条路径待完成 Codex 调查。`,
          ]),
    ];
    this.session.updatedAt = this.now().toISOString();
    this.usedOutputBytes +=
      Buffer.byteLength(message) +
      observations.reduce((total, item) => total + Buffer.byteLength(item), 0);
    this.options.tools.setSession(this.session);
    const turn: AgentTurn = {
      turnId,
      sessionId: this.session.sessionId,
      ...(this.session.threadId === undefined ? {} : { threadId: this.session.threadId }),
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
    this.session = this.finish('interrupted', 'user_interrupted');
    this.options.tools.setSession(this.session);
    await this.options.store.save(this.session);
    return this.session;
  }

  private async runUntilSettled(userMessage: string): Promise<AgentResponse> {
    const startingTurnCount = this.session.turnCount;
    const runStartedAt = this.now().getTime();
    const startingUsedTokens = this.usedTokens;
    const startingUsedOutputBytes = this.usedOutputBytes;
    let response = await this.runTurn(userMessage);
    while (
      this.session.state === 'running' &&
      this.canContinue(startingTurnCount, runStartedAt, startingUsedTokens, startingUsedOutputBytes)
    ) {
      if (!this.options.tools.classificationStatus().completed) await this.rotateThreadIfNeeded();
      const classificationCompleted = this.options.tools.classificationStatus().completed;
      const compositionCompleted = this.options.tools.wikiCompositionStatus().completed;
      response = await this.runTurn(
        !classificationCompleted
          ? '根据上一轮结果继续调查最有价值的证据，并在信息充分时结束。'
          : !compositionCompleted
            ? '服务调查已完成。请根据 wiki_source 使用 compose_wiki 撰写完整服务器知识手册。'
            : 'AI Wiki 综合稿件已成功写入。请检查完成门禁并使用 kind=final 结束。',
      );
    }
    if (this.session.state === 'running') {
      const classification = this.options.tools.classificationStatus();
      this.session.unresolvedQuestions = [
        ...this.session.unresolvedQuestions,
        ...(classification.completed
          ? []
          : [
              `Agent 已达到本轮预算，仍有 ${classification.unreviewedServiceIds.length} 个有效服务和 ${classification.unreviewedPathKeys.length} 条路径待调查；可使用 --resume 继续。`,
            ]),
      ];
      this.session = this.finish('partial', 'budget_exhausted');
      this.options.tools.setSession(this.session);
      await this.options.store.save(this.session);
    }
    return response;
  }

  private async bootstrap(resume: boolean): Promise<AgentSession> {
    const previousStopReason = this.session.stopReason;
    const initial: AgentSession = {
      ...this.session,
      state: 'running',
      currentStage: 'bootstrapping',
      updatedAt: this.now().toISOString(),
    };
    delete initial.finishedAt;
    delete initial.lastError;
    delete initial.stopReason;
    initial.repairSuggestions = [];
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
      const rotateThread =
        previousStopReason === 'budget_exhausted' || previousStopReason === 'codex_failed';
      const thread =
        resume && initial.threadId !== undefined && !rotateThread
          ? await this.options.thread.resume(initial.threadId, threadOptions)
          : await this.options.thread.start(threadOptions);
      this.threadTurnCount = 0;
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

AgentDecision contract:
${AGENT_DECISION_PROMPT_CONTRACT}

When L1.discovery.workflowVersion is m20_evidence_driven, Snapshot services, systemd units, processes, ports, paths, and mounts are raw evidence, not a service checklist. Correlate every meaningful deployment candidate across systemd unit identity and ExecStart, the complete ps-style process command/arguments/parent/cgroup/user/working-directory evidence, socket ownership and listening port, custom paths, and every Docker/Compose container. Container evidence is not more authoritative than systemd or process evidence. If planningCompleted=false, call list_candidates once with {} to receive the complete lightweight service-filtering index (up to 500 items), then use plan_discovery on the next turn. Do not call list_candidates repeatedly when hasMore=false. Only when hasMore=true, call it again with nextOffset and limit=500. The lightweight index intentionally omits detailed evidence; after planning, use read_context with section=services, processes, containers, systemd_units, or path_candidates and successive offsets only for selected investigations or identity gaps. Group routine Linux system units and processes into evidence-backed filtered groups, and select meaningful investigations. Do not create one ServiceAssessmentChange per ordinary systemd unit. A filter group may only contain low-value routine operating-system evidence; every Docker/Compose deployment, any listening service, direct deployed process, failed service, custom systemd unit, custom executable, or custom/data path must remain an investigation or explicit needs_review item. The local completion gate rejects a plan that omits any such service.

For active M20 investigations, L1.services is the current highest-priority unreviewed batch and already contains the compact units, processes, sockets, containers, paths, visibility constraints, and evidence IDs needed for assessment. Assess the visible L1.services directly. After update_projection succeeds, the next turn automatically receives a refreshed unreviewed batch. Do not call read_context for the same services already visible in L1. Use read_context with a nonzero offset only for deliberate pagination when the required candidate is not present in L1.

L0.recent is authoritative cross-thread history of completed or rejected OpSense tool calls. A newly rotated Codex thread has no conversational tool history, so read L0.recent before claiming that no tool result is available or repeating a tool call. A completed read_context result in L0.recent is a real tool result.

Treat the displayed services and their related evidence as one batch. Prefer one update_projection decision covering 5-12 services and all evidence-backed paths visible for them. Do not spend one turn on each service or path. Read more context or request execute_governed_probe only where it closes a concrete shared gap. Probe requests must be narrow and evidence-linked. Use update_projection only for serviceIds already selected by plan_discovery. Evidence gaps are not fatal: use confidence=unknown, role=unknown, reportPlacement=needs_review, unknowns, and reviewItems as appropriate. Never use kind=failed merely because evidence is incomplete, context is static, a probe is unavailable, or the completion gate is not met. kind=failed is reserved for an irrecoverable local capability or contract failure that prevents every allowed next action.

Once every selected service has an evidence-backed assessment, call plan_discovery again with all existing investigations and filter groups preserved, set each investigation to resolved or needs_review, and set discoveryCompleted=true. Do not use final yet. When L0 reports classificationCompleted=true, L1.wiki_source contains the complete assessed server knowledge source. Use compose_wiki exactly once to write the final server Wiki narrative, service groups, key findings, and detailed service descriptions. Then use kind=final. final is accepted only after both the classification and Wiki composition gates pass.

The report must be genuinely AI-authored rather than a count-only template. In compose_wiki, write a professional Chinese server handbook for operations engineers: use short paragraphs, keep each overview module focused, avoid repeating the same facts, and explain what the server does, how important services are deployed and grouped, where configuration/data/log paths live, what is exposed, and what remains uncertain. Put every assessed non-system-summary service in exactly one meaningful serviceGroup; this grouping renders the deployment relationship view, so describe only evidence-backed grouping and never invent dependencies. For each recognizable product, use the collected service name, container name, and image identity to explain its function. For example, an image or service clearly identified as MinIO should be described as an S3-compatible object-storage service. This product-level explanation is an AI inference and must cite the collected service/container Evidence IDs. Omit serviceDescriptions for identities that cannot be responsibly recognized. Never invent topology, dependencies, credentials, commands, paths, ports, recovery guarantees, or Evidence IDs.

When L1.discovery.workflowVersion is m19_full_candidate_review, retain legacy behavior: L1.services is the current prioritized batch and contains at most two candidates. Complete displayed service and path reviews before requesting more candidates.

For each candidate, obey visibilityConstraints. If systemSummaryAllowed=false, reportPlacement must not be system_summary; use primary, supporting, or needs_review according to evidence. Failed services, externally exposed sockets, container/Compose candidates, and custom or data paths are intentionally protected from silent hiding.

role=system and reportPlacement=system_summary must be used together. A protected service that cannot enter system_summary must use an evidence-supported non-system role, or role=unknown with reportPlacement=needs_review.

Local candidate hints are non-authoritative. For M20, preserve filtered raw evidence as group-level audit data and record meaningful uncertainty as an investigation or service review item. Path roles must be decided from collected evidence, not directory-name assumptions. Never invent aliases such as get_evidence. Use kind=final only after L0 reports that the applicable completion gate is complete.

User: ${userMessage}
Context hash: ${context.hash}
L0: ${JSON.stringify(context.l0)}
L1 index: ${JSON.stringify(context.l1)}`;
  }

  private canContinue(
    startingTurnCount: number,
    runStartedAt: number,
    startingUsedTokens: number,
    startingUsedOutputBytes: number,
  ): boolean {
    const maxTurns = this.options.maxTurns ?? 8;
    const maxDurationMs = this.options.maxDurationMs ?? 300_000;
    const maxTokens = this.options.maxTokens ?? 100_000;
    const maxOutputBytes = this.options.maxOutputBytes ?? 2_000_000;
    const elapsed = Math.max(0, this.now().getTime() - runStartedAt);
    return (
      this.session.turnCount - startingTurnCount < maxTurns &&
      elapsed < maxDurationMs &&
      this.usedTokens - startingUsedTokens < maxTokens &&
      this.usedOutputBytes - startingUsedOutputBytes < maxOutputBytes
    );
  }

  private async rotateThreadIfNeeded(): Promise<void> {
    const maxTurnsPerThread =
      this.options.maxTurnsPerThread ??
      (this.session.workflowVersion === 'm20_evidence_driven' ? 4 : 1);
    if (this.threadTurnCount < maxTurnsPerThread) return;
    const thread = await this.options.thread.start({
      ...(this.options.model === undefined ? {} : { model: this.options.model }),
      ...(this.options.workingDirectory === undefined
        ? {}
        : { workingDirectory: this.options.workingDirectory }),
    });
    this.session.threadId = thread.threadId;
    this.threadTurnCount = 0;
    this.session.updatedAt = this.now().toISOString();
    this.options.tools.setSession(this.session);
    await this.options.store.save(this.session);
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
  private finish(
    state: 'completed' | 'partial' | 'interrupted',
    stopReason: AgentSession['stopReason'],
  ): AgentSession {
    const at = this.now().toISOString();
    return {
      ...this.session,
      state,
      ...(stopReason === undefined ? {} : { stopReason }),
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

function compactRecentValue(value: unknown, maxItems: number): unknown {
  if (Array.isArray(value)) return value.slice(0, maxItems);
  return value;
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
