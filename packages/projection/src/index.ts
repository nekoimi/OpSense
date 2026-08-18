import path from 'node:path';

import { BaselineRelevanceClassifier, governAiPlan } from '@opsense/ai-provider';
import { requiredServiceInvestigationReasons } from '@opsense/discovery';
import { InventoryProjectionSchema, assertSchema } from '@opsense/schema';
import type {
  AgentDecision,
  AiPlan,
  AiPathAssessment,
  AiServiceAssessment,
  DiscoveryCandidate,
  DiscoveredService,
  InventoryProjection,
  AiAnalysis,
  DiscoveryWorkspace,
  MountRecord,
  NetworkInterface,
  ScanSnapshot,
  ServiceRecord,
  PlanDiscoveryArguments,
  VisibilityDecision,
  WikiNarrativeDraft,
} from '@opsense/schema';

export interface BuildInventoryProjectionOptions {
  analysis?: AiAnalysis;
  mode?: 'legacy' | 'agent';
  now?: () => Date;
  previousProjection?: InventoryProjection;
  workflowVersion?: 'm19_full_candidate_review' | 'm20_evidence_driven';
}

export interface ApplyProjectionDecisionOptions {
  now?: () => Date;
  threadId?: string;
}

export interface ApplyDiscoveryPlanOptions {
  now?: () => Date;
  threadId?: string;
}

export interface ApplyWikiNarrativeOptions {
  model?: string;
  now?: () => Date;
  threadId?: string;
}

export interface CodexClassificationStatus {
  candidatePathCount: number;
  candidateServiceCount: number;
  completed: boolean;
  provider?: string;
  reviewedPathCount: number;
  reviewedServiceCount: number;
  unreviewedPathKeys: string[];
  unreviewedServiceIds: string[];
}

const CONTAINER_INTERFACE_PATTERN =
  /^(?:docker(?:\d+)?|br-[a-f0-9]+|veth|virbr|cni|flannel|cali|tunl)/i;
const RUNTIME_MOUNT_PATTERN =
  /(?:overlay2|containers\/storage|containerd|podman|docker\/containers)/i;
const PSEUDO_TARGET_PATTERN = /^\/(?:proc|sys|dev|run)(?:\/|$)/;

function buildDiscoveryWorkspace(
  previous: DiscoveryWorkspace | undefined,
  updatedAt: string,
): DiscoveryWorkspace {
  return {
    discoveryCompleted: previous?.discoveryCompleted ?? false,
    discoveredServices: [...(previous?.discoveredServices ?? [])],
    filteredGroups: [...(previous?.filteredGroups ?? [])],
    investigations: [...(previous?.investigations ?? [])],
    planningCompleted: previous?.planningCompleted ?? false,
    unresolvedQuestions: [...(previous?.unresolvedQuestions ?? [])],
    updatedAt,
    workflowVersion: 'm20_evidence_driven',
  };
}

