import type { Thread, TurnOptions } from '@openai/codex-sdk';
import { CodexAgentThreadAdapter, CodexProvider } from '@opsense/ai-codex';
import { BaselineRelevanceClassifier } from '@opsense/ai-provider';
import type { ScanSnapshot } from '@opsense/schema';
import { describe, expect, it } from 'vitest';

import { readFixture } from './support/read-fixture.js';

describe('M9 Codex provider fallback', () => {
  it('returns a valid baseline result when the local Codex runtime is unavailable', async () => {
    const snapshot = JSON.parse(await readFixture('schema/minimal-snapshot.json')) as ScanSnapshot;
    const baselinePlan = new BaselineRelevanceClassifier().classify(snapshot);
    const provider = new CodexProvider({
      client: {
        resumeThread() {
          throw new Error('Codex runtime unavailable');
        },
        startThread() {
          throw new Error('Codex runtime unavailable');
        },
      },
    });

    const result = await provider.analyze({
      aiInputDirectory: '.',
      baselinePlan,
      snapshot,
    });

    expect(result.run.status).toBe('degraded');
    expect(result.analysis.provider).toBe('baseline');
    expect(result.plan.serviceAssessments).toHaveLength(snapshot.services.length);
  });

  it('constrains Agent turns with the AgentDecision output schema', async () => {
    const optionsSeen: (TurnOptions | undefined)[] = [];
    const thread = {
      id: 'codex-structured-thread',
      run: async (_prompt: string, options?: TurnOptions) => {
        optionsSeen.push(options);
        return {
          items: [],
          finalResponse: JSON.stringify({
            decisionId: 'decision:structured',
            turnId: 'model-turn',
            kind: 'failed',
            reason: '验证 Schema 传递。',
            nextAction: 'stop',
            unresolvedQuestions: [],
            nextSuggestions: [],
            payloadJson: JSON.stringify({ error: '测试结束。' }),
          }),
          usage: null,
        };
      },
    } as unknown as Thread;
    const adapter = new CodexAgentThreadAdapter({
      client: {
        startThread: () => thread,
        resumeThread: () => thread,
      },
    });

    const started = await adapter.start({});
    await adapter.run(started.threadId, 'test');

    expect(optionsSeen).toHaveLength(1);
    expect(optionsSeen[0]?.outputSchema).toMatchObject({
      type: 'object',
    });
    expect(optionsSeen[0]?.outputSchema).toHaveProperty('properties.payloadJson');
  });
});
