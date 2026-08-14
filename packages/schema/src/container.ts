import { Type, type Static } from '@sinclair/typebox';

import { DateTimeSchema, IdSchema, NonEmptyStringSchema, StringMapSchema } from './common.js';

export const ContainerMountSchema = Type.Object(
  {
    type: Type.Union([Type.Literal('bind'), Type.Literal('volume'), Type.Literal('tmpfs')]),
    source: Type.Optional(Type.String()),
    destination: NonEmptyStringSchema,
    readOnly: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const ContainerPortMappingSchema = Type.Object(
  {
    protocol: Type.Union([Type.Literal('tcp'), Type.Literal('udp')]),
    containerPort: Type.Integer({ minimum: 0, maximum: 65535 }),
    hostAddress: Type.Optional(Type.String()),
    hostPort: Type.Optional(Type.Integer({ minimum: 0, maximum: 65535 })),
  },
  { additionalProperties: false },
);

export const ContainerRecordSchema = Type.Object(
  {
    id: IdSchema,
    runtime: Type.Literal('docker'),
    name: NonEmptyStringSchema,
    image: NonEmptyStringSchema,
    imageId: Type.Optional(Type.String()),
    state: NonEmptyStringSchema,
    startedAt: Type.Optional(DateTimeSchema),
    restartPolicy: Type.Optional(Type.String()),
    healthStatus: Type.Optional(Type.String()),
    processId: Type.Optional(Type.Integer({ minimum: 0 })),
    networks: Type.Array(Type.String()),
    mounts: Type.Array(ContainerMountSchema),
    ports: Type.Array(ContainerPortMappingSchema),
    environmentKeys: Type.Array(Type.String()),
    labels: StringMapSchema,
    evidenceIds: Type.Array(IdSchema),
  },
  { additionalProperties: false },
);

export type ContainerRecord = Static<typeof ContainerRecordSchema>;

export const ComposeServiceRecordSchema = Type.Object(
  {
    name: NonEmptyStringSchema,
    containerIds: Type.Array(IdSchema),
  },
  { additionalProperties: false },
);

export const ComposeProjectRecordSchema = Type.Object(
  {
    id: IdSchema,
    name: NonEmptyStringSchema,
    workingDirectory: Type.Optional(Type.String()),
    configFiles: Type.Array(Type.String()),
    services: Type.Array(ComposeServiceRecordSchema),
    evidenceIds: Type.Array(IdSchema),
  },
  { additionalProperties: false },
);

export type ComposeProjectRecord = Static<typeof ComposeProjectRecordSchema>;