export function buildInventoryProjection(
  snapshot: ScanSnapshot,
  options: BuildInventoryProjectionOptions = {},
): InventoryProjection {
  const now = options.now ?? (() => new Date());
  const generatedAt = now().toISOString();
  const mode = options.mode ?? 'legacy';
  const workflowVersion = options.workflowVersion ?? 'm19_full_candidate_review';
  const evidenceDriven = mode === 'agent' && workflowVersion === 'm20_evidence_driven';
  const migratingFromM19 =
    evidenceDriven &&
    options.previousProjection !== undefined &&
    options.previousProjection.discoveryWorkspace === undefined;
  const baselinePlan: AiPlan =
    mode === 'agent'
      ? {
          generatedAt,
          pathAssessments: [],
          probeRequests: [],
          provider: 'local_candidate',
          serviceAssessments: [],
        }
      : new BaselineRelevanceClassifier().classify(snapshot, () => new Date(generatedAt));
  const analysis = mode === 'agent' ? undefined : (options.analysis ?? snapshot.aiAnalysis);
  const legacyAssessments =
    analysis === undefined
      ? baselinePlan.serviceAssessments
      : governAiPlan(
          snapshot,
          {
            generatedAt: analysis.generatedAt,
            pathAssessments: analysis.pathAssessments,
            probeRequests: [],
            provider: analysis.provider,
            serviceAssessments: analysis.serviceAssessments,
            ...(analysis.model === undefined ? {} : { model: analysis.model }),
            ...(analysis.threadId === undefined ? {} : { threadId: analysis.threadId }),
          },
          baselinePlan,
          () => new Date(generatedAt),
        ).serviceAssessments;
  const previous = options.previousProjection;
  const projectedServices =
    mode === 'agent'
      ? mergeServices(
          snapshot.services,
          (previous?.services ?? []).filter((service) => service.id.startsWith('service:orphan:')),
        )
      : [...snapshot.services];
  const serviceIds = new Set(projectedServices.map((service) => service.id));
  const workspace = evidenceDriven
    ? buildDiscoveryWorkspace(previous?.discoveryWorkspace, generatedAt)
    : undefined;
  const selectedServiceIds = new Set(
    workspace?.investigations.flatMap((item) => item.serviceIds) ??
      projectedServices.map((item) => item.id),
  );
  const candidatePathKeys = servicePathKeys(
    evidenceDriven
      ? projectedServices.filter((service) => selectedServiceIds.has(service.id))
      : projectedServices,
  );
  const reviewedServiceIds =
    mode === 'agent'
      ? migratingFromM19
        ? []
        : [
            ...new Set(
              (previous?.reviewedServiceIds ?? []).filter((serviceId) => serviceIds.has(serviceId)),
            ),
          ]
      : [];
  const reviewedPathKeys =
    mode === 'agent'
      ? migratingFromM19
        ? []
        : [
            ...new Set(
              [
                ...(previous?.reviewedPathKeys ?? []),
                ...(previous?.pathAssessments ?? []).flatMap((assessment) =>
                  assessment.serviceIds.map((serviceId) => pathKey(serviceId, assessment.path)),
                ),
              ].filter((key) => candidatePathKeys.includes(key)),
            ),
          ]
      : [];
  const previousAssessments = new Map(
    (mode === 'agent' && !migratingFromM19 ? (previous?.serviceAssessments ?? []) : [])
      .filter(
        (assessment) =>
          serviceIds.has(assessment.serviceId) &&
          (assessment.classificationSource === 'codex' ||
            reviewedServiceIds.includes(assessment.serviceId)),
      )
      .map((assessment) => [assessment.serviceId, assessment]),
  );
  const serviceAssessments =
    mode === 'agent'
      ? (evidenceDriven
          ? projectedServices.filter((service) => previousAssessments.has(service.id))
          : projectedServices
        ).map(
          (service): AiServiceAssessment =>
            previousAssessments.get(service.id) ?? {
              classificationSource: 'local_candidate',
              confidence: 'unknown',
              evidenceIds: [...service.evidenceIds],
              importance: 'unknown',
              reason: '等待 Codex 根据已采集证据完成服务语义审查。',
              reportPlacement: 'needs_review',
              reviewItems: ['等待 Codex 完成服务角色和报告位置判断。'],
              role: 'unknown',
              serviceId: service.id,
              unknowns: ['服务用途和重要性尚未由 Codex 确认。'],
            },
        )
      : legacyAssessments.map((assessment) => ({
          ...assessment,
          classificationSource:
            analysis?.provider === 'codex' ? ('legacy' as const) : ('baseline' as const),
        }));
  const visibilityDecisions: VisibilityDecision[] = [];
  const servicePaths = new Map(
    projectedServices.map((service) => [service.id, servicePathsFor(service)]),
  );
  const visibleInterfaces = (snapshot.network?.interfaces ?? []).filter((item) => {
    const filtered = isContainerInterface(item);
    visibilityDecisions.push(
      visibilityDecision(
        item.id,
        'network_interface',
        filtered ? 'filtered' : 'primary',
        filtered ? '容器运行时内部网络接口，不进入主机网络正文。' : '主机网络接口候选。',
        'host_interface',
        item.evidenceIds,
      ),
    );
    return !filtered;
  });
  const visibleMounts = (snapshot.storage?.mounts ?? []).filter((item) => {
    const filtered = isRuntimeMount(item);
    const relatedServiceIds = relatedServices(item, servicePaths);
    visibilityDecisions.push(
      visibilityDecision(
        item.id,
        'mount',
        filtered ? 'filtered' : relatedServiceIds.length > 0 ? 'supporting' : 'primary',
        filtered
          ? '容器运行时、伪文件系统或临时挂载，不进入主机存储正文。'
          : relatedServiceIds.length > 0
            ? '挂载路径与已知服务目录关联，保留为服务附属资源。'
            : '主机有效挂载候选。',
        filtered
          ? 'container_runtime_mount'
          : relatedServiceIds.length > 0
            ? 'service_mount'
            : 'host_mount',
        item.evidenceIds,
        relatedServiceIds,
      ),
    );
    return !filtered;
  });
  const filteredInterfaceCount =
    (snapshot.network?.interfaces.length ?? 0) - visibleInterfaces.length;
  const filteredMountCount = (snapshot.storage?.mounts.length ?? 0) - visibleMounts.length;
  const projection: InventoryProjection = {
    artifacts: [...snapshot.artifacts],
    composeProjects: [...snapshot.composeProjects],
    containers: [...snapshot.containers],
    evidence: [...snapshot.evidence],
    filteredCounts: {
      'network.container_network': filteredInterfaceCount,
      'storage.runtime_mount': filteredMountCount,
    },
    findings: [...snapshot.findings],
    generatedAt,
    ...(snapshot.host === undefined ? {} : { host: snapshot.host }),
    ...(snapshot.network === undefined
      ? {}
      : {
          network: {
            ...snapshot.network,
            interfaces: visibleInterfaces,
          },
        }),
    ...(snapshot.pathSeeds === undefined ? {} : { pathSeeds: [...snapshot.pathSeeds] }),
    processes: [...snapshot.processes],
    projectionId: `projection:${snapshot.session.id}`,
    ...(snapshot.redaction === undefined ? {} : { redaction: snapshot.redaction }),
    ...(analysis === undefined ? {} : { analysis }),
    services: projectedServices,
    serviceAssessments,
    ...(mode === 'agent'
      ? {
          candidateServiceCount: selectedServiceIds.size,
          candidatePathCount: candidatePathKeys.length,
          candidatePathKeys,
          classificationCompleted: evidenceDriven
            ? workspace?.discoveryCompleted === true &&
              [...selectedServiceIds].every((serviceId) => reviewedServiceIds.includes(serviceId))
            : projectedServices.length === reviewedServiceIds.length &&
              projectedServices.every((service) => reviewedServiceIds.includes(service.id)) &&
              candidatePathKeys.length === reviewedPathKeys.length,
          classificationProvider: 'codex' as const,
          classificationUpdatedAt: generatedAt,
          pathAssessments: migratingFromM19 ? [] : [...(previous?.pathAssessments ?? [])],
          reviewedServiceCount: reviewedServiceIds.length,
          reviewedServiceIds,
          reviewedPathCount: reviewedPathKeys.length,
          reviewedPathKeys,
          ...(migratingFromM19 || previous?.classificationThreadId === undefined
            ? {}
            : { classificationThreadId: previous.classificationThreadId }),
          ...(workspace === undefined ? {} : { discoveryWorkspace: workspace }),
          ...(migratingFromM19 || previous?.wikiNarrative === undefined
            ? {}
            : { wikiNarrative: previous.wikiNarrative }),
        }
      : {
          candidateServiceCount: projectedServices.length,
          candidatePathCount: candidatePathKeys.length,
          candidatePathKeys,
          classificationCompleted: false,
          classificationProvider: (analysis?.provider === 'codex' ? 'legacy' : 'baseline') as
            'legacy' | 'baseline',
          classificationUpdatedAt: generatedAt,
          pathAssessments: [...(analysis?.pathAssessments ?? baselinePlan.pathAssessments)],
          reviewedServiceCount: 0,
          reviewedServiceIds: [],
          reviewedPathCount: 0,
          reviewedPathKeys: [],
        }),
    session: snapshot.session,
    sockets: [...snapshot.sockets],
    ...(snapshot.storage === undefined
      ? {}
      : {
          storage: {
            ...snapshot.storage,
            mounts: visibleMounts,
          },
        }),
    systemdUnits: [...snapshot.systemdUnits],
    unknowns: [...snapshot.unknowns],
    visibilityDecisions,
    sourceSnapshotId: snapshot.session.id,
  };
  if (evidenceDriven && projection.discoveryWorkspace !== undefined) {
    const missingRequired = missingRequiredInvestigationServices(projection);
    if (missingRequired.length > 0) {
      projection.discoveryWorkspace.planningCompleted = false;
      projection.discoveryWorkspace.discoveryCompleted = false;
      projection.classificationCompleted = false;
      delete projection.wikiNarrative;
    }
  }
  assertSchema(InventoryProjectionSchema, projection);
  return projection;
}

