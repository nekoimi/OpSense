import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  createReportFileNames,
  createReportModel,
  formatDateTime,
  generateReportArtifacts,
  sanitizeReportIdentifier,
  validateDocxBuffer,
} from '@opsense/report';
import { buildInventoryProjection } from '@opsense/projection';
import { REDACTED_VALUE, scanForSecrets } from '@opsense/redaction';
import { ReportModelSchema, validateSchema } from '@opsense/schema';
import type { ScanSnapshot } from '@opsense/schema';
import { afterEach, describe, expect, it } from 'vitest';

import { readFixture } from './support/read-fixture.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('M8 report generation', () => {
  it('formats report timestamps consistently with an explicit timezone offset', () => {
    expect(formatDateTime('2026-08-14T08:36:12.000Z', 'Asia/Shanghai')).toBe(
      '2026-08-14 16:36:12 GMT+8',
    );
  });

  it('creates Chinese cross-platform file names with a common local timestamp', async () => {
    const model = createReportModel(
      buildInventoryProjection(await reportSnapshot()),
      () => new Date('2026-08-14T09:00:00Z'),
    );

    expect(createReportFileNames(model, { timeZone: 'Asia/Shanghai' })).toEqual({
      docx: '服务器巡检报告-192.168.168.12-2026-08-14_16-36-12.docx',
      html: 'index.html',
    });
    expect(sanitizeReportIdentifier('2001:db8::12')).toBe('2001_db8_12');
    expect(sanitizeReportIdentifier('<>:"/\\|?*')).toBe('未知服务器');
    expect(sanitizeReportIdentifier('CON')).toBe('服务器_CON');
  });

  it('builds a schema-valid format-independent report model', async () => {
    const model = createReportModel(
      buildInventoryProjection(await reportSnapshot()),
      () => new Date('2026-08-14T09:00:00Z'),
    );
    const validation = validateSchema(ReportModelSchema, model);

    expect(validation.valid, JSON.stringify(validation.errors)).toBe(true);
    expect(model.summary).toMatchObject({
      diskCount: 1,
      interfaceCount: 1,
      primaryServiceCount: 1,
      runningServiceCount: 1,
      serviceCount: 1,
      systemServiceCount: 0,
    });
    expect(model.services[0]?.ports).toContain('TCP 0.0.0.0:8080 (external)');
  });

  it('writes redacted Markdown, offline HTML, and a valid DOCX from one model', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'opsense-report-test-'));
    temporaryDirectories.push(root);
    const snapshot = await reportSnapshot();
    const artifacts = await generateReportArtifacts(buildInventoryProjection(snapshot), {
      now: () => new Date('2026-08-14T09:00:00Z'),
      outputDirectory: root,
      sourceSnapshot: snapshot,
      timeZone: 'Asia/Shanghai',
    });

    expect(path.basename(artifacts.docxFile ?? '')).toBe(
      '服务器巡检报告-192.168.168.12-2026-08-14_16-36-12.docx',
    );
    expect(path.basename(artifacts.htmlFile ?? '')).toBe('index.html');
    expect(artifacts.markdownFiles.map((file) => path.relative(root, file))).toEqual(
      expect.arrayContaining([
        'README.md',
        'system.md',
        'storage.md',
        'network.md',
        'services.md',
        'findings.md',
        'unknowns.md',
        'evidence.md',
      ]),
    );

    const html = await readFile(artifacts.htmlFile ?? '', 'utf8');
    const model = JSON.parse(await readFile(artifacts.modelFile, 'utf8')) as unknown;
    const persistedSnapshot = JSON.parse(
      await readFile(artifacts.snapshotFile ?? '', 'utf8'),
    ) as unknown;
    const persisted = await Promise.all(
      (await listFiles(root)).map((file) =>
        path.extname(file) === '.docx' ? Promise.resolve('') : readFile(file, 'utf8'),
      ),
    );
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('部署服务');
    expect(html).toContain('class="watermark-layer"');
    expect(html).toContain('OpSense 版权所有');
    expect(html).toContain('© 2026 OpSense. 保留所有权利。');
    expect(html).toContain('&lt;script&gt;alert(&quot;report&quot;)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert("report")</script>');
    expect(persisted.join('\n')).not.toContain('OPSENSE_REPORT_SECRET');
    expect(persisted.join('\n')).not.toContain('<script>alert("report")</script>');
    expect(JSON.stringify(model)).toContain(REDACTED_VALUE);
    expect(scanForSecrets(model)).toEqual([]);
    expect(scanForSecrets(persistedSnapshot)).toEqual([]);

    const docxFile = artifacts.docxFile ?? '';
    expect((await stat(docxFile)).size).toBeGreaterThan(10_000);
    const validation = await validateDocxBuffer(await readFile(docxFile));
    expect(validation.paragraphCount).toBeGreaterThan(20);
    expect(validation.tableCount).toBeGreaterThan(5);
    expect(validation.hasUpdateFields).toBe(true);
    expect(validation.hasWatermark).toBe(true);
    expect(validation.hasCopyrightNotice).toBe(true);
    expect(validation.text).toContain('服务器巡检报告');
    expect(validation.text).toContain('系统环境');
    expect(validation.text).toContain('证据附录');
  });
});

