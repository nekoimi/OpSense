import { M5_COMMAND_CONCURRENCY, collectM5Snapshot } from '@opsense/collectors';
import {
  ArtifactRecordSchema,
  EvidenceRecordSchema,
  PathSeedRecordSchema,
  validateSchema,
} from '@opsense/schema';
import { SafeCommandExecutor, getCommandSpec, renderCommand } from '@opsense/ssh';
import type { RawCommandResult, RemoteCommandTransport } from '@opsense/ssh';
import { describe, expect, it } from 'vitest';

import { readFixture } from './support/read-fixture.js';

describe('M5 targeted directory discovery', () => {
  it('collects bounded artifacts and config summaries without reading .env values', async () => {
    const outputs = await createOutputs();
    const transport = new FixtureTransport(outputs);
    const collected = await collectM5Snapshot(
      new SafeCommandExecutor(transport),
      inputFixture(),
      options(),
    );

    expect(collected.unknowns).toEqual([]);
    expect(collected.pathSeeds).toHaveLength(1);
    expect(collected.artifacts.find((item) => item.kind === 'environment')?.path).toBe(
      '/opt/order-api/.env',
    );
    expect(collected.artifacts.find((item) => item.kind === 'compose')).toBeUndefined();
    const summary = collected.evidence.find((item) => item.kind === 'config_value');
    expect(summary?.value).toMatchObject({
      format: 'yaml',
      read: true,
      topLevelKeys: ['database', 'features', 'server'],
    });
    expect(JSON.stringify(collected)).not.toContain('fixture-secret-value');
    expect(transport.commands.some((command) => command.includes("'/opt/order-api/.env'"))).toBe(
      false,
    );
    collected.pathSeeds.forEach((item) =>
      expect(validateSchema(PathSeedRecordSchema, item).valid).toBe(true),
    );
    collected.artifacts.forEach((item) =>
      expect(validateSchema(ArtifactRecordSchema, item).valid).toBe(true),
    );
    collected.evidence.forEach((item) =>
      expect(validateSchema(EvidenceRecordSchema, item).valid).toBe(true),
    );
  });

  it('falls back to find plus stat when GNU printf is unavailable', async () => {
    const outputs = await createOutputs();
    const primary = executionCommand('directory.scan', {
      maxDepth: 4,
      path: '/opt/order-api',
    });
    outputs.set(
      executionCommand('directory.scan-stat', { maxDepth: 4, path: '/opt/order-api' }),
      await readFixture('m5/stat-output.txt'),
    );
    const transport = new FixtureTransport(
      outputs,
      new Map([[primary, failure("find: unknown predicate `-printf'")]]),
    );
    const collected = await collectM5Snapshot(
      new SafeCommandExecutor(transport),
      inputFixture(),
      options(),
    );

    expect(collected.artifacts).toHaveLength(2);
    expect(
      collected.evidence.find((item) => item.commandId === 'directory.scan-stat'),
    ).toMatchObject({ status: 'success' });
  });

  it('marks file-count limits and permission failures explicitly', async () => {
    const outputs = await createOutputs();
    const limited = await collectM5Snapshot(
      new SafeCommandExecutor(new FixtureTransport(outputs)),
      inputFixture(),
      options({ maxFilesPerDirectory: 3 }),
    );
    expect(limited.artifacts).toHaveLength(3);
    expect(limited.unknowns).toEqual(['directory.scan:/opt/order-api: truncated']);
    expect(limited.evidence.find((item) => item.commandId === 'directory.scan')).toMatchObject({
      status: 'truncated',
    });

    const primary = executionCommand('directory.scan', {
      maxDepth: 4,
      path: '/opt/order-api',
    });
    const denied = await collectM5Snapshot(
      new SafeCommandExecutor(
        new FixtureTransport(new Map(), new Map([[primary, permissionDenied()]])),
      ),
      inputFixture(),
      options(),
    );
    expect(denied.unknowns).toEqual(['directory.scan:/opt/order-api: permission_denied']);
    expect(denied.evidence[0]).toMatchObject({ status: 'permission_denied' });
  });

  it('keeps config metadata and generic failure evidence when structured parsing fails', async () => {
    const outputs = await createOutputs();
    outputs.set(
      executionCommand('directory.read-config', { path: '/opt/order-api/config/app.yml' }),
      'server: [invalid',
    );
    const collected = await collectM5Snapshot(
      new SafeCommandExecutor(new FixtureTransport(outputs)),
      inputFixture(),
      options(),
    );

    expect(collected.artifacts.some((item) => item.path.endsWith('/config/app.yml'))).toBe(true);
    expect(collected.unknowns).toEqual([]);
    expect(collected.evidence.find((item) => item.kind === 'config_value')).toMatchObject({
      message: 'Structured parser rejected the configuration file.',
      status: 'failed',
    });
    expect(JSON.stringify(collected)).not.toContain('server: [invalid');
  });

  it('uses root metadata summaries for container data volumes', async () => {
    const input = inputFixture();
    input.systemdUnits = [];
    input.containers = [
      {
        environmentKeys: [],
        evidenceIds: ['evidence:docker'],
        id: 'container:data',
        image: 'mysql:8',
        labels: {},
        mounts: [
          {
            destination: '/var/lib/mysql',
            readOnly: false,
            source: '/data/mount_data/mysql80',
            type: 'bind',
          },
        ],
        name: 'mysql',
        networks: [],
        ports: [],
        runtime: 'docker',
        state: 'running',
      },
    ];
    const command = executionCommand('directory.stat', { path: '/data/mount_data/mysql80' });
    const transport = new FixtureTransport(
      new Map([[command, 'd\t4096\tmysql\tmysql\t750\t1786672800\t/data/mount_data/mysql80\t\n']]),
    );

    const collected = await collectM5Snapshot(new SafeCommandExecutor(transport), input, options());

    expect(collected.unknowns).toEqual([]);
    expect(collected.artifacts).toHaveLength(1);
    expect(transport.commands).toContain(command);
  });

  it('falls back to basic stat syntax for container data volumes', async () => {
    const input = inputFixture();
    input.systemdUnits = [];
    input.containers = [
      {
        environmentKeys: [],
        evidenceIds: ['evidence:docker'],
        id: 'container:data',
        image: 'mysql:8',
        labels: {},
        mounts: [
          {
            destination: '/var/lib/mysql',
            readOnly: false,
            source: '/data/mount_data/mysql80',
            type: 'bind',
          },
        ],
        name: 'mysql',
        networks: [],
        ports: [],
        runtime: 'docker',
        state: 'running',
      },
    ];
    const primary = executionCommand('directory.stat', { path: '/data/mount_data/mysql80' });
    const fallback = executionCommand('directory.stat-basic', {
      path: '/data/mount_data/mysql80',
    });
    const transport = new FixtureTransport(
      new Map([
        [fallback, 'directory\t4096\tmysql\tmysql\t750\t1786672800\t/data/mount_data/mysql80\n'],
      ]),
      new Map([[primary, failure("stat: unrecognized option '--printf'")]]),
    );

    const collected = await collectM5Snapshot(new SafeCommandExecutor(transport), input, options());

    expect(collected.unknowns).toEqual([]);
    expect(collected.artifacts).toHaveLength(1);
    expect(transport.commands).toEqual([primary, fallback]);
    expect(
      collected.evidence.find((item) => item.commandId === 'directory.stat-basic'),
    ).toMatchObject({ status: 'success' });
  });

  it('limits concurrent directory commands', async () => {
    const input = inputFixture();
    input.processes = Array.from({ length: 12 }, (_, index) => ({
      arguments: [],
      command: 'worker',
      evidenceIds: ['evidence:process'],
      id: `process:${index + 1}`,
      pid: index + 1,
      workingDirectory: `/opt/app-${index + 1}`,
    }));
    const transport = new ConcurrencyTransport();

    await collectM5Snapshot(new SafeCommandExecutor(transport), input, options());

    expect(transport.maximumActive).toBeLessThanOrEqual(M5_COMMAND_CONCURRENCY);
    expect(transport.maximumActive).toBeGreaterThan(1);
  });
});