export function promoteOrphanProcessCandidates(
  projection: InventoryProjection,
  candidates: readonly DiscoveryCandidate[],
): string[] {
  const existingProcessIds = new Set(projection.services.flatMap((service) => service.processIds));
  const added: string[] = [];
  for (const candidate of candidates) {
    if (candidate.serviceId !== undefined || candidate.sourceKind !== 'process') continue;
    const processes = projection.processes.filter(
      (process) => candidate.sourceIds.includes(process.id) && !existingProcessIds.has(process.pid),
    );
    if (processes.length === 0) continue;
    const processIds = processes.map((process) => process.pid);
    const sockets = projection.sockets.filter((socket) =>
      socket.processIds.some((pid) => processIds.includes(pid)),
    );
    const customExecutablePaths = processes.flatMap((process) =>
      [process.executablePath, process.workingDirectory, ...process.arguments]
        .filter(
          (value): value is string =>
            value !== undefined && /^\/(?:apps?|data|home|opt|srv|usr\/local)(?:\/|$)/.test(value),
        )
        .map((value) => (path.posix.extname(value).length > 0 ? path.posix.dirname(value) : value)),
    );
    const highValue =
      sockets.some((socket) => socket.listening) ||
      customExecutablePaths.length > 0 ||
      ['java', 'go', 'rust', 'container'].includes(candidate.runtimeKind);
    if (!highValue) continue;
    const serviceId = `service:orphan:${candidate.candidateId}`;
    if (projection.services.some((service) => service.id === serviceId)) continue;
    const service: ServiceRecord = {
      composeProjectIds: [],
      confidence: candidate.confidence,
      configFiles: [],
      containerIds: [],
      dataDirectories: [],
      deployDirectories: [...new Set(customExecutablePaths)],
      deploymentType: 'process',
      displayName: candidate.displayName,
      environmentFiles: [],
      evidenceIds: [
        ...new Set([
          ...candidate.evidenceIds,
          ...processes.flatMap((process) => process.evidenceIds),
          ...sockets.flatMap((socket) => socket.evidenceIds),
        ]),
      ],
      id: serviceId,
      logLocations: [],
      name: candidate.displayName,
      processIds,
      socketIds: sockets.map((socket) => socket.id),
      status: 'running',
      systemdUnitIds: [],
      unknownFields: ['purpose', 'enabledAtBoot', 'configFiles', 'logLocations', 'dataDirectories'],
    };
    projection.services.push(service);
    if (projection.discoveryWorkspace?.workflowVersion !== 'm20_evidence_driven')
      projection.serviceAssessments.push({
        classificationSource: 'local_candidate',
        confidence: 'unknown',
        evidenceIds: [...service.evidenceIds],
        importance: 'unknown',
        reason: '高价值孤立进程候选，等待 Codex 判断是否属于部署服务。',
        reportPlacement: 'needs_review',
        reviewItems: ['孤立进程尚未归并到已有服务，需要 Codex 审查。'],
        role: 'unknown',
        serviceId,
        unknowns: ['服务用途、部署方式和路径角色尚未确认。'],
      });
    processIds.forEach((pid) => existingProcessIds.add(pid));
    added.push(serviceId);
  }
  if (added.length === 0) return [];
  const selectedServiceIds = new Set(
    projection.discoveryWorkspace?.investigations.flatMap((item) => item.serviceIds) ??
      projection.services.map((service) => service.id),
  );
  const candidatePathKeys = servicePathKeys(
    projection.services.filter((service) => selectedServiceIds.has(service.id)),
  );
  projection.candidateServiceCount = selectedServiceIds.size;
  projection.candidatePathKeys = candidatePathKeys;
  projection.candidatePathCount = candidatePathKeys.length;
  projection.classificationCompleted = false;
  projection.classificationUpdatedAt = new Date().toISOString();
  if (projection.discoveryWorkspace?.workflowVersion === 'm20_evidence_driven') {
    projection.discoveryWorkspace.discoveryCompleted = false;
    projection.discoveryWorkspace.updatedAt = projection.classificationUpdatedAt;
  }
  assertSchema(InventoryProjectionSchema, projection);
  return added;
}

