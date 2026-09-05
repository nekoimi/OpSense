import type { Thread, TurnOptions } from '@openai/codex-sdk';
import { CodexBatchDiscoveryAdapter } from '@opsense/ai-codex';
import { buildBatchDiscoveryInput, validateBatchDiscoveryDecision } from '@opsense/discovery';
import { BatchDiscoveryArtifactSchema, assertSchema } from '@opsense/schema';
import type {
  BatchDiscoveryDecision,
  BatchDiscoveryInput,
  DeploymentCandidateSet,
  ResourceGraph,
  ScanSnapshot,
} from '@opsense/schema';
import { describe, expect, it } from 'vitest';

describe('v3 Batch Discovery', () => {
  it('builds one compact payload with hard per-candidate resource limits', () => {
    const nodes = Array.from({ length: 16 }, (_, index) => ({
      attributes: { activeState: 'active' },
      evidenceIds: [],
      kind: 'systemd_unit' as const,
      name: `app-${index}.service`,
      resourceId: `systemd:app-${index}.service`,
      sourceObjectId: `systemd:app-${index}.service`,
    }));
    const graph = {
      components: [],
      edges: [],
      generatedAt: '2026-09-05T00:00:00.000Z',
      graphId: 'resource-graph:test',
      nodes,
      schemaVersion: '3.0',
      sourceScanId: 'scan-batch',
    } satisfies ResourceGraph;
    const candidateSet = {
      candidates: [
        {
          candidateId: 'candidate:app',
          composeProjectIds: [],
          containerIds: [],
          deploymentHints: ['systemd'],
          evidenceIds: Array.from({ length: 20 }, (_, index) => `evidence:${index}`),
          exposedPorts: Array.from({ length: 10 }, (_, hostPort) => ({
            exposed: true,
            hostPort,
            protocol: 'tcp' as const,
          })),
          imageNames: [],
          pathIds: [],
          processIds: [],
          protectionSignals: ['custom_systemd_unit'],
          socketIds: [],
          sourceObjectIds: nodes.map((node) => node.sourceObjectId),
          unitIds: nodes.map((node) => node.sourceObjectId),
          unresolvedFields: ['role', 'purpose'],
        },
      ],
      filteredGroups: [],
      generatedAt: '2026-09-05T00:00:00.000Z',
      graphId: graph.graphId,
      schemaVersion: '3.0',
      sourceScanId: graph.sourceScanId,
    } satisfies DeploymentCandidateSet;
    const snapshot = {
      evidence: [],
      host: {
        architecture: 'x86_64',
        hostname: 'batch-host',
        operatingSystem: { prettyName: 'Linux' },
      },
      session: { id: graph.sourceScanId, target: { host: 'batch-host' } },
    } as unknown as ScanSnapshot;

    const input = buildBatchDiscoveryInput(snapshot, graph, candidateSet, {
      maxProbeRequests: 20,
      maxProbeRounds: 1,
    });

    expect(input.candidates).toHaveLength(1);
    expect(input.candidates[0]?.units).toHaveLength(4);
    expect(input.candidates[0]?.ports).toHaveLength(8);
    expect(input.candidates[0]?.evidenceIds).toHaveLength(12);
    expect(input.candidates[0]?.totals).toMatchObject({ evidence: 20, ports: 10, units: 16 });
  });

  it('keeps valid drafts and reports only invalid item references plus completion gaps', () => {
    const input = discoveryInput();
    const decision = validDecision(input);
    const validation = validateBatchDiscoveryDecision(
      {
        ...decision,
        services: [
          {
            ...decision.services[0],
            evidenceIds: ['evidence:one'],
            sourceCandidateIds: ['candidate:one'],
            sourceObjectIds: ['systemd:one.service'],
          },
          {
            ...decision.services[0],
            evidenceIds: ['evidence:not-visible'],
            serviceId: 'service:invalid',
            sourceCandidateIds: ['candidate:two'],
            sourceObjectIds: ['systemd:two.service'],
          },
        ],
      },
      input,
    );

    expect(validation.valid).toBe(false);
    expect(validation.decision?.services.map((service) => service.serviceId)).toEqual([
      'service:merged',
    ]);
    expect(validation.itemErrors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'REFERENCE_NOT_FOUND',
          field: 'evidenceIds',
          itemId: 'service:invalid',
        }),
      ]),
    );
    expect(validation.completion.missingCandidateIds).toEqual(['candidate:two']);
  });

  it('submits all candidates in one Codex turn and records separated token usage', async () => {
    const input = discoveryInput();
    const prompts: string[] = [];
    const optionsSeen: (TurnOptions | undefined)[] = [];
    const thread = {
      id: 'thread:batch',
      run: async (prompt: string, options?: TurnOptions) => {
        prompts.push(prompt);
        optionsSeen.push(options);
        return {
          finalResponse: JSON.stringify(validDecision(input)),
          items: [],
          usage: {
            cache_write_input_tokens: 0,
            cached_input_tokens: 7,
            input_tokens: 100,
            output_tokens: 30,
            reasoning_output_tokens: 11,
          },
        };
      },
    } as unknown as Thread;
    const adapter = new CodexBatchDiscoveryAdapter({
      client: { resumeThread: () => thread, startThread: () => thread },
    });

    const artifact = await adapter.discover(input);

    assertSchema(BatchDiscoveryArtifactSchema, artifact);
    expect(artifact.run).toMatchObject({
      callCount: 1,
      repairCount: 0,
      status: 'completed',
      usage: { cachedInputTokens: 7, inputTokens: 100, outputTokens: 30, reasoningTokens: 11 },
    });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('candidate:one');
    expect(prompts[0]).toContain('candidate:two');
    expect(optionsSeen[0]?.outputSchema).toHaveProperty('$id', 'BatchDiscoveryDecisionV3');
  });

  it('repairs local item errors inside the same thread and degrades safely when unavailable', async () => {
    const input = discoveryInput();
    const prompts: string[] = [];
    let call = 0;
    const thread = {
      id: 'thread:repair',
      run: async (prompt: string) => {
        prompts.push(prompt);
        call += 1;
        const decision = validDecision(input);
        return {
          finalResponse: JSON.stringify(
            call === 1
              ? {
                  ...decision,
                  services: [{ ...decision.services[0], evidenceIds: ['evidence:not-visible'] }],
                }
              : decision,
          ),
          items: [],
          usage: null,
        };
      },
    } as unknown as Thread;
    const adapter = new CodexBatchDiscoveryAdapter({
      client: { resumeThread: () => thread, startThread: () => thread },
    });

    const repaired = await adapter.discover(input, { maxRetries: 1 });

    expect(repaired.run).toMatchObject({ callCount: 2, repairCount: 1, status: 'completed' });
    expect(prompts[1]).toContain('REFERENCE_NOT_FOUND');
    expect(prompts[1]).toContain('Preserve valid items and IDs');

    const unavailable = new CodexBatchDiscoveryAdapter({
      client: {
        resumeThread: () => {
          throw new Error('runtime unavailable');
        },
        startThread: () => {
          throw new Error('runtime unavailable');
        },
      },
    });
    const degraded = await unavailable.discover(input);
    expect(degraded.run.status).toBe('degraded');
    expect(degraded.decision.retainedUnknownCandidateIds).toEqual([
      'candidate:one',
      'candidate:two',
    ]);
    expect(degraded.completion.complete).toBe(true);
  });

  it('repairs invalid JSON without starting another discovery thread', async () => {
    const input = discoveryInput();
    let call = 0;
    const prompts: string[] = [];
    const thread = {
      id: 'thread:json-repair',
      run: async (prompt: string) => {
        prompts.push(prompt);
        call += 1;
        return {
          finalResponse: call === 1 ? '{invalid' : JSON.stringify(validDecision(input)),
          items: [],
          usage: null,
        };
      },
    } as unknown as Thread;
    const adapter = new CodexBatchDiscoveryAdapter({
      client: { resumeThread: () => thread, startThread: () => thread },
    });

    const result = await adapter.discover(input, { maxRetries: 1 });

    expect(result.run).toMatchObject({ callCount: 2, repairCount: 1, status: 'completed' });
    expect(prompts[1]).toContain('not valid JSON');

    const budgetThread = {
      id: 'thread:budget',
      run: async () => ({ finalResponse: '{invalid', items: [], usage: null }),
    } as unknown as Thread;
    const budgeted = new CodexBatchDiscoveryAdapter({
      client: { resumeThread: () => budgetThread, startThread: () => budgetThread },
    });
    const exhausted = await budgeted.discover(input, { maxCalls: 1, maxRetries: 5 });
    expect(exhausted.run).toMatchObject({ callCount: 1, status: 'degraded' });
    expect(exhausted.run.error).toContain('call budget exhausted');
  });
});

