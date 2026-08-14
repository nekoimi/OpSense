export const ExitCode = {
  Success: 0,
  GeneralError: 1,
  InvalidUsage: 2,
  NotImplemented: 3,
  Interrupted: 130,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];