export function applyDiscoveryPlan(
  projection: InventoryProjection,
  plan: PlanDiscoveryArguments,
  options: ApplyDiscoveryPlanOptions = {},
): string[] {
  if (projection.discoveryWorkspace?.workflowVersion !== 'm20_evidence_driven')
    throw new Error('当前 Projection 不是 M20 证据驱动工作区。');
  const next = structuredClone(projection);
  delete next.wikiNarrative;
  const evidenceIds = new Set(next.evidence.map((item) => item.id));
  const sourceIds = new Set([
    ...next.services.map((item) => item.id),
    ...next.systemdUnits.map((item) => item.id),
    ...next.processes.map((item) => item.id),
    ...next.sockets.map((item) => item.id),
    ...next.containers.map((item) => item.id),
    ...next.composeProjects.map((item) => item.id),
    ...(next.pathSeeds ?? []).map((item) => item.id),
  ]);
  const serviceIds = new Set(next.services.map((item) => item.id));
  const changedIds = new Set<string>();
  const verify = (ids: readonly string[], label: string, known: Set<string>): void => {
    for (const id of ids)
      if (!known.has(id)) throw new Error(`${label} 引用了不存在的对象：${id}。`);
  };

  for (const declaration of plan.discoveredServices) {
    if (!declaration.serviceId.startsWith('service:agent:'))
      throw new Error(`Codex 发现服务必须使用 service:agent: 前缀：${declaration.serviceId}。`);
    verify(declaration.evidenceIds, `发现服务 ${declaration.serviceId}`, evidenceIds);
    verify(declaration.sourceObjectIds, `发现服务 ${declaration.serviceId}`, sourceIds);
    if (serviceIds.has(declaration.serviceId))
      throw new Error(`Codex 发现服务 ID 已存在：${declaration.serviceId}。`);
    const service = discoveredServiceRecord(next, declaration);
    next.services.push(service);
    serviceIds.add(service.id);
    changedIds.add(service.id);
  }
  for (const investigation of plan.investigations) {
    verify(investigation.evidenceIds, `调查 ${investigation.investigationId}`, evidenceIds);
    verify(investigation.sourceObjectIds, `调查 ${investigation.investigationId}`, sourceIds);
    verify(investigation.serviceIds, `调查 ${investigation.investigationId}`, serviceIds);
    changedIds.add(investigation.investigationId);
    investigation.serviceIds.forEach((id) => changedIds.add(id));
  }
  for (const group of plan.filteredGroups) {
    verify(group.evidenceIds, `过滤组 ${group.groupId}`, evidenceIds);
    verify(group.sourceObjectIds, `过滤组 ${group.groupId}`, sourceIds);
    for (const serviceId of group.sourceObjectIds.filter((id) => serviceIds.has(id))) {
      const service = next.services.find((item) => item.id === serviceId);
      if (service !== undefined && mustRemainVisible(next, service))
        throw new Error(`安全可见性规则禁止过滤高价值服务：${serviceId}。`);
    }
    changedIds.add(group.groupId);
  }

  const workspace: DiscoveryWorkspace = {
    discoveryCompleted: plan.discoveryCompleted,
    discoveredServices: plan.discoveredServices.map((item) => ({ ...item })),
    filteredGroups: plan.filteredGroups.map((item) => ({ ...item })),
    investigations: plan.investigations.map((item) => ({ ...item })),
    planningCompleted: plan.planningCompleted,
    unresolvedQuestions: [...new Set(plan.unresolvedQuestions)],
    updatedAt: (options.now ?? (() => new Date()))().toISOString(),
    workflowVersion: 'm20_evidence_driven',
  };
  const selected = new Set(workspace.investigations.flatMap((item) => item.serviceIds));
  if (workspace.planningCompleted) {
    next.discoveryWorkspace = workspace;
    const missingRequired = missingRequiredInvestigationServices(next);
    if (missingRequired.length > 0) {
      const missingIds = missingRequired.map((service) => service.id);
      throw new Error(
        `Codex 调查计划遗漏 ${missingRequired.length} 个受保护服务。轻量服务索引已经完整读取，不要再次调用 list_candidates；请将以下全部 ID 补入一个或多个 investigation 后重新提交 plan_discovery：${JSON.stringify(missingIds)}。`,
      );
    }
  }
  const candidatePathKeys = servicePathKeys(
    next.services.filter((service) => selected.has(service.id)),
  );
  const reviewed = new Set(next.reviewedServiceIds ?? []);
  next.discoveryWorkspace = workspace;
  next.serviceAssessments = next.serviceAssessments.filter((item) => selected.has(item.serviceId));
  next.pathAssessments = (next.pathAssessments ?? []).filter((item) =>
    item.serviceIds.some((serviceId) => selected.has(serviceId)),
  );
  next.candidateServiceCount = selected.size;
  next.candidatePathKeys = candidatePathKeys;
  next.candidatePathCount = candidatePathKeys.length;
  next.reviewedServiceIds = [...selected].filter((id) => reviewed.has(id));
  next.reviewedServiceCount = next.reviewedServiceIds.length;
  next.reviewedPathKeys = (next.reviewedPathKeys ?? []).filter((key) =>
    candidatePathKeys.includes(key),
  );
  next.reviewedPathCount = next.reviewedPathKeys.length;
  next.classificationProvider = 'codex';
  next.classificationCompleted =
    workspace.discoveryCompleted && [...selected].every((id) => reviewed.has(id));
  next.classificationUpdatedAt = workspace.updatedAt;
  if (options.threadId !== undefined) next.classificationThreadId = options.threadId;
  next.filteredCounts = {
    ...next.filteredCounts,
    'discovery.filtered_objects': workspace.filteredGroups.reduce(
      (total, group) => total + group.sourceObjectIds.length,
      0,
    ),
  };
  assertSchema(InventoryProjectionSchema, next);
  Object.assign(projection, next);
  return [...changedIds];
}

