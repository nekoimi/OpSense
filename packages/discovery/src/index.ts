import path from 'node:path';

import { DiscoveryCandidateSchema, EvidenceIndexSchema, assertSchema } from '@opsense/schema';
import type {
  DiscoveryCandidate,
  DiscoveryRuntimeKind,
  EvidenceIndex,
  InventoryProjection,
  PathInvestigationSeed,
  ServiceRecord,
} from '@opsense/schema';

const FORBIDDEN_PATH_PATTERN =
  /(?:^|\/)(?:proc|sys|dev|run|tmp|overlay2|containerd|podman|docker\/containers)(?:\/|$)|\/var\/lib\/docker(?:\/|$)|\/var\/lib\/containers\/storage(?:\/|$)/i;
const BROAD_ROOTS = new Set(['/', '/etc', '/usr', '/var', '/home', '/opt', '/srv', '/data']);
const CONFIG_PATH_PATTERN =
  /(?:\.(?:conf|config|ini|json|toml|ya?ml)|Caddyfile|Dockerfile|\.env)$/i;
const CUSTOM_SERVICE_PATH_PATTERN = /^\/(?:apps?|data|home|opt|srv|usr\/local)(?:\/|$)/;
const CUSTOM_SYSTEMD_UNIT_PATTERN = /^\/(?:etc|usr\/local\/lib)\/systemd\/system(?:\/|$)/;

export interface DiscoveryBuildOptions {
  now?: () => Date;
}

export function requiredServiceInvestigationReasons(
  projection: InventoryProjection,
  service: ServiceRecord,
): string[] {
  const linkedSockets = projection.sockets.filter((socket) =>
    service.socketIds.includes(socket.id),
  );
  const linkedUnits = projection.systemdUnits.filter((unit) =>
    service.systemdUnitIds.includes(unit.id),
  );
  return [
    ...(service.status === 'failed' ? ['failed_status'] : []),
    ...(service.deploymentType === 'docker' || service.containerIds.length > 0
      ? ['container_deployment']
      : []),
    ...(service.deploymentType === 'compose' || service.composeProjectIds.length > 0
      ? ['compose_deployment']
      : []),
    ...(service.deploymentType === 'process' ? ['direct_process_deployment'] : []),
    ...(linkedSockets.some((socket) => socket.listening) ? ['listening_socket'] : []),
    ...(linkedSockets.some((socket) => socket.exposed) ? ['externally_exposed_socket'] : []),
    ...(servicePaths(service).some((value) => CUSTOM_SERVICE_PATH_PATTERN.test(value))
      ? ['custom_or_data_path']
      : []),
    ...(linkedUnits.some(
      (unit) =>
        unit.fragmentPath !== undefined && CUSTOM_SYSTEMD_UNIT_PATTERN.test(unit.fragmentPath),
    )
      ? ['custom_systemd_unit']
      : []),
  ];
}

