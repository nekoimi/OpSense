import { CodexProvider } from '@opsense/ai-codex';
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
});
