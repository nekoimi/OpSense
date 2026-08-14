import { Type, type Static } from '@sinclair/typebox';

import { AiConfidenceSchema, DateTimeSchema, IdSchema, NonEmptyStringSchema } from './common.js';
import { FindingRecordSchema } from './evidence.js';

export const AiServiceRoleSchema = Type.Union([
  Type.Literal('application'),
  Type.Literal('middleware'),
  Type.Literal('infrastructure'),
  Type.Literal('system'),
  Type.Literal('unknown'),
]);

export const ReportPlacementSchema = Type.Union([
  Type.Literal('primary'),
  Type.Literal('supporting'),
  Type.Literal('system_summary'),
  Type.Literal('needs_review'),
]);

export const AiPathSemanticSchema = Type.Union([
  Type.Literal('deploy'),
  Type.Literal('config'),
  Type.Literal('data'),
  Type.Literal('log'),
  Type.Literal('backup'),
  Type.Literal('runtime'),
  Type.Literal('system'),
  Type.Literal('unknown'),
]);

export const AiServiceAssessmentSchema = Type.Object(
  {
    serviceId: IdSchema,
    role: AiServiceRoleSchema,
    reportPlacement: ReportPlacementSchema,
    purpose: Type.Optional(Type.String()),
    reason: NonEmptyStringSchema,
    confidence: AiConfidenceSchema,
    evidenceIds: Type.Array(IdSchema),
  },
  { additionalProperties: false },
);

export const AiPathAssessmentSchema = Type.Object(
  {
    path: NonEmptyStringSchema,
    serviceIds: Type.Array(IdSchema),
    semantic: AiPathSemanticSchema,
    reason: NonEmptyStringSchema,
    confidence: AiConfidenceSchema,
    evidenceIds: Type.Array(IdSchema),
  },
  { additionalProperties: false },
);

const ProbeCommon = {
  id: IdSchema,
  targetServiceId: IdSchema,
  reason: NonEmptyStringSchema,
  expectedFields: Type.Array(NonEmptyStringSchema, { minItems: 1 }),
  evidenceIds: Type.Array(IdSchema, { minItems: 1 }),
  maxBytes: Type.Integer({ minimum: 1024, maximum: 5_000_000 }),
  timeoutMs: Type.Integer({ minimum: 1000, maximum: 60_000 }),
} as const;

export const DirectoryMetadataProbeRequestSchema = Type.Object(
  {
    ...ProbeCommon,
    kind: Type.Literal('directory_metadata'),
    path: NonEmptyStringSchema,
  },
  { additionalProperties: false },
);

export const DirectoryListingProbeRequestSchema = Type.Object(
  {
    ...ProbeCommon,
    kind: Type.Literal('directory_listing'),
    path: NonEmptyStringSchema,
    maxDepth: Type.Integer({ minimum: 1, maximum: 8 }),
    maxMatches: Type.Integer({ minimum: 1, maximum: 1000 }),
  },
  { additionalProperties: false },
);

export const ConfigSummaryProbeRequestSchema = Type.Object(
  {
    ...ProbeCommon,
    kind: Type.Literal('config_summary'),
    path: NonEmptyStringSchema,
  },
  { additionalProperties: false },
);

export const PathSearchProbeRequestSchema = Type.Object(
  {
    ...ProbeCommon,
    kind: Type.Literal('path_search'),
    searchRoot: NonEmptyStringSchema,
    searchTerm: NonEmptyStringSchema,
    maxDepth: Type.Integer({ minimum: 1, maximum: 8 }),
    maxMatches: Type.Integer({ minimum: 1, maximum: 1000 }),
  },
  { additionalProperties: false },
);

export const ProbeRequestSchema = Type.Union([
  DirectoryMetadataProbeRequestSchema,
  DirectoryListingProbeRequestSchema,
  ConfigSummaryProbeRequestSchema,
  PathSearchProbeRequestSchema,
]);

