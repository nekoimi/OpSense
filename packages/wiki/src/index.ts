import {
  RiskFindingSchema,
  ServiceWikiEntrySchema,
  ServiceWikiProjectionSchema,
  assertSchema,
} from '@opsense/schema';
import type {
  AiServiceAssessment,
  Confidence,
  InventoryProjection,
  ServiceRecord,
  ServiceWikiEntry,
  ServiceWikiProjection,
  WikiClaim,
  WikiConflict,
  WikiEntryDraft,
  WikiLifecycle,
  WikiServiceRole,
} from '@opsense/schema';

const KEY_FIELDS = [
  'purpose',
  'status',
  'deploymentType',
  'deployDirectory',
  'ports',
  'configFiles',
  'logLocations',
  'dataDirectories',
  'lifecycle',
  'evidenceIds',
] as const;

export interface BuildServiceWikiOptions {
  now?: () => Date;
  minimumCoverage?: number;
}

export function buildServiceWikiProjection(
  projection: InventoryProjection,
  options: BuildServiceWikiOptions = {},
): ServiceWikiProjection {
  const now = options.now ?? (() => new Date());
  const generatedAt = now().toISOString();
  const evidenceDriven = projection.discoveryWorkspace?.workflowVersion === 'm20_evidence_driven';
  const assessedServiceIds = new Set(projection.serviceAssessments.map((item) => item.serviceId));
  const wikiServices = evidenceDriven
    ? projection.services.filter((service) => assessedServiceIds.has(service.id))
    : projection.services;
  const entries = wikiServices.map((service) =>
    buildServiceWikiEntry(service, projection, generatedAt, options),
  );
  const reviewServiceIds = entries
    .filter((entry) => entry.reportPlacement === 'needs_review')
    .map((entry) => entry.serviceId);
  const summaryServiceIds = entries
    .filter((entry) => entry.reportPlacement === 'system_summary')
    .map((entry) => entry.serviceId);
  const riskFindings = projection.findings.map((finding) => {
    const relatedServiceIds = entries
      .filter((entry) => finding.evidenceIds.some((id) => entry.evidence.evidenceIds.includes(id)))
      .map((entry) => entry.serviceId);
    const riskFinding = {
      description: finding.description,
      evidenceIds: [...finding.evidenceIds],
      findingId: finding.id,
      relatedServiceIds,
      severity: finding.severity,
      status: finding.confidence === 'confirmed' ? 'confirmed' : 'needs_review',
      title: finding.title,
    } as const;
    assertSchema(RiskFindingSchema, riskFinding);
    return riskFinding;
  });
  const result: ServiceWikiProjection = {
    entries,
    generatedAt,
    inventoryProjectionId: projection.projectionId,
    projectionId: `service-wiki:${projection.sourceSnapshotId}`,
    reviewServiceIds,
    riskFindings,
    serviceIds: entries.map((entry) => entry.serviceId),
    summaryServiceIds,
    unresolvedQuestions: entries.flatMap((entry) => entry.unknowns),
  };
  assertSchema(ServiceWikiProjectionSchema, result);
  return result;
}

export function buildServiceWikiEntry(
  service: ServiceRecord,
  projection: InventoryProjection,
  generatedAt = new Date().toISOString(),
  options: BuildServiceWikiOptions = {},
): ServiceWikiEntry {
  const draft = buildWikiEntryDraft(service, projection, options);
  const assessment = assessmentFor(projection, service.id);
  const requestedPlacement = assessment?.reportPlacement ?? 'needs_review';
  const reportPlacement =
    (requestedPlacement === 'primary' || requestedPlacement === 'supporting') &&
    draft.evidence.evidenceIds.length === 0
      ? 'needs_review'
      : requestedPlacement;
  const entry: ServiceWikiEntry = {
    ...draft,
    anchor: anchorFor(service.id),
    generatedAt,
    reportPlacement,
  };
  assertSchema(ServiceWikiEntrySchema, entry);
  return entry;
}

