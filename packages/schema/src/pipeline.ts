import { Type, type Static } from '@sinclair/typebox';

import { DateTimeSchema, IdSchema, NonEmptyStringSchema } from './common.js';

export const PIPELINE_SCHEMA_VERSION = '3.0' as const;
export const PIPELINE_WORKFLOW_VERSION = 'v3_pipeline' as const;

export const PipelineProfileSchema = Type.Union([
  Type.Literal('fast'),
  Type.Literal('standard'),
  Type.Literal('deep'),
]);

export type PipelineProfile = Static<typeof PipelineProfileSchema>;

export const PipelineStageSchema = Type.Union([
  Type.Literal('created'),
  Type.Literal('preflighting'),
  Type.Literal('collecting_baseline'),
  Type.Literal('correlating'),
  Type.Literal('inventory_ready'),
  Type.Literal('discovering'),
  Type.Literal('probing'),
  Type.Literal('reconciling'),
  Type.Literal('composing'),
  Type.Literal('reporting'),
]);

export type PipelineStage = Static<typeof PipelineStageSchema>;

export const PipelineStateSchema = Type.Union([
  Type.Literal('created'),
  Type.Literal('running'),
  Type.Literal('inventory_ready'),
  Type.Literal('completed'),
  Type.Literal('partial'),
  Type.Literal('failed'),
  Type.Literal('interrupted'),
]);

export type PipelineState = Static<typeof PipelineStateSchema>;

export const PipelineBudgetsSchema = Type.Object(
  {
    maxAiCalls: Type.Integer({ minimum: 0 }),
    maxProbeRequests: Type.Integer({ minimum: 0 }),
    maxProbeRounds: Type.Integer({ minimum: 0 }),
    maxSessionDurationMs: Type.Integer({ minimum: 1 }),
    maxSessionTokens: Type.Integer({ minimum: 0 }),
    maxSessionTurns: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export type PipelineBudgets = Static<typeof PipelineBudgetsSchema>;

export const PipelineTargetSchema = Type.Object(
  {
    host: NonEmptyStringSchema,
    port: Type.Integer({ minimum: 1, maximum: 65_535 }),
    user: Type.Optional(NonEmptyStringSchema),
  },
  { additionalProperties: false },
);

export const PipelineStageCheckpointSchema = Type.Object(
  {
    finishedAt: DateTimeSchema,
    outputHash: Type.Optional(NonEmptyStringSchema),
    sourceHash: Type.Optional(NonEmptyStringSchema),
    stage: PipelineStageSchema,
  },
  { additionalProperties: false },
);

export const StructuredFailureSchema = Type.Object(
  {
    code: NonEmptyStringSchema,
    message: NonEmptyStringSchema,
    retryable: Type.Boolean(),
    stage: PipelineStageSchema,
  },
  { additionalProperties: false },
);

export const PipelineRunSchema = Type.Object(
  {
    budgets: PipelineBudgetsSchema,
    completedStages: Type.Array(PipelineStageCheckpointSchema),
    currentStage: PipelineStageSchema,
    finishedAt: Type.Optional(DateTimeSchema),
    lastError: Type.Optional(StructuredFailureSchema),
    outputFiles: Type.Array(NonEmptyStringSchema),
    profile: PipelineProfileSchema,
    runId: IdSchema,
    schemaVersion: Type.Literal(PIPELINE_SCHEMA_VERSION),
    startedAt: DateTimeSchema,
    state: PipelineStateSchema,
    target: PipelineTargetSchema,
    updatedAt: DateTimeSchema,
    workflowVersion: Type.Literal(PIPELINE_WORKFLOW_VERSION),
  },
  { $id: 'PipelineRunV3', additionalProperties: false },
);

export type PipelineRun = Static<typeof PipelineRunSchema>;

export const MetricStatusCountsSchema = Type.Object(
  {
    cancelled: Type.Integer({ minimum: 0 }),
    commandMissing: Type.Integer({ minimum: 0 }),
    failed: Type.Integer({ minimum: 0 }),
    permissionDenied: Type.Integer({ minimum: 0 }),
    success: Type.Integer({ minimum: 0 }),
    timeout: Type.Integer({ minimum: 0 }),
    truncated: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const CommandMetricSchema = Type.Object(
  {
    count: Type.Integer({ minimum: 0 }),
    durationMs: Type.Integer({ minimum: 0 }),
    maxDurationMs: Type.Integer({ minimum: 0 }),
    stderrBytes: Type.Integer({ minimum: 0 }),
    stdoutBytes: Type.Integer({ minimum: 0 }),
    statuses: MetricStatusCountsSchema,
  },
  { additionalProperties: false },
);

export type CommandMetric = Static<typeof CommandMetricSchema>;

export const StageMetricSchema = Type.Object(
  {
    durationMs: Type.Integer({ minimum: 0 }),
    finishedAt: DateTimeSchema,
    stage: PipelineStageSchema,
    startedAt: DateTimeSchema,
    status: Type.Union([
      Type.Literal('completed'),
      Type.Literal('failed'),
      Type.Literal('interrupted'),
    ]),
  },
  { additionalProperties: false },
);

export type StageMetric = Static<typeof StageMetricSchema>;

const CounterSchema = Type.Integer({ minimum: 0 });

export const RunMetricsSchema = Type.Object(
  {
    ai: Type.Object(
      {
        calls: CounterSchema,
        cachedInputTokens: CounterSchema,
        durationMs: CounterSchema,
        failedCalls: CounterSchema,
        inputTokens: CounterSchema,
        outputTokens: CounterSchema,
        reasoningTokens: CounterSchema,
        repairs: CounterSchema,
      },
      { additionalProperties: false },
    ),
    discovery: Type.Object(
      {
        candidateCount: CounterSchema,
        filteredGroupCount: CounterSchema,
        finalServiceCount: CounterSchema,
        protectedCandidateCount: CounterSchema,
        rawObjectCount: CounterSchema,
      },
      { additionalProperties: false },
    ),
    generatedAt: DateTimeSchema,
    probes: Type.Object(
      {
        accepted: CounterSchema,
        deduplicated: CounterSchema,
        failed: CounterSchema,
        rejected: CounterSchema,
        requested: CounterSchema,
        resolvedFields: CounterSchema,
        rounds: CounterSchema,
      },
      { additionalProperties: false },
    ),
    report: Type.Object(
      {
        durationMs: CounterSchema,
        generatedFiles: CounterSchema,
        qualityGateFailures: CounterSchema,
      },
      { additionalProperties: false },
    ),
    runId: IdSchema,
    schemaVersion: Type.Literal(PIPELINE_SCHEMA_VERSION),
    ssh: Type.Object(
      {
        byCommandId: Type.Record(Type.String({ minLength: 1 }), CommandMetricSchema),
        cacheHits: CounterSchema,
        commandCount: CounterSchema,
        executionDurationMs: CounterSchema,
        queuedDurationMs: CounterSchema,
      },
      { additionalProperties: false },
    ),
    stages: Type.Array(StageMetricSchema),
  },
  { $id: 'RunMetricsV3', additionalProperties: false },
);

export type RunMetrics = Static<typeof RunMetricsSchema>;
