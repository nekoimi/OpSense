import { readdir, readFile } from 'node:fs/promises';

import {
  AgentRuntime,
  ContextBuilder,
  FileAgentSessionStore,
  ProbeGovernor,
  ToolRouter,
  createAgentSession,
  requireCodex,
} from '@opsense/agent-runtime';
import { CodexAgentThreadAdapter, CodexSdkPreflightProbe } from '@opsense/ai-codex';
import { executeAiProbeRequests } from '@opsense/collectors';
import { buildEvidenceIndex } from '@opsense/discovery';
import {
  applyProjectionDecision,
  applyDiscoveryPlan,
  applyWikiNarrative,
  buildInventoryProjection,
  promoteOrphanProcessCandidates,
} from '@opsense/projection';
import { redactSnapshot } from '@opsense/redaction';
import {
  AgentSessionSchema,
  InventoryProjectionSchema,
  ScanSnapshotSchema,
  assertSchema,
} from '@opsense/schema';
import type {
  AgentSession,
  InventoryProjection,
  ProbeRequest,
  ScanSnapshot,
} from '@opsense/schema';
import type { CodexPreflightProbe } from '@opsense/agent-runtime';
import {
  createRunWorkspaceLayout,
  createWorkspaceLayout,
  ensureWorkspace,
  ensureRunWorkspace,
  writeJsonAtomic,
} from '@opsense/workspace';
import type { RunWorkspaceLayout } from '@opsense/workspace';

import { runScanWorkflow } from './scan-workflow.js';

export interface AgentWorkflowOptions {
  acceptNewHostKey?: boolean;
  config?: string;
  focusService?: string;
  host?: string;
  identity?: string;
  maxAgentRounds: number;
  maxProbes: number;
  model?: string;
  password?: string;
  port: number;
  preflightTimeoutMs?: number;
  provider: 'codex';
  resume?: string;
  scan?: string;
  signal?: AbortSignal;
  turnTimeoutMs?: number;
  user?: string;
  workspace?: string;
  preflight?: CodexPreflightProbe;
}

export interface PreparedAgentWorkflow {
  close(): void;
  layout: RunWorkspaceLayout;
  projection: InventoryProjection;
  runtime: AgentRuntime;
  snapshot: ScanSnapshot;
}

