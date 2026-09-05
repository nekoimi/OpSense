import { Type, type Static } from '@sinclair/typebox';

import { IdSchema, NonEmptyStringSchema } from './common.js';

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
  { ...ProbeCommon, kind: Type.Literal('directory_metadata'), path: NonEmptyStringSchema },
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
  { ...ProbeCommon, kind: Type.Literal('config_summary'), path: NonEmptyStringSchema },
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

export const SystemdUnitProbeRequestSchema = Type.Object(
  { ...ProbeCommon, kind: Type.Literal('systemd_unit'), unitName: NonEmptyStringSchema },
  { additionalProperties: false },
);

export const ProcessRuntimeProbeRequestSchema = Type.Object(
  {
    ...ProbeCommon,
    kind: Type.Literal('process_runtime'),
    pid: Type.Integer({ minimum: 1, maximum: 4_194_304 }),
  },
  { additionalProperties: false },
);

export const ProcessCgroupProbeRequestSchema = Type.Object(
  {
    ...ProbeCommon,
    kind: Type.Literal('process_cgroup'),
    pid: Type.Integer({ minimum: 1, maximum: 4_194_304 }),
  },
  { additionalProperties: false },
);

export const SocketOwnershipProbeRequestSchema = Type.Object(
  { ...ProbeCommon, kind: Type.Literal('socket_ownership'), socketId: IdSchema },
  { additionalProperties: false },
);

export const ContainerInspectProbeRequestSchema = Type.Object(
  { ...ProbeCommon, kind: Type.Literal('container_inspect'), containerId: IdSchema },
  { additionalProperties: false },
);

export const ComposeMetadataProbeRequestSchema = Type.Object(
  { ...ProbeCommon, kind: Type.Literal('compose_metadata'), composeProjectId: IdSchema },
  { additionalProperties: false },
);

export const LogMetadataProbeRequestSchema = Type.Object(
  { ...ProbeCommon, kind: Type.Literal('log_metadata'), path: NonEmptyStringSchema },
  { additionalProperties: false },
);

export const ProbeRequestSchema = Type.Union([
  DirectoryMetadataProbeRequestSchema,
  DirectoryListingProbeRequestSchema,
  ConfigSummaryProbeRequestSchema,
  PathSearchProbeRequestSchema,
  SystemdUnitProbeRequestSchema,
  ProcessRuntimeProbeRequestSchema,
  ProcessCgroupProbeRequestSchema,
  SocketOwnershipProbeRequestSchema,
  ContainerInspectProbeRequestSchema,
  ComposeMetadataProbeRequestSchema,
  LogMetadataProbeRequestSchema,
]);

export type ProbeRequest = Static<typeof ProbeRequestSchema>;
