import type {
  AiAnalysis,
  AiPathAssessment,
  AiPlan,
  AiServiceAssessment,
  ProbeRequest,
  ScanSnapshot,
  ServiceRecord,
} from '@opsense/schema';

const SYSTEM_UNIT_PATTERN =
  /^(?:acpid|auditd|chronyd?|console-getty|container-getty|cron|crond|dbus|firewalld|getty@|irqbalance|kdump|kmod-static-nodes|ldconfig|logrotate|lvm2|modprobe@|networkd-dispatcher|NetworkManager|nftables|polkit|rc-local|rescue|rsyslog|serial-getty@|snapd|sshd?|systemd-|systemd\.|systemd@|systemd-.*|systemd[^a-z]|tuned|udev|udisks2|user-runtime-dir@|user@|uuidd|wpa_supplicant)(?:\.service)?$/i;
const MIDDLEWARE_PATTERN =
  /(?:nginx|apache|httpd|haproxy|traefik|mysql|mariadb|postgres|redis|memcached|mongo|elasticsearch|opensearch|kafka|zookeeper|rabbitmq|rocketmq|nacos|etcd|minio|doris|hadoop|hdfs|yarn|spark|flink|clickhouse|prometheus|grafana|loki|jaeger|consul|vault)/i;
const INFRASTRUCTURE_PATTERN =
  /(?:docker|containerd|podman|kubelet|kubernetes|node-exporter|cadvisor)/i;
const CUSTOM_ROOT_PATTERN = /^\/(?:apps?|data|home|opt|srv|usr\/local)(?:\/|$)/;
const SYSTEM_PATH_PATTERN =
  /^\/(?:bin|boot|dev|etc|lib(?:32|64)?|proc|run|sbin|sys|usr\/(?:bin|lib|libexec|sbin)|var\/(?:cache|lib\/systemd|log\/journal|run))(?:\/|$)/;

export class BaselineRelevanceClassifier {
  public classify(snapshot: ScanSnapshot, now: () => Date = () => new Date()): AiPlan {
    const serviceAssessments = snapshot.services.map((service) =>
      classifyService(snapshot, service),
    );
    const pathAssessments = classifyPaths(snapshot);
    return {
      generatedAt: now().toISOString(),
      pathAssessments,
      probeRequests: createBaselineProbeRequests(snapshot),
      provider: 'baseline',
      serviceAssessments,
    };
  }
}

export function createFallbackAnalysis(
  snapshot: ScanSnapshot,
  plan: AiPlan,
  provider: string,
  now: () => Date = () => new Date(),
  message = '未启用 AI 解释层，以下分类来自 OpSense 本地基线规则。',
): AiAnalysis {
  const assessments = new Map(plan.serviceAssessments.map((item) => [item.serviceId, item]));
  const visible = snapshot.services.filter(
    (service) => assessments.get(service.id)?.reportPlacement !== 'system_summary',
  );
  return {
    findings: [],
    generatedAt: now().toISOString(),
    hostSummary: message,
    pathAssessments: plan.pathAssessments,
    provider,
    serviceAssessments: plan.serviceAssessments,
    serviceSummaries: visible.map((service) => {
      const assessment = assessments.get(service.id);
      return {
        evidenceIds: assessment?.evidenceIds ?? service.evidenceIds,
        notes: [assessment?.reason ?? '本地基线分类。'],
        ...(assessment?.purpose === undefined ? {} : { purpose: assessment.purpose }),
        purposeConfidence: assessment?.confidence ?? 'unknown',
        serviceId: service.id,
        summary: `${service.displayName ?? service.name} 当前状态为 ${service.status}，部署方式为 ${service.deploymentType}。`,
      };
    }),
    storageSummary: '存储事实保持原样，未生成额外 AI 推断。',
    unknowns: [],
  };
}

