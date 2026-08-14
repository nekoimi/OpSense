import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { BaselineRelevanceClassifier } from '@opsense/ai-provider';
import { redactSnapshot } from '@opsense/redaction';
import type { AiAnalysis, AnalysisResult, ScanSnapshot } from '@opsense/schema';
import {
  AiAnalysisSchema,
  AiPlanSchema,
  AiProbeAuditSchema,
  AiRunSchema,
  assertSchema,
} from '@opsense/schema';
import type { ReportFormat } from '@opsense/report';
import { ensureRunWorkspace } from '@opsense/workspace';
import { afterEach, describe, expect, it } from 'vitest';

import {
  parseReportFormats,
  runReportWorkflow,
} from '../apps/cli/src/workflows/report-workflow.js';
import { runInspectWorkflow } from '../apps/cli/src/workflows/inspect-workflow.js';
import type { ScanWorkflowResult } from '../apps/cli/src/workflows/scan-workflow.js';
import { readFixture } from './support/read-fixture.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('M10 CLI workflows', () => {
  it('parses comma-separated report formats and rejects unknown values', () => {
    expect(parseReportFormats('docx, html,docx')).toEqual(['docx', 'html']);
    expect(() => parseReportFormats('pdf')).toThrow('docx, markdown, html');
  });

  it('regenerates a report from a snapshot without an AI output file', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'opsense-m10-report-'));
    temporaryDirectories.push(root);
    const snapshot = await snapshotFixture();
    const redacted = redactSnapshot(snapshot, () => new Date('2026-08-14T09:00:00Z'));
    const layout = await ensureRunWorkspace(snapshot.session.id, root);
    await writeFile(layout.snapshotFile, JSON.stringify(redacted.value), 'utf8');

    const result = await runReportWorkflow({
      formats: ['docx', 'html'],
      scan: snapshot.session.id,
      timeZone: 'Asia/Shanghai',
      workspace: root,
    });
    expect(result.analysis).toBeUndefined();
    expect(result.artifacts.docxFile).toContain('.docx');
    expect(result.artifacts.htmlFile).toContain('index.html');
  });

  it('keeps inspect stages ordered and produces mandatory Word and HTML paths', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'opsense-m10-inspect-'));
    temporaryDirectories.push(root);
    const snapshot = await snapshotFixture();
    const redacted = redactSnapshot(snapshot, () => new Date('2026-08-14T09:00:00Z'));
    const layout = await ensureRunWorkspace(snapshot.session.id, root);
    await writeFile(layout.snapshotFile, JSON.stringify(redacted.value), 'utf8');
    const stages: string[] = [];
    const fakeConnection = { close: () => undefined } as NonNullable<
      ScanWorkflowResult['connection']
    >;
    const fakeExecutor = {} as NonNullable<ScanWorkflowResult['executor']>;
    const baseline = new BaselineRelevanceClassifier().classify(redacted.value);
    const fakeResult: AnalysisResult = {
      analysis: baselineAnalysis(redacted.value),
      plan: baseline,
      probeAudit: { generatedAt: '2026-08-14T09:00:00.000Z', records: [], round: 0 },
      run: {
        durationMs: 0,
        finishedAt: '2026-08-14T09:00:00.000Z',
        provider: 'noop',
        retryCount: 0,
        startedAt: '2026-08-14T09:00:00.000Z',
        status: 'skipped',
      },
    };
    assertSchema(AiAnalysisSchema, fakeResult.analysis);
    assertSchema(AiPlanSchema, fakeResult.plan);
    assertSchema(AiProbeAuditSchema, fakeResult.probeAudit);
    assertSchema(AiRunSchema, fakeResult.run);
    const scanResult = {
      config: {} as ScanWorkflowResult['config'],
      connection: fakeConnection,
      executor: fakeExecutor,
      layout,
      scanId: snapshot.session.id,
      snapshot: redacted.value,
      workspaceRoot: root,
    } satisfies ScanWorkflowResult;

    const result = await runInspectWorkflow(
      {
        formats: ['markdown'] as ReportFormat[],
        host: 'server.example.com',
        port: 22,
        provider: 'noop',
        threadTimeoutMs: 1_000,
        user: 'ops',
        workspace: root,
      },
      (stage) => stages.push(stage),
      {
        runScan: async (_options, handler) => {
          await handler?.('created');
          return scanResult;
        },
        runAnalysis: async (_options, handler) => {
          await handler?.(_options.stageMode === 'planning-only' ? 'planning' : 'analyzing');
          return {
            config: {} as ScanWorkflowResult['config'],
            layout,
            result: fakeResult,
            snapshot: redacted.value,
          };
        },
        executeProbes: async () => ({ artifacts: [], evidence: [], records: [] }),
        runReport: async () => ({
          analysis: fakeResult.analysis,
          artifacts: {
            markdownFiles: [],
            modelFile: path.join(root, 'report-model.json'),
            outputDirectory: root,
            projectionFile: path.join(root, 'inventory-projection.json'),
            redactionReportFile: path.join(root, 'redaction-report.json'),
            snapshotFile: path.join(root, 'snapshot.json'),
            docxFile: path.join(root, '服务器巡检报告.docx'),
            htmlFile: path.join(root, 'index.html'),
          },
          snapshot: redacted.value,
        }),
      },
    );

    expect(stages).toEqual(['created', 'planning', 'enriching', 'analyzing', 'rendering']);
    expect(result.report.artifacts.docxFile).toContain('.docx');
    expect(result.report.artifacts.htmlFile).toContain('index.html');
  });
});

async function snapshotFixture(): Promise<ScanSnapshot> {
  return JSON.parse(await readFixture('schema/minimal-snapshot.json')) as ScanSnapshot;
}

function baselineAnalysis(snapshot: ScanSnapshot): AiAnalysis {
  const plan = new BaselineRelevanceClassifier().classify(snapshot);
  return {
    generatedAt: '2026-08-14T09:00:00.000Z',
    hostSummary: 'host',
    pathAssessments: plan.pathAssessments,
    provider: 'noop',
    serviceAssessments: plan.serviceAssessments,
    serviceSummaries: [],
    storageSummary: 'storage',
    findings: [],
    unknowns: [],
  };
}
