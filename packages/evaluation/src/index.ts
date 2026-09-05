import type { PipelineRun, RunMetrics } from '@opsense/schema';

export interface BenchmarkGate {
  actual: number;
  limit: number;
  metric: string;
  passed: boolean;
}

export interface RunBenchmark {
  aiCalls: number;
  candidateCount: number;
  finalServiceCount: number;
  inventoryDurationMs?: number;
  nPlusOneCommandCount: number;
  probeInformationGain: number;
  probeRounds: number;
  reportDurationMs: number;
  runId: string;
  sshCommandCount: number;
  tokenCount: number;
  wallClockDurationMs: number;
  gates: BenchmarkGate[];
  passed: boolean;
}

export interface BenchmarkComparison {
  baseline: RunBenchmark;
  candidate: RunBenchmark;
  delta: Record<
    | 'aiCalls'
    | 'candidateCount'
    | 'finalServiceCount'
    | 'inventoryDurationMs'
    | 'nPlusOneCommandCount'
    | 'probeInformationGain'
    | 'probeRounds'
    | 'reportDurationMs'
    | 'sshCommandCount'
    | 'tokenCount'
    | 'wallClockDurationMs',
    number
  >;
}

export interface ReleaseSample {
  id: string;
  source: 'synthetic' | 'real';
  tags: string[];
  expectedProtectedObjects: string[];
  detectedProtectedObjects: string[];
  expectedSystemObjects: string[];
  systemObjectsPromotedToCandidates: string[];
  finalServiceCount: number;
  needsReviewServiceCount: number;
  inventoryDurationMs: number;
  sshCommandCount: number;
  aiCalls: number;
  tokenCount: number;
  probesRequested: number;
  probesAccepted: number;
}

export interface ReleaseGate {
  actual: number;
  expected: string;
  metric: string;
  passed: boolean;
}

export interface ReleaseAssessment {
  gates: ReleaseGate[];
  metrics: {
    aiCallsMax: number;
    baseSshCommandsMax: number;
    inventoryP50Ms: number;
    inventoryP95Ms: number;
    probeAcceptanceRate: number;
    protectedCandidateRecall: number;
    systemFalsePositiveRate: number;
    tokenP50: number;
    tokenP95: number;
    unknownServiceRatio: number;
  };
  passed: boolean;
  realServerEvidenceComplete: boolean;
  sampleCount: number;
}

export function parseReleaseSamples(value: unknown): ReleaseSample[] {
  if (!Array.isArray(value)) throw new Error('Release sample file must contain a JSON array.');
  const samples = value.map((item, index) => parseReleaseSample(item, index));
  if (new Set(samples.map((sample) => sample.id)).size !== samples.length)
    throw new Error('Release sample IDs must be unique.');
  return samples;
}

const REQUIRED_REAL_TAGS = [
  'debian-ubuntu',
  'rhel-rocky',
  'no-systemd',
  'docker-compose',
  'custom-service',
  'minimal-permission',
] as const;

export function benchmarkRun(run: PipelineRun, metrics: RunMetrics): RunBenchmark {
  if (run.runId !== metrics.runId)
    throw new Error(`Pipeline run '${run.runId}' does not match metrics '${metrics.runId}'.`);
  const finishedAt = Date.parse(run.finishedAt ?? run.updatedAt);
  const startedAt = Date.parse(run.startedAt);
  const inventoryCheckpoint = run.completedStages.find((item) => item.stage === 'inventory_ready');
  const inventoryDurationMs =
    inventoryCheckpoint === undefined
      ? undefined
      : Math.max(0, Date.parse(inventoryCheckpoint.finishedAt) - startedAt);
  const nPlusOneCommandCount = Object.entries(metrics.ssh.byCommandId)
    .filter(([id]) =>
      /^(?:service\.systemd-show|docker\.inspect|directory\.(?:find|stat))$/.test(id),
    )
    .reduce((sum, [, value]) => sum + value.count, 0);
  const tokenCount = metrics.ai.inputTokens + metrics.ai.outputTokens + metrics.ai.reasoningTokens;
  const gates: BenchmarkGate[] = [
    gate('inventoryDurationMs', inventoryDurationMs ?? Number.POSITIVE_INFINITY, 60_000),
    gate('sshCommandCount', metrics.ssh.commandCount, 40),
    gate('nPlusOneCommandCount', nPlusOneCommandCount, 0),
    gate('aiCalls', metrics.ai.calls, 6),
    gate('probeRounds', metrics.probes.rounds, 1),
    gate('qualityGateFailures', metrics.report.qualityGateFailures, 0),
  ];
  return {
    aiCalls: metrics.ai.calls,
    candidateCount: metrics.discovery.candidateCount,
    finalServiceCount: metrics.discovery.finalServiceCount,
    ...(inventoryDurationMs === undefined ? {} : { inventoryDurationMs }),
    nPlusOneCommandCount,
    probeInformationGain:
      metrics.probes.accepted === 0 ? 0 : metrics.probes.resolvedFields / metrics.probes.accepted,
    probeRounds: metrics.probes.rounds,
    reportDurationMs: metrics.report.durationMs,
    runId: run.runId,
    sshCommandCount: metrics.ssh.commandCount,
    tokenCount,
    wallClockDurationMs: Math.max(0, finishedAt - startedAt),
    gates,
    passed: gates.every((item) => item.passed),
  };
}

