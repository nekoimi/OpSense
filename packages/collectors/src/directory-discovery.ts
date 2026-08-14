import type { ArtifactRecord, EvidenceRecord, PathSeedRecord } from '@opsense/schema';
import { getCommandSpec, toCollectionStatus } from '@opsense/ssh';
import type { CommandExecutionResult, SafeCommandExecutor } from '@opsense/ssh';

import {
  artifactFromEntry,
  configFormat,
  mergeArtifacts,
  parseConfigSummary,
  parseFindEntries,
  parseStatEntries,
} from './artifacts.js';
import { buildPathSeeds, isPathSeedScanEligible } from './path-seeds.js';
import type { PathSeedInput } from './path-seeds.js';

interface M5Attempt {
  commandExecuted?: boolean;
  evidenceId: string;
  kind?: EvidenceRecord['kind'];
  message?: string;
  result: CommandExecutionResult;
  source?: string;
  status?: EvidenceRecord['status'];
  value?: unknown;
}

interface SeedScanResult {
  artifacts: ArtifactRecord[];
  attempts: M5Attempt[];
  unknowns: string[];
}

export const M5_COMMAND_CONCURRENCY = 4;

export interface M5CollectionOptions {
  commandTimeoutMs?: number;
  crossFileSystems: boolean;
  maxConfigFileBytes: number;
  maxDirectoryDepth: number;
  maxFilesPerDirectory: number;
  maxOutputBytes?: number;
  opsenseVersion: string;
  signal?: AbortSignal;
  useSudo?: boolean;
}

export interface M5CollectionResult {
  artifacts: ArtifactRecord[];
  evidence: EvidenceRecord[];
  pathSeeds: PathSeedRecord[];
  unknowns: string[];
}

export async function collectM5Snapshot(
  executor: SafeCommandExecutor,
  input: PathSeedInput,
  options: M5CollectionOptions,
): Promise<M5CollectionResult> {
  const pathSeeds = buildPathSeeds(input);
  const scanResults = await mapWithConcurrency(
    pathSeeds.filter(isPathSeedScanEligible),
    M5_COMMAND_CONCURRENCY,
    (seed) => scanSeed(executor, seed, options),
  );
  const attempts = scanResults.flatMap((result) => result.attempts);
  const unknowns = scanResults.flatMap((result) => result.unknowns);
  const artifacts = mergeArtifacts(scanResults.flatMap((result) => result.artifacts));
  const configAttempts = await collectConfigSummaries(executor, artifacts, options, unknowns);
  attempts.push(...configAttempts);

  return {
    artifacts,
    evidence: attempts.map((attempt) => createEvidence(attempt, options.opsenseVersion)),
    pathSeeds,
    unknowns,
  };
}

async function scanSeed(
  executor: SafeCommandExecutor,
  seed: PathSeedRecord,
  options: M5CollectionOptions,
): Promise<SeedScanResult> {
  if (isLargeDataSeed(seed)) return scanLargeDataSeed(executor, seed, options);
  const attempts: M5Attempt[] = [];
  const unknowns: string[] = [];
  const primaryId = options.crossFileSystems
    ? 'directory.scan-cross-filesystems'
    : 'directory.scan';
  const fallbackId = options.crossFileSystems
    ? 'directory.scan-stat-cross-filesystems'
    : 'directory.scan-stat';
  const maxDepth = options.maxDirectoryDepth;
  const primary = await executeScanCommand(executor, primaryId, seed.path, maxDepth, options);
  attempts.push({ evidenceId: scanEvidenceId(primaryId, seed), result: primary });
  let selected = primary;
  let entries = parseUsableEntries(primary, parseFindEntries);

  if (entries === undefined && shouldTryStatFallback(primary)) {
    const fallback = await executeScanCommand(executor, fallbackId, seed.path, maxDepth, options);
    attempts.push({ evidenceId: scanEvidenceId(fallbackId, seed), result: fallback });
    selected = fallback;
    entries = parseUsableEntries(fallback, parseStatEntries);
  }

  const selectedAttempt = attempts.find((attempt) => attempt.result === selected);
  if (entries === undefined) {
    const status = normalizedDirectoryStatus(selected);
    if (selectedAttempt !== undefined) selectedAttempt.status = status;
    if (status !== 'not_found') unknowns.push(`directory.scan:${seed.path}: ${status}`);
    return { artifacts: [], attempts, unknowns };
  }

  const limited = entries.slice(0, options.maxFilesPerDirectory);
  const fileLimitReached = entries.length > options.maxFilesPerDirectory;
  const outputTruncated = selected.status === 'truncated';
  if (selectedAttempt !== undefined) {
    selectedAttempt.status =
      fileLimitReached || outputTruncated ? 'truncated' : normalizedDirectoryStatus(selected);
    selectedAttempt.value = {
      entryCount: limited.length,
      fileLimitReached,
      maxDepth,
      outputTruncated,
      pathSeedId: seed.id,
    };
  }
  if (fileLimitReached || outputTruncated) {
    unknowns.push(`directory.scan:${seed.path}: truncated`);
  } else if (selected.status === 'permission_denied' || selected.status === 'failed') {
    unknowns.push(`directory.scan:${seed.path}: ${normalizedDirectoryStatus(selected)}`);
  }
  const evidenceId = selectedAttempt?.evidenceId ?? scanEvidenceId(selected.commandId, seed);
  return {
    artifacts: limited.map((entry) => artifactFromEntry(entry, evidenceId, seed.confidence)),
    attempts,
    unknowns,
  };
}

