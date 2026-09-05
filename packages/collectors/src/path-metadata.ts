import { createHash } from 'node:crypto';

import { mapWithConcurrency } from '@opsense/collection-runtime';
import type { CollectionScheduler } from '@opsense/collection-runtime';
import type { ArtifactRecord, EvidenceRecord, PathSeedRecord } from '@opsense/schema';
import { getCommandSpec, toCollectionStatus } from '@opsense/ssh';
import type { CommandExecutionResult, SafeCommandExecutor } from '@opsense/ssh';

import { artifactFromEntry, mergeArtifacts, parseStatEntries } from './artifacts.js';
import { isPathSeedScanEligible } from './path-seeds.js';

export const PATH_METADATA_BATCH_SIZE = 64;
export const PATH_METADATA_CONCURRENCY = 4;

export interface PathMetadataCollectionOptions {
  commandTimeoutMs?: number;
  maxOutputBytes?: number;
  opsenseVersion: string;
  scheduler?: CollectionScheduler;
  signal?: AbortSignal;
  useSudo?: boolean;
}

export interface PathMetadataCollectionResult {
  artifacts: ArtifactRecord[];
  evidence: EvidenceRecord[];
  pathSeeds: PathSeedRecord[];
  unknowns: string[];
}

interface MetadataAttempt {
  evidenceId: string;
  result: CommandExecutionResult;
  status?: EvidenceRecord['status'];
  value: Record<string, unknown>;
}

interface MetadataBatchResult {
  artifacts: ArtifactRecord[];
  attempts: MetadataAttempt[];
  unknowns: string[];
}

export async function collectPathMetadataSnapshot(
  executor: SafeCommandExecutor,
  pathSeeds: readonly PathSeedRecord[],
  options: PathMetadataCollectionOptions,
): Promise<PathMetadataCollectionResult> {
  const eligible = pathSeeds.filter(isPathSeedScanEligible);
  const batches = await mapWithConcurrency(
    chunk(eligible, PATH_METADATA_BATCH_SIZE),
    PATH_METADATA_CONCURRENCY,
    (batch) => collectMetadataBatch(executor, batch, options),
    options.scheduler,
  );
  return {
    artifacts: mergeArtifacts(batches.flatMap((batch) => batch.artifacts)),
    evidence: batches.flatMap((batch) =>
      batch.attempts.map((attempt) => createEvidence(attempt, options.opsenseVersion)),
    ),
    pathSeeds: [...pathSeeds],
    unknowns: batches.flatMap((batch) => batch.unknowns),
  };
}

async function collectMetadataBatch(
  executor: SafeCommandExecutor,
  seeds: readonly PathSeedRecord[],
  options: PathMetadataCollectionOptions,
): Promise<MetadataBatchResult> {
  const paths = seeds.map((seed) => seed.path);
  const attempts: MetadataAttempt[] = [];
  let selected = await executeBatch(executor, 'directory.stat-batch', paths, options);
  attempts.push(attemptFor(selected, paths));
  let entries = parseStatEntries(selected.stdout);

  if (shouldTryBasicFallback(selected)) {
    selected = await executeBatch(executor, 'directory.stat-basic-batch', paths, options);
    attempts.push(attemptFor(selected, paths));
    entries = parseStatEntries(selected.stdout);
  }

  const selectedAttempt = attempts.at(-1);
  const foundPaths = new Set(entries.map((entry) => entry.path));
  const missingPaths = paths.filter((path) => !foundPaths.has(path));
  if (selectedAttempt !== undefined) {
    selectedAttempt.status =
      selected.status === 'truncated' || (entries.length > 0 && missingPaths.length > 0)
        ? 'truncated'
        : toCollectionStatus(selected.status);
    selectedAttempt.value = {
      ...selectedAttempt.value,
      entryCount: entries.length,
      missingCount: missingPaths.length,
    };
  }

  const seedByPath = new Map(seeds.map((seed) => [seed.path, seed]));
  const evidenceId = selectedAttempt?.evidenceId ?? metadataEvidenceId(paths);
  const artifacts = entries.flatMap((entry) => {
    const seed = seedByPath.get(entry.path);
    return seed === undefined ? [] : [artifactFromEntry(entry, evidenceId, seed.confidence)];
  });
  const unknowns =
    missingPaths.length === 0 || /no such file or directory/i.test(selected.stderr)
      ? []
      : [`directory.stat-batch: ${missingPaths.length} paths unresolved (${selected.status})`];
  return { artifacts, attempts, unknowns };
}

function attemptFor(result: CommandExecutionResult, paths: readonly string[]): MetadataAttempt {
  return {
    evidenceId: metadataEvidenceId(paths, result.commandId),
    result,
    value: { pathCount: paths.length },
  };
}

async function executeBatch(
  executor: SafeCommandExecutor,
  commandId: 'directory.stat-batch' | 'directory.stat-basic-batch',
  paths: readonly string[],
  options: PathMetadataCollectionOptions,
): Promise<CommandExecutionResult> {
  const spec = getCommandSpec(commandId);
  return executor.execute(
    spec,
    { paths },
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

function shouldTryBasicFallback(result: CommandExecutionResult): boolean {
  return (
    result.status === 'command_missing' ||
    (result.status === 'failed' &&
      /unrecognized|unsupported|invalid (?:option|argument)|unknown option/i.test(result.stderr))
  );
}

function createEvidence(attempt: MetadataAttempt, opsenseVersion: string): EvidenceRecord {
  const status = attempt.status ?? toCollectionStatus(attempt.result.status);
  const message = (attempt.result.errorMessage ?? attempt.result.stderr).trim().slice(0, 500);
  return {
    collectedAt: attempt.result.finishedAt,
    commandId: attempt.result.commandId,
    id: attempt.evidenceId,
    kind: 'command_output',
    opsenseVersion,
    sensitivity: 'internal',
    source: attempt.result.commandId,
    status,
    value: {
      ...attempt.value,
      exitCode: attempt.result.exitCode ?? null,
      stderrBytes: attempt.result.stderrBytes,
      stdoutBytes: attempt.result.stdoutBytes,
      truncated: status === 'truncated',
    },
    ...(status === 'success' || message.length === 0 ? {} : { message }),
  };
}

function metadataEvidenceId(paths: readonly string[], commandId = 'directory.stat-batch'): string {
  const digest = createHash('sha256').update(paths.join('\0')).digest('hex').slice(0, 16);
  return `evidence:${commandId}:${digest}`;
}

function chunk<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}