export function compareBenchmarks(
  baseline: RunBenchmark,
  candidate: RunBenchmark,
): BenchmarkComparison {
  return {
    baseline,
    candidate,
    delta: {
      aiCalls: candidate.aiCalls - baseline.aiCalls,
      candidateCount: candidate.candidateCount - baseline.candidateCount,
      finalServiceCount: candidate.finalServiceCount - baseline.finalServiceCount,
      inventoryDurationMs:
        (candidate.inventoryDurationMs ?? 0) - (baseline.inventoryDurationMs ?? 0),
      nPlusOneCommandCount: candidate.nPlusOneCommandCount - baseline.nPlusOneCommandCount,
      probeInformationGain: candidate.probeInformationGain - baseline.probeInformationGain,
      probeRounds: candidate.probeRounds - baseline.probeRounds,
      reportDurationMs: candidate.reportDurationMs - baseline.reportDurationMs,
      sshCommandCount: candidate.sshCommandCount - baseline.sshCommandCount,
      tokenCount: candidate.tokenCount - baseline.tokenCount,
      wallClockDurationMs: candidate.wallClockDurationMs - baseline.wallClockDurationMs,
    },
  };
}

export function assessReleaseSamples(samples: readonly ReleaseSample[]): ReleaseAssessment {
  if (samples.length === 0) throw new Error('Release assessment requires at least one sample.');
  const expectedProtected = samples.flatMap((sample) =>
    sample.expectedProtectedObjects.map((id) => `${sample.id}:${id}`),
  );
  const detectedProtected = new Set(
    samples.flatMap((sample) => sample.detectedProtectedObjects.map((id) => `${sample.id}:${id}`)),
  );
  const expectedSystem = samples.flatMap((sample) =>
    sample.expectedSystemObjects.map((id) => `${sample.id}:${id}`),
  );
  const promotedSystem = new Set(
    samples.flatMap((sample) =>
      sample.systemObjectsPromotedToCandidates.map((id) => `${sample.id}:${id}`),
    ),
  );
  const serviceCount = sum(samples.map((sample) => sample.finalServiceCount));
  const requestedProbes = sum(samples.map((sample) => sample.probesRequested));
  const realTags = new Set(
    samples.filter((sample) => sample.source === 'real').flatMap((sample) => sample.tags),
  );
  const metrics = {
    aiCallsMax: Math.max(...samples.map((sample) => sample.aiCalls)),
    baseSshCommandsMax: Math.max(...samples.map((sample) => sample.sshCommandCount)),
    inventoryP50Ms: percentile(
      samples.map((sample) => sample.inventoryDurationMs),
      0.5,
    ),
    inventoryP95Ms: percentile(
      samples.map((sample) => sample.inventoryDurationMs),
      0.95,
    ),
    probeAcceptanceRate:
      requestedProbes === 0
        ? 1
        : sum(samples.map((sample) => sample.probesAccepted)) / requestedProbes,
    protectedCandidateRecall:
      expectedProtected.length === 0
        ? 1
        : expectedProtected.filter((id) => detectedProtected.has(id)).length /
          expectedProtected.length,
    systemFalsePositiveRate:
      expectedSystem.length === 0
        ? 0
        : expectedSystem.filter((id) => promotedSystem.has(id)).length / expectedSystem.length,
    tokenP50: percentile(
      samples.map((sample) => sample.tokenCount),
      0.5,
    ),
    tokenP95: percentile(
      samples.map((sample) => sample.tokenCount),
      0.95,
    ),
    unknownServiceRatio:
      serviceCount === 0
        ? 0
        : sum(samples.map((sample) => sample.needsReviewServiceCount)) / serviceCount,
  };
  const realServerEvidenceComplete = REQUIRED_REAL_TAGS.every((tag) => realTags.has(tag));
  const gates: ReleaseGate[] = [
    releaseGate(
      'protectedCandidateRecall',
      metrics.protectedCandidateRecall,
      '>= 1.0',
      (x) => x >= 1,
    ),
    releaseGate(
      'systemFalsePositiveRate',
      metrics.systemFalsePositiveRate,
      '<= 0.05',
      (x) => x <= 0.05,
    ),
    releaseGate('unknownServiceRatio', metrics.unknownServiceRatio, '<= 0.30', (x) => x <= 0.3),
    releaseGate('probeAcceptanceRate', metrics.probeAcceptanceRate, '>= 0.50', (x) => x >= 0.5),
    releaseGate('inventoryP50Ms', metrics.inventoryP50Ms, '<= 30000', (x) => x <= 30_000),
    releaseGate('inventoryP95Ms', metrics.inventoryP95Ms, '<= 60000', (x) => x <= 60_000),
    releaseGate('baseSshCommandsMax', metrics.baseSshCommandsMax, '<= 40', (x) => x <= 40),
    releaseGate('aiCallsMax', metrics.aiCallsMax, '<= 6', (x) => x <= 6),
    releaseGate('tokenP50', metrics.tokenP50, '<= 300000', (x) => x <= 300_000),
    releaseGate('tokenP95', metrics.tokenP95, '<= 500000', (x) => x <= 500_000),
    releaseGate(
      'realServerEvidenceComplete',
      realServerEvidenceComplete ? 1 : 0,
      '= 1',
      (x) => x === 1,
    ),
  ];
  return {
    gates,
    metrics,
    passed: gates.every((item) => item.passed),
    realServerEvidenceComplete,
    sampleCount: samples.length,
  };
}

