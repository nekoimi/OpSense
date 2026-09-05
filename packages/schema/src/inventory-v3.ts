import { Type, type Static } from '@sinclair/typebox';

import { ConfidenceSchema, DateTimeSchema, IdSchema, NonEmptyStringSchema } from './common.js';
import { FindingRecordSchema } from './evidence.js';

export const DeploymentHintSchema = Type.Union([
  Type.Literal('systemd'),
  Type.Literal('process'),
  Type.Literal('docker'),
  Type.Literal('compose'),
]);

export type DeploymentHint = Static<typeof DeploymentHintSchema>;

export const PortSummarySchema = Type.Object(
  {
    address: Type.Optional(Type.String()),
    containerPort: Type.Optional(Type.Integer({ minimum: 0, maximum: 65_535 })),
    exposed: Type.Boolean(),
    hostPort: Type.Integer({ minimum: 0, maximum: 65_535 }),
    protocol: Type.Union([Type.Literal('tcp'), Type.Literal('udp')]),
  },
  { additionalProperties: false },
);

export type PortSummary = Static<typeof PortSummarySchema>;

export const ProtectionSignalSchema = Type.Union([
  Type.Literal('docker_deployment'),
  Type.Literal('compose_deployment'),
  Type.Literal('exposed_socket'),
  Type.Literal('listening_process'),
  Type.Literal('failed_unit'),
  Type.Literal('custom_systemd_unit'),
  Type.Literal('custom_service_path'),
  Type.Literal('service_storage'),
  Type.Literal('evidence_conflict'),
]);

export type ProtectionSignal = Static<typeof ProtectionSignalSchema>;

export const DeploymentCandidateSchema = Type.Object(
  {
    candidateId: IdSchema,
    composeProjectIds: Type.Array(IdSchema),
    containerIds: Type.Array(IdSchema),
    deploymentHints: Type.Array(DeploymentHintSchema),
    evidenceIds: Type.Array(IdSchema),
    exposedPorts: Type.Array(PortSummarySchema),
    imageNames: Type.Array(NonEmptyStringSchema),
    pathIds: Type.Array(IdSchema),
    processIds: Type.Array(IdSchema),
    protectionSignals: Type.Array(ProtectionSignalSchema, { minItems: 1 }),
    socketIds: Type.Array(IdSchema),
    sourceObjectIds: Type.Array(IdSchema, { minItems: 1 }),
    suggestedName: Type.Optional(NonEmptyStringSchema),
    unitIds: Type.Array(IdSchema),
    unresolvedFields: Type.Array(NonEmptyStringSchema),
  },
  { additionalProperties: false },
);

export type DeploymentCandidate = Static<typeof DeploymentCandidateSchema>;

export const FilteredEvidenceGroupCategorySchema = Type.Union([
  Type.Literal('routine_system_service'),
  Type.Literal('boot_helper'),
  Type.Literal('kernel_helper'),
  Type.Literal('runtime_internal'),
  Type.Literal('inactive_unit'),
]);

export const FilteredEvidenceGroupSchema = Type.Object(
  {
    category: FilteredEvidenceGroupCategorySchema,
    evidenceIds: Type.Array(IdSchema),
    groupId: IdSchema,
    objectCount: Type.Integer({ minimum: 1 }),
    reason: NonEmptyStringSchema,
    sampleNames: Type.Array(NonEmptyStringSchema),
    sourceObjectIds: Type.Array(IdSchema, { minItems: 1 }),
  },
  { additionalProperties: false },
);

export type FilteredEvidenceGroup = Static<typeof FilteredEvidenceGroupSchema>;

export const DeploymentCandidateSetSchema = Type.Object(
  {
    candidates: Type.Array(DeploymentCandidateSchema),
    filteredGroups: Type.Array(FilteredEvidenceGroupSchema),
    generatedAt: DateTimeSchema,
    graphId: IdSchema,
    schemaVersion: Type.Literal('3.0'),
    sourceScanId: IdSchema,
  },
  { $id: 'DeploymentCandidateSetV3', additionalProperties: false },
);

