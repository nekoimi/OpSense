import { detectDistributionFamily, probeFailureSummary, runProbe } from '@opsense/collectors';
import type { ProbeSpec } from '@opsense/collectors';
import { SafeCommandExecutor } from '@opsense/ssh';
import type { RawCommandResult, RemoteCommandTransport } from '@opsense/ssh';
import { describe, expect, it } from 'vitest';

import { readFixture } from './support/read-fixture.js';

describe('M3.1 distribution adaptation', () => {
  it('detects Debian, RHEL, Alpine, and unknown families from os-release', async () => {
    const [debian, rhel, alpine] = await Promise.all([
      readFixture('m3/os-release.txt'),
      readFixture('m3/os-release-rhel.txt'),
      readFixture('m3/os-release-alpine.txt'),
    ]);

    expect(detectDistributionFamily(debian)).toBe('debian');
    expect(detectDistributionFamily(rhel)).toBe('rhel');
    expect(detectDistributionFamily(alpine)).toBe('alpine');
    expect(detectDistributionFamily('ID=custom')).toBe('unknown');
  });

  it('falls back after a missing command, unsupported option, or parser failure', async () => {
    for (const firstResult of [
      failure('command_missing', 127, 'command not found'),
      failure('failed', 1, 'unrecognized option: -J'),
      success('{invalid-json'),
    ]) {
      const transport = new SequenceTransport([firstResult, success('Architecture: x86_64')]);
      const outcome = await runProbe(new SafeCommandExecutor(transport), cpuProbe(), 'debian');

      expect(outcome.selectedCommandId).toBe('host.lscpu-text');
      expect(outcome.value).toBe('Architecture: x86_64');
      expect(outcome.attempts).toHaveLength(2);
    }
  });

  it('reports one unknown only after all required variants fail', async () => {
    const outcome = await runProbe(
      new SafeCommandExecutor(
        new SequenceTransport([
          failure('command_missing', 127, 'not found'),
          failure('failed', 1, 'unsupported option'),
        ]),
      ),
      cpuProbe(),
      'rhel',
    );

    expect(probeFailureSummary(outcome)).toBe(
      'host.cpu: all variants failed (host.lscpu=command_missing, host.lscpu-text=failed)',
    );
    expect(outcome.attempts).toHaveLength(2);
  });

  it('does not turn an exhausted optional alternative into an unknown', async () => {
    const spec: ProbeSpec<string> = { ...cpuProbe(), required: false };
    const outcome = await runProbe(
      new SafeCommandExecutor(
        new SequenceTransport([
          failure('command_missing', 127, 'not found'),
          failure('command_missing', 127, 'not found'),
        ]),
      ),
      spec,
      'alpine',
    );

    expect(probeFailureSummary(outcome)).toBeUndefined();
  });
});

function cpuProbe(): ProbeSpec<string> {
  return {
    id: 'host.cpu',
    required: true,
    variants: [
      {
        commandId: 'host.lscpu',
        distributions: ['debian', 'rhel', 'alpine'],
        parse: (result) => {
          JSON.parse(result.stdout);
          return result.stdout;
        },
      },
      {
        commandId: 'host.lscpu-text',
        distributions: ['debian', 'rhel', 'alpine'],
        parse: (result) => result.stdout,
      },
    ],
  };
}

class SequenceTransport implements RemoteCommandTransport {
  public constructor(private readonly results: RawCommandResult[]) {}

  public executeRaw(): Promise<RawCommandResult> {
    return Promise.resolve(this.results.shift() ?? failure('failed', 1, 'no fixture result'));
  }
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

function failure(
  status: RawCommandResult['status'],
  exitCode: number,
  stderr: string,
): RawCommandResult {
  return {
    durationMs: 1,
    exitCode,
    status,
    stderr,
    stderrBytes: Buffer.byteLength(stderr),
    stdout: '',
    stdoutBytes: 0,
  };
}
