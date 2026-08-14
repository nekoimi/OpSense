import {
  buildPathSeeds,
  extractAbsolutePaths,
  isPathSeedScanEligible,
  normalizePathSeed,
} from '@opsense/collectors';
import { describe, expect, it } from 'vitest';

describe('M5 path seeds', () => {
  it('builds normalized, sourced seeds from runtime records', () => {
    const seeds = buildPathSeeds({
      composeProjects: [
        {
          configFiles: ['/srv/shop/compose.yml'],
          evidenceIds: ['evidence:compose'],
          id: 'compose:shop',
          name: 'shop',
          services: [],
          workingDirectory: '/srv/shop/./deploy',
        },
      ],
      containers: [
        {
          environmentKeys: [],
          evidenceIds: ['evidence:docker'],
          id: 'container:abc',
          image: 'app:1',
          labels: {},
          mounts: [
            { destination: '/app', readOnly: false, source: '/data/shop', type: 'bind' },
            {
              destination: '/var/lib/app',
              readOnly: false,
              source: '/var/lib/docker/overlay2/unsafe',
              type: 'volume',
            },
          ],
          name: 'app',
          networks: [],
          ports: [],
          runtime: 'docker',
          state: 'running',
        },
      ],
      processes: [
        {
          arguments: ['--config=/opt/order-api/config/app.yml'],
          command: 'node',
          evidenceIds: ['evidence:process'],
          executablePath: '/usr/bin/node',
          id: 'process:42',
          pid: 42,
          workingDirectory: '/opt/order-api',
        },
      ],
      systemdUnits: [
        {
          environmentFiles: ['/etc/order-api/order.env'],
          evidenceIds: ['evidence:systemd'],
          execReload: [],
          execStart: ['/usr/bin/node /opt/order-api/server.js'],
          id: 'systemd:order-api.service',
          name: 'order-api.service',
          workingDirectory: '/opt/order-api/../order-api',
        },
      ],
    });

    expect(seeds.map((seed) => seed.path)).toEqual(
      expect.arrayContaining([
        '/data/shop',
        '/etc/order-api/order.env',
        '/opt/order-api',
        '/opt/order-api/config/app.yml',
        '/opt/order-api/server.js',
        '/srv/shop/compose.yml',
        '/srv/shop/deploy',
        '/usr/bin/node',
      ]),
    );
    expect(seeds.map((seed) => seed.path)).not.toContain('/var/lib/docker/overlay2/unsafe');
    expect(seeds.find((seed) => seed.path === '/opt/order-api')?.sources).toHaveLength(2);
    expect(seeds.every((seed) => seed.confidence !== 'unknown')).toBe(true);
  });

  it('rejects unsafe paths and does not select broad roots for scanning', () => {
    expect(normalizePathSeed('/proc/1/root')).toBeUndefined();
    expect(normalizePathSeed('/tmp/work')).toBeUndefined();
    expect(normalizePathSeed('/opt/app\n/etc/passwd')).toBeUndefined();
    expect(normalizePathSeed('relative/path')).toBeUndefined();
    expect(
      isPathSeedScanEligible({
        confidence: 'confirmed',
        id: 'path-seed:root',
        path: '/etc',
        sources: [{ evidenceIds: [], sourceId: 'systemd:test', sourceType: 'test' }],
      }),
    ).toBe(false);
    expect(
      isPathSeedScanEligible({
        confidence: 'confirmed',
        id: 'path-seed:binary',
        path: '/usr/bin/node',
        sources: [{ evidenceIds: [], sourceId: 'process:1', sourceType: 'process.executable' }],
      }),
    ).toBe(false);
  });

  it('extracts absolute paths from command arguments without redacted values', () => {
    expect(
      extractAbsolutePaths('/usr/bin/node --config=/etc/order-api/app.json [REDACTED]'),
    ).toEqual(['/usr/bin/node', '/etc/order-api/app.json']);
  });
});
