import type { DistributionFamily } from '@opsense/ssh';
import { getCommandSpec } from '@opsense/ssh';
import type { CommandExecutionResult, SafeCommandExecutor } from '@opsense/ssh';

export interface ProbeVariant<T> {
  acceptedExitCodes?: readonly number[];
  commandId: string;
  distributions: readonly DistributionFamily[];
  parse: (result: CommandExecutionResult) => T;
}

export interface ProbeSpec<T> {
  id: string;
  required: boolean;
  variants: readonly ProbeVariant<T>[];
}

export interface ProbeAttempt {
  parseError?: string;
  result: CommandExecutionResult;
}

export interface ProbeOutcome<T> {
  attempts: ProbeAttempt[];
  id: string;
  required: boolean;
  selectedCommandId?: string;
  value?: T;
}

export interface ProbeExecutionOptions {
  commandTimeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  useSudo?: (commandId: string) => boolean;
}

export async function runProbe<T>(
  executor: SafeCommandExecutor,
  spec: ProbeSpec<T>,
  distribution: DistributionFamily,
  options: ProbeExecutionOptions = {},
): Promise<ProbeOutcome<T>> {
  const attempts: ProbeAttempt[] = [];
  const variants = spec.variants.filter((variant) => variant.distributions.includes(distribution));

  for (const variant of variants) {
    if (options.signal?.aborted === true) {
      break;
    }
    const command = getCommandSpec(variant.commandId);
    const rawResult = await executor.execute(
      command,
      {},
      {
        maxOutputBytes:
          options.maxOutputBytes === undefined
            ? command.maxOutputBytes
            : Math.min(command.maxOutputBytes, options.maxOutputBytes),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        timeoutMs:
          options.commandTimeoutMs === undefined
            ? command.timeoutMs
            : Math.min(command.timeoutMs, options.commandTimeoutMs),
        ...(options.useSudo?.(variant.commandId) === true ? { useSudo: true } : {}),
      },
    );
    const result = acceptExitCode(rawResult, variant.acceptedExitCodes);
    if (result.status !== 'success') {
      attempts.push({ result });
      continue;
    }

    try {
      const value = variant.parse(result);
      attempts.push({ result });
      return {
        attempts,
        id: spec.id,
        required: spec.required,
        selectedCommandId: variant.commandId,
        value,
      };
    } catch (error) {
      attempts.push({
        parseError: error instanceof Error ? error.message : String(error),
        result,
      });
    }
  }

  return { attempts, id: spec.id, required: spec.required };
}

export function detectDistributionFamily(osRelease: string): DistributionFamily {
  const values = new Map<string, string>();
  for (const rawLine of osRelease.split(/\r?\n/)) {
    const line = rawLine.trim();
    const separator = line.indexOf('=');
    if (separator <= 0 || line.startsWith('#')) {
      continue;
    }
    values.set(
      line.slice(0, separator).trim().toUpperCase(),
      line
        .slice(separator + 1)
        .trim()
        .replace(/^(['"])(.*)\1$/, '$2')
        .toLowerCase(),
    );
  }

  const identifiers = `${values.get('ID') ?? ''} ${values.get('ID_LIKE') ?? ''}`;
  if (/\b(alpine)\b/.test(identifiers)) return 'alpine';
  if (/\b(debian|ubuntu|linuxmint|raspbian)\b/.test(identifiers)) return 'debian';
  if (/\b(rhel|fedora|centos|rocky|almalinux|ol)\b/.test(identifiers)) return 'rhel';
  return 'unknown';
}

export function probeFailureSummary(outcome: ProbeOutcome<unknown>): string | undefined {
  if (outcome.value !== undefined || !outcome.required) {
    return undefined;
  }
  if (outcome.attempts.length === 0) {
    return `${outcome.id}: no compatible command variant`;
  }
  const failures = outcome.attempts.map((attempt) =>
    attempt.parseError === undefined
      ? `${attempt.result.commandId}=${attempt.result.status}`
      : `${attempt.result.commandId}=parsing_failed`,
  );
  return `${outcome.id}: all variants failed (${failures.join(', ')})`;
}

function acceptExitCode(
  result: CommandExecutionResult,
  acceptedExitCodes: readonly number[] | undefined,
): CommandExecutionResult {
  return result.exitCode !== undefined && acceptedExitCodes?.includes(result.exitCode) === true
    ? { ...result, status: 'success' }
    : result;
}
