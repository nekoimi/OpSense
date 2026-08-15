import { mkdir } from 'node:fs/promises';

import { createRunWorkspaceLayout, createWorkspaceLayout } from './paths.js';
import type { RunWorkspaceLayout, WorkspaceLayout } from './paths.js';

export async function ensureWorkspace(explicitRoot?: string): Promise<WorkspaceLayout> {
  const layout = createWorkspaceLayout(explicitRoot);
  await Promise.all([
    mkdir(layout.rootDirectory, { recursive: true }),
    mkdir(layout.runsDirectory, { recursive: true }),
    mkdir(layout.reportsDirectory, { recursive: true }),
  ]);
  return layout;
}

export async function ensureRunWorkspace(
  scanId: string,
  explicitRoot?: string,
): Promise<RunWorkspaceLayout> {
  const layout = createRunWorkspaceLayout(scanId, explicitRoot);
  await ensureWorkspace(explicitRoot);
  await Promise.all([
    mkdir(layout.agentSandboxDirectory, { recursive: true }),
    mkdir(layout.runDirectory, { recursive: true }),
    mkdir(layout.aiInputDirectory, { recursive: true }),
  ]);
  return layout;
}
