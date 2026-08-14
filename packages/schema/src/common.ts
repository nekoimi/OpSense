import { Type, type Static } from '@sinclair/typebox';

export const SCHEMA_VERSION = '1.0.0';

export const DateTimeSchema = Type.String({ format: 'date-time' });
export const NonEmptyStringSchema = Type.String({ minLength: 1 });
export const IdSchema = Type.String({ minLength: 1, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]*$' });

export const ConfidenceSchema = Type.Union([
  Type.Literal('confirmed'),
  Type.Literal('inferred'),
  Type.Literal('unknown'),
  Type.Literal('conflict'),
]);

export type Confidence = Static<typeof ConfidenceSchema>;

export const AiConfidenceSchema = Type.Union([
  Type.Literal('inferred'),
  Type.Literal('unknown'),
  Type.Literal('conflict'),
]);

export type AiConfidence = Static<typeof AiConfidenceSchema>;

export const SensitivitySchema = Type.Union([
  Type.Literal('public'),
  Type.Literal('internal'),
  Type.Literal('sensitive'),
  Type.Literal('secret'),
]);

export type Sensitivity = Static<typeof SensitivitySchema>;

export const CollectionStatusSchema = Type.Union([
  Type.Literal('success'),
  Type.Literal('not_found'),
  Type.Literal('permission_denied'),
  Type.Literal('command_missing'),
  Type.Literal('timeout'),
  Type.Literal('failed'),
  Type.Literal('truncated'),
]);

export type CollectionStatus = Static<typeof CollectionStatusSchema>;

export const ScanStageSchema = Type.Union([
  Type.Literal('created'),
  Type.Literal('connecting'),
  Type.Literal('collecting'),
  Type.Literal('normalizing'),
  Type.Literal('redacting'),
  Type.Literal('planning'),
  Type.Literal('enriching'),
  Type.Literal('analyzing'),
  Type.Literal('rendering'),
]);

export type ScanStage = Static<typeof ScanStageSchema>;

export const ScanStateSchema = Type.Union([
  ...ScanStageSchema.anyOf,
  Type.Literal('completed'),
  Type.Literal('partial'),
  Type.Literal('failed'),
]);

export type ScanState = Static<typeof ScanStateSchema>;

export const StringMapSchema = Type.Record(Type.String(), Type.String());
