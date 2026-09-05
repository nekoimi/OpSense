import { buildPostReportRevisions } from '@opsense/agent-runtime';
import { CodexPostReportAgentAdapter } from '@opsense/ai-codex';
import type { PostReportAgentAdapter } from '@opsense/ai-provider';
import { InventoryRevisionSchema, EvidenceRecordSchema, WikiRevisionSchema } from '@opsense/schema';
import type {
  EvidenceRecord,
  InventoryRevision,
  PostReportAgentResult,
  WikiRevision,
} from '@opsense/schema';
import { appendJsonLine, loadConfig, readJsonLines } from '@opsense/workspace';

import { findInventory, readWiki } from './inventory-report-workflow.js';

export interface AgentWorkflowOptions {
  config?: string;
  inventory: string;
  maxRetries?: number;
  model?: string;
  prompt: string;
  signal?: AbortSignal;
  threadId?: string;
  timeoutMs?: number;
  workspace?: string;
}

export interface AgentWorkflowDependencies {
  adapter?: PostReportAgentAdapter;
  now?: () => Date;
}

export interface AgentWorkflowResult {
  agent: PostReportAgentResult;
  inventoryRevision?: InventoryRevision;
  inventoryRevisionsFile: string;
  turnsFile: string;
  wikiRevision?: WikiRevision;
  wikiRevisionsFile: string;
}

export async function runAgentWorkflow(
  options: AgentWorkflowOptions,
  dependencies: AgentWorkflowDependencies = {},
): Promise<AgentWorkflowResult> {
  const loaded = await loadConfig({
    ...(options.config === undefined ? {} : { explicitPath: options.config }),
    ...(options.workspace === undefined ? {} : { workspaceRoot: options.workspace }),
  });
  const workspaceRoot = options.workspace ?? loaded.config.workspace.rootDirectory;
  const located = await findInventory(options.inventory, workspaceRoot);
  const wiki = await readWiki(located.scanId, workspaceRoot, located.inventory);
  const [evidence, inventoryRevisions, wikiRevisions] = await Promise.all([
    readJsonLines<EvidenceRecord>(located.layout.evidenceFile, EvidenceRecordSchema),
    readJsonLines<InventoryRevision>(
      located.layout.inventoryRevisionsFile,
      InventoryRevisionSchema,
      { allowMissing: true },
    ),
    readJsonLines<WikiRevision>(located.layout.wikiRevisionsFile, WikiRevisionSchema, {
      allowMissing: true,
    }),
  ]);
  if (new Set(evidence.map((item) => item.id)).size !== evidence.length)
    throw new Error('Evidence Store contains duplicate Evidence IDs.');
  assertRevisionChain(inventoryRevisions, located.inventory.inventoryId, 'inventory');
  assertRevisionChain(wikiRevisions, located.inventory.inventoryId, 'wiki');

  const adapter = dependencies.adapter ?? new CodexPostReportAgentAdapter();
  const agent = await adapter.investigate(
    {
      evidence,
      inventory: located.inventory,
      inventoryRevisions,
      prompt: options.prompt,
      wiki,
      wikiRevisions,
    },
    {
      ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.threadId === undefined ? {} : { threadId: options.threadId }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    },
  );
  const revisions = buildPostReportRevisions({
    evidence,
    inventory: located.inventory,
    previousInventoryRevisions: inventoryRevisions,
    previousWikiRevisions: wikiRevisions,
    prompt: options.prompt,
    result: agent,
    wiki,
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
  });

  if (revisions.inventoryRevision !== undefined)
    await appendJsonLine(located.layout.inventoryRevisionsFile, revisions.inventoryRevision);
  if (revisions.wikiRevision !== undefined)
    await appendJsonLine(located.layout.wikiRevisionsFile, revisions.wikiRevision);
  await appendJsonLine(located.layout.postReportAgentTurnsFile, {
    inventoryId: located.inventory.inventoryId,
    prompt: options.prompt,
    proposal: revisions.proposal,
    run: agent.run,
  });

  return {
    agent: { ...agent, proposal: revisions.proposal },
    inventoryRevisionsFile: located.layout.inventoryRevisionsFile,
    turnsFile: located.layout.postReportAgentTurnsFile,
    wikiRevisionsFile: located.layout.wikiRevisionsFile,
    ...(revisions.inventoryRevision === undefined
      ? {}
      : { inventoryRevision: revisions.inventoryRevision }),
    ...(revisions.wikiRevision === undefined ? {} : { wikiRevision: revisions.wikiRevision }),
  };
}

function assertRevisionChain(
  revisions: readonly (InventoryRevision | WikiRevision)[],
  inventoryId: string,
  kind: string,
): void {
  for (const [index, revision] of revisions.entries()) {
    if (revision.inventoryId !== inventoryId)
      throw new Error(`${kind} revision ${revision.revisionId} targets another Inventory.`);
    if (revision.sequence !== index + 1)
      throw new Error(`${kind} revision sequence is not contiguous at ${revision.revisionId}.`);
    const expectedParent = index === 0 ? undefined : revisions[index - 1]?.revisionId;
    if (revision.parentRevisionId !== expectedParent)
      throw new Error(`${kind} revision parent chain is invalid at ${revision.revisionId}.`);
  }
}
