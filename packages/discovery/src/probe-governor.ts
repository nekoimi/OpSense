import { createHash } from 'node:crypto';
import path from 'node:path';

import { GovernedProbePlanSchema, assertSchema } from '@opsense/schema';
import type {
  BatchDiscoveryDecision,
  BatchDiscoveryInput,
  GovernedProbePlan,
  ProbeRequest,
  ScanSnapshot,
} from '@opsense/schema';

const FORBIDDEN_ROOTS = ['/proc', '/sys', '/dev', '/run'];
const FORBIDDEN_PATTERN = /\/(?:overlay2|containers\/storage\/overlay)(?:\/|$)/;

export interface V3ProbePolicyLimits {
  maxDepth: number;
  maxMatches: number;
  maxRequests: number;
  maxTimeoutMs: number;
  maxTotalBytes: number;
}

export const DEFAULT_V3_PROBE_POLICY_LIMITS: V3ProbePolicyLimits = {
  maxDepth: 4,
  maxMatches: 100,
  maxRequests: 20,
  maxTimeoutMs: 15_000,
  maxTotalBytes: 5_000_000,
};

export function compileGovernedProbePlan(
  input: BatchDiscoveryInput,
  decision: BatchDiscoveryDecision,
  snapshot: ScanSnapshot,
  options: { limits?: Partial<V3ProbePolicyLimits>; now?: () => Date } = {},
): GovernedProbePlan {
  const limits = { ...DEFAULT_V3_PROBE_POLICY_LIMITS, ...options.limits };
  limits.maxRequests = Math.min(limits.maxRequests, input.probePolicy.maxRequests);
  const services = new Map(decision.services.map((service) => [service.serviceId, service]));
  const candidates = new Map(
    input.candidates.map((candidate) => [candidate.candidateId, candidate]),
  );
  const evidenceIds = new Set(input.evidenceIndex.map((evidence) => evidence.id));
  const preliminary: ProbeRequest[] = [];
  const audit: GovernedProbePlan['audit'] = [];

  for (const original of decision.probeRequests) {
    const request = normalizeRequest(original);
    const rejection = rejectionReason(
      request,
      input,
      snapshot,
      services,
      candidates,
      evidenceIds,
      limits,
    );
    if (rejection === undefined) preliminary.push(request);
    else audit.push({ reason: rejection, request, status: 'rejected' });
  }

  const requests: ProbeRequest[] = [];
  let totalBytes = 0;
  for (const request of [...preliminary].sort(compareForCoverage)) {
    const duplicate = requests.find((accepted) => covers(accepted, request));
    if (duplicate !== undefined) {
      audit.push({
        canonicalRequestId: duplicate.id,
        reason: '请求被相同语义缓存键或祖先路径覆盖。',
        request,
        status: 'deduplicated',
      });
      continue;
    }
    if (requests.length >= limits.maxRequests) {
      audit.push({ reason: '超过单轮最大探测请求数。', request, status: 'rejected' });
      continue;
    }
    if (totalBytes + request.maxBytes > limits.maxTotalBytes) {
      audit.push({ reason: '超过单轮总读取字节预算。', request, status: 'rejected' });
      continue;
    }
    requests.push(request);
    totalBytes += request.maxBytes;
    audit.push({ reason: '请求已通过来源、安全边界与预算校验。', request, status: 'accepted' });
  }

  const plan: GovernedProbePlan = {
    audit,
    generatedAt: (options.now ?? (() => new Date()))().toISOString(),
    planId: stableId(
      'probe-plan',
      `${decision.decisionId}|${requests.map((request) => semanticKey(request)).join('|')}`,
    ),
    requests,
    round: 1,
    sourceCandidateSetHash: input.sourceCandidateSetHash,
    sourceDecisionId: decision.decisionId,
  };
  assertSchema(GovernedProbePlanSchema, plan);
  return plan;
}

