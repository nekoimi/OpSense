import { access, constants, readFile } from 'node:fs/promises';

import { generateReportArtifacts } from '@opsense/report';
import type { GeneratedReportArtifacts, ReportFormat, ReportProfile } from '@opsense/report';
import { buildInventoryProjection } from '@opsense/projection';
import { AgentSessionSchema, AiAnalysisSchema, assertSchema } from '@opsense/schema';
import type { AiAnalysis, ScanSnapshot } from '@opsense/schema';
import {
  createReportDirectory,
  createRunWorkspaceLayout,
  ensureWorkspace,
  loadConfig,
  writeJsonAtomic,
} from '@opsense/workspace';

import { readSnapshotFile } from './analysis-workflow.js';

export interface ReportWorkflowOptions {
  config?: string;
  formats: readonly ReportFormat[];
  profile?: ReportProfile;
  scan: string;
  timeZone?: string;
  workspace?: string;
}

export interface ReportWorkflowResult {
  analysis?: AiAnalysis;
  artifacts: GeneratedReportArtifacts;
  snapshot: ScanSnapshot;
}

export async function runReportWorkflow(
  options: ReportWorkflowOptions,
): Promise<ReportWorkflowResult> {
  const loaded = await loadConfig({
    ...(options.config === undefined ? {} : { explicitPath: options.config }),
    ...(options.workspace === undefined ? {} : { workspaceRoot: options.workspace }),
  });
  const workspaceRoot = options.workspace ?? loaded.config.workspace.rootDirectory;
  await ensureWorkspace(workspaceRoot);
  const layout = createRunWorkspaceLayout(options.scan, workspaceRoot);
  const snapshot = await readSnapshotFile(layout.snapshotFile);
  const analysis = await readOptionalAnalysis(layout.aiOutputFile);
  const projection = buildInventoryProjection(snapshot, {
    ...(analysis === undefined ? {} : { analysis }),
  });
  await writeJsonAtomic(layout.agentProjectionFile, projection);
  const scannedAt = new Date(snapshot.session.finishedAt ?? snapshot.session.startedAt);
  const outputDirectory = createReportDirectory(
    snapshot.session.target.host,
    scannedAt,
    workspaceRoot,
  );
  const artifacts = await generateReportArtifacts(projection, {
    formats: options.formats,
    outputDirectory,
    ...(options.profile === undefined ? {} : { profile: options.profile }),
    sourceSnapshot: snapshot,
    ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }),
  });
  await recordAgentArtifacts(layout.agentSessionFile, artifacts);
  return { ...(analysis === undefined ? {} : { analysis }), artifacts, snapshot };
}

async function recordAgentArtifacts(
  file: string,
  artifacts: GeneratedReportArtifacts,
): Promise<void> {
  try {
    await access(file, constants.F_OK);
  } catch {
    return;
  }
  const value = JSON.parse(await readFile(file, 'utf8')) as unknown;
  assertSchema(AgentSessionSchema, value);
  const files = [
    artifacts.docxFile,
    artifacts.htmlFile,
    ...artifacts.markdownFiles,
    artifacts.modelFile,
    artifacts.projectionFile,
    artifacts.qualityFile,
    artifacts.wikiProjectionFile,
  ].filter((item): item is string => item !== undefined);
  await writeJsonAtomic(file, {
    ...value,
    outputFiles: [...new Set([...value.outputFiles, ...files])],
    updatedAt: new Date().toISOString(),
  });
}

export async function readOptionalAnalysis(file: string): Promise<AiAnalysis | undefined> {
  try {
    await access(file, constants.F_OK);
  } catch {
    return undefined;
  }
  const value = JSON.parse(await readFile(file, 'utf8')) as unknown;
  assertSchema(AiAnalysisSchema, value);
  return value;
}

export function parseReportFormats(value: string): ReportFormat[] {
  const formats = value
    .split(/[\s,]+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  const allowed = new Set<ReportFormat>(['docx', 'html', 'markdown']);
  if (formats.length === 0 || formats.some((format) => !allowed.has(format as ReportFormat))) {
    throw new Error('Report format must be one or more of docx, markdown, html.');
  }
  return [...new Set(formats as ReportFormat[])];
}
