import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export async function hashFiles(files: readonly string[]): Promise<string> {
  const hash = createHash('sha256');
  for (const file of files) {
    const content = await readFile(file);
    hash.update(String(Buffer.byteLength(file)));
    hash.update(':');
    hash.update(file);
    hash.update(':');
    hash.update(String(content.byteLength));
    hash.update(':');
    hash.update(content);
  }
  return hash.digest('hex');
}
