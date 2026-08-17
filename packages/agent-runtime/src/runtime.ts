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
        value: compactRecentValue(result.value),
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
      const classification = this.options.tools.classificationStatus();
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
      } else {
        this.session = this.finish('completed', 'classification_complete');
        this.options.tools.setSession(this.session);
        message = decision.qualitySummary;
      }
    } else {
      await this.fail(decision.error);
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
    let response = await this.runTurn(userMessage);
    while (this.session.state === 'running' && this.canContinue(startingTurnCount)) {
      if (!this.options.tools.classificationStatus().completed) await this.rotateThreadIfNeeded();
      response = await this.runTurn('根据上一轮结果继续调查最有价值的证据，并在信息充分时结束。');
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

Allowed toolName values and arguments:
- read_context: {"section":"host|storage|network|services|processes|containers|systemd_summary|path_candidates|findings|visibility_summary|discovery","offset"?:number,"limit"?:1..5}
- read_evidence: {"ids"?:["existing-evidence-id"],"serviceId"?:"existing-service-id","field"?:"optional-field-or-source-fragment"}
- list_candidates: {"section"?:"services|paths|network|storage|findings","offset"?:number,"limit"?:1..5}
- execute_governed_probe: {"request": ProbeRequest}; use only for a concrete evidence gap. Allowed request kinds: directory_metadata, directory_listing, config_summary, path_search, systemd_unit, process_runtime, process_cgroup, socket_ownership, container_inspect, compose_metadata, log_metadata. Never provide Shell text.
- plan_discovery: {"planningCompleted":boolean,"discoveryCompleted":boolean,"investigations":[DiscoveryInvestigation],"discoveredServices":[{"serviceId":"service:agent:...","name":"...","deploymentType":"systemd|process|docker|compose|unknown","status":"running|stopped|failed|unknown","sourceObjectIds":["existing-raw-object-id"],"evidenceIds":["existing-evidence-id"],"unknownFields":["..."],"reason":"..."}],"filteredGroups":[DiscoveryFilterGroup],"unresolvedQuestions":["..."],"reason":"..."}
- update_projection: {"changes":[ServiceAssessmentChange|PathAssessmentChange],"evidenceIds":[...],"reason"?:string}

ServiceAssessmentChange shape:
{"changeType":"service_assessment","objectId":"existing-service-id","operation":"add|update","summary":"...","assessment":{"serviceId":"same-service-id","role":"application|middleware|infrastructure|edge|container_platform|system|unknown","reportPlacement":"primary|supporting|system_summary|needs_review","importance":"critical|high|medium|low|unknown","purpose"?:"...","statusInterpretation"?:"...","reason":"...","confidence":"inferred|unknown|conflict","evidenceIds":["existing-evidence-id"],"unknowns":[],"reviewItems":[]}}

PathAssessmentChange shape:
{"changeType":"path_assessment","objectId":"existing-service-id","operation":"add|update","summary":"...","assessment":{"serviceId":"same-service-id","path":"existing-collected-path","semantic":"deploy|config|data|log|backup|runtime|system|unknown","reason":"...","confidence":"inferred|unknown|conflict","evidenceIds":["existing-evidence-id"]}}

When L1.discovery.workflowVersion is m20_evidence_driven, Snapshot services, systemd units, processes, ports, paths, and mounts are raw evidence, not a service checklist. If planningCompleted=false, first use plan_discovery to group routine system evidence, filter it with evidence-backed group decisions, and select only meaningful investigations. Do not create one ServiceAssessmentChange per ordinary systemd unit. A filter group may only contain low-value routine evidence; externally exposed sockets, failed services, container/Compose evidence, custom executables, and custom/data paths must remain an investigation or explicit needs_review item.

For an active M20 investigation, read evidence or request execute_governed_probe only where it closes a concrete gap. Probe requests must be narrow and evidence-linked. Use update_projection only for serviceIds already selected by plan_discovery. Once active investigations are resolved or explicitly need review and selected services have evidence-backed assessments, call plan_discovery with discoveryCompleted=true before final. final is accepted only after the local completion gate passes.

When L1.discovery.workflowVersion is m19_full_candidate_review, retain legacy behavior: L1.services is the current prioritized batch and contains at most two candidates. Complete displayed service and path reviews before requesting more candidates.

For each candidate, obey visibilityConstraints. If systemSummaryAllowed=false, reportPlacement must not be system_summary; use primary, supporting, or needs_review according to evidence. Failed services, externally exposed sockets, container/Compose candidates, and custom or data paths are intentionally protected from silent hiding.

role=system and reportPlacement=system_summary must be used together. A protected service that cannot enter system_summary must use an evidence-supported non-system role, or role=unknown with reportPlacement=needs_review.

Local candidate hints are non-authoritative. For M20, preserve filtered raw evidence as group-level audit data and record meaningful uncertainty as an investigation or service review item. Path roles must be decided from collected evidence, not directory-name assumptions. Never invent aliases such as get_evidence. Use kind=final only after L0 reports that the applicable completion gate is complete.

User: ${userMessage}
Context hash: ${context.hash}
L0: ${JSON.stringify(context.l0)}
L1 index: ${JSON.stringify(context.l1)}`;
  }

  private canContinue(startingTurnCount: number): boolean {
    const maxTurns = this.options.maxTurns ?? 8;
    const maxDurationMs = this.options.maxDurationMs ?? 300_000;
    const maxTokens = this.options.maxTokens ?? 100_000;
    const maxOutputBytes = this.options.maxOutputBytes ?? 2_000_000;
    const elapsed = Math.max(0, this.now().getTime() - new Date(this.session.startedAt).getTime());
    return (
      this.session.turnCount - startingTurnCount < maxTurns &&
      elapsed < maxDurationMs &&
      this.usedTokens < maxTokens &&
      this.usedOutputBytes < maxOutputBytes
    );
  }

  private async rotateThreadIfNeeded(): Promise<void> {
    const maxTurnsPerThread = this.options.maxTurnsPerThread ?? 1;
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

function compactRecentValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.slice(0, 2);
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
