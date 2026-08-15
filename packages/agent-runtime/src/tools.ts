import { randomUUID } from 'node:crypto';

import {
  AgentDecisionSchema,
  AgentToolNameSchema,
  AgentToolActivitySchema,
  ExecuteGovernedProbeArgumentsSchema,
  ListCandidatesArgumentsSchema,
  ReadContextArgumentsSchema,
  ReadEvidenceArgumentsSchema,
  UpdateProjectionArgumentsSchema,
  assertSchema,
} from '@opsense/schema';
import type {
  AgentDecision,
  AgentSession,
  AgentToolActivity,
  AgentToolName,
  InventoryProjection,
} from '@opsense/schema';

import type { ContextBuilder, ContextSection } from './context.js';
import type { ProbeGovernor } from './governor.js';

export const AGENT_TOOL_NAMES = [
  'read_context',
  'read_evidence',
  'list_candidates',
  'execute_governed_probe',
  'update_projection',
] as const;

export interface ToolExecutionResult {
  status: 'completed' | 'failed';
  summary: string;
  value?: unknown;
  evidenceIds: string[];
  changedIds: string[];
  activity: AgentToolActivity;
}

export interface ToolRouterOptions {
  projection: InventoryProjection;
  context: ContextBuilder;
  governor: ProbeGovernor;
  applyProjectionUpdate?: (
    decision: Extract<AgentDecision, { kind: 'projection_update' }>,
  ) => Promise<readonly string[]> | readonly string[];
  now?: () => Date;
}

export class ToolRouter {
  private readonly projection: InventoryProjection;
  private readonly context: ContextBuilder;
  private readonly governor: ProbeGovernor;
  private readonly applyProjectionUpdate: ToolRouterOptions['applyProjectionUpdate'];
  private readonly now: () => Date;

  public constructor(options: ToolRouterOptions) {
    this.projection = options.projection;
    this.context = options.context;
    this.governor = options.governor;
    this.applyProjectionUpdate = options.applyProjectionUpdate;
    this.now = options.now ?? (() => new Date());
  }

  public setSession(session: AgentSession): void {
    this.governor.setSession(session);
  }

  public async execute(
    name: string,
    argumentsValue: unknown,
    turnId: string,
  ): Promise<ToolExecutionResult> {
    const startedAt = this.now().toISOString();
    const activityId = `tool-${randomUUID()}`;
    let result: Omit<ToolExecutionResult, 'activity'>;
    try {
      if (!isToolName(name)) throw new Error(`不支持的 Agent 工具：${name}`);
      result = await this.executeKnown(name, argumentsValue, turnId);
    } catch (error) {
      result = {
        changedIds: [],
        evidenceIds: [],
        status: 'failed',
        summary: error instanceof Error ? error.message : String(error),
      };
    }
    const activity: AgentToolActivity = {
      activityId,
      toolName: name,
      status: result.status === 'completed' ? 'completed' : 'failed',
      startedAt,
      finishedAt: this.now().toISOString(),
      argumentSummary: summarize(argumentsValue),
      resultSummary: result.summary.slice(0, 500),
      evidenceIds: result.evidenceIds,
      ...(result.status === 'failed' ? { error: result.summary } : {}),
    };
    assertSchema(AgentToolActivitySchema, activity);
    return { ...result, activity };
  }

  private async executeKnown(
    name: AgentToolName,
    value: unknown,
    turnId: string,
  ): Promise<Omit<ToolExecutionResult, 'activity'>> {
    if (name === 'read_context') {
      assertSchema(ReadContextArgumentsSchema, value);
      const args = value;
      const section = args.section as ContextSection;
      return {
        changedIds: [],
        evidenceIds: [],
        status: 'completed',
        summary: `已读取上下文章节 ${section}。`,
        value: this.context.readSection(section, args.offset ?? 0, args.limit ?? 50),
      };
    }
    if (name === 'read_evidence') {
      assertSchema(ReadEvidenceArgumentsSchema, value);
      const ids = value.ids;
      const evidence = this.context.readEvidence(ids);
      return {
        changedIds: [],
        evidenceIds: ids.filter((id) => this.projection.evidence.some((item) => item.id === id)),
        status: 'completed',
        summary: `已读取 ${evidence.length} 条证据摘要。`,
        value: evidence,
      };
    }
    if (name === 'list_candidates') {
      assertSchema(ListCandidatesArgumentsSchema, value);
      const section = value.section ?? 'services';
      const valueForSection =
        section === 'services'
          ? this.context.readSection('services')
          : section === 'paths'
            ? this.context.readSection('path_candidates')
            : this.context.readSection(section as ContextSection);
      return {
        changedIds: [],
        evidenceIds: [],
        status: 'completed',
        summary: `已列出 ${section} 候选。`,
        value: valueForSection,
      };
    }
    if (name === 'execute_governed_probe') {
      assertSchema(ExecuteGovernedProbeArgumentsSchema, value);
      const probe = await this.governor.execute(value.request);
      return {
        changedIds: [],
        evidenceIds: probe.evidenceIds,
        status: probe.status,
        summary: probe.reason,
        value: probe.value,
      };
    }
    const raw = objectValue(value);
    const updateArguments = {
      changes: raw.changes,
      evidenceIds: raw.evidenceIds,
      ...(typeof raw.reason === 'string' ? { reason: raw.reason } : {}),
    };
    assertSchema(UpdateProjectionArgumentsSchema, updateArguments);
    const decisionValue = {
      ...updateArguments,
      decisionId: typeof raw.decisionId === 'string' ? raw.decisionId : `decision:${randomUUID()}`,
      turnId: typeof raw.turnId === 'string' ? raw.turnId : turnId,
      kind: 'projection_update',
      reason: typeof raw.reason === 'string' ? raw.reason : 'Agent projection update',
      nextAction: typeof raw.nextAction === 'string' ? raw.nextAction : 'continue',
      unresolvedQuestions: Array.isArray(raw.unresolvedQuestions) ? raw.unresolvedQuestions : [],
      nextSuggestions: Array.isArray(raw.nextSuggestions) ? raw.nextSuggestions : [],
    };
    assertSchema(AgentDecisionSchema, decisionValue);
    const decision = decisionValue;
    if (decision.kind !== 'projection_update') throw new Error('projection 更新结构无效。');
    if (
      !decision.evidenceIds.every((id) => this.projection.evidence.some((item) => item.id === id))
    )
      throw new Error('projection 更新引用了不存在的 Evidence ID。');
    const changedIds =
      this.applyProjectionUpdate === undefined
        ? decision.changes.map((item) => item.objectId)
        : [...(await this.applyProjectionUpdate(decision))];
    return {
      changedIds,
      evidenceIds: [...decision.evidenceIds],
      status: 'completed',
      summary: `已登记 ${changedIds.length} 项投影变更。`,
      value: decision.changes,
    };
  }
}

function isToolName(value: string): value is AgentToolName {
  return assertToolName(value);
}

function assertToolName(value: string): value is AgentToolName {
  try {
    assertSchema(AgentToolNameSchema, value);
    return true;
  } catch {
    return false;
  }
}
function objectValue(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('工具参数必须是 JSON 对象。');
  return value as Record<string, unknown>;
}
function summarize(value: unknown): string {
  const text = JSON.stringify(value).replace(
    /("(?:password|passwd|secret|token|private[_-]?key|credential|authorization)"\s*:\s*)"[^"]*"/gi,
    '$1"[REDACTED]"',
  );
  return text.length > 500 ? `${text.slice(0, 500)}...` : text;
}
