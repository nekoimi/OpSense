import path from 'node:path';

import type { AiProbeAudit, ProbeAuditRecord, ProbeRequest, ScanSnapshot } from '@opsense/schema';

const FORBIDDEN_ROOTS = ['/proc', '/sys', '/dev', '/run'];
const FORBIDDEN_PATTERN = /\/(?:overlay2|containers\/storage\/overlay)(?:\/|$)/;

export interface ProbePolicyLimits {
  maxDepth: number;
  maxMatches: number;
  maxRequests: number;
  maxTotalBytes: number;
  maxTimeoutMs: number;
}

export interface ProbeValidationResult {
  accepted: ProbeRequest[];
  audit: AiProbeAudit;
}

export const DEFAULT_PROBE_POLICY_LIMITS: ProbePolicyLimits = {
  maxDepth: 4,
  maxMatches: 100,
  maxRequests: 8,
  maxTotalBytes: 2_000_000,
  maxTimeoutMs: 15_000,
};

export class ProbePlanValidator {
  public constructor(private readonly limits: ProbePolicyLimits = DEFAULT_PROBE_POLICY_LIMITS) {}

  public validate(
    snapshot: ScanSnapshot,
    requests: readonly ProbeRequest[],
    now: () => Date = () => new Date(),
  ): ProbeValidationResult {
    const accepted: ProbeRequest[] = [];
    const records: ProbeAuditRecord[] = [];
    let totalBytes = 0;
    for (const request of requests) {
      const rejection = this.rejectionReason(snapshot, request, accepted.length, totalBytes);
      if (rejection !== undefined) {
        records.push({ evidenceIds: [], reason: rejection, request, status: 'rejected' });
        continue;
      }
      accepted.push(request);
      totalBytes += request.maxBytes;
      records.push({
        evidenceIds: [],
        reason: '请求符合本地路径来源、目录范围和资源预算策略。',
        request,
        status: 'accepted',
      });
    }
    return {
      accepted,
      audit: { generatedAt: now().toISOString(), records, round: 0 },
    };
  }

  private rejectionReason(
    snapshot: ScanSnapshot,
    request: ProbeRequest,
    acceptedCount: number,
    totalBytes: number,
  ): string | undefined {
    if (acceptedCount >= this.limits.maxRequests) return '超过单轮最大探测请求数。';
    if (totalBytes + request.maxBytes > this.limits.maxTotalBytes)
      return '超过单轮总读取字节预算。';
    if (request.timeoutMs > this.limits.maxTimeoutMs) return '超过单请求超时预算。';
    if ('maxDepth' in request && request.maxDepth > this.limits.maxDepth)
      return '超过最大目录深度。';
    if ('maxMatches' in request && request.maxMatches > this.limits.maxMatches)
      return '超过最大匹配数。';
    if (!request.evidenceIds.every((id) => snapshot.evidence.some((item) => item.id === id))) {
      return '引用了不存在的 Evidence ID。';
    }
    const targetService = snapshot.services.find((item) => item.id === request.targetServiceId);
    if (targetService === undefined) return '目标服务不存在。';
    if (request.kind === 'path_search') {
      if (unsafePath(request.searchRoot)) return '搜索根目录被安全策略禁止。';
      if (!approvedRoots(snapshot).some((root) => within(root, request.searchRoot))) {
        return '搜索根不在批准的部署根或已知数据挂载内。';
      }
      if (!allowedSearchTerms(snapshot).has(request.searchTerm.toLowerCase())) {
        return '搜索词不是已采集的服务、进程、unit、镜像或 Compose 线索。';
      }
      return undefined;
    }
    if (request.kind === 'systemd_unit') {
      const unit = snapshot.systemdUnits.find((item) => item.name === request.unitName);
      return unit !== undefined && targetService.systemdUnitIds.includes(unit.id)
        ? undefined
        : 'systemd unit 不属于目标服务的既有证据。';
    }
    if (request.kind === 'process_runtime' || request.kind === 'process_cgroup')
      return targetService.processIds.includes(request.pid)
        ? undefined
        : 'PID 不属于目标服务的既有证据。';
    if (request.kind === 'socket_ownership')
      return targetService.socketIds.includes(request.socketId)
        ? undefined
        : 'socket 不属于目标服务的既有证据。';
    if (request.kind === 'container_inspect')
      return targetService.containerIds.includes(request.containerId)
        ? undefined
        : '容器不属于目标服务的既有证据。';
    if (request.kind === 'compose_metadata')
      return targetService.composeProjectIds.includes(request.composeProjectId)
        ? undefined
        : 'Compose 项目不属于目标服务的既有证据。';
    if (unsafePath(request.path)) return '目标路径被安全策略禁止。';
    if (!knownPaths(snapshot).some((known) => within(known, request.path))) {
      return '目标路径无法追溯到已采集路径证据。';
    }
    if (request.kind === 'config_summary' && !looksLikeConfig(request.path)) {
      return '配置摘要仅允许读取已知配置文件类型。';
    }
    if (
      request.kind === 'log_metadata' &&
      !targetService.logLocations.some((location) => within(location, request.path))
    )
      return '日志目录不属于目标服务的既有证据。';
    return undefined;
  }
}

