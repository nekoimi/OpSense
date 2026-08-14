import {
  enrichMounts,
  parseDf,
  parseLsblk,
  parseLsblkPairs,
  parseMountInfo,
  parseProcSwaps,
  parseStorageSnapshot,
} from '@opsense/collectors';
import { describe, expect, it } from 'vitest';

import { readFixture } from './support/read-fixture.js';

describe('M3 storage parsers', () => {
  it('parses disks, layers, mounts, fstab, df, and swap in bytes', async () => {
    const [lsblk, findmnt, dfBytes, dfInodes, fstab, swap] = await Promise.all([
      readFixture('m3/lsblk.json'),
      readFixture('m3/findmnt.json'),
      readFixture('m3/df-bytes.txt'),
      readFixture('m3/df-inodes.txt'),
      readFixture('m3/fstab.txt'),
      readFixture('m3/swapon.txt'),
    ]);

    const storage = parseStorageSnapshot({
      collectedAt: '2026-08-14T00:00:00.000Z',
      dfBytes,
      dfBytesEvidenceId: 'evidence:storage.df-bytes',
      dfInodes,
      dfInodesEvidenceId: 'evidence:storage.df-inodes',
      findmnt,
      findmntEvidenceId: 'evidence:storage.findmnt',
      fstab,
      fstabEvidenceId: 'evidence:storage.fstab',
      lsblk,
      lsblkEvidenceId: 'evidence:storage.lsblk',
      swap,
      swapEvidenceId: 'evidence:storage.swap',
    });

    expect(storage.disks[0]).toMatchObject({
      name: 'sda',
      rotational: true,
      sizeBytes: 107_374_182_400,
    });
    expect(storage.disks[0]?.partitions).toHaveLength(2);
    expect(storage.layers).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'vg-data', type: 'lvm' })]),
    );
    expect(storage.swapDevices[0]).toMatchObject({
      name: '/swapfile',
      sizeBytes: 2_147_483_648,
      usedBytes: 1_073_741_824,
    });
    expect(storage.fstabEntries).toHaveLength(3);

    const dataMount = storage.mounts.find((mount) => mount.target === '/data');
    expect(dataMount).toMatchObject({
      inodeTotal: 2_621_440,
      readOnly: true,
      temporary: false,
      totalBytes: 42_949_672_960,
    });
    expect(storage.mounts.find((mount) => mount.target === '/run')).toMatchObject({
      pseudo: false,
      temporary: true,
    });
    expect(storage.mounts.find((mount) => mount.target === '/mnt/share')).toMatchObject({
      network: true,
    });
  });

  it('accepts human-readable lsblk sizes as a compatibility fallback', () => {
    const parsed = parseLsblk(
      JSON.stringify({
        blockdevices: [{ name: 'sda', path: '/dev/sda', size: '100G', type: 'disk' }],
      }),
      'evidence:storage.lsblk',
    );

    expect(parsed.disks[0]?.sizeBytes).toBe(107_374_182_400);
  });

  it('parses text fallbacks for lsblk, mountinfo, kilobyte df, and /proc/swaps', async () => {
    const [lsblk, mountinfo, dfKilobytes, procSwaps] = await Promise.all([
      readFixture('m3/lsblk-pairs.txt'),
      readFixture('m3/mountinfo.txt'),
      readFixture('m3/df-kilobytes.txt'),
      readFixture('m3/proc-swaps.txt'),
    ]);
    const disks = parseLsblkPairs(lsblk, 'evidence:storage.lsblk-pairs');
    const mounts = enrichMounts(
      parseMountInfo(mountinfo, 'evidence:storage.mountinfo'),
      parseDf(dfKilobytes, 1024),
      [],
      'evidence:storage.df-kilobytes',
      'evidence:storage.df-inodes',
    );
    const swap = parseProcSwaps(procSwaps, 'evidence:storage.swap-proc');

    expect(disks.disks[0]).toMatchObject({ name: 'sda', sizeBytes: 107_374_182_400 });
    expect(disks.disks[0]?.partitions[0]).toMatchObject({ name: 'sda1' });
    expect(mounts.find((mount) => mount.target === '/')).toMatchObject({
      totalBytes: 53_687_091_200,
    });
    expect(mounts.find((mount) => mount.target === '/mnt/share')).toMatchObject({ network: true });
    expect(swap[0]).toMatchObject({ sizeBytes: 2_147_483_648, usedBytes: 1_073_741_824 });
  });
});
