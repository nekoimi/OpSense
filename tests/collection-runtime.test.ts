import {
  CollectionScheduler,
  PipelineRunTracker,
  RunMetricsCollector,
  emptyRunMetrics,
} from '@opsense/collection-runtime';
import { PipelineRunSchema, RunMetricsSchema, assertSchema } from '@opsense/schema';
import { describe, expect, it, vi } from 'vitest';

describe('v3 collection runtime', () => {
  it('bounds concurrency while preserving result order', async () => {
    const scheduler = new CollectionScheduler({ concurrency: 2 });
    let active = 0;
    let peak = 0;

    const results = await scheduler.run(
      [0, 1, 2, 3].map((value) => ({
        taskId: `task-${value}`,
        execute: async () => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active -= 1;
          return value;
        },
      })),
    );

    expect(peak).toBe(2);
    expect(results.map((result) => result.value)).toEqual([0, 1, 2, 3]);
  });

  it('honors dependencies and skips dependants after failure', async () => {
    const events: string[] = [];
    const scheduler = new CollectionScheduler({ concurrency: 3 });
    const results = await scheduler.run([
      {
        taskId: 'baseline',
        execute: async () => {
          events.push('baseline');
          return 'ok';
        },
      },
      {
        dependencies: ['baseline'],
        taskId: 'detail',
        execute: async () => {
          events.push('detail');
          throw new Error('unavailable');
        },
      },
      {
        dependencies: ['detail'],
        taskId: 'enrichment',
        execute: async () => {
          events.push('enrichment');
          return 'unused';
        },
      },
    ]);

    expect(events).toEqual(['baseline', 'detail']);
    expect(results.map((result) => result.status)).toEqual(['success', 'failed', 'skipped']);
  });

  it('deduplicates equal semantic cache keys', async () => {
    const execute = vi.fn(async () => 'shared');
    const scheduler = new CollectionScheduler({ concurrency: 2 });
    const results = await scheduler.run([
      { cacheKey: 'host:uname', execute, taskId: 'left' },
      { cacheKey: 'host:uname', execute, taskId: 'right' },
    ]);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(results.map((result) => result.value)).toEqual(['shared', 'shared']);
    expect(results.filter((result) => result.cacheHit)).toHaveLength(1);
  });

  it('rejects dependency cycles and cancels work before dispatch', async () => {
    const scheduler = new CollectionScheduler();
    await expect(
      scheduler.run([
        { dependencies: ['b'], execute: async () => 1, taskId: 'a' },
        { dependencies: ['a'], execute: async () => 2, taskId: 'b' },
      ]),
    ).rejects.toThrow('dependency cycle');

    const controller = new AbortController();
    controller.abort();
    const execute = vi.fn(async () => 1);
    const [result] = await scheduler.run([{ execute, taskId: 'cancelled' }], {
      signal: controller.signal,
    });
    expect(result?.status).toBe('cancelled');
    expect(execute).not.toHaveBeenCalled();
  });

  it('emits schema-valid run state and metrics', () => {
    const at = new Date('2026-09-04T08:00:00.000Z');
    const run = new PipelineRunTracker({
      now: () => at,
      profile: 'standard',
      runId: 'scan-v3-test',
      target: { host: 'server.example.com', port: 22, user: 'ops' },
    });
    run.transition('collecting_baseline');
    run.checkpoint('collecting_baseline', { outputHash: 'sha256-value' });
    assertSchema(PipelineRunSchema, run.snapshot());

    const metrics = new RunMetricsCollector('scan-v3-test', () => at);
    metrics.startStage('collecting_baseline');
    metrics.recordCommand({
      commandId: 'host.hostname',
      durationMs: 12,
      status: 'success',
      stderrBytes: 0,
      stdoutBytes: 7,
    });
    metrics.finishStage();
    expect(metrics.snapshot().ssh.commandCount).toBe(1);
    assertSchema(RunMetricsSchema, metrics.snapshot());
    assertSchema(RunMetricsSchema, emptyRunMetrics('scan-v3-test', at));
  });
});
