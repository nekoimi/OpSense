import { randomUUID } from 'node:crypto';

import {
  AgentDecisionSchema,
  AgentToolNameSchema,
  AgentToolActivitySchema,
  ExecuteGovernedProbeArgumentsSchema,
  ListCandidatesArgumentsSchema,
  PlanDiscoveryArgumentsSchema,
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
  PlanDiscoveryArguments,
} from '@opsense/schema';

import type { ContextBuilder, ContextSection } from './context.js';
import type { ProbeGovernor } from './governor.js';

export const AGENT_TOOL_NAMES = [
  'read_context',
  'read_evidence',
  'list_candidates',
  'execute_governed_probe',
  'plan_discovery',
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
    session: AgentSession,
  ) => Promise<readonly string[]> | readonly string[];
  applyDiscoveryPlan?: (
    plan: PlanDiscoveryArguments,
    session: AgentSession,
  ) => Promise<readonly string[]> | readonly string[];
  now?: () => Date;
}

export class ToolRouter {
  private readonly projection: InventoryProjection;
  private readonly context: ContextBuilder;
  private readonly governor: ProbeGovernor;
  private readonly applyProjectionUpdate: ToolRouterOptions['applyProjectionUpdate'];
  private readonly applyDiscoveryPlan: ToolRouterOptions['applyDiscoveryPlan'];
  private readonly now: () => Date;
  private session: AgentSession | undefined;

  public constructor(options: ToolRouterOptions) {
    this.projection = options.projection;
    this.context = options.context;
    this.governor = options.governor;
    this.applyProjectionUpdate = options.applyProjectionUpdate;
    this.applyDiscoveryPlan = options.applyDiscoveryPlan;
    this.now = options.now ?? (() => new Date());
  }

  public setSession(session: AgentSession): void {
    this.session = session;
    this.governor.setSession(session);
  }

