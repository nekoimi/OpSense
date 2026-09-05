import { Type, type Static } from '@sinclair/typebox';

import { DateTimeSchema, IdSchema, NonEmptyStringSchema } from './common.js';
import { ProbeRequestSchema } from './probe-request.js';
import { DeploymentHintSchema, PortSummarySchema, ProtectionSignalSchema } from './inventory-v3.js';
import { GovernedProbePlanSchema, ProbeBatchResultSchema } from './probe-v3.js';

export const BATCH_DISCOVERY_CONTRACT_VERSION = 'batch-discovery-v1' as const;

const CompactResourceSchema = Type.Object(
  {
    attributes: Type.Record(Type.String(), Type.Unknown()),
    id: IdSchema,
    name: NonEmptyStringSchema,
  },
  { additionalProperties: false },
);

const CompactEvidenceSchema = Type.Object(
  {
    field: Type.Optional(NonEmptyStringSchema),
    id: IdSchema,
    kind: NonEmptyStringSchema,
    source: NonEmptyStringSchema,
    status: NonEmptyStringSchema,
  },
  { additionalProperties: false },
);

export const BatchDiscoveryCandidateSchema = Type.Object(
  {
    candidateId: IdSchema,
    composeProjects: Type.Array(CompactResourceSchema, { maxItems: 4 }),
    containers: Type.Array(CompactResourceSchema, { maxItems: 4 }),
    deploymentHints: Type.Array(DeploymentHintSchema),
    evidenceIds: Type.Array(IdSchema, { maxItems: 12 }),
    imageNames: Type.Array(NonEmptyStringSchema, { maxItems: 4 }),
    paths: Type.Array(CompactResourceSchema, { maxItems: 12 }),
    ports: Type.Array(PortSummarySchema, { maxItems: 8 }),
    processes: Type.Array(CompactResourceSchema, { maxItems: 4 }),
    protectionSignals: Type.Array(ProtectionSignalSchema, { minItems: 1 }),
    sourceObjectIds: Type.Array(IdSchema, { minItems: 1 }),
    suggestedName: Type.Optional(NonEmptyStringSchema),
    totals: Type.Object(
      {
        composeProjects: Type.Integer({ minimum: 0 }),
        containers: Type.Integer({ minimum: 0 }),
        evidence: Type.Integer({ minimum: 0 }),
        paths: Type.Integer({ minimum: 0 }),
        ports: Type.Integer({ minimum: 0 }),
        processes: Type.Integer({ minimum: 0 }),
        units: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
    units: Type.Array(CompactResourceSchema, { maxItems: 4 }),
    unresolvedFields: Type.Array(NonEmptyStringSchema),
  },
  { additionalProperties: false },
);

export type BatchDiscoveryCandidate = Static<typeof BatchDiscoveryCandidateSchema>;

const BatchDiscoveryFilteredGroupSchema = Type.Object(
  {
    category: NonEmptyStringSchema,
    groupId: IdSchema,
    objectCount: Type.Integer({ minimum: 1 }),
    reason: NonEmptyStringSchema,
    sampleNames: Type.Array(NonEmptyStringSchema, { maxItems: 10 }),
  },
  { additionalProperties: false },
);

export const BatchDiscoveryInputSchema = Type.Object(
  {
    candidates: Type.Array(BatchDiscoveryCandidateSchema),
    contractVersion: Type.Literal(BATCH_DISCOVERY_CONTRACT_VERSION),
    evidenceIndex: Type.Array(CompactEvidenceSchema),
    filteredGroups: Type.Array(BatchDiscoveryFilteredGroupSchema),
    host: Type.Object(
      {
        architecture: NonEmptyStringSchema,
        hostname: NonEmptyStringSchema,
        operatingSystem: NonEmptyStringSchema,
      },
      { additionalProperties: false },
    ),
    probePolicy: Type.Object(
      {
        allowedKinds: Type.Array(NonEmptyStringSchema),
        maxRequests: Type.Integer({ minimum: 0 }),
        maxRounds: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
    sourceCandidateSetHash: NonEmptyStringSchema,
    sourceScanId: IdSchema,
  },
  { $id: 'BatchDiscoveryInputV3', additionalProperties: false },
);

export type BatchDiscoveryInput = Static<typeof BatchDiscoveryInputSchema>;

export const DiscoveredServiceRoleSchema = Type.Union([
  Type.Literal('primary_application'),
  Type.Literal('infrastructure_service'),
  Type.Literal('edge_service'),
  Type.Literal('supporting_component'),
  Type.Literal('container_platform'),
  Type.Literal('system_service'),
  Type.Literal('needs_review'),
]);

export const DiscoveredServiceDraftSchema = Type.Object(
  {
    confidence: Type.Union([
      Type.Literal('confirmed'),
      Type.Literal('inferred'),
      Type.Literal('unknown'),
    ]),
    displayName: Type.Optional(NonEmptyStringSchema),
    evidenceIds: Type.Array(IdSchema),
    name: NonEmptyStringSchema,
    purpose: Type.Optional(NonEmptyStringSchema),
    reviewItems: Type.Array(NonEmptyStringSchema),
    role: DiscoveredServiceRoleSchema,
    serviceId: IdSchema,
    sourceCandidateIds: Type.Array(IdSchema, { minItems: 1 }),
    sourceObjectIds: Type.Array(IdSchema, { minItems: 1 }),
    unknownFields: Type.Array(NonEmptyStringSchema),
  },
  { additionalProperties: false },
);

export type DiscoveredServiceDraft = Static<typeof DiscoveredServiceDraftSchema>;

export const BatchDiscoveryDecisionSchema = Type.Object(
  {
    decisionId: IdSchema,
    filteredCandidateIds: Type.Array(IdSchema),
    probeRequests: Type.Array(ProbeRequestSchema),
    retainedUnknownCandidateIds: Type.Array(IdSchema),
    services: Type.Array(DiscoveredServiceDraftSchema),
    sourceCandidateSetHash: NonEmptyStringSchema,
    summary: NonEmptyStringSchema,
    unresolvedQuestions: Type.Array(NonEmptyStringSchema),
  },
  { $id: 'BatchDiscoveryDecisionV3', additionalProperties: false },
);

export type BatchDiscoveryDecision = Static<typeof BatchDiscoveryDecisionSchema>;

export const ItemValidationErrorSchema = Type.Object(
  {
    allowedValues: Type.Optional(Type.Array(Type.String())),
    code: NonEmptyStringSchema,
    field: NonEmptyStringSchema,
    itemId: NonEmptyStringSchema,
    message: NonEmptyStringSchema,
  },
  { additionalProperties: false },
);

export type ItemValidationError = Static<typeof ItemValidationErrorSchema>;

export const DiscoveryCompletionSchema = Type.Object(
  {
    complete: Type.Boolean(),
    duplicateCandidateIds: Type.Array(IdSchema),
    handledCandidateIds: Type.Array(IdSchema),
    missingCandidateIds: Type.Array(IdSchema),
  },
  { additionalProperties: false },
);

export type DiscoveryCompletion = Static<typeof DiscoveryCompletionSchema>;

export const BatchDiscoveryRunSchema = Type.Object(
  {
    callCount: Type.Integer({ minimum: 0 }),
    durationMs: Type.Integer({ minimum: 0 }),
    error: Type.Optional(NonEmptyStringSchema),
    finishedAt: DateTimeSchema,
    model: Type.Optional(NonEmptyStringSchema),
    provider: NonEmptyStringSchema,
    repairCount: Type.Integer({ minimum: 0 }),
    startedAt: DateTimeSchema,
    status: Type.Union([Type.Literal('completed'), Type.Literal('degraded')]),
    threadId: Type.Optional(NonEmptyStringSchema),
    usage: Type.Object(
      {
        cachedInputTokens: Type.Integer({ minimum: 0 }),
        inputTokens: Type.Integer({ minimum: 0 }),
        outputTokens: Type.Integer({ minimum: 0 }),
        reasoningTokens: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export type BatchDiscoveryRun = Static<typeof BatchDiscoveryRunSchema>;

export const BatchDiscoveryArtifactSchema = Type.Object(
  {
    batchErrors: Type.Array(NonEmptyStringSchema),
    completion: DiscoveryCompletionSchema,
    decision: BatchDiscoveryDecisionSchema,
    itemErrors: Type.Array(ItemValidationErrorSchema),
    run: BatchDiscoveryRunSchema,
    schemaVersion: Type.Literal('3.0'),
  },
  { $id: 'BatchDiscoveryArtifactV3', additionalProperties: false },
);

export type BatchDiscoveryArtifact = Static<typeof BatchDiscoveryArtifactSchema>;

export const BatchReconciliationInputSchema = Type.Object(
  {
    contractVersion: Type.Literal('batch-reconciliation-v1'),
    discoveryInput: BatchDiscoveryInputSchema,
    newEvidence: Type.Array(
      Type.Object(
        {
          field: Type.Optional(NonEmptyStringSchema),
          id: IdSchema,
          kind: NonEmptyStringSchema,
          source: NonEmptyStringSchema,
          status: NonEmptyStringSchema,
          value: Type.Unknown(),
        },
        { additionalProperties: false },
      ),
    ),
    originalDecision: BatchDiscoveryDecisionSchema,
    probeBatch: ProbeBatchResultSchema,
    probePlan: GovernedProbePlanSchema,
  },
  { $id: 'BatchReconciliationInputV3', additionalProperties: false },
);

export type BatchReconciliationInput = Static<typeof BatchReconciliationInputSchema>;
