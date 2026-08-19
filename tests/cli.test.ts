import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createCliPasswordProvider } from '../apps/cli/src/commands/scan.js';
import { createProgram } from '../apps/cli/src/program.js';
import { createInteractiveSudoPasswordProvider } from '../apps/cli/src/sudo-password.js';

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
      'agent',
    ]);
  });

  it('exposes the M16 agent options', () => {
    const program = createProgram();
    const agent = program.commands.find((command) => command.name() === 'agent');

    expect(agent?.helpInformation()).toContain('--scan <scan-id>');
    expect(agent?.helpInformation()).toContain('--resume <agent-session-id>');
    expect(agent?.helpInformation()).toContain('--prompt <text>');
    expect(agent?.helpInformation()).toContain('--max-agent-rounds <count>');
    expect(agent?.helpInformation()).toContain('--max-probes <count>');
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

  it('reads a sudo password once without echoing it and reuses the cached value', async () => {
    const input = new PassThrough() as PassThrough & {
      isRaw: boolean;
      isTTY: boolean;
      setRawMode(mode: boolean): void;
    };
    input.isRaw = false;
    input.isTTY = true;
    input.setRawMode = vi.fn((mode: boolean) => {
      input.isRaw = mode;
    });
    const output: string[] = [];
    const provider = createInteractiveSudoPasswordProvider(input, {
      write: (value) => output.push(value),
    });

    const first = provider?.();
    input.write('sudo-password-value\r');

    await expect(first).resolves.toBe('sudo-password-value');
    await expect(provider?.()).resolves.toBe('sudo-password-value');
    expect(output.join('')).toBe('Sudo password: \n');
    expect(output.join('')).not.toContain('sudo-password-value');
    expect(input.setRawMode).toHaveBeenCalledTimes(2);
  });

  it('does not offer an interactive sudo provider without a TTY', () => {
    const input = new PassThrough() as PassThrough & { isTTY: boolean };
    input.isTTY = false;

    expect(createInteractiveSudoPasswordProvider(input)).toBeUndefined();
  });
});
