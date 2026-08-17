import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { AgentSessionSchema, InventoryProjectionSchema, assertSchema } from '@opsense/schema';
import type { AgentResponse, AgentSession, ScanSnapshot } from '@opsense/schema';
import { ensureRunWorkspace, writeJsonAtomic } from '@opsense/workspace';
import { describe, expect, it } from 'vitest';

import { runAgentToCompletion } from '../apps/cli/src/commands/agent.js';
import { prepareAgentWorkflow } from '../apps/cli/src/workflows/agent-workflow.js';
import { readFixture } from './support/read-fixture.js';

describe('M16 agent CLI workspace', () => {
  it('automatically resumes partial Agent runs until classification completes', async () => {
    let session: Pick<AgentSession, 'coverage' | 'state' | 'turnCount'> = {
      coverage: { classification: 0.5 },
      state: 'partial',
      turnCount: 2,
    };
    const logs: string[] = [];
    const initial = response('response:initial');
    const completed = response('response:completed');
    const result = await runAgentToCompletion(
      {
        get currentSession() {
          return session;
        },
        resume: async () => {
          session = {
            coverage: { classification: 1 },
            state: 'completed',
            turnCount: 3,
          };
          return completed;
        },
      },
      initial,
      {
        debug: () => undefined,
        error: () => undefined,
        info: (message) => logs.push(message),
      },
      3,
    );

    expect(result).toBe(completed);
    expect(session).toMatchObject({ state: 'completed', turnCount: 3 });
    expect(logs.join('\n')).toContain('Auto-resume 2/3');
  });

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
        preflight: availablePreflight(),
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
        preflight: availablePreflight(),
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

function response(responseId: string): AgentResponse {
  return {
    evidenceReferences: [],
    message: '继续。',
    nextAction: 'continue',
    nextSuggestions: [],
    observations: [],
    responseId,
    sessionId: 'agent:test',
    toolActivity: [],
    turnId: 'turn:test',
    unresolvedQuestions: [],
    updatedEntities: [],
    wikiArtifacts: [],
  };
}

function availablePreflight() {
  return {
    check: async () => ({
      available: true,
      checks: { login: true, model: true, sdk: true, thread: true },
      threadId: 'codex-preflight-test',
    }),
  };
}
