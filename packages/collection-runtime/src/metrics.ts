import { RunMetricsSchema, assertSchema } from '@opsense/schema';
import type { CommandMetric, PipelineStage, RunMetrics, StageMetric } from '@opsense/schema';
import type { CollectionConcurrencySnapshot } from './scheduler.js';

export interface CommandMetricInput {
  commandId: string;
  durationMs: number;
  status: string;
  stderrBytes: number;
  stdoutBytes: number;
}

export class RunMetricsCollector {
  private readonly metrics: RunMetrics;
  private activeStage: { stage: PipelineStage; startedAt: Date } | undefined;

  public constructor(
    runId: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.metrics = emptyRunMetrics(runId, now());
  }

  public startStage(stage: PipelineStage): void {
    if (this.activeStage?.stage === stage) return;
    if (this.activeStage !== undefined) this.finishStage('completed');
    this.activeStage = { stage, startedAt: this.now() };
  }

  public finishStage(status: StageMetric['status'] = 'completed'): void {
    if (this.activeStage === undefined) return;
    const finishedAt = this.now();
    this.metrics.stages.push({
      durationMs: Math.max(0, finishedAt.getTime() - this.activeStage.startedAt.getTime()),
      finishedAt: finishedAt.toISOString(),
      stage: this.activeStage.stage,
      startedAt: this.activeStage.startedAt.toISOString(),
      status,
    });
    this.activeStage = undefined;
  }

  public recordCommand(record: CommandMetricInput): void {
    const metric = this.metrics.ssh.byCommandId[record.commandId] ?? emptyCommandMetric();
    metric.count += 1;
    metric.durationMs += Math.max(0, Math.round(record.durationMs));
    metric.maxDurationMs = Math.max(
      metric.maxDurationMs,
      Math.max(0, Math.round(record.durationMs)),
    );
    metric.stderrBytes += Math.max(0, record.stderrBytes);
    metric.stdoutBytes += Math.max(0, record.stdoutBytes);
    incrementStatus(metric, record.status);
    this.metrics.ssh.byCommandId[record.commandId] = metric;
    this.metrics.ssh.commandCount += 1;
    this.metrics.ssh.executionDurationMs += Math.max(0, Math.round(record.durationMs));
  }

  public addSchedulerMetrics(result: { cacheHit: boolean; queuedDurationMs: number }): void {
    if (result.cacheHit) this.metrics.ssh.cacheHits += 1;
    this.metrics.ssh.queuedDurationMs += Math.max(0, Math.round(result.queuedDurationMs));
  }

  public setSchedulerConcurrency(snapshot: CollectionConcurrencySnapshot): void {
    this.metrics.ssh.concurrency = { ...snapshot };
  }

  public setDiscoveryMetrics(values: RunMetrics['discovery']): void {
    this.metrics.discovery = { ...values };
  }

  public snapshot(): RunMetrics {
    const snapshot = structuredClone(this.metrics);
    snapshot.generatedAt = this.now().toISOString();
    assertSchema(RunMetricsSchema, snapshot);
    return snapshot;
  }
}

export function emptyRunMetrics(runId: string, at = new Date()): RunMetrics {
  return {
    ai: {
      calls: 0,
      cachedInputTokens: 0,
      durationMs: 0,
      failedCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      repairs: 0,
    },
    discovery: {
      candidateCount: 0,
      filteredGroupCount: 0,
      finalServiceCount: 0,
      protectedCandidateCount: 0,
      rawObjectCount: 0,
    },
    generatedAt: at.toISOString(),
    probes: {
      accepted: 0,
      deduplicated: 0,
      failed: 0,
      rejected: 0,
      requested: 0,
      resolvedFields: 0,
      rounds: 0,
    },
    report: { durationMs: 0, generatedFiles: 0, qualityGateFailures: 0 },
    runId,
    schemaVersion: '3.0',
    ssh: {
      byCommandId: {},
      cacheHits: 0,
      commandCount: 0,
      concurrency: {
        current: 4,
        maximum: 4,
        minimum: 2,
        pressureFailures: 0,
        recoveries: 0,
        reductions: 0,
      },
      executionDurationMs: 0,
      queuedDurationMs: 0,
    },
    stages: [],
  };
}

function emptyCommandMetric(): CommandMetric {
  return {
    count: 0,
    durationMs: 0,
    maxDurationMs: 0,
    stderrBytes: 0,
    stdoutBytes: 0,
    statuses: {
      cancelled: 0,
      commandMissing: 0,
      failed: 0,
      permissionDenied: 0,
      success: 0,
      timeout: 0,
      truncated: 0,
    },
  };
}

function incrementStatus(metric: CommandMetric, status: string): void {
  if (status === 'success') metric.statuses.success += 1;
  else if (status === 'timeout') metric.statuses.timeout += 1;
  else if (status === 'truncated') metric.statuses.truncated += 1;
  else if (status === 'command_missing') metric.statuses.commandMissing += 1;
  else if (status === 'permission_denied') metric.statuses.permissionDenied += 1;
  else if (status === 'cancelled') metric.statuses.cancelled += 1;
  else metric.statuses.failed += 1;
}
