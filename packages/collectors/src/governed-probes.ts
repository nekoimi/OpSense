import { CollectionScheduler } from '@opsense/collection-runtime';
import type { CollectionTask } from '@opsense/collection-runtime';
import { ProbeBatchResultSchema, assertSchema } from '@opsense/schema';
import type {
  ArtifactRecord,
  EvidenceRecord,
  GovernedProbePlan,
  ProbeBatchResult,
  ProbeRequest,
} from '@opsense/schema';
import { getCommandSpec } from '@opsense/ssh';
import type { CommandExecutionResult, SafeCommandExecutor } from '@opsense/ssh';

import { executeAiProbeRequests, materializeAiProbeExecution } from './ai-probes.js';
import type { AiProbeExecutionResult } from './ai-probes.js';
import { mergeArtifacts } from './artifacts.js';

export interface GovernedProbeExecutionOptions {
  maxDurationMs?: number;
  opsenseVersion: string;
  scheduler?: CollectionScheduler;
  signal?: AbortSignal;
  useSudo?: boolean;
  now?: () => Date;
}

interface ProbeTaskValue {
  execution: AiProbeExecutionResult;
  requests: ProbeRequest[];
}

interface ProbeTaskDefinition {
  diskIntensive: boolean;
  requests: ProbeRequest[];
  task: CollectionTask<ProbeTaskValue>;
}

export async function executeGovernedProbeBatch(
  executor: SafeCommandExecutor,
  plan: GovernedProbePlan,
  options: GovernedProbeExecutionOptions,
): Promise<{ batch: ProbeBatchResult; execution: AiProbeExecutionResult }> {
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  const scheduler = options.scheduler ?? new CollectionScheduler({ concurrency: 4 });
  const diskPermits = new PermitPool(2);
  const signal = boundedSignal(options.signal, options.maxDurationMs ?? 120_000);
  const definitions = buildTaskDefinitions(
    executor,
    plan.requests,
    { ...options, signal },
    diskPermits,
  );
  const byTaskId = new Map(definitions.map((item) => [item.task.taskId, item]));
  const scheduled = await scheduler.run(
    definitions.map((item) => item.task),
    { signal },
  );
  const artifacts: ArtifactRecord[] = [];
  const evidence: EvidenceRecord[] = [];
  const records: AiProbeExecutionResult['records'] = [];
  const objectResults: ProbeBatchResult['results'] = [];

  for (const result of scheduled) {
    const definition = byTaskId.get(result.taskId);
    if (definition === undefined) continue;
    if (result.value === undefined) {
      for (const request of definition.requests) {
        records.push({
          evidenceIds: [],
          reason: result.error ?? '探测任务未执行。',
          requestId: request.id,
          status: 'failed',
        });
        objectResults.push({
          durationMs: result.durationMs,
          evidenceIds: [],
          reason: result.error ?? '探测任务未执行。',
          requestId: request.id,
          status: result.status === 'cancelled' ? 'cancelled' : 'failed',
        });
      }
      continue;
    }
    artifacts.push(...result.value.execution.artifacts);
    evidence.push(...result.value.execution.evidence);
    records.push(...result.value.execution.records);
    for (const record of result.value.execution.records) {
      objectResults.push({
        durationMs: result.durationMs,
        evidenceIds: record.evidenceIds,
        reason: record.reason,
        requestId: record.requestId,
        status: record.status === 'accepted' ? 'completed' : 'failed',
      });
    }
  }
  const finishedAt = now();
  const execution = { artifacts: mergeArtifacts(artifacts), evidence, records };
  const batch: ProbeBatchResult = {
    evidenceIds: evidence.map((item) => item.id),
    finishedAt: finishedAt.toISOString(),
    planId: plan.planId,
    results: objectResults.sort((left, right) => left.requestId.localeCompare(right.requestId)),
    round: 1,
    startedAt: startedAt.toISOString(),
    yield: {
      changedConfidenceCount: 0,
      newEvidenceCount: evidence.length,
      newServiceCount: 0,
      resolvedFieldCount: 0,
      resolvedQuestionCount: 0,
    },
  };
  assertSchema(ProbeBatchResultSchema, batch);
  return { batch, execution };
}

