import { Type, type Static } from '@sinclair/typebox';

import { DateTimeSchema, NonEmptyStringSchema } from './common.js';

export const RedactionModeSchema = Type.Union([
  Type.Literal('persistence'),
  Type.Literal('ai'),
  Type.Literal('report'),
  Type.Literal('audit'),
]);

export const RedactionRuleHitSchema = Type.Object(
  {
    count: Type.Integer({ minimum: 1 }),
    ruleId: NonEmptyStringSchema,
  },
  { additionalProperties: false },
);

export const RedactionReportSchema = Type.Object(
  {
    generatedAt: DateTimeSchema,
    mode: RedactionModeSchema,
    passes: Type.Integer({ minimum: 1, maximum: 2 }),
    rulesVersion: NonEmptyStringSchema,
    totalMatches: Type.Integer({ minimum: 0 }),
    ruleHits: Type.Array(RedactionRuleHitSchema),
    sensitivityCounts: Type.Object(
      {
        internal: Type.Integer({ minimum: 0 }),
        public: Type.Integer({ minimum: 0 }),
        secret: Type.Integer({ minimum: 0 }),
        sensitive: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
    secretScanPassed: Type.Boolean(),
  },
  { additionalProperties: false },
);

export type RedactionMode = Static<typeof RedactionModeSchema>;
export type RedactionReport = Static<typeof RedactionReportSchema>;
