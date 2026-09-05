import { readFile } from 'node:fs/promises';

import {
  assessReleaseSamples,
  benchmarkRun,
  compareBenchmarks,
  parseReleaseSamples,
} from '@opsense/evaluation';
import { emptyRunMetrics } from '@opsense/collection-runtime';
import { PipelineRunTracker } from '@opsense/collection-runtime';
import { describe, expect, it } from 'vitest';

describe('v3 release evaluation', () => {
  it('passes all repository fixture gates and keeps real-server evidence explicit', async () => {
    const samples = parseReleaseSamples(
      JSON.parse(await readFile('fixtures/evaluation/v3-release-samples.json', 'utf8')) as unknown,
    );
    const assessment = assessReleaseSamples(samples);

    expect(samples.map((sample) => sample.tags).flat()).toEqual(
      expect.arrayContaining([
        'debian-ubuntu',
        'rhel-rocky',
        'no-systemd',
        'docker-compose',
        'custom-service',
        'minimal-permission',
      ]),
    );
    expect(assessment.gates.filter((gate) => gate.metric !== 'realServerEvidenceComplete')).toEqual(
      expect.arrayContaining([expect.objectContaining({ passed: true })]),
    );
    expect(
      assessment.gates
        .filter((gate) => gate.metric !== 'realServerEvidenceComplete')
        .every((gate) => gate.passed),
    ).toBe(true);
    expect(assessment.realServerEvidenceComplete).toBe(false);
    expect(assessment.passed).toBe(false);
    expect(assessment.metrics).toMatchObject({
      aiCallsMax: 3,
      baseSshCommandsMax: 31,
      protectedCandidateRecall: 1,
      systemFalsePositiveRate: 0,
    });
  });

  it('summarizes persisted metrics and detects N+1 command IDs', () => {
    const tracker = new PipelineRunTracker({
      now: sequenceClock([
        '2026-09-05T01:00:00.000Z',
        '2026-09-05T01:00:10.000Z',
        '2026-09-05T01:00:20.000Z',
        '2026-09-05T01:00:30.000Z',
      ]),
      runId: 'scan:benchmark',
      target: { host: 'fixture', port: 22 },
    });
    tracker.transition('inventory_ready');
    tracker.checkpoint('inventory_ready');
    const run = tracker.finish('completed');
    const metrics = emptyRunMetrics('scan:benchmark');
    metrics.ssh.commandCount = 41;
    metrics.ssh.byCommandId['service.systemd-show'] = {
      count: 300,
      durationMs: 1,
      maxDurationMs: 1,
      stderrBytes: 0,
      stdoutBytes: 0,
      statuses: {
        cancelled: 0,
        commandMissing: 0,
        failed: 0,
        permissionDenied: 0,
        success: 300,
        timeout: 0,
        truncated: 0,
      },
    };
    const benchmark = benchmarkRun(run, metrics);

    expect(benchmark.nPlusOneCommandCount).toBe(300);
    expect(benchmark.passed).toBe(false);
    expect(benchmark.gates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ metric: 'sshCommandCount', passed: false }),
        expect.objectContaining({ metric: 'nPlusOneCommandCount', passed: false }),
      ]),
    );
    expect(
      compareBenchmarks(benchmark, { ...benchmark, sshCommandCount: 20 }).delta.sshCommandCount,
    ).toBe(-21);
  });
});

function sequenceClock(values: string[]): () => Date {
  let index = 0;
  return () => new Date(values[Math.min(index++, values.length - 1)]!);
}
