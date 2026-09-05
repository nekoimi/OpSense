export type CollectionTaskPriority = 'critical' | 'normal' | 'enrichment';

export interface CollectionTask<T> {
  cacheKey?: string;
  dependencies?: readonly string[];
  execute(signal?: AbortSignal): Promise<T>;
  priority?: CollectionTaskPriority;
  taskId: string;
}

export type CollectionTaskStatus = 'success' | 'failed' | 'skipped' | 'cancelled';

export interface CollectionTaskResult<T> {
  cacheHit: boolean;
  durationMs: number;
  error?: string;
  queuedDurationMs: number;
  status: CollectionTaskStatus;
  taskId: string;
  value?: T;
}

export interface CollectionSchedulerOptions {
  concurrency?: number;
  minimumConcurrency?: number;
  now?: () => number;
  onConcurrencyChanged?: (snapshot: CollectionConcurrencySnapshot) => void;
  onTaskCompleted?: (result: CollectionTaskResult<unknown>) => void;
  pressureFailureThreshold?: number;
  recoverySuccessThreshold?: number;
}

export interface CollectionConcurrencySnapshot {
  current: number;
  maximum: number;
  minimum: number;
  pressureFailures: number;
  recoveries: number;
  reductions: number;
}

interface CachedExecution {
  ownerTaskId: string;
  promise: Promise<unknown>;
}

const PRIORITY_ORDER: Record<CollectionTaskPriority, number> = {
  critical: 0,
  normal: 1,
  enrichment: 2,
};

export class CollectionScheduler {
  private readonly maximumConcurrency: number;
  private readonly minimumConcurrency: number;
  private readonly now: () => number;
  private readonly onConcurrencyChanged:
    ((snapshot: CollectionConcurrencySnapshot) => void) | undefined;
  private readonly onTaskCompleted: ((result: CollectionTaskResult<unknown>) => void) | undefined;
  private readonly pressureFailureThreshold: number;
  private readonly recoverySuccessThreshold: number;
  private readonly cache = new Map<string, CachedExecution>();
  private activeExecutions = 0;
  private currentConcurrency: number;
  private consecutivePressureFailures = 0;
  private consecutiveStableSuccesses = 0;
  private pressureFailures = 0;
  private recoveries = 0;
  private reductions = 0;
  private readonly permitWaiters: Array<(release: () => void) => void> = [];

  public constructor(options: CollectionSchedulerOptions = {}) {
    const concurrency = options.concurrency ?? 4;
    if (!Number.isInteger(concurrency) || concurrency < 1)
      throw new Error('Collection scheduler concurrency must be a positive integer.');
    const minimumConcurrency = options.minimumConcurrency ?? Math.min(2, concurrency);
    if (
      !Number.isInteger(minimumConcurrency) ||
      minimumConcurrency < 1 ||
      minimumConcurrency > concurrency
    )
      throw new Error('Collection scheduler minimum concurrency must be within its limit.');
    const pressureFailureThreshold = options.pressureFailureThreshold ?? 2;
    const recoverySuccessThreshold = options.recoverySuccessThreshold ?? 8;
    if (!Number.isInteger(pressureFailureThreshold) || pressureFailureThreshold < 1)
      throw new Error('Collection scheduler pressure threshold must be a positive integer.');
    if (!Number.isInteger(recoverySuccessThreshold) || recoverySuccessThreshold < 1)
      throw new Error('Collection scheduler recovery threshold must be a positive integer.');
    this.maximumConcurrency = concurrency;
    this.minimumConcurrency = minimumConcurrency;
    this.currentConcurrency = concurrency;
    this.now = options.now ?? (() => Date.now());
    this.onConcurrencyChanged = options.onConcurrencyChanged;
    this.onTaskCompleted = options.onTaskCompleted;
    this.pressureFailureThreshold = pressureFailureThreshold;
    this.recoverySuccessThreshold = recoverySuccessThreshold;
  }

  public clearCache(): void {
    this.cache.clear();
  }

  public concurrencySnapshot(): CollectionConcurrencySnapshot {
    return {
      current: this.currentConcurrency,
      maximum: this.maximumConcurrency,
      minimum: this.minimumConcurrency,
      pressureFailures: this.pressureFailures,
      recoveries: this.recoveries,
      reductions: this.reductions,
    };
  }

