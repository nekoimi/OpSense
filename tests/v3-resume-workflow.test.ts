import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { PipelineRunTracker, emptyRunMetrics, hashJson } from '@opsense/collection-runtime';
import { buildResourceGraph } from '@opsense/correlation';
import { buildLocalDeploymentInventory, selectDeploymentCandidates } from '@opsense/discovery';
import { redactSnapshot } from '@opsense/redaction';
import type { ScanSnapshot } from '@opsense/schema';
import { appendJsonLines, ensureRunWorkspace, writeJsonAtomic } from '@opsense/workspace';
import { afterEach, describe, expect, it } from 'vitest';

import { runResumeWorkflow } from '../apps/cli/src/workflows/resume-workflow.js';
import { readFixture } from './support/read-fixture.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('v3 pipeline resume', () => {
  it('continues from inventory_ready and does not rerun a completed pipeline', async () => {
    const fixture = await createInventoryReadyRun();
    const stages: string[] = [];

    const resumed = await runResumeWorkflow(
      {
        provider: 'noop',
        run: fixture.runId,
        timeoutMs: 1_000,
        workspace: fixture.workspace,
      },
      (stage) => stages.push(stage),
    );

    expect(resumed.status).toBe('resumed');
    expect(resumed.pipelineRun.state).toBe('completed');
    expect(stages).toEqual(['discovering', 'composing', 'reporting']);
    await expect(readFile(resumed.reports.markdownFile, 'utf8')).resolves.toContain(
      '服务器部署清单',
    );

    const secondStages: string[] = [];
    const completed = await runResumeWorkflow(
      {
        provider: 'noop',
        run: fixture.runId,
        timeoutMs: 1_000,
        workspace: fixture.workspace,
      },
      (stage) => secondStages.push(stage),
    );
    expect(completed.status).toBe('already_complete');
    expect(secondStages).toEqual([]);

    await writeFile(resumed.reports.markdownFile, 'tampered report', 'utf8');
    const repairStages: string[] = [];
    const repaired = await runResumeWorkflow(
      {
        provider: 'noop',
        run: fixture.runId,
        timeoutMs: 1_000,
        workspace: fixture.workspace,
      },
      (stage) => repairStages.push(stage),
    );
    expect(repaired.status).toBe('resumed');
    expect(repairStages).toEqual(['reporting']);
    await expect(readFile(repaired.reports.markdownFile, 'utf8')).resolves.not.toBe(
      'tampered report',
    );
  });

  it('rejects an inventory whose checkpoint hash no longer matches', async () => {
    const fixture = await createInventoryReadyRun();
    const inventory = JSON.parse(await readFile(fixture.layout.inventoryFile, 'utf8')) as {
      unresolvedQuestions: string[];
    };
    inventory.unresolvedQuestions.push('tampered');
    await writeJsonAtomic(fixture.layout.inventoryFile, inventory);

    await expect(
      runResumeWorkflow({
        provider: 'noop',
        run: fixture.runId,
        timeoutMs: 1_000,
        workspace: fixture.workspace,
      }),
    ).rejects.toThrow("checkpoint 'inventory_ready'");
  });
});

async function createInventoryReadyRun() {
  const workspace = await mkdtemp(path.join(tmpdir(), 'opsense-v3-resume-'));
  temporaryDirectories.push(workspace);
  const snapshot = JSON.parse(await readFixture('schema/minimal-snapshot.json')) as ScanSnapshot;
  const runId = 'scan:resume';
  snapshot.session.id = runId;
  const redacted = redactSnapshot(snapshot).value;
  const layout = await ensureRunWorkspace(runId, workspace);
  const graph = buildResourceGraph(redacted);
  const candidateSet = selectDeploymentCandidates(graph, redacted);
  const inventory = buildLocalDeploymentInventory(redacted, graph, candidateSet);
  const tracker = new PipelineRunTracker({
    profile: 'standard',
    runId,
    target: redacted.session.target,
  });
  tracker.transition('inventory_ready');
  tracker.checkpoint('inventory_ready', { outputHash: hashJson(inventory) });
  tracker.addOutputFiles([
    layout.snapshotFile,
    layout.evidenceFile,
    layout.resourceGraphFile,
    layout.candidateSetFile,
    layout.inventoryFile,
  ]);
  await Promise.all([
    appendJsonLines(layout.evidenceFile, redacted.evidence),
    writeJsonAtomic(layout.snapshotFile, redacted),
    writeJsonAtomic(layout.resourceGraphFile, graph),
    writeJsonAtomic(layout.candidateSetFile, candidateSet),
    writeJsonAtomic(layout.inventoryFile, inventory),
    writeJsonAtomic(layout.pipelineRunFile, tracker.snapshot()),
    writeJsonAtomic(layout.metricsFile, emptyRunMetrics(runId)),
  ]);
  return { layout, runId, workspace };
}