export function buildWikiEntryDraft(
  service: ServiceRecord,
  projection: InventoryProjection,
  options: BuildServiceWikiOptions = {},
): WikiEntryDraft {
  const assessment = assessmentFor(projection, service.id);
  const classifiedPaths = pathsFor(service, projection);
  const pathEvidence = (
    semantic: NonNullable<InventoryProjection['pathAssessments']>[number]['semantic'],
  ): string[] =>
    projection.classificationProvider !== 'codex'
      ? [...new Set(service.evidenceIds)]
      : [
          ...new Set(
            (projection.pathAssessments ?? [])
              .filter((item) => item.serviceIds.includes(service.id) && item.semantic === semantic)
              .flatMap((item) => item.evidenceIds),
          ),
        ];
  const pathConfidence: Confidence =
    projection.classificationProvider === 'codex' ? 'inferred' : service.confidence;
  const serviceEvidenceIds = [...new Set(service.evidenceIds)];
  const linkedUnits = projection.systemdUnits.filter((unit) =>
    service.systemdUnitIds.includes(unit.id),
  );
  const linkedSockets = projection.sockets.filter((socket) =>
    service.socketIds.includes(socket.id),
  );
  const linkedContainers = projection.containers.filter((container) =>
    service.containerIds.includes(container.id),
  );
  const linkedComposeServices = projection.composeProjects
    .filter((project) => service.composeProjectIds.includes(project.id))
    .flatMap((project) =>
      project.services.map((composeService) => ({
        containerIds: [...composeService.containerIds],
        evidenceIds: [...project.evidenceIds],
        name: composeService.name,
        projectId: project.id,
      })),
    );
  const linkedMountIds = projection.visibilityDecisions
    .filter(
      (decision) =>
        decision.objectType === 'mount' &&
        decision.relatedServiceIds.includes(service.id) &&
        decision.placement !== 'filtered',
    )
    .map((decision) => decision.objectId);
  const linkedEvidenceIds = [
    ...serviceEvidenceIds,
    ...linkedUnits.flatMap((unit) => unit.evidenceIds),
    ...linkedSockets.flatMap((socket) => socket.evidenceIds),
    ...linkedContainers.flatMap((container) => container.evidenceIds),
  ];
  const evidenceIds = [...new Set(linkedEvidenceIds)];
  const purpose = assessment?.purpose ?? service.purpose;
  const purposeConfidence: Confidence = purpose
    ? assessment === undefined
      ? (service.purposeConfidence ?? service.confidence)
      : 'inferred'
    : 'unknown';
  const lifecycle = lifecycleFor(service, linkedUnits, serviceEvidenceIds);
  const runtimeUser = linkedUnits.find((unit) => unit.user !== undefined)?.user;
  const ports = [
    ...linkedSockets.map((socket) => ({
      evidenceIds: [...socket.evidenceIds],
      exposed: socket.exposed,
      hostAddress: socket.localAddress,
      hostPort: socket.localPort,
      protocol: socket.protocol.toUpperCase(),
    })),
    ...linkedContainers.flatMap((container) =>
      container.ports.map((port) => ({
        ...(port.containerPort === undefined ? {} : { containerPort: port.containerPort }),
        evidenceIds: [...container.evidenceIds],
        exposed: port.hostPort !== undefined,
        ...(port.hostAddress === undefined ? {} : { hostAddress: port.hostAddress }),
        ...(port.hostPort === undefined ? {} : { hostPort: port.hostPort }),
        protocol: port.protocol.toUpperCase(),
      })),
    ),
  ];
  const coveredFields = new Set<string>();
  const confirmedFacts: WikiClaim[] = [];
  const inferences: WikiClaim[] = [];
  const claim = (
    field: string,
    value: string | undefined,
    fieldEvidenceIds: readonly string[],
    confidence: Confidence,
  ): void => {
    if (value === undefined || value.length === 0) return;
    const uniqueEvidenceIds = [...new Set(fieldEvidenceIds)];
    const item: WikiClaim = { confidence, evidenceIds: uniqueEvidenceIds, field, value };
    if (confidence === 'confirmed' && uniqueEvidenceIds.length > 0) {
      confirmedFacts.push(item);
      coveredFields.add(field);
    } else if (confidence !== 'unknown') {
      inferences.push(item);
      if (uniqueEvidenceIds.length > 0) coveredFields.add(field);
    }
  };
  claim('purpose', purpose, assessment?.evidenceIds ?? serviceEvidenceIds, purposeConfidence);
  claim('status', service.status, serviceEvidenceIds, service.confidence);
  claim('deploymentType', service.deploymentType, serviceEvidenceIds, service.confidence);
  claim('deployDirectory', classifiedPaths.deploy[0], pathEvidence('deploy'), pathConfidence);
  claim(
    'ports',
    ports.length === 0 ? undefined : ports.map(formatPort).join(', '),
    ports.flatMap((port) => port.evidenceIds),
    ports.some((port) => port.evidenceIds.length > 0) ? 'confirmed' : 'unknown',
  );
  claim('configFiles', classifiedPaths.config.join(', '), pathEvidence('config'), pathConfidence);
  claim('logLocations', classifiedPaths.log.join(', '), pathEvidence('log'), pathConfidence);
  claim('dataDirectories', classifiedPaths.data.join(', '), pathEvidence('data'), pathConfidence);
  claim(
    'lifecycle',
    lifecycle.start?.command,
    lifecycle.start?.evidenceIds ?? [],
    lifecycle.start?.confidence ?? 'unknown',
  );
  if (serviceEvidenceIds.length > 0) coveredFields.add('evidenceIds');
  const missingFields = KEY_FIELDS.filter((field) => !coveredFields.has(field));
  const coverage = (KEY_FIELDS.length - missingFields.length) / KEY_FIELDS.length;
  const unknowns = [
    ...new Set([
      ...service.unknownFields,
      ...(assessment?.unknowns ?? []),
      ...missingFields.map((field) => `缺少 ${field} 的有效证据。`),
    ]),
  ];
  const reviewItems = [
    ...(service.conflictFields ?? []).map((field) => `字段存在冲突：${field}`),
    ...(assessment?.reportPlacement === 'needs_review' ? ['服务分类需要人工确认。'] : []),
    ...(assessment?.reviewItems ?? []),
    ...(coverage < (options.minimumCoverage ?? 0.8)
      ? [`服务证据覆盖率 ${(coverage * 100).toFixed(0)}%，低于建议阈值。`]
      : []),
    ...((assessment?.reportPlacement === 'primary' ||
      assessment?.reportPlacement === 'supporting') &&
    evidenceIds.length === 0
      ? ['主要服务没有关联任何 Evidence ID。']
      : []),
  ];
  const confidence: Confidence =
    service.conflictFields !== undefined && service.conflictFields.length > 0
      ? 'conflict'
      : serviceEvidenceIds.length === 0
        ? 'unknown'
        : service.confidence;
  const conflicts: WikiConflict[] = (service.conflictFields ?? []).map((field) => {
    const fieldEvidence = projection.evidence.filter(
      (evidence) => serviceEvidenceIds.includes(evidence.id) && evidence.field === field,
    );
    const sourceEvidence =
      fieldEvidence.length > 0
        ? fieldEvidence
        : projection.evidence.filter((evidence) => serviceEvidenceIds.includes(evidence.id));
    return {
      evidenceIds: sourceEvidence.map((evidence) => evidence.id),
      field,
      observedValues: sourceEvidence.flatMap((evidence) =>
        evidence.value === undefined ? [] : [safeValue(evidence.value)],
      ),
      sources: [...new Set(sourceEvidence.map((evidence) => evidence.source))],
    };
  });
  const identityName = service.displayName ?? service.name;
  return {
    configuration: {
      backupPaths: classifiedPaths.backup,
      configFiles: classifiedPaths.config,
      environmentFiles: classifiedPaths.environment,
    },
    confidence,
    conflicts,
    confirmedFacts,
    deployment: {
      composeProjectIds: [...service.composeProjectIds],
      composeServices: linkedComposeServices,
      containerIds: [...service.containerIds],
      containers: linkedContainers.map((container) => ({
        containerId: container.id,
        evidenceIds: [...container.evidenceIds],
        image: container.image,
        name: container.name,
        state: container.state,
      })),
      deployDirectories: classifiedPaths.deploy,
      deploymentType: service.deploymentType,
      processIds: [...service.processIds],
      systemdUnitIds: [...service.systemdUnitIds],
      ...(runtimeUser === undefined ? {} : { runtimeUser }),
    },
    evidence: {
      conflictFields: [...(service.conflictFields ?? [])],
      coveredFields: [...coveredFields].sort(),
      coverage,
      evidenceIds,
      missingFields,
    },
    exposure: { ports },
    identity: {
      name: service.name,
      ...(identityName === service.name ? {} : { displayName: identityName }),
      role: wikiRoleFor(service, assessment),
    },
    inferences,
    lifecycle,
    logging: { logLocations: classifiedPaths.log },
    oneLineSummary: purpose ?? `${identityName} 服务，当前用途尚未确认。`,
    purpose: {
      ...(purpose === undefined ? {} : { summary: purpose }),
      confidence: purposeConfidence,
      evidenceIds: [...new Set(assessment?.evidenceIds ?? serviceEvidenceIds)],
    },
    reviewItems,
    serviceId: service.id,
    storage: {
      backupPaths: classifiedPaths.backup,
      dataDirectories: classifiedPaths.data,
      mountIds: linkedMountIds,
    },
    unknowns,
  };
}