  public async run<T>(
    tasks: readonly CollectionTask<T>[],
    options: { signal?: AbortSignal } = {},
  ): Promise<CollectionTaskResult<T>[]> {
    validateTasks(tasks);
    const runStartedAt = this.now();
    const byId = new Map(tasks.map((task) => [task.taskId, task]));
    const order = new Map(tasks.map((task, index) => [task.taskId, index]));
    const remaining = new Set(tasks.map((task) => task.taskId));
    const completed = new Map<string, CollectionTaskResult<T>>();
    const active = new Map<string, Promise<{ id: string; result: CollectionTaskResult<T> }>>();

    while (remaining.size > 0 || active.size > 0) {
      for (const taskId of [...remaining]) {
        const task = byId.get(taskId)!;
        const dependencyResults = (task.dependencies ?? []).map((id) => completed.get(id));
        if (
          dependencyResults.some((result) => result !== undefined && result.status !== 'success')
        ) {
          const result: CollectionTaskResult<T> = {
            cacheHit: false,
            durationMs: 0,
            error: 'A dependency did not complete successfully.',
            queuedDurationMs: Math.max(0, this.now() - runStartedAt),
            status: 'skipped',
            taskId,
          };
          completed.set(taskId, result);
          this.onTaskCompleted?.(result);
          remaining.delete(taskId);
        }
      }

      if (options.signal?.aborted === true) {
        for (const taskId of remaining) {
          const result: CollectionTaskResult<T> = {
            cacheHit: false,
            durationMs: 0,
            error: 'Collection task was cancelled.',
            queuedDurationMs: Math.max(0, this.now() - runStartedAt),
            status: 'cancelled',
            taskId,
          };
          completed.set(taskId, result);
          this.onTaskCompleted?.(result);
        }
        remaining.clear();
      }

      const ready = [...remaining]
        .map((id) => byId.get(id)!)
        .filter((task) =>
          (task.dependencies ?? []).every(
            (dependency) => completed.get(dependency)?.status === 'success',
          ),
        )
        .sort(
          (left, right) =>
            PRIORITY_ORDER[left.priority ?? 'normal'] -
              PRIORITY_ORDER[right.priority ?? 'normal'] ||
            order.get(left.taskId)! - order.get(right.taskId)!,
        );

      while (active.size < this.currentConcurrency && ready.length > 0) {
        const task = ready.shift()!;
        remaining.delete(task.taskId);
        const queuedDurationMs = Math.max(0, this.now() - runStartedAt);
        const execution = this.executeTask(task, queuedDurationMs, options.signal).then(
          (result) => ({ id: task.taskId, result }),
        );
        active.set(task.taskId, execution);
      }

      if (active.size === 0) {
        if (remaining.size > 0)
          throw new Error(
            'Collection scheduler cannot make progress because dependencies are unresolved.',
          );
        break;
      }

      const settled = await Promise.race(active.values());
      active.delete(settled.id);
      completed.set(settled.id, settled.result);
      this.observeResult(settled.result);
      this.onTaskCompleted?.(settled.result);
    }

    return tasks.map((task) => completed.get(task.taskId)!);
  }

  private async executeTask<T>(
    task: CollectionTask<T>,
    queuedDurationMs: number,
    signal: AbortSignal | undefined,
  ): Promise<CollectionTaskResult<T>> {
    const waitingAt = this.now();
    const release = await this.acquirePermit();
    const globallyQueuedDurationMs = Math.max(0, this.now() - waitingAt);
    if (signal?.aborted === true) {
      release();
      return {
        cacheHit: false,
        durationMs: 0,
        error: 'Collection task was cancelled.',
        queuedDurationMs: queuedDurationMs + globallyQueuedDurationMs,
        status: 'cancelled',
        taskId: task.taskId,
      };
    }
    const startedAt = this.now();
    const existing = task.cacheKey === undefined ? undefined : this.cache.get(task.cacheKey);
    const execution = existing?.promise ?? Promise.resolve().then(() => task.execute(signal));
    if (task.cacheKey !== undefined && existing === undefined) {
      this.cache.set(task.cacheKey, { ownerTaskId: task.taskId, promise: execution });
    }
    if (existing !== undefined) release();

    try {
      const value = (await execution) as T;
      return {
        cacheHit: existing !== undefined,
        durationMs: existing === undefined ? Math.max(0, this.now() - startedAt) : 0,
        queuedDurationMs: queuedDurationMs + globallyQueuedDurationMs,
        status: 'success',
        taskId: task.taskId,
        value,
      };
    } catch (error) {
      if (task.cacheKey !== undefined && existing === undefined) this.cache.delete(task.cacheKey);
      return {
        cacheHit: existing !== undefined,
        durationMs: Math.max(0, this.now() - startedAt),
        error: error instanceof Error ? error.message : String(error),
        queuedDurationMs: queuedDurationMs + globallyQueuedDurationMs,
        status: isAborted(signal) ? 'cancelled' : 'failed',
        taskId: task.taskId,
      };
    } finally {
      if (existing === undefined) release();
    }
  }

