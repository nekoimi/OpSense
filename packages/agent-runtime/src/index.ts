import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import {
  AgentSessionSchema,
  AgentDecisionSchema,
  TranscriptEntrySchema,
  AgentTurnSchema,
  assertSchema,
} from '@opsense/schema';
import type {
  AgentSession,
  AgentDecision,
  AgentTurn,
  ProbeBudget,
  TranscriptEntry,
} from '@opsense/schema';
import { appendJsonLine, writeJsonAtomic } from '@opsense/workspace';
import type { RunWorkspaceLayout } from '@opsense/workspace';

export interface CreateAgentSessionOptions {
  scanId: string;
  now?: () => Date;
  model?: string;
  budgets?: Partial<ProbeBudget>;
  workflowVersion?: 'm19_full_candidate_review' | 'm20_evidence_driven';
}

export function createAgentSession(options: CreateAgentSessionOptions): AgentSession {
  const now = (options.now ?? (() => new Date()))().toISOString();
  const budgets: ProbeBudget = {
    maxBytes: options.budgets?.maxBytes ?? 2_000_000,
    maxDurationMs: options.budgets?.maxDurationMs ?? 120_000,
    maxRequests: options.budgets?.maxRequests ?? 8,
    maxRounds: options.budgets?.maxRounds ?? 1,
    usedBytes: options.budgets?.usedBytes ?? 0,
    usedDurationMs: options.budgets?.usedDurationMs ?? 0,
    usedRequests: options.budgets?.usedRequests ?? 0,
    usedRounds: options.budgets?.usedRounds ?? 0,
  };
  const session: AgentSession = {
    budgets,
    coverage: {},
    currentStage: 'created',
    completedProbeRequestIds: [],
    outputFiles: [],
    probeRound: 0,
    provider: 'codex',
    repairSuggestions: [],
    scanId: options.scanId,
    sessionId: `agent-${randomUUID()}`,
    startedAt: now,
    state: 'created',
    turnCount: 0,
    unresolvedQuestions: [],
    updatedAt: now,
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.workflowVersion === undefined ? {} : { workflowVersion: options.workflowVersion }),
  };
  assertSchema(AgentSessionSchema, session);
  return session;
}

export function parseAgentDecision(value: unknown): AgentDecision {
  assertSchema(AgentDecisionSchema, value);
  return value;
}

export interface AgentSessionStore {
  load(): Promise<AgentSession>;
  save(session: AgentSession): Promise<void>;
  appendTurn(turn: AgentTurn): Promise<void>;
  appendTranscript(entry: TranscriptEntry): Promise<void>;
}

export class FileAgentSessionStore implements AgentSessionStore {
  public constructor(private readonly layout: RunWorkspaceLayout) {}

  public async load(): Promise<AgentSession> {
    const value = JSON.parse(await readFile(this.layout.agentSessionFile, 'utf8')) as unknown;
    assertSchema(AgentSessionSchema, value);
    return value;
  }

  public async save(session: AgentSession): Promise<void> {
    assertSchema(AgentSessionSchema, session);
    await writeJsonAtomic(this.layout.agentSessionFile, session);
  }

  public async appendTurn(turn: AgentTurn): Promise<void> {
    assertSchema(AgentTurnSchema, turn);
    await appendJsonLine(this.layout.agentTurnsFile, turn);
  }

  public async appendTranscript(entry: TranscriptEntry): Promise<void> {
    assertSchema(TranscriptEntrySchema, entry);
    await appendJsonLine(this.layout.agentTranscriptFile, entry);
  }
}

export interface CodexPreflightResult {
  available: boolean;
  checkedAt: string;
  checks: Readonly<Record<string, boolean>>;
  threadId?: string;
  error?: string;
}

export interface CodexPreflightProbe {
  check(): Promise<Omit<CodexPreflightResult, 'checkedAt'>>;
}

export class CodexUnavailableError extends Error {
  public readonly code = 'CODEX_UNAVAILABLE';
  public readonly exitCode = 30;

  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CodexUnavailableError';
  }
}

export function failSessionForCodex(
  session: AgentSession,
  error: string,
  repairSuggestions: readonly string[],
  now: () => Date = () => new Date(),
): AgentSession {
  const finishedAt = now().toISOString();
  const failed: AgentSession = {
    ...session,
    currentStage: 'failed',
    finishedAt,
    lastError: error,
    repairSuggestions: [...repairSuggestions],
    state: 'failed',
    stopReason: 'codex_failed',
    updatedAt: finishedAt,
  };
  assertSchema(AgentSessionSchema, failed);
  return failed;
}

export interface StartAgentSessionOptions {
  session: AgentSession;
  store: AgentSessionStore;
  probe: CodexPreflightProbe;
  now?: () => Date;
  repairSuggestions?: readonly string[];
}

export async function startAgentSession(options: StartAgentSessionOptions): Promise<AgentSession> {
  const now = options.now ?? (() => new Date());
  const started: AgentSession = {
    ...options.session,
    currentStage: 'bootstrapping',
    state: 'running',
    updatedAt: now().toISOString(),
  };
  await options.store.save(started);
  try {
    const preflight = await requireCodex(options.probe, now);
    const ready: AgentSession = {
      ...started,
      ...(preflight.threadId === undefined ? {} : { threadId: preflight.threadId }),
      currentStage: 'investigating',
      updatedAt: now().toISOString(),
    };
    assertSchema(AgentSessionSchema, ready);
    await options.store.save(ready);
    return ready;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failed = failSessionForCodex(
      started,
      message,
      options.repairSuggestions ?? [
        '确认 Codex CLI/SDK 已安装并完成登录。',
        '确认目标模型可用后重新运行或使用 --resume 恢复。',
      ],
      now,
    );
    await options.store.save(failed);
    throw error;
  }
}

export async function requireCodex(
  probe: CodexPreflightProbe,
  now: () => Date = () => new Date(),
): Promise<CodexPreflightResult> {
  const checkedAt = now().toISOString();
  try {
    const result = await probe.check();
    const checked = { ...result, checkedAt };
    if (!checked.available) {
      throw new CodexUnavailableError(checked.error ?? 'Codex preflight failed.');
    }
    return checked;
  } catch (error) {
    if (error instanceof CodexUnavailableError) throw error;
    throw new CodexUnavailableError(
      `Codex preflight failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

export function createTranscriptEntry(
  sessionId: string,
  sequence: number,
  kind: TranscriptEntry['kind'],
  text: string,
  now: () => Date = () => new Date(),
  responseId?: string,
): TranscriptEntry {
  const entry: TranscriptEntry = {
    at: now().toISOString(),
    entryId: `transcript-${randomUUID()}`,
    kind,
    sequence,
    sessionId,
    text: sanitizeTranscriptText(text),
    ...(responseId === undefined ? {} : { responseId }),
  };
  assertSchema(TranscriptEntrySchema, entry);
  return entry;
}

function sanitizeTranscriptText(value: string): string {
  return value
    .replace(
      /\b(password|passwd|passphrase|secret|token|api[_-]?key)\s*[:=]\s*([^\s,;]+)/gi,
      '$1=[REDACTED]',
    )
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
      '[REDACTED PRIVATE KEY]',
    );
}

export * from './context.js';
export * from './decision-contract.js';
export * from './governor.js';
export * from './runtime.js';
export * from './tools.js';
