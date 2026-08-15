import { readdir, readFile } from 'node:fs/promises';

import {
  AgentRuntime,
  ContextBuilder,
  FileAgentSessionStore,
  ProbeGovernor,
  ToolRouter,
  createAgentSession,
} from '@opsense/agent-runtime';
import { CodexAgentThreadAdapter } from '@opsense/ai-codex';
import { executeAiProbeRequests } from '@opsense/collectors';
import { buildEvidenceIndex } from '@opsense/discovery';
import { buildInventoryProjection } from '@opsense/projection';
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
import {
  createRunWorkspaceLayout,
  createWorkspaceLayout,
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
  provider: 'codex';
  resume?: string;
  scan?: string;
  signal?: AbortSignal;
  user?: string;
  workspace?: string;
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
  const source = await resolveSource(options);
  const { layout } = source;
  const snapshot = source.snapshot;
  const projection = await loadOrBuildProjection(layout, snapshot);
  const evidenceIndex = buildEvidenceIndex(projection);
  const existingSession = source.session;
  const session =
    existingSession ??
    createAgentSession({
      scanId: snapshot.session.id,
      ...(options.model === undefined ? {} : { model: options.model }),
      budgets: {
        maxRequests: options.maxProbes,
        maxRounds: options.maxProbes,
      },
    });
  const store = new FileAgentSessionStore(layout);
  if (existingSession === undefined) await store.save(session);
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
    applyProjectionUpdate: (decision) => decision.changes.map((item) => item.objectId),
  });
  const runtime = new AgentRuntime({
    scanId: snapshot.session.id,
    session,
    store,
    context,
    tools,
    thread: new CodexAgentThreadAdapter(),
    maxTurns: options.maxAgentRounds,
    ...(options.model === undefined ? {} : { model: options.model }),
    workingDirectory: layout.aiInputDirectory,
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
    return value;
  } catch {
    return buildInventoryProjection(snapshot);
  }
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
  Object.assign(projection, buildInventoryProjection(snapshot));
  Object.assign(evidenceIndex, buildEvidenceIndex(projection));
  await Promise.all([
    writeJsonAtomic(layout.snapshotFile, snapshot),
    writeJsonAtomic(layout.agentProjectionFile, projection),
  ]);
}

function mergeById<T extends { id: string }>(left: readonly T[], right: readonly T[]): T[] {
  return [...new Map([...left, ...right].map((item) => [item.id, item])).values()];
}