export const AiPlanSchema = Type.Object(
  {
    provider: NonEmptyStringSchema,
    model: Type.Optional(Type.String()),
    threadId: Type.Optional(Type.String()),
    generatedAt: DateTimeSchema,
    serviceAssessments: Type.Array(AiServiceAssessmentSchema),
    pathAssessments: Type.Array(AiPathAssessmentSchema),
    probeRequests: Type.Array(ProbeRequestSchema),
  },
  { $id: 'AiPlan', additionalProperties: false },
);

export const AiPlanProposalSchema = Type.Object(
  {
    serviceAssessments: Type.Array(AiServiceAssessmentSchema),
    pathAssessments: Type.Array(AiPathAssessmentSchema),
    probeRequests: Type.Array(ProbeRequestSchema),
  },
  { $id: 'AiPlanProposal', additionalProperties: false },
);

export const ProbeAuditStatusSchema = Type.Union([
  Type.Literal('accepted'),
  Type.Literal('rejected'),
  Type.Literal('failed'),
  Type.Literal('skipped'),
  Type.Literal('pending'),
]);

export const ProbeAuditRecordSchema = Type.Object(
  {
    request: ProbeRequestSchema,
    status: ProbeAuditStatusSchema,
    reason: NonEmptyStringSchema,
    evidenceIds: Type.Array(IdSchema),
  },
  { additionalProperties: false },
);

export const AiProbeAuditSchema = Type.Object(
  {
    generatedAt: DateTimeSchema,
    round: Type.Integer({ minimum: 0, maximum: 1 }),
    records: Type.Array(ProbeAuditRecordSchema),
  },
  { $id: 'AiProbeAudit', additionalProperties: false },
);

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
    serviceAssessments: Type.Array(AiServiceAssessmentSchema),
    pathAssessments: Type.Array(AiPathAssessmentSchema),
    serviceSummaries: Type.Array(AiServiceSummarySchema),
    findings: Type.Array(FindingRecordSchema),
    unknowns: Type.Array(Type.String()),
  },
  { $id: 'AiAnalysis', additionalProperties: false },
);

export const AiAnalysisProposalSchema = Type.Object(
  {
    hostSummary: NonEmptyStringSchema,
    storageSummary: NonEmptyStringSchema,
    serviceSummaries: Type.Array(AiServiceSummarySchema),
    findings: Type.Array(FindingRecordSchema),
    unknowns: Type.Array(Type.String()),
  },
  { $id: 'AiAnalysisProposal', additionalProperties: false },
);

export const AiRunStatusSchema = Type.Union([
  Type.Literal('completed'),
  Type.Literal('degraded'),
  Type.Literal('failed'),
  Type.Literal('skipped'),
]);

export const AiRunSchema = Type.Object(
  {
    provider: NonEmptyStringSchema,
    model: Type.Optional(Type.String()),
    threadId: Type.Optional(Type.String()),
    startedAt: DateTimeSchema,
    finishedAt: DateTimeSchema,
    durationMs: Type.Integer({ minimum: 0 }),
    retryCount: Type.Integer({ minimum: 0 }),
    status: AiRunStatusSchema,
    error: Type.Optional(Type.String()),
  },
  { $id: 'AiRun', additionalProperties: false },
);

export type AiAnalysis = Static<typeof AiAnalysisSchema>;
export type AiAnalysisProposal = Static<typeof AiAnalysisProposalSchema>;
export type AiPathAssessment = Static<typeof AiPathAssessmentSchema>;
export type AiPlan = Static<typeof AiPlanSchema>;
export type AiPlanProposal = Static<typeof AiPlanProposalSchema>;
export type AiProbeAudit = Static<typeof AiProbeAuditSchema>;
export type AiRun = Static<typeof AiRunSchema>;
export type AiServiceAssessment = Static<typeof AiServiceAssessmentSchema>;
export type AiServiceRole = Static<typeof AiServiceRoleSchema>;
export type ProbeAuditRecord = Static<typeof ProbeAuditRecordSchema>;
export type ProbeRequest = Static<typeof ProbeRequestSchema>;
export type ReportPlacement = Static<typeof ReportPlacementSchema>;
