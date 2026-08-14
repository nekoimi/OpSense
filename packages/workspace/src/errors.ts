export class WorkspaceError extends Error {
  public readonly code: string;
  public override readonly cause: unknown;

  public constructor(code: string, message: string, cause?: unknown) {
    super(message);
    this.name = 'WorkspaceError';
    this.code = code;
    this.cause = cause;
  }
}

export class ConfigError extends Error {
  public readonly code: string;
  public override readonly cause: unknown;

  public constructor(code: string, message: string, cause?: unknown) {
    super(message);
    this.name = 'ConfigError';
    this.code = code;
    this.cause = cause;
  }
}
