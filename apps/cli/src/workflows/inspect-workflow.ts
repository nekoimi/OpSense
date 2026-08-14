import { executeAiProbeRequests } from '@opsense/collectors';
import { normalizeAndMergeServices } from '@opsense/core';
import { redactSnapshot } from '@opsense/redaction';
import { AiProbeAuditSchema, ScanSnapshotSchema, assertSchema } from '@opsense/schema';
import type { AiProbeAudit, ProbeAuditRecord, ScanSnapshot } from '@opsense/schema';
import { ProbePlanValidator } from '@opsense/ai-provider';
import { writeJsonAtomic } from '@opsense/workspace';
import type { ReportFormat } from '@opsense/report';

import {
  runAnalysisWorkflow,
  type AnalyzeWorkflowOptions,
  type AnalyzeWorkflowResult,
} from './analysis-workflow.js';
import { WorkflowInterruptedError } from './errors.js';
import {
  runReportWorkflow,
  type ReportWorkflowOptions,
  type ReportWorkflowResult,
} from './report-workflow.js';
import {
  runScanWorkflow,
  type ScanStageHandler,
  type ScanWorkflowOptions,
  type ScanWorkflowResult,
} from './scan-workflow.js';

export interface InspectWorkflowOptions extends Omit<ScanWorkflowOptions, 'retainConnection'> {
  formats: readonly ReportFormat[];
  maxRetries?: number;
  model?: string;
  provider: string;
  threadTimeoutMs: number;
  timeZone?: string;
}

export interface InspectWorkflowDependencies {
  runScan?: (
    options: ScanWorkflowOptions,
    onStage?: ScanStageHandler,
  ) => Promise<ScanWorkflowResult>;
  runAnalysis?: (
    options: AnalyzeWorkflowOptions,
    onStage?: ScanStageHandler,
  ) => Promise<AnalyzeWorkflowResult>;
  runReport?: (options: ReportWorkflowOptions) => Promise<ReportWorkflowResult>;
  executeProbes?: typeof executeAiProbeRequests;
  now?: () => Date;
}

export interface InspectWorkflowResult {
  analysis: AnalyzeWorkflowResult;
  report: ReportWorkflowResult;
  scan: ScanWorkflowResult;
}

