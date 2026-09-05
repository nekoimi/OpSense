import type { Thread } from '@openai/codex-sdk';
import { CodexBatchDiscoveryAdapter } from '@opsense/ai-codex';
import { buildFinalDeploymentInventory } from '@opsense/discovery';
import { renderV3Html, renderV3Markdown, renderV3Docx } from '@opsense/report';
import {
  DeploymentInventorySchema,
  WikiNarrativeResultSchema,
  WikiProjectionV3Schema,
  assertSchema,
} from '@opsense/schema';
import type {
  BatchDiscoveryArtifact,
  DeploymentCandidateSet,
  ResourceGraph,
  ScanSnapshot,
  WikiNarrativeProposal,
} from '@opsense/schema';
import { buildWikiProjectionV3, deploymentInventoryHash } from '@opsense/wiki';
import { describe, expect, it } from 'vitest';

describe('v3 stable inventory and Wiki', () => {
  it('freezes a stable attributed inventory from a merged discovery decision', () => {
    const first = inventoryFixture('2026-09-05T01:00:00.000Z');
    const retried = inventoryFixture('2026-09-05T02:00:00.000Z');

    assertSchema(DeploymentInventorySchema, first);
    expect(first.inventoryId).toBe(retried.inventoryId);
    expect(first.services).toHaveLength(1);
    expect(first.services[0]).toMatchObject({
      attribution: {
        name: { certainty: 'inferred', source: 'codex', value: 'orders' },
        role: { certainty: 'inferred', source: 'codex', value: 'primary_application' },
      },
      role: 'primary_application',
      sourceCandidateIds: ['candidate:api', 'candidate:worker'],
    });
    expect(first.services[0]?.serviceId).not.toBe('service:model-generated');
    expect(first.semanticStatus).toBe('verified');
  });

  it('builds a reference-checked Wiki projection and all three report formats', async () => {
    const inventory = inventoryFixture('2026-09-05T01:00:00.000Z');
    const narrative = narrativeFor(inventory);
    const built = buildWikiProjectionV3(inventory, narrative, { requireNarrative: true });

    assertSchema(WikiProjectionV3Schema, built.projection);
    expect(built.quality.passed).toBe(true);
    expect(built.quality.serviceCoverage).toBe(1);
    expect(renderV3Markdown(inventory, built.projection)).toContain('orders');
    expect(renderV3Html(inventory, built.projection)).toContain('<!doctype html>');
    expect((await renderV3Docx(inventory, built.projection)).byteLength).toBeGreaterThan(1_000);

    const invalid = buildWikiProjectionV3(
      inventory,
      {
        ...narrative,
        serviceDescriptions: [
          { ...narrative.serviceDescriptions[0]!, evidenceIds: ['evidence:unrelated'] },
        ],
      },
      { requireNarrative: true },
    );
    expect(invalid.quality.passed).toBe(false);
    expect(invalid.projection.narrative).toBeUndefined();
  });

  it('composes the Wiki in one structured Codex call without a final Agent turn', async () => {
    const inventory = inventoryFixture('2026-09-05T01:00:00.000Z');
    const prompts: string[] = [];
    const thread = {
      id: 'thread:wiki',
      run: async (prompt: string) => {
        prompts.push(prompt);
        return { finalResponse: JSON.stringify(narrativeFor(inventory)), items: [], usage: null };
      },
    } as unknown as Thread;
    const adapter = new CodexBatchDiscoveryAdapter({
      client: { resumeThread: () => thread, startThread: () => thread },
    });

    const result = await adapter.compose(inventory, { maxCalls: 1, threadId: 'thread:wiki' });

    assertSchema(WikiNarrativeResultSchema, result);
    expect(result.run).toMatchObject({ callCount: 1, status: 'completed' });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(inventory.inventoryId);
  });
});

