import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { buildResourceGraph } from '@opsense/correlation';
import { buildLocalDeploymentInventory, selectDeploymentCandidates } from '@opsense/discovery';
import { redactSnapshot } from '@opsense/redaction';
import type { ScanSnapshot } from '@opsense/schema';
import { buildWikiProjectionV3 } from '@opsense/wiki';
import { ensureRunWorkspace, writeJsonAtomic } from '@opsense/workspace';
import { afterEach, describe, expect, it } from 'vitest';

import { runInventoryReportWorkflow } from '../apps/cli/src/workflows/inventory-report-workflow.js';
import { readFixture } from './support/read-fixture.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('v3 report redaction gate', () => {
  it('removes credentials from persisted Inventory/Wiki input before rendering reports', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'opsense-v3-report-redaction-'));
    temporaryDirectories.push(workspace);
    const snapshot = JSON.parse(await readFixture('schema/minimal-snapshot.json')) as ScanSnapshot;
    snapshot.session.id = 'scan:report-redaction';
    const redacted = redactSnapshot(snapshot).value;
    const graph = buildResourceGraph(redacted);
    const candidates = selectDeploymentCandidates(graph, redacted);
    const inventory = buildLocalDeploymentInventory(redacted, graph, candidates);
    const jwt = 'eyJabcdefghijk.abcdefghijk.abcdefghijk';
    const databaseUri = 'postgres://admin:super-secret@db.internal:5432/app';
    inventory.unresolvedQuestions = [`check ${jwt}`, `database ${databaseUri}`];
    const wiki = buildWikiProjectionV3(inventory).projection;
    const layout = await ensureRunWorkspace(snapshot.session.id, workspace);
    await Promise.all([
      writeJsonAtomic(layout.inventoryFile, inventory),
      writeJsonAtomic(layout.wikiFile, wiki),
    ]);

    const result = await runInventoryReportWorkflow({
      inventory: inventory.inventoryId,
      workspace,
    });
    const [markdown, html, redactionReport] = await Promise.all([
      readFile(result.artifacts.markdownFile, 'utf8'),
      readFile(result.artifacts.htmlFile, 'utf8'),
      readFile(layout.reportRedactionFile, 'utf8'),
    ]);

    expect(markdown).not.toContain(jwt);
    expect(markdown).not.toContain('admin:super-secret');
    expect(html).not.toContain(jwt);
    expect(html).not.toContain('admin:super-secret');
    expect(JSON.parse(redactionReport)).toMatchObject({
      mode: 'report',
      secretScanPassed: true,
    });
  });
});
