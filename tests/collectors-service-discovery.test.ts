import {
  DOCKER_INSPECT_BATCH_SIZE,
  M4_COMMAND_CONCURRENCY,
  SYSTEMD_DETAIL_BATCH_SIZE,
  collectM4Snapshot,
} from '@opsense/collectors';
import {
  ComposeProjectRecordSchema,
  ContainerRecordSchema,
  ProcessRecordSchema,
  SocketRecordSchema,
  SystemdUnitRecordSchema,
  validateSchema,
} from '@opsense/schema';
import { SafeCommandExecutor, getCommandSpec, renderCommand } from '@opsense/ssh';
import type { CommandParameterValue, RawCommandResult, RemoteCommandTransport } from '@opsense/ssh';
import { describe, expect, it } from 'vitest';

import { readFixture } from './support/read-fixture.js';

describe('M4 collection orchestration', () => {
  it('collects schema-valid service runtime entities and direct PID/container links', async () => {
    const outputs = await createOutputs();
    const collected = await collectM4Snapshot(
      new SafeCommandExecutor(new FixtureTransport(outputs)),
      {
        now: () => new Date('2026-08-14T05:00:00.000Z'),
        opsenseVersion: '0.1.0',
      },
    );

    expect(collected.unknowns).toEqual([]);
    expect(collected.systemdUnits.some((unit) => unit.name === 'legacy-worker.service')).toBe(true);
    expect(collected.processes.some((process) => process.pid === 2341)).toBe(true);
    expect(collected.containers).toHaveLength(2);
    expect(collected.containers.find((container) => container.name === 'worker')).toMatchObject({
      processId: 0,
      state: 'exited',
    });
    expect(collected.composeProjects).toHaveLength(1);
    expect(collected.sockets.find((socket) => socket.localPort === 18080)?.containerIds).toEqual([
      collected.containers[0]?.id,
    ]);
    for (const [schema, values] of [
      [SystemdUnitRecordSchema, collected.systemdUnits],
      [ProcessRecordSchema, collected.processes],
      [SocketRecordSchema, collected.sockets],
      [ContainerRecordSchema, collected.containers],
      [ComposeProjectRecordSchema, collected.composeProjects],
    ] as const) {
      values.forEach((value) => expect(validateSchema(schema, value).valid).toBe(true));
    }
    expect(new Set(collected.evidence.map((item) => item.id)).size).toBe(collected.evidence.length);
    expect(JSON.stringify(collected)).not.toContain('secret-value');
    expect(JSON.stringify(collected)).not.toContain('top-secret');
  });

  it('falls back to netstat when ss is missing', async () => {
    const outputs = await createOutputs();
    outputs.delete(executionCommand('network.sockets'));
    outputs.set(executionCommand('network.sockets-netstat'), await readFixture('m4/netstat.txt'));
    const collected = await collectM4Snapshot(
      new SafeCommandExecutor(new FixtureTransport(outputs)),
      { opsenseVersion: '0.1.0' },
    );

    expect(collected.sockets).toHaveLength(2);
    expect(collected.unknowns).toEqual([]);
    expect(
      collected.evidence.find((item) => item.commandId === 'network.sockets-netstat'),
    ).toMatchObject({ status: 'success' });
  });

  it('keeps template unit files without probing uninstantiated systemd units', async () => {
    const outputs = await createOutputs();
    const filesCommand = executionCommand('service.systemd-files');
    outputs.set(filesCommand, `${outputs.get(filesCommand)}\ngetty@.service enabled enabled\n`);
    const collected = await collectM4Snapshot(
      new SafeCommandExecutor(new FixtureTransport(outputs)),
      { opsenseVersion: '0.1.0' },
    );

    expect(collected.systemdUnits).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'getty@.service' })]),
    );
    expect(collected.unknowns.join('\n')).not.toContain('getty@.service');
  });

  it('accepts useful proc link output from normal process-exit races', async () => {
    const outputs = await createOutputs();
    const command = executionCommand('process.links');
    const partialResult: RawCommandResult = {
      durationMs: 1,
      exitCode: 1,
      status: 'failed',
      stderr: 'find: /proc/999/exe: No such file or directory',
      stderrBytes: 45,
      stdout: outputs.get(command) ?? '',
      stdoutBytes: Buffer.byteLength(outputs.get(command) ?? ''),
    };
    const collected = await collectM4Snapshot(
      new SafeCommandExecutor(new FixtureTransport(outputs, new Map([[command, partialResult]]))),
      { opsenseVersion: '0.1.0' },
    );

    expect(collected.unknowns.join('\n')).not.toContain('process.links');
    expect(collected.evidence.find((item) => item.commandId === 'process.links')).toMatchObject({
      status: 'success',
      value: expect.objectContaining({ exitCode: 1 }),
    });
  });

  it('falls back to a bounded basic Docker list after the JSON list times out', async () => {
    const outputs = await createOutputs();
    const primaryCommand = executionCommand('docker.ps');
    const basicCommand = executionCommand('docker.ps-basic');
    outputs.set(
      basicCommand,
      'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890\tweb\tnginx:1.27\trunning\n' +
        '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef\tworker\tnode:22\texited\n',
    );
    const timeoutResult: RawCommandResult = {
      durationMs: 30_000,
      status: 'timeout',
      stderr: '',
      stderrBytes: 0,
      stdout: '',
      stdoutBytes: 0,
    };
    const collected = await collectM4Snapshot(
      new SafeCommandExecutor(
        new FixtureTransport(outputs, new Map([[primaryCommand, timeoutResult]])),
      ),
      { opsenseVersion: '0.1.0' },
    );

    expect(collected.containers).toHaveLength(2);
    expect(collected.unknowns.join('\n')).not.toContain('docker.ps');
    expect(collected.evidence.find((item) => item.commandId === 'docker.ps')).toMatchObject({
      status: 'timeout',
    });
    expect(collected.evidence.find((item) => item.commandId === 'docker.ps-basic')).toMatchObject({
      status: 'success',
    });
  });

  it('limits concurrent SSH channels across M4 base probes', async () => {
    const transport = new ConcurrencyTransport();

    await collectM4Snapshot(new SafeCommandExecutor(transport), {
      opsenseVersion: '0.1.0',
    });

    expect(transport.maximumActive).toBeLessThanOrEqual(M4_COMMAND_CONCURRENCY);
    expect(transport.maximumActive).toBeGreaterThan(1);
  });

  it('does not produce systemd or Docker N+1 detail commands on large hosts', async () => {
    const systemdCount = 300;
    const dockerCount = 100;
    const outputs = createLargeHostOutputs(systemdCount, dockerCount);
    const transport = new FixtureTransport(outputs);

    const collected = await collectM4Snapshot(new SafeCommandExecutor(transport), {
      opsenseVersion: '3.0.0',
    });

    expect(collected.systemdUnits).toHaveLength(systemdCount);
    expect(collected.containers).toHaveLength(dockerCount);
    expect(
      transport.commands.filter((command) => command.startsWith("'systemctl' 'show'")).length,
    ).toBe(Math.ceil(systemdCount / SYSTEMD_DETAIL_BATCH_SIZE));
    expect(
      transport.commands.filter((command) => command.startsWith("'docker' 'inspect'")).length,
    ).toBe(Math.ceil(dockerCount / DOCKER_INSPECT_BATCH_SIZE));
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
    if (stdout === undefined) {
      return Promise.resolve({
        durationMs: 1,
        exitCode: 127,
        status: 'command_missing',
        stderr: 'command not found',
        stderrBytes: 17,
        stdout: '',
        stdoutBytes: 0,
      });
    }
    return Promise.resolve({
      durationMs: 1,
      exitCode: 0,
      status: 'success',
      stderr: '',
      stderrBytes: 0,
      stdout,
      stdoutBytes: Buffer.byteLength(stdout),
    });
  }
}

