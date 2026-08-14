import { Type, type Static } from '@sinclair/typebox';

import { DateTimeSchema, IdSchema, NonEmptyStringSchema } from './common.js';

export const PartitionRecordSchema = Type.Object(
  {
    id: IdSchema,
    name: NonEmptyStringSchema,
    path: NonEmptyStringSchema,
    parentDiskId: IdSchema,
    sizeBytes: Type.Integer({ minimum: 0 }),
    fileSystemType: Type.Optional(Type.String()),
    uuid: Type.Optional(Type.String()),
    mountPoints: Type.Array(Type.String()),
    evidenceIds: Type.Array(IdSchema),
  },
  { additionalProperties: false },
);

export type PartitionRecord = Static<typeof PartitionRecordSchema>;

export const DiskRecordSchema = Type.Object(
  {
    id: IdSchema,
    name: NonEmptyStringSchema,
    path: NonEmptyStringSchema,
    type: NonEmptyStringSchema,
    sizeBytes: Type.Integer({ minimum: 0 }),
    model: Type.Optional(Type.String()),
    serial: Type.Optional(Type.String()),
    rotational: Type.Optional(Type.Boolean()),
    removable: Type.Optional(Type.Boolean()),
    partitions: Type.Array(PartitionRecordSchema),
    evidenceIds: Type.Array(IdSchema),
  },
  { additionalProperties: false },
);

export type DiskRecord = Static<typeof DiskRecordSchema>;

export const MountRecordSchema = Type.Object(
  {
    id: IdSchema,
    source: NonEmptyStringSchema,
    target: NonEmptyStringSchema,
    fileSystemType: NonEmptyStringSchema,
    options: Type.Array(Type.String()),
    totalBytes: Type.Optional(Type.Integer({ minimum: 0 })),
    usedBytes: Type.Optional(Type.Integer({ minimum: 0 })),
    availableBytes: Type.Optional(Type.Integer({ minimum: 0 })),
    inodeTotal: Type.Optional(Type.Integer({ minimum: 0 })),
    inodeUsed: Type.Optional(Type.Integer({ minimum: 0 })),
    readOnly: Type.Boolean(),
    network: Type.Boolean(),
    pseudo: Type.Boolean(),
    evidenceIds: Type.Array(IdSchema),
  },
  { additionalProperties: false },
);

export type MountRecord = Static<typeof MountRecordSchema>;

export const StorageLayerRecordSchema = Type.Object(
  {
    id: IdSchema,
    type: Type.Union([Type.Literal('lvm'), Type.Literal('raid')]),
    name: NonEmptyStringSchema,
    devices: Type.Array(NonEmptyStringSchema),
    sizeBytes: Type.Optional(Type.Integer({ minimum: 0 })),
    evidenceIds: Type.Array(IdSchema),
  },
  { additionalProperties: false },
);

export type StorageLayerRecord = Static<typeof StorageLayerRecordSchema>;

export const StorageSnapshotSchema = Type.Object(
  {
    disks: Type.Array(DiskRecordSchema),
    mounts: Type.Array(MountRecordSchema),
    layers: Type.Array(StorageLayerRecordSchema),
    collectedAt: DateTimeSchema,
  },
  { additionalProperties: false },
);

export type StorageSnapshot = Static<typeof StorageSnapshotSchema>;