function gate(metric: string, actual: number, limit: number): BenchmarkGate {
  return { actual, limit, metric, passed: actual <= limit };
}

function releaseGate(
  metric: string,
  actual: number,
  expected: string,
  predicate: (value: number) => boolean,
): ReleaseGate {
  return { actual, expected, metric, passed: predicate(actual) };
}

function percentile(values: readonly number[], quantile: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)] ?? 0;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function parseReleaseSample(value: unknown, index: number): ReleaseSample {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`Release sample ${index} must be an object.`);
  const item = value as Record<string, unknown>;
  const stringArray = (key: string): string[] => {
    const found = item[key];
    if (!Array.isArray(found) || found.some((entry) => typeof entry !== 'string'))
      throw new Error(`Release sample ${index}.${key} must be a string array.`);
    return found as string[];
  };
  const number = (key: string): number => {
    const found = item[key];
    if (typeof found !== 'number' || !Number.isFinite(found) || found < 0)
      throw new Error(`Release sample ${index}.${key} must be a non-negative number.`);
    return found;
  };
  if (typeof item.id !== 'string' || item.id.length === 0)
    throw new Error(`Release sample ${index}.id must be a non-empty string.`);
  if (item.source !== 'synthetic' && item.source !== 'real')
    throw new Error(`Release sample ${index}.source must be synthetic or real.`);
  const sample: ReleaseSample = {
    aiCalls: number('aiCalls'),
    detectedProtectedObjects: stringArray('detectedProtectedObjects'),
    expectedProtectedObjects: stringArray('expectedProtectedObjects'),
    expectedSystemObjects: stringArray('expectedSystemObjects'),
    finalServiceCount: number('finalServiceCount'),
    id: item.id,
    inventoryDurationMs: number('inventoryDurationMs'),
    needsReviewServiceCount: number('needsReviewServiceCount'),
    probesAccepted: number('probesAccepted'),
    probesRequested: number('probesRequested'),
    source: item.source,
    sshCommandCount: number('sshCommandCount'),
    systemObjectsPromotedToCandidates: stringArray('systemObjectsPromotedToCandidates'),
    tags: stringArray('tags'),
    tokenCount: number('tokenCount'),
  };
  if (
    !Number.isInteger(sample.finalServiceCount) ||
    !Number.isInteger(sample.needsReviewServiceCount)
  )
    throw new Error(`Release sample ${index} service counts must be integers.`);
  if (sample.needsReviewServiceCount > sample.finalServiceCount)
    throw new Error(`Release sample ${index} needs-review count exceeds final services.`);
  if (!Number.isInteger(sample.probesRequested) || !Number.isInteger(sample.probesAccepted))
    throw new Error(`Release sample ${index} probe counts must be integers.`);
  if (sample.probesAccepted > sample.probesRequested)
    throw new Error(`Release sample ${index} accepted probes exceed requested probes.`);
  return sample;
}