function discoveredServiceRecord(
  projection: InventoryProjection,
  declaration: DiscoveredService,
): ServiceRecord {
  const sourceIds = new Set(declaration.sourceObjectIds);
  const systemdUnitIds = projection.systemdUnits
    .filter((item) => sourceIds.has(item.id))
    .map((item) => item.id);
  const processIds = projection.processes
    .filter((item) => sourceIds.has(item.id))
    .map((item) => item.pid);
  const socketIds = projection.sockets
    .filter((item) => sourceIds.has(item.id))
    .map((item) => item.id);
  const containerIds = projection.containers
    .filter((item) => sourceIds.has(item.id))
    .map((item) => item.id);
  const composeProjectIds = projection.composeProjects
    .filter((item) => sourceIds.has(item.id))
    .map((item) => item.id);
  const paths = (projection.pathSeeds ?? [])
    .filter((item) => sourceIds.has(item.id))
    .map((item) => item.path);
  return {
    composeProjectIds,
    confidence: 'unknown',
    configFiles: [],
    containerIds,
    dataDirectories: [],
    deployDirectories: paths,
    deploymentType: declaration.deploymentType,
    ...(declaration.displayName === undefined ? {} : { displayName: declaration.displayName }),
    environmentFiles: [],
    evidenceIds: [...new Set(declaration.evidenceIds)],
    id: declaration.serviceId,
    logLocations: [],
    name: declaration.name,
    processIds,
    socketIds,
    status: declaration.status,
    systemdUnitIds,
    unknownFields: [...new Set(declaration.unknownFields)],
  };
}

