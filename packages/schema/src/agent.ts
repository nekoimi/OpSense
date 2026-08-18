import { Type, type Static } from '@sinclair/typebox';

import { AiConfidenceSchema, DateTimeSchema, IdSchema, NonEmptyStringSchema } from './common.js';
import {
  AiPathSemanticSchema,
  AiServiceImportanceSchema,
  AiServiceRoleSchema,
  ProbeRequestSchema,
  ReportPlacementSchema,
} from './ai.js';
import {
  DiscoveredServiceSchema,
  DiscoveryFilterGroupSchema,
  DiscoveryInvestigationSchema,
} from './projection.js';
import { WikiNarrativeDraftSchema } from './wiki.js';

export const AgentContextSectionSchema = Type.Union([
  Type.Literal('host'),
  Type.Literal('storage'),
  Type.Literal('network'),
  Type.Literal('services'),
  Type.Literal('processes'),
  Type.Literal('containers'),
  Type.Literal('systemd_units'),
  Type.Literal('systemd_summary'),
  Type.Literal('path_candidates'),
  Type.Literal('findings'),
  Type.Literal('visibility_summary'),
  Type.Literal('discovery'),
  Type.Literal('wiki_source'),
]);

export const ReadContextArgumentsSchema = Type.Object(
  {
    section: AgentContextSectionSchema,
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 12 })),
  },
  { additionalProperties: false },
);

export const ReadEvidenceArgumentsSchema = Type.Object(
  {
    ids: Type.Optional(Type.Array(IdSchema, { minItems: 1, maxItems: 20 })),
    serviceId: Type.Optional(IdSchema),
    field: Type.Optional(NonEmptyStringSchema),
  },
  { additionalProperties: false, minProperties: 1 },
);

export const ListCandidatesArgumentsSchema = Type.Object(
  {
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
  },
  { additionalProperties: false },
);

export const ExecuteGovernedProbeArgumentsSchema = Type.Union([
  Type.Object({ request: ProbeRequestSchema }, { additionalProperties: false }),
  Type.Object(
    { requests: Type.Array(ProbeRequestSchema, { minItems: 1, maxItems: 4 }) },
    { additionalProperties: false },
  ),
]);

export const PlanDiscoveryArgumentsSchema = Type.Object(
  {
    planningCompleted: Type.Boolean(),
    discoveryCompleted: Type.Boolean(),
    investigations: Type.Array(DiscoveryInvestigationSchema),
    discoveredServices: Type.Array(DiscoveredServiceSchema),
    filteredGroups: Type.Array(DiscoveryFilterGroupSchema),
    unresolvedQuestions: Type.Array(Type.String()),
    reason: NonEmptyStringSchema,
  },
  { additionalProperties: false },
);

export type PlanDiscoveryArguments = Static<typeof PlanDiscoveryArgumentsSchema>;

