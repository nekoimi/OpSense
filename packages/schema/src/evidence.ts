import { Type, type Static } from '@sinclair/typebox';

import {
  CollectionStatusSchema,
  ConfidenceSchema,
  DateTimeSchema,
  IdSchema,
  NonEmptyStringSchema,
  SensitivitySchema,
} from './common.js';

export const EvidenceKindSchema = Type.Union([
  Type.Literal('command_output'),
  Type.Literal('file_metadata'),
  Type.Literal('config_value'),
  Type.Literal('runtime_state'),
  Type.Literal('derived'),
]);

export const EvidenceRecordSchema = Type.Object(
  {
    id: IdSchema,
    kind: EvidenceKindSchema,
    source: NonEmptyStringSchema,
    field: Type.Optional(NonEmptyStringSchema),
    value: Type.Optional(Type.Unknown()),
    collectedAt: DateTimeSchema,
    opsenseVersion: NonEmptyStringSchema,
    parserVersion: Type.Optional(NonEmptyStringSchema),
    commandId: Type.Optional(NonEmptyStringSchema),
    status: CollectionStatusSchema,
    sensitivity: SensitivitySchema,
    errorCode: Type.Optional(NonEmptyStringSchema),
    message: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export type EvidenceRecord = Static<typeof EvidenceRecordSchema>;

export const PathSeedSourceSchema = Type.Object(
  {
    sourceType: NonEmptyStringSchema,
    sourceId: NonEmptyStringSchema,
    evidenceIds: Type.Array(IdSchema),
  },
  { additionalProperties: false },
);

export const PathSeedRecordSchema = Type.Object(
  {
    id: IdSchema,
    path: NonEmptyStringSchema,
    confidence: ConfidenceSchema,
    sources: Type.Array(PathSeedSourceSchema, { minItems: 1 }),
  },
  { additionalProperties: false },
);

export type PathSeedRecord = Static<typeof PathSeedRecordSchema>;

export const ArtifactKindSchema = Type.Union([
  Type.Literal('directory'),
  Type.Literal('config'),
  Type.Literal('environment'),
  Type.Literal('executable'),
  Type.Literal('script'),
  Type.Literal('log'),
  Type.Literal('data'),
  Type.Literal('backup'),
  Type.Literal('compose'),
  Type.Literal('other'),
]);

export const ArtifactRecordSchema = Type.Object(
  {
    id: IdSchema,
    path: NonEmptyStringSchema,
    kind: ArtifactKindSchema,
    fileType: Type.Optional(
      Type.Union([
        Type.Literal('file'),
        Type.Literal('directory'),
        Type.Literal('symlink'),
        Type.Literal('other'),
      ]),
    ),
    exists: Type.Boolean(),
    sizeBytes: Type.Optional(Type.Integer({ minimum: 0 })),
    mode: Type.Optional(Type.String()),
    owner: Type.Optional(Type.String()),
    group: Type.Optional(Type.String()),
    modifiedAt: Type.Optional(DateTimeSchema),
    linkTarget: Type.Optional(Type.String()),
    confidence: ConfidenceSchema,
    evidenceIds: Type.Array(IdSchema),
  },
  { additionalProperties: false },
);

export type ArtifactRecord = Static<typeof ArtifactRecordSchema>;

export const FindingSeveritySchema = Type.Union([
  Type.Literal('info'),
  Type.Literal('low'),
  Type.Literal('medium'),
  Type.Literal('high'),
  Type.Literal('critical'),
]);

export const FindingRecordSchema = Type.Object(
  {
    id: IdSchema,
    severity: FindingSeveritySchema,
    category: NonEmptyStringSchema,
    title: NonEmptyStringSchema,
    description: NonEmptyStringSchema,
    confidence: ConfidenceSchema,
    evidenceIds: Type.Array(IdSchema),
  },
  { additionalProperties: false },
);

export type FindingRecord = Static<typeof FindingRecordSchema>;