export function buildEvidenceIndex(
  projection: InventoryProjection,
  options: DiscoveryBuildOptions = {},
): EvidenceIndex {
  const generatedAt = (options.now ?? (() => new Date()))().toISOString();
  const processIdsByPid: Record<string, string> = {};
  const processIdsByParentPid: Record<string, string[]> = {};
  const processIdsByCgroup: Record<string, string[]> = {};
  for (const process of projection.processes) {
    processIdsByPid[String(process.pid)] = process.id;
    if (process.parentPid !== undefined) {
      const key = String(process.parentPid);
      processIdsByParentPid[key] = [...(processIdsByParentPid[key] ?? []), process.id];
    }
    if (process.cgroup !== undefined) {
      processIdsByCgroup[process.cgroup] = [
        ...(processIdsByCgroup[process.cgroup] ?? []),
        process.id,
      ];
    }
  }
  const unitIdsByName: Record<string, string> = {};
  for (const unit of projection.systemdUnits) unitIdsByName[unit.name] = unit.id;
  const socketIdsByPort: Record<string, string[]> = {};
  for (const socket of projection.sockets) {
    const key = `${socket.protocol}:${socket.localPort}`;
    socketIdsByPort[key] = [...(socketIdsByPort[key] ?? []), socket.id];
  }
  const containerIdsByImage: Record<string, string[]> = {};
  for (const container of projection.containers) {
    const key = container.image.toLowerCase();
    containerIdsByImage[key] = [...(containerIdsByImage[key] ?? []), container.id];
  }
  const composeIdsByLabel: Record<string, string[]> = {};
  for (const container of projection.containers) {
    for (const [label, value] of Object.entries(container.labels)) {
      const key = `${label}=${value}`;
      composeIdsByLabel[key] = [...(composeIdsByLabel[key] ?? []), container.id];
    }
  }
  for (const project of projection.composeProjects) {
    for (const service of project.services) {
      const key = `compose:${project.id}:${service.name}`;
      composeIdsByLabel[key] = [...(composeIdsByLabel[key] ?? []), project.id];
    }
  }
  const pathSeedIdsByPath: Record<string, string> = {};
  for (const seed of projection.pathSeeds ?? []) pathSeedIdsByPath[seed.path] = seed.id;
  const candidates = buildCandidates(projection);
  const index: EvidenceIndex = {
    candidates,
    composeIdsByLabel: sortRecordArrays(composeIdsByLabel),
    containerIdsByImage: sortRecordArrays(containerIdsByImage),
    generatedAt,
    indexId: `evidence-index:${projection.sourceSnapshotId}`,
    pathSeedIdsByPath,
    processIdsByPid,
    processIdsByParentPid: sortRecordArrays(processIdsByParentPid),
    processIdsByCgroup: sortRecordArrays(processIdsByCgroup),
    socketIdsByPort: sortRecordArrays(socketIdsByPort),
    sourceSnapshotId: projection.sourceSnapshotId,
    unitIdsByName,
  };
  assertSchema(EvidenceIndexSchema, index);
  return index;
}

export function buildPathInvestigationSeeds(
  projection: InventoryProjection,
  index = buildEvidenceIndex(projection),
): PathInvestigationSeed[] {
  const seeds = new Map<string, PathInvestigationSeed>();
  const add = (seed: PathInvestigationSeed): void => {
    const key = seedKey(seed);
    const existing = seeds.get(key);
    if (existing === undefined || (existing.status === 'rejected' && seed.status === 'accepted')) {
      seeds.set(key, seed);
    }
  };
  for (const service of projection.services) {
    const paths = servicePaths(service);
    for (const value of paths) {
      const kind = CONFIG_PATH_PATTERN.test(value) ? 'config_summary' : 'directory_metadata';
      add(pathSeedForPath(kind, value, service.evidenceIds, [service.id], service.id));
      if (kind === 'config_summary') {
        add(pathSeedForSearchRoot(path.posix.dirname(value), service));
      }
    }
    for (const root of [...service.deployDirectories, ...service.dataDirectories]) {
      add(
        pathSeedForPath('directory_listing', root, service.evidenceIds, [service.id], service.id),
      );
      for (const term of termsForService(service, projection)) {
        add(pathSeedForSearch(root, term.value, service.id, term.sourceIds, term.evidenceIds));
      }
    }
  }
  for (const mount of projection.storage?.mounts ?? []) {
    const decision = projection.visibilityDecisions.find(
      (item) => item.objectId === mount.id && item.objectType === 'mount',
    );
    const targetServiceId = decision?.relatedServiceIds[0];
    add(
      pathSeedForPath(
        'directory_metadata',
        mount.target,
        mount.evidenceIds,
        [mount.id],
        targetServiceId,
      ),
    );
  }
  for (const seed of projection.pathSeeds ?? []) {
    const indexedSeedId = index.pathSeedIdsByPath[seed.path] ?? seed.id;
    const sourceIds = [indexedSeedId, ...seed.sources.map((source) => source.sourceId)];
    const evidenceIds = seed.sources.flatMap((source) => source.evidenceIds);
    add(pathSeedForPath('directory_metadata', seed.path, evidenceIds, sourceIds));
  }
  return [...seeds.values()].sort((left, right) => left.seedId.localeCompare(right.seedId));
}

