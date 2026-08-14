import { buildInventoryProjection } from '@opsense/projection';
import { createReportModel } from '@opsense/report';
import type { MountRecord, NetworkInterface, ScanSnapshot, ServiceRecord } from '@opsense/schema';
import { describe, expect, it } from 'vitest';

import { readFixture } from './support/read-fixture.js';

describe('M12 inventory projection', () => {
  it('filters container runtime noise without mutating the source snapshot', async () => {
    const snapshot = await projectionSnapshot();
    const projection = buildInventoryProjection(snapshot, {
      now: () => new Date('2026-08-14T04:00:00.000Z'),
    });

    expect(snapshot.network?.interfaces).toHaveLength(4);
    expect(snapshot.storage?.mounts).toHaveLength(5);
    expect(projection.network?.interfaces.map((item) => item.name)).toEqual(['eth0']);
    expect(projection.storage?.mounts.map((item) => item.target)).toEqual(['/data']);
    expect(projection.filteredCounts).toEqual({
      'network.container_network': 3,
      'storage.runtime_mount': 4,
    });
    expect(
      projection.visibilityDecisions.find((item) => item.objectId === 'mount:business'),
    ).toMatchObject({
      placement: 'supporting',
      relatedServiceIds: ['service:minio'],
      resourceClass: 'service_mount',
    });
  });

  it('keeps filtered network and mounts out of the report model', async () => {
    const projection = buildInventoryProjection(await projectionSnapshot());
    const model = createReportModel(projection);

    expect(model.network.interfaces.map((item) => item.name)).toEqual(['eth0']);
    expect(model.mounts.map((item) => item.target)).toEqual(['/data']);
    expect(JSON.stringify(model)).not.toContain('docker0');
    expect(JSON.stringify(model)).not.toContain('/var/lib/docker/overlay2');
  });
});

async function projectionSnapshot(): Promise<ScanSnapshot> {
  const snapshot = JSON.parse(await readFixture('schema/minimal-snapshot.json')) as ScanSnapshot;
  snapshot.network = {
    collectedAt: '2026-08-14T03:00:01.000Z',
    dns: { searchDomains: [], servers: [] },
    firewall: { backend: 'unknown', evidenceIds: [], summary: [] },
    interfaces: [
      networkInterface('interface:eth0', 'eth0'),
      networkInterface('interface:docker0', 'docker0'),
      networkInterface('interface:bridge', 'br-a1b2c3d4e5f6'),
      networkInterface('interface:veth', 'veth1234'),
    ],
    routes: [],
  };
  snapshot.storage = {
    collectedAt: '2026-08-14T03:00:01.000Z',
    disks: [],
    fstabEntries: [],
    layers: [],
    mounts: [
      mount('mount:business', '/dev/sdb1', '/data', 'xfs'),
      mount(
        'mount:overlay',
        '/var/lib/docker/overlay2/layer/merged',
        '/var/lib/docker/overlay2/layer/merged',
        'overlay',
      ),
      mount('mount:rootfs', 'rootfs', '/run/container/rootfs', 'rootfs', true),
      mount('mount:shm', 'shm', '/dev/shm', 'tmpfs', false, true),
      mount('mount:proc', 'proc', '/proc', 'proc', true),
    ],
    swapDevices: [],
  };
  snapshot.services = [service()];
  return snapshot;
}

function networkInterface(id: string, name: string): NetworkInterface {
  return {
    addresses: [],
    evidenceIds: [],
    id,
    name,
  };
}

function mount(
  id: string,
  source: string,
  target: string,
  fileSystemType: string,
  pseudo = false,
  temporary = false,
): MountRecord {
  return {
    evidenceIds: [],
    fileSystemType,
    id,
    network: false,
    options: ['rw'],
    pseudo,
    readOnly: false,
    source,
    target,
    temporary,
  };
}

function service(): ServiceRecord {
  return {
    composeProjectIds: [],
    confidence: 'confirmed',
    configFiles: ['/etc/minio/config.env'],
    containerIds: [],
    dataDirectories: ['/data/minio'],
    deployDirectories: ['/opt/minio'],
    deploymentType: 'systemd',
    environmentFiles: [],
    evidenceIds: [],
    id: 'service:minio',
    logLocations: ['/var/log/minio'],
    name: 'minio',
    processIds: [],
    socketIds: [],
    status: 'running',
    systemdUnitIds: [],
    unknownFields: [],
  };
}
