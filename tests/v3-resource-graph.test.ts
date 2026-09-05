import { buildResourceGraph } from '@opsense/correlation';
import { buildLocalDeploymentInventory, selectDeploymentCandidates } from '@opsense/discovery';
import {
  DeploymentCandidateSetSchema,
  DeploymentInventorySchema,
  ResourceGraphSchema,
  assertSchema,
} from '@opsense/schema';
import type { ScanSnapshot } from '@opsense/schema';
import { describe, expect, it } from 'vitest';

describe('v3 resource graph and local inventory', () => {
  it('correlates resources, protects deployments, and aggregates routine objects', () => {
    const snapshot = graphFixture();
    const now = () => new Date('2026-09-05T01:00:00.000Z');
    const graph = buildResourceGraph(snapshot, { now });
    const candidateSet = selectDeploymentCandidates(graph, snapshot, { now });
    const inventory = buildLocalDeploymentInventory(snapshot, graph, candidateSet, { now });

    assertSchema(ResourceGraphSchema, graph);
    assertSchema(DeploymentCandidateSetSchema, candidateSet);
    assertSchema(DeploymentInventorySchema, inventory);
    expect(graph.edges.map((edge) => edge.kind)).toEqual(
      expect.arrayContaining([
        'unit_main_process',
        'process_socket',
        'process_container',
        'container_compose_service',
        'container_publishes_port',
        'container_mounts_path',
        'unit_references_path',
        'path_on_mount',
      ]),
    );
    expect(candidateSet.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          protectionSignals: expect.arrayContaining(['custom_service_path', 'exposed_socket']),
          suggestedName: 'order-api',
        }),
        expect.objectContaining({
          protectionSignals: expect.arrayContaining(['docker_deployment', 'compose_deployment']),
          suggestedName: 'shop',
        }),
      ]),
    );
    expect(
      candidateSet.candidates.find((candidate) => candidate.suggestedName === 'order-api')
        ?.sourceObjectIds,
    ).not.toContain('process:1');
    expect(candidateSet.filteredGroups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: 'inactive_unit', objectCount: 1 }),
      ]),
    );
    expect(inventory.semanticStatus).toBe('unverified');
    expect(inventory.services).toHaveLength(candidateSet.candidates.length);
  });
});

function graphFixture(): ScanSnapshot {
  return {
    artifacts: [],
    composeProjects: [
      {
        configFiles: ['/srv/shop/compose.yml'],
        evidenceIds: ['evidence:compose:shop'],
        id: 'compose:shop',
        name: 'shop',
        services: [{ containerIds: ['container:abcdef123456'], name: 'web' }],
        workingDirectory: '/srv/shop',
      },
    ],
    containers: [
      {
        environmentKeys: [],
        evidenceIds: ['evidence:container:web'],
        id: 'container:abcdef123456',
        image: 'nginx:1.27',
        labels: {},
        mounts: [
          {
            destination: '/usr/share/nginx/html',
            readOnly: false,
            source: '/data/shop',
            type: 'bind',
          },
        ],
        name: 'web',
        networks: [],
        ports: [{ containerPort: 443, hostAddress: '0.0.0.0', hostPort: 8443, protocol: 'tcp' }],
        processId: 200,
        runtime: 'docker',
        state: 'running',
      },
    ],
    evidence: [],
    findings: [],
    pathSeeds: [
      pathSeed(
        'path-seed:order-api',
        '/opt/order-api',
        'systemd:order-api.service',
        'systemd.working_directory',
      ),
      pathSeed('path-seed:shop-data', '/data/shop', 'container:abcdef123456', 'docker.mount.bind'),
    ],
    processes: [
      {
        arguments: [],
        command: '/sbin/init',
        evidenceIds: ['evidence:process:1'],
        id: 'process:1',
        parentPid: 0,
        pid: 1,
      },
      {
        arguments: [],
        command: '/opt/order-api/server',
        evidenceIds: ['evidence:process:100'],
        executablePath: '/opt/order-api/server',
        id: 'process:100',
        parentPid: 1,
        pid: 100,
        workingDirectory: '/opt/order-api',
      },
      {
        arguments: [],
        cgroup: '/docker/abcdef123456',
        command: 'nginx',
        containerId: 'abcdef123456',
        evidenceIds: ['evidence:process:200'],
        id: 'process:200',
        parentPid: 1,
        pid: 200,
      },
    ],
    services: [],
    session: {
      configSummary: {},
      id: 'scan-v3-graph',
      opsenseVersion: '3.0.0',
      permissionLevel: 'unprivileged',
      rulesVersion: '3.0.0',
      schemaVersion: '1.0.0',
      startedAt: '2026-09-05T00:00:00.000Z',
      state: 'completed',
      target: { host: 'server.example.com', port: 22, user: 'ops' },
    },
    sockets: [
      socket('socket:tcp:8080', 8080, [100], []),
      socket('socket:tcp:8443', 8443, [], ['container:abcdef123456']),
    ],
    storage: {
      collectedAt: '2026-09-05T00:00:00.000Z',
      disks: [],
      fstabEntries: [],
      layers: [],
      mounts: [
        {
          evidenceIds: ['evidence:mount:data'],
          fileSystemType: 'ext4',
          id: 'mount:data',
          network: false,
          options: ['rw'],
          pseudo: false,
          readOnly: false,
          source: '/dev/sdb1',
          target: '/data',
          temporary: false,
        },
      ],
      swapDevices: [],
    },
    systemdUnits: [
      unit('order-api.service', 'active', 100, '/etc/systemd/system/order-api.service'),
      unit('cron.service', 'inactive'),
    ],
    unknowns: [],
  };
}

function unit(name: string, activeState: string, mainPid?: number, fragmentPath?: string) {
  return {
    activeState,
    environmentFiles: [],
    evidenceIds: [`evidence:unit:${name}`],
    execReload: [],
    execStart: [],
    ...(fragmentPath === undefined ? {} : { fragmentPath }),
    id: `systemd:${name}`,
    ...(mainPid === undefined ? {} : { mainPid }),
    name,
  };
}

function socket(id: string, localPort: number, processIds: number[], containerIds: string[]) {
  return {
    containerIds,
    evidenceIds: [`evidence:${id}`],
    exposed: true,
    family: 'ipv4' as const,
    id,
    listening: true,
    localAddress: '0.0.0.0',
    localPort,
    processIds,
    processNames: [],
    protocol: 'tcp' as const,
  };
}

function pathSeed(id: string, seedPath: string, sourceId: string, sourceType: string) {
  return {
    confidence: 'confirmed' as const,
    id,
    path: seedPath,
    sources: [{ evidenceIds: [`evidence:${id}`], sourceId, sourceType }],
  };
}
