import { Type, type Static } from '@sinclair/typebox';

import { AiAnalysisSchema, AiServiceAssessmentSchema } from './ai.js';
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