function assessmentFor(
  projection: InventoryProjection,
  serviceId: string,
): AiServiceAssessment | undefined {
  return projection.serviceAssessments.find((assessment) => assessment.serviceId === serviceId);
}

function wikiRoleFor(
  _service: ServiceRecord,
  assessment: AiServiceAssessment | undefined,
): WikiServiceRole {
  if (assessment?.reportPlacement === 'system_summary' || assessment?.role === 'system') {
    return 'system_service';
  }
  if (assessment?.role === 'edge') return 'edge_service';
  if (assessment?.role === 'container_platform') return 'container_platform';
  if (assessment?.role === 'infrastructure') return 'infrastructure_service';
  if (assessment?.role === 'middleware') return 'supporting_component';
  if (assessment?.role === 'application') return 'primary_application';
  return 'unknown';
}

function pathsFor(
  service: ServiceRecord,
  projection: InventoryProjection,
): {
  backup: string[];
  config: string[];
  data: string[];
  deploy: string[];
  environment: string[];
  log: string[];
} {
  if (projection.classificationProvider !== 'codex') {
    return {
      backup: [],
      config: [...service.configFiles],
      data: [...service.dataDirectories],
      deploy: [...service.deployDirectories],
      environment: [...service.environmentFiles],
      log: [...service.logLocations],
    };
  }
  const assessments = (projection.pathAssessments ?? []).filter((item) =>
    item.serviceIds.includes(service.id),
  );
  const forSemantic = (semantic: (typeof assessments)[number]['semantic']): string[] => [
    ...new Set(assessments.filter((item) => item.semantic === semantic).map((item) => item.path)),
  ];
  const config = forSemantic('config');
  return {
    backup: forSemantic('backup'),
    config,
    data: forSemantic('data'),
    deploy: forSemantic('deploy'),
    environment: service.environmentFiles.filter((item) => config.includes(item)),
    log: forSemantic('log'),
  };
}

