export class SshError extends Error {
  public readonly code: string;
  public override readonly cause: unknown;

  public constructor(code: string, message: string, cause?: unknown) {
    super(message);
    this.name = 'SshError';
    this.code = code;
    this.cause = cause;
  }
}

export class UnknownHostKeyError extends SshError {
  public constructor(host: string, port: number, fingerprint: string) {
    super(
      'SSH_HOST_KEY_UNKNOWN',
      `No trusted SSH host key exists for ${host}:${port}. Presented fingerprint: ${fingerprint}`,
    );
    this.name = 'UnknownHostKeyError';
  }
}

export class HostKeyMismatchError extends SshError {
  public constructor(host: string, port: number, expected: string, actual: string) {
    super(
      'SSH_HOST_KEY_MISMATCH',
      `SSH host key mismatch for ${host}:${port}. Expected ${expected}, received ${actual}.`,
    );
    this.name = 'HostKeyMismatchError';
  }
}

export class CommandSpecError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = 'CommandSpecError';
    this.code = code;
  }
}
