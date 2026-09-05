import { Type, type Static } from '@sinclair/typebox';

import { BatchDiscoveryRunSchema } from './batch-discovery.js';
import { DateTimeSchema, IdSchema, NonEmptyStringSchema } from './common.js';
import {
  DeploymentHintSchema,
  DeploymentServiceRoleSchema,
  FilteredEvidenceGroupSchema,
  PortSummarySchema,
} from './inventory-v3.js';

export const WikiNarrativeClaimSchema = Type.Object(
  {
    evidenceIds: Type.Array(IdSchema),
    text: NonEmptyStringSchema,
  },
  { additionalProperties: false },
);

export const WikiServiceNarrativeSchema = Type.Object(
  {
    evidenceIds: Type.Array(IdSchema),
    operations: Type.Array(NonEmptyStringSchema),
    serviceId: IdSchema,
    summary: NonEmptyStringSchema,
  },
  { additionalProperties: false },
);

export const WikiNarrativeProposalSchema = Type.Object(
  {
    architectureSummary: NonEmptyStringSchema,
    executiveSummary: NonEmptyStringSchema,
    inventoryHash: NonEmptyStringSchema,
    inventoryId: IdSchema,
    operationsConcerns: Type.Array(WikiNarrativeClaimSchema),
    reviewRecommendations: Type.Array(NonEmptyStringSchema),
    serviceDescriptions: Type.Array(WikiServiceNarrativeSchema),
  },
  { $id: 'WikiNarrativeProposalV3', additionalProperties: false },
);

export type WikiNarrativeProposal = Static<typeof WikiNarrativeProposalSchema>;

export const WikiNarrativeResultSchema = Type.Object(
  {
    narrative: Type.Optional(WikiNarrativeProposalSchema),
    run: BatchDiscoveryRunSchema,
  },
  { $id: 'WikiNarrativeResultV3', additionalProperties: false },
);

export type WikiNarrativeResult = Static<typeof WikiNarrativeResultSchema>;

export const WikiProjectionServiceSchema = Type.Object(
  {
    deploymentHints: Type.Array(DeploymentHintSchema),
    evidenceIds: Type.Array(IdSchema),
    name: NonEmptyStringSchema,
    pathIds: Type.Array(IdSchema),
    ports: Type.Array(PortSummarySchema),
    purpose: Type.Optional(NonEmptyStringSchema),
    reviewItems: Type.Array(NonEmptyStringSchema),
    role: DeploymentServiceRoleSchema,
    serviceId: IdSchema,
    unknownFields: Type.Array(NonEmptyStringSchema),
  },
  { additionalProperties: false },
);

export const WikiProjectionV3Schema = Type.Object(
  {
    filteredGroups: Type.Array(FilteredEvidenceGroupSchema),
    generatedAt: DateTimeSchema,
    host: Type.Object(
      {
        hostname: NonEmptyStringSchema,
        operatingSystem: NonEmptyStringSchema,
      },
      { additionalProperties: false },
    ),
    inventoryHash: NonEmptyStringSchema,
    inventoryId: IdSchema,
    narrative: Type.Optional(WikiNarrativeProposalSchema),
    projectionId: IdSchema,
    schemaVersion: Type.Literal('3.0'),
    semanticStatus: Type.Union([
      Type.Literal('verified'),
      Type.Literal('partially_verified'),
      Type.Literal('unverified'),
    ]),
    services: Type.Array(WikiProjectionServiceSchema),
    unresolvedQuestions: Type.Array(Type.String()),
  },
  { $id: 'WikiProjectionV3', additionalProperties: false },
);

export type WikiProjectionV3 = Static<typeof WikiProjectionV3Schema>;

export const WikiQualityResultSchema = Type.Object(
  {
    errors: Type.Array(NonEmptyStringSchema),
    evidenceReferenceCoverage: Type.Number({ minimum: 0, maximum: 1 }),
    passed: Type.Boolean(),
    serviceCoverage: Type.Number({ minimum: 0, maximum: 1 }),
    warnings: Type.Array(NonEmptyStringSchema),
  },
  { additionalProperties: false },
);

export type WikiQualityResult = Static<typeof WikiQualityResultSchema>;

export const WikiCompositionArtifactSchema = Type.Object(
  {
    projection: WikiProjectionV3Schema,
    quality: WikiQualityResultSchema,
    run: BatchDiscoveryRunSchema,
    schemaVersion: Type.Literal('3.0'),
  },
  { $id: 'WikiCompositionArtifactV3', additionalProperties: false },
);

export type WikiCompositionArtifact = Static<typeof WikiCompositionArtifactSchema>;
