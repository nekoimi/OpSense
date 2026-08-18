import crypto from 'node:crypto';

import { requiredServiceInvestigationReasons } from '@opsense/discovery';
import type { DiscoveryCandidate, EvidenceIndex, InventoryProjection } from '@opsense/schema';

export type ContextSection =
  | 'host'
  | 'storage'
  | 'network'
  | 'services'
  | 'processes'
  | 'containers'
  | 'systemd_units'
  | 'systemd_summary'
  | 'path_candidates'
  | 'findings'
  | 'visibility_summary'
  | 'discovery'
  | 'wiki_source';

export interface AgentContext {
  l0: Record<string, unknown>;
  l1: Record<string, unknown>;
  l2?: Record<string, unknown>;
  hash: string;
}

export interface ContextBuilderOptions {
  projection: InventoryProjection;
  evidenceIndex?: EvidenceIndex;
  redact?: (value: unknown) => unknown;
}

const LEGACY_SERVICE_BATCH_SIZE = 2;
const M20_SERVICE_BATCH_SIZE = 12;
const MAX_CONTEXT_PAGE_SIZE = 12;

export class ContextBuilder {
  private readonly projection: InventoryProjection;
  private readonly evidenceIndex: EvidenceIndex | undefined;
  private readonly redact: (value: unknown) => unknown;

  public constructor(options: ContextBuilderOptions) {
    this.projection = options.projection;
    this.evidenceIndex = options.evidenceIndex;
    this.redact = options.redact ?? redactContext;
  }

  public build(options: {
    stage: string;
    round: number;
    budget: unknown;
    recent?: unknown[];
  }): AgentContext {
    const p = this.projection;
    const rankedCandidates = this.rankedCandidates();
    const contextCandidates = rankedCandidates.slice(0, this.serviceBatchSize());
    const reviewedServiceIds = new Set(p.reviewedServiceIds ?? []);
    const l0 = this.redact({
      scanId: p.sourceSnapshotId,
      stage: options.stage,
      round: options.round,
      budget: options.budget,
      counts: {
        services: p.services.length,
        candidates: rankedCandidates.length,
        candidatesShown: contextCandidates.length,
        candidatesOmitted: Math.max(0, rankedCandidates.length - contextCandidates.length),
        candidateServiceCount: p.candidateServiceCount ?? p.services.length,
        reviewedServiceCount: p.reviewedServiceCount ?? reviewedServiceIds.size,
        candidatePathCount: p.candidatePathCount ?? 0,
        reviewedPathCount: p.reviewedPathCount ?? 0,
        classificationCompleted: p.classificationCompleted ?? false,
        evidence: p.evidence.length,
        findings: p.findings.length,
        filtered: p.filteredCounts,
        discovery:
          p.discoveryWorkspace === undefined
            ? undefined
            : {
                planningCompleted: p.discoveryWorkspace.planningCompleted,
                discoveryCompleted: p.discoveryWorkspace.discoveryCompleted,
                activeInvestigations: p.discoveryWorkspace.investigations.filter(
                  (item) => item.status === 'selected' || item.status === 'investigating',
                ).length,
                filteredGroups: p.discoveryWorkspace.filteredGroups.length,
                discoveredServices: p.discoveryWorkspace.discoveredServices.length,
              },
      },
      unresolvedQuestions: p.unknowns.slice(0, 40),
      recent: options.recent ?? [],
    }) as Record<string, unknown>;
    const l1 = this.redact({
      host: p.host === undefined ? undefined : compactHost(p.host),
      storage: compactStorage(p),
      network: compactNetwork(p),
      services: contextCandidates.map((item) => compactCandidate(item, p)),
      processes: p.processes.slice(0, 12).map(compactProcess),
      containers: p.containers.slice(0, 12).map(compactContainer),
      systemd_units: p.systemdUnits.slice(0, 12).map(compactSystemdUnit),
      evidence: p.evidence.slice(0, 20).map((item) => ({
        id: item.id,
        kind: item.kind,
        source: item.source,
        status: item.status,
      })),
      systemd_summary: compactSystemd(p),
      path_candidates: (p.pathSeeds ?? []).slice(0, 10).map((item) => ({
        id: item.id,
        path: item.path,
        confidence: item.confidence,
        sources: item.sources.slice(0, 2).map((source) => ({
          sourceId: source.sourceId,
          sourceType: source.sourceType,
          evidenceIds: source.evidenceIds.slice(0, 3),
        })),
      })),
      findings: p.findings.map((item) => ({
        id: item.id,
        severity: item.severity,
        title: item.title,
        description: item.description,
        evidenceIds: item.evidenceIds,
      })),
      visibility_summary: compactVisibility(p),
      discovery: compactDiscovery(p, this.evidenceIndex),
      wiki_source: compactWikiSource(p),
    }) as Record<string, unknown>;
    const context = { l0, l1, hash: hashValue({ l0, l1 }) };
    return context;
  }

