import { Type, type Static } from '@sinclair/typebox';

import { DateTimeSchema, IdSchema, NonEmptyStringSchema } from './common.js';
import { DeploymentServiceRoleSchema } from './inventory-v3.js';

export const InventoryRevisionChangeSchema = Type.Object(
  {
    serviceId: IdSchema,
    evidenceIds: Type.Array(IdSchema),
    reason: NonEmptyStringSchema,
    name: Type.Optional(NonEmptyStringSchema),
    purpose: Type.Optional(NonEmptyStringSchema),
    role: Type.Optional(DeploymentServiceRoleSchema),
    reviewItems: Type.Optional(Type.Array(NonEmptyStringSchema)),
  },
  { additionalProperties: false },
);

export const WikiRevisionChangeSchema = Type.Object(
  {
    section: Type.Union([
      Type.Literal('overview'),
      Type.Literal('service'),
      Type.Literal('operations'),
      Type.Literal('risks'),
    ]),
    serviceId: Type.Optional(IdSchema),
    content: NonEmptyStringSchema,
    evidenceIds: Type.Array(IdSchema),
    reason: NonEmptyStringSchema,
  },
  { additionalProperties: false },
);

export const PostReportAgentProposalSchema = Type.Object(
  {
    message: NonEmptyStringSchema,
    inventoryChanges: Type.Array(InventoryRevisionChangeSchema),
    wikiChanges: Type.Array(WikiRevisionChangeSchema),
    evidenceReferences: Type.Array(IdSchema),
    unresolvedQuestions: Type.Array(NonEmptyStringSchema),
    nextSuggestions: Type.Array(NonEmptyStringSchema),
  },
  { $id: 'PostReportAgentProposalV3', additionalProperties: false },
);

export const InventoryRevisionSchema = Type.Object(
  {
    schemaVersion: Type.Literal('3.0'),
    revisionId: IdSchema,
    inventoryId: IdSchema,
    sequence: Type.Integer({ minimum: 1 }),
    parentRevisionId: Type.Optional(IdSchema),
    createdAt: DateTimeSchema,
    author: Type.Literal('codex'),
    request: NonEmptyStringSchema,
    changes: Type.Array(InventoryRevisionChangeSchema, { minItems: 1 }),
    unresolvedQuestions: Type.Array(NonEmptyStringSchema),
  },
  { $id: 'InventoryRevisionV3', additionalProperties: false },
);

export const WikiRevisionSchema = Type.Object(
  {
    schemaVersion: Type.Literal('3.0'),
    revisionId: IdSchema,
    wikiId: IdSchema,
    inventoryId: IdSchema,
    sequence: Type.Integer({ minimum: 1 }),
    parentRevisionId: Type.Optional(IdSchema),
    createdAt: DateTimeSchema,
    author: Type.Literal('codex'),
    request: NonEmptyStringSchema,
    changes: Type.Array(WikiRevisionChangeSchema, { minItems: 1 }),
  },
  { $id: 'WikiRevisionV3', additionalProperties: false },
);

export const PostReportAgentRunSchema = Type.Object(
  {
    provider: NonEmptyStringSchema,
    status: Type.Union([Type.Literal('completed'), Type.Literal('failed')]),
    startedAt: DateTimeSchema,
    finishedAt: DateTimeSchema,
    durationMs: Type.Integer({ minimum: 0 }),
    callCount: Type.Integer({ minimum: 0 }),
    repairCount: Type.Integer({ minimum: 0 }),
    threadId: Type.Optional(NonEmptyStringSchema),
    model: Type.Optional(NonEmptyStringSchema),
    error: Type.Optional(NonEmptyStringSchema),
  },
  { additionalProperties: false },
);

export const PostReportAgentResultSchema = Type.Object(
  {
    proposal: PostReportAgentProposalSchema,
    run: PostReportAgentRunSchema,
  },
  { $id: 'PostReportAgentResultV3', additionalProperties: false },
);

export type InventoryRevisionChange = Static<typeof InventoryRevisionChangeSchema>;
export type WikiRevisionChange = Static<typeof WikiRevisionChangeSchema>;
export type PostReportAgentProposal = Static<typeof PostReportAgentProposalSchema>;
export type InventoryRevision = Static<typeof InventoryRevisionSchema>;
export type WikiRevision = Static<typeof WikiRevisionSchema>;
export type PostReportAgentRun = Static<typeof PostReportAgentRunSchema>;
export type PostReportAgentResult = Static<typeof PostReportAgentResultSchema>;
