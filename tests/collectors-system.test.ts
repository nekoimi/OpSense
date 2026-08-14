import { M3_COMMAND_CONCURRENCY, collectM3Snapshot } from '@opsense/collectors';
import {
  HostSnapshotSchema,
  NetworkSnapshotSchema,
  StorageSnapshotSchema,
  validateSchema,
} from '@opsense/schema';
import { SafeCommandExecutor, getCommandSpec, renderCommand } from '@opsense/ssh';
import type { RawCommandResult, RemoteCommandTransport } from '@opsense/ssh';
import { describe, expect, it } from 'vitest';

import { readFixture } from './support/read-fixture.js';

describe('M3 collection orchestration', () => {
  it('builds schema-valid host, storage, and network snapshots', async () => {
    const outputs = await createOutputs();
    const executor = new SafeCommandExecutor(new FixtureTransport(outputs));

    const collected = await collectM3Snapshot(executor, {
      now: () => new Date('2026-08-14T00:00:00.000Z'),
      opsenseVersion: '0.1.0',
    });

    expect(validateSchema(HostSnapshotSchema, collected.host).valid).toBe(true);
    expect(validateSchema(StorageSnapshotSchema, collected.storage).valid).toBe(true);
    expect(validateSchema(NetworkSnapshotSchema, collected.network).valid).toBe(true);
    expect(collected.host.packageManager).toBe('apt/dpkg');
    expect(collected.host.capabilities.find((item) => item.command === 'ip')).toMatchObject({
      available: true,
    });
    expect(collected.unknowns).toEqual([]);
    expect(JSON.stringify(collected.evidence)).not.toContain('Ubuntu 24.04.1 LTS');
  });

  it('records a missing command and continues collecting other sections', async () => {
    const outputs = await createOutputs();
    outputs.delete(executionCommand('network.routes'));
    const executor = new SafeCommandExecutor(new FixtureTransport(outputs));

    const collected = await collectM3Snapshot(executor, {
      now: () => new Date('2026-08-14T00:00:00.000Z'),
      opsenseVersion: '0.1.0',
    });

    expect(collected.host.hostname).toBe('opsense-test');
    expect(collected.network.routes).toEqual([]);
    expect(collected.unknowns.join('\n')).toContain('network.routes: all variants failed');
  });

  it('isolates parser failures to the affected command output', async () => {
    const outputs = await createOutputs();
    outputs.set(executionCommand('storage.lsblk'), '{invalid');
    const executor = new SafeCommandExecutor(new FixtureTransport(outputs));

    const collected = await collectM3Snapshot(executor, {
      now: () => new Date('2026-08-14T00:00:00.000Z'),
      opsenseVersion: '0.1.0',
    });

    expect(collected.storage.disks).toEqual([]);
    expect(collected.storage.mounts.length).toBeGreaterThan(0);
    expect(collected.unknowns.join('\n')).toContain('storage.block-devices: all variants failed');
    expect(collected.unknowns.join('\n')).toContain('storage.lsblk=parsing_failed');
  });

  it('uses a lower-capability command after the primary parser rejects its output', async () => {
    const outputs = await createOutputs();
    outputs.set(executionCommand('storage.lsblk'), '{invalid');
    outputs.set(executionCommand('storage.lsblk-basic'), await readFixture('m3/lsblk.json'));
    const executor = new SafeCommandExecutor(new FixtureTransport(outputs));

    const collected = await collectM3Snapshot(executor, {
      now: () => new Date('2026-08-14T00:00:00.000Z'),
      opsenseVersion: '0.1.0',
    });

    expect(collected.storage.disks.length).toBeGreaterThan(0);
    expect(collected.unknowns.join('\n')).not.toContain('storage.block-devices');
    expect(collected.evidence.find((item) => item.commandId === 'storage.lsblk')).toMatchObject({
      status: 'failed',
    });
    expect(
      collected.evidence.find((item) => item.commandId === 'storage.lsblk-basic'),
    ).toMatchObject({ status: 'success' });
  });

  it('limits concurrent SSH command channels', async () => {
    const transport = new ConcurrencyTransport();
    const executor = new SafeCommandExecutor(transport);

    await collectM3Snapshot(executor, {
      now: () => new Date('2026-08-14T00:00:00.000Z'),
      opsenseVersion: '0.1.0',
    });

    expect(transport.maximumActive).toBeLessThanOrEqual(M3_COMMAND_CONCURRENCY);
    expect(transport.maximumActive).toBeGreaterThan(1);
  });

  it('orders package-manager probes by the detected distribution family', async () => {
    const cases = [
      ['m3/os-release-rhel.txt', 'environment.rpm', 'rpm'],
      ['m3/os-release-alpine.txt', 'environment.apk', 'apk'],
    ] as const;

    for (const [osFixture, commandId, expectedManager] of cases) {
      const outputs = await createOutputs();
      outputs.set(executionCommand('host.os-release'), await readFixture(osFixture));
      outputs.delete(executionCommand('environment.dpkg'));
      outputs.set(executionCommand(commandId), `${expectedManager} version\n`);
      const collected = await collectM3Snapshot(
        new SafeCommandExecutor(new FixtureTransport(outputs)),
        { opsenseVersion: '0.1.0' },
      );

      expect(collected.host.packageManager).toBe(expectedManager);
    }
  });
});

