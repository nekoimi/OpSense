import { Type, type Static } from '@sinclair/typebox';

import { ConfidenceSchema, DateTimeSchema, IdSchema, NonEmptyStringSchema } from './common.js';
import { ReportPlacementSchema } from './ai.js';
import { DeploymentTypeSchema, ServiceStatusSchema } from './service.js';

export const WikiServiceRoleSchema = Type.Union([
  Type.Literal('primary_application'),
  Type.Literal('infrastructure_service'),
  Type.Literal('edge_service'),
  Type.Literal('supporting_component'),
  Type.Literal('container_platform'),
  Type.Literal('system_service'),
  Type.Literal('unknown'),
]);

export type WikiServiceRole = Static<typeof WikiServiceRoleSchema>;

export const WikiClaimSchema = Type.Object(
  {
    field: NonEmptyStringSchema,
    value: NonEmptyStringSchema,
    confidence: ConfidenceSchema,
    evidenceIds: Type.Array(IdSchema),
  },
  { additionalProperties: false },
);

export type WikiClaim = Static<typeof WikiClaimSchema>;

export const WikiCommandSchema = Type.Object(
  {
    command: NonEmptyStringSchema,
    confidence: ConfidenceSchema,
    evidenceIds: Type.Array(IdSchema),
  },
  { additionalProperties: false },
);

export type WikiCommand = Static<typeof WikiCommandSchema>;

export const WikiPurposeSchema = Type.Object(
  {
    summary: Type.Optional(NonEmptyStringSchema),
    confidence: ConfidenceSchema,
    evidenceIds: Type.Array(IdSchema),
  },
  { additionalProperties: false },
);

export type WikiPurpose = Static<typeof WikiPurposeSchema>;

export const WikiIdentitySchema = Type.Object(
  {
    name: NonEmptyStringSchema,
    displayName: Type.Optional(NonEmptyStringSchema),
    role: WikiServiceRoleSchema,
  },
  { additionalProperties: false },
);

export type WikiIdentity = Static<typeof WikiIdentitySchema>;

export const WikiLifecycleSchema = Type.Object(
  {
    status: ServiceStatusSchema,
    enabledAtBoot: Type.Optional(Type.Boolean()),
    start: Type.Optional(WikiCommandSchema),
    stop: Type.Optional(WikiCommandSchema),
    restart: Type.Optional(WikiCommandSchema),
  },
  { additionalProperties: false },
);

export type WikiLifecycle = Static<typeof WikiLifecycleSchema>;

export const WikiContainerSchema = Type.Object(
  {
    containerId: IdSchema,
    name: NonEmptyStringSchema,
    image: NonEmptyStringSchema,
    state: NonEmptyStringSchema,
    evidenceIds: Type.Array(IdSchema),
  },
  { additionalProperties: false },
);

export type WikiContainer = Static<typeof WikiContainerSchema>;

export const WikiComposeServiceSchema = Type.Object(
  {
    projectId: IdSchema,
    name: NonEmptyStringSchema,
    containerIds: Type.Array(IdSchema),
    evidenceIds: Type.Array(IdSchema),
  },
  { additionalProperties: false },
);

export type WikiComposeService = Static<typeof WikiComposeServiceSchema>;

export const WikiDeploymentSchema = Type.Object(
  {
    deploymentType: DeploymentTypeSchema,
    deployDirectories: Type.Array(Type.String()),
    systemdUnitIds: Type.Array(IdSchema),
    composeProjectIds: Type.Array(IdSchema),
    composeServices: Type.Array(WikiComposeServiceSchema),
    containerIds: Type.Array(IdSchema),
    containers: Type.Array(WikiContainerSchema),
    processIds: Type.Array(Type.Integer({ minimum: 1 })),
    runtimeUser: Type.Optional(NonEmptyStringSchema),
  },
  { additionalProperties: false },
);

export type WikiDeployment = Static<typeof WikiDeploymentSchema>;

