import { Type, type Static } from '@sinclair/typebox';

import { ConfidenceSchema, DateTimeSchema, IdSchema, NonEmptyStringSchema } from './common.js';

export const DiscoveryRuntimeKindSchema = Type.Union([
  Type.Literal('java'),
  Type.Literal('go'),
  Type.Literal('rust'),
  Type.Literal('shell'),
  Type.Literal('container'),
  Type.Literal('binary'),
  Type.Literal('unknown'),
]);

export type DiscoveryRuntimeKind = Static<typeof DiscoveryRuntimeKindSchema>;

export const DiscoveryCandidateSourceSchema = Type.Union([
  Type.Literal('service'),
  Type.Literal('process'),
  Type.Literal('systemd_unit'),
  Type.Literal('socket'),
  Type.Literal('container'),
  Type.Literal('compose'),
  Type.Literal('path'),
  Type.Literal('mixed'),
]);

export const DiscoveryCandidateSchema = Type.Object(
  {
    candidateId: IdSchema,
    displayName: NonEmptyStringSchema,
    sourceKind: DiscoveryCandidateSourceSchema,
    sourceIds: Type.Array(IdSchema),
    mergeRule: NonEmptyStringSchema,
    evidenceIds: Type.Array(IdSchema),
    runtimeKind: DiscoveryRuntimeKindSchema,
    confidence: ConfidenceSchema,
    serviceId: Type.Optional(IdSchema),
    signals: Type.Array(NonEmptyStringSchema),
    unknowns: Type.Array(NonEmptyStringSchema),
  },
  { additionalProperties: false },
);

export type DiscoveryCandidate = Static<typeof DiscoveryCandidateSchema>;

export const EvidenceIndexSchema = Type.Object(
  {
    indexId: IdSchema,
    sourceSnapshotId: IdSchema,
    generatedAt: DateTimeSchema,
    processIdsByPid: Type.Record(Type.String(), IdSchema),
    processIdsByParentPid: Type.Record(Type.String(), Type.Array(IdSchema)),
    processIdsByCgroup: Type.Record(Type.String(), Type.Array(IdSchema)),
    unitIdsByName: Type.Record(Type.String(), IdSchema),
    socketIdsByPort: Type.Record(Type.String(), Type.Array(IdSchema)),
    containerIdsByImage: Type.Record(Type.String(), Type.Array(IdSchema)),
    composeIdsByLabel: Type.Record(Type.String(), Type.Array(IdSchema)),
    pathSeedIdsByPath: Type.Record(Type.String(), IdSchema),
    candidates: Type.Array(DiscoveryCandidateSchema),
  },
  { $id: 'EvidenceIndex', additionalProperties: false },
);

export type EvidenceIndex = Static<typeof EvidenceIndexSchema>;

export const PathInvestigationKindSchema = Type.Union([
  Type.Literal('directory_metadata'),
  Type.Literal('directory_listing'),
  Type.Literal('config_summary'),
  Type.Literal('path_search'),
]);

export type PathInvestigationKind = Static<typeof PathInvestigationKindSchema>;

export const PathInvestigationStatusSchema = Type.Union([
  Type.Literal('accepted'),
  Type.Literal('rejected'),
]);

export const PathInvestigationSeedSchema = Type.Object(
  {
    seedId: IdSchema,
    status: PathInvestigationStatusSchema,
    kind: PathInvestigationKindSchema,
    targetServiceId: Type.Optional(IdSchema),
    path: Type.Optional(NonEmptyStringSchema),
    searchRoot: Type.Optional(NonEmptyStringSchema),
    searchTerm: Type.Optional(NonEmptyStringSchema),
    maxDepth: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })),
    maxMatches: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
    sourceIds: Type.Array(IdSchema),
    evidenceIds: Type.Array(IdSchema),
    reason: NonEmptyStringSchema,
  },
  { $id: 'PathInvestigationSeed', additionalProperties: false },
);

export type PathInvestigationSeed = Static<typeof PathInvestigationSeedSchema>;
