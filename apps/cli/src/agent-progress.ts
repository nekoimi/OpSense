import type { AgentSession, InventoryProjection } from '@opsense/schema';
import type { AgentRuntimeProgress } from '@opsense/agent-runtime';

export interface AgentProgressSnapshot {
  activity?: AgentRuntimeProgress;
  activeInvestigations: string[];
  assessedPathCount: number;
  assessedServiceCount: number;
  classificationCompleted: boolean;
  discoveryCompleted: boolean;
  planningCompleted: boolean;
  filteredGroupCount: number;
  filteredObjectCount: number;
  investigationCounts: {
    active: number;
    completed: number;
    needsReview: number;
    queued: number;
    total: number;
  };
  model: string;
  phase: string;
  probes: { max: number; used: number };
  rawObjectCount: number;
  selectedServiceCount: number;
  state: string;
  triagedObjectCount: number;
  turnCount: number;
  unresolvedQuestions: string[];
  wikiCompleted: boolean;
}

export function buildAgentProgressSnapshot(
  session: AgentSession,
  projection: InventoryProjection,
  activity?: AgentRuntimeProgress,
): AgentProgressSnapshot {
  const workspace = projection.discoveryWorkspace;
  const investigations = workspace?.investigations ?? [];
  const selectedServiceIds = new Set(investigations.flatMap((item) => item.serviceIds));
  const reviewedServiceIds = new Set(projection.reviewedServiceIds ?? []);
  const rawObjectIds = new Set([
    ...projection.services.map((item) => item.id),
    ...projection.systemdUnits.map((item) => item.id),
    ...projection.processes.map((item) => item.id),
    ...projection.sockets.map((item) => item.id),
    ...projection.containers.map((item) => item.id),
    ...projection.composeProjects.map((item) => item.id),
    ...(projection.pathSeeds ?? []).map((item) => item.id),
  ]);
  const triagedObjectIds = new Set(
    [
      ...investigations.flatMap((item) => item.sourceObjectIds),
      ...(workspace?.filteredGroups.flatMap((item) => item.sourceObjectIds) ?? []),
    ].filter((id) => rawObjectIds.has(id)),
  );
  const completed = investigations.filter((item) => item.status === 'resolved').length;
  const needsReview = investigations.filter((item) => item.status === 'needs_review').length;
  const active = investigations.filter((item) => item.status === 'investigating').length;
  const queued = investigations.filter((item) => item.status === 'selected').length;

  return {
    ...(activity === undefined ? {} : { activity }),
    activeInvestigations: investigations
      .filter((item) => item.status === 'investigating' || item.status === 'selected')
      .slice(0, 3)
      .map((item) => item.label),
    assessedPathCount: (projection.pathAssessments ?? []).filter((assessment) =>
      assessment.serviceIds.some((id) => selectedServiceIds.has(id)),
    ).length,
    assessedServiceCount: [...selectedServiceIds].filter((id) => reviewedServiceIds.has(id)).length,
    classificationCompleted: projection.classificationCompleted ?? false,
    discoveryCompleted: workspace?.discoveryCompleted ?? false,
    planningCompleted: workspace?.planningCompleted ?? false,
    filteredGroupCount: workspace?.filteredGroups.length ?? 0,
    filteredObjectCount:
      workspace?.filteredGroups.reduce((total, item) => total + item.sourceObjectIds.length, 0) ??
      0,
    investigationCounts: {
      active,
      completed,
      needsReview,
      queued,
      total: investigations.length,
    },
    model: session.model ?? 'Codex default',
    phase: progressPhase(session, projection),
    probes: { max: session.budgets.maxRequests, used: session.budgets.usedRequests },
    rawObjectCount: rawObjectIds.size,
    selectedServiceCount: selectedServiceIds.size,
    state: stateLabel(session.state),
    triagedObjectCount: triagedObjectIds.size,
    turnCount: session.turnCount,
    unresolvedQuestions: session.unresolvedQuestions,
    wikiCompleted: projection.wikiNarrative?.provider === 'codex',
  };
}

export function formatAgentProgress(snapshot: AgentProgressSnapshot): string[] {
  const investigations = snapshot.investigationCounts;
  return [
    `[Agent] ${snapshot.state} | ${snapshot.phase} | 模型 ${snapshot.model} | Turn ${snapshot.turnCount}`,
    `  调查：完成 ${investigations.completed}/${investigations.total}，进行中 ${investigations.active}，排队 ${investigations.queued}，待确认 ${investigations.needsReview}`,
    `  服务：已整理 ${snapshot.assessedServiceCount}/${snapshot.selectedServiceCount} | 路径：已归类 ${snapshot.assessedPathCount}`,
    `  证据：已分流 ${snapshot.triagedObjectCount}/${snapshot.rawObjectCount} | 过滤 ${snapshot.filteredGroupCount} 组、${snapshot.filteredObjectCount} 个对象`,
    `  探测：${snapshot.probes.used}/${snapshot.probes.max} 个请求`,
    `  门禁：计划 ${statusWord(snapshot.planningCompleted)} | 调查收尾 ${statusWord(snapshot.discoveryCompleted)} | 分类 ${statusWord(snapshot.classificationCompleted)} | Wiki ${snapshot.wikiCompleted ? '已生成' : '未生成'}`,
    ...(snapshot.activity === undefined
      ? []
      : [`  当前动作：${formatCurrentActivity(snapshot.activity)}`]),
    ...(snapshot.activity?.lastTool === undefined
      ? []
      : [`  最近工具：${formatLastTool(snapshot.activity.lastTool)}`]),
    ...(snapshot.activeInvestigations.length === 0
      ? []
      : [`  当前：${snapshot.activeInvestigations.join('、')}`]),
    ...(snapshot.unresolvedQuestions.length === 0
      ? []
      : [
          `  未解决：${snapshot.unresolvedQuestions.length} 项；${truncate(snapshot.unresolvedQuestions[0] ?? '', 140)}`,
        ]),
  ];
}

