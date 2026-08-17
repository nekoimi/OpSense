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
  if (request.kind === 'systemd_unit') {
    return executor.execute(
      getCommandSpec('service.systemd-show'),
      { unitName: request.unitName },
      common,
    );
  }
  if (request.kind === 'process_runtime') {
    return executor.execute(
      getCommandSpec('runtime.process-details'),
      { pid: request.pid },
      common,
    );
  }
  if (request.kind === 'process_cgroup') {
    return executor.execute(
      getCommandSpec('runtime.process-cgroup'),
      { path: `/proc/${request.pid}/cgroup` },
      common,
    );
  }
  if (request.kind === 'socket_ownership') {
    return executor.execute(getCommandSpec('network.sockets'), {}, common);
  }
  if (request.kind === 'container_inspect') {
    return executor.execute(
      getCommandSpec('docker.inspect'),
      { containerId: request.containerId.replace(/^container:/, '') },
      common,
    );
  }
  if (request.kind === 'compose_metadata') {
    return executor.execute(getCommandSpec('docker.compose-ls'), {}, common);
  }
  if (request.kind === 'log_metadata') {
    return executor.execute(
      getCommandSpec('directory.scan'),
      { maxDepth: 1, path: request.path },
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
  if (isRuntimeProbe(request)) {
    return { artifacts: [], value: runtimeProbeValue(request, result.stdout) };
  }
  const entries =
    request.kind === 'directory_metadata'
      ? parseStatEntries(result.stdout)
      : parseFindEntries(result.stdout).slice(
          0,
          request.kind === 'log_metadata' ? 100 : request.maxMatches,
        );
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
  const source = probeSource(request);
  const message = (result.errorMessage ?? result.stderr).trim().slice(0, 500);
  return {
    collectedAt: result.finishedAt,
    commandId: result.commandId,
    id: evidenceId,
    kind:
      request.kind === 'config_summary'
        ? 'config_value'
        : isRuntimeProbe(request)
          ? 'runtime_state'
          : 'file_metadata',
    ...(message.length === 0 ? {} : { message }),
    opsenseVersion,
    sensitivity: 'internal',
    source,
    sourceEvidenceIds: request.evidenceIds,
    status: toCollectionStatus(result.status),
    value,
  };
}

function isRuntimeProbe(request: ProbeRequest): request is Exclude<
  ProbeRequest,
  {
    kind:
      | 'directory_metadata'
      | 'directory_listing'
      | 'config_summary'
      | 'path_search'
      | 'log_metadata';
  }
> {
  return [
    'systemd_unit',
    'process_runtime',
    'process_cgroup',
    'socket_ownership',
    'container_inspect',
    'compose_metadata',
  ].includes(request.kind);
}

function runtimeProbeValue(request: ProbeRequest, stdout: string): unknown {
  const lines = stdout.split(/\r?\n/).filter((item) => item.length > 0);
  if (request.kind === 'systemd_unit') {
    const allowed = new Set([
      'Id',
      'Description',
      'LoadState',
      'ActiveState',
      'SubState',
      'UnitFileState',
      'MainPID',
      'FragmentPath',
      'WorkingDirectory',
      'User',
      'Group',
    ]);
    return Object.fromEntries(
      lines.flatMap((line) => {
        const separator = line.indexOf('=');
        const key = line.slice(0, separator);
        return separator > 0 && allowed.has(key) ? [[key, line.slice(separator + 1)]] : [];
      }),
    );
  }
  if (request.kind === 'process_cgroup') return { cgroups: lines.slice(0, 20), pid: request.pid };
  if (request.kind === 'process_runtime')
    return { outputPresent: lines.length > 0, pid: request.pid, rowCount: lines.length };
  if (request.kind === 'socket_ownership')
    return { listenerLineCount: lines.length, socketId: request.socketId };
  if (request.kind === 'container_inspect')
    return containerInspectSummary(stdout, request.containerId);
  if (request.kind === 'compose_metadata') return composeSummary(stdout, request.composeProjectId);
  return { parseStatus: 'unsupported_runtime_probe' };
}

function containerInspectSummary(stdout: string, containerId: string): unknown {
  try {
    const item = (JSON.parse(stdout) as Array<Record<string, unknown>>)[0] ?? {};
    const config = objectValue(item.Config);
    const state = objectValue(item.State);
    const mounts = Array.isArray(item.Mounts)
      ? item.Mounts.slice(0, 30).flatMap((mount) => {
          const value = objectValue(mount);
          return [{ destination: value.Destination, source: value.Source, type: value.Type }];
        })
      : [];
    return { containerId, image: config.Image, mounts, name: item.Name, state: state.Status };
  } catch {
    return { containerId, parseStatus: 'failed' };
  }
}

function composeSummary(stdout: string, composeProjectId: string): unknown {
  try {
    const records = JSON.parse(stdout) as Array<Record<string, unknown>>;
    return {
      composeProjectId,
      projects: records.slice(0, 30).map((item) => ({
        name: item.Name,
        services: item.Services,
        status: item.Status,
      })),
    };
  } catch {
    return { composeProjectId, parseStatus: 'failed' };
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function probeSource(request: ProbeRequest): string {
  if (request.kind === 'path_search') return request.searchRoot;
  if ('path' in request) return request.path;
  if (request.kind === 'systemd_unit') return `systemd:${request.unitName}`;
  if (request.kind === 'process_runtime' || request.kind === 'process_cgroup')
    return `process:${request.pid}`;
  if (request.kind === 'socket_ownership') return request.socketId;
  if (request.kind === 'container_inspect') return request.containerId;
  if (request.kind === 'compose_metadata') return request.composeProjectId;
  return '';
}