function buildCandidates(projection: InventoryProjection): DiscoveryCandidate[] {
  const candidates: DiscoveryCandidate[] = [];
  const serviceProcessIds = new Set(projection.services.flatMap((service) => service.processIds));
  for (const service of projection.services) {
    const linkedProcesses = projection.processes.filter((process) =>
      service.processIds.includes(process.pid),
    );
    const linkedUnits = projection.systemdUnits.filter((unit) =>
      service.systemdUnitIds.includes(unit.id),
    );
    const linkedSockets = projection.sockets.filter((socket) =>
      service.socketIds.includes(socket.id),
    );
    const linkedContainers = projection.containers.filter((container) =>
      service.containerIds.includes(container.id),
    );
    const sourceIds = [
      service.id,
      ...linkedProcesses.map((process) => process.id),
      ...linkedUnits.map((unit) => unit.id),
      ...linkedSockets.map((socket) => socket.id),
      ...linkedContainers.map((container) => container.id),
      ...service.composeProjectIds,
    ];
    const evidenceIds = [
      ...service.evidenceIds,
      ...linkedProcesses.flatMap((process) => process.evidenceIds),
      ...linkedUnits.flatMap((unit) => unit.evidenceIds),
      ...linkedSockets.flatMap((socket) => socket.evidenceIds),
      ...linkedContainers.flatMap((container) => container.evidenceIds),
    ];
    const runtimeKind = runtimeKindForService(service, linkedProcesses, linkedContainers);
    const signals = [
      'service_record',
      ...(linkedProcesses.length === 0 ? [] : ['process']),
      ...(linkedUnits.length === 0 ? [] : ['systemd_unit']),
      ...(linkedSockets.length === 0 ? [] : ['socket']),
      ...(linkedContainers.length === 0 ? [] : ['container']),
      ...(service.composeProjectIds.length === 0 ? [] : ['compose']),
      ...(servicePaths(service).length === 0 ? [] : ['service_path']),
    ];
    const candidate: DiscoveryCandidate = {
      candidateId: `candidate:${service.id}`,
      confidence: evidenceIds.length === 0 ? 'unknown' : service.confidence,
      displayName: service.displayName ?? service.name,
      evidenceIds: [...new Set(evidenceIds)],
      mergeRule: 'service_record + linked process/unit/socket/container/compose evidence',
      runtimeKind,
      serviceId: service.id,
      signals,
      sourceIds: [...new Set(sourceIds)],
      sourceKind: signals.length > 2 ? 'mixed' : 'service',
      unknowns: [
        ...(evidenceIds.length === 0 ? ['服务候选没有关联 Evidence ID。'] : []),
        ...(runtimeKind === 'unknown' ? ['运行时语言或执行类型尚未确认。'] : []),
      ],
    };
    assertSchema(DiscoveryCandidateSchema, candidate);
    candidates.push(candidate);
  }
  for (const process of projection.processes) {
    if (serviceProcessIds.has(process.pid)) continue;
    const runtimeKind = runtimeKindForProcess(process.command, process.executablePath);
    const candidate: DiscoveryCandidate = {
      candidateId: `candidate:${process.id}`,
      confidence: process.evidenceIds.length === 0 ? 'unknown' : 'inferred',
      displayName: executableName(process.executablePath ?? process.command),
      evidenceIds: [...new Set(process.evidenceIds)],
      mergeRule: 'orphan process candidate from process command and executable evidence',
      runtimeKind,
      signals: ['orphan_process', 'process_command'],
      sourceIds: [process.id],
      sourceKind: 'process',
      unknowns: [
        ...(process.evidenceIds.length === 0 ? ['进程没有关联 Evidence ID。'] : []),
        ...(runtimeKind === 'unknown' ? ['无法从执行命令确认 Java、Go、Rust 或 Shell 类型。'] : []),
      ],
    };
    assertSchema(DiscoveryCandidateSchema, candidate);
    candidates.push(candidate);
  }
  return candidates.sort((left, right) => left.candidateId.localeCompare(right.candidateId));
}

