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
import { applyDiscoveryPlan, buildInventoryProjection } from '@opsense/projection';
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

  it('fails and persists the session when a Codex turn exceeds its hard timeout', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'opsense-m15-timeout-'));
    try {
      const snapshot = await fixtureSnapshot();
      const projection = buildInventoryProjection(snapshot);
      const session = createAgentSession({ scanId: snapshot.session.id });
      const layout = createRunWorkspaceLayout(snapshot.session.id, root);
      const store = new FileAgentSessionStore(layout);
      await store.save(session);
      const runtime = new AgentRuntime({
        scanId: snapshot.session.id,
        store,
        thread: {
          start: async () => ({ threadId: 'codex-timeout-thread' }),
          resume: async (threadId: string) => ({ threadId }),
          run: () => new Promise(() => undefined),
        },
        context: new ContextBuilder({ projection }),
        tools: new ToolRouter({
          projection,
          context: new ContextBuilder({ projection }),
          governor: new ProbeGovernor({ snapshot, session }),
        }),
        turnTimeoutMs: 20,
      });

      await expect(runtime.start('开始')).rejects.toThrow('Codex turn timed out after 20 ms.');
      const failed = await store.load();
      expect(failed.state).toBe('failed');
      expect(failed.lastError).toBe('Codex turn timed out after 20 ms.');
      expect(failed.repairSuggestions.join('\n')).toContain('--turn-timeout-ms');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not retry non-transient context-window failures', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'opsense-m15-context-error-'));
    try {
      const snapshot = await fixtureSnapshot();
      const projection = buildInventoryProjection(snapshot);
      const session = createAgentSession({ scanId: snapshot.session.id });
      const store = new FileAgentSessionStore(createRunWorkspaceLayout(snapshot.session.id, root));
      await store.save(session);
      let calls = 0;
      const runtime = new AgentRuntime({
        scanId: snapshot.session.id,
        store,
        thread: {
          start: async () => ({ threadId: 'codex-context-thread' }),
          resume: async (threadId: string) => ({ threadId }),
          run: async () => {
            calls += 1;
            throw new Error("Codex ran out of room in the model's context window.");
          },
        },
        context: new ContextBuilder({ projection }),
        tools: new ToolRouter({
          projection,
          context: new ContextBuilder({ projection }),
          governor: new ProbeGovernor({ snapshot, session }),
        }),
      });

      await expect(runtime.start('开始')).rejects.toThrow('context window');
      expect(calls).toBe(1);
      expect((await store.load()).state).toBe('failed');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('persists actionable recovery guidance for Codex rate limits', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'opsense-m15-rate-limit-'));
    try {
      const snapshot = await fixtureSnapshot();
      const projection = buildInventoryProjection(snapshot);
      const session = createAgentSession({ scanId: snapshot.session.id });
      const store = new FileAgentSessionStore(createRunWorkspaceLayout(snapshot.session.id, root));
      await store.save(session);
      const context = new ContextBuilder({ projection });
      const runtime = new AgentRuntime({
        scanId: snapshot.session.id,
        store,
        thread: {
          start: async () => ({ threadId: 'codex-rate-limit-thread' }),
          resume: async (threadId: string) => ({ threadId }),
          run: async () => {
            throw new Error('exceeded retry limit, last status: 429 Too Many Requests');
          },
        },
        context,
        tools: new ToolRouter({
          projection,
          context,
          governor: new ProbeGovernor({ snapshot, session }),
        }),
      });

      await expect(runtime.start('开始')).rejects.toThrow('429 Too Many Requests');
      const failed = await store.load();
      expect(failed.repairSuggestions.join('\n')).toContain('等待配额恢复');
      expect(failed.repairSuggestions.join('\n')).toContain('--max-agent-runs');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('retries a transient Codex transport failure and then completes', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'opsense-m15-transient-'));
    try {
      const snapshot = await fixtureSnapshot();
      const projection = buildInventoryProjection(snapshot);
      const session = createAgentSession({ scanId: snapshot.session.id });
      const store = new FileAgentSessionStore(createRunWorkspaceLayout(snapshot.session.id, root));
      await store.save(session);
      let calls = 0;
      const runtime = new AgentRuntime({
        scanId: snapshot.session.id,
        store,
        thread: {
          start: async () => ({ threadId: 'codex-retry-thread' }),
          resume: async (threadId: string) => ({ threadId }),
          run: async () => {
            calls += 1;
            if (calls === 1) throw new Error('temporary connection failure');
            return {
              decision: {
                decisionId: 'decision:final-after-retry',
                turnId: 'model-turn',
                kind: 'final' as const,
                inventoryProjectionId: projection.projectionId,
                serviceWikiProjectionId: 'wiki:test',
                findingIds: [],
                qualitySummary: '重试后完成。',
                reason: '证据充分。',
                nextAction: 'wiki',
                unresolvedQuestions: [],
                nextSuggestions: [],
              },
            };
          },
        },
        context: new ContextBuilder({ projection }),
        tools: new ToolRouter({
          projection,
          context: new ContextBuilder({ projection }),
          governor: new ProbeGovernor({ snapshot, session }),
        }),
      });

      await expect(runtime.start('开始')).resolves.toMatchObject({ message: '重试后完成。' });
      expect(calls).toBe(2);
      expect((await store.load()).state).toBe('completed');
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
      expect(prompts[1]).toContain('"arguments":{"section":"services"}');
      expect((await store.load()).threadId).toBe('codex-real-thread');
      expect((await store.load()).state).toBe('completed');
      expect(runtime.currentProgress).toMatchObject({
        current: { detail: 'Turn 2 已完成，准备下一轮', phase: 'idle', sequence: 2 },
        lastTool: {
          sequence: 1,
          status: 'completed',
          toolName: 'read_context',
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('applies the duration budget to each resumed run instead of the session lifetime', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'opsense-m15-resume-budget-'));
    try {
      const snapshot = await fixtureSnapshot();
      const projection = buildInventoryProjection(snapshot);
      const session = createAgentSession({
        scanId: snapshot.session.id,
        now: () => new Date('2026-08-01T00:00:00.000Z'),
      });
      session.currentStage = 'partial';
      session.state = 'partial';
      session.stopReason = 'budget_exhausted';
      const store = new FileAgentSessionStore(createRunWorkspaceLayout(snapshot.session.id, root));
      await store.save(session);
      let turns = 0;
      const runtime = new AgentRuntime({
        scanId: snapshot.session.id,
        store,
        thread: {
          start: async () => ({ threadId: 'codex-resumed-thread' }),
          resume: async (threadId: string) => ({ threadId }),
          run: async () => {
            turns += 1;
            return turns === 1
              ? {
                  decision: {
                    arguments: { section: 'services' },
                    decisionId: 'decision:resume-read',
                    kind: 'tool_call' as const,
                    nextAction: 'continue',
                    nextSuggestions: [],
                    reason: '读取服务上下文。',
                    toolName: 'read_context' as const,
                    turnId: 'model-turn',
                    unresolvedQuestions: [],
                  },
                }
              : {
                  decision: {
                    decisionId: 'decision:resume-final',
                    findingIds: [],
                    inventoryProjectionId: projection.projectionId,
                    kind: 'final' as const,
                    nextAction: 'wiki',
                    nextSuggestions: [],
                    qualitySummary: '恢复运行已完成。',
                    reason: '证据充分。',
                    serviceWikiProjectionId: 'wiki:test',
                    turnId: 'model-turn',
                    unresolvedQuestions: [],
                  },
                };
          },
        },
        context: new ContextBuilder({ projection }),
        tools: new ToolRouter({
          projection,
          context: new ContextBuilder({ projection }),
          governor: new ProbeGovernor({ snapshot, session }),
        }),
        maxDurationMs: 60_000,
        maxTurns: 3,
        now: () => new Date('2026-08-17T00:00:00.000Z'),
      });

      await expect(runtime.resume('继续')).resolves.toMatchObject({ message: '恢复运行已完成。' });
      expect(turns).toBe(2);
      expect(runtime.currentSession.state).toBe('completed');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('applies the token budget to each resumed run instead of cumulative runtime usage', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'opsense-m15-resume-token-budget-'));
    try {
      const snapshot = await fixtureSnapshot();
      const projection = buildInventoryProjection(snapshot);
      const session = createAgentSession({ scanId: snapshot.session.id });
      const store = new FileAgentSessionStore(createRunWorkspaceLayout(snapshot.session.id, root));
      await store.save(session);
      let turns = 0;
      const runtime = new AgentRuntime({
        scanId: snapshot.session.id,
        store,
        thread: {
          start: async () => ({ threadId: `codex-token-thread-${turns}` }),
          resume: async (threadId: string) => ({ threadId }),
          run: async () => {
            turns += 1;
            if (turns < 3)
              return {
                decision: {
                  arguments: { section: 'services' },
                  decisionId: `decision:token-read-${turns}`,
                  kind: 'tool_call' as const,
                  nextAction: 'continue',
                  nextSuggestions: [],
                  reason: '读取服务上下文。',
                  toolName: 'read_context' as const,
                  turnId: 'model-turn',
                  unresolvedQuestions: [],
                },
                tokenUsage: turns === 1 ? 100 : 40,
              };
            return {
              decision: {
                decisionId: 'decision:token-final',
                findingIds: [],
                inventoryProjectionId: projection.projectionId,
                kind: 'final' as const,
                nextAction: 'wiki',
                nextSuggestions: [],
                qualitySummary: '恢复后的本轮 token 预算允许继续完成。',
                reason: '证据充分。',
                serviceWikiProjectionId: 'wiki:test',
                turnId: 'model-turn',
                unresolvedQuestions: [],
              },
            };
          },
        },
        context: new ContextBuilder({ projection }),
        tools: new ToolRouter({
          projection,
          context: new ContextBuilder({ projection }),
          governor: new ProbeGovernor({ snapshot, session }),
        }),
        maxTokens: 100,
        maxTurns: 3,
      });

      await runtime.start('开始');
      expect(runtime.currentSession).toMatchObject({ state: 'partial', turnCount: 1 });

      await runtime.resume('继续');
      expect(runtime.currentSession).toMatchObject({ state: 'completed', turnCount: 3 });
      expect(turns).toBe(3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a model failed decision while required discovery is incomplete', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'opsense-m20-nonterminal-failed-'));
    try {
      const snapshot = await fixtureSnapshot();
      snapshot.evidence = [
        {
          collectedAt: '2026-08-18T07:00:00.000Z',
          id: 'evidence:m20-runtime',
          kind: 'derived',
          opsenseVersion: '0.1.0',
          sensitivity: 'internal',
          source: 'service.normalization',
          status: 'success',
        },
      ];
      snapshot.services = [
        {
          composeProjectIds: [],
          confidence: 'inferred',
          configFiles: [],
          containerIds: [],
          dataDirectories: [],
          deployDirectories: ['/opt/order-api'],
          deploymentType: 'systemd',
          environmentFiles: [],
          evidenceIds: ['evidence:m20-runtime'],
          id: 'service:order-api',
          logLocations: [],
          name: 'order-api',
          processIds: [],
          socketIds: [],
          status: 'running',
          systemdUnitIds: [],
          unknownFields: [],
        },
      ];
      const projection = buildInventoryProjection(snapshot, {
        mode: 'agent',
        workflowVersion: 'm20_evidence_driven',
      });
      applyDiscoveryPlan(projection, {
        discoveryCompleted: false,
        discoveredServices: [],
        filteredGroups: [],
        investigations: [
          {
            evidenceIds: ['evidence:m20-runtime'],
            investigationId: 'investigation:order-api',
            label: 'Order API',
            priority: 'high',
            reason: 'Custom deployment requires a service assessment.',
            serviceIds: ['service:order-api'],
            sourceObjectIds: ['service:order-api'],
            status: 'selected',
          },
        ],
        planningCompleted: true,
        reason: 'Select the custom deployment for investigation.',
        unresolvedQuestions: [],
      });
      const session = createAgentSession({
        scanId: snapshot.session.id,
        workflowVersion: 'm20_evidence_driven',
      });
      const store = new FileAgentSessionStore(createRunWorkspaceLayout(snapshot.session.id, root));
      await store.save(session);
      const prompts: string[] = [];
      let turns = 0;
      const context = new ContextBuilder({ projection });
      const runtime = new AgentRuntime({
        scanId: snapshot.session.id,
        session,
        store,
        thread: {
          start: async () => ({ threadId: 'codex-nonterminal-failed' }),
          resume: async (threadId: string) => ({ threadId }),
          run: async (_threadId: string, prompt: string) => {
            prompts.push(prompt);
            turns += 1;
            return turns === 1
              ? {
                  decision: {
                    decisionId: 'decision:premature-failed',
                    error: 'Only static context is available.',
                    kind: 'failed' as const,
                    nextAction: 'stop',
                    nextSuggestions: [],
                    reason: 'Cannot continue.',
                    turnId: 'model-turn',
                    unresolvedQuestions: [],
                  },
                }
              : {
                  decision: {
                    arguments: { section: 'services' },
                    decisionId: 'decision:recover-read',
                    kind: 'tool_call' as const,
                    nextAction: 'continue',
                    nextSuggestions: [],
                    reason: 'Continue with the available OpSense tool.',
                    toolName: 'read_context' as const,
                    turnId: 'model-turn',
                    unresolvedQuestions: [],
                  },
                };
          },
        },
        context,
        tools: new ToolRouter({
          projection,
          context,
          governor: new ProbeGovernor({ snapshot, session }),
        }),
        maxTurns: 2,
        requireClassificationComplete: true,
      });

      await runtime.start('开始');

      expect(runtime.currentSession.state).toBe('partial');
      expect(runtime.currentSession.lastError).toBeUndefined();
      expect(turns).toBe(2);
      expect(prompts[1]).toContain('model_failed_decision');
      expect(prompts[1]).toContain('Only static context is available.');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reuses an M20 Codex thread for several Agent turns', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'opsense-m20-thread-reuse-'));
    try {
      const snapshot = await fixtureSnapshot();
      const projection = buildInventoryProjection(snapshot, {
        mode: 'agent',
        workflowVersion: 'm20_evidence_driven',
      });
      const session = createAgentSession({
        scanId: snapshot.session.id,
        workflowVersion: 'm20_evidence_driven',
      });
      const store = new FileAgentSessionStore(createRunWorkspaceLayout(snapshot.session.id, root));
      await store.save(session);
      let starts = 0;
      let resumes = 0;
      const runtime = new AgentRuntime({
        scanId: snapshot.session.id,
        session,
        store,
        thread: {
          start: async () => ({ threadId: `codex-m20-thread-${++starts}` }),
          resume: async (threadId: string) => {
            resumes += 1;
            return { threadId };
          },
          run: async () => ({
            decision: {
              arguments: { section: 'discovery' },
              decisionId: `decision:m20-read-${runtime.currentSession.turnCount + 1}`,
              kind: 'tool_call' as const,
              nextAction: 'continue',
              nextSuggestions: [],
              reason: '继续读取 M20 调查上下文。',
              toolName: 'read_context' as const,
              turnId: 'model-turn',
              unresolvedQuestions: [],
            },
          }),
        },
        context: new ContextBuilder({ projection }),
        tools: new ToolRouter({
          projection,
          context: new ContextBuilder({ projection }),
          governor: new ProbeGovernor({ snapshot, session }),
        }),
        maxTurns: 5,
      });

      await runtime.start('开始');

      expect(runtime.currentSession).toMatchObject({ state: 'partial', turnCount: 5 });
      expect(starts).toBe(2);
      expect(resumes).toBe(0);
      expect(runtime.currentSession.threadId).toBe('codex-m20-thread-2');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function fixtureSnapshot(): Promise<ScanSnapshot> {
  return JSON.parse(await readFixture('schema/minimal-snapshot.json')) as ScanSnapshot;
}