export type DeploymentCandidateSet = Static<typeof DeploymentCandidateSetSchema>;

export const DeploymentServiceRoleSchema = Type.Union([
  Type.Literal('primary_application'),
  Type.Literal('infrastructure_service'),
  Type.Literal('edge_service'),
  Type.Literal('supporting_component'),
  Type.Literal('container_platform'),
  Type.Literal('system_service'),
  Type.Literal('needs_review'),
]);

export const AttributedStringSchema = Type.Object(
  {
    certainty: Type.Union([
      Type.Literal('confirmed'),
      Type.Literal('inferred'),
      Type.Literal('unknown'),
    ]),
    evidenceIds: Type.Array(IdSchema),
    source: Type.Union([
      Type.Literal('collector'),
      Type.Literal('correlation'),
      Type.Literal('codex'),
      Type.Literal('human'),
    ]),
    value: NonEmptyStringSchema,
  },
  { additionalProperties: false },
);

export const DeploymentInventoryServiceSchema = Type.Object(
  {
    composeProjectIds: Type.Array(IdSchema),
    confidence: ConfidenceSchema,
    containerIds: Type.Array(IdSchema),
    deploymentHints: Type.Array(DeploymentHintSchema),
    evidenceIds: Type.Array(IdSchema),
    imageNames: Type.Array(NonEmptyStringSchema),
    name: NonEmptyStringSchema,
    attribution: Type.Object(
      {
        name: AttributedStringSchema,
        purpose: Type.Optional(AttributedStringSchema),
        role: AttributedStringSchema,
      },
      { additionalProperties: false },
    ),
    pathIds: Type.Array(IdSchema),
    ports: Type.Array(PortSummarySchema),
    processIds: Type.Array(IdSchema),
    purpose: Type.Optional(NonEmptyStringSchema),
    reviewItems: Type.Array(NonEmptyStringSchema),
    role: DeploymentServiceRoleSchema,
    serviceId: IdSchema,
    socketIds: Type.Array(IdSchema),
    sourceCandidateIds: Type.Array(IdSchema, { minItems: 1 }),
    sourceObjectIds: Type.Array(IdSchema, { minItems: 1 }),
    unitIds: Type.Array(IdSchema),
    unknownFields: Type.Array(NonEmptyStringSchema),
  },
  { additionalProperties: false },
);

export const InventoryCoverageSchema = Type.Object(
  {
    candidateCount: Type.Integer({ minimum: 0 }),
    filteredObjectCount: Type.Integer({ minimum: 0 }),
    protectedObjectCount: Type.Integer({ minimum: 0 }),
    rawObjectCount: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const DeploymentInventorySchema = Type.Object(
  {
    coverage: InventoryCoverageSchema,
    exposedPorts: Type.Array(PortSummarySchema),
    filteredGroups: Type.Array(FilteredEvidenceGroupSchema),
    findings: Type.Array(FindingRecordSchema),
    generatedAt: DateTimeSchema,
    host: Type.Object(
      {
        hostname: NonEmptyStringSchema,
        operatingSystem: NonEmptyStringSchema,
      },
      { additionalProperties: false },
    ),
    inventoryId: IdSchema,
    schemaVersion: Type.Literal('3.0'),
    semanticStatus: Type.Union([
      Type.Literal('verified'),
      Type.Literal('partially_verified'),
      Type.Literal('unverified'),
    ]),
    sourceDecisionId: Type.Optional(IdSchema),
    services: Type.Array(DeploymentInventoryServiceSchema),
    sourceEvidenceHash: NonEmptyStringSchema,
    sourceScanId: IdSchema,
    unresolvedQuestions: Type.Array(Type.String()),
    filteredCandidateIds: Type.Array(IdSchema),
  },
  { $id: 'DeploymentInventoryV3', additionalProperties: false },
);

export type DeploymentInventory = Static<typeof DeploymentInventorySchema>;
