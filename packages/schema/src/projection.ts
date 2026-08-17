import { Type, type Static } from '@sinclair/typebox';

import { AiAnalysisSchema, AiPathAssessmentSchema, AiServiceAssessmentSchema } from './ai.js';
import { DateTimeSchema, IdSchema, NonEmptyStringSchema } from './common.js';
import { EvidenceRecordSchema, FindingRecordSchema } from './evidence.js';
import { HostSnapshotSchema } from './host.js';
import { NetworkSnapshotSchema } from './network.js';
import { ProcessRecordSchema, SocketRecordSchema, SystemdUnitRecordSchema } from './runtime.js';
import { ServiceRecordSchema } from './service.js';
import { StorageSnapshotSchema } from './storage.js';
import { ContainerRecordSchema, ComposeProjectRecordSchema } from './container.js';
import { ArtifactRecordSchema, PathSeedRecordSchema } from './evidence.js';
import { ScanSessionSchema } from './scan.js';
import { RedactionReportSchema } from './redaction.js';
import { ServiceWikiEntrySchema } from './wiki.js';

export const VisibilityPlacementSchema = Type.Union([
  Type.Literal('primary'),
  Type.Literal('supporting'),
  Type.Literal('summary'),
  Type.Literal('appendix'),
  Type.Literal('filtered'),
]);

export type VisibilityPlacement = Static<typeof VisibilityPlacementSchema>;

export const VisibilityDecisionSchema = Type.Object(
  {
    objectId: IdSchema,
    objectType: NonEmptyStringSchema,
    placement: VisibilityPlacementSchema,
    resourceClass: NonEmptyStringSchema,
    visibilityReason: NonEmptyStringSchema,
    relatedServiceIds: Type.Array(IdSchema),
    evidenceIds: Type.Array(IdSchema),
    userReviewRequired: Type.Boolean(),
  },
  { additionalProperties: false },
);

export type VisibilityDecision = Static<typeof VisibilityDecisionSchema>;

export const RiskFindingSchema = Type.Object(
  {
    findingId: IdSchema,
    title: NonEmptyStringSchema,
    description: NonEmptyStringSchema,
    severity: Type.Union([
      Type.Literal('info'),
      Type.Literal('low'),
      Type.Literal('medium'),
      Type.Literal('high'),
      Type.Literal('critical'),
    ]),
    status: Type.Union([
      Type.Literal('confirmed'),
      Type.Literal('inferred'),
      Type.Literal('needs_review'),
    ]),
    relatedServiceIds: Type.Array(IdSchema),
    evidenceIds: Type.Array(IdSchema),
  },
  { additionalProperties: false },
);

export type RiskFinding = Static<typeof RiskFindingSchema>;

export const DiscoveryWorkflowVersionSchema = Type.Union([
  Type.Literal('m19_full_candidate_review'),
  Type.Literal('m20_evidence_driven'),
]);

export type DiscoveryWorkflowVersion = Static<typeof DiscoveryWorkflowVersionSchema>;

export const DiscoveryInvestigationStatusSchema = Type.Union([
  Type.Literal('selected'),
  Type.Literal('investigating'),
  Type.Literal('resolved'),
  Type.Literal('needs_review'),
]);

export const DiscoveryInvestigationSchema = Type.Object(
  {
    investigationId: IdSchema,
    label: NonEmptyStringSchema,
    status: DiscoveryInvestigationStatusSchema,
    priority: Type.Union([
      Type.Literal('critical'),
      Type.Literal('high'),
      Type.Literal('medium'),
      Type.Literal('low'),
    ]),
    serviceIds: Type.Array(IdSchema),
    sourceObjectIds: Type.Array(IdSchema),
    evidenceIds: Type.Array(IdSchema, { minItems: 1 }),
    reason: NonEmptyStringSchema,
  },
  { additionalProperties: false },
);

export type DiscoveryInvestigation = Static<typeof DiscoveryInvestigationSchema>;

export const DiscoveredServiceSchema = Type.Object(
  {
    serviceId: IdSchema,
    name: NonEmptyStringSchema,
    displayName: Type.Optional(Type.String()),
    deploymentType: Type.Union([
      Type.Literal('systemd'),
      Type.Literal('process'),
      Type.Literal('docker'),
      Type.Literal('compose'),
      Type.Literal('unknown'),
    ]),
    status: Type.Union([
      Type.Literal('running'),
      Type.Literal('stopped'),
      Type.Literal('failed'),
      Type.Literal('unknown'),
    ]),
    sourceObjectIds: Type.Array(IdSchema, { minItems: 1 }),
    evidenceIds: Type.Array(IdSchema, { minItems: 1 }),
    unknownFields: Type.Array(NonEmptyStringSchema),
    reason: NonEmptyStringSchema,
  },
  { additionalProperties: false },
);

