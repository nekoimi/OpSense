import type {
  ComposeProjectRecord,
  ContainerRecord,
  EvidenceRecord,
  ProcessRecord,
  SocketRecord,
  SystemdUnitRecord,
} from '@opsense/schema';
import { mapWithConcurrency } from '@opsense/collection-runtime';
import type { CollectionScheduler } from '@opsense/collection-runtime';
import { getCommandSpec, toCollectionStatus } from '@opsense/ssh';
import type {
  CommandExecutionResult,
  CommandParameterValue,
  SafeCommandExecutor,
} from '@opsense/ssh';

import {
  buildComposeProjects,
  minimalContainer,
  parseDockerInspectBatch,
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
export const SYSTEMD_DETAIL_BATCH_SIZE = 48;
export const DOCKER_INSPECT_BATCH_SIZE = 48;

const M4_BASE_COMMAND_IDS = [
  'service.systemd-units',
  'service.systemd-files',
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
  'docker.inspect-batch',
  'docker.compose-ls',
  'docker-compose.ls',
]);

export interface M4CollectionOptions {
  commandTimeoutMs?: number;
  maxOutputBytes?: number;
  now?: () => Date;
  opsenseVersion: string;
  scheduler?: CollectionScheduler;
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
    options.scheduler,
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
          details: evidenceId('service.systemd-show-batch'),
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
  const names = [...new Set([...units.keys(), ...files.keys()])]
    .filter((name) => !name.endsWith('@.service'))
    .sort();
  const batches = await mapWithConcurrency(
    chunk(names, SYSTEMD_DETAIL_BATCH_SIZE),
    M4_COMMAND_CONCURRENCY,
    (unitNames) => collectSystemdDetailBatch(executor, unitNames, attempts, options, unknowns),
    options.scheduler,
  );
  return {
    evidenceIds: new Map(batches.flatMap((batch) => [...batch.evidenceIds.entries()])),
    source: batches
      .flatMap((batch) => batch.sources)
      .filter((source) => source.trim().length > 0)
      .join('\n\n'),
  };
}

interface SystemdDetailBatchResult {
  evidenceIds: Map<string, string>;
  sources: string[];
}

async function collectSystemdDetailBatch(
  executor: SafeCommandExecutor,
  unitNames: readonly string[],
  attempts: M4Attempt[],
  options: M4CollectionOptions,
  unknowns: string[],
): Promise<SystemdDetailBatchResult> {
  const result = await executeCommand(executor, 'service.systemd-show-batch', options, {
    unitNames,
  });
  const batchEvidenceId = evidenceId(batchId('service.systemd-show-batch', unitNames));
  attempts.push({ evidenceId: batchEvidenceId, result });
  if (result.status !== 'success') {
    if (unitNames.length > 1) {
      const [left, right] = splitBatch(unitNames);
      return mergeSystemdBatches(
        await collectSystemdDetailBatch(executor, left, attempts, options, unknowns),
        await collectSystemdDetailBatch(executor, right, attempts, options, unknowns),
      );
    }
    unknowns.push(`service.systemd-show:${unitNames[0] ?? 'unknown'}: ${result.status}`);
    return { evidenceIds: new Map(), sources: [] };
  }

  const requestedNames = new Set(unitNames);
  const details = new Map(
    [...parseUnitDetails(result.stdout)].filter(([name]) => requestedNames.has(name)),
  );
  const evidenceIds = new Map([...details.keys()].map((name) => [name, batchEvidenceId]));
  const missing = unitNames.filter((name) => !details.has(name));
  const current = { evidenceIds, sources: [formatUnitDetails(details)] };
  if (missing.length === 0) return current;
  if (unitNames.length === 1) {
    unknowns.push(`service.systemd-show:${unitNames[0] ?? 'unknown'}: detail_missing`);
    return current;
  }
  if (missing.length === unitNames.length) {
    const [left, right] = splitBatch(unitNames);
    return mergeSystemdBatches(
      await collectSystemdDetailBatch(executor, left, attempts, options, unknowns),
      await collectSystemdDetailBatch(executor, right, attempts, options, unknowns),
    );
  }
  return mergeSystemdBatches(
    current,
    await collectSystemdDetailBatch(executor, missing, attempts, options, unknowns),
  );
}

function mergeSystemdBatches(
  left: SystemdDetailBatchResult,
  right: SystemdDetailBatchResult,
): SystemdDetailBatchResult {
  return {
    evidenceIds: new Map([...left.evidenceIds, ...right.evidenceIds]),
    sources: [...left.sources, ...right.sources],
  };
}

