import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  AgentRuntime,
  ContextBuilder,
  FileAgentSessionStore,
  ProbeGovernor,
  ToolRouter,
  createAgentSession,
} from '@opsense/agent-runtime';
import { buildInventoryProjection } from '@opsense/projection';
import type { ScanSnapshot } from '@opsense/schema';
import { createRunWorkspaceLayout } from '@opsense/workspace';
import { describe, expect, it } from 'vitest';

import { readFixture } from './support/read-fixture.js';

describe('M15 agent runtime', () => {
  it('builds layered context and redacts sensitive keys', async () => {
    const snapshot = await fixtureSnapshot();
    snapshot.evidence = [
      {
        collectedAt: '2026-08-14T03:00:01.000Z',
        id: 'evidence:secret',
        kind: 'config_value',
        opsenseVersion: '0.1.0',
        sensitivity: 'secret',
        source: 'config.env',
        status: 'success',
        value: { password: 'do-not-send', host: 'db.internal' },
      },
    ];
    const projection = buildInventoryProjection(snapshot);
    const context = new ContextBuilder({ projection }).build({
      stage: 'investigating',
      round: 1,
      budget: {},
    });
    expect(context.l0).toHaveProperty('counts');
    expect(JSON.stringify(context)).not.toContain('do-not-send');
    expect(context.hash).toHaveLength(64);
  });

  it('keeps tools structured and refuses arbitrary tool names and unsafe probes', async () => {
    const snapshot = await fixtureSnapshot();
    const projection = buildInventoryProjection(snapshot);
    const session = createAgentSession({ scanId: snapshot.session.id });
    const governor = new ProbeGovernor({ snapshot, session });
    const router = new ToolRouter({
      projection,
      context: new ContextBuilder({ projection }),
      governor,
    });
    const unsupported = await router.execute('shell', { command: 'id' }, 'turn-test');
    expect(unsupported.status).toBe('failed');
    const unsafe = await router.execute(
      'execute_governed_probe',
      {
        request: {
          kind: 'path_search',
          id: 'probe:unsafe',
          targetServiceId: 'service:none',
          reason: 'test',
          expectedFields: ['x'],
          evidenceIds: [],
          maxBytes: 1024,
          timeoutMs: 1000,
          searchRoot: '/',
          searchTerm: 'id',
          maxDepth: 1,
          maxMatches: 1,
        },
      },
      'turn-test',
    );
    expect(unsafe.status).toBe('failed');
    expect(unsafe.activity.toolName).toBe('execute_governed_probe');
  });

  it('persists Codex failure without baseline fallback', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'opsense-m15-'));
    try {
      const snapshot = await fixtureSnapshot();
      const projection = buildInventoryProjection(snapshot);
      const session = createAgentSession({ scanId: snapshot.session.id });
      const layout = createRunWorkspaceLayout(snapshot.session.id, root);
      const store = new FileAgentSessionStore(layout);
      await store.save(session);
      const thread = {
        start: async () => {
          throw new Error('Codex unavailable');
        },
        resume: async () => {
          throw new Error('Codex unavailable');
        },
        run: async () => ({ decision: {} }),
      };
      const runtime = new AgentRuntime({
        scanId: snapshot.session.id,
        store,
        thread,
        context: new ContextBuilder({ projection }),
        tools: new ToolRouter({
          projection,
          context: new ContextBuilder({ projection }),
          governor: new ProbeGovernor({ snapshot, session }),
        }),
        now: () => new Date('2026-08-14T03:00:02.000Z'),
      });
      await expect(runtime.start('开始')).rejects.toThrow('Codex unavailable');
      const failed = await store.load();
      expect(failed.state).toBe('failed');
      expect(failed.lastError).toContain('Codex unavailable');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('feeds tool results into the next turn and persists the real thread id', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'opsense-m15-loop-'));
    try {
      const snapshot = await fixtureSnapshot();
      const projection = buildInventoryProjection(snapshot);
      const session = createAgentSession({ scanId: snapshot.session.id });
      const layout = createRunWorkspaceLayout(snapshot.session.id, root);
      const store = new FileAgentSessionStore(layout);
      await store.save(session);
      const prompts: string[] = [];
      let turn = 0;
      const thread = {
        start: async () => ({ threadId: 'pending-thread' }),
        resume: async (threadId: string) => ({ threadId }),
        run: async (_threadId: string, prompt: string) => {
          prompts.push(prompt);
          turn += 1;
          return turn === 1
            ? {
                threadId: 'codex-real-thread',
                tokenUsage: 100,
                decision: {
                  decisionId: 'decision:read',
                  turnId: 'model-turn',
                  kind: 'tool_call' as const,
                  toolName: 'read_context',
                  arguments: { section: 'services' },
                  reason: '读取服务候选。',
                  nextAction: 'continue',
                  unresolvedQuestions: [],
                  nextSuggestions: [],
                },
              }
            : {
                threadId: 'codex-real-thread',
                decision: {
                  decisionId: 'decision:final',
                  turnId: 'model-turn',
                  kind: 'final' as const,
                  inventoryProjectionId: projection.projectionId,
                  serviceWikiProjectionId: 'wiki:test',
                  findingIds: [],
                  qualitySummary: 'Wiki 投影已完成。',
                  reason: '证据已足够。',
                  nextAction: 'wiki',
                  unresolvedQuestions: [],
                  nextSuggestions: [],
                },
              };
        },
      };
      const context = new ContextBuilder({ projection });
      const runtime = new AgentRuntime({
        scanId: snapshot.session.id,
        store,
        thread,
        context,
        tools: new ToolRouter({
          projection,
          context,
          governor: new ProbeGovernor({ snapshot, session }),
        }),
        maxTurns: 3,
      });
      const response = await runtime.start('开始');
      expect(response.message).toBe('Wiki 投影已完成。');
      expect(prompts).toHaveLength(2);
      expect(prompts[1]).toContain('read_context');
      expect((await store.load()).threadId).toBe('codex-real-thread');
      expect((await store.load()).state).toBe('completed');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function fixtureSnapshot(): Promise<ScanSnapshot> {
  return JSON.parse(await readFixture('schema/minimal-snapshot.json')) as ScanSnapshot;
}
