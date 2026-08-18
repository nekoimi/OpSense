import { randomUUID } from 'node:crypto';

import {
  AgentDecisionSchema,
  AgentToolNameSchema,
  AgentToolActivitySchema,
  ComposeWikiArgumentsSchema,
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
  WikiNarrativeDraft,
} from '@opsense/schema';

import type { ContextBuilder, ContextSection } from './context.js';
import type { GovernedProbeResult, ProbeGovernor } from './governor.js';

export const AGENT_TOOL_NAMES = [
  'read_context',
  'read_evidence',
  'list_candidates',
  'execute_governed_probe',
  'plan_discovery',
  'update_projection',
  'compose_wiki',
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
  applyWikiComposition?: (
    draft: WikiNarrativeDraft,
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
  private readonly applyWikiComposition: ToolRouterOptions['applyWikiComposition'];
  private readonly now: () => Date;
  private session: AgentSession | undefined;

  public constructor(options: ToolRouterOptions) {
    this.projection = options.projection;
    this.context = options.context;
    this.governor = options.governor;
    this.applyProjectionUpdate = options.applyProjectionUpdate;
    this.applyDiscoveryPlan = options.applyDiscoveryPlan;
    this.applyWikiComposition = options.applyWikiComposition;
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

  public wikiCompositionStatus(): { completed: boolean; threadId?: string } {
    return {
      completed: this.projection.wikiNarrative?.provider === 'codex',
      ...(this.projection.wikiNarrative?.threadId === undefined
        ? {}
        : { threadId: this.projection.wikiNarrative.threadId }),
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
        value: this.context.readSection(section, args.offset ?? 0, args.limit),
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
      const requestedOffset = value.offset ?? 0;
      const coverage = this.session?.candidateIndexCoverage;
      if (coverage !== undefined && requestedOffset < coverage.nextOffset) {
        return {
          changedIds: [],
          evidenceIds: [],
          status: 'completed',
          summary: coverage.complete
            ? '轻量服务过滤索引已经完整读取，请直接执行 plan_discovery。'
            : `该候选页已经读取，请从 offset=${coverage.nextOffset} 继续。`,
          value: {
            alreadyRead: true,
            total: coverage.total,
            nextOffset: coverage.nextOffset,
            complete: coverage.complete,
          },
        };
      }
      if (coverage !== undefined && requestedOffset > coverage.nextOffset) {
        throw new Error(`不能跳过服务候选；下一页必须从 offset=${coverage.nextOffset} 开始。`);
      }
      const candidateIndex = this.context.listServiceCandidates(
        requestedOffset,
        value.limit ?? 500,
      );
      if (this.session !== undefined) {
        this.session.candidateIndexCoverage = {
          total: candidateIndex.total,
          nextOffset: candidateIndex.nextOffset ?? candidateIndex.total,
          complete: !candidateIndex.hasMore,
        };
      }
      return {
        changedIds: [],
        evidenceIds: [],
        status: 'completed',
        summary: '已列出轻量服务过滤索引。',
        value: candidateIndex,
      };
    }
    if (name === 'execute_governed_probe') {
      assertSchema(ExecuteGovernedProbeArgumentsSchema, value);
      const requests = 'requests' in value ? value.requests : [value.request];
      const workspace = this.projection.discoveryWorkspace;
      if (workspace?.workflowVersion === 'm20_evidence_driven') {
        const investigationServiceIds = new Set(
          workspace.investigations.flatMap((item) => item.serviceIds),
        );
        const unselected = requests.find(
          (request) => !investigationServiceIds.has(request.targetServiceId),
        );
        if (unselected !== undefined)
          throw new Error(`补探测目标尚未进入 Codex 调查工作区：${unselected.targetServiceId}。`);
      }
      if (!('requests' in value)) {
        const probe = await this.governor.execute(value.request);
        return {
          changedIds: [],
          evidenceIds: probe.evidenceIds,
          status: probe.status,
          summary: probe.reason,
          value: probe.value,
        };
      }
      const probes: GovernedProbeResult[] = await this.governor.executeBatch(requests);
      const completed = probes.filter((probe) => probe.status === 'completed').length;
      return {
        changedIds: [],
        evidenceIds: [...new Set(probes.flatMap((probe) => probe.evidenceIds))],
        status: completed === probes.length ? 'completed' : 'failed',
        summary: `批量受控探测完成 ${completed}/${probes.length} 项。`,
        value: probes,
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
    if (name === 'compose_wiki') {
      assertSchema(ComposeWikiArgumentsSchema, value);
      if (!this.classificationStatus().completed)
        throw new Error('必须先完成 Codex 服务调查，才能撰写服务器 Wiki。');
      if (this.applyWikiComposition === undefined)
        throw new Error('当前 Agent 未配置 AI Wiki 综合稿件写入器。');
      if (this.session === undefined) throw new Error('Agent session 尚未绑定到工具路由。');
      const changedIds = [...(await this.applyWikiComposition(value, this.session))];
      return {
        changedIds,
        evidenceIds: [
          ...new Set([
            ...value.serviceDescriptions.flatMap((item) => item.evidenceIds),
            ...value.keyFindings.flatMap((item) => item.evidenceIds),
          ]),
        ],
        status: 'completed',
        summary: `Codex 已完成服务器 Wiki 综合撰写：${value.serviceGroups.length} 个服务分组、${value.serviceDescriptions.length} 个服务详细描述。`,
        value: {
          executiveSummary: value.executiveSummary,
          serviceGroupCount: value.serviceGroups.length,
          serviceDescriptionCount: value.serviceDescriptions.length,
          keyFindingCount: value.keyFindings.length,
        },
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
