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
  private readonly session: AgentSession;
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

  public validate(request: unknown): ProbeRequest {
    assertSchema(ProbeRequestSchema, request);
    const validation = this.validator.validate(this.snapshot, [request], this.now);
    const record = validation.audit.records[0];
    if (record === undefined || record.status !== 'accepted')
      throw new ProbeGovernorError(record?.reason ?? '探测请求被拒绝。');
    this.checkSessionBudget(request);
    return request;
  }

  public async execute(request: unknown, signal?: AbortSignal): Promise<GovernedProbeResult> {
    const checked = this.validate(request);
    if (this.executor === undefined)
      return {
        evidenceIds: [],
        reason: '未配置远程探测执行器，已保留为待执行请求。',
        status: 'failed',
      };
    this.beginRound();
    const started = this.now().getTime();
    this.session.budgets.usedRequests += 1;
    this.session.budgets.usedBytes += checked.maxBytes;
    this.session.budgets.usedDurationMs += checked.timeoutMs;
    try {
      const result = await this.executor.execute(checked, signal);
      const elapsed = Math.max(0, this.now().getTime() - started);
      this.session.budgets.usedDurationMs = Math.max(
        0,
        this.session.budgets.usedDurationMs - checked.timeoutMs + elapsed,
      );
      await this.reconcile?.(checked, result);
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
