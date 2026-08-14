import { NORMALIZER_VERSION, normalizeAndMergeServices } from '@opsense/core';
import { EvidenceRecordSchema, ServiceRecordSchema, validateSchema } from '@opsense/schema';
import type {
  ArtifactRecord,
  ComposeProjectRecord,
  ContainerRecord,
  EvidenceRecord,
  ProcessRecord,
  SocketRecord,
  SystemdUnitRecord,
} from '@opsense/schema';
import { describe, expect, it } from 'vitest';

describe('M6 normalization and service merge', () => {
  it('merges systemd, PID, socket, and deployment artifacts into one traceable service', () => {
    const result = normalizeAndMergeServices({
      artifacts: [
        artifact('/opt/order-api/config/app.yml', 'config', 'evidence:directory'),
        artifact('/opt/order-api/.env', 'environment', 'evidence:directory'),
        artifact('/opt/order-api/logs/app.log', 'log', 'evidence:directory'),
        artifact('/opt/order-api/data', 'data', 'evidence:directory'),
      ],
      collectedAt: '2026-08-14T07:30:00+00:00',
      composeProjects: [],
      containers: [],
      evidence: evidenceFixtures(),
      opsenseVersion: '0.1.0',
      processes: [process(2341, '/system.slice/order-api.service')],
      sockets: [socket([2341], [])],
      systemdUnits: [systemdUnit()],
      unknowns: [],
    });

    expect(result.services).toHaveLength(1);
    expect(result.services[0]).toMatchObject({
      confidence: 'confirmed',
      configFiles: expect.arrayContaining([
        '/etc/systemd/system/order-api.service',
        '/opt/order-api/config/app.yml',
      ]),
      dataDirectories: ['/opt/order-api/data'],
      deployDirectories: ['/opt/order-api'],
      deploymentType: 'systemd',
      enabledAtBoot: true,
      environmentFiles: ['/opt/order-api/.env'],
      id: 'service:systemd:order-api.service',
      logLocations: ['/opt/order-api/logs/app.log'],
      name: 'order-api',
      processIds: [2341],
      socketIds: ['socket:tcp-ipv4-0.0.0.0-8080'],
      status: 'running',
      systemdUnitIds: ['systemd:order-api.service'],
    });
    expect(result.services[0]?.deployDirectories).not.toContain('/usr/bin');
    const derived = result.evidence.find((item) => item.source === 'normalization.service-merge');
    expect(derived).toMatchObject({
      parserVersion: NORMALIZER_VERSION,
      sourceEvidenceIds: expect.arrayContaining([
        'evidence:directory',
        'evidence:process',
        'evidence:socket',
        'evidence:systemd',
      ]),
      status: 'success',
    });
    expect(result.evidence.every((item) => item.parserVersion !== undefined)).toBe(true);
    result.services.forEach((item) =>
      expect(validateSchema(ServiceRecordSchema, item).valid).toBe(true),
    );
    result.evidence.forEach((item) =>
      expect(validateSchema(EvidenceRecordSchema, item).valid).toBe(true),
    );
  });

  it('merges container cgroups and Compose labels without duplicating the service', () => {
    const containerId = `container:${'a'.repeat(64)}`;
    const container: ContainerRecord = {
      environmentKeys: ['NODE_ENV'],
      evidenceIds: ['evidence:docker'],
      id: containerId,
      image: 'order-api:1.0',
      labels: {
        'com.docker.compose.project': 'shop',
        'com.docker.compose.service': 'api',
      },
      mounts: [
        { destination: '/app', readOnly: false, source: '/workspace/shop/api', type: 'bind' },
        { destination: '/app/data', readOnly: false, source: '/data/shop-api', type: 'bind' },
      ],
      name: 'shop-api-1',
      networks: ['shop_default'],
      ports: [],
      processId: 4001,
      runtime: 'docker',
      state: 'running',
    };
    const project: ComposeProjectRecord = {
      configFiles: ['/workspace/shop/docker-compose.yml'],
      evidenceIds: ['evidence:compose'],
      id: 'compose:shop',
      name: 'shop',
      services: [{ containerIds: [containerId], name: 'api' }],
      workingDirectory: '/workspace/shop',
    };
    const result = normalizeAndMergeServices({
      artifacts: [artifact('/workspace/shop/api/config.yml', 'config', 'evidence:directory')],
      collectedAt: '2026-08-14T07:30:00.000Z',
      composeProjects: [project],
      containers: [container],
      evidence: evidenceFixtures(),
      opsenseVersion: '0.1.0',
      processes: [
        {
          arguments: ['--system'],
          command: '/usr/lib/systemd/systemd',
          evidenceIds: ['evidence:process'],
          executablePath: '/usr/lib/systemd/systemd',
          id: 'process:1',
          pid: 1,
          workingDirectory: '/',
        },
        {
          ...process(4001, `/docker/${'a'.repeat(12)}`),
          containerId: `container:${'a'.repeat(12)}`,
          executablePath: '/usr/local/bin/node',
          workingDirectory: '/app',
        },
      ],
      sockets: [socket([4001], [containerId])],
      systemdUnits: [],
      unknowns: [],
    });

    expect(result.services).toHaveLength(1);
    expect(result.services[0]).toMatchObject({
      composeProjectIds: ['compose:shop'],
      confidence: 'confirmed',
      containerIds: [containerId],
      dataDirectories: ['/data/shop-api'],
      deploymentType: 'compose',
      id: 'service:compose:shop:api',
      name: 'shop/api',
      processIds: [4001],
      status: 'running',
    });
  });

  it('deduplicates standalone workers by runtime signature and marks the result inferred', () => {
    const first = process(5001);
    const second = { ...process(5002), startedAt: '2026-08-14T07:20:01.000Z' };
    const result = normalizeAndMergeServices({
      artifacts: [],
      collectedAt: '2026-08-14T07:30:00.000Z',
      composeProjects: [],
      containers: [],
      evidence: evidenceFixtures(),
      opsenseVersion: '0.1.0',
      processes: [first, second],
      sockets: [],
      systemdUnits: [],
      unknowns: ['z: missing', 'a: denied', 'z: missing'],
    });

    expect(result.services).toHaveLength(1);
    expect(result.services[0]).toMatchObject({
      confidence: 'inferred',
      deploymentType: 'process',
      processIds: [5001, 5002],
      status: 'running',
    });
    expect(result.unknowns).toEqual(['a: denied', 'z: missing']);
  });

  it('omits unobservable kernel and transient processes from the service inventory', () => {
    const result = normalizeAndMergeServices({
      artifacts: [],
      collectedAt: '2026-08-14T07:30:00.000Z',
      composeProjects: [],
      containers: [],
      evidence: evidenceFixtures(),
      opsenseVersion: '0.1.0',
      processes: [
        {
          arguments: [],
          command: '[kworker/0:1]',
          evidenceIds: ['evidence:process'],
          id: 'process:7001',
          pid: 7001,
          workingDirectory: '/',
        },
        {
          arguments: ['-c', 'systemctl status'],
          command: '/bin/sh',
          evidenceIds: ['evidence:process'],
          executablePath: '/usr/bin/dash',
          id: 'process:7002',
          pid: 7002,
          workingDirectory: '/root',
        },
      ],
      sockets: [socket([1], [])],
      systemdUnits: [],
      unknowns: [],
    });

    expect(result.services).toEqual([]);
  });

  it('does not merge identical process signatures across container boundaries', () => {
    const containers = ['a', 'b'].map((letter, index): ContainerRecord => ({
      environmentKeys: [],
      evidenceIds: ['evidence:docker'],
      id: `container:${letter.repeat(64)}`,
      image: 'nginx:1.27',
      labels: {},
      mounts: [],
      name: `proxy-${letter}`,
      networks: [],
      ports: [],
      processId: 6001 + index,
      runtime: 'docker',
      state: 'running',
    }));
    const processes = [6001, 6002].map((pid): ProcessRecord => ({
      ...process(pid),
      arguments: ['worker process'],
      command: 'nginx:',
      executablePath: '/usr/sbin/nginx',
      workingDirectory: '/',
    }));
    const result = normalizeAndMergeServices({
      artifacts: [],
      collectedAt: '2026-08-14T07:30:00.000Z',
      composeProjects: [],
      containers,
      evidence: evidenceFixtures(),
      opsenseVersion: '0.1.0',
      processes,
      sockets: [],
      systemdUnits: [],
      unknowns: [],
    });

    expect(result.services).toHaveLength(2);
    expect(result.services.map((item) => item.containerIds)).toEqual([
      [`container:${'a'.repeat(64)}`],
      [`container:${'b'.repeat(64)}`],
    ]);
  });

  it('separates conflicting fields from unknown fields', () => {
    const containerId = `container:${'b'.repeat(64)}`;
    const result = normalizeAndMergeServices({
      artifacts: [],
      collectedAt: '2026-08-14T07:30:00.000Z',
      composeProjects: [],
      containers: [
        {
          environmentKeys: [],
          evidenceIds: ['evidence:docker'],
          id: containerId,
          image: 'order-api:1.0',
          labels: {},
          mounts: [],
          name: 'order-api',
          networks: [],
          ports: [],
          processId: 2341,
          runtime: 'docker',
          state: 'exited',
        },
      ],
      evidence: evidenceFixtures(),
      opsenseVersion: '0.1.0',
      processes: [process(2341, `/docker/${'b'.repeat(12)}`)],
      sockets: [],
      systemdUnits: [systemdUnit()],
      unknowns: [],
    });

    expect(result.services).toHaveLength(1);
    expect(result.services[0]).toMatchObject({
      confidence: 'conflict',
      conflictFields: ['status'],
      status: 'running',
      unknownFields: expect.arrayContaining(['purpose']),
    });
  });

  it('keeps stable service IDs when source entity order changes', () => {
    const base = {
      artifacts: [artifact('/opt/order-api/config/app.yml', 'config', 'evidence:directory')],
      collectedAt: '2026-08-14T07:30:00.000Z',
      composeProjects: [],
      containers: [],
      evidence: evidenceFixtures(),
      opsenseVersion: '0.1.0',
      processes: [process(2341, '/system.slice/order-api.service'), process(5001)],
      sockets: [socket([2341], [])],
      systemdUnits: [systemdUnit()],
      unknowns: [],
    };
    const forward = normalizeAndMergeServices(base);
    const reversed = normalizeAndMergeServices({
      ...base,
      artifacts: [...base.artifacts].reverse(),
      evidence: [...base.evidence].reverse(),
      processes: [...base.processes].reverse(),
      sockets: [...base.sockets].reverse(),
      systemdUnits: [...base.systemdUnits].reverse(),
    });

    expect(reversed.services.map((item) => item.id)).toEqual(
      forward.services.map((item) => item.id),
    );
  });
});

