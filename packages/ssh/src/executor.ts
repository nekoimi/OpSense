import type { CollectionStatus } from '@opsense/schema';

import { getCommandSpec } from './command-catalog.js';
import { renderCommand } from './command-spec.js';
import type { CommandParameterValue, CommandSpec, RenderedCommand } from './command-spec.js';
import type {
  RawCommandOptions,
  RawCommandResult,
  RawExecutionStatus,
  SshConnection,
} from './connection.js';

export interface CommandAuditRecord {
  command: string;
  commandId: string;
  durationMs: number;
  exitCode?: number;
  finishedAt: string;
  status: RawExecutionStatus;
  stderrBytes: number;
  stdoutBytes: number;
  sudoUsed: boolean;
}

export type CommandAuditSink = (record: CommandAuditRecord) => Promise<void> | void;

export interface CommandExecutionOptions {
  maxOutputBytes?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  useSudo?: boolean;
}

export interface CommandExecutionResult extends RawCommandResult {
  commandId: string;
  finishedAt: string;
  startedAt: string;
}

export interface RemoteCommandTransport {
  executeRaw(command: string, options: RawCommandOptions): Promise<RawCommandResult>;
}

export class SafeCommandExecutor {
  public constructor(
    private readonly transport: RemoteCommandTransport | SshConnection,
    private readonly auditSink?: CommandAuditSink,
  ) {}

  public executeById(
    commandId: string,
    parameters: Readonly<Record<string, CommandParameterValue>> = {},
    options: CommandExecutionOptions = {},
  ): Promise<CommandExecutionResult> {
    return this.execute(getCommandSpec(commandId), parameters, options);
  }

  public async execute(
    spec: CommandSpec,
    parameters: Readonly<Record<string, CommandParameterValue>> = {},
    options: CommandExecutionOptions = {},
  ): Promise<CommandExecutionResult> {
    const rendered = renderCommand(
      spec,
      parameters,
      options.useSudo === undefined ? {} : { useSudo: options.useSudo },
    );
    const startedAt = new Date();
    let rawResult: RawCommandResult;

    try {
      rawResult = await this.transport.executeRaw(rendered.execution, {
        maxOutputBytes: options.maxOutputBytes ?? spec.maxOutputBytes,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        timeoutMs: options.timeoutMs ?? spec.timeoutMs,
      });
    } catch (error) {
      rawResult = {
        durationMs: Date.now() - startedAt.getTime(),
        errorMessage: error instanceof Error ? error.message : String(error),
        status: 'failed',
        stderr: '',
        stderrBytes: 0,
        stdout: '',
        stdoutBytes: 0,
      };
    }

    const finishedAt = new Date();
    const result: CommandExecutionResult = {
      ...rawResult,
      commandId: spec.id,
      finishedAt: finishedAt.toISOString(),
      startedAt: startedAt.toISOString(),
    };
    await this.writeAudit(spec, rendered, rawResult, finishedAt);
    return result;
  }

  private async writeAudit(
    spec: CommandSpec,
    rendered: RenderedCommand,
    result: RawCommandResult,
    finishedAt: Date,
  ): Promise<void> {
    await this.auditSink?.({
      command: rendered.audit,
      commandId: spec.id,
      durationMs: result.durationMs,
      ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
      finishedAt: finishedAt.toISOString(),
      status: result.status,
      stderrBytes: result.stderrBytes,
      stdoutBytes: result.stdoutBytes,
      sudoUsed: rendered.sudoUsed,
    });
  }
}

export function toCollectionStatus(status: RawExecutionStatus): CollectionStatus {
  switch (status) {
    case 'success':
      return 'success';
    case 'timeout':
      return 'timeout';
    case 'truncated':
      return 'truncated';
    case 'command_missing':
      return 'command_missing';
    case 'permission_denied':
      return 'permission_denied';
    case 'cancelled':
    case 'failed':
      return 'failed';
  }
}
