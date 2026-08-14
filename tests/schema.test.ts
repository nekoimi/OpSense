import { readFile } from 'node:fs/promises';

import {
  AiServiceSummarySchema,
  DEFAULT_OPSENSE_CONFIG,
  OpsenseConfigSchema,
  ScanSnapshotSchema,
  validateSchema,
} from '@opsense/schema';
import { describe, expect, it } from 'vitest';

async function readFixture(name: string): Promise<unknown> {
  const source = await readFile(new URL(`../fixtures/schema/${name}`, import.meta.url), 'utf8');
  return JSON.parse(source) as unknown;
}

describe('schema contracts', () => {
  it('accepts the default OpSense config', () => {
    const result = validateSchema(OpsenseConfigSchema, DEFAULT_OPSENSE_CONFIG);

    expect(result).toEqual({ data: DEFAULT_OPSENSE_CONFIG, errors: [], valid: true });
  });

  it('accepts a minimal scan snapshot fixture', async () => {
    const fixture = await readFixture('minimal-snapshot.json');

    expect(validateSchema(ScanSnapshotSchema, fixture).valid).toBe(true);
  });

  it('rejects an invalid scan snapshot fixture with useful errors', async () => {
    const fixture = await readFixture('invalid-snapshot.json');
    const result = validateSchema(ScanSnapshotSchema, fixture);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.length).toBeGreaterThan(2);
      expect(result.errors.join('\n')).toContain('/session');
    }
  });

  it('rejects out-of-range config values', () => {
    const invalid = {
      ...DEFAULT_OPSENSE_CONFIG,
      scan: { ...DEFAULT_OPSENSE_CONFIG.scan, maxDirectoryDepth: 100 },
    };

    expect(validateSchema(OpsenseConfigSchema, invalid).valid).toBe(false);
  });

  it('prevents AI summaries from claiming confirmed confidence', () => {
    const result = validateSchema(AiServiceSummarySchema, {
      serviceId: 'svc-api',
      purpose: 'API service',
      purposeConfidence: 'confirmed',
      summary: 'AI-generated summary',
      evidenceIds: [],
      notes: [],
    });

    expect(result.valid).toBe(false);
  });
});
