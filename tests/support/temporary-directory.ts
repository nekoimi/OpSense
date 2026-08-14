import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach } from 'vitest';

const temporaryDirectories: string[] = [];

export async function createTestDirectory(): Promise<string> {
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