export function governAiPlan(
  snapshot: ScanSnapshot,
  candidate: AiPlan,
  baseline: AiPlan,
  now: () => Date = () => new Date(),
): AiPlan {
  const baselineByService = new Map(
    baseline.serviceAssessments.map((item) => [item.serviceId, item]),
  );
  const candidateByService = new Map(
    candidate.serviceAssessments.map((item) => [item.serviceId, item]),
  );
  const evidenceIds = new Set(snapshot.evidence.map((item) => item.id));
  const serviceAssessments = snapshot.services.map((service) => {
    const fallback = baselineByService.get(service.id) ?? classifyService(snapshot, service);
    const proposed = candidateByService.get(service.id);
    if (proposed === undefined) {
      if (candidate.provider !== 'codex') return fallback;
      return {
        classificationSource: 'local_candidate' as const,
        confidence: 'unknown' as const,
        evidenceIds: [...service.evidenceIds],
        importance: 'unknown' as const,
        reason: 'Codex 未返回该候选的语义判断，保留为待审查项。',
        reportPlacement: 'needs_review' as const,
        reviewItems: ['Codex 分类结果缺失，需要恢复 Agent 后继续审查。'],
        role: 'unknown' as const,
        serviceId: service.id,
        unknowns: ['服务角色、用途和重要性尚未完成 Codex 审查。'],
      };
    }
    const governed = {
      ...proposed,
      classificationSource: 'codex' as const,
      evidenceIds: proposed.evidenceIds.filter((id) => evidenceIds.has(id)),
    };
    if (mustRemainVisible(snapshot, service) && governed.reportPlacement === 'system_summary') {
      return {
        ...governed,
        reportPlacement: 'needs_review' as const,
        reason: `${governed.reason} OpSense 治理规则：失败、外部监听、自定义路径或容器化候选不得隐藏。`,
      };
    }
    return governed;
  });
  const candidatePaths = new Set(allCandidatePaths(snapshot));
  const pathAssessments = candidate.pathAssessments.filter((item) => candidatePaths.has(item.path));
  const baselinePaths = new Map(
    (candidate.provider === 'codex' ? [] : baseline.pathAssessments).map((item) => [
      item.path,
      item,
    ]),
  );
  for (const item of pathAssessments) baselinePaths.set(item.path, item);
  return {
    generatedAt: now().toISOString(),
    pathAssessments: [...baselinePaths.values()],
    probeRequests: candidate.probeRequests,
    provider: candidate.provider,
    ...(candidate.model === undefined ? {} : { model: candidate.model }),
    ...(candidate.threadId === undefined ? {} : { threadId: candidate.threadId }),
    serviceAssessments,
  };
}

export function mustRemainVisible(snapshot: ScanSnapshot, service: ServiceRecord): boolean {
  return (
    service.status === 'failed' ||
    service.deploymentType === 'docker' ||
    service.deploymentType === 'compose' ||
    service.containerIds.length > 0 ||
    service.composeProjectIds.length > 0 ||
    hasExternalSocket(snapshot, service) ||
    servicePaths(service).some((item) => CUSTOM_ROOT_PATTERN.test(item)) ||
    service.systemdUnitIds.some((id) => {
      const unit = snapshot.systemdUnits.find((item) => item.id === id);
      return (
        unit !== undefined &&
        [unit.workingDirectory, unit.fragmentPath, ...unit.execStart]
          .filter((value): value is string => value !== undefined)
          .some((value) => CUSTOM_ROOT_PATTERN.test(value))
      );
    })
  );
}

