import { Type, type Static } from '@sinclair/typebox';

import { AiConfidenceSchema, DateTimeSchema, IdSchema, NonEmptyStringSchema } from './common.js';
import { FindingRecordSchema } from './evidence.js';

export const AiServiceSummarySchema = Type.Object(
  {
    serviceId: IdSchema,
    purpose: Type.Optional(Type.String()),
    purposeConfidence: AiConfidenceSchema,
    summary: NonEmptyStringSchema,
    evidenceIds: Type.Array(IdSchema),
    notes: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);

export const AiAnalysisSchema = Type.Object(
  {
    provider: NonEmptyStringSchema,
    model: Type.Optional(Type.String()),
    threadId: Type.Optional(Type.String()),
    generatedAt: DateTimeSchema,
    hostSummary: NonEmptyStringSchema,
    storageSummary: NonEmptyStringSchema,
    serviceSummaries: Type.Array(AiServiceSummarySchema),
    findings: Type.Array(FindingRecordSchema),
    unknowns: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);

export type AiAnalysis = Static<typeof AiAnalysisSchema>;
