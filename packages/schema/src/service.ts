import { Type, type Static } from '@sinclair/typebox';

import { ConfidenceSchema, IdSchema, NonEmptyStringSchema } from './common.js';

export const DeploymentTypeSchema = Type.Union([
  Type.Literal('systemd'),
  Type.Literal('process'),
  Type.Literal('docker'),
  Type.Literal('compose'),
  Type.Literal('unknown'),
]);

export const ServiceStatusSchema = Type.Union([
  Type.Literal('running'),
  Type.Literal('stopped'),
  Type.Literal('failed'),
  Type.Literal('unknown'),
]);

export const ServiceRecordSchema = Type.Object(
  {
    id: IdSchema,
    name: NonEmptyStringSchema,
    displayName: Type.Optional(Type.String()),
    purpose: Type.Optional(Type.String()),
    purposeConfidence: Type.Optional(ConfidenceSchema),
    deploymentType: DeploymentTypeSchema,
    status: ServiceStatusSchema,
    enabledAtBoot: Type.Optional(Type.Boolean()),
    systemdUnitIds: Type.Array(IdSchema),
    processIds: Type.Array(Type.Integer({ minimum: 1 })),
    containerIds: Type.Array(IdSchema),
    composeProjectIds: Type.Array(IdSchema),
    socketIds: Type.Array(IdSchema),
    deployDirectories: Type.Array(Type.String()),
    configFiles: Type.Array(Type.String()),
    environmentFiles: Type.Array(Type.String()),
    logLocations: Type.Array(Type.String()),
    dataDirectories: Type.Array(Type.String()),
    startCommand: Type.Optional(Type.String()),
    stopCommand: Type.Optional(Type.String()),
    restartCommand: Type.Optional(Type.String()),
    confidence: ConfidenceSchema,
    evidenceIds: Type.Array(IdSchema),
    unknownFields: Type.Array(Type.String()),
    conflictFields: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: false },
);

export type ServiceRecord = Static<typeof ServiceRecordSchema>;
