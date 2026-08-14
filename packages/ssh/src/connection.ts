import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';

import { createWorkspaceLayout } from '@opsense/workspace';
import type { Client, ClientChannel, ConnectConfig } from 'ssh2';

import { SshError } from './errors.js';
import { HostKeyPolicy, KnownHostsStore } from './known-hosts.js';

const require = createRequire(import.meta.url);
const SshClient = require('ssh2').Client as new () => Client;

export type RawExecutionStatus =
  | 'success'
  | 'failed'
  | 'timeout'
  | 'truncated'
  | 'cancelled'
  | 'command_missing'
  | 'permission_denied';

export interface RawCommandOptions {
  maxOutputBytes: number;
  signal?: AbortSignal;
  timeoutMs: number;
}

export interface RawCommandResult {
  durationMs: number;
  errorMessage?: string;
  exitCode?: number;
  exitSignal?: string;
  status: RawExecutionStatus;
  stderr: string;
  stderrBytes: number;
  stdout: string;
  stdoutBytes: number;
}

export interface SshConnectionOptions {
  acceptNewHostKey?: boolean;
  agentSocket?: string;
  connectTimeoutMs?: number;
  host: string;
  identityFile?: string;
  keepaliveCountMax?: number;
  keepaliveIntervalMs?: number;
  knownHostsFile?: string;
  passphraseProvider?: () => Promise<string>;
  passwordProvider?: () => Promise<string>;
  port?: number;
  signal?: AbortSignal;
  strictHostKeyChecking?: boolean;
  user: string;
  workspaceRoot?: string;
}

export interface SshConnectionDependencies {
  clientFactory?: () => Client;
  now?: () => Date;
}

export class SshConnection {
  public constructor(
    private readonly client: Client,
    public readonly host: string,
    public readonly port: number,
    public readonly user: string,
  ) {}

  public executeRaw(command: string, options: RawCommandOptions): Promise<RawCommandResult> {
    const startedAt = Date.now();

    return new Promise((resolve) => {
      let channel: ClientChannel | undefined;
      let completed = false;
      let exitCode: number | undefined;
      let exitSignal: string | undefined;
      let forcedStatus: RawExecutionStatus | undefined;
      let storedBytes = 0;
      let stderrBytes = 0;
      let stdoutBytes = 0;
      const stderrChunks: Buffer[] = [];
      const stdoutChunks: Buffer[] = [];

      const finish = (errorMessage?: string): void => {
        if (completed) {
          return;
        }
        completed = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);

        const stderr = Buffer.concat(stderrChunks).toString('utf8');
        const stdout = Buffer.concat(stdoutChunks).toString('utf8');
        const status =
          forcedStatus ?? classifyExit(exitCode, stderr.length > 0 ? stderr : (errorMessage ?? ''));
        resolve({
          durationMs: Date.now() - startedAt,
          ...(errorMessage === undefined ? {} : { errorMessage }),
          ...(exitCode === undefined ? {} : { exitCode }),
          ...(exitSignal === undefined ? {} : { exitSignal }),
          status,
          stderr,
          stderrBytes,
          stdout,
          stdoutBytes,
        });
      };

      const stopChannel = (): void => {
        try {
          channel?.signal('TERM');
        } catch {
          // Some servers do not support signal requests.
        }
        channel?.close();
      };

      const abort = (): void => {
        forcedStatus = 'cancelled';
        finish('Command execution was cancelled.');
        stopChannel();
      };

      const timer = setTimeout(() => {
        forcedStatus = 'timeout';
        finish(`Command timed out after ${options.timeoutMs} ms.`);
        stopChannel();
      }, options.timeoutMs);
      timer.unref();

      if (options.signal?.aborted === true) {
        abort();
        return;
      }
      options.signal?.addEventListener('abort', abort, { once: true });

      this.client.exec(command, (error, openedChannel) => {
        if (completed) {
          openedChannel?.close();
          return;
        }
        if (error) {
          finish(error.message);
          return;
        }

        channel = openedChannel;
        const append = (target: Buffer[], chunk: Buffer, stream: 'stderr' | 'stdout'): void => {
          if (stream === 'stdout') {
            stdoutBytes += chunk.length;
          } else {
            stderrBytes += chunk.length;
          }

          const remaining = Math.max(0, options.maxOutputBytes - storedBytes);
          if (remaining > 0) {
            const storedChunk = chunk.subarray(0, remaining);
            target.push(storedChunk);
            storedBytes += storedChunk.length;
          }

          if (chunk.length > remaining && forcedStatus === undefined) {
            forcedStatus = 'truncated';
            stopChannel();
          }
        };

        openedChannel.on('data', (chunk: Buffer) => append(stdoutChunks, chunk, 'stdout'));
        openedChannel.stderr.on('data', (chunk: Buffer) => append(stderrChunks, chunk, 'stderr'));
        openedChannel.on('exit', (code: number | null, signal: string | null) => {
          if (code !== null) {
            exitCode = code;
          }
          if (signal !== null) {
            exitSignal = signal;
          }
        });
        openedChannel.on('error', (channelError: Error) => finish(channelError.message));
        openedChannel.on('close', () => finish());
      });
    });
  }

  public close(): void {
    this.client.end();
  }
}

