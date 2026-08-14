import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';

export interface WorkspaceLayout {
  configFile: string;
  reportsDirectory: string;
  rootDirectory: string;
  runsDirectory: string;
}

export interface RunWorkspaceLayout extends WorkspaceLayout {
  aiInputDirectory: string;
  aiOutputFile: string;
  auditFile: string;
  metaFile: string;
  runDirectory: string;
  scanId: string;
  snapshotFile: string;
}

export function resolveWorkspaceRoot(explicitRoot?: string): string {
  return path.resolve(explicitRoot ?? path.join(homedir(), '.opsense'));
}

export function createWorkspaceLayout(explicitRoot?: string): WorkspaceLayout {
  const rootDirectory = resolveWorkspaceRoot(explicitRoot);
  return {
    configFile: path.join(rootDirectory, 'config.json'),
    reportsDirectory: path.join(rootDirectory, 'reports'),
    rootDirectory,
    runsDirectory: path.join(rootDirectory, 'runs'),
  };
}

export function createRunWorkspaceLayout(
  scanId: string,
  explicitRoot?: string,
): RunWorkspaceLayout {
  const workspace = createWorkspaceLayout(explicitRoot);
  const runDirectory = path.join(workspace.runsDirectory, sanitizePathSegment(scanId));
  return {
    ...workspace,
    aiInputDirectory: path.join(runDirectory, 'ai-input'),
    aiOutputFile: path.join(runDirectory, 'ai-output.json'),
    auditFile: path.join(runDirectory, 'audit.jsonl'),
    metaFile: path.join(runDirectory, 'meta.json'),
    runDirectory,
    scanId,
    snapshotFile: path.join(runDirectory, 'snapshot.json'),
  };
}

export function createReportDirectory(
  host: string,
  scannedAt: Date,
  explicitRoot?: string,
): string {
  const workspace = createWorkspaceLayout(explicitRoot);
  return path.join(
    workspace.reportsDirectory,
    sanitizePathSegment(host),
    formatTimestamp(scannedAt),
  );
}

export function createScanId(now = new Date(), uuid = randomUUID()): string {
  return `scan-${formatTimestamp(now)}-${uuid.slice(0, 8)}`;
}

export function sanitizePathSegment(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 100);

  return sanitized.length > 0 ? sanitized : 'unknown';
}

function formatTimestamp(value: Date): string {
  return value
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}