  private candidateRank(a: DiscoveryCandidate, b: DiscoveryCandidate): number {
    const score = (item: DiscoveryCandidate): number => {
      const service = this.projection.services.find((candidate) => candidate.id === item.serviceId);
      const exposed = service?.socketIds.some((id) =>
        this.projection.sockets.some((socket) => socket.id === id && socket.exposed),
      );
      const abnormal = this.projection.findings.some((finding) =>
        finding.evidenceIds.some((id) => item.evidenceIds.includes(id)),
      );
      const serviceId = item.serviceId ?? item.candidateId;
      const reviewedPathKeys = new Set(this.projection.reviewedPathKeys ?? []);
      const servicePathKeys = candidatePathKeysForService(this.projection, serviceId).map(
        (item) => item.key,
      );
      const reviewed =
        (this.projection.reviewedServiceIds?.includes(serviceId) ?? false) &&
        servicePathKeys.every((key) => reviewedPathKeys.has(key));
      return (
        (reviewed ? 0 : 20) +
        (abnormal ? 8 : 0) +
        (exposed ? 6 : 0) +
        (item.sourceKind === 'mixed' ? 4 : item.sourceKind === 'container' ? 3 : 1) +
        (item.signals.length > 0 ? 2 : 0) +
        (item.unknowns.length > 0 ? 1 : 0)
      );
    };
    return score(b) - score(a) || a.displayName.localeCompare(b.displayName);
  }

  public readSection(
    section: ContextSection,
    offset = 0,
    limit = this.serviceBatchSize(),
  ): unknown {
    const pageSize = Math.min(Math.max(1, limit), MAX_CONTEXT_PAGE_SIZE);
    if (section === 'services')
      return this.rankedCandidates()
        .slice(Math.max(0, offset), Math.max(0, offset) + pageSize)
        .map((item) => compactCandidate(item, this.projection));
    if (section === 'processes')
      return this.projection.processes
        .slice(Math.max(0, offset), Math.max(0, offset) + pageSize)
        .map(compactProcess);
    if (section === 'containers')
      return this.projection.containers
        .slice(Math.max(0, offset), Math.max(0, offset) + pageSize)
        .map(compactContainer);
    if (section === 'systemd_units')
      return this.projection.systemdUnits
        .slice(Math.max(0, offset), Math.max(0, offset) + pageSize)
        .map(compactSystemdUnit);
    const context = this.build({ stage: 'read', round: 0, budget: {} });
    const value = context.l1[section];
    if (Array.isArray(value))
      return value.slice(Math.max(0, offset), Math.max(0, offset) + pageSize);
    return value ?? null;
  }

  private serviceBatchSize(): number {
    return this.projection.discoveryWorkspace?.workflowVersion === 'm20_evidence_driven'
      ? M20_SERVICE_BATCH_SIZE
      : LEGACY_SERVICE_BATCH_SIZE;
  }

  private rankedCandidates(): DiscoveryCandidate[] {
    const indexedByServiceId = new Map(
      (this.evidenceIndex?.candidates ?? [])
        .filter((candidate) => candidate.serviceId !== undefined)
        .map((candidate) => [candidate.serviceId as string, candidate]),
    );
    const workspace = this.projection.discoveryWorkspace;
    const activeServiceIds =
      workspace?.workflowVersion === 'm20_evidence_driven'
        ? new Set([
            ...workspace.investigations
              .filter((item) => item.status === 'selected' || item.status === 'investigating')
              .flatMap((item) => item.serviceIds),
            ...this.projection.services
              .filter(
                (service) =>
                  requiredServiceInvestigationReasons(this.projection, service).length > 0 &&
                  !workspace.investigations.some((item) => item.serviceIds.includes(service.id)),
              )
              .map((service) => service.id),
          ])
        : undefined;
    const candidates = this.projection.services
      .filter((service) => activeServiceIds === undefined || activeServiceIds.has(service.id))
      .map(
        (service) =>
          indexedByServiceId.get(service.id) ?? {
            candidateId: service.id,
            displayName: service.displayName ?? service.name,
            sourceKind: 'service' as const,
            sourceIds: [service.id],
            mergeRule: 'projection.service',
            evidenceIds: service.evidenceIds,
            runtimeKind: 'unknown' as const,
            confidence: 'unknown' as const,
            signals: [],
            unknowns: [],
            serviceId: service.id,
          },
      );
    const ranked = [...candidates].sort((a, b) => this.candidateRank(a, b));
    return workspace?.workflowVersion === 'm20_evidence_driven' && !workspace.planningCompleted
      ? fairServiceCandidateOrder(ranked, this.projection)
      : ranked;
  }

