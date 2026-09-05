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
  now?: () => number;
  onTaskCompleted?: (result: CollectionTaskResult<unknown>) => void;
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
  private readonly concurrency: number;
  private readonly now: () => number;
  private readonly onTaskCompleted: ((result: CollectionTaskResult<unknown>) => void) | undefined;
  private readonly cache = new Map<string, CachedExecution>();
  private activeExecutions = 0;
  private readonly permitWaiters: Array<(release: () => void) => void> = [];

  public constructor(options: CollectionSchedulerOptions = {}) {
    const concurrency = options.concurrency ?? 4;
    if (!Number.isInteger(concurrency) || concurrency < 1)
      throw new Error('Collection scheduler concurrency must be a positive integer.');
    this.concurrency = concurrency;
    this.now = options.now ?? (() => Date.now());
    this.onTaskCompleted = options.onTaskCompleted;
  }

  public clearCache(): void {
    this.cache.clear();
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

      while (active.size < this.concurrency && ready.length > 0) {
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
    if (this.activeExecutions < this.concurrency) {
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
      const next = this.permitWaiters.shift();
      if (next !== undefined) {
        this.activeExecutions += 1;
        next(this.createRelease());
      }
    };
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
