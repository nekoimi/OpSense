import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createAgentSession } from '@opsense/agent-runtime';
import { buildInventoryProjection } from '@opsense/projection';
import { AgentSessionSchema, InventoryProjectionSchema, assertSchema } from '@opsense/schema';
import type { AgentResponse, AgentSession, AgentTurn, ScanSnapshot } from '@opsense/schema';
import { ensureRunWorkspace, writeJsonAtomic } from '@opsense/workspace';
import { describe, expect, it } from 'vitest';

import {
  buildAgentProgressSnapshot,
  formatAgentHeartbeat,
  formatAgentProgress,
} from '../apps/cli/src/agent-progress.js';
import { assertWikiThreadAudit, runAgentToCompletion } from '../apps/cli/src/commands/agent.js';
import { prepareAgentWorkflow } from '../apps/cli/src/workflows/agent-workflow.js';
import { readFixture } from './support/read-fixture.js';

describe('M16 agent CLI workspace', () => {
  it('formats a friendly M20 progress summary without a misleading global percentage', async () => {
    const snapshot = JSON.parse(await readFixture('schema/minimal-snapshot.json')) as ScanSnapshot;
    const projection = buildInventoryProjection(snapshot, {
      mode: 'agent',
      workflowVersion: 'm20_evidence_driven',
    });
    const session = createAgentSession({
      model: 'gpt-5.6-luna',
      scanId: snapshot.session.id,
      workflowVersion: 'm20_evidence_driven',
    });

    const progress = buildAgentProgressSnapshot(session, projection);
    const output = formatAgentProgress(progress).join('\n');

    expect(output).toContain('证据筛选与调查规划');
    expect(output).toContain('模型 gpt-5.6-luna');
    expect(output).toContain('调查：完成 0/0');
    expect(output).toContain('门禁：计划 未完成 | 调查收尾 未完成');
    expect(output).not.toContain('%');
    expect(formatAgentHeartbeat(progress, 72_000)).toContain(
      'Codex 处理中 | 证据筛选与调查规划 | 本次 1m 12s',
    );
  });

  it('shows the current Codex action and last tool failure in heartbeats', async () => {
    const snapshot = JSON.parse(await readFixture('schema/minimal-snapshot.json')) as ScanSnapshot;
    const projection = buildInventoryProjection(snapshot, {
      mode: 'agent',
      workflowVersion: 'm20_evidence_driven',
    });
    const session = createAgentSession({
      scanId: snapshot.session.id,
      workflowVersion: 'm20_evidence_driven',
    });
    const progress = buildAgentProgressSnapshot(session, projection, {
      current: {
        detail: '等待 Codex 返回结构化决策',
        phase: 'waiting_for_codex',
        sequence: 43,
        startedAt: '2026-08-18T16:01:29.000Z',
      },
      lastTool: {
        resultSummary: '请同时修改 role 与 reportPlacement。',
        sequence: 42,
        status: 'failed',
        toolName: 'update_projection',
      },
    });

    const output = formatAgentHeartbeat(progress, 120_000, Date.parse('2026-08-18T16:03:29Z'));

    expect(output).toContain('Turn 43');
    expect(output).toContain('当前 等待 Codex 返回结构化决策 2m 0s');
    expect(output).toContain(
      '上一步 Turn 42 update_projection 失败: 请同时修改 role 与 reportPlacement。',
    );
  });

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

  it('accepts an audited classification and final decision from different Codex threads', () => {
    const sessionId = 'agent:multi-thread-audit';
    const classificationThreadId = 'thread:classification';
    const compositionThreadId = 'thread:composition';
    const finalThreadId = 'thread:final';
    const turns: AgentTurn[] = [
      agentTurn({
        decisionKind: 'tool_call',
        projectionChanges: ['service:order-api'],
        sequence: 8,
        sessionId,
        threadId: classificationThreadId,
        toolCalls: [
          {
            activityId: 'activity:plan-discovery',
            argumentSummary: '{}',
            evidenceIds: ['evidence:order-api'],
            finishedAt: '2026-08-18T07:42:14.000Z',
            resultSummary: 'Discovery completed.',
            startedAt: '2026-08-18T07:42:13.000Z',
            status: 'completed',
            toolName: 'plan_discovery',
          },
        ],
      }),
      agentTurn({
        decisionKind: 'tool_call',
        projectionChanges: ['wiki-narrative:scan:test'],
        sequence: 9,
        sessionId,
        threadId: compositionThreadId,
        toolCalls: [
          {
            activityId: 'activity:compose-wiki',
            argumentSummary: '{}',
            evidenceIds: ['evidence:order-api'],
            finishedAt: '2026-08-18T07:42:16.000Z',
            resultSummary: 'Wiki composed.',
            startedAt: '2026-08-18T07:42:15.000Z',
            status: 'completed',
            toolName: 'compose_wiki',
          },
        ],
      }),
      agentTurn({
        decisionKind: 'final',
        projectionChanges: [],
        sequence: 10,
        sessionId,
        threadId: finalThreadId,
        toolCalls: [],
      }),
    ];

    expect(() =>
      assertWikiThreadAudit(
        { sessionId, threadId: finalThreadId, turnCount: 10 },
        {
          classificationThreadId,
          wikiNarrative: {
            architectureOverview: '应用采用独立服务部署。',
            deploymentOverview: '部署路径来自已审查证据。',
            executiveSummary: '服务器运行订单应用。',
            generatedAt: '2026-08-18T07:42:16.000Z',
            keyFindings: [],
            operationsOverview: '运维时关注服务状态。',
            provider: 'codex',
            serviceDescriptions: [],
            serviceGroups: [],
            systemOverview: 'Linux 应用服务器。',
            threadId: compositionThreadId,
            unresolvedQuestions: [],
          },
        },
        turns,
      ),
    ).not.toThrow();
  });

  it('rejects a classification thread without an audited projection change', () => {
    const sessionId = 'agent:missing-classification-audit';
    const finalThreadId = 'thread:final';
    const turns = [
      agentTurn({
        decisionKind: 'final',
        projectionChanges: [],
        sequence: 10,
        sessionId,
        threadId: finalThreadId,
        toolCalls: [],
      }),
    ];

    expect(() =>
      assertWikiThreadAudit(
        { sessionId, threadId: finalThreadId, turnCount: 10 },
        { classificationThreadId: 'thread:not-audited' },
        turns,
      ),
    ).toThrow('Projection 分类 Thread 没有对应的成功变更 Turn');
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

      const luna = await prepareAgentWorkflow({
        maxAgentRounds: 3,
        maxProbes: 2,
        model: 'gpt-5.6-luna',
        port: 22,
        provider: 'codex',
        preflight: availablePreflight(),
        resume: sessionId,
        workspace: root,
      });
      expect(luna.runtime.currentSession.model).toBe('gpt-5.6-luna');
      expect(JSON.parse(await readFile(layout.agentSessionFile, 'utf8'))).toMatchObject({
        model: 'gpt-5.6-luna',
      });
      luna.close();
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

function agentTurn(
  values: Pick<
    AgentTurn,
    'decisionKind' | 'projectionChanges' | 'sequence' | 'sessionId' | 'threadId' | 'toolCalls'
  >,
): AgentTurn {
  return {
    decisionKind: values.decisionKind,
    evidenceAdded: [],
    finishedAt: '2026-08-18T07:43:44.000Z',
    inputContextHash: 'audit-context-hash',
    projectionChanges: values.projectionChanges,
    sequence: values.sequence,
    sessionId: values.sessionId,
    startedAt: '2026-08-18T07:43:43.000Z',
    threadId: values.threadId,
    toolCalls: values.toolCalls,
    turnId: `turn:${values.sequence}`,
    userMessage: 'Continue.',
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
