import { readFile } from 'node:fs/promises';

import {
  BaselineRelevanceClassifier,
  ProbePlanValidator,
  buildAiWorkspace,
  governAiPlan,
} from '@opsense/ai-provider';
import type { AiPlan, ProbeRequest, ScanSnapshot, ServiceRecord } from '@opsense/schema';
import { describe, expect, it } from 'vitest';

import { createTestDirectory } from './support/temporary-directory.js';
import { readFixture } from './support/read-fixture.js';

describe('M9 baseline relevance and probe governance', () => {
  it('suppresses packaged system units while retaining deployed and risky services', async () => {
    const snapshot = await baseSnapshot();
    snapshot.services = [
      service('cron', { systemdUnitIds: ['systemd:cron.service'] }),
      service('order-api', {
        deployDirectories: ['/opt/order-api'],
        systemdUnitIds: ['systemd:order-api.service'],
      }),
      service('failed-daemon', {
        status: 'failed',
        systemdUnitIds: ['systemd:failed-daemon.service'],
      }),
      service('minio', { deploymentType: 'docker', containerIds: ['container:minio'] }),
    ];
    snapshot.systemdUnits = [
      unit('cron.service', '/lib/systemd/system/cron.service', ['/usr/sbin/cron']),
      unit('order-api.service', '/etc/systemd/system/order-api.service', [
        '/opt/order-api/bin/server',
      ]),
      unit('failed-daemon.service', '/lib/systemd/system/failed-daemon.service', [
        '/usr/sbin/failed-daemon',
      ]),
    ];
    snapshot.containers = [
      {
        environmentKeys: [],
        evidenceIds: ['evidence:test'],
        id: 'container:minio',
        image: 'minio/minio:latest',
        labels: {},
        mounts: [],
        name: 'minio',
        networks: [],
        ports: [],
        runtime: 'docker',
        state: 'running',
      },
    ];

    const plan = new BaselineRelevanceClassifier().classify(snapshot);
    const byName = new Map(plan.serviceAssessments.map((item) => [item.serviceId, item]));

    expect(byName.get('service:cron')?.reportPlacement).toBe('system_summary');
    expect(byName.get('service:order-api')?.reportPlacement).toBe('primary');
    expect(byName.get('service:failed-daemon')?.reportPlacement).toBe('needs_review');
    expect(byName.get('service:minio')?.reportPlacement).toBe('supporting');
  });

  it('prevents AI output from hiding failed, externally listening, custom-path and container services', async () => {
    const snapshot = await baseSnapshot();
    snapshot.services = [
      service('external-api', { socketIds: ['socket:8443'] }),
      service('custom-api', { deployDirectories: ['/srv/custom-api'] }),
      service('container-api', { deploymentType: 'docker', containerIds: ['container:api'] }),
    ];
    snapshot.sockets = [
      {
        containerIds: [],
        evidenceIds: ['evidence:test'],
        exposed: true,
        family: 'ipv4',
        id: 'socket:8443',
        listening: true,
        localAddress: '0.0.0.0',
        localPort: 8443,
        processIds: [],
        processNames: [],
        protocol: 'tcp',
      },
    ];
    const baseline = new BaselineRelevanceClassifier().classify(snapshot);
    const candidate: AiPlan = {
      generatedAt: new Date().toISOString(),
      pathAssessments: [],
      probeRequests: [],
      provider: 'codex',
      serviceAssessments: snapshot.services.map((item) => ({
        confidence: 'inferred',
        evidenceIds: ['evidence:test'],
        reason: 'AI proposed system classification.',
        reportPlacement: 'system_summary',
        role: 'system',
        serviceId: item.id,
      })),
    };

    const governed = governAiPlan(snapshot, candidate, baseline);
    expect(governed.serviceAssessments.map((item) => item.reportPlacement)).toEqual([
      'needs_review',
      'needs_review',
      'needs_review',
    ]);
  });

  it('accepts evidence-derived Doris searches and rejects root scans or invented terms', async () => {
    const snapshot = await baseSnapshot();
    snapshot.services = [service('doris')];
    const valid = pathSearch('probe:doris', '/opt', 'doris');
    const rootScan = pathSearch('probe:root', '/', 'doris');
    const invented = pathSearch('probe:invented', '/opt', 'secret-product');

    const result = new ProbePlanValidator().validate(snapshot, [valid, rootScan, invented]);

    expect(result.accepted.map((item) => item.id)).toEqual(['probe:doris']);
    expect(result.audit.records.map((item) => item.status)).toEqual([
      'accepted',
      'rejected',
      'rejected',
    ]);
  });

  it('writes the complete redacted read-only AI input contract', async () => {
    const snapshot = await baseSnapshot();
    snapshot.services = [
      service('order-api', { startCommand: 'order-api --token M9_TEST_SECRET' }),
    ];
    const temporary = await createTestDirectory();

    const result = await buildAiWorkspace(snapshot, temporary);
    const names = result.files.map((file) => file.split(/[\\/]/).at(-1));
    const contents = await Promise.all(result.files.map((file) => readFile(file, 'utf8')));

    expect(names).toEqual(
      expect.arrayContaining([
        'context.md',
        'host.json',
        'storage.json',
        'network.json',
        'service-candidates.json',
        'path-candidates.json',
        'findings.json',
        'evidence-index.json',
        'redaction-report.json',
        'classification-schema.json',
        'probe-plan-schema.json',
        'analysis-schema.json',
      ]),
    );
    expect(contents.join('\n')).not.toContain('M9_TEST_SECRET');
  });
});

async function baseSnapshot(): Promise<ScanSnapshot> {
  const snapshot = JSON.parse(await readFixture('schema/minimal-snapshot.json')) as ScanSnapshot;
  snapshot.evidence = [
    {
      collectedAt: new Date().toISOString(),
      id: 'evidence:test',
      kind: 'derived',
      opsenseVersion: '0.1.0',
      sensitivity: 'internal',
      source: 'test',
      status: 'success',
    },
  ];
  snapshot.pathSeeds = [
    {
      confidence: 'inferred',
      id: 'path-seed:opt',
      path: '/opt',
      sources: [{ evidenceIds: ['evidence:test'], sourceId: 'test', sourceType: 'test' }],
    },
  ];
  return snapshot;
}

function service(name: string, overrides: Partial<ServiceRecord> = {}): ServiceRecord {
  return {
    composeProjectIds: [],
    confidence: 'inferred',
    configFiles: [],
    containerIds: [],
    dataDirectories: [],
    deployDirectories: [],
    deploymentType: 'systemd',
    environmentFiles: [],
    evidenceIds: ['evidence:test'],
    id: `service:${name}`,
    logLocations: [],
    name,
    processIds: [],
    socketIds: [],
    status: 'running',
    systemdUnitIds: [],
    unknownFields: [],
    ...overrides,
  };
}

function unit(name: string, fragmentPath: string, execStart: string[]) {
  return {
    activeState: 'active',
    environmentFiles: [],
    evidenceIds: ['evidence:test'],
    execReload: [],
    execStart,
    fragmentPath,
    id: `systemd:${name}`,
    name,
    subState: 'running',
  };
}

function pathSearch(id: string, searchRoot: string, searchTerm: string): ProbeRequest {
  return {
    evidenceIds: ['evidence:test'],
    expectedFields: ['deployDirectories'],
    id,
    kind: 'path_search',
    maxBytes: 100_000,
    maxDepth: 3,
    maxMatches: 20,
    reason: 'Locate evidence-derived deployment path.',
    searchRoot,
    searchTerm,
    targetServiceId: 'service:doris',
    timeoutMs: 5000,
  };
}