function classifyService(snapshot: ScanSnapshot, service: ServiceRecord): AiServiceAssessment {
  const name = `${service.name} ${service.displayName ?? ''}`;
  const evidenceIds = [...service.evidenceIds];
  const external = hasExternalSocket(snapshot, service);
  const customPath = servicePaths(service).some((item) => CUSTOM_ROOT_PATTERN.test(item));
  const systemUnitNames = service.systemdUnitIds.map(
    (id) =>
      snapshot.systemdUnits.find((unit) => unit.id === id)?.name ?? id.replace(/^systemd:/, ''),
  );
  const unitRecords = service.systemdUnitIds.flatMap((id) => {
    const unit = snapshot.systemdUnits.find((item) => item.id === id);
    return unit === undefined ? [] : [unit];
  });
  const packagedSystemUnit =
    unitRecords.length > 0 &&
    unitRecords.every((unit) =>
      /^\/(?:usr\/)?lib\/systemd\/system\//.test(unit.fragmentPath ?? ''),
    );
  const ordinarySystem =
    service.deploymentType === 'systemd' &&
    systemUnitNames.length > 0 &&
    !MIDDLEWARE_PATTERN.test(name) &&
    !INFRASTRUCTURE_PATTERN.test(name) &&
    (systemUnitNames.every((unit) => SYSTEM_UNIT_PATTERN.test(unit)) || packagedSystemUnit) &&
    !mustRemainVisible(snapshot, service);

  if (ordinarySystem) {
    return {
      confidence: 'inferred',
      evidenceIds,
      reason: '标准系统 unit，未发现容器、自定义部署路径、失败状态或需关注的监听端口。',
      reportPlacement: 'system_summary',
      role: 'system',
      serviceId: service.id,
    };
  }
  if (MIDDLEWARE_PATTERN.test(name)) {
    return {
      confidence: 'inferred',
      evidenceIds,
      purpose: '通用中间件或数据基础组件。',
      reason: '服务名、容器镜像或部署线索匹配常见中间件/数据平台。',
      reportPlacement: service.status === 'failed' ? 'needs_review' : 'supporting',
      role: 'middleware',
      serviceId: service.id,
    };
  }
  if (INFRASTRUCTURE_PATTERN.test(name)) {
    return {
      confidence: 'inferred',
      evidenceIds,
      reason: '服务名称匹配容器或集群基础设施组件。',
      reportPlacement: service.status === 'failed' ? 'needs_review' : 'supporting',
      role: 'infrastructure',
      serviceId: service.id,
    };
  }
  if (service.deploymentType === 'compose' || customPath || external) {
    return {
      confidence: 'inferred',
      evidenceIds,
      reason:
        service.deploymentType === 'compose'
          ? 'Compose 项目通常代表明确部署的应用或组件。'
          : customPath
            ? '发现 /opt、/srv、/data、/apps、/home 或 /usr/local 下的自定义部署路径。'
            : '服务存在对外监听端口，需要在部署服务清单中保留。',
      reportPlacement: 'primary',
      role: 'application',
      serviceId: service.id,
    };
  }
  if (service.deploymentType === 'docker' || service.containerIds.length > 0) {
    return {
      confidence: 'inferred',
      evidenceIds,
      reason: '容器候选至少作为支撑组件保留，等待业务语义确认。',
      reportPlacement: 'supporting',
      role: 'unknown',
      serviceId: service.id,
    };
  }
  return {
    confidence: 'unknown',
    evidenceIds,
    reason: '现有事实不足以可靠区分业务应用与系统组件。',
    reportPlacement: 'needs_review',
    role: 'unknown',
    serviceId: service.id,
  };
}

function classifyPaths(snapshot: ScanSnapshot): AiPathAssessment[] {
  const serviceIdsByPath = new Map<string, Set<string>>();
  for (const service of snapshot.services) {
    for (const value of servicePaths(service)) {
      const ids = serviceIdsByPath.get(value) ?? new Set<string>();
      ids.add(service.id);
      serviceIdsByPath.set(value, ids);
    }
  }
  return allCandidatePaths(snapshot).map((value) => {
    const artifact = snapshot.artifacts.find((item) => item.path === value);
    const semantic = pathSemantic(value, artifact?.kind);
    return {
      confidence: semantic === 'unknown' ? ('unknown' as const) : ('inferred' as const),
      evidenceIds: artifact?.evidenceIds ?? [],
      path: value,
      reason:
        semantic === 'system' ? '路径位于标准系统目录。' : '根据路径位置和采集到的文件类型推断。',
      semantic,
      serviceIds: [...(serviceIdsByPath.get(value) ?? [])],
    };
  });
}

