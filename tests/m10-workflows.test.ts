import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { NoopBatchDiscoveryAdapter } from '@opsense/ai-provider';
import { PipelineRunTracker, emptyRunMetrics } from '@opsense/collection-runtime';
import { buildResourceGraph } from '@opsense/correlation';
import {
  buildBatchDiscoveryInput,
  buildLocalDeploymentInventory,
  selectDeploymentCandidates,
} from '@opsense/discovery';
import { redactSnapshot } from '@opsense/redaction';
import type { ReportFormat } from '@opsense/report';
import type { ScanSnapshot } from '@opsense/schema';
import { ensureRunWorkspace } from '@opsense/workspace';
import { afterEach, describe, expect, it } from 'vitest';

import { runInspectWorkflow } from '../apps/cli/src/workflows/inspect-workflow.js';
import type { FinalizeWorkflowResult } from '../apps/cli/src/workflows/finalize-workflow.js';
import type { ScanWorkflowResult } from '../apps/cli/src/workflows/scan-workflow.js';
import { readFixture } from './support/read-fixture.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('v3 CLI workflows', () => {
  it('keeps inspect stages ordered and returns the stable Inventory reports', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'opsense-v3-inspect-'));
    temporaryDirectories.push(root);
    const snapshot = JSON.parse(await readFixture('schema/minimal-snapshot.json')) as ScanSnapshot;
    const redacted = redactSnapshot(snapshot, () => new Date('2026-08-14T09:00:00Z')).value;
    const layout = await ensureRunWorkspace(snapshot.session.id, root);
    const graph = buildResourceGraph(redacted);
    const candidateSet = selectDeploymentCandidates(graph, redacted);
    const inventory = buildLocalDeploymentInventory(redacted, graph, candidateSet);
    const pipelineRun = new PipelineRunTracker({
      runId: snapshot.session.id,
      target: snapshot.session.target,
    }).snapshot();
    const metrics = emptyRunMetrics(snapshot.session.id);
    const input = buildBatchDiscoveryInput(redacted, graph, candidateSet, pipelineRun.budgets);
    const artifact = await new NoopBatchDiscoveryAdapter().discover(input);
    const scanResult = {
      candidateSet,
      config: {} as ScanWorkflowResult['config'],
      connection: { close: () => undefined } as NonNullable<ScanWorkflowResult['connection']>,
      executor: {} as NonNullable<ScanWorkflowResult['executor']>,
      layout,
      inventory,
      metrics,
      pipelineRun,
      resourceGraph: graph,
      scanId: snapshot.session.id,
      snapshot: redacted,
      workspaceRoot: root,
    } satisfies ScanWorkflowResult;
    const discovery = { artifact, candidateSet, input, layout, metrics, pipelineRun };
    const stages: string[] = [];
    const finalization = {
      composition: {},
      inventory,
      metrics,
      pipelineRun: { ...pipelineRun, state: 'completed' },
      reports: {
        docxFile: path.join(root, '服务器部署清单.docx'),
        htmlFile: path.join(root, 'index.html'),
        markdownFile: path.join(root, 'README.md'),
        outputDirectory: root,
      },
    } as FinalizeWorkflowResult;

    const result = await runInspectWorkflow(
      {
        formats: ['markdown'] as ReportFormat[],
        host: 'server.example.com',
        port: 22,
        provider: 'noop',
        threadTimeoutMs: 1_000,
        user: 'ops',
        workspace: root,
      },
      (stage) => stages.push(stage),
      {
        runScan: async (_options, handler) => {
          await handler?.('created');
          return scanResult;
        },
        runDiscovery: async (_options, handler) => {
          await handler?.('discovering');
          return discovery;
        },
        runFinalize: async (_options, _scan, _discovery, _decision, _snapshot, handler) => {
          await handler?.('composing');
          await handler?.('reporting');
          return finalization;
        },
      },
    );

    expect(stages).toEqual(['created', 'discovering', 'composing', 'reporting']);
    expect(result.finalization.reports.docxFile).toContain('.docx');
    expect(result.finalization.reports.htmlFile).toContain('index.html');
    expect(result.finalization.inventory.inventoryId).toBe(inventory.inventoryId);
  });
});