async function reportSnapshot(): Promise<ScanSnapshot> {
  const snapshot = JSON.parse(await readFixture('schema/minimal-snapshot.json')) as ScanSnapshot;
  snapshot.session.target.host = '192.168.168.12';
  snapshot.session.finishedAt = '2026-08-14T08:36:12.000Z';
  snapshot.host = {
    architecture: 'x86_64',
    capabilities: [],
    collectedAt: '2026-08-14T08:36:12.000Z',
    cpu: { architecture: 'x86_64', logicalCores: 8, model: 'Example CPU', physicalCores: 4 },
    hostname: 'prod-web-01',
    kernelVersion: '6.8.0',
    memory: {
      availableBytes: 8_589_934_592,
      swapFreeBytes: 2_147_483_648,
      swapTotalBytes: 2_147_483_648,
      totalBytes: 17_179_869_184,
    },
    operatingSystem: { id: 'ubuntu', name: 'Ubuntu', prettyName: 'Ubuntu 24.04 LTS' },
    packageManager: 'apt',
    timezone: 'Asia/Shanghai',
    uptimeSeconds: 172_800,
    virtualization: 'kvm',
  };
  snapshot.storage = {
    collectedAt: '2026-08-14T08:36:12.000Z',
    disks: [
      {
        evidenceIds: ['evidence:storage'],
        id: 'disk:sda',
        model: 'Example Disk',
        name: 'sda',
        partitions: [
          {
            evidenceIds: ['evidence:storage'],
            fileSystemType: 'ext4',
            id: 'partition:sda1',
            mountPoints: ['/'],
            name: 'sda1',
            parentDiskId: 'disk:sda',
            path: '/dev/sda1',
            sizeBytes: 107_374_182_400,
          },
        ],
        path: '/dev/sda',
        sizeBytes: 107_374_182_400,
        type: 'disk',
      },
    ],
    fstabEntries: [],
    layers: [],
    mounts: [
      {
        availableBytes: 64_424_509_440,
        evidenceIds: ['evidence:storage'],
        fileSystemType: 'ext4',
        id: 'mount:root',
        network: false,
        options: ['rw'],
        pseudo: false,
        readOnly: false,
        source: '/dev/sda1',
        target: '/',
        temporary: false,
        totalBytes: 107_374_182_400,
        usedBytes: 42_949_672_960,
      },
    ],
    swapDevices: [],
  };
  snapshot.network = {
    collectedAt: '2026-08-14T08:36:12.000Z',
    dns: { searchDomains: ['internal.example'], servers: ['192.168.168.1'] },
    firewall: { active: true, backend: 'iptables', evidenceIds: ['evidence:network'], summary: [] },
    interfaces: [
      {
        addresses: [
          {
            address: '192.168.168.12',
            classification: 'private',
            family: 'ipv4',
            prefixLength: 24,
          },
        ],
        evidenceIds: ['evidence:network'],
        id: 'interface:eth0',
        macAddress: '00:11:22:33:44:55',
        mtu: 1500,
        name: 'eth0',
        state: 'UP',
      },
    ],
    routes: [
      {
        destination: 'default',
        device: 'eth0',
        gateway: '192.168.168.1',
        isDefault: true,
      },
    ],
  };
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
      processIds: [100],
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
      displayName: '订单服务 <script>alert("report")</script>',
      enabledAtBoot: true,
      environmentFiles: ['/opt/order-api/.env'],
      evidenceIds: ['evidence:service'],
      id: 'service:order-api',
      logLocations: ['/var/log/order-api'],
      name: 'order-api',
      processIds: [100],
      purpose: '处理订单请求。',
      socketIds: ['socket:8080'],
      startCommand: 'order-api --token OPSENSE_REPORT_SECRET',
      status: 'running',
      systemdUnitIds: ['systemd:order-api.service'],
      unknownFields: [],
    },
  ];
  snapshot.findings = [
    {
      category: 'storage',
      confidence: 'confirmed',
      description: '根分区使用率需要持续关注。',
      evidenceIds: ['evidence:storage'],
      id: 'finding:storage-root',
      severity: 'medium',
      title: '根分区容量风险',
    },
  ];
  snapshot.unknowns = ['未获取应用业务负责人。'];
  snapshot.evidence = [
    {
      collectedAt: '2026-08-14T08:36:12.000Z',
      id: 'evidence:storage',
      kind: 'command_output',
      opsenseVersion: '0.1.0',
      sensitivity: 'internal',
      source: 'storage.df-bytes',
      status: 'success',
    },
    {
      collectedAt: '2026-08-14T08:36:12.000Z',
      id: 'evidence:network',
      kind: 'command_output',
      opsenseVersion: '0.1.0',
      sensitivity: 'sensitive',
      source: 'network.addresses',
      status: 'success',
    },
    {
      collectedAt: '2026-08-14T08:36:12.000Z',
      id: 'evidence:socket',
      kind: 'runtime_state',
      opsenseVersion: '0.1.0',
      sensitivity: 'internal',
      source: 'network.sockets',
      status: 'success',
    },
    {
      collectedAt: '2026-08-14T08:36:12.000Z',
      id: 'evidence:service',
      kind: 'derived',
      opsenseVersion: '0.1.0',
      sensitivity: 'sensitive',
      source: 'service.normalization',
      status: 'success',
    },
  ];
  return snapshot;
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
}
