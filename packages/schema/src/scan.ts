import { Type, type Static } from '@sinclair/typebox';

import { AiAnalysisSchema } from './ai.js';
import {
  SCHEMA_VERSION,
  DateTimeSchema,
  IdSchema,
  ScanStageSchema,
  ScanStateSchema,
} from './common.js';
import { ComposeProjectRecordSchema, ContainerRecordSchema } from './container.js';
import { ArtifactRecordSchema, EvidenceRecordSchema, FindingRecordSchema } from './evidence.js';
import { HostSnapshotSchema } from './host.js';
import { NetworkSnapshotSchema } from './network.js';
import { ProcessRecordSchema, SocketRecordSchema, SystemdUnitRecordSchema } from './runtime.js';
import { ServiceRecordSchema } from './service.js';
import { StorageSnapshotSchema } from './storage.js';

export const PermissionLevelSchema = Type.Union([
  Type.Literal('unprivileged'),
  Type.Literal('partial_privileged'),
  Type.Literal('privileged'),
  Type.Literal('unknown'),
]);

export const ScanTargetSchema = Type.Object(
  {
    host: Type.String({ minLength: 1 }),
    port: Type.Integer({ minimum: 1, maximum: 65535 }),
    user: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

export const ScanSessionSchema = Type.Object(
  {
    id: IdSchema,
    schemaVersion: Type.Literal(SCHEMA_VERSION),
    opsenseVersion: Type.String({ minLength: 1 }),
    rulesVersion: Type.String({ minLength: 1 }),
    target: ScanTargetSchema,
    state: ScanStateSchema,
    currentStage: Type.Optional(ScanStageSchema),
    permissionLevel: PermissionLevelSchema,
    startedAt: DateTimeSchema,
    finishedAt: Type.Optional(DateTimeSchema),
    configSummary: Type.Record(Type.String(), Type.Unknown()),
  },
  { additionalProperties: false },
);

export type ScanSession = Static<typeof ScanSessionSchema>;

export const ScanSnapshotSchema = Type.Object(
  {
    session: ScanSessionSchema,
    host: Type.Optional(HostSnapshotSchema),
    storage: Type.Optional(StorageSnapshotSchema),
    network: Type.Optional(NetworkSnapshotSchema),
    processes: Type.Array(ProcessRecordSchema),
    sockets: Type.Array(SocketRecordSchema),
    systemdUnits: Type.Array(SystemdUnitRecordSchema),
    containers: Type.Array(ContainerRecordSchema),
    composeProjects: Type.Array(ComposeProjectRecordSchema),
    artifacts: Type.Array(ArtifactRecordSchema),
    services: Type.Array(ServiceRecordSchema),
    evidence: Type.Array(EvidenceRecordSchema),
    findings: Type.Array(FindingRecordSchema),
    unknowns: Type.Array(Type.String()),
    aiAnalysis: Type.Optional(AiAnalysisSchema),
  },
  { $id: 'ScanSnapshot', additionalProperties: false },
);

export type ScanSnapshot = Static<typeof ScanSnapshotSchema>;
