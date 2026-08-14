import type {
  ComposeProjectRecord,
  ContainerRecord,
  EvidenceRecord,
  ProcessRecord,
  SocketRecord,
  SystemdUnitRecord,
} from '@opsense/schema';
import { getCommandSpec, toCollectionStatus } from '@opsense/ssh';
import type { CommandExecutionResult, SafeCommandExecutor } from '@opsense/ssh';

import {
  buildComposeProjects,
  minimalContainer,
  parseDockerInspect,
  parseDockerPs,
  parseDockerPsBasic,
} from './docker.js';
import type { DockerPsSummary } from './docker.js';
import {
  associateSocketContainers,
  parseNetstatSockets,
  parseProcessList,
  parseSsSockets,
} from './runtime.js';
import { parseSystemdUnits, parseUnitDetails, parseUnitFiles, parseUnitList } from './systemd.js';
import type { ProbeAttempt } from './probe.js';

interface M4Attempt extends ProbeAttempt {
  evidenceId?: string;
}

export const M4_COMMAND_CONCURRENCY = 4;

const M4_BASE_COMMAND_IDS = [
  'service.systemd-units',
  'service.systemd-files',
  'service.systemd-details',
  'process.list',
  'process.links',
  'process.passwd',
  'network.sockets',
  'docker.info',
  'docker.ps',
] as const;

const SUDO_COMMANDS = new Set([
  'process.links',
  'network.sockets',
  'network.sockets-netstat',
  'docker.info',
  'docker.ps',
  'docker.ps-basic',
  'docker.inspect',
  'docker.compose-ls',
  'docker-compose.ls',
]);

export interface M4CollectionOptions {
  commandTimeoutMs?: number;
  maxOutputBytes?: number;
  now?: () => Date;
  opsenseVersion: string;
  signal?: AbortSignal;
  useSudo?: boolean;
}

export interface M4CollectionResult {
  composeProjects: ComposeProjectRecord[];
  containers: ContainerRecord[];
  evidence: EvidenceRecord[];
  processes: ProcessRecord[];
  sockets: SocketRecord[];
  systemdUnits: SystemdUnitRecord[];
  unknowns: string[];
}

export async function collectM4Snapshot(
  executor: SafeCommandExecutor,
  options: M4CollectionOptions,
): Promise<M4CollectionResult> {
  const baseEntries = await mapWithConcurrency(
    M4_BASE_COMMAND_IDS,
    M4_COMMAND_CONCURRENCY,
    async (commandId) => [commandId, await executeCommand(executor, commandId, options)] as const,
  );
  const results = new Map(baseEntries);
  const processLinksResult = normalizePartialFindResult(results.get('process.links'));
  if (processLinksResult !== undefined) results.set('process.links', processLinksResult);
  const attempts: M4Attempt[] = [...results.values()].map((result) => ({ result }));
  const unknowns: string[] = [];
  const collectedAt = (options.now ?? (() => new Date()))().toISOString();

  const processListResult = results.get('process.list');
  const processes = parseOrFallback(
    processListResult?.status === 'success' ? processListResult : undefined,
    attempts,
    unknowns,
    'process.list',
    () => {
      const parsed = parseProcessList(
        processListResult?.stdout ?? '',
        processLinksResult?.status === 'success' ? processLinksResult.stdout : '',
        successfulOutput(results, 'process.passwd'),
        { links: evidenceId('process.links'), list: evidenceId('process.list') },
        collectedAt,
      );
      if ((processListResult?.stdout.trim().length ?? 0) > 0 && parsed.length === 0) {
        throw new Error('process list output does not contain parseable processes.');
      }
      return parsed;
    },
    [],
  );
  if (
    processLinksResult?.status !== 'success' ||
    (processes.length > 0 && processLinksResult.stdout.trim().length === 0)
  ) {
    unknowns.push(`process.links: ${processLinksResult?.status ?? 'failed'}`);
  }

  const systemdDetails = await collectSystemdDetails(
    executor,
    results,
    attempts,
    options,
    unknowns,
  );
  const systemdUnits = parseOptional(
    attempts,
    'service.systemd',
    () =>
      parseSystemdUnits(
        successfulOutput(results, 'service.systemd-units'),
        successfulOutput(results, 'service.systemd-files'),
        systemdDetails.source,
        {
          details: evidenceId('service.systemd-details'),
          detailsByUnit: systemdDetails.evidenceIds,
          files: evidenceId('service.systemd-files'),
          units: evidenceId('service.systemd-units'),
        },
      ),
    [],
  );

  let sockets = await collectSockets(executor, results, attempts, options, unknowns);
  if (sockets.length > 0 && sockets.every((socket) => socket.processIds.length === 0)) {
    unknowns.push('network.sockets: process ownership unavailable');
  }
  const docker = await collectDocker(executor, results, attempts, options, unknowns);
  sockets = associateSocketContainers(sockets, processes, docker.containers);

  return {
    composeProjects: docker.composeProjects,
    containers: docker.containers,
    evidence: attempts.map((attempt) =>
      createCommandEvidence(
        attempt,
        options.opsenseVersion,
        attempt.evidenceId ?? evidenceId(attempt.result.commandId),
      ),
    ),
    processes,
    sockets,
    systemdUnits,
    unknowns,
  };
}

