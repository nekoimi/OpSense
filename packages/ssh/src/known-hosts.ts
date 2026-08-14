import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { writeJsonAtomic } from '@opsense/workspace';

import { HostKeyMismatchError, SshError, UnknownHostKeyError } from './errors.js';

export interface KnownHostEntry {
  fingerprint: string;
  firstSeenAt: string;
  host: string;
  lastSeenAt: string;
  port: number;
}

interface KnownHostsDocument {
  entries: Record<string, KnownHostEntry>;
  version: 1;
}

const EMPTY_KNOWN_HOSTS: KnownHostsDocument = { entries: {}, version: 1 };

export function fingerprintHostKey(key: Buffer): string {
  const digest = createHash('sha256').update(key).digest('base64').replace(/=+$/g, '');
  return `SHA256:${digest}`;
}

export class KnownHostsStore {
  public constructor(private readonly filePath: string) {}

  public async find(host: string, port: number): Promise<KnownHostEntry | undefined> {
    const document = await this.read();
    return document.entries[toHostKey(host, port)];
  }

  public async remember(host: string, port: number, fingerprint: string, now: Date): Promise<void> {
    const document = await this.read();
    const key = toHostKey(host, port);
    const existing = document.entries[key];
    document.entries[key] = {
      fingerprint,
      firstSeenAt: existing?.firstSeenAt ?? now.toISOString(),
      host,
      lastSeenAt: now.toISOString(),
      port,
    };
    await writeJsonAtomic(this.filePath, document);
  }

  private async read(): Promise<KnownHostsDocument> {
    try {
      const source = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(source) as unknown;
      if (!isKnownHostsDocument(parsed)) {
        throw new SshError('SSH_KNOWN_HOSTS_INVALID', `Invalid known-hosts file: ${this.filePath}`);
      }
      return parsed;
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return { entries: {}, version: EMPTY_KNOWN_HOSTS.version };
      }
      if (error instanceof SshError) {
        throw error;
      }
      throw new SshError(
        'SSH_KNOWN_HOSTS_READ_FAILED',
        `Failed to read known-hosts file: ${this.filePath}`,
        error,
      );
    }
  }
}

export class HostKeyPolicy {
  private acceptedFingerprint?: string;
  private rejection?: SshError;

  public constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly expectedFingerprint: string | undefined,
    private readonly strict: boolean,
    private readonly acceptNew: boolean,
  ) {}

  public verify = (key: Buffer): boolean => {
    const fingerprint = fingerprintHostKey(key);

    if (!this.strict) {
      return true;
    }

    if (this.expectedFingerprint === undefined) {
      if (this.acceptNew) {
        this.acceptedFingerprint = fingerprint;
        return true;
      }
      this.rejection = new UnknownHostKeyError(this.host, this.port, fingerprint);
      return false;
    }

    if (this.expectedFingerprint !== fingerprint) {
      this.rejection = new HostKeyMismatchError(
        this.host,
        this.port,
        this.expectedFingerprint,
        fingerprint,
      );
      return false;
    }

    this.acceptedFingerprint = fingerprint;
    return true;
  };

  public getAcceptedFingerprint(): string | undefined {
    return this.acceptedFingerprint;
  }

  public getRejection(): SshError | undefined {
    return this.rejection;
  }
}

function toHostKey(host: string, port: number): string {
  return `${host.toLowerCase()}:${port}`;
}

function isKnownHostsDocument(value: unknown): value is KnownHostsDocument {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<KnownHostsDocument>;
  return (
    candidate.version === 1 && candidate.entries !== null && typeof candidate.entries === 'object'
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
