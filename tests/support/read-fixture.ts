import { readFile } from 'node:fs/promises';

export function readFixture(relativePath: string): Promise<string> {
  return readFile(new URL(`../../fixtures/${relativePath}`, import.meta.url), 'utf8');
}