function formatUnitDetails(details: ReadonlyMap<string, Record<string, string>>): string {
  return [...details.values()]
    .map((values) =>
      Object.entries(values)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n'),
    )
    .join('\n\n');
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

  const fallback = await executeStandaloneCommand(executor, 'network.sockets-netstat', options);
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
    const fallback = await executeStandaloneCommand(executor, 'docker.ps-basic', options);
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

  const containers = (
    await mapWithConcurrency(
      chunk(summaries, DOCKER_INSPECT_BATCH_SIZE),
      M4_COMMAND_CONCURRENCY,
      (batch) =>
        collectDockerInspectBatch(
          executor,
          batch,
          dockerListEvidenceId,
          attempts,
          options,
          unknowns,
        ),
      options.scheduler,
    )
  ).flat();

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

async function collectDockerInspectBatch(
  executor: SafeCommandExecutor,
  summaries: readonly DockerPsSummary[],
  dockerListEvidenceId: string,
  attempts: M4Attempt[],
  options: M4CollectionOptions,
  unknowns: string[],
): Promise<ContainerRecord[]> {
  const result = await executeCommand(executor, 'docker.inspect-batch', options, {
    containerIds: summaries.map((summary) => summary.id),
  });
  const inspectId = evidenceId(
    batchId(
      'docker.inspect-batch',
      summaries.map((summary) => summary.id.toLowerCase()),
    ),
  );
  attempts.push({ evidenceId: inspectId, result });
  if (result.status !== 'success') {
    return recoverDockerBatch(
      executor,
      summaries,
      dockerListEvidenceId,
      attempts,
      options,
      unknowns,
      result.status,
    );
  }

  let parsed: ContainerRecord[];
  try {
    parsed = parseDockerInspectBatch(result.stdout, inspectId, summaries);
  } catch (error) {
    markParseError(attempts, result, error);
    return recoverDockerBatch(
      executor,
      summaries,
      dockerListEvidenceId,
      attempts,
      options,
      unknowns,
      'parsing_failed',
    );
  }

  const parsedIds = new Set(parsed.map((container) => container.id.slice('container:'.length)));
  const missing = summaries.filter((summary) => !parsedIds.has(summary.id.toLowerCase()));
  if (missing.length === 0) return parsed;
  if (missing.length === summaries.length) {
    return recoverDockerBatch(
      executor,
      summaries,
      dockerListEvidenceId,
      attempts,
      options,
      unknowns,
      'detail_missing',
    );
  }
  return [
    ...parsed,
    ...(await collectDockerInspectBatch(
      executor,
      missing,
      dockerListEvidenceId,
      attempts,
      options,
      unknowns,
    )),
  ];
}

async function recoverDockerBatch(
  executor: SafeCommandExecutor,
  summaries: readonly DockerPsSummary[],
  dockerListEvidenceId: string,
  attempts: M4Attempt[],
  options: M4CollectionOptions,
  unknowns: string[],
  failure: string,
): Promise<ContainerRecord[]> {
  if (summaries.length > 1) {
    const [left, right] = splitBatch(summaries);
    return [
      ...(await collectDockerInspectBatch(
        executor,
        left,
        dockerListEvidenceId,
        attempts,
        options,
        unknowns,
      )),
      ...(await collectDockerInspectBatch(
        executor,
        right,
        dockerListEvidenceId,
        attempts,
        options,
        unknowns,
      )),
    ];
  }
  const summary = summaries[0];
  if (summary === undefined) return [];
  unknowns.push(`docker.inspect:${shortId(summary.id)}: ${failure}`);
  return [minimalContainer(summary, dockerListEvidenceId)];
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
    const result = await executeStandaloneCommand(executor, commandId, options);
    attempts.push({ result });
    if (result.status === 'success') return result;
  }
  return undefined;
}

async function executeCommand(
  executor: SafeCommandExecutor,
  commandId: string,
  options: M4CollectionOptions,
  parameters: Readonly<Record<string, CommandParameterValue>> = {},
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

async function executeStandaloneCommand(
  executor: SafeCommandExecutor,
  commandId: string,
  options: M4CollectionOptions,
  parameters: Readonly<Record<string, CommandParameterValue>> = {},
): Promise<CommandExecutionResult> {
  if (options.scheduler === undefined) {
    return executeCommand(executor, commandId, options, parameters);
  }
  const [scheduled] = await options.scheduler.run(
    [
      {
        execute: () => executeCommand(executor, commandId, options, parameters),
        taskId: `command:${commandId}`,
      },
    ],
    options.signal === undefined ? {} : { signal: options.signal },
  );
  if (scheduled?.status === 'success' && scheduled.value !== undefined) return scheduled.value;
  const at = (options.now ?? (() => new Date()))().toISOString();
  return {
    commandId,
    durationMs: scheduled?.durationMs ?? 0,
    errorMessage: scheduled?.error ?? 'Command was not scheduled.',
    finishedAt: at,
    startedAt: at,
    status: scheduled?.status === 'cancelled' ? 'cancelled' : 'failed',
    stderr: '',
    stderrBytes: 0,
    stdout: '',
    stdoutBytes: 0,
  };
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

function evidenceId(value: string): string {
  return `evidence:${value}`;
}

function shortId(value: string): string {
  return value.slice(0, 12).toLowerCase();
}

function chunk<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function splitBatch<T>(values: readonly T[]): [readonly T[], readonly T[]] {
  const middle = Math.ceil(values.length / 2);
  return [values.slice(0, middle), values.slice(middle)];
}

function batchId(prefix: string, values: readonly string[]): string {
  const first = safeIdPart(values[0] ?? 'empty');
  const last = safeIdPart(values.at(-1) ?? 'empty');
  return `${prefix}:${first}:${last}:${values.length}`;
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