function rejectionReason(
  request: ProbeRequest,
  input: BatchDiscoveryInput,
  snapshot: ScanSnapshot,
  services: ReadonlyMap<string, BatchDiscoveryDecision['services'][number]>,
  candidates: ReadonlyMap<string, BatchDiscoveryInput['candidates'][number]>,
  evidenceIds: ReadonlySet<string>,
  limits: V3ProbePolicyLimits,
): string | undefined {
  if (!input.probePolicy.allowedKinds.includes(request.kind)) return '探测类型不在本次批准列表。';
  if (request.timeoutMs > limits.maxTimeoutMs) return '超过单请求超时预算。';
  if ('maxDepth' in request && request.maxDepth > limits.maxDepth) return '超过最大目录深度。';
  if ('maxMatches' in request && request.maxMatches > limits.maxMatches) return '超过最大匹配数。';
  if (!request.evidenceIds.every((id) => evidenceIds.has(id)))
    return '引用了未提交的 Evidence ID。';
  const service = services.get(request.targetServiceId);
  if (service === undefined) return '目标服务不存在于本次 Discovery 结果。';
  const sources = service.sourceCandidateIds.flatMap((id) => {
    const candidate = candidates.get(id);
    return candidate === undefined ? [] : [candidate];
  });
  if (request.kind === 'systemd_unit') {
    return sources.some((candidate) =>
      candidate.units.some(
        (unit) => unit.name === request.unitName || unit.id === `systemd:${request.unitName}`,
      ),
    )
      ? undefined
      : 'systemd unit 不属于目标候选。';
  }
  if (request.kind === 'process_runtime' || request.kind === 'process_cgroup') {
    return sources.some((candidate) =>
      candidate.processes.some((process) => process.attributes.pid === request.pid),
    )
      ? undefined
      : 'PID 不属于目标候选。';
  }
  if (request.kind === 'socket_ownership') {
    return sources.some((candidate) => candidate.sourceObjectIds.includes(request.socketId))
      ? undefined
      : 'socket 不属于目标候选。';
  }
  if (request.kind === 'container_inspect') {
    return sources.some((candidate) =>
      candidate.containers.some((container) => container.id === request.containerId),
    )
      ? undefined
      : '容器不属于目标候选。';
  }
  if (request.kind === 'compose_metadata') {
    return sources.some((candidate) =>
      candidate.composeProjects.some((project) => project.id === request.composeProjectId),
    )
      ? undefined
      : 'Compose 项目不属于目标候选。';
  }
  if (request.kind === 'path_search') {
    if (unsafePath(request.searchRoot)) return '搜索根目录被安全策略禁止。';
    if (!approvedRoots(snapshot, sources).some((root) => within(root, request.searchRoot)))
      return '搜索根不在批准的部署根或数据挂载内。';
    if (!allowedSearchTerms(service, sources).has(request.searchTerm.toLowerCase()))
      return '搜索词不是已提交的服务、进程、unit、镜像或 Compose 线索。';
    return undefined;
  }
  if (unsafePath(request.path)) return '目标路径被安全策略禁止。';
  if (!knownPaths(sources).some((known) => within(known, request.path)))
    return '目标路径无法追溯到目标候选。';
  if (request.kind === 'config_summary' && !looksLikeConfig(request.path))
    return '配置摘要仅允许已知配置文件类型。';
  return undefined;
}

function normalizeRequest(request: ProbeRequest): ProbeRequest {
  if (request.kind === 'path_search') {
    return {
      ...request,
      searchRoot: path.posix.normalize(request.searchRoot),
      searchTerm: request.searchTerm.trim().toLowerCase(),
    };
  }
  if ('path' in request) return { ...request, path: path.posix.normalize(request.path) };
  if (request.kind === 'systemd_unit') return { ...request, unitName: request.unitName.trim() };
  if (request.kind === 'container_inspect') {
    return { ...request, containerId: request.containerId.trim() };
  }
  if (request.kind === 'compose_metadata') {
    return { ...request, composeProjectId: request.composeProjectId.trim() };
  }
  if (request.kind === 'socket_ownership') {
    return { ...request, socketId: request.socketId.trim() };
  }
  return request;
}

function compareForCoverage(left: ProbeRequest, right: ProbeRequest): number {
  return pathDepth(pathForCoverage(left)) - pathDepth(pathForCoverage(right));
}