  public readEvidence(ids: readonly string[]): unknown[] {
    const wanted = new Set(ids.slice(0, 20));
    return this.projection.evidence
      .filter((item) => wanted.has(item.id))
      .map((item) =>
        this.redact({
          id: item.id,
          kind: item.kind,
          source: item.source,
          status: item.status,
          collectedAt: item.collectedAt,
          value: summarizeValue(item.value),
          message: item.message,
        }),
      );
  }

  public readEvidenceForService(serviceId: string, field?: string): unknown[] {
    const service = this.projection.services.find((item) => item.id === serviceId);
    if (service === undefined) return [];
    const evidenceIds = new Set([
      ...service.evidenceIds,
      ...this.projection.systemdUnits
        .filter((item) => service.systemdUnitIds.includes(item.id))
        .flatMap((item) => item.evidenceIds),
      ...this.projection.sockets
        .filter((item) => service.socketIds.includes(item.id))
        .flatMap((item) => item.evidenceIds),
      ...this.projection.containers
        .filter((item) => service.containerIds.includes(item.id))
        .flatMap((item) => item.evidenceIds),
    ]);
    return this.projection.evidence
      .filter(
        (item) =>
          evidenceIds.has(item.id) &&
          (field === undefined || item.field === field || item.source.includes(field)),
      )
      .slice(0, 20)
      .map((item) =>
        this.redact({
          id: item.id,
          kind: item.kind,
          source: item.source,
          field: item.field,
          status: item.status,
          sourceType: 'confirmed_evidence',
          collectedAt: item.collectedAt,
          value: summarizeValue(item.value),
          message: item.message,
        }),
      );
  }
}

function compactProcess(item: InventoryProjection['processes'][number]): unknown {
  return {
    id: item.id,
    pid: item.pid,
    parentPid: item.parentPid,
    userId: item.userId,
    userName: item.userName,
    command: item.command.slice(0, 320),
    arguments: item.arguments.slice(0, 12).map((argument) => argument.slice(0, 240)),
    executablePath: item.executablePath?.slice(0, 240),
    workingDirectory: item.workingDirectory?.slice(0, 240),
    cgroup: item.cgroup?.slice(0, 320),
    containerId: item.containerId,
    evidenceIds: item.evidenceIds.slice(0, 4),
  };
}

function compactContainer(item: InventoryProjection['containers'][number]): unknown {
  return {
    id: item.id,
    name: item.name,
    image: item.image,
    imageId: item.imageId,
    state: item.state,
    processId: item.processId,
    restartPolicy: item.restartPolicy,
    ports: item.ports.slice(0, 8).map((port) => ({
      containerPort: port.containerPort,
      hostAddress: port.hostAddress,
      hostPort: port.hostPort,
      protocol: port.protocol,
    })),
    mounts: item.mounts.slice(0, 8),
    networks: item.networks.slice(0, 8),
    labels: Object.fromEntries(Object.entries(item.labels).slice(0, 12)),
    evidenceIds: item.evidenceIds.slice(0, 4),
  };
}

function compactSystemdUnit(item: InventoryProjection['systemdUnits'][number]): unknown {
  return {
    id: item.id,
    name: item.name,
    description: item.description,
    loadState: item.loadState,
    activeState: item.activeState,
    subState: item.subState,
    enabledState: item.enabledState,
    mainPid: item.mainPid,
    fragmentPath: item.fragmentPath,
    workingDirectory: item.workingDirectory,
    execStart: item.execStart.slice(0, 4),
    evidenceIds: item.evidenceIds.slice(0, 4),
  };
}

