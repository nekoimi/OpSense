import { buildInventoryProjection } from '@opsense/projection';
import { assertReportQuality, createReportModel, evaluateReportQuality } from '@opsense/report';
import { buildServiceWikiProjection } from '@opsense/wiki';
import type { ScanSnapshot } from '@opsense/schema';
import { describe, expect, it } from 'vitest';

import { readFixture } from './support/read-fixture.js';

describe('M17 report quality gate', () => {
  it('passes a clean projection and exposes a stable audit result', async () => {
    const snapshot = await fixtureSnapshot();
    const projection = buildInventoryProjection(snapshot);
    const model = createReportModel(projection);
    const wiki = buildServiceWikiProjection(projection);
    const result = evaluateReportQuality(projection, model, wiki, {
      now: () => new Date('2026-08-15T01:00:00.000Z'),
      profile: 'wiki',
    });

    expect(result.passed).toBe(true);
    expect(result.checkedAt).toBe('2026-08-15T01:00:00.000Z');
    expect(() => assertReportQuality(result)).not.toThrow();
  });

  it('rejects container network, runtime mount, and evidence-free lifecycle noise', async () => {
    const snapshot = await fixtureSnapshot();
    const projection = buildInventoryProjection(snapshot);
    const service = projection.services[0];
    if (service === undefined) throw new Error('fixture service missing');
    service.startCommand = '/opt/app/start.sh';
    service.evidenceIds = [];
    const model = createReportModel(projection);
    model.network.interfaces.push({
      addresses: [],
      evidenceIds: ['evidence:noise'],
      name: 'docker0',
    });
    model.mounts.push({
      availableBytes: 1,
      evidenceIds: ['evidence:noise'],
      fileSystemType: 'overlay',
      network: false,
      readOnly: false,
      source: '/var/lib/docker/overlay2/layer',
      target: '/var/lib/docker/overlay2/layer/merged',
      totalBytes: 2,
      usedBytes: 1,
    });
    const wiki = buildServiceWikiProjection(projection);
    const result = evaluateReportQuality(projection, model, wiki);

    expect(result.issues.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        'CONTAINER_NETWORK_NOISE',
        'RUNTIME_MOUNT_NOISE',
        'LIFECYCLE_EVIDENCE_MISSING',
      ]),
    );
    expect(() => assertReportQuality(result)).toThrow('报告质量门禁失败');
  });
});

async function fixtureSnapshot(): Promise<ScanSnapshot> {
  const snapshot = JSON.parse(await readFixture('schema/minimal-snapshot.json')) as ScanSnapshot;
  snapshot.evidence = [
    {
      collectedAt: '2026-08-15T00:00:00.000Z',
      id: 'evidence:service',
      kind: 'derived',
      opsenseVersion: '0.1.0',
      sensitivity: 'internal',
      source: 'service.fixture',
      status: 'success',
    },
  ];
  snapshot.services = [
    {
      composeProjectIds: [],
      confidence: 'confirmed',
      configFiles: ['/opt/app/config.yaml'],
      containerIds: [],
      dataDirectories: ['/data/app'],
      deployDirectories: ['/opt/app'],
      deploymentType: 'systemd',
      environmentFiles: [],
      evidenceIds: ['evidence:service'],
      id: 'service:app',
      logLocations: ['/var/log/app'],
      name: 'app',
      processIds: [],
      socketIds: [],
      status: 'running',
      systemdUnitIds: [],
      unknownFields: [],
    },
  ];
  snapshot.services[0]!.purpose = '业务应用';
  snapshot.services[0]!.purposeConfidence = 'confirmed';
  snapshot.evidence[0]!.field = 'service';
  return snapshot;
}