async function scanLargeDataSeed(
  executor: SafeCommandExecutor,
  seed: PathSeedRecord,
  options: M5CollectionOptions,
): Promise<SeedScanResult> {
  const attempts: M5Attempt[] = [];
  let selected = await executeMetadataCommand(executor, 'directory.stat', seed.path, options);
  attempts.push({ evidenceId: scanEvidenceId('directory.stat', seed), result: selected });
  let entries = parseUsableEntries(selected, parseStatEntries);
  if (entries === undefined && shouldTryStatFallback(selected)) {
    selected = await executeMetadataCommand(executor, 'directory.stat-basic', seed.path, options);
    attempts.push({ evidenceId: scanEvidenceId('directory.stat-basic', seed), result: selected });
    entries = parseUsableEntries(selected, parseStatEntries);
  }
  const selectedAttempt = attempts.find((attempt) => attempt.result === selected);
  if (entries === undefined) {
    const status = normalizedDirectoryStatus(selected);
    if (selectedAttempt !== undefined) selectedAttempt.status = status;
    return {
      artifacts: [],
      attempts,
      unknowns: status === 'not_found' ? [] : [`directory.summary:${seed.path}: ${status}`],
    };
  }
  if (selectedAttempt !== undefined) {
    selectedAttempt.value = { entryCount: entries.length, pathSeedId: seed.id, summaryOnly: true };
  }
  const evidenceId = selectedAttempt?.evidenceId ?? scanEvidenceId(selected.commandId, seed);
  return {
    artifacts: entries.map((entry) => artifactFromEntry(entry, evidenceId, seed.confidence)),
    attempts,
    unknowns: [],
  };
}

async function collectConfigSummaries(
  executor: SafeCommandExecutor,
  artifacts: ArtifactRecord[],
  options: M5CollectionOptions,
  unknowns: string[],
): Promise<M5Attempt[]> {
  const candidates = artifacts.flatMap((artifact) => {
    if (
      artifact.fileType !== 'file' ||
      (artifact.kind !== 'config' && artifact.kind !== 'compose')
    ) {
      return [];
    }
    const format = configFormat(artifact.path);
    return format === undefined ? [] : [{ artifact, format }];
  });
  return (
    await mapWithConcurrency(candidates, M5_COMMAND_CONCURRENCY, async ({ artifact, format }) => {
      const evidenceId = `evidence:config.summary:${artifact.id.slice('artifact:'.length)}`;
      artifact.evidenceIds = [...new Set([...artifact.evidenceIds, evidenceId])];
      if (artifact.sizeBytes !== undefined && artifact.sizeBytes > options.maxConfigFileBytes) {
        return {
          commandExecuted: false,
          evidenceId,
          kind: 'derived' as const,
          result: syntheticResult('directory.read-config', 'success'),
          source: artifact.path,
          status: 'success' as const,
          value: {
            format,
            maxBytes: options.maxConfigFileBytes,
            read: false,
            reason: 'size_limit',
          },
        };
      }
      const result = await executeConfigRead(executor, artifact.path, options);
      const attempt: M5Attempt = { evidenceId, result, source: artifact.path };
      if (result.status !== 'success') {
        if (result.status !== 'command_missing') {
          unknowns.push(`config.read:${artifact.path}: ${result.status}`);
        }
        return attempt;
      }
      try {
        attempt.value = { ...parseConfigSummary(format, result.stdout), read: true };
      } catch {
        attempt.status = 'failed';
        attempt.message = 'Structured parser rejected the configuration file.';
        attempt.value = { format, read: true };
      }
      return attempt;
    })
  ).filter((attempt): attempt is M5Attempt => attempt !== undefined);
}

