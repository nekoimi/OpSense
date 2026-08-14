import {
  parseCpuInfo,
  parseCpuSnapshot,
  parseHostSnapshot,
  parseMemoryInfo,
  parseOsRelease,
} from '@opsense/collectors';
import { describe, expect, it } from 'vitest';

import { readFixture } from './support/read-fixture.js';

describe('M3 host parsers', () => {
  it('parses os-release, lscpu JSON, memory, and uptime', async () => {
    const [osRelease, lscpu, memoryInfo] = await Promise.all([
      readFixture('m3/os-release.txt'),
      readFixture('m3/lscpu.json'),
      readFixture('m3/meminfo.txt'),
    ]);

    const host = parseHostSnapshot({
      architecture: 'x86_64\n',
      capabilities: [],
      collectedAt: '2026-08-14T00:00:00.000Z',
      hostname: 'opsense-test\n',
      kernelVersion: '6.8.0-test\n',
      lscpuJson: lscpu,
      memoryInfo,
      osRelease,
      timezone: 'Asia/Shanghai\n',
      uptime: '12345.67 100.00\n',
      virtualization: 'kvm\n',
    });

    expect(host.operatingSystem).toMatchObject({
      family: 'debian',
      id: 'ubuntu',
      versionId: '24.04',
    });
    expect(host.cpu).toMatchObject({
      architecture: 'x86_64',
      logicalCores: 8,
      physicalCores: 4,
      sockets: 2,
    });
    expect(host.memory).toEqual({
      availableBytes: 8_388_608_000,
      swapFreeBytes: 1_073_741_824,
      swapTotalBytes: 2_147_483_648,
      totalBytes: 16_777_216_000,
    });
    expect(host.uptimeSeconds).toBe(12_345);
  });

  it('falls back to text lscpu output when JSON is invalid', async () => {
    const text = await readFixture('m3/lscpu.txt');
    const cpu = parseCpuSnapshot('{invalid', text);

    expect(cpu).toMatchObject({
      architecture: 'aarch64',
      logicalCores: 4,
      physicalCores: 4,
      sockets: 1,
    });
  });

  it('parses /proc/cpuinfo when lscpu is unavailable', async () => {
    const cpu = parseCpuInfo(await readFixture('m3/cpuinfo.txt'), 'x86_64');

    expect(cpu).toMatchObject({
      architecture: 'x86_64',
      logicalCores: 2,
      physicalCores: 2,
      sockets: 1,
    });
  });

  it('returns schema-safe unknown values for missing host facts', () => {
    expect(parseOsRelease('')).toMatchObject({ id: 'unknown', prettyName: 'unknown' });
    expect(parseMemoryInfo('')).toEqual({
      availableBytes: 0,
      swapFreeBytes: 0,
      swapTotalBytes: 0,
      totalBytes: 0,
    });
  });
});