class FixtureTransport implements RemoteCommandTransport {
  public constructor(private readonly outputs: ReadonlyMap<string, string>) {}

  public executeRaw(command: string): Promise<RawCommandResult> {
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
      exitCode: 0,
      status: 'success',
      stderr: '',
      stderrBytes: 0,
      stdout: '',
      stdoutBytes: 0,
    };
  }
}

async function createOutputs(): Promise<Map<string, string>> {
  const fixtures = await Promise.all([
    readFixture('m3/os-release.txt'),
    readFixture('m3/lscpu.json'),
    readFixture('m3/lscpu.txt'),
    readFixture('m3/meminfo.txt'),
    readFixture('m3/lsblk.json'),
    readFixture('m3/findmnt.json'),
    readFixture('m3/df-bytes.txt'),
    readFixture('m3/df-inodes.txt'),
    readFixture('m3/fstab.txt'),
    readFixture('m3/swapon.txt'),
    readFixture('m3/ip-address.json'),
    readFixture('m3/ip-route.json'),
    readFixture('m3/resolv.conf'),
    readFixture('m3/nft.json'),
  ]);
  const [
    osRelease,
    lscpuJson,
    lscpuText,
    memoryInfo,
    lsblk,
    findmnt,
    dfBytes,
    dfInodes,
    fstab,
    swap,
    addresses,
    routes,
    dns,
    nft,
  ] = fixtures;
  return new Map([
    [executionCommand('host.os-release'), osRelease ?? ''],
    [executionCommand('host.kernel-release'), '6.8.0-test\n'],
    [executionCommand('host.architecture'), 'x86_64\n'],
    [executionCommand('host.hostname'), 'opsense-test\n'],
    [executionCommand('host.hostname-fqdn'), 'opsense-test.example.internal\n'],
    [executionCommand('host.timezone'), 'Asia/Shanghai\n'],
    [executionCommand('host.uptime'), '12345.67 100.00\n'],
    [executionCommand('host.virtualization'), 'kvm\n'],
    [executionCommand('host.lscpu'), lscpuJson ?? ''],
    [executionCommand('host.lscpu-text'), lscpuText ?? ''],
    [executionCommand('host.memory'), memoryInfo ?? ''],
    [executionCommand('storage.lsblk'), lsblk ?? ''],
    [executionCommand('storage.findmnt'), findmnt ?? ''],
    [executionCommand('storage.df-bytes'), dfBytes ?? ''],
    [executionCommand('storage.df-inodes'), dfInodes ?? ''],
    [executionCommand('storage.fstab'), fstab ?? ''],
    [executionCommand('storage.swap'), swap ?? ''],
    [executionCommand('network.addresses'), addresses ?? ''],
    [executionCommand('network.routes'), routes ?? ''],
    [executionCommand('network.dns'), dns ?? ''],
    [executionCommand('firewall.nft'), nft ?? ''],
    [
      executionCommand('environment.dpkg'),
      'Debian dpkg-query package management program version 1.22\n',
    ],
  ]);
}

function executionCommand(commandId: string): string {
  return renderCommand(getCommandSpec(commandId)).execution;
}
