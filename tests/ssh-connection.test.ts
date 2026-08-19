import { EventEmitter } from 'node:events';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { HostKeyMismatchError, SshConnection, connectSsh } from '@opsense/ssh';
import type { SshError } from '@opsense/ssh';
import { describe, expect, it, vi } from 'vitest';

import { createTestDirectory } from './support/temporary-directory.js';

interface CapturedConnectConfig {
  agent?: string;
  hostVerifier?: (key: Buffer) => boolean;
  keepaliveCountMax?: number;
  keepaliveInterval?: number;
  password?: string;
  privateKey?: Buffer;
  readyTimeout?: number;
}

class FakeConnectClient extends EventEmitter {
  public config?: CapturedConnectConfig;
  public ended = false;

  public constructor(private readonly hostKey: Buffer) {
    super();
  }

  public connect(config: CapturedConnectConfig): this {
    this.config = config;
    queueMicrotask(() => {
      if (config.hostVerifier?.(this.hostKey) ?? true) {
        this.emit('ready');
      } else {
        this.emit('error', new Error('host key rejected'));
      }
    });
    return this;
  }

  public end(): void {
    this.ended = true;
  }
}

class FakeChannel extends PassThrough {
  public receivedInput = '';
  public readonly stderr = new PassThrough();
  public readonly signal = vi.fn();
  private closed = false;

  public constructor() {
    super();
    this.on('data', (chunk: Buffer) => {
      this.receivedInput += chunk.toString('utf8');
    });
  }

  public close(): void {
    if (!this.closed) {
      this.closed = true;
      this.emit('close');
    }
  }
}

class FakeExecClient {
  public constructor(private readonly run: (channel: FakeChannel) => void) {}

  public exec(
    _command: string,
    callback: (error: Error | undefined, channel: FakeChannel) => void,
  ): void {
    const channel = new FakeChannel();
    callback(undefined, channel);
    queueMicrotask(() => this.run(channel));
  }

  public end(): void {}
}

class FakeClosedClient extends EventEmitter {
  public connect(): this {
    queueMicrotask(() => this.emit('close'));
    return this;
  }

  public end(): void {}
}

describe('SSH connection', () => {
  it('supports password providers, keepalive, and explicit first-use trust', async () => {
    const root = await createTestDirectory();
    const knownHostsFile = path.join(root, 'known-hosts.json');
    const client = new FakeConnectClient(Buffer.from('host-key'));
    const passwordProvider = vi.fn(async () => 'not-logged');

    const connection = await connectSsh(
      {
        acceptNewHostKey: true,
        agentSocket: '',
        connectTimeoutMs: 5000,
        host: 'server.example.com',
        keepaliveCountMax: 5,
        keepaliveIntervalMs: 2000,
        knownHostsFile,
        passwordProvider,
        strictHostKeyChecking: true,
        user: 'ops',
      },
      { clientFactory: () => client as never, now: () => new Date('2026-08-14T00:00:00Z') },
    );

    expect(connection.host).toBe('server.example.com');
    expect(passwordProvider).toHaveBeenCalledOnce();
    expect(client.config).toMatchObject({
      keepaliveCountMax: 5,
      keepaliveInterval: 2000,
      password: 'not-logged',
      readyTimeout: 5000,
    });
    connection.close();
    expect(client.ended).toBe(true);

    const trustedClient = new FakeConnectClient(Buffer.from('host-key'));
    await expect(
      connectSsh(
        {
          agentSocket: '',
          host: 'server.example.com',
          knownHostsFile,
          passwordProvider: async () => 'password',
          user: 'ops',
        },
        { clientFactory: () => trustedClient as never },
      ),
    ).resolves.toBeInstanceOf(SshConnection);
  });

  it('rejects changed host keys', async () => {
    const root = await createTestDirectory();
    const knownHostsFile = path.join(root, 'known-hosts.json');
    const firstClient = new FakeConnectClient(Buffer.from('first-key'));
    await connectSsh(
      {
        acceptNewHostKey: true,
        agentSocket: '',
        host: 'server',
        knownHostsFile,
        passwordProvider: async () => 'password',
        user: 'ops',
      },
      { clientFactory: () => firstClient as never },
    );

    const changedClient = new FakeConnectClient(Buffer.from('changed-key'));
    await expect(
      connectSsh(
        {
          agentSocket: '',
          host: 'server',
          knownHostsFile,
          passwordProvider: async () => 'password',
          user: 'ops',
        },
        { clientFactory: () => changedClient as never },
      ),
    ).rejects.toBeInstanceOf(HostKeyMismatchError);
  });

  it('loads private keys and rejects missing authentication', async () => {
    const root = await createTestDirectory();
    const identityFile = path.join(root, 'id_test');
    await writeFile(identityFile, 'private-key-fixture', 'utf8');
    const client = new FakeConnectClient(Buffer.from('host-key'));

    await connectSsh(
      {
        agentSocket: '',
        host: 'server',
        identityFile,
        strictHostKeyChecking: false,
        user: 'ops',
      },
      { clientFactory: () => client as never },
    );
    expect(client.config?.privateKey?.toString('utf8')).toBe('private-key-fixture');

    await expect(
      connectSsh(
        {
          agentSocket: '',
          host: 'server',
          strictHostKeyChecking: false,
          user: 'ops',
        },
        { clientFactory: () => new FakeConnectClient(Buffer.from('key')) as never },
      ),
    ).rejects.toMatchObject<Partial<SshError>>({ code: 'SSH_AUTH_MISSING' });
  });

  it('rejects when the connection closes during authentication', async () => {
    await expect(
      connectSsh(
        {
          agentSocket: '',
          host: 'server',
          passwordProvider: async () => 'password',
          strictHostKeyChecking: false,
          user: 'ops',
        },
        { clientFactory: () => new FakeClosedClient() as never },
      ),
    ).rejects.toMatchObject<Partial<SshError>>({ code: 'SSH_CONNECTION_CLOSED' });
  });
});

