import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  REDACTED_VALUE,
  REDACTION_RULES_VERSION,
  classifySensitivity,
  redactForAiInput,
  redactForAudit,
  redactForReport,
  redactPayload,
  redactSnapshot,
  scanForSecrets,
} from '@opsense/redaction';
import { RedactionReportSchema, ScanSnapshotSchema, validateSchema } from '@opsense/schema';
import type { ScanSnapshot } from '@opsense/schema';
import { appendJsonLine, ensureRunWorkspace, writeJsonAtomic } from '@opsense/workspace';
import { afterEach, describe, expect, it } from 'vitest';

import { readFixture } from './support/read-fixture.js';

const temporaryDirectories: string[] = [];
const SECRET_MARKERS = [
  'OPSENSE_TEST_PASSWORD_VALUE',
  'OPSENSE_TEST_API_TOKEN_VALUE',
  'OPSENSE_TEST_PRIVATE_KEY_BODY',
  'OPSENSE_TEST_DB_PASSWORD',
  'OPSENSE_TEST_DB_TOKEN',
  'OPSENSE_TEST_SIGNATURE',
  'OPSENSE_TEST_URL_TOKEN',
  'OPSENSE_TEST_COMMAND_PASSWORD',
  'OPSENSE_TEST_COMMAND_TOKEN',
  'OPSENSE_TEST_ENV_SECRET',
  'OPSENSE_TEST_ARGUMENT_TOKEN',
  'OPSENSE_TEST_DOCKER_TOKEN',
  'OPSENSE_TEST_LABEL_PASSWORD',
  'OPSENSE_TEST_URL_PASSWORD',
  'OPSENSE_TEST_LABEL_SIGNATURE',
  'OPSENSE_TEST_ENV_FILE_PASSWORD',
  'OPSENSE_TEST_ENV_FILE_TOKEN',
] as const;

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('M7 redaction and security checks', () => {
  it('classifies public, internal, sensitive, and secret values', () => {
    expect(classifySensitivity('version', '24.04')).toBe('public');
    expect(classifySensitivity('serviceName', 'order-api')).toBe('internal');
    expect(classifySensitivity('userName', 'deploy')).toBe('sensitive');
    expect(classifySensitivity('workingDirectory', '/opt/order-api')).toBe('sensitive');
    expect(classifySensitivity('password', 'not-safe')).toBe('secret');
  });

  it('removes secrets while preserving key-only environment metadata', async () => {
    const fixture = JSON.parse(await readFixture('security/sensitive-payload.json')) as Record<
      string,
      unknown
    >;
    const result = redactPayload(fixture, {
      mode: 'persistence',
      now: () => new Date('2026-08-14T08:00:00.000Z'),
    });
    const serialized = JSON.stringify(result.value);

    expectSecretsAbsent(serialized);
    expect(result.value.password).toBe(REDACTED_VALUE);
    expect(result.value.environmentKeys).toEqual(['NORMAL_VALUE', 'API_TOKEN']);
    expect(result.value.environment).toEqual([
      `NORMAL_VALUE=${REDACTED_VALUE}`,
      `API_TOKEN=${REDACTED_VALUE}`,
    ]);
    expect(result.value.environmentFile).toEqual({
      content: ['API_TOKEN', 'DB_PASSWORD', 'PUBLIC_MODE'],
      path: '/opt/order-api/.env',
    });
    expect(String(result.value.databaseUrl)).toBe(
      `postgresql://${REDACTED_VALUE}@db.internal:5432/app?${REDACTED_VALUE}`,
    );
    expect(scanForSecrets(result.value)).toEqual([]);
    expect(result.report).toMatchObject({
      generatedAt: '2026-08-14T08:00:00.000Z',
      mode: 'persistence',
      passes: 1,
      rulesVersion: REDACTION_RULES_VERSION,
      secretScanPassed: true,
    });
    expect(result.report.totalMatches).toBeGreaterThan(10);
    expect(validateSchema(RedactionReportSchema, result.report).valid).toBe(true);
  });

  it('produces a schema-valid redacted snapshot with classified evidence', async () => {
    const snapshot = JSON.parse(await readFixture('schema/minimal-snapshot.json')) as ScanSnapshot;
    snapshot.processes = [
      {
        arguments: [
          '--token',
          'OPSENSE_TEST_ARGUMENT_TOKEN',
          '--tokenize',
          'ordinary-value',
          'password-policy',
          '-port',
          '8080',
          '-p=OPSENSE_TEST_ARGUMENT_TOKEN',
        ],
        command: 'worker --password OPSENSE_TEST_COMMAND_PASSWORD',
        evidenceIds: ['evidence:process'],
        id: 'process:100',
        pid: 100,
      },
    ];
    snapshot.systemdUnits = [
      {
        evidenceIds: ['evidence:process'],
        environmentFiles: [],
        execReload: [],
        execStart: [
          '/usr/bin/worker --access-token OPSENSE_TEST_ARGUMENT_TOKEN --tokenize ordinary-value',
        ],
        id: 'systemd:worker.service',
        name: 'worker.service',
      },
    ];
    snapshot.containers = [
      {
        environmentKeys: ['API_TOKEN'],
        evidenceIds: ['evidence:docker'],
        id: `container:${'a'.repeat(64)}`,
        image: 'order-api:1.0',
        labels: { 'example.password': 'OPSENSE_TEST_LABEL_PASSWORD' },
        mounts: [],
        name: 'order-api',
        networks: [],
        ports: [],
        runtime: 'docker',
        state: 'running',
      },
    ];
    snapshot.evidence = [
      {
        collectedAt: '2026-08-14T07:59:00.000Z',
        id: 'evidence:process',
        kind: 'command_output',
        opsenseVersion: '0.1.0',
        sensitivity: 'internal',
        source: '/opt/order-api/.env',
        status: 'success',
        value: {
          content: 'DB_PASSWORD=OPSENSE_TEST_ENV_FILE_PASSWORD',
          path: '/opt/order-api/.env',
        },
      },
      {
        collectedAt: '2026-08-14T07:59:00.000Z',
        id: 'evidence:docker',
        kind: 'command_output',
        opsenseVersion: '0.1.0',
        sensitivity: 'internal',
        source: 'docker.inspect',
        status: 'success',
      },
    ];

    const result = redactSnapshot(snapshot, () => new Date('2026-08-14T08:00:00.000Z'));
    const serialized = JSON.stringify(result.value);

    expectSecretsAbsent(serialized);
    expect(result.value.processes[0]?.arguments).toEqual([
      '--token',
      REDACTED_VALUE,
      '--tokenize',
      'ordinary-value',
      'password-policy',
      '-port',
      '8080',
      `-p=${REDACTED_VALUE}`,
    ]);
    expect(result.value.systemdUnits[0]?.execStart).toEqual([
      `/usr/bin/worker --access-token ${REDACTED_VALUE} --tokenize ordinary-value`,
    ]);
    expect(result.value.containers[0]?.environmentKeys).toEqual(['API_TOKEN']);
    expect(result.value.evidence[0]?.sensitivity).toBe('secret');
    expect(result.value.redaction).toEqual(result.report);
    expect(scanForSecrets(result.value)).toEqual([]);
    const validation = validateSchema(ScanSnapshotSchema, result.value);
    expect(validation.valid, JSON.stringify(validation.errors)).toBe(true);

    const root = await mkdtemp(path.join(tmpdir(), 'opsense-snapshot-redaction-test-'));
    temporaryDirectories.push(root);
    const layout = await ensureRunWorkspace('scan-security-snapshot', root);
    await Promise.all([
      writeJsonAtomic(layout.snapshotFile, result.value),
      writeJsonAtomic(layout.redactionReportFile, result.report),
    ]);
    const persisted = await Promise.all([
      readFile(layout.snapshotFile, 'utf8'),
      readFile(layout.redactionReportFile, 'utf8'),
    ]);
    expectSecretsAbsent(persisted.join('\n'));
    expect(scanForSecrets(JSON.parse(persisted[0]) as unknown)).toEqual([]);
  });

  it('protects AI input, audit logs, and report payloads at their write boundaries', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'opsense-redaction-test-'));
    temporaryDirectories.push(root);
    const layout = await ensureRunWorkspace('scan-security', root);
    const fixture = JSON.parse(await readFixture('security/sensitive-payload.json')) as unknown;
    const ai = redactForAiInput(fixture, () => new Date('2026-08-14T08:00:00.000Z'));
    const audit = redactForAudit(
      { message: 'Bearer eyJvcHNlbnNlIjoiZmFrZSJ9.eyJzY29wZSI6InRlc3QifQ.ZmFrZS1zaWduYXR1cmU' },
      () => new Date('2026-08-14T08:00:00.000Z'),
    );
    const report = redactForReport(
      { text: 'Password=OPSENSE_TEST_REPORT_PASSWORD;User Id=opsense' },
      () => new Date('2026-08-14T08:00:00.000Z'),
    );

    await writeJsonAtomic(path.join(layout.aiInputDirectory, 'payload.json'), ai.value);
    await writeJsonAtomic(path.join(layout.aiInputDirectory, 'redaction-report.json'), ai.report);
    await appendJsonLine(layout.auditFile, audit.value);
    await writeJsonAtomic(path.join(layout.runDirectory, 'report-model.json'), report.value);
    const persisted = await Promise.all([
      readFile(path.join(layout.aiInputDirectory, 'payload.json'), 'utf8'),
      readFile(path.join(layout.aiInputDirectory, 'redaction-report.json'), 'utf8'),
      readFile(layout.auditFile, 'utf8'),
      readFile(path.join(layout.runDirectory, 'report-model.json'), 'utf8'),
    ]);

    expect(ai.report.passes).toBe(2);
    expectSecretsAbsent(persisted.join('\n'));
    expect(persisted.join('\n')).not.toContain('OPSENSE_TEST_REPORT_PASSWORD');
    expect(scanForSecrets(ai.value)).toEqual([]);
    expect(scanForSecrets(audit.value)).toEqual([]);
    expect(scanForSecrets(report.value)).toEqual([]);
  });

  it('does not treat ps output format selectors as connection credentials', () => {
    const command = 'ps -eo user=,pid=,ppid=,uid=,lstart=,args=';
    const result = redactForAudit({ command });

    expect(result.value).toEqual({ command });
    expect(result.report.totalMatches).toBe(0);
    expect(scanForSecrets(result.value)).toEqual([]);
  });
});

function expectSecretsAbsent(value: string): void {
  for (const marker of SECRET_MARKERS) expect(value).not.toContain(marker);
}