function compactCandidate(item: DiscoveryCandidate, projection: InventoryProjection): unknown {
  const serviceId = item.serviceId ?? item.candidateId;
  const service = projection.services.find((candidate) => candidate.id === serviceId);
  const assessment = projection.serviceAssessments.find(
    (candidate) => candidate.serviceId === serviceId,
  );
  const units = (service?.systemdUnitIds ?? []).flatMap((id) => {
    const unit = projection.systemdUnits.find((candidate) => candidate.id === id);
    return unit === undefined
      ? []
      : [
          {
            id: unit.id,
            name: unit.name,
            description: unit.description,
            activeState: unit.activeState,
            enabledState: unit.enabledState,
            fragmentPath: unit.fragmentPath,
            execStart: unit.execStart.slice(0, 2),
            evidenceIds: unit.evidenceIds.slice(0, 4),
          },
        ];
  });
  const processes = (service?.processIds ?? []).flatMap((pid) => {
    const process = projection.processes.find((candidate) => candidate.pid === pid);
    return process === undefined
      ? []
      : [
          {
            pid,
            command: process.command.slice(0, 240),
            executablePath: process.executablePath?.slice(0, 240),
            evidenceIds: process.evidenceIds.slice(0, 4),
          },
        ];
  });
  const sockets = (service?.socketIds ?? []).flatMap((id) => {
    const socket = projection.sockets.find((candidate) => candidate.id === id);
    return socket === undefined
      ? []
      : [
          {
            id,
            protocol: socket.protocol,
            address: socket.localAddress,
            port: socket.localPort,
            exposed: socket.exposed,
            evidenceIds: socket.evidenceIds.slice(0, 4),
          },
        ];
  });
  const containers = (service?.containerIds ?? []).flatMap((id) => {
    const container = projection.containers.find((candidate) => candidate.id === id);
    return container === undefined
      ? []
      : [
          {
            id,
            name: container.name,
            image: container.image,
            state: container.state,
            mounts: container.mounts.slice(0, 6),
            ports: container.ports.slice(0, 6),
            evidenceIds: container.evidenceIds.slice(0, 4),
          },
        ];
  });
  const candidatePaths = candidatePathKeysForService(projection, serviceId);
  const reviewedPathKeys = new Set(projection.reviewedPathKeys ?? []);
  const pendingCandidatePaths = candidatePaths.filter((item) => !reviewedPathKeys.has(item.key));
  const displayedCandidatePaths = pendingCandidatePaths.slice(0, 6);
  const visibilityConstraints = visibilityConstraintsFor(service, projection);
  return {
    id: serviceId,
    name: service?.displayName ?? service?.name ?? item.displayName,
    sourceKind: item.sourceKind,
    runtimeKind: item.runtimeKind,
    reviewedByCodex: projection.reviewedServiceIds?.includes(serviceId) ?? false,
    pathReview: {
      candidateCount: candidatePaths.length,
      reviewedCount: candidatePaths.filter((item) => reviewedPathKeys.has(item.key)).length,
      pendingCount: pendingCandidatePaths.length,
      displayedCount: displayedCandidatePaths.length,
    },
    currentAssessment: assessment,
    semanticSource:
      assessment?.classificationSource === 'codex' ? 'codex_inference' : 'local_heuristic',
    candidateHints: {
      sourceKind: item.sourceKind,
      runtimeKind: item.runtimeKind,
      confidence: item.confidence,
      signals: item.signals.slice(0, 3),
      unknowns: item.unknowns.slice(0, 3),
    },
    status: service?.status,
    deploymentType: service?.deploymentType,
    enabledAtBoot: service?.enabledAtBoot,
    visibilityConstraints,
    paths:
      service === undefined
        ? undefined
        : {
            deployCandidates: service.deployDirectories.slice(0, 8),
            configCandidates: service.configFiles.slice(0, 8),
            environmentCandidates: service.environmentFiles.slice(0, 4),
            logCandidates: service.logLocations.slice(0, 8),
            dataCandidates: service.dataDirectories.slice(0, 8),
            allCandidates: displayedCandidatePaths.map((item) => item.path),
            currentAssessments: (projection.pathAssessments ?? [])
              .filter((item) => item.serviceIds.includes(serviceId))
              .slice(0, 20),
          },
    units: units.slice(0, 4),
    processes: processes.slice(0, 4),
    sockets: sockets.slice(0, 8),
    containers: containers.slice(0, 4),
    signals: item.signals.slice(0, 3),
    unknowns: item.unknowns.slice(0, 3),
    evidenceIds: [...new Set([...(service?.evidenceIds ?? []), ...item.evidenceIds])].slice(0, 12),
  };
}

