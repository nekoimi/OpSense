import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  HostKeyMismatchError,
  HostKeyPolicy,
  KnownHostsStore,
  UnknownHostKeyError,
  fingerprintHostKey,
} from '@opsense/ssh';
import { describe, expect, it } from 'vitest';

import { createTestDirectory } from './support/temporary-directory.js';

describe('SSH known hosts', () => {
  it('produces OpenSSH-style SHA256 fingerprints', () => {
    expect(fingerprintHostKey(Buffer.from('host-key'))).toMatch(/^SHA256:[A-Za-z0-9+/]+$/);
  });

  it('stores and reloads trusted fingerprints', async () => {
    const root = await createTestDirectory();
    const filePath = path.join(root, 'known-hosts.json');
    const store = new KnownHostsStore(filePath);

    await store.remember('server.example.com', 22, 'SHA256:test', new Date('2026-08-14T00:00:00Z'));

    expect(await store.find('SERVER.EXAMPLE.COM', 22)).toMatchObject({
      fingerprint: 'SHA256:test',
    });
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toMatchObject({ version: 1 });
  });

  it('rejects unknown and changed host keys in strict mode', () => {
    const key = Buffer.from('presented-key');
    const fingerprint = fingerprintHostKey(key);
    const unknown = new HostKeyPolicy('server', 22, undefined, true, false);

    expect(unknown.verify(key)).toBe(false);
    expect(unknown.getRejection()).toBeInstanceOf(UnknownHostKeyError);

    const mismatch = new HostKeyPolicy('server', 22, 'SHA256:different', true, false);
    expect(mismatch.verify(key)).toBe(false);
    expect(mismatch.getRejection()).toBeInstanceOf(HostKeyMismatchError);
    expect(mismatch.getRejection()?.message).toContain(fingerprint);
  });

  it('allows explicit trust-on-first-use', () => {
    const key = Buffer.from('new-key');
    const policy = new HostKeyPolicy('server', 22, undefined, true, true);

    expect(policy.verify(key)).toBe(true);
    expect(policy.getAcceptedFingerprint()).toBe(fingerprintHostKey(key));
  });
});
