import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  FileAgentSessionStore,
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
});
