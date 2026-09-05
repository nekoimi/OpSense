import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import { assertSchema } from '@opsense/schema';

import { WorkspaceError } from './errors.js';

export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const directory = path.dirname(filePath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );

  await mkdir(directory, { recursive: true });

  try {
    const handle = await open(temporaryPath, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }

    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw new WorkspaceError('JSON_WRITE_FAILED', `Failed to write JSON file: ${filePath}`, error);
  }
}

export async function appendJsonLine(filePath: string, value: unknown): Promise<void> {
  await appendJsonLines(filePath, [value]);
}

export async function appendJsonLines(filePath: string, values: readonly unknown[]): Promise<void> {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true });

  try {
    const handle = await open(filePath, 'a', 0o600);
    try {
      if (values.length > 0)
        await handle.writeFile(
          `${values.map((value) => JSON.stringify(value)).join('\n')}\n`,
          'utf8',
        );
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    throw new WorkspaceError(
      'JSONL_APPEND_FAILED',
      `Failed to append JSON line: ${filePath}`,
      error,
    );
  }
}

export async function readJsonLines<T>(
  filePath: string,
  schema: Parameters<typeof assertSchema>[0],
  options: { allowMissing?: boolean } = {},
): Promise<T[]> {
  let source: string;
  try {
    source = await readFile(filePath, 'utf8');
  } catch (error) {
    if (options.allowMissing === true && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw new WorkspaceError('JSONL_READ_FAILED', `Failed to read JSON lines: ${filePath}`, error);
  }
  return source
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      try {
        const value = JSON.parse(line) as unknown;
        assertSchema(schema, value);
        return value as T;
      } catch (error) {
        throw new WorkspaceError(
          'JSONL_INVALID',
          `Invalid JSON line ${index + 1}: ${filePath}`,
          error,
        );
      }
    });
}