function pathSeedForPath(
  kind: PathInvestigationSeed['kind'],
  value: string,
  evidenceIds: readonly string[],
  sourceIds: readonly string[],
  targetServiceId?: string,
): PathInvestigationSeed {
  const common = {
    evidenceIds: [...new Set(evidenceIds)],
    kind,
    reason: '',
    seedId: seedId(`${kind}:${value}:${targetServiceId ?? ''}`),
    sourceIds: [...new Set(sourceIds)],
    status: 'accepted' as const,
    ...(targetServiceId === undefined ? {} : { targetServiceId }),
    path: value,
  };
  if (!isSafePath(value)) {
    return {
      ...common,
      reason: rejectedPathReason(value),
      status: 'rejected',
    };
  }
  if (common.evidenceIds.length === 0) {
    return { ...common, reason: '缺少 Evidence ID，拒绝生成远程探测种子。', status: 'rejected' };
  }
  return {
    ...common,
    reason:
      kind === 'config_summary'
        ? '配置路径来自已采集服务证据。'
        : '路径来自已采集服务、挂载或路径种子证据。',
  };
}

function pathSeedForSearchRoot(root: string, service: ServiceRecord): PathInvestigationSeed {
  return pathSeedForSearch(root, service.name, service.id, [service.id], service.evidenceIds);
}

function pathSeedForSearch(
  root: string,
  term: string,
  targetServiceId: string,
  sourceIds: readonly string[],
  evidenceIds: readonly string[],
): PathInvestigationSeed {
  const common = {
    evidenceIds: [...new Set(evidenceIds)],
    kind: 'path_search' as const,
    maxDepth: 4,
    maxMatches: 100,
    searchRoot: root,
    searchTerm: term,
    seedId: seedId(`path_search:${root}:${term}:${targetServiceId}`),
    sourceIds: [...new Set(sourceIds)],
    status: 'accepted' as const,
    targetServiceId,
  };
  if (!isSafePath(root)) {
    return { ...common, reason: rejectedPathReason(root), status: 'rejected' };
  }
  if (BROAD_ROOTS.has(normalize(root))) {
    return {
      ...common,
      reason: '搜索根过于宽泛，必须使用具体部署目录、数据挂载或服务路径。',
      status: 'rejected',
    };
  }
  if (!isSafeTerm(term)) {
    return { ...common, reason: '搜索词不是来自安全的已采集服务线索。', status: 'rejected' };
  }
  if (common.evidenceIds.length === 0) {
    return { ...common, reason: '缺少 Evidence ID，拒绝生成远程搜索种子。', status: 'rejected' };
  }
  return { ...common, reason: '搜索根和搜索词均来自已采集服务证据。' };
}

function termsForService(
  service: ServiceRecord,
  projection: InventoryProjection,
): Array<{ value: string; sourceIds: string[]; evidenceIds: string[] }> {
  const terms = new Map<string, { sourceIds: string[]; evidenceIds: string[] }>();
  const add = (
    value: string | undefined,
    sourceId: string,
    evidenceIds: readonly string[],
  ): void => {
    const normalized = value?.trim();
    if (!isSafeTerm(normalized)) return;
    const existing = terms.get(normalized) ?? { evidenceIds: [], sourceIds: [] };
    existing.sourceIds.push(sourceId);
    existing.evidenceIds.push(...evidenceIds);
    terms.set(normalized, existing);
  };
  add(service.name, service.id, service.evidenceIds);
  add(service.displayName, service.id, service.evidenceIds);
  for (const process of projection.processes.filter((item) =>
    service.processIds.includes(item.pid),
  )) {
    add(executableName(process.executablePath ?? process.command), process.id, process.evidenceIds);
  }
  for (const unit of projection.systemdUnits.filter((item) =>
    service.systemdUnitIds.includes(item.id),
  )) {
    add(unit.name.replace(/\.service$/i, ''), unit.id, unit.evidenceIds);
  }
  for (const container of projection.containers.filter((item) =>
    service.containerIds.includes(item.id),
  )) {
    add(container.image.split('@')[0]?.split(':')[0], container.id, container.evidenceIds);
    for (const value of Object.values(container.labels))
      add(value, container.id, container.evidenceIds);
  }
  for (const project of projection.composeProjects.filter((item) =>
    service.composeProjectIds.includes(item.id),
  )) {
    for (const composeService of project.services)
      add(composeService.name, project.id, project.evidenceIds);
  }
  return [...terms.entries()]
    .map(([value, source]) => ({
      evidenceIds: [...new Set(source.evidenceIds)],
      sourceIds: [...new Set(source.sourceIds)],
      value,
    }))
    .sort((left, right) => left.value.localeCompare(right.value));
}