function createLargeHostOutputs(systemdCount: number, dockerCount: number): Map<string, string> {
  const unitNames = Array.from(
    { length: systemdCount },
    (_, index) => `app-${String(index).padStart(4, '0')}.service`,
  );
  const containerIds = Array.from({ length: dockerCount }, (_, index) =>
    index.toString(16).padStart(64, '0'),
  );
  const outputs = new Map<string, string>([
    [
      executionCommand('service.systemd-units'),
      unitNames.map((name) => `${name} loaded active running Application`).join('\n'),
    ],
    [
      executionCommand('service.systemd-files'),
      unitNames.map((name) => `${name} enabled enabled`).join('\n'),
    ],
    [executionCommand('process.list'), ''],
    [executionCommand('process.links'), ''],
    [executionCommand('process.passwd'), ''],
    [executionCommand('network.sockets'), ''],
    [executionCommand('docker.info'), '{}'],
    [
      executionCommand('docker.ps'),
      containerIds
        .map((id, index) =>
          JSON.stringify({
            ID: id,
            Image: `example/app:${index}`,
            Names: `app-${index}`,
            State: 'running',
          }),
        )
        .join('\n'),
    ],
    [executionCommand('docker.compose-ls'), '[]'],
  ]);
  for (let index = 0; index < unitNames.length; index += SYSTEMD_DETAIL_BATCH_SIZE) {
    const batch = unitNames.slice(index, index + SYSTEMD_DETAIL_BATCH_SIZE);
    outputs.set(
      executionCommand('service.systemd-show-batch', { unitNames: batch }),
      batch
        .map(
          (name) =>
            `Id=${name}\nDescription=Application\nLoadState=loaded\nActiveState=active\nSubState=running\nUnitFileState=enabled\nMainPID=0`,
        )
        .join('\n\n'),
    );
  }
  for (let index = 0; index < containerIds.length; index += DOCKER_INSPECT_BATCH_SIZE) {
    const batch = containerIds.slice(index, index + DOCKER_INSPECT_BATCH_SIZE);
    outputs.set(
      executionCommand('docker.inspect-batch', { containerIds: batch }),
      JSON.stringify(
        batch.map((id) => {
          const itemIndex = Number.parseInt(id.slice(-8), 16);
          return {
            Config: { Env: [], Image: `example/app:${itemIndex}`, Labels: {} },
            HostConfig: {},
            Id: id,
            Mounts: [],
            Name: `/app-${itemIndex}`,
            NetworkSettings: { Networks: {}, Ports: {} },
            State: { Pid: itemIndex + 1, Status: 'running' },
          };
        }),
      ),
    );
  }
  return outputs;
}

