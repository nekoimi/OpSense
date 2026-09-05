import { Type, type Static } from '@sinclair/typebox';

import { ProbeRequestSchema } from './ai.js';
import { DateTimeSchema, IdSchema, NonEmptyStringSchema } from './common.js';

export const GovernedProbeAuditStatusSchema = Type.Union([
  Type.Literal('accepted'),
  Type.Literal('rejected'),
  Type.Literal('deduplicated'),
]);

export const GovernedProbeAuditRecordSchema = Type.Object(
  {
    canonicalRequestId: Type.Optional(IdSchema),
    reason: NonEmptyStringSchema,
    request: ProbeRequestSchema,
    status: GovernedProbeAuditStatusSchema,
  },
  { additionalProperties: false },
);

export const GovernedProbePlanSchema = Type.Object(
  {
    audit: Type.Array(GovernedProbeAuditRecordSchema),
    generatedAt: DateTimeSchema,
    planId: IdSchema,
    requests: Type.Array(ProbeRequestSchema),
    round: Type.Literal(1),
    sourceCandidateSetHash: NonEmptyStringSchema,
    sourceDecisionId: IdSchema,
  },
  { $id: 'GovernedProbePlanV3', additionalProperties: false },
);

export type GovernedProbePlan = Static<typeof GovernedProbePlanSchema>;

export const ProbeObjectResultSchema = Type.Object(
  {
    durationMs: Type.Integer({ minimum: 0 }),
    evidenceIds: Type.Array(IdSchema),
    reason: NonEmptyStringSchema,
    requestId: IdSchema,
    status: Type.Union([
      Type.Literal('completed'),
      Type.Literal('failed'),
      Type.Literal('cancelled'),
      Type.Literal('skipped'),
    ]),
  },
  { additionalProperties: false },
);

export const ProbeYieldSchema = Type.Object(
  {
    changedConfidenceCount: Type.Integer({ minimum: 0 }),
    newEvidenceCount: Type.Integer({ minimum: 0 }),
    newServiceCount: Type.Integer({ minimum: 0 }),
    resolvedFieldCount: Type.Integer({ minimum: 0 }),
    resolvedQuestionCount: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export type ProbeYield = Static<typeof ProbeYieldSchema>;

export const ProbeBatchResultSchema = Type.Object(
  {
    evidenceIds: Type.Array(IdSchema),
    finishedAt: DateTimeSchema,
    planId: IdSchema,
    results: Type.Array(ProbeObjectResultSchema),
    round: Type.Literal(1),
    startedAt: DateTimeSchema,
    yield: ProbeYieldSchema,
  },
  { $id: 'ProbeBatchResultV3', additionalProperties: false },
);

export type ProbeBatchResult = Static<typeof ProbeBatchResultSchema>;