function buildTaskDefinitions(
  executor: SafeCommandExecutor,
  requests: readonly ProbeRequest[],
  options: GovernedProbeExecutionOptions,
  diskPermits: PermitPool,
): ProbeTaskDefinition[] {
  const definitions: ProbeTaskDefinition[] = [];
  const batchKinds = [
    ['systemd_unit', 48],
    ['container_inspect', 48],
    ['directory_metadata', 64],
  ] as const;
  const batchedIds = new Set<string>();
  for (const [kind, size] of batchKinds) {
    const selected = requests.filter((request) => request.kind === kind);
    for (const values of chunks(selected, size)) {
      values.forEach((request) => batchedIds.add(request.id));
      definitions.push(
        taskDefinition(
          `probe-batch:${kind}:${values.map((request) => request.id).join(',')}`,
          values,
          kind === 'directory_metadata',
          async () => executeBatchable(executor, values, options),
          diskPermits,
        ),
      );
    }
  }
  for (const request of requests.filter((item) => !batchedIds.has(item.id))) {
    const diskIntensive = [
      'directory_listing',
      'config_summary',
      'log_metadata',
      'path_search',
    ].includes(request.kind);
    definitions.push(
      taskDefinition(
        `probe:${request.id}`,
        [request],
        diskIntensive,
        async () => ({
          execution: await executeAiProbeRequests(executor, [request], options),
          requests: [request],
        }),
        diskPermits,
      ),
    );
  }
  return definitions;
}

function taskDefinition(
  taskId: string,
  requests: ProbeRequest[],
  diskIntensive: boolean,
  execute: () => Promise<ProbeTaskValue>,
  diskPermits: PermitPool,
): ProbeTaskDefinition {
  return {
    diskIntensive,
    requests,
    task: {
      cacheKey: `governed:${requests.map(semanticKey).join('|')}`,
      execute: async () => {
        if (!diskIntensive) return execute();
        const release = await diskPermits.acquire();
        try {
          return await execute();
        } finally {
          release();
        }
      },
      priority: diskIntensive ? 'enrichment' : 'normal',
      taskId,
    },
  };
}

async function executeBatchable(
  executor: SafeCommandExecutor,
  requests: ProbeRequest[],
  options: GovernedProbeExecutionOptions,
): Promise<ProbeTaskValue> {
  if (requests.length === 1) {
    return {
      execution: await executeAiProbeRequests(executor, requests, options),
      requests,
    };
  }
  const result = await executeBatchCommand(executor, requests, options);
  if (!successful(result)) {
    const midpoint = Math.ceil(requests.length / 2);
    return mergeTaskValues(
      await executeBatchable(executor, requests.slice(0, midpoint), options),
      await executeBatchable(executor, requests.slice(midpoint), options),
    );
  }
  const outputs = splitBatchOutput(requests, result.stdout);
  const found = requests.filter((request) => outputs.has(request.id));
  const missing = requests.filter((request) => !outputs.has(request.id));
  const materialized = found.map((request) =>
    materializeAiProbeExecution(
      request,
      { ...result, stdout: outputs.get(request.id) ?? '' },
      options.opsenseVersion,
    ),
  );
  const base = mergeExecutions(materialized, found);
  return missing.length === 0
    ? base
    : mergeTaskValues(base, await executeBatchable(executor, missing, options));
}

function executeBatchCommand(
  executor: SafeCommandExecutor,
  requests: ProbeRequest[],
  options: GovernedProbeExecutionOptions,
): Promise<CommandExecutionResult> {
  const first = requests[0];
  if (first === undefined) throw new Error('Cannot execute an empty probe batch.');
  const common = {
    maxOutputBytes: requests.reduce((total, request) => total + request.maxBytes, 0),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    timeoutMs: Math.max(...requests.map((request) => request.timeoutMs)),
    ...(options.useSudo === true ? { useSudo: true } : {}),
  };
  if (first.kind === 'systemd_unit') {
    return executor.execute(
      getCommandSpec('service.systemd-show-batch'),
      {
        unitNames: requests.flatMap((request) =>
          request.kind === 'systemd_unit' ? [request.unitName] : [],
        ),
      },
      common,
    );
  }
  if (first.kind === 'container_inspect') {
    return executor.execute(
      getCommandSpec('docker.inspect-batch'),
      {
        containerIds: requests.flatMap((request) =>
          request.kind === 'container_inspect'
            ? [request.containerId.replace(/^container:/, '')]
            : [],
        ),
      },
      common,
    );
  }
  return executor.execute(
    getCommandSpec('directory.stat-batch'),
    {
      paths: requests.flatMap((request) =>
        request.kind === 'directory_metadata' ? [request.path] : [],
      ),
    },
    common,
  );
}