export function formatAgentHeartbeat(
  snapshot: AgentProgressSnapshot,
  elapsedMs: number,
  nowMs = Date.now(),
): string {
  const investigations = snapshot.investigationCounts;
  const activity = snapshot.activity;
  const currentTurn = activity?.current.sequence ?? snapshot.turnCount;
  const activityElapsed =
    activity === undefined
      ? undefined
      : Math.max(0, nowMs - Date.parse(activity.current.startedAt));
  return [
    `[Agent] Codex 处理中 | ${snapshot.phase} | 本次 ${formatDuration(elapsedMs)} | Turn ${currentTurn}`,
    `调查 ${investigations.completed}/${investigations.total}（进行中 ${investigations.active}，排队 ${investigations.queued}，待确认 ${investigations.needsReview}）`,
    `服务 ${snapshot.assessedServiceCount}/${snapshot.selectedServiceCount}`,
    `门禁 计划:${shortStatus(snapshot.planningCompleted)} 调查:${shortStatus(snapshot.discoveryCompleted)} Wiki:${snapshot.wikiCompleted ? '完成' : '未完成'}`,
    `探测 ${snapshot.probes.used}/${snapshot.probes.max}`,
    ...(activity === undefined
      ? []
      : [
          `当前 ${truncate(activity.current.detail, 80)}${activityElapsed === undefined ? '' : ` ${formatDuration(activityElapsed)}`}`,
        ]),
    ...(activity?.lastTool === undefined ? [] : [`上一步 ${formatLastTool(activity.lastTool)}`]),
  ].join(' | ');
}

export function formatAgentCompletionProgress(snapshot: AgentProgressSnapshot): string {
  const investigations = snapshot.investigationCounts;
  return [
    `计划=${statusWord(snapshot.planningCompleted)}`,
    `调查=${investigations.completed}/${investigations.total}完成` +
      `（进行中${investigations.active}，排队${investigations.queued}，待确认${investigations.needsReview}）`,
    `服务=${snapshot.assessedServiceCount}/${snapshot.selectedServiceCount}`,
    `调查收尾=${statusWord(snapshot.discoveryCompleted)}`,
    `Wiki=${snapshot.wikiCompleted ? '已生成' : '未生成'}`,
  ].join(', ');
}

function progressPhase(session: AgentSession, projection: InventoryProjection): string {
  if (session.state === 'completed') return '已完成';
  if (session.state === 'failed') return '执行失败';
  if (session.state === 'interrupted') return '已中断';
  if (session.currentStage === 'bootstrapping') return '初始化 Codex';
  if (session.currentStage === 'composing') return 'AI 撰写服务器 Wiki';
  if (session.currentStage === 'validating' || session.currentStage === 'reviewing')
    return '质量检查';
  const workspace = projection.discoveryWorkspace;
  if (workspace === undefined) return '兼容语义审查';
  if (!workspace.planningCompleted) return '证据筛选与调查规划';
  if (!workspace.discoveryCompleted) return '服务调查与按需探测';
  if (projection.wikiNarrative === undefined) return 'AI 撰写服务器 Wiki';
  return 'Wiki 质量检查';
}

function stateLabel(state: AgentSession['state']): string {
  const labels: Record<AgentSession['state'], string> = {
    completed: '已完成',
    created: '已创建',
    failed: '失败',
    interrupted: '已中断',
    partial: '可继续',
    running: '运行中',
  };
  return labels[state];
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes === 0 ? `${seconds}s` : `${minutes}m ${seconds}s`;
}

function formatCurrentActivity(progress: AgentRuntimeProgress): string {
  const sequence = progress.current.sequence;
  return `${sequence === undefined ? '' : `Turn ${sequence} `}${progress.current.detail}`;
}

function formatLastTool(lastTool: NonNullable<AgentRuntimeProgress['lastTool']>): string {
  const status = lastTool.status === 'completed' ? '成功' : '失败';
  return `Turn ${lastTool.sequence} ${lastTool.toolName} ${status}: ${truncate(lastTool.resultSummary, 120)}`;
}

function statusWord(value: boolean): string {
  return value ? '已完成' : '未完成';
}

function shortStatus(value: boolean): string {
  return value ? '完成' : '未完成';
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}
