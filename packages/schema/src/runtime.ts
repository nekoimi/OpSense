import { Type, type Static } from '@sinclair/typebox';

import { DateTimeSchema, IdSchema, NonEmptyStringSchema } from './common.js';

export const ProcessRecordSchema = Type.Object(
  {
    id: IdSchema,
    pid: Type.Integer({ minimum: 1 }),
    parentPid: Type.Optional(Type.Integer({ minimum: 0 })),
    userId: Type.Optional(Type.Integer({ minimum: 0 })),
    userName: Type.Optional(Type.String()),
    command: NonEmptyStringSchema,
    arguments: Type.Array(Type.String()),
    executablePath: Type.Optional(Type.String()),
    workingDirectory: Type.Optional(Type.String()),
    startedAt: Type.Optional(DateTimeSchema),
    cgroup: Type.Optional(Type.String()),
    containerId: Type.Optional(Type.String()),
    evidenceIds: Type.Array(IdSchema),
  },
  { additionalProperties: false },
);

export type ProcessRecord = Static<typeof ProcessRecordSchema>;

export const SocketRecordSchema = Type.Object(
  {
    id: IdSchema,
    protocol: Type.Union([Type.Literal('tcp'), Type.Literal('udp')]),
    family: Type.Union([Type.Literal('ipv4'), Type.Literal('ipv6')]),
    localAddress: NonEmptyStringSchema,
    localPort: Type.Integer({ minimum: 0, maximum: 65535 }),
    listening: Type.Boolean(),
    exposed: Type.Boolean(),
    processIds: Type.Array(Type.Integer({ minimum: 1 })),
    processNames: Type.Array(Type.String()),
    containerIds: Type.Array(IdSchema),
    evidenceIds: Type.Array(IdSchema),
  },
  { additionalProperties: false },
);

export type SocketRecord = Static<typeof SocketRecordSchema>;

export const SystemdUnitRecordSchema = Type.Object(
  {
    id: IdSchema,
    name: NonEmptyStringSchema,
    description: Type.Optional(Type.String()),
    loadState: Type.Optional(Type.String()),
    activeState: Type.Optional(Type.String()),
    subState: Type.Optional(Type.String()),
    enabledState: Type.Optional(Type.String()),
    mainPid: Type.Optional(Type.Integer({ minimum: 0 })),
    fragmentPath: Type.Optional(Type.String()),
    workingDirectory: Type.Optional(Type.String()),
    execStart: Type.Array(Type.String()),
    execReload: Type.Array(Type.String()),
    environmentFiles: Type.Array(Type.String()),
    user: Type.Optional(Type.String()),
    group: Type.Optional(Type.String()),
    evidenceIds: Type.Array(IdSchema),
  },
  { additionalProperties: false },
);

export type SystemdUnitRecord = Static<typeof SystemdUnitRecordSchema>;
