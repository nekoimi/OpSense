import { createHash } from 'node:crypto';

import {
  InventoryRevisionSchema,
  PostReportAgentResultSchema,
  WikiRevisionSchema,
  assertSchema,
} from '@opsense/schema';
import type {
  DeploymentInventory,
  EvidenceRecord,
  InventoryRevision,
  PostReportAgentProposal,
  PostReportAgentResult,
  WikiProjectionV3,
  WikiRevision,
} from '@opsense/schema';

export interface BuildPostReportRevisionsInput {
  inventory: DeploymentInventory;
  wiki: WikiProjectionV3;
  evidence: readonly EvidenceRecord[];
  prompt: string;
  previousInventoryRevisions: readonly InventoryRevision[];
  previousWikiRevisions: readonly WikiRevision[];
  result: PostReportAgentResult;
  now?: () => Date;
}

export interface PostReportRevisions {
  inventoryRevision?: InventoryRevision;
  proposal: PostReportAgentProposal;
  wikiRevision?: WikiRevision;
}

export function buildPostReportRevisions(
  input: BuildPostReportRevisionsInput,
): PostReportRevisions {
  assertSchema(PostReportAgentResultSchema, input.result);
  const proposal = validatePostReportProposal(
    input.result.proposal,
    input.inventory,
    input.evidence,
  );
  const createdAt = (input.now ?? (() => new Date()))().toISOString();
  const inventoryRevision =
    proposal.inventoryChanges.length === 0
      ? undefined
      : buildInventoryRevision(input, proposal, createdAt);
  const wikiRevision =
    proposal.wikiChanges.length === 0 ? undefined : buildWikiRevision(input, proposal, createdAt);
  return {
    proposal,
    ...(inventoryRevision === undefined ? {} : { inventoryRevision }),
    ...(wikiRevision === undefined ? {} : { wikiRevision }),
  };
}

export function validatePostReportProposal(
  proposal: PostReportAgentProposal,
  inventory: DeploymentInventory,
  evidence: readonly EvidenceRecord[],
): PostReportAgentProposal {
  const serviceIds = new Set(inventory.services.map((service) => service.serviceId));
  const evidenceIds = new Set(evidence.map((item) => item.id));
  const referencedEvidence = [
    ...proposal.evidenceReferences,
    ...proposal.inventoryChanges.flatMap((change) => change.evidenceIds),
    ...proposal.wikiChanges.flatMap((change) => change.evidenceIds),
  ];
  const unknownEvidence = unique(referencedEvidence).filter((id) => !evidenceIds.has(id));
  if (unknownEvidence.length > 0)
    throw new Error(`Agent referenced unknown Evidence IDs: ${unknownEvidence.join(', ')}`);

  const unknownServices = unique([
    ...proposal.inventoryChanges.map((change) => change.serviceId),
    ...proposal.wikiChanges.flatMap((change) =>
      change.serviceId === undefined ? [] : [change.serviceId],
    ),
  ]).filter((id) => !serviceIds.has(id));
  if (unknownServices.length > 0)
    throw new Error(`Agent referenced unknown Service IDs: ${unknownServices.join(', ')}`);

  const invalidWikiChange = proposal.wikiChanges.find(
    (change) =>
      (change.section === 'service' && change.serviceId === undefined) ||
      (change.section !== 'service' && change.serviceId !== undefined),
  );
  if (invalidWikiChange !== undefined)
    throw new Error('Wiki service revisions require serviceId; other sections must omit it.');

  return {
    ...proposal,
    evidenceReferences: unique(proposal.evidenceReferences),
    inventoryChanges: proposal.inventoryChanges.map((change) => ({
      ...change,
      evidenceIds: unique(change.evidenceIds),
      ...(change.reviewItems === undefined ? {} : { reviewItems: unique(change.reviewItems) }),
    })),
    nextSuggestions: unique(proposal.nextSuggestions),
    unresolvedQuestions: unique(proposal.unresolvedQuestions),
    wikiChanges: proposal.wikiChanges.map((change) => ({
      ...change,
      evidenceIds: unique(change.evidenceIds),
    })),
  };
}

function buildInventoryRevision(
  input: BuildPostReportRevisionsInput,
  proposal: PostReportAgentProposal,
  createdAt: string,
): InventoryRevision {
  const previous = input.previousInventoryRevisions.at(-1);
  const sequence = (previous?.sequence ?? 0) + 1;
  const revision: InventoryRevision = {
    author: 'codex',
    changes: proposal.inventoryChanges,
    createdAt,
    inventoryId: input.inventory.inventoryId,
    request: input.prompt,
    revisionId: revisionId(
      'inventory',
      input.inventory.inventoryId,
      sequence,
      proposal.inventoryChanges,
    ),
    schemaVersion: '3.0',
    sequence,
    unresolvedQuestions: proposal.unresolvedQuestions,
    ...(previous === undefined ? {} : { parentRevisionId: previous.revisionId }),
  };
  assertSchema(InventoryRevisionSchema, revision);
  return revision;
}

function buildWikiRevision(
  input: BuildPostReportRevisionsInput,
  proposal: PostReportAgentProposal,
  createdAt: string,
): WikiRevision {
  const previous = input.previousWikiRevisions.at(-1);
  const sequence = (previous?.sequence ?? 0) + 1;
  const revision: WikiRevision = {
    author: 'codex',
    changes: proposal.wikiChanges,
    createdAt,
    inventoryId: input.inventory.inventoryId,
    request: input.prompt,
    revisionId: revisionId('wiki', input.wiki.projectionId, sequence, proposal.wikiChanges),
    schemaVersion: '3.0',
    sequence,
    wikiId: input.wiki.projectionId,
    ...(previous === undefined ? {} : { parentRevisionId: previous.revisionId }),
  };
  assertSchema(WikiRevisionSchema, revision);
  return revision;
}

function revisionId(kind: string, sourceId: string, sequence: number, changes: unknown): string {
  const hash = createHash('sha256')
    .update(JSON.stringify({ changes, kind, sequence, sourceId }))
    .digest('hex')
    .slice(0, 20);
  return `${kind}-revision-${hash}`;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
