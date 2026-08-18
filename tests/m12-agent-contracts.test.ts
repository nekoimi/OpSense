import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  FileAgentSessionStore,
  AGENT_DECISION_PROMPT_CONTRACT,
  createAgentSession,
  createTranscriptEntry,
  failSessionForCodex,
} from '@opsense/agent-runtime';
import {
  AgentDecisionSchema,
  AgentHypothesisSchema,
  AgentResponseSchema,
  AgentSessionSchema,
  AgentTurnSchema,
  ServiceWikiProjectionSchema,
  TranscriptEntrySchema,
  assertSchema,
  validateSchema,
} from '@opsense/schema';
import type { AgentTurn } from '@opsense/schema';
import { createRunWorkspaceLayout } from '@opsense/workspace';
import { afterEach, describe, expect, it } from 'vitest';

import { readFixture } from './support/read-fixture.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('M12 agent contracts and session workspace', () => {
  it.each([
    ['agent-session.json', AgentSessionSchema],
    ['agent-decision.json', AgentDecisionSchema],
    ['agent-hypothesis.json', AgentHypothesisSchema],
    ['agent-turn.json', AgentTurnSchema],
    ['agent-response.json', AgentResponseSchema],
    ['transcript-entry.json', TranscriptEntrySchema],
    ['service-wiki-projection.json', ServiceWikiProjectionSchema],
  ])('validates the %s fixture', async (file, schema) => {
    const value = JSON.parse(await readFixture(`schema/${file}`)) as unknown;
    assertSchema(schema, value);
  });

  it('rejects extra fields in structured model decisions', async () => {
    const value = JSON.parse(await readFixture('schema/agent-decision.json')) as Record<
      string,
      unknown
    >;
    value.unstructuredFact = 'must not be accepted';

    expect(validateSchema(AgentDecisionSchema, value).valid).toBe(false);
  });

  it('rejects Agent tool aliases outside the supported tool names', async () => {
    const value = JSON.parse(await readFixture('schema/agent-decision.json')) as Record<
      string,
      unknown
    >;
    value.toolName = 'get_evidence';

    expect(validateSchema(AgentDecisionSchema, value).valid).toBe(false);
  });

  it('keeps list_candidates limited to the lightweight service index contract', async () => {
    const value = JSON.parse(await readFixture('schema/agent-decision.json')) as Record<
      string,
      unknown
    >;
    value.arguments = { limit: 500 };
    expect(validateSchema(AgentDecisionSchema, value).valid).toBe(true);

    value.arguments = { section: 'services' };
    expect(validateSchema(AgentDecisionSchema, value).valid).toBe(false);

    value.arguments = { limit: 501 };
    expect(validateSchema(AgentDecisionSchema, value).valid).toBe(false);
  });

  it('validates tool-specific plan_discovery arguments in AgentDecision', () => {
    const valid = planDiscoveryDecision();

    expect(validateSchema(AgentDecisionSchema, valid).valid).toBe(true);

    const invalidStatus = structuredClone(valid);
    invalidStatus.arguments.investigations[0]!.status = 'active';
    expect(validateSchema(AgentDecisionSchema, invalidStatus).valid).toBe(false);

    const missingPriority = structuredClone(valid) as Record<string, unknown>;
    delete (
      (missingPriority.arguments as { investigations: Record<string, unknown>[] })
        .investigations[0] as Record<string, unknown>
    ).priority;
    expect(validateSchema(AgentDecisionSchema, missingPriority).valid).toBe(false);

    const extraFilterProperty = structuredClone(valid) as Record<string, unknown>;
    (
      (extraFilterProperty.arguments as { filteredGroups: Record<string, unknown>[] })
        .filteredGroups[0] as Record<string, unknown>
    ).status = 'filtered';
    expect(validateSchema(AgentDecisionSchema, extraFilterProperty).valid).toBe(false);
  });

  it('documents exact discovery enums and required fields in the shared Agent prompt', () => {
    expect(AGENT_DECISION_PROMPT_CONTRACT).toContain(
      '"status":"selected|investigating|resolved|needs_review"',
    );
    expect(AGENT_DECISION_PROMPT_CONTRACT).toContain('"priority":"critical|high|medium|low"');
    expect(AGENT_DECISION_PROMPT_CONTRACT).toContain(
      'active, pending, done, complete, and arbitrary values are invalid',
    );
    expect(AGENT_DECISION_PROMPT_CONTRACT).toContain('No additional properties');
    expect(AGENT_DECISION_PROMPT_CONTRACT).toContain(
      'Projection changes have exactly one representation',
    );
    expect(AGENT_DECISION_PROMPT_CONTRACT).toContain(
      'Never emit kind=projection_update and never combine',
    );
    expect(AGENT_DECISION_PROMPT_CONTRACT).toContain('[compose_wiki]');
    expect(AGENT_DECISION_PROMPT_CONTRACT).toContain('serviceDescriptions');
    expect(AGENT_DECISION_PROMPT_CONTRACT).toContain('protected=true');
    expect(AGENT_DECISION_PROMPT_CONTRACT).toContain('must start with service:agent:');
  });

  it('validates the complete AI Wiki composition contract', () => {
    const value = composeWikiDecision();

    expect(validateSchema(AgentDecisionSchema, value).valid).toBe(true);
    const invalid = structuredClone(value) as Record<string, unknown>;
    (invalid.arguments as Record<string, unknown>).extraNarrative = 'not allowed';
    expect(validateSchema(AgentDecisionSchema, invalid).valid).toBe(false);
  });

  it('persists sessions, turns, and transcripts in the run workspace', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'opsense-m12-session-'));
    temporaryDirectories.push(root);
    const layout = createRunWorkspaceLayout('scan-fixture', root);
    const store = new FileAgentSessionStore(layout);
    const session = createAgentSession({
      now: () => new Date('2026-08-14T03:00:00.000Z'),
      scanId: 'scan-fixture',
    });
    await store.save(session);

    const turn = JSON.parse(await readFixture('schema/agent-turn.json')) as AgentTurn;
    turn.sessionId = session.sessionId;
    const transcript = createTranscriptEntry(
      session.sessionId,
      1,
      'user',
      '整理服务器服务。',
      () => new Date('2026-08-14T03:00:01.000Z'),
    );
    await store.appendTurn(turn);
    await store.appendTranscript(transcript);

    expect(await store.load()).toEqual(session);
    expect(JSON.parse((await readFile(layout.agentTurnsFile, 'utf8')).trim())).toEqual(turn);
    expect(JSON.parse((await readFile(layout.agentTranscriptFile, 'utf8')).trim())).toEqual(
      transcript,
    );
  });

  it('records a Codex failure and repair suggestions on the session', () => {
    const session = createAgentSession({ scanId: 'scan-fixture' });
    const failed = failSessionForCodex(
      session,
      'Codex login is unavailable.',
      ['运行 codex login 后重试。'],
      () => new Date('2026-08-14T03:00:02.000Z'),
    );

    expect(failed).toMatchObject({
      currentStage: 'failed',
      lastError: 'Codex login is unavailable.',
      repairSuggestions: ['运行 codex login 后重试。'],
      state: 'failed',
    });
  });

  it('redacts credentials before writing transcript text', () => {
    const entry = createTranscriptEntry(
      'agent:test',
      1,
      'user',
      'password=plain-text token:abc123',
    );

    expect(entry.text).toBe('password=[REDACTED] token=[REDACTED]');
  });
});