function splitBatchOutput(requests: readonly ProbeRequest[], stdout: string): Map<string, string> {
  const first = requests[0];
  if (first?.kind === 'systemd_unit') {
    const byName = new Map(
      stdout.split(/\r?\n\s*\r?\n/).flatMap((block) => {
        const id = /^Id=(.+)$/m.exec(block)?.[1];
        return id === undefined ? [] : [[id.trim(), block]];
      }),
    );
    return new Map(
      requests.flatMap((request) =>
        request.kind === 'systemd_unit' && byName.has(request.unitName)
          ? [[request.id, byName.get(request.unitName)!]]
          : [],
      ),
    );
  }
  if (first?.kind === 'container_inspect') {
    try {
      const values = JSON.parse(stdout) as Array<Record<string, unknown>>;
      return new Map(
        requests.flatMap((request) => {
          if (request.kind !== 'container_inspect') return [];
          const rawId = request.containerId.replace(/^container:/, '').toLowerCase();
          const value = values.find(
            (item) => typeof item.Id === 'string' && item.Id.toLowerCase().startsWith(rawId),
          );
          return value === undefined ? [] : [[request.id, JSON.stringify([value])]];
        }),
      );
    } catch {
      return new Map();
    }
  }
  const lines = stdout.split(/\r?\n/).filter(Boolean);
  return new Map(
    requests.flatMap((request) => {
      if (request.kind !== 'directory_metadata') return [];
      const line = lines.find((item) => item.split('\t')[6] === request.path);
      return line === undefined ? [] : [[request.id, line]];
    }),
  );
}

function mergeTaskValues(left: ProbeTaskValue, right: ProbeTaskValue): ProbeTaskValue {
  return {
    execution: {
      artifacts: mergeArtifacts([...left.execution.artifacts, ...right.execution.artifacts]),
      evidence: [...left.execution.evidence, ...right.execution.evidence],
      records: [...left.execution.records, ...right.execution.records],
    },
    requests: [...left.requests, ...right.requests],
  };
}

function mergeExecutions(
  values: readonly AiProbeExecutionResult[],
  requests: ProbeRequest[],
): ProbeTaskValue {
  return {
    execution: {
      artifacts: mergeArtifacts(values.flatMap((value) => value.artifacts)),
      evidence: values.flatMap((value) => value.evidence),
      records: values.flatMap((value) => value.records),
    },
    requests,
  };
}

function successful(result: CommandExecutionResult): boolean {
  return result.status === 'success' || result.status === 'truncated';
}

function semanticKey(request: ProbeRequest): string {
  if (request.kind === 'path_search')
    return `${request.kind}:${request.searchRoot}:${request.searchTerm}:${request.maxDepth}`;
  if ('path' in request) return `${request.kind}:${request.path}`;
  if (request.kind === 'systemd_unit') return `${request.kind}:${request.unitName}`;
  if (request.kind === 'process_runtime' || request.kind === 'process_cgroup')
    return `${request.kind}:${request.pid}`;
  if (request.kind === 'socket_ownership') return `${request.kind}:${request.socketId}`;
  if (request.kind === 'container_inspect') return `${request.kind}:${request.containerId}`;
  return `${request.kind}:${request.composeProjectId}`;
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function boundedSignal(external: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return external === undefined ? timeout : AbortSignal.any([external, timeout]);
}

class PermitPool {
  private active = 0;
  private readonly waiters: Array<(release: () => void) => void> = [];

  public constructor(private readonly capacity: number) {}

  public acquire(): Promise<() => void> {
    if (this.active < this.capacity) {
      this.active += 1;
      return Promise.resolve(this.releaseFunction());
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private releaseFunction(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      const next = this.waiters.shift();
      if (next !== undefined) {
        this.active += 1;
        next(this.releaseFunction());
      }
    };
  }
}