export function applyProjectionDecision(
  projection: InventoryProjection,
  decision: Extract<AgentDecision, { kind: 'projection_update' }>,
  options: ApplyProjectionDecisionOptions = {},
): string[] {
  const now = options.now ?? (() => new Date());
  const next = structuredClone(projection);
  delete next.wikiNarrative;
  const evidenceIds = new Set(next.evidence.map((item) => item.id));
  const services = new Map(next.services.map((service) => [service.id, service]));
  const evidenceDriven = next.discoveryWorkspace?.workflowVersion === 'm20_evidence_driven';
  const selectedServiceIds = new Set(
    evidenceDriven
      ? next.discoveryWorkspace?.investigations.flatMap((item) => item.serviceIds)
      : [],
  );
  const reviewed = new Set(next.reviewedServiceIds ?? []);
  const candidatePathKeySet = new Set(next.candidatePathKeys ?? servicePathKeys(next.services));
  const reviewedPaths = new Set(next.reviewedPathKeys ?? []);
  const changedIds = new Set<string>();

  for (const change of decision.changes) {
    if (change.changeType === 'service_assessment') {
      const update = change.assessment;
      if (change.objectId !== update.serviceId)
        throw new Error(`服务评估 objectId 与 serviceId 不一致：${change.objectId}。`);
      const service = services.get(update.serviceId);
      if (service === undefined) throw new Error(`服务不存在：${update.serviceId}。`);
      if (evidenceDriven && !selectedServiceIds.has(update.serviceId))
        throw new Error(`服务尚未进入 Codex 调查工作区：${update.serviceId}。`);
      assertEvidenceIds(update.evidenceIds, evidenceIds, update.serviceId);
      if (update.confidence !== 'unknown' && update.evidenceIds.length === 0)
        throw new Error(`非 unknown 服务判断必须引用 Evidence ID：${update.serviceId}。`);
      if (update.reportPlacement === 'system_summary' && update.evidenceIds.length === 0)
        throw new Error(`隐藏到系统摘要的判断必须引用 Evidence ID：${update.serviceId}。`);
      if ((update.role === 'system') !== (update.reportPlacement === 'system_summary'))
        throw new Error(`system 角色必须与 system_summary 报告位置成对：${update.serviceId}。`);
      if (update.reportPlacement === 'system_summary' && mustRemainVisible(next, service))
        throw new Error(`安全可见性规则禁止将服务隐藏到系统摘要：${update.serviceId}。`);
      const assessment: AiServiceAssessment = {
        classificationSource: 'codex',
        confidence: update.confidence,
        evidenceIds: [...new Set(update.evidenceIds)],
        importance: update.importance,
        reason: update.reason,
        reportPlacement: update.reportPlacement,
        reviewItems: [...new Set(update.reviewItems)],
        role: update.role,
        serviceId: update.serviceId,
        unknowns: [...new Set(update.unknowns)],
        ...(update.purpose === undefined ? {} : { purpose: update.purpose }),
        ...(update.statusInterpretation === undefined
          ? {}
          : { statusInterpretation: update.statusInterpretation }),
      };
      const index = next.serviceAssessments.findIndex(
        (item) => item.serviceId === update.serviceId,
      );
      if (index === -1) next.serviceAssessments.push(assessment);
      else next.serviceAssessments[index] = assessment;
      reviewed.add(update.serviceId);
      changedIds.add(update.serviceId);
      continue;
    }

    const update = change.assessment;
    if (change.objectId !== update.serviceId)
      throw new Error(`路径评估 objectId 与 serviceId 不一致：${change.objectId}。`);
    const service = services.get(update.serviceId);
    if (service === undefined) throw new Error(`路径评估引用了不存在的服务：${update.serviceId}。`);
    if (evidenceDriven && !selectedServiceIds.has(update.serviceId))
      throw new Error(`路径所属服务尚未进入 Codex 调查工作区：${update.serviceId}。`);
    const updatePathKey = pathKey(update.serviceId, update.path);
    if (!candidatePathKeySet.has(updatePathKey) && !candidatePaths(next).has(update.path))
      throw new Error(`路径评估引用了未采集的候选路径：${update.path}。`);
    assertEvidenceIds(update.evidenceIds, evidenceIds, update.path);
    if (update.confidence !== 'unknown' && update.evidenceIds.length === 0)
      throw new Error(`非 unknown 路径判断必须引用 Evidence ID：${update.path}。`);
    const pathAssessment: AiPathAssessment = {
      confidence: update.confidence,
      evidenceIds: [...new Set(update.evidenceIds)],
      path: update.path,
      reason: update.reason,
      semantic: update.semantic,
      serviceIds: [update.serviceId],
    };
    const pathAssessments = next.pathAssessments ?? [];
    const index = pathAssessments.findIndex(
      (item) => item.path === update.path && item.serviceIds.includes(update.serviceId),
    );
    if (index === -1) pathAssessments.push(pathAssessment);
    else pathAssessments[index] = pathAssessment;
    next.pathAssessments = pathAssessments;
    if (candidatePathKeySet.has(updatePathKey)) reviewedPaths.add(updatePathKey);
    changedIds.add(update.serviceId);
  }

  const candidateServiceIds = evidenceDriven
    ? [...selectedServiceIds]
    : next.services.map((service) => service.id);
  const reviewedServiceIds = candidateServiceIds.filter((serviceId) => reviewed.has(serviceId));
  next.candidateServiceCount = candidateServiceIds.length;
  next.candidatePathKeys = [...candidatePathKeySet];
  next.candidatePathCount = candidatePathKeySet.size;
  next.reviewedServiceIds = reviewedServiceIds;
  next.reviewedServiceCount = reviewedServiceIds.length;
  next.reviewedPathKeys = [...candidatePathKeySet].filter((key) => reviewedPaths.has(key));
  next.reviewedPathCount = next.reviewedPathKeys.length;
  next.classificationProvider = 'codex';
  next.classificationCompleted = evidenceDriven
    ? next.discoveryWorkspace?.discoveryCompleted === true &&
      reviewedServiceIds.length === candidateServiceIds.length
    : reviewedServiceIds.length === candidateServiceIds.length &&
      next.reviewedPathCount === next.candidatePathCount;
  next.classificationUpdatedAt = now().toISOString();
  if (options.threadId !== undefined) next.classificationThreadId = options.threadId;
  assertSchema(InventoryProjectionSchema, next);
  Object.assign(projection, next);
  return [...changedIds];
}