export function markProbeRequestsOffline(audit: AiProbeAudit): AiProbeAudit {
  return {
    ...audit,
    records: audit.records.map((record) =>
      record.status === 'accepted'
        ? {
            ...record,
            reason: '独立 analyze 为离线模式，不重新连接 SSH；请求留待 inspect 执行。',
            status: 'skipped' as const,
          }
        : record,
    ),
  };
}

function knownPaths(snapshot: ScanSnapshot): string[] {
  return [
    ...new Set([
      ...(snapshot.pathSeeds ?? []).map((item) => item.path),
      ...snapshot.artifacts.map((item) => item.path),
      ...snapshot.services.flatMap((service) => [
        ...service.deployDirectories,
        ...service.configFiles,
        ...service.environmentFiles,
        ...service.logLocations,
        ...service.dataDirectories,
      ]),
      ...snapshot.systemdUnits.flatMap((unit) =>
        [unit.fragmentPath, unit.workingDirectory, ...unit.environmentFiles].filter(
          (value): value is string => value !== undefined,
        ),
      ),
      ...snapshot.containers.flatMap((container) =>
        container.mounts.flatMap((mount) => mount.source ?? []),
      ),
    ]),
  ].filter((value) => value.startsWith('/'));
}

function approvedRoots(snapshot: ScanSnapshot): string[] {
  return [
    ...new Set([
      ...(snapshot.pathSeeds ?? []).map((item) => item.path),
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

function allowedSearchTerms(snapshot: ScanSnapshot): Set<string> {
  const values = new Set<string>();
  const add = (value: string | undefined): void => {
    if (value === undefined) return;
    for (const token of [value, path.posix.basename(value), value.replace(/\.service$/i, '')]) {
      const normalized = token.trim().toLowerCase();
      if (normalized.length >= 2) values.add(normalized);
    }
  };
  for (const service of snapshot.services) add(service.name);
  for (const process of snapshot.processes) {
    add(process.command);
    add(process.executablePath);
  }
  for (const unit of snapshot.systemdUnits) add(unit.name);
  for (const container of snapshot.containers) {
    add(container.name);
    add(container.image.split(':')[0]);
    for (const value of Object.values(container.labels)) add(value);
  }
  for (const project of snapshot.composeProjects) {
    add(project.name);
    for (const service of project.services) add(service.name);
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

function looksLikeConfig(value: string): boolean {
  return (
    /\.(?:conf|cfg|cnf|ini|json|ya?ml|toml|properties|xml|env)$/i.test(value) ||
    /\/(?:\.env|config)$/i.test(value)
  );
}
