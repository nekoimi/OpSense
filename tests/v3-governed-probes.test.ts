import { executeGovernedProbeBatch } from '@opsense/collectors';
import { compileGovernedProbePlan } from '@opsense/discovery';
import { GovernedProbePlanSchema, ProbeBatchResultSchema, assertSchema } from '@opsense/schema';
import type {
  BatchDiscoveryDecision,
  BatchDiscoveryInput,
  GovernedProbePlan,
  ProbeRequest,
  ScanSnapshot,
} from '@opsense/schema';
import type { CommandExecutionResult, SafeCommandExecutor } from '@opsense/ssh';
import { describe, expect, it, vi } from 'vitest';

describe('v3 governed probe batch', () => {
  it('validates sources and merges duplicate or covered path probes', () => {
    const input = probeInput();
    const requests: ProbeRequest[] = [
      listing('probe:root', '/opt/orders', 3),
      listing('probe:child', '/opt/orders/config', 2),
      listing('probe:duplicate', '/opt/orders', 3),
      listing('probe:forbidden', '/proc/1', 1),
    ];
    const plan = compileGovernedProbePlan(
      input,
      { ...probeDecision(), probeRequests: requests },
      probeSnapshot(),
      { now: () => new Date('2026-09-05T01:00:00.000Z') },
    );

    assertSchema(GovernedProbePlanSchema, plan);
    expect(plan.requests.map((request) => request.id)).toEqual(['probe:root']);
    expect(plan.audit.filter((item) => item.status === 'deduplicated')).toHaveLength(2);
    expect(plan.audit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          request: expect.objectContaining({ id: 'probe:forbidden' }),
          status: 'rejected',
        }),
      ]),
    );
  });

  it('executes systemd requests in one batch and returns object-level evidence', async () => {
    const execute = vi.fn(async (spec: { id: string }, parameters: Record<string, unknown>) => {
      expect(spec.id).toBe('service.systemd-show-batch');
      expect(parameters.unitNames).toEqual(['one.service', 'two.service']);
      return commandResult(
        spec.id,
        'Id=one.service\nActiveState=active\n\nId=two.service\nActiveState=failed\n',
      );
    });
    const requests = [unitProbe('probe:one', 'one.service'), unitProbe('probe:two', 'two.service')];
    const plan = {
      audit: requests.map((request) => ({
        reason: 'accepted',
        request,
        status: 'accepted' as const,
      })),
      generatedAt: '2026-09-05T01:00:00.000Z',
      planId: 'probe-plan:test',
      requests,
      round: 1,
      sourceCandidateSetHash: 'hash:test',
      sourceDecisionId: 'decision:test',
    } satisfies GovernedProbePlan;

    const result = await executeGovernedProbeBatch(
      { execute } as unknown as SafeCommandExecutor,
      plan,
      { opsenseVersion: '3.0.0' },
    );

    assertSchema(ProbeBatchResultSchema, result.batch);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.batch.results).toHaveLength(2);
    expect(result.batch.yield.newEvidenceCount).toBe(2);
    expect(result.execution.evidence.map((item) => item.id)).toEqual([
      'evidence:ai-probe:probe:one',
      'evidence:ai-probe:probe:two',
    ]);
  });
});

function probeInput(): BatchDiscoveryInput {
  return {
    candidates: [
      {
        candidateId: 'candidate:orders',
        composeProjects: [],
        containers: [],
        deploymentHints: ['systemd'],
        evidenceIds: ['evidence:orders'],
        imageNames: [],
        paths: [{ attributes: { path: '/opt/orders' }, id: 'path:orders', name: '/opt/orders' }],
        ports: [],
        processes: [],
        protectionSignals: ['custom_systemd_unit'],
        sourceObjectIds: ['systemd:orders.service'],
        suggestedName: 'orders',
        totals: {
          composeProjects: 0,
          containers: 0,
          evidence: 1,
          paths: 1,
          ports: 0,
          processes: 0,
          units: 1,
        },
        units: [{ attributes: {}, id: 'systemd:orders.service', name: 'orders.service' }],
        unresolvedFields: ['purpose'],
      },
    ],
    contractVersion: 'batch-discovery-v1',
    evidenceIndex: [
      { id: 'evidence:orders', kind: 'runtime_state', source: 'orders', status: 'success' },
    ],
    filteredGroups: [],
    host: { architecture: 'x86_64', hostname: 'host', operatingSystem: 'Linux' },
    probePolicy: {
      allowedKinds: ['directory_listing', 'systemd_unit'],
      maxRequests: 20,
      maxRounds: 1,
    },
    sourceCandidateSetHash: 'hash:test',
    sourceScanId: 'scan:test',
  };
}

function probeDecision(): BatchDiscoveryDecision {
  return {
    decisionId: 'decision:test',
    filteredCandidateIds: [],
    probeRequests: [],
    retainedUnknownCandidateIds: [],
    services: [
      {
        confidence: 'unknown',
        evidenceIds: ['evidence:orders'],
        name: 'orders',
        reviewItems: [],
        role: 'needs_review',
        serviceId: 'service:orders',
        sourceCandidateIds: ['candidate:orders'],
        sourceObjectIds: ['systemd:orders.service'],
        unknownFields: ['purpose'],
      },
    ],
    sourceCandidateSetHash: 'hash:test',
    summary: 'Needs investigation.',
    unresolvedQuestions: [],
  };
}

function listing(id: string, path: string, maxDepth: number): ProbeRequest {
  return {
    evidenceIds: ['evidence:orders'],
    expectedFields: ['purpose'],
    id,
    kind: 'directory_listing',
    maxBytes: 10_000,
    maxDepth,
    maxMatches: 20,
    path,
    reason: 'Inspect deployment layout.',
    targetServiceId: 'service:orders',
    timeoutMs: 5_000,
  };
}

function unitProbe(id: string, unitName: string): ProbeRequest & { kind: 'systemd_unit' } {
  return {
    evidenceIds: ['evidence:orders'],
    expectedFields: ['status'],
    id,
    kind: 'systemd_unit',
    maxBytes: 10_000,
    reason: 'Inspect unit.',
    targetServiceId: 'service:orders',
    timeoutMs: 5_000,
    unitName,
  };
}

function probeSnapshot(): ScanSnapshot {
  return { storage: { mounts: [] } } as unknown as ScanSnapshot;
}

function commandResult(commandId: string, stdout: string): CommandExecutionResult {
  return {
    commandId,
    durationMs: 1,
    exitCode: 0,
    finishedAt: '2026-09-05T01:00:01.000Z',
    startedAt: '2026-09-05T01:00:00.000Z',
    status: 'success',
    stderr: '',
    stderrBytes: 0,
    stdout,
    stdoutBytes: Buffer.byteLength(stdout),
  };
}