class FixtureTransport implements RemoteCommandTransport {
  public readonly commands: string[] = [];

  public constructor(
    private readonly outputs: ReadonlyMap<string, string>,
    private readonly overrides: ReadonlyMap<string, RawCommandResult> = new Map(),
  ) {}

  public executeRaw(command: string): Promise<RawCommandResult> {
    this.commands.push(command);
    const override = this.overrides.get(command);
    if (override !== undefined) return Promise.resolve(override);
    const stdout = this.outputs.get(command);
    if (stdout === undefined) return Promise.resolve(missing());
    return Promise.resolve(success(stdout));
  }
}

class ConcurrencyTransport implements RemoteCommandTransport {
  public active = 0;
  public maximumActive = 0;

  public async executeRaw(): Promise<RawCommandResult> {
    this.active += 1;
    this.maximumActive = Math.max(this.maximumActive, this.active);
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
    this.active -= 1;
    return missing();
  }
}

async function createOutputs(): Promise<Map<string, string>> {
  return new Map([
    [
      executionCommand('directory.scan', { maxDepth: 4, path: '/opt/order-api' }),
      await readFixture('m5/find-output.txt'),
    ],
    [
      executionCommand('directory.read-config', { path: '/opt/order-api/config/app.yml' }),
      await readFixture('m5/app.yml'),
    ],
  ]);
}

