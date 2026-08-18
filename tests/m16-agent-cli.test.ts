import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createAgentSession } from '@opsense/agent-runtime';
import { buildInventoryProjection } from '@opsense/projection';
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

  it('recovers a timed-out Codex turn during complete orchestration', async () => {
    let session: Pick<
      AgentSession,
      'coverage' | 'state' | 'stopReason' | 'turnCount' | 'workflowVersion'
    > = {
      coverage: { classification: 0.5 },
      state: 'partial',
      turnCount: 2,
      workflowVersion: 'm20_evidence_driven',
    };
    let calls = 0;
    const logs: string[] = [];
    const completed = response('response:completed-after-timeout');

    const result = await runAgentToCompletion(
      {
        get currentSession() {
          return session;
        },
        resume: async () => {
          calls += 1;
          if (calls === 1) {
            session = {
              ...session,
              state: 'failed',
              stopReason: 'codex_failed',
            };
            throw new Error('Codex turn timed out after 120000 ms.');
          }
          session = {
            coverage: { classification: 1 },
            state: 'completed',
            stopReason: 'classification_complete',
            turnCount: 3,
            workflowVersion: 'm20_evidence_driven',
          };
          return completed;
        },
      },
      response('response:initial'),
      logger(logs),
      3,
    );

    expect(result).toBe(completed);
    expect(calls).toBe(2);
    expect(logs.join('\n')).toContain('Codex turn timed out; auto-resume 3/3');
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

  it('migrates a legacy M19 session and projection with recoverable backups', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'opsense-m16-migration-'));
    try {
      const snapshot = JSON.parse(
        await readFixture('schema/minimal-snapshot.json'),
      ) as ScanSnapshot;
      const layout = await ensureRunWorkspace(snapshot.session.id, root);
      const legacyProjection = buildInventoryProjection(snapshot, {
        mode: 'agent',
        workflowVersion: 'm19_full_candidate_review',
      });
      const legacySession = createAgentSession({
        scanId: snapshot.session.id,
        workflowVersion: 'm19_full_candidate_review',
      });
      legacySession.currentStage = 'partial';
      legacySession.state = 'partial';
      legacySession.stopReason = 'budget_exhausted';
      legacySession.threadId = 'codex-legacy-thread';
      legacySession.budgets.usedRequests = legacySession.budgets.maxRequests;
      await Promise.all([
        writeJsonAtomic(layout.snapshotFile, snapshot),
        writeJsonAtomic(layout.agentProjectionFile, legacyProjection),
        writeJsonAtomic(layout.agentSessionFile, legacySession),
      ]);

      const migrated = await prepareAgentWorkflow({
        maxAgentRounds: 3,
        maxProbes: 2,
        port: 22,
        provider: 'codex',
        preflight: availablePreflight(),
        resume: legacySession.sessionId,
        workspace: root,
      });

      expect(migrated.runtime.currentSession).toMatchObject({
        coverage: { classification: 0 },
        sessionId: legacySession.sessionId,
        state: 'partial',
        workflowVersion: 'm20_evidence_driven',
      });
      expect(migrated.runtime.currentSession.budgets).toMatchObject({
        maxRequests: 2,
        usedRequests: 0,
      });
      expect(migrated.runtime.currentSession.threadId).toBeUndefined();
      expect(migrated.projection.discoveryWorkspace?.workflowVersion).toBe('m20_evidence_driven');
      expect(
        JSON.parse(await readFile(`${layout.agentSessionFile}.m19.json`, 'utf8')),
      ).toMatchObject({
        sessionId: legacySession.sessionId,
        workflowVersion: 'm19_full_candidate_review',
      });
      expect(
        JSON.parse(await readFile(`${layout.agentProjectionFile}.m19.json`, 'utf8')),
      ).not.toHaveProperty('discoveryWorkspace');
      migrated.close();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

function logger(logs: string[]) {
  return {
    debug: () => undefined,
    error: () => undefined,
    info: (message: string) => logs.push(message),
  };
}

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