export async function prepareAgentWorkflow(
  options: AgentWorkflowOptions,
): Promise<PreparedAgentWorkflow> {
  const workspace = createWorkspaceLayout(options.workspace);
  await ensureWorkspace(workspace.rootDirectory);
  const preflight =
    options.preflight ??
    new CodexSdkPreflightProbe({
      workingDirectory: workspace.rootDirectory,
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.preflightTimeoutMs === undefined
        ? {}
        : { timeoutMs: options.preflightTimeoutMs }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  const checked = await requireCodex(preflight);
  const cachedPreflight: CodexPreflightProbe = {
    check: async () => ({
      available: checked.available,
      checks: checked.checks,
      ...(checked.threadId === undefined ? {} : { threadId: checked.threadId }),
    }),
  };
  const source = await resolveSource(options);
  const { layout } = source;
  const snapshot = source.snapshot;
  const projection = await loadOrBuildProjection(layout, snapshot);
  let evidenceIndex = buildEvidenceIndex(projection);
  if (promoteOrphanProcessCandidates(projection, evidenceIndex.candidates).length > 0)
    evidenceIndex = buildEvidenceIndex(projection);
  const existingSession = source.session;
  const migratedFromM19 =
    existingSession !== undefined &&
    projection.discoveryWorkspace?.workflowVersion === 'm20_evidence_driven' &&
    existingSession.workflowVersion !== 'm20_evidence_driven';
  const session =
    existingSession === undefined
      ? createAgentSession({
          scanId: snapshot.session.id,
          ...(options.model === undefined ? {} : { model: options.model }),
          budgets: {
            maxRequests: options.maxProbes,
            maxRounds: options.maxProbes,
          },
          ...(projection.discoveryWorkspace === undefined
            ? {}
            : { workflowVersion: projection.discoveryWorkspace.workflowVersion }),
        })
      : migratedFromM19
        ? migrateSessionToM20(existingSession, options.maxProbes)
        : existingSession;
  const sessionModelChanged = options.model !== undefined && session.model !== options.model;
  if (options.model !== undefined) session.model = options.model;
  const store = new FileAgentSessionStore(layout);
  if (existingSession === undefined || migratedFromM19 || sessionModelChanged) {
    if (migratedFromM19)
      await writeJsonAtomic(`${layout.agentSessionFile}.m19.json`, existingSession);
    await store.save(session);
  }
  await writeJsonAtomic(layout.agentProjectionFile, projection);
  if (existingSession === undefined) await writeJsonAtomic(layout.agentHypothesesFile, []);

  const context = new ContextBuilder({ evidenceIndex, projection });
  const probeExecutor =
    source.executor === undefined
      ? undefined
      : {
          execute: async (request: ProbeRequest, signal?: AbortSignal) => {
            const execution = await executeAiProbeRequests(source.executor!, [request], {
              opsenseVersion: snapshot.session.opsenseVersion,
              ...(signal === undefined ? {} : { signal }),
            });
            const record = execution.records[0];
            return {
              evidenceIds: record?.evidenceIds ?? [],
              reason: record?.reason ?? '补探测未返回执行记录。',
              status: record?.status === 'accepted' ? ('completed' as const) : ('failed' as const),
              value: execution,
            };
          },
        };
  const governor = new ProbeGovernor({
    snapshot,
    session,
    ...(probeExecutor === undefined
      ? {}
      : {
          executor: probeExecutor,
          reconcile: async (_request, result) => {
            await reconcileProbeResult(snapshot, projection, evidenceIndex, layout, result);
          },
        }),
  });
  const tools = new ToolRouter({
    projection,
    context,
    governor,
    applyProjectionUpdate: async (decision, currentSession) => {
      const changedIds = applyProjectionDecision(projection, decision, {
        ...(currentSession.threadId === undefined ? {} : { threadId: currentSession.threadId }),
      });
      await writeJsonAtomic(layout.agentProjectionFile, projection);
      return changedIds;
    },
    applyDiscoveryPlan: async (plan, currentSession) => {
      const changedIds = applyDiscoveryPlan(projection, plan, {
        ...(currentSession.threadId === undefined ? {} : { threadId: currentSession.threadId }),
      });
      await writeJsonAtomic(layout.agentProjectionFile, projection);
      return changedIds;
    },
    applyWikiComposition: async (draft, currentSession) => {
      const changedIds = applyWikiNarrative(projection, draft, {
        ...(currentSession.model === undefined ? {} : { model: currentSession.model }),
        ...(currentSession.threadId === undefined ? {} : { threadId: currentSession.threadId }),
      });
      await writeJsonAtomic(layout.agentProjectionFile, projection);
      return changedIds;
    },
  });
  const runtime = new AgentRuntime({
    scanId: snapshot.session.id,
    session,
    store,
    context,
    tools,
    preflight: cachedPreflight,
    thread: new CodexAgentThreadAdapter(),
    maxTurns: options.maxAgentRounds,
    requireClassificationComplete: true,
    ...(options.turnTimeoutMs === undefined ? {} : { turnTimeoutMs: options.turnTimeoutMs }),
    ...(options.model === undefined ? {} : { model: options.model }),
    workingDirectory: layout.agentSandboxDirectory,
  });
  return {
    close: () => source.connection?.close(),
    layout,
    projection,
    runtime,
    snapshot,
  };
}

async function resolveSource(options: AgentWorkflowOptions): Promise<{
  connection?: { close(): void };
  executor?: Parameters<typeof executeAiProbeRequests>[0];
  layout: RunWorkspaceLayout;
  session?: AgentSession;
  snapshot: ScanSnapshot;
}> {
  if (options.host !== undefined) {
    if (options.user === undefined) throw new Error('--host requires --user.');
    const scan = await runScanWorkflow({
      host: options.host,
      port: options.port,
      user: options.user,
      retainConnection: true,
      ...(options.acceptNewHostKey === undefined
        ? {}
        : { acceptNewHostKey: options.acceptNewHostKey }),
      ...(options.config === undefined ? {} : { config: options.config }),
      ...(options.identity === undefined ? {} : { identity: options.identity }),
      ...(options.password === undefined ? {} : { password: options.password }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
    });
    return {
      ...(scan.connection === undefined ? {} : { connection: scan.connection }),
      ...(scan.executor === undefined ? {} : { executor: scan.executor }),
      layout: scan.layout,
      snapshot: scan.snapshot,
    };
  }
  if (options.resume !== undefined) {
    const found = await findSession(options.resume, options.workspace);
    return {
      layout: found.layout,
      session: found.session,
      snapshot: await readSnapshot(found.layout),
    };
  }
  if (options.scan === undefined) throw new Error('必须指定 --host、--scan 或 --resume。');
  const layout = await ensureRunWorkspace(options.scan, options.workspace);
  return { layout, snapshot: await readSnapshot(layout) };
}

async function findSession(
  sessionId: string,
  workspaceRoot?: string,
): Promise<{ layout: RunWorkspaceLayout; session: AgentSession }> {
  const workspace = createWorkspaceLayout(workspaceRoot);
  const entries = await readdir(workspace.runsDirectory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const layout = createRunWorkspaceLayout(entry.name, workspaceRoot);
    try {
      const value = JSON.parse(await readFile(layout.agentSessionFile, 'utf8')) as unknown;
      assertSchema(AgentSessionSchema, value);
      if (value.sessionId === sessionId) return { layout, session: value };
    } catch {
      // A run without an Agent session is expected.
    }
  }
  throw new Error(`未找到 Agent session：${sessionId}`);
}

async function readSnapshot(layout: RunWorkspaceLayout): Promise<ScanSnapshot> {
  const value = JSON.parse(await readFile(layout.snapshotFile, 'utf8')) as unknown;
  assertSchema(ScanSnapshotSchema, value);
  return value;
}

async function loadOrBuildProjection(
  layout: RunWorkspaceLayout,
  snapshot: ScanSnapshot,
): Promise<InventoryProjection> {
  try {
    const value = JSON.parse(await readFile(layout.agentProjectionFile, 'utf8')) as unknown;
    assertSchema(InventoryProjectionSchema, value);
    if (value.discoveryWorkspace === undefined)
      await writeJsonAtomic(`${layout.agentProjectionFile}.m19.json`, value);
    return buildInventoryProjection(snapshot, {
      mode: 'agent',
      previousProjection: value,
      workflowVersion: 'm20_evidence_driven',
    });
  } catch {
    return buildInventoryProjection(snapshot, {
      mode: 'agent',
      workflowVersion: 'm20_evidence_driven',
    });
  }
}

function migrateSessionToM20(session: AgentSession, maxProbes: number): AgentSession {
  const migrated: AgentSession = {
    ...session,
    budgets: {
      ...session.budgets,
      maxRequests: maxProbes,
      maxRounds: maxProbes,
      usedBytes: 0,
      usedDurationMs: 0,
      usedRequests: 0,
      usedRounds: 0,
    },
    completedProbeRequestIds: [],
    coverage: { classification: 0 },
    currentStage: 'partial',
    outputFiles: [],
    probeRound: 0,
    repairSuggestions: [],
    state: 'partial',
    stopReason: 'budget_exhausted',
    unresolvedQuestions: ['旧 M19 全量候选审查会话已迁移到 M20 证据驱动调查流程。'],
    workflowVersion: 'm20_evidence_driven',
  };
  delete migrated.lastError;
  delete migrated.threadId;
  return migrated;
}

async function reconcileProbeResult(
  snapshot: ScanSnapshot,
  projection: InventoryProjection,
  evidenceIndex: ReturnType<typeof buildEvidenceIndex>,
  layout: RunWorkspaceLayout,
  result: { value?: unknown },
): Promise<void> {
  const value = result.value;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return;
  const payload = value as Awaited<ReturnType<typeof executeAiProbeRequests>>;
  if (!Array.isArray(payload.evidence) || !Array.isArray(payload.artifacts)) return;
  const merged: ScanSnapshot = {
    ...snapshot,
    artifacts: mergeById(snapshot.artifacts, payload.artifacts),
    evidence: mergeById(snapshot.evidence, payload.evidence),
  };
  const redacted = redactSnapshot(merged).value;
  Object.assign(snapshot, redacted);
  Object.assign(
    projection,
    buildInventoryProjection(snapshot, {
      mode: 'agent',
      previousProjection: projection,
      workflowVersion:
        projection.discoveryWorkspace?.workflowVersion ?? 'm19_full_candidate_review',
    }),
  );
  Object.assign(evidenceIndex, buildEvidenceIndex(projection));
  await Promise.all([
    writeJsonAtomic(layout.snapshotFile, snapshot),
    writeJsonAtomic(layout.agentProjectionFile, projection),
  ]);
}

function mergeById<T extends { id: string }>(left: readonly T[], right: readonly T[]): T[] {
  return [...new Map([...left, ...right].map((item) => [item.id, item])).values()];
}