function process(pid: number, cgroup?: string): ProcessRecord {
  return {
    arguments: ['server.js'],
    command: 'node',
    evidenceIds: ['evidence:process'],
    executablePath: '/usr/bin/node',
    id: `process:${pid}`,
    pid,
    startedAt: '2026-08-14T07:20:00.000Z',
    workingDirectory: '/opt/order-api',
    ...(cgroup === undefined ? {} : { cgroup }),
  };
}

function socket(processIds: number[], containerIds: string[]): SocketRecord {
  return {
    containerIds,
    evidenceIds: ['evidence:socket'],
    exposed: true,
    family: 'ipv4',
    id: 'socket:tcp-ipv4-0.0.0.0-8080',
    listening: true,
    localAddress: '0.0.0.0',
    localPort: 8080,
    processIds,
    processNames: ['node'],
    protocol: 'tcp',
  };
}

function systemdUnit(): SystemdUnitRecord {
  return {
    activeState: 'active',
    description: 'Order API',
    enabledState: 'enabled',
    environmentFiles: ['/opt/order-api/.env'],
    evidenceIds: ['evidence:systemd'],
    execReload: [],
    execStart: ['/usr/bin/node /opt/order-api/server.js --config /opt/order-api/config/app.yml'],
    fragmentPath: '/etc/systemd/system/order-api.service',
    id: 'systemd:order-api.service',
    mainPid: 2341,
    name: 'order-api.service',
    subState: 'running',
    workingDirectory: '/opt/order-api',
  };
}

function artifact(
  artifactPath: string,
  kind: ArtifactRecord['kind'],
  evidenceId: string,
): ArtifactRecord {
  return {
    confidence: 'confirmed',
    evidenceIds: [evidenceId],
    exists: true,
    fileType: kind === 'data' ? 'directory' : 'file',
    id: `artifact:${artifactPath.replace(/[^A-Za-z0-9]+/g, '_')}`,
    kind,
    path: artifactPath,
  };
}

function evidenceFixtures(): EvidenceRecord[] {
  return ['directory', 'process', 'socket', 'systemd', 'docker', 'compose'].map((name) => ({
    collectedAt: '2026-08-14T07:29:00.000Z',
    id: `evidence:${name}`,
    kind: 'command_output',
    opsenseVersion: '0.1.0',
    sensitivity: 'internal',
    source: name,
    status: 'success',
  }));
}