export async function runInspectWorkflow(
  options: InspectWorkflowOptions,
  onStage?: ScanStageHandler,
  dependencies: InspectWorkflowDependencies = {},
): Promise<InspectWorkflowResult> {
  const now = dependencies.now ?? (() => new Date());
  let scan: ScanWorkflowResult | undefined;
  try {
    const scanRunner =
      dependencies.runScan ?? ((scanOptions, handler) => runScanWorkflow(scanOptions, handler));
    scan = await scanRunner({ ...options, retainConnection: true }, onStage);
    throwIfAborted(options.signal);
    if (scan.executor === undefined || scan.connection === undefined) {
      throw new Error('Inspect scan did not retain its SSH session.');
    }

    const analyzeRunner =
      dependencies.runAnalysis ??
      ((analysisOptions, handler) => runAnalysisWorkflow(analysisOptions, handler));
    const initial = await analyzeRunner(
      {
        provider: options.provider,
        scan: scan.scanId,
        stageMode: 'planning-only',
        timeoutMs: options.threadTimeoutMs,
        ...(options.config === undefined ? {} : { config: options.config }),
        ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
        ...(options.model === undefined ? {} : { model: options.model }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
      },
      onStage,
    );
    throwIfAborted(options.signal);

    const validation = new ProbePlanValidator().validate(
      initial.snapshot,
      initial.result.plan.probeRequests,
      now,
    );
    await onStage?.('enriching');
    const executeProbes = dependencies.executeProbes ?? executeAiProbeRequests;
    const probeResult = await executeProbes(scan.executor, validation.accepted, {
      opsenseVersion: initial.snapshot.session.opsenseVersion,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    throwIfAborted(options.signal);
    const probeAudit = mergeProbeAudit(validation.audit, probeResult.records, now);
    const enrichedSnapshot = await persistEnrichedSnapshot(
      initial.snapshot,
      probeResult,
      scan.layout,
      now,
    );

    let analysis = initial;
    if (initial.result.run.status !== 'degraded' && validation.accepted.length > 0) {
      const threadId = analysisThreadId(initial);
      const final = await analyzeRunner(
        {
          provider: options.provider,
          scan: scan.scanId,
          stageMode: 'analyzing-only',
          timeoutMs: options.threadTimeoutMs,
          ...(options.config === undefined ? {} : { config: options.config }),
          ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
          ...(options.model === undefined ? {} : { model: options.model }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          ...(threadId === undefined ? {} : { threadId }),
          ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
        },
        onStage,
      );
      const finalAudit = mergeFinalAudit(probeAudit, final.result.probeAudit, now);
      analysis = { ...final, result: { ...final.result, probeAudit: finalAudit } };
      await writeJsonAtomic(final.layout.aiProbeAuditFile, finalAudit);
    } else {
      await onStage?.('analyzing');
      await writeJsonAtomic(initial.layout.aiProbeAuditFile, probeAudit);
      analysis = { ...initial, result: { ...initial.result, probeAudit } };
    }

    const reportRunner = dependencies.runReport ?? runReportWorkflow;
    const formats = [...new Set<ReportFormat>([...options.formats, 'docx', 'html'])];
    await onStage?.('rendering');
    const report = await reportRunner({
      formats,
      scan: scan.scanId,
      ...(options.config === undefined ? {} : { config: options.config }),
      ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }),
      ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
    });
    throwIfAborted(options.signal);
    return { analysis, report, scan: { ...scan, snapshot: enrichedSnapshot } };
  } finally {
    scan?.connection?.close();
  }
}

async function persistEnrichedSnapshot(
  snapshot: ScanSnapshot,
  probeResult: Awaited<ReturnType<typeof executeAiProbeRequests>>,
  layout: ScanWorkflowResult['layout'],
  now: () => Date,
): Promise<ScanSnapshot> {
  const normalized = normalizeAndMergeServices({
    artifacts: [...snapshot.artifacts, ...probeResult.artifacts],
    collectedAt: now().toISOString(),
    composeProjects: snapshot.composeProjects,
    containers: snapshot.containers,
    evidence: [...snapshot.evidence, ...probeResult.evidence],
    opsenseVersion: snapshot.session.opsenseVersion,
    processes: snapshot.processes,
    sockets: snapshot.sockets,
    systemdUnits: snapshot.systemdUnits,
    unknowns: snapshot.unknowns,
  });
  const enriched: ScanSnapshot = {
    ...snapshot,
    artifacts: normalized.artifacts,
    composeProjects: normalized.composeProjects,
    containers: normalized.containers,
    evidence: normalized.evidence,
    services: normalized.services,
    sockets: normalized.sockets,
    systemdUnits: normalized.systemdUnits,
    unknowns: normalized.unknowns,
    session: {
      ...snapshot.session,
      finishedAt: now().toISOString(),
      state: normalized.unknowns.length === 0 ? 'completed' : 'partial',
    },
  };
  const redacted = redactSnapshot(enriched, now);
  assertSchema(ScanSnapshotSchema, redacted.value);
  await Promise.all([
    writeJsonAtomic(layout.snapshotFile, redacted.value),
    writeJsonAtomic(layout.metaFile, redacted.value.session),
    writeJsonAtomic(layout.redactionReportFile, redacted.report),
  ]);
  return redacted.value;
}

function mergeProbeAudit(
  audit: AiProbeAudit,
  records: readonly {
    evidenceIds: string[];
    requestId: string;
    status: 'accepted' | 'failed';
    reason: string;
  }[],
  now: () => Date,
): AiProbeAudit {
  const executed = new Map(records.map((record) => [record.requestId, record]));
  return {
    generatedAt: now().toISOString(),
    records: audit.records.map((record) => {
      const execution = executed.get(record.request.id);
      if (record.status !== 'accepted' || execution === undefined) return record;
      return {
        evidenceIds: execution.evidenceIds,
        reason: execution.reason,
        request: record.request,
        status: execution.status,
      };
    }),
    round: 1,
  };
}

function mergeFinalAudit(
  executedAudit: AiProbeAudit,
  finalAudit: AiProbeAudit,
  now: () => Date,
): AiProbeAudit {
  const seen = new Set(executedAudit.records.map((record) => record.request.id));
  const records: ProbeAuditRecord[] = [...executedAudit.records];
  for (const record of finalAudit.records) {
    if (seen.has(record.request.id)) continue;
    records.push(
      record.status === 'accepted'
        ? {
            evidenceIds: [],
            reason: '唯一一轮补探测已完成，该请求留待下一次 inspect。',
            request: record.request,
            status: 'skipped',
          }
        : record,
    );
  }
  const result = { generatedAt: now().toISOString(), records, round: 1 as const };
  assertSchema(AiProbeAuditSchema, result);
  return result;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new WorkflowInterruptedError();
}

function analysisThreadId(result: AnalyzeWorkflowResult): string | undefined {
  return (
    result.result.run.threadId ?? result.result.analysis.threadId ?? result.result.plan.threadId
  );
}
