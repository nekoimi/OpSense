import { buildInventoryProjection } from '@opsense/projection';
import {
  buildServiceWikiEntry,
  buildServiceWikiProjection,
  buildWikiEntryDraft,
} from '@opsense/wiki';
import {
  ServiceWikiEntrySchema,
  ServiceWikiProjectionSchema,
  WikiEntryDraftSchema,
  assertSchema,
} from '@opsense/schema';
import type { ScanSnapshot, ServiceRecord } from '@opsense/schema';
import { describe, expect, it } from 'vitest';

import { readFixture } from './support/read-fixture.js';

describe('M13 service Wiki entries', () => {
  it('validates the draft and final entry fixtures', async () => {
    assertSchema(
      WikiEntryDraftSchema,
      JSON.parse(await readFixture('schema/wiki-entry-draft.json')),
    );
    assertSchema(
      ServiceWikiEntrySchema,
      JSON.parse(await readFixture('schema/service-wiki-entry.json')),
    );
  });

  it('builds an evidence-gated entry without guessing lifecycle commands', async () => {
    const projection = buildInventoryProjection(await wikiSnapshot());
    projection.serviceAssessments = [
      {
        serviceId: 'service:order-api',
        role: 'application',
        reportPlacement: 'primary',
        purpose: '处理订单请求。',
        reason: '自定义 systemd unit、端口和部署目录均有证据。',
        confidence: 'inferred',
        evidenceIds: ['evidence:service', 'evidence:unit', 'evidence:socket'],
      },
    ];
    const service = projection.services[0] as ServiceRecord;
    const draft = buildWikiEntryDraft(service, projection);
    const entry = buildServiceWikiEntry(service, projection, '2026-08-14T06:00:00.000Z');

    expect(draft.evidence.coverage).toBe(1);
    expect(draft.lifecycle.start?.command).toBe('/opt/order-api/bin/start');
    expect(draft.lifecycle.stop).toBeUndefined();
    expect(draft.lifecycle.restart).toBeUndefined();
    expect(entry.anchor).toBe('service-service-order-api');
    assertSchema(ServiceWikiEntrySchema, entry);
  });

  it('puts ordinary systemd services in summary and exposes low coverage for review', async () => {
    const projection = buildInventoryProjection(await wikiSnapshot());
    projection.serviceAssessments = [
      {
        serviceId: 'service:order-api',
        role: 'system',
        reportPlacement: 'system_summary',
        reason: '普通系统服务，仅进入摘要。',
        confidence: 'unknown',
        evidenceIds: ['evidence:service'],
      },
    ];
    const sparseService = { ...(projection.services[0] as ServiceRecord) };
    sparseService.configFiles = [];
    sparseService.dataDirectories = [];
    sparseService.deployDirectories = [];
    sparseService.logLocations = [];
    delete sparseService.purpose;
    delete sparseService.purposeConfidence;
    delete sparseService.startCommand;
    projection.services[0] = sparseService;
    const wiki = buildServiceWikiProjection(projection, { minimumCoverage: 0.8 });

    expect(wiki.summaryServiceIds).toEqual(['service:order-api']);
    expect(wiki.reviewServiceIds).toEqual([]);
    expect(wiki.entries[0]?.evidence.coverage).toBeLessThan(0.8);
    expect(wiki.entries[0]?.unknowns.length).toBeGreaterThan(0);
    assertSchema(ServiceWikiProjectionSchema, wiki);
  });

  it('retains multiple evidence sources for a conflicting field', async () => {
    const projection = buildInventoryProjection(await wikiSnapshot());
    const service = projection.services[0] as ServiceRecord;
    service.conflictFields = ['port'];
    const wiki = buildServiceWikiProjection(projection);

    expect(wiki.entries[0]?.conflicts).toEqual([
      expect.objectContaining({
        field: 'port',
        evidenceIds: ['evidence:service', 'evidence:service-alt'],
        observedValues: ['8080', '9090'],
      }),
    ]);
  });
});

async function wikiSnapshot(): Promise<ScanSnapshot> {
  const snapshot = JSON.parse(await readFixture('schema/minimal-snapshot.json')) as ScanSnapshot;
  snapshot.evidence = [
    evidence('evidence:service', 'service.normalization', 'port', 8080),
    evidence('evidence:service-alt', 'service.systemd', 'port', 9090),
    evidence('evidence:unit', 'systemd.details'),
    evidence('evidence:socket', 'network.sockets'),
  ];
  snapshot.systemdUnits = [
    {
      activeState: 'active',
      enabledState: 'enabled',
      evidenceIds: ['evidence:unit'],
      environmentFiles: [],
      execReload: [],
      execStart: ['/opt/order-api/bin/start'],
      fragmentPath: '/etc/systemd/system/order-api.service',
      id: 'systemd:order-api.service',
      name: 'order-api.service',
      subState: 'running',
    },
  ];
  snapshot.sockets = [
    {
      containerIds: [],
      evidenceIds: ['evidence:socket'],
      exposed: true,
      family: 'ipv4',
      id: 'socket:8080',
      listening: true,
      localAddress: '0.0.0.0',
      localPort: 8080,
      processIds: [],
      processNames: ['order-api'],
      protocol: 'tcp',
    },
  ];
  snapshot.services = [
    {
      composeProjectIds: [],
      confidence: 'confirmed',
      configFiles: ['/opt/order-api/config.yml'],
      containerIds: [],
      dataDirectories: ['/var/lib/order-api'],
      deployDirectories: ['/opt/order-api'],
      deploymentType: 'systemd',
      enabledAtBoot: true,
      environmentFiles: [],
      evidenceIds: ['evidence:service', 'evidence:service-alt'],
      id: 'service:order-api',
      logLocations: ['/var/log/order-api'],
      name: 'order-api',
      processIds: [],
      socketIds: ['socket:8080'],
      status: 'running',
      systemdUnitIds: ['systemd:order-api.service'],
      unknownFields: [],
    },
  ];
  return snapshot;
}

function evidence(id: string, source: string, field?: string, value?: unknown) {
  return {
    collectedAt: '2026-08-14T03:00:01.000Z',
    id,
    kind: 'derived' as const,
    opsenseVersion: '0.1.0',
    sensitivity: 'internal' as const,
    source,
    status: 'success' as const,
    ...(field === undefined ? {} : { field }),
    ...(value === undefined ? {} : { value }),
  };
}