function compactHost(host: InventoryProjection['host']): unknown {
  if (host === undefined) return null;
  return {
    hostname: host.hostname,
    fqdn: host.fqdn,
    architecture: host.architecture,
    operatingSystem: host.operatingSystem,
    cpu: host.cpu,
    memory: { totalBytes: host.memory.totalBytes, availableBytes: host.memory.availableBytes },
    virtualization: host.virtualization,
  };
}

function compactStorage(projection: InventoryProjection): unknown {
  return {
    disks: (projection.storage?.disks ?? []).slice(0, 40).map((item) => ({
      id: item.id,
      name: item.name,
      path: item.path,
      sizeBytes: item.sizeBytes,
      evidenceIds: item.evidenceIds,
    })),
    mounts: (projection.storage?.mounts ?? []).slice(0, 60).map((item) => ({
      id: item.id,
      source: item.source,
      target: item.target,
      fileSystemType: item.fileSystemType,
      totalBytes: item.totalBytes,
      usedBytes: item.usedBytes,
      evidenceIds: item.evidenceIds,
    })),
  };
}

function compactNetwork(projection: InventoryProjection): unknown {
  return {
    interfaces: (projection.network?.interfaces ?? []).slice(0, 80).map((item) => ({
      id: item.id,
      name: item.name,
      addresses: item.addresses.slice(0, 8),
      mtu: item.mtu,
    })),
    routes: projection.network?.routes ?? [],
    firewall: projection.network?.firewall,
    dns: projection.network?.dns,
  };
}