function covers(accepted: ProbeRequest, candidate: ProbeRequest): boolean {
  if (semanticKey(accepted) === semanticKey(candidate)) return true;
  if (accepted.kind !== candidate.kind || accepted.targetServiceId !== candidate.targetServiceId)
    return false;
  if (accepted.kind === 'directory_listing' && candidate.kind === 'directory_listing') {
    return (
      within(accepted.path, candidate.path) &&
      accepted.maxDepth >= pathDistance(accepted.path, candidate.path) + candidate.maxDepth
    );
  }
  if (accepted.kind === 'log_metadata' && candidate.kind === 'log_metadata') {
    return within(accepted.path, candidate.path);
  }
  if (accepted.kind === 'path_search' && candidate.kind === 'path_search') {
    return (
      accepted.searchTerm === candidate.searchTerm &&
      within(accepted.searchRoot, candidate.searchRoot) &&
      accepted.maxDepth >=
        pathDistance(accepted.searchRoot, candidate.searchRoot) + candidate.maxDepth
    );
  }
  return false;
}

function semanticKey(request: ProbeRequest): string {
  const common = `${request.kind}|${request.targetServiceId}`;
  if (request.kind === 'path_search') {
    return `${common}|${request.searchRoot}|${request.searchTerm}|${request.maxDepth}`;
  }
  if ('path' in request) return `${common}|${request.path}`;
  if (request.kind === 'systemd_unit') return `${common}|${request.unitName}`;
  if (request.kind === 'process_runtime' || request.kind === 'process_cgroup')
    return `${common}|${request.pid}`;
  if (request.kind === 'socket_ownership') return `${common}|${request.socketId}`;
  if (request.kind === 'container_inspect') return `${common}|${request.containerId}`;
  return `${common}|${request.composeProjectId}`;
}

function knownPaths(candidates: readonly BatchDiscoveryInput['candidates'][number][]): string[] {
  return candidates.flatMap((candidate) => candidate.paths.map((item) => item.name));
}

function approvedRoots(
  snapshot: ScanSnapshot,
  candidates: readonly BatchDiscoveryInput['candidates'][number][],
): string[] {
  return [
    ...new Set([
      ...knownPaths(candidates),
      ...(snapshot.storage?.mounts ?? [])
        .filter((mount) => !mount.pseudo && !mount.temporary && mount.target !== '/')
        .map((mount) => mount.target),
      '/opt',
      '/srv',
      '/data',
      '/apps',
      '/usr/local',
    ]),
  ].filter((value) => !unsafePath(value));
}

function allowedSearchTerms(
  service: BatchDiscoveryDecision['services'][number],
  candidates: readonly BatchDiscoveryInput['candidates'][number][],
): Set<string> {
  const values = new Set<string>();
  const add = (value: string | undefined): void => {
    if (value === undefined) return;
    for (const item of [value, path.posix.basename(value), value.replace(/\.service$/i, '')]) {
      const normalized = item.trim().toLowerCase();
      if (normalized.length >= 2) values.add(normalized);
    }
  };
  add(service.name);
  add(service.displayName);
  for (const candidate of candidates) {
    add(candidate.suggestedName);
    candidate.imageNames.forEach(add);
    candidate.units.forEach((item) => add(item.name));
    candidate.processes.forEach((item) => add(item.name));
    candidate.containers.forEach((item) => add(item.name));
    candidate.composeProjects.forEach((item) => add(item.name));
  }
  return values;
}

function unsafePath(value: string): boolean {
  const normalized = path.posix.normalize(value);
  return (
    normalized === '/' ||
    FORBIDDEN_ROOTS.some((root) => within(root, normalized)) ||
    FORBIDDEN_PATTERN.test(normalized)
  );
}

function within(root: string, candidate: string): boolean {
  const normalizedRoot = path.posix.normalize(root).replace(/\/$/, '');
  const normalizedCandidate = path.posix.normalize(candidate);
  return (
    normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`)
  );
}

function pathDepth(value: string | undefined): number {
  return value === undefined ? Number.MAX_SAFE_INTEGER : value.split('/').filter(Boolean).length;
}

function pathDistance(root: string, candidate: string): number {
  return Math.max(0, pathDepth(candidate) - pathDepth(root));
}

function pathForCoverage(request: ProbeRequest): string | undefined {
  if (request.kind === 'path_search') return request.searchRoot;
  return 'path' in request ? request.path : undefined;
}

function looksLikeConfig(value: string): boolean {
  return (
    /\.(?:conf|cfg|cnf|ini|json|ya?ml|toml|properties|xml|env)$/i.test(value) ||
    /\/(?:\.env|config)$/i.test(value)
  );
}

function stableId(prefix: string, value: string): string {
  return `${prefix}:${createHash('sha256').update(value).digest('hex').slice(0, 20)}`;
}
