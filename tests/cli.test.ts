import { afterEach, describe, expect, it, vi } from 'vitest';

import { createCliPasswordProvider } from '../apps/cli/src/commands/scan.js';
import { createProgram } from '../apps/cli/src/program.js';

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

describe('opsense CLI skeleton', () => {
  it('registers the M0 commands', () => {
    const program = createProgram();

    expect(program.commands.map((command) => command.name())).toEqual([
      'scan',
      'analyze',
      'report',
      'inspect',
    ]);
  });

  it('exposes version and help information', () => {
    const program = createProgram();

    expect(program.version()).toBe('0.1.0');
    expect(program.helpInformation()).toContain('Inspect a Linux server');
  });

  it('exposes the M9 analyze options', () => {
    const program = createProgram();
    const analyze = program.commands.find((command) => command.name() === 'analyze');

    expect(analyze?.helpInformation()).toContain('--scan <scan-id>');
    expect(analyze?.helpInformation()).toContain('--provider <provider>');
    expect(analyze?.helpInformation()).toContain('--thread-id <thread-id>');
  });

  it('exposes the M3 scan connection options', () => {
    const program = createProgram();
    const scan = program.commands.find((command) => command.name() === 'scan');

    expect(scan?.helpInformation()).toContain('--accept-new-host-key');
    expect(scan?.helpInformation()).toContain('--identity <path>');
    expect(scan?.helpInformation()).toContain('--password <password>');
  });

  it('keeps a CLI password in an in-memory provider', async () => {
    const provider = createCliPasswordProvider('temporary-password');

    await expect(provider?.()).resolves.toBe('temporary-password');
    expect(createCliPasswordProvider(undefined)).toBeUndefined();
  });
});