function compactVisibility(projection: InventoryProjection): unknown {
  const counts = new Map<string, number>();
  for (const item of projection.visibilityDecisions) {
    const key = `${item.objectType}:${item.placement}:${item.resourceClass}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, count]) => ({ key, count }));
}

function compactWikiSource(projection: InventoryProjection): unknown {
  if (projection.classificationCompleted !== true)
    return { readyForComposition: false, reason: 'Codex 服务调查尚未完成。' };
  const assessedServiceIds = new Set(
    projection.serviceAssessments.map((assessment) => assessment.serviceId),
  );
  return {
    readyForComposition: true,
    alreadyComposed: projection.wikiNarrative !== undefined,
    host: projection.host === undefined ? null : compactHost(projection.host),
    storage: compactStorage(projection),
    network: compactNetwork(projection),
    services: projection.services
      .filter((service) => assessedServiceIds.has(service.id))
      .map((service) => ({
        id: service.id,
        name: service.name,
        displayName: service.displayName,
        status: service.status,
        deploymentType: service.deploymentType,
        assessment: projection.serviceAssessments.find(
          (assessment) => assessment.serviceId === service.id,
        ),
        containers: service.containerIds.flatMap((containerId) => {
          const container = projection.containers.find((item) => item.id === containerId);
          return container === undefined
            ? []
            : [
                {
                  id: container.id,
                  name: container.name,
                  image: container.image,
                  state: container.state,
                  ports: container.ports,
                  evidenceIds: container.evidenceIds,
                },
              ];
        }),
        ports: service.socketIds.flatMap((socketId) => {
          const socket = projection.sockets.find((item) => item.id === socketId);
          return socket === undefined
            ? []
            : [
                {
                  protocol: socket.protocol,
                  address: socket.localAddress,
                  port: socket.localPort,
                  exposed: socket.exposed,
                  evidenceIds: socket.evidenceIds,
                },
              ];
        }),
        paths: (projection.pathAssessments ?? []).filter((item) =>
          item.serviceIds.includes(service.id),
        ),
        evidenceIds: service.evidenceIds,
      })),
    investigations: projection.discoveryWorkspace?.investigations ?? [],
    filteredGroups: projection.discoveryWorkspace?.filteredGroups ?? [],
    findings: projection.findings,
    unresolvedQuestions: [
      ...projection.unknowns,
      ...(projection.discoveryWorkspace?.unresolvedQuestions ?? []),
    ],
  };
}

function compactDiscovery(
  projection: InventoryProjection,
  evidenceIndex: EvidenceIndex | undefined,
): unknown {
  const workspace = projection.discoveryWorkspace;
  if (workspace === undefined)
    return {
      workflowVersion: 'm19_full_candidate_review',
      note: '旧会话使用逐候选审查流程。',
    };
  const associatedUnitIds = new Set(projection.services.flatMap((item) => item.systemdUnitIds));
  const protectedServices = projection.services.filter(
    (service) => requiredServiceInvestigationReasons(projection, service).length > 0,
  );
  const routineServices = projection.services.filter(
    (service) => !protectedServices.includes(service),
  );
  const routineUnits = projection.systemdUnits.filter((unit) => !associatedUnitIds.has(unit.id));
  const indexed = new Map(
    (evidenceIndex?.candidates ?? [])
      .filter((item) => item.serviceId !== undefined)
      .map((item) => [item.serviceId as string, item]),
  );
  const orderedProtectedServices = fairServiceOrder(protectedServices);
  const highValueLeads = orderedProtectedServices.slice(0, 30).map((service) => {
    const candidate = indexed.get(service.id);
    return {
      id: service.id,
      name: service.displayName ?? service.name,
      deploymentType: service.deploymentType,
      status: service.status,
      reasons: visibilityConstraintsFor(service, projection).reasons,
      evidenceIds: service.evidenceIds.slice(0, 8),
      signals: candidate?.signals.slice(0, 4) ?? [],
    };
  });
  const rawGroups = [
    ...(routineServices.length === 0
      ? []
      : [
          {
            groupId: 'raw-group:routine-services',
            label: '无高价值信号的原始服务记录',
            resourceClass: 'routine_service_evidence',
            sourceObjectIds: routineServices.map((item) => item.id),
            evidenceIds: [...new Set(routineServices.flatMap((item) => item.evidenceIds))].slice(
              0,
              20,
            ),
            samples: routineServices.slice(0, 12).map((item) => ({
              id: item.id,
              name: item.displayName ?? item.name,
              deploymentType: item.deploymentType,
              status: item.status,
            })),
          },
        ]),
    ...(routineUnits.length === 0
      ? []
      : [
          {
            groupId: 'raw-group:unassociated-systemd-units',
            label: '未归并的原始 systemd unit',
            resourceClass: 'systemd_unit_evidence',
            sourceObjectIds: routineUnits.map((item) => item.id),
            evidenceIds: [...new Set(routineUnits.flatMap((item) => item.evidenceIds))].slice(
              0,
              20,
            ),
            samples: routineUnits.slice(0, 12).map((item) => ({
              id: item.id,
              name: item.name,
              activeState: item.activeState,
              fragmentPath: item.fragmentPath,
            })),
          },
        ]),
  ];
  return {
    workflowVersion: workspace.workflowVersion,
    planningCompleted: workspace.planningCompleted,
    discoveryCompleted: workspace.discoveryCompleted,
    investigations: workspace.investigations.slice(0, 12).map((item) => ({
      investigationId: item.investigationId,
      label: item.label,
      status: item.status,
      priority: item.priority,
      serviceIds: item.serviceIds,
      sourceObjectIds: item.sourceObjectIds.slice(0, 12),
      evidenceIds: item.evidenceIds.slice(0, 8),
      reason: item.reason,
    })),
    filteredGroups: workspace.filteredGroups.slice(0, 12).map((item) => ({
      groupId: item.groupId,
      label: item.label,
      resourceClass: item.resourceClass,
      objectCount: item.sourceObjectIds.length,
      sourceObjectIds: item.sourceObjectIds.slice(0, 12),
      evidenceIds: item.evidenceIds.slice(0, 8),
      reason: item.reason,
    })),
    discoveredServices: workspace.discoveredServices.slice(0, 12).map((item) => ({
      serviceId: item.serviceId,
      name: item.displayName ?? item.name,
      deploymentType: item.deploymentType,
      status: item.status,
      sourceObjectIds: item.sourceObjectIds.slice(0, 12),
      evidenceIds: item.evidenceIds.slice(0, 8),
      reason: item.reason,
    })),
    unresolvedQuestions: workspace.unresolvedQuestions.slice(0, 20),
    rawEvidenceCounts: {
      services: projection.services.length,
      systemdUnits: projection.systemdUnits.length,
      processes: projection.processes.length,
      sockets: projection.sockets.length,
      containers: projection.containers.length,
      pathSeeds: projection.pathSeeds?.length ?? 0,
    },
    highValueLeadCounts: {
      total: orderedProtectedServices.length,
      shown: highValueLeads.length,
      omitted: Math.max(0, orderedProtectedServices.length - highValueLeads.length),
      byDeploymentType: countBy(orderedProtectedServices, (service) => service.deploymentType),
    },
    highValueLeads,
    rawGroups,
  };
}

function compactSystemd(projection: InventoryProjection): unknown {
  const units = projection.systemdUnits;
  return {
    total: units.length,
    active: units.filter((item) => item.activeState === 'active').length,
    failed: units
      .filter((item) => item.activeState === 'failed')
      .map((item) => ({ id: item.id, name: item.name, description: item.description })),
  };
}

function summarizeValue(value: unknown): unknown {
  if (typeof value === 'string') return value.length > 500 ? `${value.slice(0, 500)}...` : value;
  if (Array.isArray(value))
    return { type: 'array', count: value.length, sample: value.slice(0, 10) };
  if (value !== null && typeof value === 'object')
    return { type: 'object', keys: Object.keys(value).slice(0, 30) };
  return value;
}

function redactContext(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactContext);
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (
        /(?:password|passwd|secret|token|private[_-]?key|credential|authorization|cookie|env(?:ironment)?)/i.test(
          key,
        )
      )
        result[key] = '[REDACTED]';
      else result[key] = redactContext(child);
    }
    return result;
  }
  if (typeof value === 'string' && /(password|passwd|secret|token|private[_-]?key)=/i.test(value))
    return '[REDACTED]';
  return value;
}

function hashValue(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function candidatePathKeysForService(
  projection: InventoryProjection,
  serviceId: string,
): Array<{ key: string; path: string }> {
  return (projection.candidatePathKeys ?? []).flatMap((key) => {
    try {
      const value = JSON.parse(key) as unknown;
      return Array.isArray(value) && value[0] === serviceId && typeof value[1] === 'string'
        ? [{ key, path: value[1] }]
        : [];
    } catch {
      return [];
    }
  });
}

function visibilityConstraintsFor(
  service: InventoryProjection['services'][number] | undefined,
  projection: InventoryProjection,
): { systemSummaryAllowed: boolean; reasons: string[] } {
  if (service === undefined) return { systemSummaryAllowed: true, reasons: [] };
  const reasons = requiredServiceInvestigationReasons(projection, service);
  return { systemSummaryAllowed: reasons.length === 0, reasons };
}

function fairServiceCandidateOrder(
  candidates: DiscoveryCandidate[],
  projection: InventoryProjection,
): DiscoveryCandidate[] {
  const byId = new Map(projection.services.map((service) => [service.id, service]));
  return interleaveGroups(candidates, (candidate) =>
    serviceRuntimeGroup(byId.get(candidate.serviceId ?? '')),
  );
}

function fairServiceOrder(
  services: InventoryProjection['services'],
): InventoryProjection['services'] {
  return interleaveGroups(services, serviceRuntimeGroup);
}

function serviceRuntimeGroup(service: InventoryProjection['services'][number] | undefined): string {
  if (service === undefined) return 'other';
  if (
    service.deploymentType === 'docker' ||
    service.deploymentType === 'compose' ||
    service.containerIds.length > 0 ||
    service.composeProjectIds.length > 0
  )
    return 'container';
  if (service.deploymentType === 'systemd' || service.systemdUnitIds.length > 0) return 'systemd';
  if (service.deploymentType === 'process' || service.processIds.length > 0) return 'process';
  return 'other';
}

function interleaveGroups<T>(items: readonly T[], groupFor: (item: T) => string): T[] {
  const groups = new Map<string, T[]>();
  for (const item of items)
    groups.set(groupFor(item), [...(groups.get(groupFor(item)) ?? []), item]);
  const preferred = ['container', 'systemd', 'process', 'other'];
  const keys = [
    ...preferred.filter((key) => groups.has(key)),
    ...[...groups.keys()].filter((key) => !preferred.includes(key)),
  ];
  const result: T[] = [];
  for (let index = 0; result.length < items.length; index += 1)
    for (const key of keys) {
      const item = groups.get(key)?.[index];
      if (item !== undefined) result.push(item);
    }
  return result;
}

function countBy<T>(items: readonly T[], keyFor: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = keyFor(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}