export type DiscoveredService = Static<typeof DiscoveredServiceSchema>;

export const DiscoveryFilterGroupSchema = Type.Object(
  {
    groupId: IdSchema,
    label: NonEmptyStringSchema,
    resourceClass: NonEmptyStringSchema,
    sourceObjectIds: Type.Array(IdSchema, { minItems: 1 }),
    evidenceIds: Type.Array(IdSchema, { minItems: 1 }),
    reason: NonEmptyStringSchema,
  },
  { additionalProperties: false },
);

export type DiscoveryFilterGroup = Static<typeof DiscoveryFilterGroupSchema>;

export const DiscoveryWorkspaceSchema = Type.Object(
  {
    workflowVersion: DiscoveryWorkflowVersionSchema,
    planningCompleted: Type.Boolean(),
    discoveryCompleted: Type.Boolean(),
    investigations: Type.Array(DiscoveryInvestigationSchema),
    discoveredServices: Type.Array(DiscoveredServiceSchema),
    filteredGroups: Type.Array(DiscoveryFilterGroupSchema),
    unresolvedQuestions: Type.Array(Type.String()),
    updatedAt: DateTimeSchema,
  },
  { additionalProperties: false },
);

export type DiscoveryWorkspace = Static<typeof DiscoveryWorkspaceSchema>;

export const ServiceWikiProjectionSchema = Type.Object(
  {
    projectionId: IdSchema,
    inventoryProjectionId: IdSchema,
    generatedAt: DateTimeSchema,
    serviceIds: Type.Array(IdSchema),
    summaryServiceIds: Type.Array(IdSchema),
    reviewServiceIds: Type.Array(IdSchema),
    riskFindings: Type.Array(RiskFindingSchema),
    entries: Type.Array(ServiceWikiEntrySchema),
    unresolvedQuestions: Type.Array(Type.String()),
  },
  { $id: 'ServiceWikiProjection', additionalProperties: false },
);

export type ServiceWikiProjection = Static<typeof ServiceWikiProjectionSchema>;

export const InventoryProjectionSchema = Type.Object(
  {
    projectionId: IdSchema,
    sourceSnapshotId: IdSchema,
    generatedAt: DateTimeSchema,
    session: ScanSessionSchema,
    host: Type.Optional(HostSnapshotSchema),
    storage: Type.Optional(StorageSnapshotSchema),
    network: Type.Optional(NetworkSnapshotSchema),
    processes: Type.Array(ProcessRecordSchema),
    sockets: Type.Array(SocketRecordSchema),
    systemdUnits: Type.Array(SystemdUnitRecordSchema),
    containers: Type.Array(ContainerRecordSchema),
    composeProjects: Type.Array(ComposeProjectRecordSchema),
    pathSeeds: Type.Optional(Type.Array(PathSeedRecordSchema)),
    artifacts: Type.Array(ArtifactRecordSchema),
    services: Type.Array(ServiceRecordSchema),
    serviceAssessments: Type.Array(AiServiceAssessmentSchema),
    pathAssessments: Type.Optional(Type.Array(AiPathAssessmentSchema)),
    classificationProvider: Type.Optional(
      Type.Union([Type.Literal('codex'), Type.Literal('baseline'), Type.Literal('legacy')]),
    ),
    classificationCompleted: Type.Optional(Type.Boolean()),
    candidateServiceCount: Type.Optional(Type.Integer({ minimum: 0 })),
    reviewedServiceCount: Type.Optional(Type.Integer({ minimum: 0 })),
    reviewedServiceIds: Type.Optional(Type.Array(IdSchema)),
    candidatePathCount: Type.Optional(Type.Integer({ minimum: 0 })),
    candidatePathKeys: Type.Optional(Type.Array(NonEmptyStringSchema)),
    reviewedPathCount: Type.Optional(Type.Integer({ minimum: 0 })),
    reviewedPathKeys: Type.Optional(Type.Array(NonEmptyStringSchema)),
    classificationThreadId: Type.Optional(NonEmptyStringSchema),
    classificationUpdatedAt: Type.Optional(DateTimeSchema),
    discoveryWorkspace: Type.Optional(DiscoveryWorkspaceSchema),
    evidence: Type.Array(EvidenceRecordSchema),
    findings: Type.Array(FindingRecordSchema),
    unknowns: Type.Array(Type.String()),
    visibilityDecisions: Type.Array(VisibilityDecisionSchema),
    filteredCounts: Type.Record(Type.String(), Type.Integer({ minimum: 0 })),
    analysis: Type.Optional(AiAnalysisSchema),
    redaction: Type.Optional(RedactionReportSchema),
  },
  { $id: 'InventoryProjection', additionalProperties: false },
);

export type InventoryProjection = Static<typeof InventoryProjectionSchema>;