  private acquirePermit(): Promise<() => void> {
    if (this.activeExecutions < this.currentConcurrency) {
      this.activeExecutions += 1;
      return Promise.resolve(this.createRelease());
    }
    return new Promise((resolve) => this.permitWaiters.push(resolve));
  }

  private createRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeExecutions -= 1;
      this.wakePermitWaiters();
    };
  }

  private observeResult(result: CollectionTaskResult<unknown>): void {
    if (result.cacheHit || result.status === 'cancelled' || result.status === 'skipped') return;
    if (
      (result.status === 'failed' && isRemotePressureError(result.error)) ||
      (result.status === 'success' && isRemotePressureValue(result.value))
    ) {
      this.pressureFailures += 1;
      this.consecutivePressureFailures += 1;
      this.consecutiveStableSuccesses = 0;
      if (
        this.currentConcurrency > this.minimumConcurrency &&
        this.consecutivePressureFailures >= this.pressureFailureThreshold
      ) {
        this.currentConcurrency = this.minimumConcurrency;
        this.consecutivePressureFailures = 0;
        this.reductions += 1;
        this.onConcurrencyChanged?.(this.concurrencySnapshot());
      }
      return;
    }
    this.consecutivePressureFailures = 0;
    if (result.status !== 'success' || this.currentConcurrency >= this.maximumConcurrency) {
      this.consecutiveStableSuccesses = 0;
      return;
    }
    this.consecutiveStableSuccesses += 1;
    if (this.consecutiveStableSuccesses < this.recoverySuccessThreshold) return;
    this.currentConcurrency = this.maximumConcurrency;
    this.consecutiveStableSuccesses = 0;
    this.recoveries += 1;
    this.onConcurrencyChanged?.(this.concurrencySnapshot());
    this.wakePermitWaiters();
  }

  private wakePermitWaiters(): void {
    while (this.activeExecutions < this.currentConcurrency) {
      const next = this.permitWaiters.shift();
      if (next === undefined) return;
      this.activeExecutions += 1;
      next(this.createRelease());
    }
  }
}

export async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T, index: number) => Promise<R>,
  scheduler = new CollectionScheduler({ concurrency }),
): Promise<R[]> {
  const results = await scheduler.run(
    values.map((value, index) => ({
      execute: () => worker(value, index),
      taskId: `map:${index}`,
    })),
  );
  return results.map((result) => {
    if (result.status !== 'success')
      throw new Error(result.error ?? `Task ${result.taskId} failed.`);
    return result.value as R;
  });
}

function validateTasks<T>(tasks: readonly CollectionTask<T>[]): void {
  const ids = new Set<string>();
  for (const task of tasks) {
    if (task.taskId.length === 0) throw new Error('Collection task ID cannot be empty.');
    if (ids.has(task.taskId)) throw new Error(`Duplicate collection task ID: ${task.taskId}.`);
    ids.add(task.taskId);
  }
  for (const task of tasks)
    for (const dependency of task.dependencies ?? [])
      if (!ids.has(dependency))
        throw new Error(`Collection task ${task.taskId} has unknown dependency ${dependency}.`);

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(tasks.map((task) => [task.taskId, task]));
  const visit = (taskId: string): void => {
    if (visiting.has(taskId))
      throw new Error(`Collection task dependency cycle includes ${taskId}.`);
    if (visited.has(taskId)) return;
    visiting.add(taskId);
    for (const dependency of byId.get(taskId)?.dependencies ?? []) visit(dependency);
    visiting.delete(taskId);
    visited.add(taskId);
  };
  for (const task of tasks) visit(task.taskId);
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function isRemotePressureError(error: string | undefined): boolean {
  return (
    error !== undefined &&
    /channel open failure|administratively prohibited|resource(?:s)? (?:temporarily )?unavailable|too many (?:open )?channels|channel limit|timed?\s*out|timeout/i.test(
      error,
    )
  );
}

function isRemotePressureValue(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record.status === 'timeout') return true;
  for (const key of ['errorMessage', 'message', 'code', 'stderr']) {
    const item = record[key];
    if (typeof item === 'string' && isRemotePressureError(item)) return true;
  }
  return Array.isArray(record.attempts) && record.attempts.some(isRemotePressureValue);
}