export function codexClassificationStatus(
  projection: InventoryProjection,
): CodexClassificationStatus {
  const evidenceDriven = projection.discoveryWorkspace?.workflowVersion === 'm20_evidence_driven';
  const candidateServiceIds = evidenceDriven
    ? [
        ...new Set(
          projection.discoveryWorkspace?.investigations.flatMap((item) => item.serviceIds) ?? [],
        ),
      ]
    : projection.services.map((service) => service.id);
  const candidatePathKeys = evidenceDriven
    ? (projection.candidatePathKeys ?? [])
    : (projection.candidatePathKeys ?? servicePathKeys(projection.services));
  const reviewed = new Set(projection.reviewedServiceIds ?? []);
  const reviewedPaths = new Set(projection.reviewedPathKeys ?? []);
  const unreviewedServiceIds = candidateServiceIds.filter((serviceId) => !reviewed.has(serviceId));
  const unreviewedPathKeys = candidatePathKeys.filter((key) => !reviewedPaths.has(key));
  const completed =
    projection.classificationProvider === 'codex' &&
    projection.classificationCompleted === true &&
    unreviewedServiceIds.length === 0 &&
    (evidenceDriven || unreviewedPathKeys.length === 0) &&
    projection.reviewedServiceCount === candidateServiceIds.length &&
    (evidenceDriven || projection.reviewedPathCount === candidatePathKeys.length);
  return {
    candidatePathCount: candidatePathKeys.length,
    candidateServiceCount: candidateServiceIds.length,
    completed,
    ...(projection.classificationProvider === undefined
      ? {}
      : { provider: projection.classificationProvider }),
    reviewedPathCount: candidatePathKeys.length - unreviewedPathKeys.length,
    reviewedServiceCount: candidateServiceIds.length - unreviewedServiceIds.length,
    unreviewedPathKeys,
    unreviewedServiceIds,
  };
}

export function assertCodexClassificationComplete(projection: InventoryProjection): void {
  const status = codexClassificationStatus(projection);
  if (!status.completed)
    throw new Error(
      `Wiki 要求 Codex 完成全部语义审查：服务 ${status.reviewedServiceCount}/${status.candidateServiceCount}，路径 ${status.reviewedPathCount}/${status.candidatePathCount}。`,
    );
  if (projection.classificationThreadId === undefined)
    throw new Error('Wiki 缺少 Codex Thread 审计标识。');
}

export function applyWikiNarrative(
  projection: InventoryProjection,
  draft: WikiNarrativeDraft,
  options: ApplyWikiNarrativeOptions = {},
): string[] {
  assertCodexClassificationComplete(projection);
  if (options.threadId === undefined) throw new Error('AI Wiki 综合稿件缺少 Codex Thread ID。');
  const assessedServiceIds = new Set(
    projection.serviceAssessments.map((assessment) => assessment.serviceId),
  );
  const evidenceIds = new Set(projection.evidence.map((evidence) => evidence.id));
  const referencedServiceIds = [
    ...draft.serviceGroups.flatMap((group) => group.serviceIds),
    ...draft.serviceDescriptions.map((description) => description.serviceId),
  ];
  const unknownServiceIds = referencedServiceIds.filter(
    (serviceId) => !assessedServiceIds.has(serviceId),
  );
  if (unknownServiceIds.length > 0)
    throw new Error(
      `AI Wiki 综合稿件引用了未完成 Codex 评估的服务：${[...new Set(unknownServiceIds)].join(', ')}。`,
    );
  const descriptionServiceIds = draft.serviceDescriptions.map((item) => item.serviceId);
  if (new Set(descriptionServiceIds).size !== descriptionServiceIds.length)
    throw new Error('AI Wiki 综合稿件包含重复的服务详细描述。');
  const handbookServiceIds = projection.serviceAssessments
    .filter((assessment) => assessment.reportPlacement !== 'system_summary')
    .map((assessment) => assessment.serviceId);
  const groupedServiceIds = draft.serviceGroups.flatMap((group) => group.serviceIds);
  const missingGroupServiceIds = handbookServiceIds.filter(
    (serviceId) => !groupedServiceIds.includes(serviceId),
  );
  const duplicateGroupServiceIds = groupedServiceIds.filter(
    (serviceId, index) => groupedServiceIds.indexOf(serviceId) !== index,
  );
  if (missingGroupServiceIds.length > 0 || duplicateGroupServiceIds.length > 0)
    throw new Error(
      `AI Wiki 服务分组必须完整且不重复。遗漏：${[...new Set(missingGroupServiceIds)].join(', ') || '无'}；重复：${[...new Set(duplicateGroupServiceIds)].join(', ') || '无'}。`,
    );
  const referencedEvidenceIds = [
    ...draft.serviceDescriptions.flatMap((description) => description.evidenceIds),
    ...draft.keyFindings.flatMap((finding) => finding.evidenceIds),
  ];
  const unknownEvidenceIds = referencedEvidenceIds.filter((id) => !evidenceIds.has(id));
  if (unknownEvidenceIds.length > 0)
    throw new Error(
      `AI Wiki 综合稿件引用了不存在的 Evidence ID：${[...new Set(unknownEvidenceIds)].join(', ')}。`,
    );
  const next = structuredClone(projection);
  next.wikiNarrative = {
    ...draft,
    generatedAt: (options.now ?? (() => new Date()))().toISOString(),
    provider: 'codex',
    threadId: options.threadId,
    ...(options.model === undefined ? {} : { model: options.model }),
  };
  assertSchema(InventoryProjectionSchema, next);
  Object.assign(projection, next);
  return [
    `wiki-narrative:${projection.sourceSnapshotId}`,
    ...draft.serviceDescriptions.map((item) => item.serviceId),
  ];
}