class ConcurrencyTransport implements RemoteCommandTransport {
  public active = 0;
  public maximumActive = 0;

  public async executeRaw(): Promise<RawCommandResult> {
    this.active += 1;
    this.maximumActive = Math.max(this.maximumActive, this.active);
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
    this.active -= 1;
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
}

async function createOutputs(): Promise<Map<string, string>> {
  const containerId = 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
  const stoppedContainerId = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
  const fixtures = await Promise.all([
    readFixture('m4/systemd-units.txt'),
    readFixture('m4/systemd-files.txt'),
    readFixture('m4/systemd-details.txt'),
    readFixture('m4/systemd-details-legacy.txt'),
    readFixture('m4/process-list.txt'),
    readFixture('m4/process-links.txt'),
    readFixture('m4/passwd.txt'),
    readFixture('m4/ss.txt'),
    readFixture('m4/docker-ps.jsonl'),
    readFixture('m4/docker-inspect-web.json'),
    readFixture('m4/docker-inspect-worker.json'),
    readFixture('m4/compose-ls.json'),
  ]);
  const systemdNames = ['legacy-worker.service', 'order-api.service', 'ssh.service'];
  const dockerIds = [containerId, stoppedContainerId];
  const dockerBatch = JSON.stringify([
    ...(JSON.parse(fixtures[9] ?? '[]') as unknown[]),
    ...(JSON.parse(fixtures[10] ?? '[]') as unknown[]),
  ]);
  return new Map([
    [executionCommand('service.systemd-units'), fixtures[0] ?? ''],
    [executionCommand('service.systemd-files'), fixtures[1] ?? ''],
    [
      executionCommand('service.systemd-show-batch', { unitNames: systemdNames }),
      `${fixtures[2] ?? ''}\n\n${fixtures[3] ?? ''}`,
    ],
    [executionCommand('process.list'), fixtures[4] ?? ''],
    [executionCommand('process.links'), fixtures[5] ?? ''],
    [executionCommand('process.passwd'), fixtures[6] ?? ''],
    [executionCommand('network.sockets'), fixtures[7] ?? ''],
    [executionCommand('docker.info'), '{}'],
    [executionCommand('docker.ps'), fixtures[8] ?? ''],
    [executionCommand('docker.inspect-batch', { containerIds: dockerIds }), dockerBatch],
    [executionCommand('docker.compose-ls'), fixtures[11] ?? ''],
  ]);
}

function executionCommand(
  commandId: string,
  parameters: Readonly<Record<string, CommandParameterValue>> = {},
): string {
  return renderCommand(getCommandSpec(commandId), parameters).execution;
}