  public classificationStatus(): {
    candidatePathCount: number;
    candidateServiceCount: number;
    completed: boolean;
    reviewedPathCount: number;
    reviewedServiceCount: number;
    unreviewedPathKeys: string[];
    unreviewedServiceIds: string[];
  } {
    const evidenceDriven =
      this.projection.discoveryWorkspace?.workflowVersion === 'm20_evidence_driven';
    const candidateServiceIds = evidenceDriven
      ? [
          ...new Set(
            this.projection.discoveryWorkspace?.investigations.flatMap((item) => item.serviceIds) ??
              [],
          ),
        ]
      : this.projection.services.map((service) => service.id);
    const candidatePathKeys = evidenceDriven ? [] : (this.projection.candidatePathKeys ?? []);
    const reviewed = new Set(this.projection.reviewedServiceIds ?? []);
    const reviewedPaths = new Set(this.projection.reviewedPathKeys ?? []);
    const unreviewedServiceIds = candidateServiceIds.filter(
      (serviceId) => !reviewed.has(serviceId),
    );
    const unreviewedPathKeys = candidatePathKeys.filter((key) => !reviewedPaths.has(key));
    return {
      candidatePathCount: candidatePathKeys.length,
      candidateServiceCount: candidateServiceIds.length,
      completed:
        this.projection.classificationProvider === 'codex' &&
        this.projection.classificationCompleted === true &&
        unreviewedServiceIds.length === 0 &&
        (evidenceDriven || unreviewedPathKeys.length === 0),
      reviewedPathCount: candidatePathKeys.length - unreviewedPathKeys.length,
      reviewedServiceCount: candidateServiceIds.length - unreviewedServiceIds.length,
      unreviewedPathKeys,
      unreviewedServiceIds,
    };
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
        value: this.context.readSection(section, args.offset ?? 0, args.limit ?? 3),
      };
    }
    if (name === 'read_evidence') {
      assertSchema(ReadEvidenceArgumentsSchema, value);
      const ids = value.ids ?? [];
      const evidence =
        value.serviceId === undefined
          ? this.context.readEvidence(ids)
          : this.context.readEvidenceForService(value.serviceId, value.field);
      const returnedEvidenceIds = [
        ...new Set([
          ...ids.filter((id) => this.projection.evidence.some((item) => item.id === id)),
          ...evidence.flatMap((item) =>
            item !== null && typeof item === 'object' && 'id' in item && typeof item.id === 'string'
              ? [item.id]
              : [],
          ),
        ]),
      ];
      return {
        changedIds: [],
        evidenceIds: returnedEvidenceIds,
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
          ? this.context.readSection('services', value.offset ?? 0, value.limit ?? 3)
          : section === 'paths'
            ? this.context.readSection('path_candidates', value.offset ?? 0, value.limit ?? 3)
            : this.context.readSection(
                section as ContextSection,
                value.offset ?? 0,
                value.limit ?? 3,
              );
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
      const workspace = this.projection.discoveryWorkspace;
      if (workspace?.workflowVersion === 'm20_evidence_driven') {
        const investigationServiceIds = new Set(
          workspace.investigations.flatMap((item) => item.serviceIds),
        );
        if (!investigationServiceIds.has(value.request.targetServiceId))
          throw new Error(
            `补探测目标尚未进入 Codex 调查工作区：${value.request.targetServiceId}。`,
          );
      }
      const probe = await this.governor.execute(value.request);
      return {
        changedIds: [],
        evidenceIds: probe.evidenceIds,
        status: probe.status,
        summary: probe.reason,
        value: probe.value,
      };
    }
    if (name === 'plan_discovery') {
      assertSchema(PlanDiscoveryArgumentsSchema, value);
      if (this.applyDiscoveryPlan === undefined)
        throw new Error('当前 Agent 未配置 M20 调查计划更新器。');
      if (this.session === undefined) throw new Error('Agent session 尚未绑定到工具路由。');
      const before = discoverySummary(this.projection);
      const changedIds = [...(await this.applyDiscoveryPlan(value, this.session))];
      const after = discoverySummary(this.projection);
      return {
        changedIds,
        evidenceIds: [
          ...new Set([
            ...value.investigations.flatMap((item) => item.evidenceIds),
            ...value.discoveredServices.flatMap((item) => item.evidenceIds),
            ...value.filteredGroups.flatMap((item) => item.evidenceIds),
          ]),
        ],
        status: 'completed',
        summary: `已应用 Codex 调查计划。${before} -> ${after}`,
        value,
      };
    }
    const raw = objectValue(value);
    const updateArguments = {
      changes: raw.changes,
      evidenceIds: raw.evidenceIds,
      ...(typeof raw.reason === 'string' ? { reason: raw.reason } : {}),
    };
    assertSchema(UpdateProjectionArgumentsSchema, updateArguments);
    updateArguments.evidenceIds = [
      ...new Set([
        ...updateArguments.evidenceIds,
        ...updateArguments.changes.flatMap((item) => item.assessment.evidenceIds),
      ]),
    ];
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
    const changeEvidenceIds = decision.changes.flatMap((item) => item.assessment.evidenceIds);
    if (!changeEvidenceIds.every((id) => decision.evidenceIds.includes(id)))
      throw new Error('projection 更新的 evidenceIds 必须覆盖所有字段级 Evidence ID。');
    if (this.applyProjectionUpdate === undefined)
      throw new Error('当前 Agent 未配置真实 Projection 更新器。');
    if (this.session === undefined) throw new Error('Agent session 尚未绑定到工具路由。');
    const before = projectionChangeSummary(this.projection, decision);
    const changedIds = [...(await this.applyProjectionUpdate(decision, this.session))];
    const after = projectionChangeSummary(this.projection, decision);
    return {
      changedIds,
      evidenceIds: [...decision.evidenceIds],
      status: 'completed',
      summary: `已应用 ${changedIds.length} 个对象的 Codex 投影变更。${before} -> ${after}`,
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

function projectionChangeSummary(
  projection: InventoryProjection,
  decision: Extract<AgentDecision, { kind: 'projection_update' }>,
): string {
  const serviceIds = new Set(decision.changes.map((item) => item.assessment.serviceId));
  const assessments = projection.serviceAssessments
    .filter((item) => serviceIds.has(item.serviceId))
    .map((item) => `${item.serviceId}:${item.role}/${item.reportPlacement}`);
  const pathCount = (projection.pathAssessments ?? []).filter((item) =>
    item.serviceIds.some((serviceId) => serviceIds.has(serviceId)),
  ).length;
  return `[services=${assessments.join(',') || 'none'};paths=${pathCount}]`;
}

function discoverySummary(projection: InventoryProjection): string {
  const workspace = projection.discoveryWorkspace;
  if (workspace === undefined) return '[discovery=legacy]';
  return `[investigations=${workspace.investigations.length};discoveredServices=${workspace.discoveredServices.length};filteredGroups=${workspace.filteredGroups.length};completed=${workspace.discoveryCompleted}]`;
}
