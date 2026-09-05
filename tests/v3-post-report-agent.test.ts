import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { PostReportAgentAdapter } from '@opsense/ai-provider';
import type { DeploymentInventory, PostReportAgentResult, ScanSnapshot } from '@opsense/schema';
import { buildWikiProjectionV3 } from '@opsense/wiki';
import { appendJsonLines, ensureRunWorkspace, writeJsonAtomic } from '@opsense/workspace';
import { afterEach, describe, expect, it } from 'vitest';

import { runAgentWorkflow } from '../apps/cli/src/workflows/agent-workflow.js';
import { readFixture } from './support/read-fixture.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('v3 post-report Agent', () => {
  it('reads a stable Inventory and appends chained Inventory/Wiki revisions', async () => {
    const fixture = await createRun();
    const adapter = adapterFor(fixture.serviceId, fixture.evidenceId);

    const first = await runAgentWorkflow(
      {
        inventory: fixture.inventory.inventoryId,
        prompt: '明确订单服务用途并补充运维说明',
        workspace: fixture.workspace,
      },
      { adapter, now: () => new Date('2026-09-05T03:00:00.000Z') },
    );
    const second = await runAgentWorkflow(
      {
        inventory: fixture.inventory.inventoryId,
        prompt: '复核同一结论',
        workspace: fixture.workspace,
      },
      { adapter, now: () => new Date('2026-09-05T03:01:00.000Z') },
    );

    expect(first.inventoryRevision).toMatchObject({ sequence: 1 });
    expect(first.wikiRevision).toMatchObject({ sequence: 1 });
    expect(second.inventoryRevision).toMatchObject({
      parentRevisionId: first.inventoryRevision?.revisionId,
      sequence: 2,
    });
    expect(second.wikiRevision).toMatchObject({
      parentRevisionId: first.wikiRevision?.revisionId,
      sequence: 2,
    });
    expect(
      (await readFile(fixture.layout.inventoryRevisionsFile, 'utf8')).trim().split(/\r?\n/),
    ).toHaveLength(2);
    expect(
      (await readFile(fixture.layout.wikiRevisionsFile, 'utf8')).trim().split(/\r?\n/),
    ).toHaveLength(2);
    expect(JSON.parse(await readFile(fixture.layout.inventoryFile, 'utf8'))).toEqual(
      fixture.inventory,
    );
  });

  it('rejects invented Evidence before persisting a revision', async () => {
    const fixture = await createRun();
    const adapter = adapterFor(fixture.serviceId, 'evidence:invented');

    await expect(
      runAgentWorkflow(
        {
          inventory: fixture.inventory.inventoryId,
          prompt: '写入未经证实的结论',
          workspace: fixture.workspace,
        },
        { adapter },
      ),
    ).rejects.toThrow('unknown Evidence IDs');
    await expect(readFile(fixture.layout.inventoryRevisionsFile, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});

async function createRun() {
  const workspace = await mkdtemp(path.join(tmpdir(), 'opsense-v3-agent-'));
  temporaryDirectories.push(workspace);
  const layout = await ensureRunWorkspace('scan:agent', workspace);
  const evidenceId = 'evidence:orders';
  const serviceId = 'service:orders';
  const snapshot = JSON.parse(await readFixture('schema/minimal-snapshot.json')) as ScanSnapshot;
  snapshot.session.id = 'scan:agent';
  snapshot.evidence = [
    {
      collectedAt: '2026-09-05T01:00:00.000Z',
      id: evidenceId,
      kind: 'runtime_state',
      opsenseVersion: '0.1.0',
      sensitivity: 'internal',
      source: 'systemd:orders.service',
      status: 'success',
      value: 'active',
    },
  ];
  const inventory: DeploymentInventory = {
    coverage: {
      candidateCount: 1,
      filteredObjectCount: 0,
      protectedObjectCount: 1,
      rawObjectCount: 1,
    },
    exposedPorts: [],
    filteredCandidateIds: [],
    filteredGroups: [],
    findings: [],
    generatedAt: '2026-09-05T02:00:00.000Z',
    host: { hostname: 'orders-host', operatingSystem: 'Ubuntu 24.04' },
    inventoryId: 'inventory:orders',
    schemaVersion: '3.0',
    semanticStatus: 'partially_verified',
    services: [
      {
        attribution: {
          name: {
            certainty: 'confirmed',
            evidenceIds: [evidenceId],
            source: 'collector',
            value: 'orders',
          },
          role: {
            certainty: 'inferred',
            evidenceIds: [evidenceId],
            source: 'codex',
            value: 'primary_application',
          },
        },
        composeProjectIds: [],
        confidence: 'inferred',
        containerIds: [],
        deploymentHints: ['systemd'],
        evidenceIds: [evidenceId],
        imageNames: [],
        name: 'orders',
        pathIds: [],
        ports: [],
        processIds: [],
        reviewItems: ['确认业务用途'],
        role: 'primary_application',
        serviceId,
        socketIds: [],
        sourceCandidateIds: ['candidate:orders'],
        sourceObjectIds: ['systemd:orders.service'],
        unitIds: ['systemd:orders.service'],
        unknownFields: ['purpose'],
      },
    ],
    sourceEvidenceHash: 'hash:orders',
    sourceScanId: 'scan:agent',
    unresolvedQuestions: ['订单服务的正式用途是什么？'],
  };
  const wiki = buildWikiProjectionV3(inventory).projection;
  await Promise.all([
    appendJsonLines(layout.evidenceFile, snapshot.evidence),
    writeJsonAtomic(layout.snapshotFile, snapshot),
    writeJsonAtomic(layout.inventoryFile, inventory),
    writeJsonAtomic(layout.wikiFile, wiki),
  ]);
  return { evidenceId, inventory, layout, serviceId, workspace };
}

function adapterFor(serviceId: string, evidenceId: string): PostReportAgentAdapter {
  return {
    name: 'test',
    investigate: async (): Promise<PostReportAgentResult> => ({
      proposal: {
        evidenceReferences: [evidenceId],
        inventoryChanges: [
          {
            evidenceIds: [evidenceId],
            purpose: '处理订单请求',
            reason: 'systemd 运行态证据支持该服务存在。',
            serviceId,
          },
        ],
        message: '已基于现有证据提出追加修订。',
        nextSuggestions: [],
        unresolvedQuestions: [],
        wikiChanges: [
          {
            content: '订单服务当前由 systemd 托管。',
            evidenceIds: [evidenceId],
            reason: '补充已验证的运行方式。',
            section: 'service',
            serviceId,
          },
        ],
      },
      run: {
        callCount: 1,
        durationMs: 1,
        finishedAt: '2026-09-05T02:00:01.000Z',
        provider: 'test',
        repairCount: 0,
        startedAt: '2026-09-05T02:00:00.000Z',
        status: 'completed',
      },
    }),
  };
}
