import type { ArtifactRecord, EvidenceRecord, ProbeRequest } from '@opsense/schema';
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

export interface AiProbeExecutionOptions {
  opsenseVersion: string;
  signal?: AbortSignal;
  useSudo?: boolean;
}

export interface AiProbeExecutionRecord {
  evidenceIds: string[];
  requestId: string;
  status: 'accepted' | 'failed';
  reason: string;
}

export interface AiProbeExecutionResult {
  artifacts: ArtifactRecord[];
  evidence: EvidenceRecord[];
  records: AiProbeExecutionRecord[];
}

export async function executeAiProbeRequests(
  executor: SafeCommandExecutor,
  requests: readonly ProbeRequest[],
  options: AiProbeExecutionOptions,
): Promise<AiProbeExecutionResult> {
  const artifacts: ArtifactRecord[] = [];
  const evidence: EvidenceRecord[] = [];
  const records: AiProbeExecutionRecord[] = [];
  for (const request of requests) {
    const evidenceId = `evidence:ai-probe:${request.id}`;
    const result = await executeRequest(executor, request, options);
    const parsed = parseRequestResult(request, result, evidenceId);
    artifacts.push(...parsed.artifacts);
    evidence.push(
      createEvidence(request, result, evidenceId, parsed.value, options.opsenseVersion),
    );
    records.push({
      evidenceIds: [evidenceId],
      reason:
        result.status === 'success' || result.status === 'truncated'
          ? '受控探测已执行，结果已进入证据层。'
          : (result.errorMessage ??
            (result.stderr.slice(0, 300) || `探测执行状态：${result.status}`)),
      requestId: request.id,
      status: result.status === 'success' || result.status === 'truncated' ? 'accepted' : 'failed',
    });
  }
  return { artifacts: mergeArtifacts(artifacts), evidence, records };
}

async function executeRequest(
  executor: SafeCommandExecutor,
  request: ProbeRequest,
  options: AiProbeExecutionOptions,
): Promise<CommandExecutionResult> {
  const common = {
    maxOutputBytes: request.maxBytes,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    timeoutMs: request.timeoutMs,
    ...(options.useSudo === true ? { useSudo: true } : {}),
  };
  if (request.kind === 'directory_metadata') {
    return executor.execute(getCommandSpec('directory.stat'), { path: request.path }, common);
  }
  if (request.kind === 'directory_listing') {
    return executor.execute(
      getCommandSpec('directory.scan'),
      { maxDepth: request.maxDepth, path: request.path },
      common,
    );
  }
  if (request.kind === 'config_summary') {
    return executor.execute(
      getCommandSpec('directory.read-config'),
      { path: request.path },
      common,
    );
  }
  return executor.execute(
    getCommandSpec('directory.search-name'),
    {
      maxDepth: request.maxDepth,
      searchRoot: request.searchRoot,
      searchTerm: `*${request.searchTerm}*`,
    },
    common,
  );
}

function parseRequestResult(
  request: ProbeRequest,
  result: CommandExecutionResult,
  evidenceId: string,
): { artifacts: ArtifactRecord[]; value: unknown } {
  if (result.status !== 'success' && result.status !== 'truncated') {
    return { artifacts: [], value: { status: result.status } };
  }
  if (request.kind === 'config_summary') {
    const format = configFormat(request.path);
    if (format === undefined)
      return { artifacts: [], value: { read: false, reason: 'unsupported_format' } };
    try {
      return { artifacts: [], value: { ...parseConfigSummary(format, result.stdout), read: true } };
    } catch {
      return { artifacts: [], value: { format, read: true, parseStatus: 'failed' } };
    }
  }
  const entries =
    request.kind === 'directory_metadata'
      ? parseStatEntries(result.stdout)
      : parseFindEntries(result.stdout).slice(0, request.maxMatches);
  return {
    artifacts: entries.map((entry) => artifactFromEntry(entry, evidenceId, 'inferred')),
    value: {
      entryCount: entries.length,
      outputTruncated: result.status === 'truncated',
      ...(request.kind === 'directory_listing' || request.kind === 'path_search'
        ? { maxMatches: request.maxMatches }
        : {}),
    },
  };
}

function createEvidence(
  request: ProbeRequest,
  result: CommandExecutionResult,
  evidenceId: string,
  value: unknown,
  opsenseVersion: string,
): EvidenceRecord {
  const source = request.kind === 'path_search' ? request.searchRoot : request.path;
  const message = (result.errorMessage ?? result.stderr).trim().slice(0, 500);
  return {
    collectedAt: result.finishedAt,
    commandId: result.commandId,
    id: evidenceId,
    kind: request.kind === 'config_summary' ? 'config_value' : 'file_metadata',
    ...(message.length === 0 ? {} : { message }),
    opsenseVersion,
    sensitivity: 'internal',
    source,
    sourceEvidenceIds: request.evidenceIds,
    status: toCollectionStatus(result.status),
    value,
  };
}