export async function connectSsh(
  options: SshConnectionOptions,
  dependencies: SshConnectionDependencies = {},
): Promise<SshConnection> {
  const port = options.port ?? 22;
  const now = dependencies.now ?? (() => new Date());
  const knownHostsFile =
    options.knownHostsFile ?? createWorkspaceLayout(options.workspaceRoot).knownHostsFile;
  const knownHosts = new KnownHostsStore(knownHostsFile);
  const knownHost = await knownHosts.find(options.host, port);
  const hostKeyPolicy = new HostKeyPolicy(
    options.host,
    port,
    knownHost?.fingerprint,
    options.strictHostKeyChecking ?? true,
    options.acceptNewHostKey ?? false,
  );
  const client = dependencies.clientFactory?.() ?? new SshClient();
  const config = await createConnectConfig(options, port, hostKeyPolicy.verify);

  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = (): void => {
      options.signal?.removeEventListener('abort', abort);
    };

    const rejectOnce = (error: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      const rejection = hostKeyPolicy.getRejection();
      reject(
        rejection ??
          (error instanceof SshError
            ? error
            : new SshError(
                'SSH_CONNECTION_FAILED',
                `Failed to connect to ${options.host}:${port}.`,
                error,
              )),
      );
    };

    const abort = (): void => {
      client.end();
      rejectOnce(
        new SshError(
          'SSH_CONNECTION_ABORTED',
          `SSH connection to ${options.host}:${port} was cancelled.`,
        ),
      );
    };

    if (options.signal?.aborted === true) {
      abort();
      return;
    }
    options.signal?.addEventListener('abort', abort, { once: true });

    client.on('error', rejectOnce);
    client.once('close', () => {
      rejectOnce(
        new SshError(
          'SSH_CONNECTION_CLOSED',
          `SSH connection to ${options.host}:${port} closed before authentication completed.`,
        ),
      );
    });
    client.once('ready', () => {
      void (async () => {
        const fingerprint = hostKeyPolicy.getAcceptedFingerprint();
        if (fingerprint !== undefined && fingerprint !== knownHost?.fingerprint) {
          await knownHosts.remember(options.host, port, fingerprint, now());
        }
        if (!settled) {
          settled = true;
          cleanup();
          resolve(new SshConnection(client, options.host, port, options.user));
        }
      })().catch((error: unknown) => {
        client.end();
        rejectOnce(error);
      });
    });

    client.connect(config);
  });
}

async function createConnectConfig(
  options: SshConnectionOptions,
  port: number,
  hostVerifier: (key: Buffer) => boolean,
): Promise<ConnectConfig> {
  const config: ConnectConfig = {
    host: options.host,
    hostVerifier,
    keepaliveCountMax: options.keepaliveCountMax ?? 3,
    keepaliveInterval: options.keepaliveIntervalMs ?? 15_000,
    port,
    readyTimeout: options.connectTimeoutMs ?? 10_000,
    username: options.user,
  };

  const agent = options.agentSocket ?? process.env.SSH_AUTH_SOCK;
  if (agent !== undefined && agent.length > 0) {
    config.agent = agent;
  }
  if (options.identityFile !== undefined) {
    try {
      config.privateKey = await readFile(options.identityFile);
    } catch (error) {
      throw new SshError(
        'SSH_IDENTITY_READ_FAILED',
        `Failed to read SSH identity file: ${options.identityFile}`,
        error,
      );
    }
  }
  if (options.passphraseProvider !== undefined) {
    config.passphrase = await options.passphraseProvider();
  }
  if (options.passwordProvider !== undefined) {
    config.password = await options.passwordProvider();
  }

  if (
    config.agent === undefined &&
    config.privateKey === undefined &&
    config.password === undefined
  ) {
    throw new SshError(
      'SSH_AUTH_MISSING',
      'SSH Agent, identity file, or password provider is required.',
    );
  }

  return config;
}

function classifyExit(exitCode: number | undefined, stderr: string): RawExecutionStatus {
  if (exitCode === 0) {
    return 'success';
  }
  if (/permission denied|operation not permitted/i.test(stderr)) {
    return 'permission_denied';
  }
  if (exitCode === 127) {
    return 'command_missing';
  }
  return 'failed';
}
