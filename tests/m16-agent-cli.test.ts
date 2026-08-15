import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { AgentSessionSchema, InventoryProjectionSchema, assertSchema } from '@opsense/schema';
import type { ScanSnapshot } from '@opsense/schema';
import { ensureRunWorkspace, writeJsonAtomic } from '@opsense/workspace';
import { describe, expect, it } from 'vitest';

import { prepareAgentWorkflow } from '../apps/cli/src/workflows/agent-workflow.js';
import { readFixture } from './support/read-fixture.js';

describe('M16 agent CLI workspace', () => {
  it('starts from an existing scan and restores the same session by agent id', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'opsense-m16-'));
    try {
      const snapshot = JSON.parse(
        await readFixture('schema/minimal-snapshot.json'),
      ) as ScanSnapshot;
      const layout = await ensureRunWorkspace(snapshot.session.id, root);
      await writeJsonAtomic(layout.snapshotFile, snapshot);
      const first = await prepareAgentWorkflow({
        maxAgentRounds: 3,
        maxProbes: 2,
        port: 22,
        provider: 'codex',
        scan: snapshot.session.id,
        workspace: root,
      });
      const sessionId = first.runtime.currentSession.sessionId;
      const savedSession = JSON.parse(await readFile(layout.agentSessionFile, 'utf8')) as unknown;
      const savedProjection = JSON.parse(
        await readFile(layout.agentProjectionFile, 'utf8'),
      ) as unknown;
      assertSchema(AgentSessionSchema, savedSession);
      assertSchema(InventoryProjectionSchema, savedProjection);
      expect(first.runtime.currentSession.budgets.maxRequests).toBe(2);
      first.close();

      const resumed = await prepareAgentWorkflow({
        maxAgentRounds: 3,
        maxProbes: 2,
        port: 22,
        provider: 'codex',
        resume: sessionId,
        workspace: root,
      });
      expect(resumed.runtime.currentSession.sessionId).toBe(sessionId);
      expect(resumed.runtime.currentSession.scanId).toBe(snapshot.session.id);
      resumed.close();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