function lifecycleFor(
  service: ServiceRecord,
  units: InventoryProjection['systemdUnits'],
  serviceEvidenceIds: readonly string[],
): WikiLifecycle {
  const unit = units.find((candidate) => candidate.execStart.length > 0);
  const command = service.startCommand ?? unit?.execStart[0];
  const evidenceIds = [...new Set([...serviceEvidenceIds, ...(unit?.evidenceIds ?? [])])];
  const commandConfidence: Confidence =
    command === undefined ? 'unknown' : evidenceIds.length > 0 ? 'confirmed' : 'unknown';
  return {
    ...(service.enabledAtBoot === undefined ? {} : { enabledAtBoot: service.enabledAtBoot }),
    status: service.status,
    ...(command === undefined || commandConfidence === 'unknown'
      ? {}
      : {
          start: {
            command,
            confidence: commandConfidence,
            evidenceIds,
          },
        }),
  };
}

function anchorFor(serviceId: string): string {
  return `service-${serviceId.replace(/[^A-Za-z0-9_-]+/g, '-')}`.toLowerCase();
}

function formatPort(port: {
  protocol: string;
  hostAddress?: string;
  hostPort?: number;
  containerPort?: number;
}): string {
  const host =
    port.hostAddress === undefined && port.hostPort === undefined
      ? 'container-only'
      : `${port.hostAddress ?? '0.0.0.0'}:${port.hostPort ?? '-'}`;
  return `${port.protocol} ${host}${port.containerPort === undefined ? '' : ` -> ${port.containerPort}`}`;
}

function safeValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
}

export type { ServiceWikiEntry, ServiceWikiProjection, WikiEntryDraft } from '@opsense/schema';