async function executeScanCommand(
  executor: SafeCommandExecutor,
  commandId: string,
  seedPath: string,
  maxDepth: number,
  options: M5CollectionOptions,
): Promise<CommandExecutionResult> {
  const spec = getCommandSpec(commandId);
  return executor.execute(
    spec,
    { maxDepth, path: seedPath },
    {
      maxOutputBytes: Math.min(
        spec.maxOutputBytes,
        options.maxOutputBytes ?? spec.maxOutputBytes,
        Math.max(65_536, options.maxFilesPerDirectory * 1024),
      ),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      timeoutMs:
        options.commandTimeoutMs === undefined
          ? spec.timeoutMs
          : Math.min(spec.timeoutMs, options.commandTimeoutMs),
      ...(options.useSudo === true ? { useSudo: true } : {}),
    },
  );
}

function isLargeDataSeed(seed: PathSeedRecord): boolean {
  const candidate = seed.path.startsWith('/data/') ? seed.path.slice('/data'.length) : seed.path;
  return (
    seed.sources.some((source) => source.sourceType === 'docker.mount.volume') ||
    /\/(?:data|db|[^/]+_data|mysql\d*|mariadb|mongo(?:db)?|postgres(?:ql)?)(?:\/|$)/i.test(
      candidate,
    )
  );
}

async function executeMetadataCommand(
  executor: SafeCommandExecutor,
  commandId: string,
  seedPath: string,
  options: M5CollectionOptions,
): Promise<CommandExecutionResult> {
  const spec = getCommandSpec(commandId);
  return executor.execute(
    spec,
    { path: seedPath },
    {
      maxOutputBytes: Math.min(spec.maxOutputBytes, options.maxOutputBytes ?? spec.maxOutputBytes),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      timeoutMs:
        options.commandTimeoutMs === undefined
          ? spec.timeoutMs
          : Math.min(spec.timeoutMs, options.commandTimeoutMs),
      ...(options.useSudo === true ? { useSudo: true } : {}),
    },
  );
}

async function executeConfigRead(
  executor: SafeCommandExecutor,
  configPath: string,
  options: M5CollectionOptions,
): Promise<CommandExecutionResult> {
  const spec = getCommandSpec('directory.read-config');
  return executor.execute(
    spec,
    { path: configPath },
    {
      maxOutputBytes: Math.min(spec.maxOutputBytes, options.maxConfigFileBytes),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      timeoutMs:
        options.commandTimeoutMs === undefined
          ? spec.timeoutMs
          : Math.min(spec.timeoutMs, options.commandTimeoutMs),
      ...(options.useSudo === true ? { useSudo: true } : {}),
    },
  );
}

function parseUsableEntries(
  result: CommandExecutionResult,
  parse: (source: string) => ReturnType<typeof parseFindEntries>,
): ReturnType<typeof parseFindEntries> | undefined {
  if (result.stdout.trim().length === 0) return undefined;
  const entries = parse(result.stdout);
  return entries.length > 0 ? entries : undefined;
}

function shouldTryStatFallback(result: CommandExecutionResult): boolean {
  return (
    result.status === 'command_missing' ||
    (result.status === 'failed' &&
      /unknown predicate|unrecognized|unsupported|invalid (?:option|argument|predicate)/i.test(
        result.stderr,
      ))
  );
}

function normalizedDirectoryStatus(result: CommandExecutionResult): EvidenceRecord['status'] {
  if (/no such file or directory/i.test(result.stderr)) return 'not_found';
  return toCollectionStatus(result.status);
}

function createEvidence(attempt: M5Attempt, opsenseVersion: string): EvidenceRecord {
  const result = attempt.result;
  const status = attempt.status ?? toCollectionStatus(result.status);
  const rawMessage = attempt.message ?? result.errorMessage ?? result.stderr;
  const message = rawMessage.trim().slice(0, 500);
  return {
    collectedAt: result.finishedAt,
    id: attempt.evidenceId,
    kind:
      attempt.kind ??
      (result.commandId === 'directory.read-config' ? 'config_value' : 'file_metadata'),
    opsenseVersion,
    sensitivity: 'internal',
    source: attempt.source ?? result.commandId,
    status,
    value: attempt.value ?? {
      exitCode: result.exitCode ?? null,
      stderrBytes: result.stderrBytes,
      stdoutBytes: result.stdoutBytes,
      truncated: result.status === 'truncated',
    },
    ...(status === 'success' || message.length === 0 ? {} : { message }),
    ...(attempt.commandExecuted === false ? {} : { commandId: result.commandId }),
  };
}

function scanEvidenceId(commandId: string, seed: PathSeedRecord): string {
  return `evidence:${commandId}:${seed.id.slice('path-seed:'.length)}`;
}

function syntheticResult(
  commandId: string,
  status: CommandExecutionResult['status'],
): CommandExecutionResult {
  const now = new Date().toISOString();
  return {
    commandId,
    durationMs: 0,
    exitCode: 0,
    finishedAt: now,
    startedAt: now,
    status,
    stderr: '',
    stderrBytes: 0,
    stdout: '',
    stdoutBytes: 0,
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
