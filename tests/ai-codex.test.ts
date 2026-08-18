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
    const prompts: string[] = [];
    const thread = {
      id: 'codex-structured-thread',
      run: async (prompt: string, options?: TurnOptions) => {
        prompts.push(prompt);
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
    expect(optionsSeen[0]?.outputSchema).toHaveProperty('properties.kind.enum', [
      'tool_call',
      'final',
      'failed',
    ]);
    expect(prompts[0]).toContain('kind=projection_update is not a valid Codex transport value');
  });

  it('normalizes the legacy mixed projection update shape to one tool call', async () => {
    const prompts: string[] = [];
    const argumentsValue = {
      changes: [
        {
          assessment: {
            confidence: 'inferred',
            evidenceIds: ['evidence:nexus'],
            importance: 'high',
            purpose: 'Artifact repository.',
            reason: 'Compose evidence identifies Nexus.',
            reportPlacement: 'primary',
            reviewItems: [],
            role: 'middleware',
            serviceId: 'service:compose:nexus:nexus',
            unknowns: [],
          },
          changeType: 'service_assessment',
          objectId: 'service:compose:nexus:nexus',
          operation: 'update',
          summary: 'Classify Nexus.',
        },
      ],
      evidenceIds: ['evidence:nexus'],
      reason: 'Apply the evidence-backed service assessment.',
    };
    const thread = {
      id: 'codex-mixed-projection-thread',
      run: async (prompt: string) => {
        prompts.push(prompt);
        return {
          items: [],
          finalResponse: JSON.stringify({
            decisionId: 'decision:mixed-projection',
            turnId: 'model-turn',
            kind: 'projection_update',
            reason: 'Apply the service assessment.',
            nextAction: 'continue',
            unresolvedQuestions: [],
            nextSuggestions: [],
            payloadJson: JSON.stringify({
              arguments: argumentsValue,
              toolName: 'update_projection',
            }),
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
    const result = await adapter.run(started.threadId, 'test');

    expect(result.decision).toMatchObject({
      arguments: argumentsValue,
      kind: 'tool_call',
      toolName: 'update_projection',
    });
    expect(prompts).toHaveLength(1);
  });

  it('reports only the selected tool argument errors after repair is exhausted', async () => {
    const thread = {
      id: 'codex-invalid-tool-thread',
      run: async () => ({
        items: [],
        finalResponse: JSON.stringify({
          decisionId: 'decision:invalid-update',
          turnId: 'model-turn',
          kind: 'tool_call',
          reason: 'Apply an incomplete update.',
          nextAction: 'continue',
          unresolvedQuestions: [],
          nextSuggestions: [],
          payloadJson: JSON.stringify({
            arguments: { changes: [] },
            toolName: 'update_projection',
          }),
        }),
        usage: null,
      }),
    } as unknown as Thread;
    const adapter = new CodexAgentThreadAdapter({
      client: {
        startThread: () => thread,
        resumeThread: () => thread,
      },
      maxRetries: 0,
    });

    const started = await adapter.start({});

    await expect(adapter.run(started.threadId, 'test')).rejects.toThrow(
      /Invalid update_projection arguments:[\s\S]*evidenceIds/,
    );
  });

  it('repairs invalid tool arguments with the exact tool contract', async () => {
    const prompts: string[] = [];
    let call = 0;
    const validArguments = {
      discoveredServices: [],
      discoveryCompleted: false,
      filteredGroups: [],
      investigations: [
        {
          evidenceIds: ['evidence:unit:nexus'],
          investigationId: 'investigation:nexus',
          label: 'Nexus deployment',
          priority: 'high',
          reason: 'The custom unit requires investigation.',
          serviceIds: ['service:systemd:nexus.service'],
          sourceObjectIds: ['systemd:nexus.service'],
          status: 'selected',
        },
      ],
      planningCompleted: true,
      reason: 'Plan the selected investigation.',
      unresolvedQuestions: [],
    };
    const thread = {
      id: 'codex-repair-thread',
      run: async (prompt: string) => {
        prompts.push(prompt);
        call += 1;
        const argumentsValue =
          call === 1
            ? {
                ...validArguments,
                investigations: [
                  {
                    ...validArguments.investigations[0],
                    priority: undefined,
                    status: 'active',
                  },
                ],
              }
            : validArguments;
        return {
          items: [],
          finalResponse: JSON.stringify({
            decisionId: 'decision:repair',
            turnId: 'model-turn',
            kind: 'tool_call',
            reason: 'Plan discovery.',
            nextAction: 'Apply plan.',
            unresolvedQuestions: [],
            nextSuggestions: [],
            payloadJson: JSON.stringify({
              arguments: argumentsValue,
              toolName: 'plan_discovery',
            }),
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
      maxRetries: 1,
    });

    const started = await adapter.start({});
    const result = await adapter.run(started.threadId, 'test');

    expect(result.decision).toMatchObject({
      arguments: validArguments,
      toolName: 'plan_discovery',
    });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('Tool argument validation errors:');
    expect(prompts[1]).toContain('/investigations/0');
    expect(prompts[1]).toContain('Preserve all valid IDs');
    expect(prompts[1]).toContain('"status":"selected|investigating|resolved|needs_review"');
    expect(prompts[1]).toContain('"priority":"critical|high|medium|low"');
    expect(prompts[1]).toContain('Every investigation requires priority');
  });
});
