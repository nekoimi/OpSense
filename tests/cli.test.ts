import { afterEach, describe, expect, it, vi } from 'vitest';

import { ExitCode } from '../apps/cli/src/exit-code.js';
import type { Logger, LoggerFactory } from '../apps/cli/src/logger.js';
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

  it('returns a clear placeholder result for unfinished commands', async () => {
    const logger: Logger = {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
    };
    const loggerFactory: LoggerFactory = () => logger;
    const program = createProgram({ loggerFactory });

    await program.parseAsync(['node', 'opsense', 'analyze']);

    expect(logger.error).toHaveBeenCalledWith(
      "The 'analyze' command is not implemented yet (M0 skeleton).",
    );
    expect(process.exitCode).toBe(ExitCode.NotImplemented);
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