async function collectSystemdDetails(
  executor: SafeCommandExecutor,
  results: ReadonlyMap<string, CommandExecutionResult>,
  attempts: M4Attempt[],
  options: M4CollectionOptions,
  unknowns: string[],
): Promise<{ evidenceIds: Map<string, string>; source: string }> {
  const units = parseUnitList(successfulOutput(results, 'service.systemd-units'));
  const files = parseUnitFiles(successfulOutput(results, 'service.systemd-files'));
  const bulkSource = successfulOutput(results, 'service.systemd-details');
  const bulkDetails = parseUnitDetails(bulkSource);
  const names = [...new Set([...units.keys(), ...files.keys()])];
  const evidenceIds = new Map<string, string>(
    [...bulkDetails.keys()].map((name) => [name, evidenceId('service.systemd-details')]),
  );
  const missingNames = names.filter(
    (name) => !bulkDetails.has(name) && !name.endsWith('@.service'),
  );
  const detailSources = await mapWithConcurrency(
    missingNames,
    M4_COMMAND_CONCURRENCY,
    async (unitName) => {
      const result = await executeCommand(executor, 'service.systemd-show', options, { unitName });
      const unitEvidenceId = evidenceId(`service.systemd-show:${safeIdPart(unitName)}`);
      attempts.push({ evidenceId: unitEvidenceId, result });
      if (result.status !== 'success') {
        unknowns.push(`service.systemd-show:${unitName}: ${result.status}`);
        return '';
      }
      evidenceIds.set(unitName, unitEvidenceId);
      return result.stdout;
    },
  );
  return {
    evidenceIds,
    source: [bulkSource, ...detailSources]
      .filter((source) => source.trim().length > 0)
      .join('\n\n'),
  };
}

async function collectSockets(
  executor: SafeCommandExecutor,
  results: Map<string, CommandExecutionResult>,
  attempts: M4Attempt[],
  options: M4CollectionOptions,
  unknowns: string[],
): Promise<SocketRecord[]> {
  const primary = results.get('network.sockets');
  if (primary?.status === 'success') {
    try {
      const parsed = parseSsSockets(primary.stdout, evidenceId(primary.commandId));
      if (primary.stdout.trim().length > 0 && parsed.length === 0) {
        throw new Error('ss output does not contain parseable sockets.');
      }
      return parsed;
    } catch (error) {
      markParseError(attempts, primary, error);
    }
  }

  const fallback = await executeCommand(executor, 'network.sockets-netstat', options);
  results.set(fallback.commandId, fallback);
  attempts.push({ result: fallback });
  if (fallback.status === 'success') {
    try {
      const parsed = parseNetstatSockets(fallback.stdout, evidenceId(fallback.commandId));
      if (fallback.stdout.trim().length > 0 && parsed.length === 0) {
        throw new Error('netstat output does not contain parseable sockets.');
      }
      return parsed;
    } catch (error) {
      markParseError(attempts, fallback, error);
    }
  }
  unknowns.push(
    `network.sockets: all variants failed (network.sockets=${primary?.status ?? 'failed'}, network.sockets-netstat=${fallback.status})`,
  );
  return [];
}