describe('raw SSH command execution', () => {
  it('captures stdout, stderr, and exit status', async () => {
    const client = new FakeExecClient((channel) => {
      channel.write('hello');
      channel.stderr.write('warning');
      channel.emit('exit', 0, null);
      channel.close();
    });
    const connection = new SshConnection(client as never, 'server', 22, 'ops');

    const result = await connection.executeRaw("'uname' '-a'", {
      maxOutputBytes: 1000,
      timeoutMs: 1000,
    });

    expect(result).toMatchObject({ status: 'success', stderr: 'warning', stdout: 'hello' });
  });

  it('writes command stdin without including it in the remote command', async () => {
    let openedChannel: FakeChannel | undefined;
    let executedCommand = '';
    const client = new FakeExecClient((channel) => {
      openedChannel = channel;
      channel.emit('exit', 0, null);
      channel.close();
    });
    const originalExec = client.exec.bind(client);
    client.exec = (command, callback): void => {
      executedCommand = command;
      originalExec(command, callback);
    };
    const connection = new SshConnection(client as never, 'server', 22, 'ops');

    const result = await connection.executeRaw("'sudo' '-S' '--' 'true'", {
      maxOutputBytes: 1000,
      stdin: 'sudo-password-value\n',
      timeoutMs: 1000,
    });

    expect(result.status).toBe('success');
    expect(openedChannel?.receivedInput).toBe('sudo-password-value\n');
    expect(executedCommand).not.toContain('sudo-password-value');
  });

  it('classifies missing commands and permission failures', async () => {
    const missing = new SshConnection(
      new FakeExecClient((channel) => {
        channel.stderr.write('not found');
        channel.emit('exit', 127, null);
        channel.close();
      }) as never,
      'server',
      22,
      'ops',
    );
    const denied = new SshConnection(
      new FakeExecClient((channel) => {
        channel.stderr.write('Permission denied');
        channel.emit('exit', 1, null);
        channel.close();
      }) as never,
      'server',
      22,
      'ops',
    );

    await expect(missing.executeRaw("'missing'", limits())).resolves.toMatchObject({
      status: 'command_missing',
    });
    await expect(denied.executeRaw("'restricted'", limits())).resolves.toMatchObject({
      status: 'permission_denied',
    });
  });

  it('enforces output limits', async () => {
    const connection = new SshConnection(
      new FakeExecClient((channel) => channel.write('0123456789')) as never,
      'server',
      22,
      'ops',
    );

    const result = await connection.executeRaw("'large-output'", {
      maxOutputBytes: 5,
      timeoutMs: 1000,
    });

    expect(result.status).toBe('truncated');
    expect(result.stdout).toBe('01234');
    expect(result.stdoutBytes).toBe(10);
  });

  it('supports timeouts and cancellation', async () => {
    const timeoutConnection = new SshConnection(
      new FakeExecClient(() => undefined) as never,
      'server',
      22,
      'ops',
    );
    const timeoutResult = await timeoutConnection.executeRaw("'sleep'", {
      maxOutputBytes: 100,
      timeoutMs: 5,
    });
    expect(timeoutResult).toMatchObject({ status: 'timeout' });
    expect(timeoutResult.errorMessage).toContain('timed out');

    const controller = new AbortController();
    controller.abort();
    const cancelledConnection = new SshConnection(
      new FakeExecClient(() => undefined) as never,
      'server',
      22,
      'ops',
    );
    await expect(
      cancelledConnection.executeRaw("'command'", {
        maxOutputBytes: 100,
        signal: controller.signal,
        timeoutMs: 1000,
      }),
    ).resolves.toMatchObject({ status: 'cancelled' });
  });
});

function limits(): { maxOutputBytes: number; timeoutMs: number } {
  return { maxOutputBytes: 1000, timeoutMs: 1000 };
}
