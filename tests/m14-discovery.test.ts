import { buildInventoryProjection } from '@opsense/projection';
import { buildEvidenceIndex, buildPathInvestigationSeeds } from '@opsense/discovery';
import { EvidenceIndexSchema, PathInvestigationSeedSchema, assertSchema } from '@opsense/schema';
import type { ProcessRecord, ScanSnapshot } from '@opsense/schema';
import { describe, expect, it } from 'vitest';

import { readFixture } from './support/read-fixture.js';

describe('M14 service discovery and governed path seeds', () => {
  it('builds queryable indexes and detects non-standard process runtimes', async () => {
    const projection = buildInventoryProjection(await discoverySnapshot());
    const index = buildEvidenceIndex(projection, {
      now: () => new Date('2026-08-14T07:00:00.000Z'),
    });

    expect(index.processIdsByPid['101']).toBe('process:java');
    expect(index.processIdsByParentPid['1']).toContain('process:java');
    expect(index.processIdsByCgroup['/system.slice/minio.service']).toContain('process:java');
    expect(index.unitIdsByName['minio.service']).toBe('systemd:minio.service');
    expect(index.socketIdsByPort['tcp:9000']).toEqual(['socket:9000']);
    expect(index.containerIdsByImage['minio/minio:latest']).toEqual(['container:minio']);
    expect(index.composeIdsByLabel['com.docker.compose.service=minio']).toEqual([
      'container:minio',
    ]);
    expect(index.pathSeedIdsByPath['/opt/minio']).toBe('path-seed:minio');
    expect(index.candidates.map((candidate) => candidate.runtimeKind)).toEqual(
      expect.arrayContaining(['java', 'go', 'rust', 'shell']),
    );
    expect(index.candidates.every((candidate) => candidate.mergeRule.length > 0)).toBe(true);
    assertSchema(EvidenceIndexSchema, index);
  });

  it('creates accepted and rejected path seeds from known evidence only', async () => {
    const projection = buildInventoryProjection(await discoverySnapshot());
    const index = buildEvidenceIndex(projection);
    const seeds = buildPathInvestigationSeeds(projection, index);

    const acceptedSearches = seeds.filter(
      (seed) => seed.kind === 'path_search' && seed.status === 'accepted',
    );
    expect(
      seeds.some(
        (seed) =>
          seed.kind === 'directory_listing' &&
          seed.status === 'accepted' &&
          seed.path === '/opt/minio',
      ),
    ).toBe(true);
    expect(acceptedSearches.length).toBeGreaterThan(0);
    expect(
      acceptedSearches.every(
        (seed) =>
          seed.searchRoot?.startsWith('/opt/minio') || seed.searchRoot?.startsWith('/data/minio'),
      ),
    ).toBe(true);
    expect(acceptedSearches.every((seed) => seed.evidenceIds.length > 0)).toBe(true);
    expect(acceptedSearches.map((seed) => seed.searchTerm)).toEqual(
      expect.arrayContaining(['minio']),
    );

    const rejected = seeds.find(
      (seed) => seed.path === '/proc/minio.conf' && seed.status === 'rejected',
    );
    expect(rejected?.reason).toContain('伪文件系统');
    expect(seeds.some((seed) => seed.searchRoot === '/')).toBe(false);
    seeds.forEach((seed) => assertSchema(PathInvestigationSeedSchema, seed));
  });
});

async function discoverySnapshot(): Promise<ScanSnapshot> {
  const snapshot = JSON.parse(await readFixture('schema/minimal-snapshot.json')) as ScanSnapshot;
  snapshot.evidence = [
    evidence('evidence:minio', 'service.normalization'),
    evidence('evidence:process', 'runtime.processes'),
    evidence('evidence:unit', 'systemd.details'),
    evidence('evidence:socket', 'network.sockets'),
    evidence('evidence:container', 'container.inspect'),
    evidence('evidence:path', 'directory.discovery'),
  ];
  snapshot.pathSeeds = [
    {
      confidence: 'confirmed',
      id: 'path-seed:minio',
      path: '/opt/minio',
      sources: [
        {
          evidenceIds: ['evidence:path'],
          sourceId: 'service:minio',
          sourceType: 'service.deploy_directory',
        },
      ],
    },
  ];
  snapshot.processes = [
    process(
      'process:java',
      101,
      'java -jar /opt/minio-java/app.jar',
      '/usr/bin/java',
      1,
      '/system.slice/minio.service',
    ),
    process('process:go', 102, '/opt/bin/go-build-minio server', '/opt/bin/go-build-minio'),
    process('process:rust', 103, '/opt/target/release/rustfs', '/opt/target/release/rustfs'),
    process('process:shell', 104, '/bin/bash /opt/minio/start.sh', '/bin/bash'),
  ];
  snapshot.systemdUnits = [
    {
      environmentFiles: [],
      evidenceIds: ['evidence:unit'],
      execReload: [],
      execStart: ['/opt/minio/bin/minio server /data/minio'],
      id: 'systemd:minio.service',
      name: 'minio.service',
    },
  ];
  snapshot.sockets = [
    {
      containerIds: [],
      evidenceIds: ['evidence:socket'],
      exposed: true,
      family: 'ipv4',
      id: 'socket:9000',
      listening: true,
      localAddress: '0.0.0.0',
      localPort: 9000,
      processIds: [],
      processNames: ['minio'],
      protocol: 'tcp',
    },
  ];
  snapshot.containers = [
    {
      environmentKeys: [],
      evidenceIds: ['evidence:container'],
      id: 'container:minio',
      image: 'minio/minio:latest',
      labels: { 'com.docker.compose.service': 'minio' },
      mounts: [],
      name: 'minio',
      networks: [],
      ports: [],
      runtime: 'docker',
      state: 'running',
    },
  ];
  snapshot.services = [
    {
      composeProjectIds: [],
      confidence: 'confirmed',
      configFiles: ['/opt/minio/config.yaml', '/proc/minio.conf'],
      containerIds: ['container:minio'],
      dataDirectories: ['/data/minio'],
      deployDirectories: ['/opt/minio'],
      deploymentType: 'docker',
      environmentFiles: [],
      evidenceIds: ['evidence:minio'],
      id: 'service:minio',
      logLocations: ['/var/log/minio'],
      name: 'minio',
      processIds: [],
      socketIds: ['socket:9000'],
      status: 'running',
      systemdUnitIds: ['systemd:minio.service'],
      unknownFields: [],
    },
  ];
  return snapshot;
}

function process(
  id: string,
  pid: number,
  command: string,
  executablePath: string,
  parentPid?: number,
  cgroup?: string,
): ProcessRecord {
  return {
    arguments: command.split(' ').slice(1),
    command,
    executablePath,
    evidenceIds: ['evidence:process'],
    id,
    pid,
    ...(parentPid === undefined ? {} : { parentPid }),
    ...(cgroup === undefined ? {} : { cgroup }),
  };
}

function evidence(id: string, source: string) {
  return {
    collectedAt: '2026-08-14T03:00:01.000Z',
    id,
    kind: 'derived' as const,
    opsenseVersion: '0.1.0',
    sensitivity: 'internal' as const,
    source,
    status: 'success' as const,
  };
}