async function collectDocker(
  executor: SafeCommandExecutor,
  results: Map<string, CommandExecutionResult>,
  attempts: M4Attempt[],
  options: M4CollectionOptions,
  unknowns: string[],
): Promise<{ composeProjects: ComposeProjectRecord[]; containers: ContainerRecord[] }> {
  let psResult = results.get('docker.ps');
  const infoResult = results.get('docker.info');
  const dockerMissing = [psResult, infoResult].every(
    (result) => result?.status === 'command_missing',
  );
  if (dockerMissing) return { composeProjects: [], containers: [] };

  let summaries = parseDockerSummaries(psResult, attempts, parseDockerPs);
  if (summaries === undefined || psResult === undefined) {
    const fallback = await executeCommand(executor, 'docker.ps-basic', options);
    results.set(fallback.commandId, fallback);
    attempts.push({ result: fallback });
    psResult = fallback;
    summaries = parseDockerSummaries(fallback, attempts, parseDockerPsBasic);
  }
  if (summaries === undefined || psResult === undefined) {
    const permissionDenied =
      psResult?.status === 'permission_denied' || infoResult?.status === 'permission_denied';
    unknowns.push(
      permissionDenied
        ? 'docker: permission_denied'
        : `docker.ps: all variants failed (docker.ps=${results.get('docker.ps')?.status ?? 'failed'}, docker.ps-basic=${results.get('docker.ps-basic')?.status ?? 'failed'})`,
    );
    return { composeProjects: [], containers: [] };
  }

  const dockerListEvidenceId = evidenceId(psResult.commandId);

  const containers = await mapWithConcurrency(
    summaries,
    M4_COMMAND_CONCURRENCY,
    async (summary): Promise<ContainerRecord> => {
      const result = await executeCommand(executor, 'docker.inspect', options, {
        containerId: summary.id,
      });
      const inspectId = evidenceId(`docker.inspect:${summary.id.toLowerCase()}`);
      attempts.push({ evidenceId: inspectId, result });
      if (result.status !== 'success') {
        unknowns.push(`docker.inspect:${shortId(summary.id)}: ${result.status}`);
        return minimalContainer(summary, dockerListEvidenceId);
      }
      try {
        return parseDockerInspect(result.stdout, inspectId, summary);
      } catch (error) {
        markParseError(attempts, result, error);
        unknowns.push(`docker.inspect:${shortId(summary.id)}: parsing_failed`);
        return minimalContainer(summary, dockerListEvidenceId);
      }
    },
  );

  const composeResult = await collectComposeList(executor, attempts, options);
  const composeProjects = parseOptional(
    attempts,
    'docker.compose-ls',
    () =>
      buildComposeProjects(
        containers,
        composeResult?.status === 'success' ? composeResult.stdout : undefined,
        composeResult?.status === 'success' ? evidenceId(composeResult.commandId) : undefined,
      ),
    buildComposeProjects(containers, undefined, undefined),
  );
  return { composeProjects, containers };
}

function parseDockerSummaries(
  result: CommandExecutionResult | undefined,
  attempts: M4Attempt[],
  parse: (source: string) => DockerPsSummary[],
): DockerPsSummary[] | undefined {
  if (result?.status !== 'success') return undefined;
  try {
    return parse(result.stdout);
  } catch (error) {
    markParseError(attempts, result, error);
    return undefined;
  }
}

async function collectComposeList(
  executor: SafeCommandExecutor,
  attempts: M4Attempt[],
  options: M4CollectionOptions,
): Promise<CommandExecutionResult | undefined> {
  for (const commandId of ['docker.compose-ls', 'docker-compose.ls']) {
    const result = await executeCommand(executor, commandId, options);
    attempts.push({ result });
    if (result.status === 'success') return result;
  }
  return undefined;
}