function discoveryInput(): BatchDiscoveryInput {
  return {
    candidates: [candidate('one'), candidate('two')],
    contractVersion: 'batch-discovery-v1',
    evidenceIndex: [evidence('one'), evidence('two')],
    filteredGroups: [
      {
        category: 'routine_system_service',
        groupId: 'filtered:routine',
        objectCount: 40,
        reason: 'Routine operating-system units.',
        sampleNames: ['cron.service'],
      },
    ],
    host: { architecture: 'x86_64', hostname: 'batch-host', operatingSystem: 'Linux' },
    probePolicy: {
      allowedKinds: ['systemd_unit', 'directory_metadata'],
      maxRequests: 20,
      maxRounds: 1,
    },
    sourceCandidateSetHash: 'hash:batch',
    sourceScanId: 'scan:batch',
  };
}

function candidate(id: string): BatchDiscoveryInput['candidates'][number] {
  return {
    candidateId: `candidate:${id}`,
    composeProjects: [],
    containers: [],
    deploymentHints: ['systemd'],
    evidenceIds: [`evidence:${id}`],
    imageNames: [],
    paths: [],
    ports: [],
    processes: [],
    protectionSignals: ['custom_systemd_unit'],
    sourceObjectIds: [`systemd:${id}.service`],
    suggestedName: id,
    totals: {
      composeProjects: 0,
      containers: 0,
      evidence: 1,
      paths: 0,
      ports: 0,
      processes: 0,
      units: 1,
    },
    units: [
      {
        attributes: { activeState: 'active' },
        id: `systemd:${id}.service`,
        name: `${id}.service`,
      },
    ],
    unresolvedFields: ['role', 'purpose'],
  };
}

function evidence(id: string): BatchDiscoveryInput['evidenceIndex'][number] {
  return {
    id: `evidence:${id}`,
    kind: 'runtime_state',
    source: `systemd:${id}.service`,
    status: 'success',
  };
}

function validDecision(input: BatchDiscoveryInput): BatchDiscoveryDecision {
  return {
    decisionId: 'decision:batch',
    filteredCandidateIds: [],
    probeRequests: [],
    retainedUnknownCandidateIds: [],
    services: [
      {
        confidence: 'inferred',
        evidenceIds: ['evidence:one', 'evidence:two'],
        name: 'merged-service',
        purpose: 'Test application.',
        reviewItems: [],
        role: 'primary_application',
        serviceId: 'service:merged',
        sourceCandidateIds: ['candidate:one', 'candidate:two'],
        sourceObjectIds: ['systemd:one.service', 'systemd:two.service'],
        unknownFields: [],
      },
    ],
    sourceCandidateSetHash: input.sourceCandidateSetHash,
    summary: 'Merged the two application units.',
    unresolvedQuestions: [],
  };
}