function planDiscoveryDecision() {
  return {
    arguments: {
      discoveredServices: [
        {
          deploymentType: 'systemd',
          evidenceIds: ['evidence:unit:nexus'],
          name: 'nexus.service',
          reason: 'Custom unit requires investigation.',
          serviceId: 'service:systemd:nexus.service',
          sourceObjectIds: ['systemd:nexus.service'],
          status: 'running',
          unknownFields: ['active compose variant'],
        },
      ],
      discoveryCompleted: false,
      filteredGroups: [
        {
          evidenceIds: ['evidence:unit:systemd-tmpfiles'],
          groupId: 'filter:routine-systemd',
          label: 'Routine system units',
          reason: 'Evidence identifies routine operating-system maintenance units.',
          resourceClass: 'systemd-routine',
          sourceObjectIds: ['systemd:systemd-tmpfiles-setup.service'],
        },
      ],
      investigations: [
        {
          evidenceIds: ['evidence:unit:nexus'],
          investigationId: 'investigation:nexus',
          label: 'Nexus deployment',
          priority: 'high',
          reason: 'Custom executable and external listener require service-level evidence.',
          serviceIds: ['service:systemd:nexus.service'],
          sourceObjectIds: ['systemd:nexus.service'],
          status: 'selected',
        },
      ],
      planningCompleted: true,
      reason: 'Selected meaningful service evidence and grouped routine system evidence.',
      unresolvedQuestions: ['Which Nexus configuration is active?'],
    },
    decisionId: 'decision:plan-discovery',
    kind: 'tool_call',
    nextAction: 'Apply the evidence-driven discovery plan.',
    nextSuggestions: [],
    reason: 'Plan the first investigation batch.',
    toolName: 'plan_discovery',
    turnId: 'turn:plan-discovery',
    unresolvedQuestions: [],
  };
}

function composeWikiDecision() {
  return {
    arguments: {
      architectureOverview: '服务通过容器运行，现有证据未确认更多依赖。',
      deploymentOverview: '部署、配置和数据路径来自已审查证据。',
      executiveSummary: '该服务器承载内部应用与基础服务。',
      keyFindings: [],
      operationsOverview: '运维时应关注服务状态和备份策略。',
      serviceDescriptions: [
        {
          basis: '容器镜像名称为 minio/minio。',
          description: 'MinIO 是兼容 S3 API 的对象存储服务，用于提供文件和对象数据存储。',
          evidenceIds: ['evidence:container:minio'],
          serviceId: 'service:compose:minio:minio',
        },
      ],
      serviceGroups: [
        {
          serviceIds: ['service:compose:minio:minio'],
          summary: '提供对象存储能力。',
          title: '存储服务',
        },
      ],
      systemOverview: 'Linux 容器应用服务器。',
      unresolvedQuestions: [],
    },
    decisionId: 'decision:compose-wiki',
    kind: 'tool_call',
    nextAction: '完成后执行 final。',
    nextSuggestions: [],
    reason: '根据完成的服务调查撰写服务器 Wiki。',
    toolName: 'compose_wiki',
    turnId: 'turn:compose-wiki',
    unresolvedQuestions: [],
  };
}
