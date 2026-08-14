import { SshError } from '@opsense/ssh';

import { WorkflowInterruptedError } from './workflows/errors.js';

export const ExitCode = {
  Success: 0,
  GeneralError: 1,
  InvalidUsage: 2,
  NotImplemented: 3,
  Interrupted: 130,
  ScanPartial: 4,
  AiDegraded: 5,
  ConnectionFailed: 10,
  AuthenticationFailed: 11,
  ReportFailed: 20,
  CodexUnavailable: 30,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

export function exitCodeForError(error: unknown, fallback = ExitCode.GeneralError): ExitCodeValue {
  if (error instanceof WorkflowInterruptedError) return ExitCode.Interrupted;
  if (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'commander.invalidArgument'
  ) {
    return ExitCode.InvalidUsage;
  }
  if (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'CODEX_UNAVAILABLE'
  ) {
    return ExitCode.CodexUnavailable;
  }
  if (error instanceof SshError) {
    if (error.code === 'SSH_CONNECTION_ABORTED') return ExitCode.Interrupted;
    if (
      error.code === 'SSH_AUTH_MISSING' ||
      error.code === 'SSH_AUTH_FAILED' ||
      /authentication|auth method|all configured authentication methods failed/i.test(
        error.message,
      ) ||
      (error.cause !== undefined &&
        typeof error.cause === 'object' &&
        error.cause !== null &&
        'level' in error.cause &&
        error.cause.level === 'client-authentication')
    ) {
      return ExitCode.AuthenticationFailed;
    }
    return ExitCode.ConnectionFailed;
  }
  return fallback;
}
