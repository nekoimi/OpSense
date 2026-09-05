import { readdir, readFile } from 'node:fs/promises';

import { generateV3Reports } from '@opsense/report';
import type { V3ReportArtifacts } from '@opsense/report';
import { redactForReport } from '@opsense/redaction';
import { DeploymentInventorySchema, WikiProjectionV3Schema, assertSchema } from '@opsense/schema';
import type { DeploymentInventory, WikiProjectionV3 } from '@opsense/schema';
import { buildWikiProjectionV3 } from '@opsense/wiki';
import {
  createReportDirectory,
  createRunWorkspaceLayout,
  createWorkspaceLayout,
  loadConfig,
  writeJsonAtomic,
} from '@opsense/workspace';
import type { RunWorkspaceLayout } from '@opsense/workspace';

export interface InventoryReportWorkflowOptions {
  config?: string;
  inventory: string;
  workspace?: string;
}

export interface InventoryReportWorkflowResult {
  artifacts: V3ReportArtifacts;
  inventory: DeploymentInventory;
  wiki: WikiProjectionV3;
}

export async function runInventoryReportWorkflow(
  options: InventoryReportWorkflowOptions,
): Promise<InventoryReportWorkflowResult> {
  const loaded = await loadConfig({
    ...(options.config === undefined ? {} : { explicitPath: options.config }),
    ...(options.workspace === undefined ? {} : { workspaceRoot: options.workspace }),
  });
  const workspaceRoot = options.workspace ?? loaded.config.workspace.rootDirectory;
  const located = await findInventory(options.inventory, workspaceRoot);
  const wiki = await readWiki(located.scanId, workspaceRoot, located.inventory);
  const outputDirectory = createReportDirectory(
    located.inventory.host.hostname,
    new Date(located.inventory.generatedAt),
    workspaceRoot,
  );
  const redacted = redactForReport({ inventory: located.inventory, wiki });
  const artifacts = await generateV3Reports(
    redacted.value.inventory,
    redacted.value.wiki,
    outputDirectory,
  );
  await writeJsonAtomic(located.layout.reportRedactionFile, redacted.report);
  return { artifacts, inventory: redacted.value.inventory, wiki: redacted.value.wiki };
}

export async function findInventory(
  inventoryId: string,
  workspaceRoot?: string,
): Promise<{
  inventory: DeploymentInventory;
  layout: RunWorkspaceLayout;
  scanId: string;
}> {
  const runsDirectory = createWorkspaceLayout(workspaceRoot).runsDirectory;
  const entries = await readdir(runsDirectory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const layout = createRunWorkspaceLayout(entry.name, workspaceRoot);
    try {
      const value = JSON.parse(await readFile(layout.inventoryFile, 'utf8')) as unknown;
      assertSchema(DeploymentInventorySchema, value);
      if (value.inventoryId === inventoryId)
        return { inventory: value, layout, scanId: entry.name };
    } catch {
      // Ignore unrelated or incomplete run directories while resolving the stable inventory ID.
    }
  }
  throw new Error(`Deployment Inventory '${inventoryId}' was not found in ${runsDirectory}.`);
}

export async function readWiki(
  scanId: string,
  workspaceRoot: string | undefined,
  inventory: DeploymentInventory,
): Promise<WikiProjectionV3> {
  const layout = createRunWorkspaceLayout(scanId, workspaceRoot);
  try {
    const value = JSON.parse(await readFile(layout.wikiFile, 'utf8')) as unknown;
    assertSchema(WikiProjectionV3Schema, value);
    if (value.inventoryId === inventory.inventoryId) return value;
  } catch {
    // A deterministic local skeleton is sufficient for explicit offline regeneration.
  }
  return buildWikiProjectionV3(inventory).projection;
}