export const WikiExposurePortSchema = Type.Object(
  {
    protocol: NonEmptyStringSchema,
    hostAddress: Type.Optional(NonEmptyStringSchema),
    hostPort: Type.Optional(Type.Integer({ minimum: 0, maximum: 65535 })),
    containerPort: Type.Optional(Type.Integer({ minimum: 0, maximum: 65535 })),
    exposed: Type.Boolean(),
    evidenceIds: Type.Array(IdSchema),
  },
  { additionalProperties: false },
);

export type WikiExposurePort = Static<typeof WikiExposurePortSchema>;

export const WikiExposureSchema = Type.Object(
  { ports: Type.Array(WikiExposurePortSchema) },
  { additionalProperties: false },
);

export type WikiExposure = Static<typeof WikiExposureSchema>;

export const WikiConfigurationSchema = Type.Object(
  {
    configFiles: Type.Array(Type.String()),
    environmentFiles: Type.Array(Type.String()),
    backupPaths: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);

export type WikiConfiguration = Static<typeof WikiConfigurationSchema>;

export const WikiStorageSchema = Type.Object(
  {
    dataDirectories: Type.Array(Type.String()),
    mountIds: Type.Array(IdSchema),
    backupPaths: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);

export type WikiStorage = Static<typeof WikiStorageSchema>;

export const WikiLoggingSchema = Type.Object(
  { logLocations: Type.Array(Type.String()) },
  { additionalProperties: false },
);

export type WikiLogging = Static<typeof WikiLoggingSchema>;

export const WikiEvidenceSummarySchema = Type.Object(
  {
    evidenceIds: Type.Array(IdSchema),
    coverage: Type.Number({ minimum: 0, maximum: 1 }),
    coveredFields: Type.Array(NonEmptyStringSchema),
    missingFields: Type.Array(NonEmptyStringSchema),
    conflictFields: Type.Array(NonEmptyStringSchema),
  },
  { additionalProperties: false },
);

export type WikiEvidenceSummary = Static<typeof WikiEvidenceSummarySchema>;

export const WikiConflictSchema = Type.Object(
  {
    field: NonEmptyStringSchema,
    evidenceIds: Type.Array(IdSchema),
    sources: Type.Array(NonEmptyStringSchema),
    observedValues: Type.Array(NonEmptyStringSchema),
  },
  { additionalProperties: false },
);

export type WikiConflict = Static<typeof WikiConflictSchema>;

const WikiEntryFields = {
  serviceId: IdSchema,
  identity: WikiIdentitySchema,
  oneLineSummary: NonEmptyStringSchema,
  purpose: WikiPurposeSchema,
  lifecycle: WikiLifecycleSchema,
  deployment: WikiDeploymentSchema,
  exposure: WikiExposureSchema,
  configuration: WikiConfigurationSchema,
  storage: WikiStorageSchema,
  logging: WikiLoggingSchema,
  evidence: WikiEvidenceSummarySchema,
  confidence: ConfidenceSchema,
  conflicts: Type.Array(WikiConflictSchema),
  confirmedFacts: Type.Array(WikiClaimSchema),
  inferences: Type.Array(WikiClaimSchema),
  unknowns: Type.Array(NonEmptyStringSchema),
  reviewItems: Type.Array(NonEmptyStringSchema),
};

export const WikiEntryDraftSchema = Type.Object(WikiEntryFields, {
  $id: 'WikiEntryDraft',
  additionalProperties: false,
});

export type WikiEntryDraft = Static<typeof WikiEntryDraftSchema>;

export const ServiceWikiEntrySchema = Type.Object(
  {
    ...WikiEntryFields,
    anchor: NonEmptyStringSchema,
    reportPlacement: ReportPlacementSchema,
    generatedAt: DateTimeSchema,
  },
  { $id: 'ServiceWikiEntry', additionalProperties: false },
);

export type ServiceWikiEntry = Static<typeof ServiceWikiEntrySchema>;