function inputFixture(): Parameters<typeof collectM5Snapshot>[1] {
  return {
    composeProjects: [],
    containers: [],
    processes: [],
    systemdUnits: [
      {
        environmentFiles: [],
        evidenceIds: ['evidence:systemd'],
        execReload: [],
        execStart: [],
        id: 'systemd:order-api.service',
        name: 'order-api.service',
        workingDirectory: '/opt/order-api',
      },
    ],
  };
}

function options(
  overrides: Partial<Parameters<typeof collectM5Snapshot>[2]> = {},
): Parameters<typeof collectM5Snapshot>[2] {
  return {
    crossFileSystems: false,
    maxConfigFileBytes: 262_144,
    maxDirectoryDepth: 4,
    maxFilesPerDirectory: 5_000,
    opsenseVersion: '0.1.0',
    ...overrides,
  };
}

function executionCommand(
  commandId: string,
  parameters: Readonly<Record<string, string | number>>,
): string {
  return renderCommand(getCommandSpec(commandId), parameters).execution;
}

function success(stdout: string): RawCommandResult {
  return {
    durationMs: 1,
    exitCode: 0,
    status: 'success',
    stderr: '',
    stderrBytes: 0,
    stdout,
    stdoutBytes: Buffer.byteLength(stdout),
  };
}

function missing(): RawCommandResult {
  return {
    durationMs: 1,
    exitCode: 127,
    status: 'command_missing',
    stderr: 'command not found',
    stderrBytes: 17,
    stdout: '',
    stdoutBytes: 0,
  };
}

function failure(stderr: string): RawCommandResult {
  return {
    durationMs: 1,
    exitCode: 1,
    status: 'failed',
    stderr,
    stderrBytes: Buffer.byteLength(stderr),
    stdout: '',
    stdoutBytes: 0,
  };
}

function permissionDenied(): RawCommandResult {
  return {
    durationMs: 1,
    exitCode: 1,
    status: 'permission_denied',
    stderr: 'Permission denied',
    stderrBytes: 17,
    stdout: '',
    stdoutBytes: 0,
  };
}
