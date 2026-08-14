import { Type, type Static } from '@sinclair/typebox';

import {
  CollectionStatusSchema,
  DateTimeSchema,
  IdSchema,
  NonEmptyStringSchema,
} from './common.js';

export const CommandCapabilitySchema = Type.Object(
  {
    command: NonEmptyStringSchema,
    available: Type.Boolean(),
    status: CollectionStatusSchema,
    evidenceIds: Type.Array(IdSchema),
  },
  { additionalProperties: false },
);

export type CommandCapability = Static<typeof CommandCapabilitySchema>;

export const OperatingSystemSchema = Type.Object(
  {
    id: NonEmptyStringSchema,
    name: NonEmptyStringSchema,
    prettyName: NonEmptyStringSchema,
    version: Type.Optional(Type.String()),
    versionId: Type.Optional(Type.String()),
    family: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export type OperatingSystem = Static<typeof OperatingSystemSchema>;

export const CpuSnapshotSchema = Type.Object(
  {
    architecture: NonEmptyStringSchema,
    model: Type.Optional(Type.String()),
    logicalCores: Type.Integer({ minimum: 0 }),
    physicalCores: Type.Optional(Type.Integer({ minimum: 1 })),
    sockets: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);

export type CpuSnapshot = Static<typeof CpuSnapshotSchema>;

export const MemorySnapshotSchema = Type.Object(
  {
    totalBytes: Type.Integer({ minimum: 0 }),
    availableBytes: Type.Integer({ minimum: 0 }),
    swapTotalBytes: Type.Integer({ minimum: 0 }),
    swapFreeBytes: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export type MemorySnapshot = Static<typeof MemorySnapshotSchema>;

export const HostSnapshotSchema = Type.Object(
  {
    hostname: NonEmptyStringSchema,
    fqdn: Type.Optional(Type.String()),
    operatingSystem: OperatingSystemSchema,
    kernelVersion: NonEmptyStringSchema,
    architecture: NonEmptyStringSchema,
    cpu: CpuSnapshotSchema,
    memory: MemorySnapshotSchema,
    timezone: Type.Optional(Type.String()),
    uptimeSeconds: Type.Integer({ minimum: 0 }),
    virtualization: Type.Optional(Type.String()),
    packageManager: Type.Optional(Type.String()),
    capabilities: Type.Array(CommandCapabilitySchema),
    collectedAt: DateTimeSchema,
  },
  { additionalProperties: false },
);

export type HostSnapshot = Static<typeof HostSnapshotSchema>;