function createBaselineProbeRequests(snapshot: ScanSnapshot): ProbeRequest[] {
  const roots = approvedSearchRoots(snapshot);
  if (roots.length === 0) return [];
  return snapshot.services.slice(0, 20).flatMap((service) => {
    if (servicePaths(service).length > 0) return [];
    const root = roots[0];
    const evidenceId = service.evidenceIds[0];
    if (root === undefined || evidenceId === undefined) return [];
    return [
      {
        evidenceIds: [evidenceId],
        expectedFields: ['deployDirectories', 'configFiles', 'dataDirectories', 'logLocations'],
        id: `probe:path-search:${sanitizeId(service.id)}:${sanitizeId(root)}`,
        kind: 'path_search' as const,
        maxBytes: 262_144,
        maxDepth: 4,
        maxMatches: 50,
        reason: '已识别服务名称但缺少部署目录线索，在批准根目录内进行受限名称搜索。',
        searchRoot: root,
        searchTerm: service.name.replace(/\.service$/i, ''),
        targetServiceId: service.id,
        timeoutMs: 15_000,
      },
    ];
  });
}

function approvedSearchRoots(snapshot: ScanSnapshot): string[] {
  const roots = new Set<string>();
  for (const seed of snapshot.pathSeeds ?? []) {
    if (/^\/(?:opt|srv|data|apps)(?:\/|$)/.test(seed.path)) roots.add(seed.path);
  }
  for (const mount of snapshot.storage?.mounts ?? []) {
    if (
      !mount.pseudo &&
      !mount.temporary &&
      /^\/(?:opt|srv|data|apps)(?:\/|$)/.test(mount.target)
    ) {
      roots.add(mount.target);
    }
  }
  return [...roots].sort();
}

function allCandidatePaths(snapshot: ScanSnapshot): string[] {
  return [
    ...new Set([
      ...snapshot.artifacts
        .filter((item) => item.kind !== 'directory' && item.kind !== 'other')
        .sort(
          (left, right) =>
            artifactPriority(left.kind) - artifactPriority(right.kind) ||
            left.path.localeCompare(right.path),
        )
        .slice(0, 500)
        .map((item) => item.path),
      ...(snapshot.pathSeeds ?? []).map((item) => item.path),
      ...snapshot.services.flatMap(servicePaths),
    ]),
  ].sort();
}

function artifactPriority(kind: string): number {
  return (
    { compose: 0, config: 1, environment: 2, executable: 3, script: 4, data: 5, log: 6, backup: 7 }[
      kind
    ] ?? 8
  );
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

function hasExternalSocket(snapshot: ScanSnapshot, service: ServiceRecord): boolean {
  const socketIds = new Set(service.socketIds);
  return snapshot.sockets.some((socket) => socketIds.has(socket.id) && socket.exposed);
}

function pathSemantic(path: string, kind: string | undefined): AiPathAssessment['semantic'] {
  if (SYSTEM_PATH_PATTERN.test(path)) return 'system';
  if (kind === 'config' || kind === 'environment' || kind === 'compose') return 'config';
  if (kind === 'data') return 'data';
  if (kind === 'log') return 'log';
  if (kind === 'backup') return 'backup';
  if (kind === 'executable' || kind === 'script') return 'runtime';
  if (CUSTOM_ROOT_PATTERN.test(path)) return 'deploy';
  return 'unknown';
}

function sanitizeId(value: string): string {
  return value.replace(/[^A-Za-z0-9._:-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '') || 'unknown';
}