function isContainerInterface(item: NetworkInterface): boolean {
  return CONTAINER_INTERFACE_PATTERN.test(item.name);
}

function isRuntimeMount(item: MountRecord): boolean {
  return (
    item.pseudo ||
    item.temporary ||
    PSEUDO_TARGET_PATTERN.test(item.target) ||
    RUNTIME_MOUNT_PATTERN.test(item.source) ||
    /^(?:overlay|aufs|fuse\.overlayfs)$/i.test(item.fileSystemType)
  );
}

function assertEvidenceIds(
  values: readonly string[],
  available: ReadonlySet<string>,
  subject: string,
): void {
  const missing = values.filter((id) => !available.has(id));
  if (missing.length > 0)
    throw new Error(`${subject} 引用了不存在的 Evidence ID：${missing.join(', ')}。`);
}

function candidatePaths(projection: InventoryProjection): Set<string> {
  return new Set([
    ...projection.artifacts.map((item) => item.path),
    ...(projection.pathSeeds ?? []).map((item) => item.path),
    ...projection.services.flatMap(servicePathsFor),
  ]);
}

function servicePathKeys(services: readonly ServiceRecord[]): string[] {
  return [
    ...new Set(
      services.flatMap((service) =>
        servicePathsFor(service).map((value) => pathKey(service.id, value)),
      ),
    ),
  ].sort();
}

function pathKey(serviceId: string, value: string): string {
  return JSON.stringify([serviceId, value]);
}

function mergeServices(
  primary: readonly ServiceRecord[],
  additional: readonly ServiceRecord[],
): ServiceRecord[] {
  return [...new Map([...primary, ...additional].map((service) => [service.id, service])).values()];
}

function mustRemainVisible(projection: InventoryProjection, service: ServiceRecord): boolean {
  return requiredServiceInvestigationReasons(projection, service).length > 0;
}

function missingRequiredInvestigationServices(projection: InventoryProjection): ServiceRecord[] {
  const workspace = projection.discoveryWorkspace;
  if (workspace === undefined) return [];
  const selected = new Set(workspace.investigations.flatMap((item) => item.serviceIds));
  const consolidatedSourceIds = new Set(
    workspace.discoveredServices
      .filter((service) => selected.has(service.serviceId))
      .flatMap((service) => service.sourceObjectIds),
  );
  return projection.services.filter(
    (service) =>
      requiredServiceInvestigationReasons(projection, service).length > 0 &&
      !selected.has(service.id) &&
      !consolidatedSourceIds.has(service.id),
  );
}

function servicePathsFor(service: ServiceRecord): string[] {
  return [
    ...service.deployDirectories,
    ...service.configFiles,
    ...service.environmentFiles,
    ...service.logLocations,
    ...service.dataDirectories,
  ].map((value) => path.posix.normalize(value));
}

function relatedServices(mount: MountRecord, servicePaths: Map<string, string[]>): string[] {
  const source = path.posix.normalize(mount.source);
  const target = path.posix.normalize(mount.target);
  return [...servicePaths.entries()]
    .filter(([, paths]) =>
      paths.some(
        (candidate) =>
          within(candidate, source) ||
          within(source, candidate) ||
          within(candidate, target) ||
          within(target, candidate),
      ),
    )
    .map(([serviceId]) => serviceId);
}

function visibilityDecision(
  objectId: string,
  objectType: string,
  placement: VisibilityDecision['placement'],
  visibilityReason: string,
  resourceClass: string,
  evidenceIds: readonly string[],
  relatedServiceIds: readonly string[] = [],
): VisibilityDecision {
  return {
    evidenceIds: [...evidenceIds],
    objectId,
    objectType,
    placement,
    relatedServiceIds: [...relatedServiceIds],
    resourceClass,
    userReviewRequired: placement === 'filtered' && relatedServiceIds.length > 0,
    visibilityReason,
  };
}

function within(root: string, candidate: string): boolean {
  const normalizedRoot = root.replace(/\/$/, '');
  return candidate === normalizedRoot || candidate.startsWith(`${normalizedRoot}/`);
}

export type { InventoryProjection } from '@opsense/schema';
