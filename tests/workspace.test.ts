import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  appendJsonLine,
  createReportDirectory,
  createScanId,
  ensureRunWorkspace,
  loadConfig,
  summarizeConfig,
  writeJsonAtomic,
} from '@opsense/workspace';
import type { ConfigError } from '@opsense/workspace';
import { afterEach, describe, expect, it } from 'vitest';

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'opsense-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('local workspace', () => {
  it('creates the run and AI input directories', async () => {
    const root = await createTemporaryDirectory();
    const layout = await ensureRunWorkspace('scan-test', root);

    expect(await readdir(layout.rootDirectory)).toEqual(
      expect.arrayContaining(['reports', 'runs']),
    );
    expect(await readdir(layout.runDirectory)).toContain('ai-input');
  });

  it('atomically writes and replaces JSON files', async () => {
    const root = await createTemporaryDirectory();
    const filePath = path.join(root, 'snapshot.json');

    await writeJsonAtomic(filePath, { version: 1 });
    await writeJsonAtomic(filePath, { version: 2 });

    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({ version: 2 });
    expect((await readdir(root)).filter((entry) => entry.endsWith('.tmp'))).toEqual([]);
  });

  it('appends durable JSON lines for audit records', async () => {
    const root = await createTemporaryDirectory();
    const filePath = path.join(root, 'audit.jsonl');

    await appendJsonLine(filePath, { commandId: 'host.uname', status: 'success' });
    await appendJsonLine(filePath, { commandId: 'storage.lsblk', status: 'failed' });

    const records = (await readFile(filePath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as unknown);
    expect(records).toEqual([
      { commandId: 'host.uname', status: 'success' },
      { commandId: 'storage.lsblk', status: 'failed' },
    ]);
  });

  it('creates a default config and applies CLI overrides', async () => {
    const root = await createTemporaryDirectory();
    const loaded = await loadConfig({
      cliOverrides: { scan: { maxDirectoryDepth: 7 } },
      workspaceRoot: root,
    });

    expect(loaded.created).toBe(true);
    expect(loaded.config.scan.maxDirectoryDepth).toBe(7);
    expect(loaded.config.report.formats).toEqual(['docx']);
    expect(JSON.parse(await readFile(loaded.sourcePath, 'utf8'))).toBeDefined();
  });

  it('merges a partial config with defaults', async () => {
    const root = await createTemporaryDirectory();
    const configPath = path.join(root, 'custom-config.json');
    await writeFile(
      configPath,
      JSON.stringify({
        report: { formats: ['docx', 'markdown'] },
        ssh: { connectTimeoutMs: 5000 },
      }),
      'utf8',
    );

    const loaded = await loadConfig({ createIfMissing: false, explicitPath: configPath });

    expect(loaded.config.report.formats).toEqual(['docx', 'markdown']);
    expect(loaded.config.ssh.connectTimeoutMs).toBe(5000);
    expect(loaded.config.ssh.commandTimeoutMs).toBe(30_000);
  });

  it('rejects credentials and private key content in config', async () => {
    const root = await createTemporaryDirectory();
    const configPath = path.join(root, 'unsafe.json');
    await writeFile(configPath, JSON.stringify({ ssh: { password: 'secret' } }), 'utf8');

    await expect(
      loadConfig({ createIfMissing: false, explicitPath: configPath }),
    ).rejects.toMatchObject<Partial<ConfigError>>({ code: 'CONFIG_SECRET_FORBIDDEN' });
  });

  it('rejects invalid ranges after merging config', async () => {
    const root = await createTemporaryDirectory();
    const configPath = path.join(root, 'invalid.json');
    await writeFile(configPath, JSON.stringify({ scan: { maxDirectoryDepth: 99 } }), 'utf8');

    await expect(
      loadConfig({ createIfMissing: false, explicitPath: configPath }),
    ).rejects.toMatchObject<Partial<ConfigError>>({ code: 'CONFIG_INVALID' });
  });

  it('creates safe scan and report path segments', () => {
    const scanId = createScanId(new Date('2026-08-14T03:00:00.000Z'), '12345678-rest');
    const reportDirectory = createReportDirectory(
      '../../server.example.com',
      new Date('2026-08-14T03:00:00.000Z'),
      'C:/opsense-test',
    );

    expect(scanId).toBe('scan-20260814T030000Z-12345678');
    expect(reportDirectory).not.toContain('..');
  });

  it('produces a config summary without exposing identity file paths', async () => {
    const root = await createTemporaryDirectory();
    const loaded = await loadConfig({
      cliOverrides: { ssh: { identityFile: 'C:/keys/private-key' } },
      workspaceRoot: root,
    });

    const summary = JSON.stringify(summarizeConfig(loaded.config));
    expect(summary).toContain('identityFileConfigured');
    expect(summary).not.toContain('private-key');
  });
});