export const ServiceAssessmentUpdateSchema = Type.Object(
  {
    serviceId: IdSchema,
    role: AiServiceRoleSchema,
    reportPlacement: ReportPlacementSchema,
    importance: AiServiceImportanceSchema,
    purpose: Type.Optional(Type.String()),
    statusInterpretation: Type.Optional(Type.String()),
    reason: NonEmptyStringSchema,
    confidence: AiConfidenceSchema,
    evidenceIds: Type.Array(IdSchema),
    unknowns: Type.Array(Type.String()),
    reviewItems: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);

export type ServiceAssessmentUpdate = Static<typeof ServiceAssessmentUpdateSchema>;

export const PathAssessmentUpdateSchema = Type.Object(
  {
    serviceId: IdSchema,
    path: NonEmptyStringSchema,
    semantic: AiPathSemanticSchema,
    reason: NonEmptyStringSchema,
    confidence: AiConfidenceSchema,
    evidenceIds: Type.Array(IdSchema),
  },
  { additionalProperties: false },
);

export type PathAssessmentUpdate = Static<typeof PathAssessmentUpdateSchema>;

const ProjectionChangeShared = {
  objectId: IdSchema,
  operation: Type.Union([Type.Literal('add'), Type.Literal('update')]),
  summary: NonEmptyStringSchema,
};

export const ProjectionChangeSchema = Type.Union([
  Type.Object(
    {
      ...ProjectionChangeShared,
      changeType: Type.Literal('service_assessment'),
      assessment: ServiceAssessmentUpdateSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...ProjectionChangeShared,
      changeType: Type.Literal('path_assessment'),
      assessment: PathAssessmentUpdateSchema,
    },
    { additionalProperties: false },
  ),
]);

export type ProjectionChange = Static<typeof ProjectionChangeSchema>;

export const UpdateProjectionArgumentsSchema = Type.Object(
  {
    changes: Type.Array(ProjectionChangeSchema, { minItems: 1 }),
    evidenceIds: Type.Array(IdSchema),
    reason: Type.Optional(NonEmptyStringSchema),
  },
  { additionalProperties: false },
);

export const ComposeWikiArgumentsSchema = WikiNarrativeDraftSchema;
export type ComposeWikiArguments = Static<typeof ComposeWikiArgumentsSchema>;

export const AgentToolNameSchema = Type.Union([
  Type.Literal('read_context'),
  Type.Literal('read_evidence'),
  Type.Literal('list_candidates'),
  Type.Literal('execute_governed_probe'),
  Type.Literal('plan_discovery'),
  Type.Literal('update_projection'),
  Type.Literal('compose_wiki'),
]);

export type AgentToolName = Static<typeof AgentToolNameSchema>;

export const AgentStageSchema = Type.Union([
  Type.Literal('created'),
  Type.Literal('bootstrapping'),
  Type.Literal('investigating'),
  Type.Literal('enriching'),
  Type.Literal('validating'),
  Type.Literal('composing'),
  Type.Literal('reviewing'),
  Type.Literal('completed'),
  Type.Literal('partial'),
  Type.Literal('failed'),
  Type.Literal('interrupted'),
]);

export type AgentStage = Static<typeof AgentStageSchema>;

export const AgentSessionStateSchema = Type.Union([
  Type.Literal('created'),
  Type.Literal('running'),
  Type.Literal('completed'),
  Type.Literal('partial'),
  Type.Literal('failed'),
  Type.Literal('interrupted'),
]);

export type AgentSessionState = Static<typeof AgentSessionStateSchema>;

export const AgentStopReasonSchema = Type.Union([
  Type.Literal('classification_complete'),
  Type.Literal('budget_exhausted'),
  Type.Literal('user_interrupted'),
  Type.Literal('codex_failed'),
  Type.Literal('quality_gate_failed'),
]);

export type AgentStopReason = Static<typeof AgentStopReasonSchema>;

export const AgentToolActivityStatusSchema = Type.Union([
  Type.Literal('requested'),
  Type.Literal('accepted'),
  Type.Literal('rejected'),
  Type.Literal('completed'),
  Type.Literal('failed'),
]);

export const AgentToolActivitySchema = Type.Object(
  {
    activityId: IdSchema,
    toolName: NonEmptyStringSchema,
    status: AgentToolActivityStatusSchema,
    startedAt: DateTimeSchema,
    finishedAt: Type.Optional(DateTimeSchema),
    argumentSummary: Type.Optional(Type.String()),
    resultSummary: Type.Optional(Type.String()),
    evidenceIds: Type.Array(IdSchema),
    error: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export type AgentToolActivity = Static<typeof AgentToolActivitySchema>;

export const ToolActivitySchema = AgentToolActivitySchema;
export type ToolActivity = AgentToolActivity;

export const ProbeBudgetSchema = Type.Object(
  {
    maxRounds: Type.Integer({ minimum: 0 }),
    maxRequests: Type.Integer({ minimum: 0 }),
    maxBytes: Type.Integer({ minimum: 0 }),
    maxDurationMs: Type.Integer({ minimum: 0 }),
    usedRounds: Type.Integer({ minimum: 0 }),
    usedRequests: Type.Integer({ minimum: 0 }),
    usedBytes: Type.Integer({ minimum: 0 }),
    usedDurationMs: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export type ProbeBudget = Static<typeof ProbeBudgetSchema>;

export const AgentHypothesisSchema = Type.Object(
  {
    hypothesisId: IdSchema,
    sessionId: IdSchema,
    statement: NonEmptyStringSchema,
    status: Type.Union([
      Type.Literal('proposed'),
      Type.Literal('confirmed'),
      Type.Literal('rejected'),
      Type.Literal('unresolved'),
    ]),
    confidence: Type.Number({ minimum: 0, maximum: 1 }),
    evidenceIds: Type.Array(IdSchema),
    createdAt: DateTimeSchema,
    updatedAt: DateTimeSchema,
  },
  { additionalProperties: false },
);

export type AgentHypothesis = Static<typeof AgentHypothesisSchema>;

const AgentDecisionShared = {
  decisionId: IdSchema,
  turnId: IdSchema,
  reason: NonEmptyStringSchema,
  nextAction: NonEmptyStringSchema,
  unresolvedQuestions: Type.Array(Type.String()),
  nextSuggestions: Type.Array(Type.String()),
};

export const AgentDecisionSchema = Type.Union([
  Type.Object(
    {
      ...AgentDecisionShared,
      kind: Type.Literal('tool_call'),
      toolName: Type.Literal('read_context'),
      arguments: ReadContextArgumentsSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...AgentDecisionShared,
      kind: Type.Literal('tool_call'),
      toolName: Type.Literal('read_evidence'),
      arguments: ReadEvidenceArgumentsSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...AgentDecisionShared,
      kind: Type.Literal('tool_call'),
      toolName: Type.Literal('list_candidates'),
      arguments: ListCandidatesArgumentsSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...AgentDecisionShared,
      kind: Type.Literal('tool_call'),
      toolName: Type.Literal('execute_governed_probe'),
      arguments: ExecuteGovernedProbeArgumentsSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...AgentDecisionShared,
      kind: Type.Literal('tool_call'),
      toolName: Type.Literal('plan_discovery'),
      arguments: PlanDiscoveryArgumentsSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...AgentDecisionShared,
      kind: Type.Literal('tool_call'),
      toolName: Type.Literal('update_projection'),
      arguments: UpdateProjectionArgumentsSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...AgentDecisionShared,
      kind: Type.Literal('tool_call'),
      toolName: Type.Literal('compose_wiki'),
      arguments: ComposeWikiArgumentsSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...AgentDecisionShared,
      kind: Type.Literal('projection_update'),
      changes: Type.Array(ProjectionChangeSchema),
      evidenceIds: Type.Array(IdSchema),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...AgentDecisionShared,
      kind: Type.Literal('final'),
      inventoryProjectionId: IdSchema,
      serviceWikiProjectionId: IdSchema,
      findingIds: Type.Array(IdSchema),
      qualitySummary: NonEmptyStringSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...AgentDecisionShared,
      kind: Type.Literal('failed'),
      error: NonEmptyStringSchema,
    },
    { additionalProperties: false },
  ),
]);

export type AgentDecision = Static<typeof AgentDecisionSchema>;

export const AgentResponseSchema = Type.Object(
  {
    responseId: IdSchema,
    sessionId: IdSchema,
    turnId: IdSchema,
    message: NonEmptyStringSchema,
    observations: Type.Array(Type.String()),
    toolActivity: Type.Array(AgentToolActivitySchema),
    evidenceReferences: Type.Array(IdSchema),
    updatedEntities: Type.Array(IdSchema),
    unresolvedQuestions: Type.Array(Type.String()),
    wikiArtifacts: Type.Array(Type.String()),
    nextSuggestions: Type.Array(Type.String()),
    nextAction: NonEmptyStringSchema,
  },
  { additionalProperties: false },
);

export type AgentResponse = Static<typeof AgentResponseSchema>;

export const AgentTurnSchema = Type.Object(
  {
    turnId: IdSchema,
    sessionId: IdSchema,
    threadId: Type.Optional(NonEmptyStringSchema),
    sequence: Type.Integer({ minimum: 1 }),
    startedAt: DateTimeSchema,
    finishedAt: Type.Optional(DateTimeSchema),
    inputContextHash: NonEmptyStringSchema,
    userMessage: NonEmptyStringSchema,
    decisionKind: Type.Union([
      Type.Literal('tool_call'),
      Type.Literal('projection_update'),
      Type.Literal('final'),
      Type.Literal('failed'),
    ]),
    toolCalls: Type.Array(AgentToolActivitySchema),
    evidenceAdded: Type.Array(IdSchema),
    projectionChanges: Type.Array(IdSchema),
    responseId: Type.Optional(IdSchema),
    tokenUsage: Type.Optional(Type.Integer({ minimum: 0 })),
    error: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export type AgentTurn = Static<typeof AgentTurnSchema>;

export const TranscriptEntrySchema = Type.Object(
  {
    entryId: IdSchema,
    sessionId: IdSchema,
    sequence: Type.Integer({ minimum: 1 }),
    at: DateTimeSchema,
    kind: Type.Union([Type.Literal('user'), Type.Literal('agent'), Type.Literal('command')]),
    text: NonEmptyStringSchema,
    responseId: Type.Optional(IdSchema),
  },
  { additionalProperties: false },
);

export type TranscriptEntry = Static<typeof TranscriptEntrySchema>;

export const AgentSessionSchema = Type.Object(
  {
    sessionId: IdSchema,
    scanId: IdSchema,
    provider: Type.Literal('codex'),
    workflowVersion: Type.Optional(
      Type.Union([Type.Literal('m19_full_candidate_review'), Type.Literal('m20_evidence_driven')]),
    ),
    model: Type.Optional(Type.String()),
    threadId: Type.Optional(NonEmptyStringSchema),
    state: AgentSessionStateSchema,
    currentStage: AgentStageSchema,
    startedAt: DateTimeSchema,
    updatedAt: DateTimeSchema,
    finishedAt: Type.Optional(DateTimeSchema),
    turnCount: Type.Integer({ minimum: 0 }),
    probeRound: Type.Integer({ minimum: 0 }),
    completedProbeRequestIds: Type.Array(IdSchema),
    budgets: ProbeBudgetSchema,
    coverage: Type.Record(Type.String(), Type.Number({ minimum: 0, maximum: 1 })),
    unresolvedQuestions: Type.Array(Type.String()),
    lastError: Type.Optional(Type.String()),
    repairSuggestions: Type.Array(Type.String()),
    outputFiles: Type.Array(Type.String()),
    candidateIndexCoverage: Type.Optional(
      Type.Object(
        {
          total: Type.Integer({ minimum: 0 }),
          nextOffset: Type.Integer({ minimum: 0 }),
          complete: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
    ),
    stopReason: Type.Optional(AgentStopReasonSchema),
  },
  { $id: 'AgentSession', additionalProperties: false },
);

export type AgentSession = Static<typeof AgentSessionSchema>;
