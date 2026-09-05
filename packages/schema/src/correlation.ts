import { Type, type Static } from '@sinclair/typebox';

import { DateTimeSchema, IdSchema, NonEmptyStringSchema } from './common.js';

export const ResourceNodeKindSchema = Type.Union([
  Type.Literal('host'),
  Type.Literal('systemd_unit'),
  Type.Literal('process'),
  Type.Literal('socket'),
  Type.Literal('container'),
  Type.Literal('compose_project'),
  Type.Literal('mount'),
  Type.Literal('path'),
]);

export type ResourceNodeKind = Static<typeof ResourceNodeKindSchema>;

export const ResourceNodeSchema = Type.Object(
  {
    attributes: Type.Record(Type.String(), Type.Unknown()),
    evidenceIds: Type.Array(IdSchema),
    kind: ResourceNodeKindSchema,
    name: NonEmptyStringSchema,
    resourceId: IdSchema,
    sourceObjectId: IdSchema,
  },
  { additionalProperties: false },
);

export type ResourceNode = Static<typeof ResourceNodeSchema>;

export const ResourceEdgeKindSchema = Type.Union([
  Type.Literal('unit_main_process'),
  Type.Literal('process_parent'),
  Type.Literal('process_socket'),
  Type.Literal('process_cgroup_unit'),
  Type.Literal('process_container'),
  Type.Literal('container_compose_service'),
  Type.Literal('container_publishes_port'),
  Type.Literal('container_mounts_path'),
  Type.Literal('unit_references_path'),
  Type.Literal('process_references_path'),
  Type.Literal('path_on_mount'),
]);

export type ResourceEdgeKind = Static<typeof ResourceEdgeKindSchema>;

export const ResourceEdgeSchema = Type.Object(
  {
    confidence: Type.Union([Type.Literal('confirmed'), Type.Literal('inferred')]),
    edgeId: IdSchema,
    evidenceIds: Type.Array(IdSchema),
    fromId: IdSchema,
    kind: ResourceEdgeKindSchema,
    ruleId: NonEmptyStringSchema,
    toId: IdSchema,
  },
  { additionalProperties: false },
);

export type ResourceEdge = Static<typeof ResourceEdgeSchema>;

export const ResourceComponentSchema = Type.Object(
  {
    componentId: IdSchema,
    resourceIds: Type.Array(IdSchema, { minItems: 1 }),
  },
  { additionalProperties: false },
);

export const ResourceGraphSchema = Type.Object(
  {
    components: Type.Array(ResourceComponentSchema),
    edges: Type.Array(ResourceEdgeSchema),
    generatedAt: DateTimeSchema,
    graphId: IdSchema,
    nodes: Type.Array(ResourceNodeSchema),
    schemaVersion: Type.Literal('3.0'),
    sourceScanId: IdSchema,
  },
  { $id: 'ResourceGraphV3', additionalProperties: false },
);

export type ResourceGraph = Static<typeof ResourceGraphSchema>;
