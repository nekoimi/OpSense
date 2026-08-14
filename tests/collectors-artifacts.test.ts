import {
  artifactFromEntry,
  configFormat,
  parseConfigSummary,
  parseFindEntries,
  parseStatEntries,
} from '@opsense/collectors';
import { describe, expect, it } from 'vitest';

import { readFixture } from './support/read-fixture.js';

describe('M5 artifact and config parsers', () => {
  it('parses bounded find metadata and classifies deployment artifacts', async () => {
    const entries = parseFindEntries(await readFixture('m5/find-output.txt'));
    const artifacts = entries.map((entry) =>
      artifactFromEntry(entry, 'evidence:directory.scan:test', 'confirmed'),
    );

    expect(artifacts.find((item) => item.path.endsWith('/app.yml'))?.kind).toBe('config');
    expect(artifacts.find((item) => item.path.endsWith('/.env'))?.kind).toBe('environment');
    expect(artifacts.find((item) => item.path.endsWith('/Dockerfile'))?.kind).toBe('config');
    expect(artifacts.find((item) => item.path.endsWith('/start.sh'))?.kind).toBe('script');
    expect(artifacts.find((item) => item.path.endsWith('/app.log'))?.kind).toBe('log');
    expect(artifacts.find((item) => item.path.endsWith('/data'))?.kind).toBe('data');
    expect(artifacts.find((item) => item.path.endsWith('/current'))).toMatchObject({
      fileType: 'symlink',
      linkTarget: '/opt/order-api/releases/42',
    });
    expect(
      artifactFromEntry(
        {
          fileType: 'file',
          path: '/var/lib/docker/volumes/fastdfs_storage_data/_data/data/00/blob.json',
          sizeBytes: 100,
        },
        'evidence:directory.scan:data',
        'confirmed',
      ).kind,
    ).toBe('data');
  });

  it('parses the stat fallback format', async () => {
    expect(parseStatEntries(await readFixture('m5/stat-output.txt'))).toMatchObject([
      { fileType: 'directory', path: '/opt/order-api' },
      { fileType: 'file', path: '/opt/order-api/config/app.yml' },
    ]);
  });

  it('stores only structured key summaries for supported config formats', async () => {
    const yaml = parseConfigSummary('yaml', await readFixture('m5/app.yml'));
    const json = parseConfigSummary('json', '{"server":{"token":"hidden"}}');
    const jsonc = parseConfigSummary('json', '{ // comment\n "server": {"port": 8080,}, }');
    const toml = parseConfigSummary('toml', '[server]\nport = 8080');
    const ini = parseConfigSummary('ini', '[server]\npassword=hidden');

    expect(yaml.topLevelKeys).toEqual(['database', 'features', 'server']);
    expect(JSON.stringify({ yaml, json, jsonc, toml, ini })).not.toContain('fixture-secret-value');
    expect(JSON.stringify({ yaml, json, jsonc, toml, ini })).not.toContain('hidden');
    expect(configFormat('/opt/app/.env')).toBeUndefined();
    expect(configFormat('/opt/app/app.service')).toBe('ini');
  });
});
