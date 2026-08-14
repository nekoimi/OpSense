import { SafeCommandExecutor, derivePermissionLevel, detectPermissions } from '@opsense/ssh';
import type { RawCommandResult, RemoteCommandTransport } from '@opsense/ssh';
import { describe, expect, it } from 'vitest';

describe('SSH permission detection', () => {
  it('collects user identity and detects unprivileged access', async () => {
    const executor = new SafeCommandExecutor(createPermissionTransport(false));

    const probe = await detectPermissions(executor);

    expect(probe).toMatchObject({
      groups: ['ops', 'docker'],
      level: 'unprivileged',
      sudoNonInteractive: false,
      uid: 1000,
      user: 'ops',
    });
  });

  it('detects non-interactive sudo access as privileged', async () => {
    const executor = new SafeCommandExecutor(createPermissionTransport(true));

    await expect(detectPermissions(executor)).resolves.toMatchObject({
      level: 'privileged',
      sudoNonInteractive: true,
    });
  });

  it('derives root and partial privilege levels', () => {
    expect(
      derivePermissionLevel({ permissionDenied: false, sudoNonInteractive: false, uid: 0 }),
    ).toBe('privileged');
    expect(
      derivePermissionLevel({ permissionDenied: true, sudoNonInteractive: false, uid: 1000 }),
    ).toBe('partial_privileged');
  });
});

function createPermissionTransport(sudoAllowed: boolean): RemoteCommandTransport {
  return {
    async executeRaw(command): Promise<RawCommandResult> {
      if (command.includes("'-u'")) {
        return result('1000');
      }
      if (command.includes("'-un'")) {
        return result('ops');
      }
      if (command.includes("'-Gn'")) {
        return result('ops docker');
      }
      if (command.startsWith("'sudo'")) {
        return sudoAllowed ? result('') : result('', 1);
      }
      return result('', 1);
    },
  };
}

function result(stdout: string, exitCode = 0): RawCommandResult {
  return {
    durationMs: 1,
    exitCode,
    status: exitCode === 0 ? 'success' : 'failed',
    stderr: '',
    stderrBytes: 0,
    stdout,
    stdoutBytes: Buffer.byteLength(stdout),
  };
}
