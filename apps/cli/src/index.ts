#!/usr/bin/env node

import { ExitCode } from './exit-code.js';
import { run } from './program.js';

try {
  await run();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Unexpected error: ${message}\n`);
  process.exitCode = ExitCode.GeneralError;
}
