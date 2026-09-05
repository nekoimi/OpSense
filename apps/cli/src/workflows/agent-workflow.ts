import { readFile } from 'node:fs/promises';

import { buildPostReportRevisions } from '@opsense/agent-runtime';
import { CodexPostReportAgentAdapter } from '@opsense/ai-codex';
import type { PostReportAgentAdapter } from '@opsense/ai-provider';
import {
  InventoryRevisionSchema,
  ScanSnapshotSchema,
  WikiRevisionSchema,
  assertSchema,
} from '@opsense/schema';
import type { InventoryRevision, PostReportAgentResult, WikiRevision } from '@opsense/schema';
import { appendJsonLine, loadConfig } from '@opsense/workspace';

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
  const snapshotValue = JSON.parse(await readFile(located.layout.snapshotFile, 'utf8')) as unknown;
  assertSchema(ScanSnapshotSchema, snapshotValue);
  const [inventoryRevisions, wikiRevisions] = await Promise.all([
    readJsonLines<InventoryRevision>(
      located.layout.inventoryRevisionsFile,
      InventoryRevisionSchema,
    ),
    readJsonLines<WikiRevision>(located.layout.wikiRevisionsFile, WikiRevisionSchema),
  ]);
  assertRevisionChain(inventoryRevisions, located.inventory.inventoryId, 'inventory');
  assertRevisionChain(wikiRevisions, located.inventory.inventoryId, 'wiki');

  const adapter = dependencies.adapter ?? new CodexPostReportAgentAdapter();
  const agent = await adapter.investigate(
    {
      evidence: snapshotValue.evidence,
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
    evidence: snapshotValue.evidence,
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

async function readJsonLines<T>(
  file: string,
  schema: Parameters<typeof assertSchema>[0],
): Promise<T[]> {
  let source: string;
  try {
    source = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return source
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const value = JSON.parse(line) as unknown;
      assertSchema(schema, value);
      return value as T;
    });
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
