import { CodexSdkPreflightProbe } from '@opsense/ai-codex';
import {
  CodexUnavailableError,
  createAgentSession,
  failSessionForCodex,
  requireCodex,
  startAgentSession,
} from '@opsense/agent-runtime';
import type { AgentSession, AgentSessionStore } from '@opsense/schema';
import { describe, expect, it } from 'vitest';

describe('M12 Codex hard dependency preflight', () => {
  it('checks a read-only thread and accepts the exact structured response', async () => {
    const optionsSeen: Record<string, unknown>[] = [];
    const probe = new CodexSdkPreflightProbe({
      client: {
        startThread(options) {
          optionsSeen.push(options as Record<string, unknown>);
          return {
            id: 'thread-fixture',
            run: async () => ({ finalResponse: '{"ok":true}' }),
          } as never;
        },
      } as never,
      workingDirectory: 'C:/opsense-fixture',
    });

    const result = await requireCodex(probe, () => new Date('2026-08-14T05:00:00.000Z'));

    expect(result).toMatchObject({ available: true, threadId: 'thread-fixture' });
    expect(result.checkedAt).toBe('2026-08-14T05:00:00.000Z');
    expect(optionsSeen[0]).toMatchObject({
      approvalPolicy: 'never',
      networkAccessEnabled: false,
      sandboxMode: 'read-only',
      workingDirectory: 'C:/opsense-fixture',
    });
  });

  it('rejects non-exact structured output', async () => {
    const probe = new CodexSdkPreflightProbe({
      client: {
        startThread() {
          return {
            id: 'thread-fixture',
            run: async () => ({ finalResponse: '{"ok":true,"extra":"no"}' }),
          } as never;
        },
      } as never,
      workingDirectory: 'C:/opsense-fixture',
    });

    await expect(requireCodex(probe)).rejects.toBeInstanceOf(CodexUnavailableError);
  });

  it('turns a preflight error into a failed resumable session', () => {
    const session = createAgentSession({ scanId: 'scan-fixture' });
    const failed = failSessionForCodex(session, 'Codex credentials are unavailable.', [
      '运行 codex login 并确认目标模型可用。',
    ]);

    expect(failed.state).toBe('failed');
    expect(failed.repairSuggestions).toHaveLength(1);
    expect(failed.scanId).toBe(session.scanId);
  });

  it('preflights before entering the investigating stage and persists failure state', async () => {
    const session = createAgentSession({ scanId: 'scan-fixture' });
    const saved: AgentSession[] = [];
    const store: AgentSessionStore = {
      appendTranscript: async () => undefined,
      appendTurn: async () => undefined,
      load: async () => saved.at(-1) ?? session,
      save: async (value) => saved.push(value),
    };
    const ready = await startAgentSession({
      session,
      store,
      probe: { check: async () => ({ available: true, checks: {}, threadId: 'thread-ready' }) },
      now: () => new Date('2026-08-14T05:00:00.000Z'),
    });

    expect(ready).toMatchObject({
      currentStage: 'investigating',
      state: 'running',
      threadId: 'thread-ready',
    });
    expect(saved.map((item) => item.currentStage)).toEqual(['bootstrapping', 'investigating']);

    const failedSession = createAgentSession({ scanId: 'scan-failure' });
    const failedSaved: AgentSession[] = [];
    const failedStore: AgentSessionStore = {
      appendTranscript: async () => undefined,
      appendTurn: async () => undefined,
      load: async () => failedSaved.at(-1) ?? failedSession,
      save: async (value) => failedSaved.push(value),
    };
    await expect(
      startAgentSession({
        session: failedSession,
        store: failedStore,
        probe: {
          check: async () => ({
            available: false,
            checks: { login: false },
            error: 'login required',
          }),
        },
        now: () => new Date('2026-08-14T05:00:00.000Z'),
      }),
    ).rejects.toBeInstanceOf(CodexUnavailableError);
    expect(failedSaved.at(-1)).toMatchObject({ currentStage: 'failed', state: 'failed' });
  });
});