function inventoryFixture(now: string) {
  const snapshot = {
    evidence: [
      evidence('evidence:api', 'systemd:orders-api.service'),
      evidence('evidence:worker', 'systemd:orders-worker.service'),
    ],
    findings: [],
    host: {
      hostname: 'orders-host',
      operatingSystem: { prettyName: 'Ubuntu 24.04' },
    },
    session: { id: 'scan:orders', target: { host: 'orders-host' } },
  } as unknown as ScanSnapshot;
  const graph = {
    components: [],
    edges: [],
    generatedAt: now,
    graphId: 'graph:orders',
    nodes: [node('systemd:orders-api.service'), node('systemd:orders-worker.service')],
    schemaVersion: '3.0',
    sourceScanId: 'scan:orders',
  } satisfies ResourceGraph;
  const candidateSet = {
    candidates: [
      candidate('api', 8080, 'evidence:api'),
      candidate('worker', undefined, 'evidence:worker'),
    ],
    filteredGroups: [],
    generatedAt: now,
    graphId: graph.graphId,
    schemaVersion: '3.0',
    sourceScanId: 'scan:orders',
  } satisfies DeploymentCandidateSet;
  const discovery = {
    batchErrors: [],
    completion: {
      complete: true,
      duplicateCandidateIds: [],
      handledCandidateIds: ['candidate:api', 'candidate:worker'],
      missingCandidateIds: [],
    },
    decision: {
      decisionId: 'decision:orders',
      filteredCandidateIds: [],
      probeRequests: [],
      retainedUnknownCandidateIds: [],
      services: [
        {
          confidence: 'inferred',
          evidenceIds: ['evidence:api', 'evidence:worker'],
          name: 'orders',
          purpose: 'Order processing application.',
          reviewItems: [],
          role: 'primary_application',
          serviceId: 'service:model-generated',
          sourceCandidateIds: ['candidate:api', 'candidate:worker'],
          sourceObjectIds: ['systemd:orders-api.service', 'systemd:orders-worker.service'],
          unknownFields: [],
        },
      ],
      sourceCandidateSetHash: 'hash:orders',
      summary: 'Merged API and worker.',
      unresolvedQuestions: [],
    },
    itemErrors: [],
    run: {
      callCount: 1,
      durationMs: 1,
      finishedAt: now,
      provider: 'codex',
      repairCount: 0,
      startedAt: now,
      status: 'completed',
      usage: { cachedInputTokens: 0, inputTokens: 10, outputTokens: 10, reasoningTokens: 0 },
    },
    schemaVersion: '3.0',
  } satisfies BatchDiscoveryArtifact;
  return buildFinalDeploymentInventory(snapshot, graph, candidateSet, discovery, {
    now: () => new Date(now),
  });
}

function candidate(id: string, port: number | undefined, evidenceId: string) {
  const objectId = `systemd:orders-${id}.service`;
  return {
    candidateId: `candidate:${id}`,
    composeProjectIds: [],
    containerIds: [],
    deploymentHints: ['systemd' as const],
    evidenceIds: [evidenceId],
    exposedPorts:
      port === undefined ? [] : [{ exposed: true, hostPort: port, protocol: 'tcp' as const }],
    imageNames: [],
    pathIds: [],
    processIds: [],
    protectionSignals: ['custom_systemd_unit' as const],
    socketIds: [],
    sourceObjectIds: [objectId],
    suggestedName: `orders-${id}`,
    unitIds: [objectId],
    unresolvedFields: [],
  };
}

function node(id: string) {
  return {
    attributes: {},
    evidenceIds: [],
    kind: 'systemd_unit' as const,
    name: id.replace('systemd:', ''),
    resourceId: id,
    sourceObjectId: id,
  };
}

function evidence(id: string, source: string) {
  return {
    collectedAt: '2026-09-05T00:00:00.000Z',
    id,
    kind: 'runtime_state' as const,
    opsenseVersion: '3.0.0',
    sensitivity: 'internal' as const,
    source,
    status: 'success' as const,
    value: { active: true },
  };
}

function narrativeFor(inventory: ReturnType<typeof inventoryFixture>): WikiNarrativeProposal {
  const service = inventory.services[0]!;
  return {
    architectureSummary: 'The API and worker form one local order-processing deployment.',
    executiveSummary: 'This host runs the order-processing application.',
    inventoryHash: deploymentInventoryHash(inventory),
    inventoryId: inventory.inventoryId,
    operationsConcerns: [
      { evidenceIds: [service.evidenceIds[0]!], text: 'Review application health.' },
    ],
    reviewRecommendations: ['Confirm downstream dependencies with the application owner.'],
    serviceDescriptions: [
      {
        evidenceIds: service.evidenceIds,
        operations: ['Monitor the exposed API endpoint.'],
        serviceId: service.serviceId,
        summary: 'Processes order requests and background work.',
      },
    ],
  };
}
