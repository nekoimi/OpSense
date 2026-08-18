import { ProbePlanValidator } from '@opsense/ai-provider';
import { ProbeRequestSchema, assertSchema } from '@opsense/schema';
import type { AgentSession, ProbeBudget, ProbeRequest, ScanSnapshot } from '@opsense/schema';

export interface GovernedProbeResult {
  status: 'completed' | 'failed';
  evidenceIds: string[];
  value?: unknown;
  reason: string;
}

export interface ProbeExecutor {
  execute(request: ProbeRequest, signal?: AbortSignal): Promise<GovernedProbeResult>;
}

export interface ProbeGovernorOptions {
  snapshot: ScanSnapshot;
  session: AgentSession;
  executor?: ProbeExecutor;
  reconcile?: (request: ProbeRequest, result: GovernedProbeResult) => Promise<void> | void;
  now?: () => Date;
}

export class ProbeGovernor {
  private readonly snapshot: ScanSnapshot;
  private session: AgentSession;
  private readonly executor: ProbeExecutor | undefined;
  private readonly reconcile: ProbeGovernorOptions['reconcile'];
  private readonly now: () => Date;
  private readonly validator: ProbePlanValidator;

  public constructor(options: ProbeGovernorOptions) {
    if (options.executor !== undefined && options.reconcile === undefined) {
      throw new Error('配置探测执行器时必须同时配置归一化、脱敏和投影重建回调。');
    }
    this.snapshot = options.snapshot;
    this.session = options.session;
    this.executor = options.executor;
    this.reconcile = options.reconcile;
    this.now = options.now ?? (() => new Date());
    this.validator = new ProbePlanValidator({
      maxDepth: 8,
      maxMatches: 1000,
      maxRequests: options.session.budgets.maxRequests,
      maxTotalBytes: options.session.budgets.maxBytes,
      maxTimeoutMs: 60_000,
    });
  }

  public get budget(): ProbeBudget {
    return { ...this.session.budgets };
  }

  public setSession(session: AgentSession): void {
    this.session = session;
  }

  public validate(request: unknown): ProbeRequest {
    assertSchema(ProbeRequestSchema, request);
    if (this.session.completedProbeRequestIds.includes(request.id))
      throw new ProbeGovernorError('该探测请求已成功执行，不允许在恢复会话中重复执行。');
    const validation = this.validator.validate(this.snapshot, [request], this.now);
    const record = validation.audit.records[0];
    if (record === undefined || record.status !== 'accepted')
      throw new ProbeGovernorError(record?.reason ?? '探测请求被拒绝。');
    this.checkSessionBudget(request);
    return request;
  }

  public async execute(request: unknown, signal?: AbortSignal): Promise<GovernedProbeResult> {
    return (await this.executeBatch([request], signal))[0]!;
  }

  public async executeBatch(
    requests: readonly unknown[],
    signal?: AbortSignal,
  ): Promise<GovernedProbeResult[]> {
    const requestIds = new Set<string>();
    const checked = requests.map((request) => {
      const validated = this.validate(request);
      if (requestIds.has(validated.id))
        throw new ProbeGovernorError(`批量探测请求 ID 重复：${validated.id}。`);
      requestIds.add(validated.id);
      return validated;
    });
    const executor = this.executor;
    if (executor === undefined)
      return checked.map(() => ({
        evidenceIds: [],
        reason: '未配置远程探测执行器，已保留为待执行请求。',
        status: 'failed' as const,
      }));
    this.beginRound();
    const results: GovernedProbeResult[] = [];
    for (const request of checked) {
      try {
        this.checkSessionBudget(request);
        results.push(await this.executeChecked(request, executor, signal));
      } catch (error) {
        results.push({
          evidenceIds: [],
          reason: error instanceof Error ? error.message : String(error),
          status: 'failed',
        });
      }
    }
    return results;
  }

  private async executeChecked(
    checked: ProbeRequest,
    executor: ProbeExecutor,
    signal?: AbortSignal,
  ): Promise<GovernedProbeResult> {
    const started = this.now().getTime();
    this.session.budgets.usedRequests += 1;
    this.session.budgets.usedBytes += checked.maxBytes;
    this.session.budgets.usedDurationMs += checked.timeoutMs;
    try {
      const result = await executor.execute(checked, signal);
      const elapsed = Math.max(0, this.now().getTime() - started);
      this.session.budgets.usedDurationMs = Math.max(
        0,
        this.session.budgets.usedDurationMs - checked.timeoutMs + elapsed,
      );
      await this.reconcile?.(checked, result);
      if (result.status === 'completed') this.session.completedProbeRequestIds.push(checked.id);
      return result;
    } catch (error) {
      return {
        evidenceIds: [],
        reason: error instanceof Error ? error.message : String(error),
        status: 'failed',
      };
    }
  }

  public beginRound(): void {
    if (this.session.budgets.usedRounds >= this.session.budgets.maxRounds)
      throw new ProbeGovernorError('超过 Agent 最大探测轮数。');
    this.session.budgets.usedRounds += 1;
    this.session.probeRound = this.session.budgets.usedRounds;
  }

  private checkSessionBudget(request: ProbeRequest): void {
    const budget = this.session.budgets;
    if (budget.usedRequests >= budget.maxRequests)
      throw new ProbeGovernorError('超过 Agent 探测请求预算。');
    if (budget.usedBytes + request.maxBytes > budget.maxBytes)
      throw new ProbeGovernorError('超过 Agent 读取字节预算。');
    if (budget.usedDurationMs + request.timeoutMs > budget.maxDurationMs)
      throw new ProbeGovernorError('超过 Agent 探测时间预算。');
  }
}

export class ProbeGovernorError extends Error {
  public readonly code = 'PROBE_GOVERNOR_REJECTED';
}