function runtimeKindForService(
  service: ServiceRecord,
  processes: InventoryProjection['processes'],
  containers: InventoryProjection['containers'],
): DiscoveryRuntimeKind {
  if (containers.length > 0) return 'container';
  const kinds = processes.map((process) =>
    runtimeKindForProcess(process.command, process.executablePath),
  );
  return (
    kinds.find((kind) => kind !== 'unknown') ??
    (service.deploymentType === 'process' ? 'binary' : 'unknown')
  );
}

function runtimeKindForProcess(
  command: string,
  executablePath: string | undefined,
): DiscoveryRuntimeKind {
  const value = `${command} ${executablePath ?? ''}`.toLowerCase();
  if (/\bjava(?:\d+)?\b|\.jar(?:\s|$)/.test(value)) return 'java';
  if (/(?:\/|^)go-build|\/go\/|\.go(?:\s|$)/.test(value)) return 'go';
  if (/\/target\/(?:debug|release)\/|\brustc\b|\bcargo\b/.test(value)) return 'rust';
  if (/(?:^|\s|\/)(?:ba)?sh(?:\s|$)|\.sh(?:\s|$)/.test(value)) return 'shell';
  return executablePath === undefined ? 'unknown' : 'binary';
}

function executableName(value: string): string {
  const normalized = value.trim().split(/\s+/)[0] ?? value;
  return path.posix.basename(normalized) || 'unknown-process';
}

function servicePaths(service: ServiceRecord): string[] {
  return [
    ...service.deployDirectories,
    ...service.configFiles,
    ...service.environmentFiles,
    ...service.logLocations,
    ...service.dataDirectories,
  ];
}

function isSafePath(value: string): boolean {
  const normalized = normalize(value);
  return (
    normalized.startsWith('/') && normalized !== '/' && !FORBIDDEN_PATH_PATTERN.test(normalized)
  );
}

function isSafeTerm(value: string | undefined): value is string {
  return (
    value !== undefined &&
    value.length > 0 &&
    value.length <= 128 &&
    !hasControlCharacters(value) &&
    !/[\\/\s*?]/.test(value) &&
    value !== '.' &&
    value !== '..'
  );
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
}

function rejectedPathReason(value: string): string {
  return FORBIDDEN_PATH_PATTERN.test(normalize(value))
    ? '路径位于伪文件系统、容器运行时或临时目录，禁止远程探测。'
    : '路径不是绝对路径或范围过宽，禁止远程探测。';
}

function normalize(value: string): string {
  return path.posix.normalize(value.trim());
}

function seedKey(seed: PathInvestigationSeed): string {
  return [
    seed.kind,
    seed.targetServiceId ?? '',
    seed.path ?? '',
    seed.searchRoot ?? '',
    seed.searchTerm ?? '',
  ].join('|');
}

function seedId(value: string): string {
  let hash = 2166136261;
  for (const character of value) hash = Math.imul(hash ^ character.codePointAt(0)!, 16777619);
  return `path-investigation:${(hash >>> 0).toString(16)}`;
}

function sortRecordArrays(record: Record<string, string[]>): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(record).map(([key, values]) => [key, [...new Set(values)].sort()]),
  );
}

export type { DiscoveryCandidate, EvidenceIndex, PathInvestigationSeed } from '@opsense/schema';
