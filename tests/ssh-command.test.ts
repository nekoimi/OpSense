import {
  COMMAND_CATALOG,
  CommandSpecError,
  SafeCommandExecutor,
  getCommandSpec,
  quotePosixShellArgument,
  renderCommand,
  toCollectionStatus,
} from '@opsense/ssh';
import type { CommandAuditRecord, RawCommandResult, RemoteCommandTransport } from '@opsense/ssh';
import { describe, expect, it, vi } from 'vitest';

describe('safe command specifications', () => {
  it('quotes malicious path input as one shell token', () => {
    const malicious = "/tmp/app'; touch /tmp/owned; echo '";
    const rendered = renderCommand(getCommandSpec('directory.stat'), { path: malicious });

    expect(rendered.execution).toContain(quotePosixShellArgument(malicious));
    expect(rendered.audit).toContain('[path]');
    expect(rendered.audit).not.toContain('touch /tmp/owned');
  });

  it('rejects unknown and invalid parameters', () => {
    const spec = getCommandSpec('directory.stat');

    expect(() => renderCommand(spec, { extra: 'value', path: '/tmp' })).toThrowError(
      CommandSpecError,
    );
    expect(() => renderCommand(spec, { path: 'relative/path' })).toThrowError(/must be absolute/);
    expect(() => renderCommand(spec, { path: '/tmp\nwhoami' })).toThrowError(CommandSpecError);
  });

  it('enforces the sudo policy declared by the allowlist', () => {
    expect(() => renderCommand(getCommandSpec('host.uname'), {}, { useSudo: true })).toThrowError(
      /does not allow sudo/,
    );

    const allowed = renderCommand(getCommandSpec('network.sockets'), {}, { useSudo: true });
    expect(allowed.execution).toMatch(/^'sudo' '-n' '--'/);
  });

  it('contains unique, read-only command identifiers across scan categories', () => {
    const ids = COMMAND_CATALOG.map((spec) => spec.id);
    const executables = new Set(COMMAND_CATALOG.map((spec) => spec.executable));

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(
      expect.arrayContaining([
        'host.uname',
        'storage.lsblk',
        'storage.lsblk-pairs',
        'network.addresses',
        'network.addresses-text',
        'process.list',
        'process.links',
        'service.systemd-details',
        'docker.ps-basic',
        'docker.inspect',
        'directory.scan',
        'directory.scan-stat',
        'directory.read-config',
        'directory.stat-basic',
        'service.systemd-units',
        'directory.stat',
      ]),
    );
    for (const forbidden of [
      'apt',
      'chmod',
      'chown',
      'dd',
      'mkfs',
      'mount',
      'rm',
      'systemctl-stop',
    ]) {
      expect(executables.has(forbidden)).toBe(false);
    }
    for (const spec of COMMAND_CATALOG) {
      expect(spec.requiredCommands).toContain(spec.executable);
      expect(spec.requiredCommands.length).toBeGreaterThan(0);
    }
    expect(renderCommand(getCommandSpec('storage.lsblk')).execution).toContain("'-b'");
    expect(renderCommand(getCommandSpec('storage.swap')).execution).toContain(
      "'--show=NAME,TYPE,SIZE,USED,PRIO'",
    );
    expect(renderCommand(getCommandSpec('storage.mountinfo')).execution).toContain(
      "'/proc/self/mountinfo'",
    );
    expect(() =>
      renderCommand(getCommandSpec('docker.inspect'), { containerId: 'not-an-id' }),
    ).toThrowError(CommandSpecError);
    expect(() =>
      renderCommand(getCommandSpec('service.systemd-show'), {
        unitName: "bad.service'; touch /tmp/owned; echo '",
      }),
    ).toThrowError(CommandSpecError);
    expect(
      renderCommand(getCommandSpec('docker.inspect'), {
        containerId: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
      }).audit,
    ).toContain('[containerId]');
    const directoryScan = renderCommand(getCommandSpec('directory.scan'), {
      maxDepth: 4,
      path: "/opt/app'; touch /tmp/owned; echo '",
    });
    expect(directoryScan.execution).toContain("'-xdev'");
    expect(directoryScan.execution).toContain("'.git'");
    expect(directoryScan.audit).toContain('[path]');
    expect(directoryScan.audit).not.toContain('/opt/app');
    expect(() =>
      renderCommand(getCommandSpec('directory.scan'), { maxDepth: 21, path: '/opt/app' }),
    ).toThrowError(CommandSpecError);
    expect(() =>
      renderCommand(getCommandSpec('directory.read-config'), { path: '/opt/app\tsecret.yml' }),
    ).toThrowError(CommandSpecError);
  });
});

describe('safe command executor', () => {
  it('passes limits to the transport and writes a parameter-free audit record', async () => {
    const executeRaw = vi.fn(async (): Promise<RawCommandResult> => success('metadata'));
    const transport: RemoteCommandTransport = { executeRaw };
    const auditRecords: CommandAuditRecord[] = [];
    const executor = new SafeCommandExecutor(transport, (record) => auditRecords.push(record));

    const result = await executor.executeById('directory.stat', { path: '/opt/secret-app' });

    expect(result.status).toBe('success');
    expect(executeRaw).toHaveBeenCalledWith(
      expect.stringContaining("'/opt/secret-app'"),
      expect.objectContaining({ maxOutputBytes: 1_000_000, timeoutMs: 15_000 }),
    );
    expect(auditRecords).toHaveLength(1);
    expect(auditRecords[0]?.command).toContain('[path]');
    expect(auditRecords[0]?.command).not.toContain('/opt/secret-app');
  });

  it('converts transport failures into failed results and audit records', async () => {
    const transport: RemoteCommandTransport = {
      executeRaw: async () => {
        throw new Error('connection lost');
      },
    };
    const auditRecords: CommandAuditRecord[] = [];
    const executor = new SafeCommandExecutor(transport, (record) => auditRecords.push(record));

    const result = await executor.executeById('host.uname');

    expect(result.status).toBe('failed');
    expect(result.errorMessage).toBe('connection lost');
    expect(auditRecords[0]?.status).toBe('failed');
  });

  it('maps execution statuses to evidence collection statuses', () => {
    expect(toCollectionStatus('success')).toBe('success');
    expect(toCollectionStatus('command_missing')).toBe('command_missing');
    expect(toCollectionStatus('permission_denied')).toBe('permission_denied');
    expect(toCollectionStatus('cancelled')).toBe('failed');
  });
});

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