async function executeCommand(
  executor: SafeCommandExecutor,
  commandId: string,
  options: M4CollectionOptions,
  parameters: Readonly<Record<string, string>> = {},
): Promise<CommandExecutionResult> {
  const spec = getCommandSpec(commandId);
  return executor.execute(spec, parameters, {
    maxOutputBytes:
      options.maxOutputBytes === undefined
        ? spec.maxOutputBytes
        : Math.min(spec.maxOutputBytes, options.maxOutputBytes),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    timeoutMs:
      options.commandTimeoutMs === undefined
        ? spec.timeoutMs
        : Math.min(spec.timeoutMs, options.commandTimeoutMs),
    ...(options.useSudo === true && SUDO_COMMANDS.has(commandId) ? { useSudo: true } : {}),
  });
}

function parseOrFallback<T>(
  result: CommandExecutionResult | undefined,
  attempts: M4Attempt[],
  unknowns: string[],
  name: string,
  parse: () => T,
  fallback: T,
): T {
  if (result === undefined) {
    unknowns.push(`${name}: failed`);
    return fallback;
  }
  try {
    return parse();
  } catch (error) {
    markParseError(attempts, result, error);
    unknowns.push(`${name}: parsing_failed`);
    return fallback;
  }
}

function parseOptional<T>(attempts: M4Attempt[], name: string, parse: () => T, fallback: T): T {
  try {
    return parse();
  } catch (error) {
    const related = attempts.find((attempt) => attempt.result.commandId.startsWith(name));
    if (related !== undefined) related.parseError = errorMessage(error);
    return fallback;
  }
}

function markParseError(
  attempts: M4Attempt[],
  result: CommandExecutionResult,
  error: unknown,
): void {
  const attempt = [...attempts].reverse().find((item) => item.result === result);
  if (attempt !== undefined) attempt.parseError = errorMessage(error);
}

function normalizePartialFindResult(
  result: CommandExecutionResult | undefined,
): CommandExecutionResult | undefined {
  return result?.exitCode === 1 && result.stdout.trim().length > 0
    ? { ...result, status: 'success' }
    : result;
}

function successfulOutput(
  results: ReadonlyMap<string, CommandExecutionResult>,
  commandId: string,
): string {
  const result = results.get(commandId);
  return result?.status === 'success' ? result.stdout : '';
}

function createCommandEvidence(
  attempt: M4Attempt,
  opsenseVersion: string,
  id: string,
): EvidenceRecord {
  const result = attempt.result;
  const status = attempt.parseError === undefined ? toCollectionStatus(result.status) : 'failed';
  const message = (attempt.parseError ?? result.errorMessage ?? result.stderr).trim().slice(0, 500);
  return {
    collectedAt: result.finishedAt,
    commandId: result.commandId,
    id,
    kind: 'command_output',
    opsenseVersion,
    sensitivity: 'internal',
    source: result.commandId,
    status,
    value: {
      exitCode: result.exitCode ?? null,
      parseFailed: attempt.parseError !== undefined,
      stderrBytes: result.stderrBytes,
      stdoutBytes: result.stdoutBytes,
      truncated: result.status === 'truncated',
    },
    ...(status === 'success' || message.length === 0 ? {} : { message }),
  };
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const runWorker = async (): Promise<void> => {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      const value = values[index];
      if (value !== undefined) results[index] = await worker(value);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, runWorker));
  return results;
}

function evidenceId(value: string): string {
  return `evidence:${value}`;
}

function shortId(value: string): string {
  return value.slice(0, 12).toLowerCase();
}

function safeIdPart(value: string): string {
  const normalized = [...value]
    .map((character) =>
      /[A-Za-z0-9._:-]/.test(character)
        ? character
        : `_${character.codePointAt(0)?.toString(16) ?? '0'}_`,
    )
    .join('')
    .replace(/^[_:.-]+/, '');
  return normalized || 'unknown';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
