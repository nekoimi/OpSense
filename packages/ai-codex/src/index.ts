import { Codex } from '@openai/codex-sdk';
import type { RunResult, Thread, ThreadOptions } from '@openai/codex-sdk';
import {
  ProbePlanValidator,
  createFallbackAnalysis,
  governAiPlan,
  markProbeRequestsOffline,
} from '@opsense/ai-provider';
import type {
  AiProvider,
  AnalysisInput,
  AnalysisOptions,
  AnalysisResult,
} from '@opsense/ai-provider';
import {
  AiAnalysisProposalSchema,
  AiPlanProposalSchema,
  SchemaValidationError,
  assertSchema,
} from '@opsense/schema';
import type {
  AiAnalysis,
  AiAnalysisProposal,
  AiPlan,
  AiPlanProposal,
  ScanSnapshot,
} from '@opsense/schema';

interface CodexClient {
  resumeThread(id: string, options?: ThreadOptions): Thread;
  startThread(options?: ThreadOptions): Thread;
}

export interface CodexProviderOptions {
  client?: CodexClient;
  now?: () => Date;
}

export class CodexProvider implements AiProvider {
  public readonly name = 'codex';
  private readonly client: CodexClient;
  private readonly now: () => Date;

  public constructor(options: CodexProviderOptions = {}) {
    this.client = options.client ?? new Codex();
    this.now = options.now ?? (() => new Date());
  }

  public async analyze(
    input: AnalysisInput,
    options: AnalysisOptions = {},
  ): Promise<AnalysisResult> {
    const started = this.now();
    const maxRetries = options.maxRetries ?? 2;
    let retryCount = 0;
    let threadId = options.threadId;
    try {
      const threadOptions: ThreadOptions = {
        approvalPolicy: 'never',
        networkAccessEnabled: false,
        sandboxMode: 'read-only',
        skipGitRepoCheck: true,
        workingDirectory: input.aiInputDirectory,
        ...(options.model === undefined ? {} : { model: options.model }),
      };
      const thread =
        threadId === undefined
          ? this.client.startThread(threadOptions)
          : this.client.resumeThread(threadId, threadOptions);
      const proposals: AiPlanProposal[] = [];
      for (const batch of classificationBatches(input.snapshot, input.baselinePlan)) {
        const planResult = await runStructured<AiPlanProposal>(
          thread,
          classificationPrompt(batch),
          AiPlanProposalSchema,
          timeoutSignal(options.signal, options.timeoutMs ?? 120_000),
          maxRetries,
        );
        retryCount += planResult.retryCount;
        proposals.push(planResult.value);
      }
      threadId = thread.id ?? threadId;
      const proposal = mergeProposals(proposals);
      const rawPlan: AiPlan = {
        pathAssessments: proposal.pathAssessments,
        probeRequests: proposal.probeRequests,
        serviceAssessments: proposal.serviceAssessments,
        generatedAt: this.now().toISOString(),
        provider: this.name,
        ...(options.model === undefined ? {} : { model: options.model }),
        ...(threadId === undefined ? {} : { threadId }),
      };
      const plan = governAiPlan(input.snapshot, rawPlan, input.baselinePlan, this.now);
      const validated = new ProbePlanValidator().validate(
        input.snapshot,
        plan.probeRequests,
        this.now,
      );
      const probeAudit = markProbeRequestsOffline(validated.audit);
      const finalResult = await runStructured<AiAnalysisProposal>(
        thread,
        finalPrompt(
          input.snapshot,
          plan,
          probeAudit.records.map((item) => ({
            id: item.request.id,
            status: item.status,
            reason: item.reason,
          })),
        ),
        AiAnalysisProposalSchema,
        timeoutSignal(options.signal, options.timeoutMs ?? 120_000),
        maxRetries,
      );
      retryCount += finalResult.retryCount;
      const analysis = governAnalysis(
        input.snapshot,
        {
          ...finalResult.value,
          generatedAt: this.now().toISOString(),
          pathAssessments: plan.pathAssessments,
          provider: this.name,
          serviceAssessments: plan.serviceAssessments,
        },
        plan,
        options.model,
        thread.id ?? threadId,
        this.now,
      );
      const finished = this.now();
      return {
        analysis,
        plan,
        probeAudit,
        run: {
          durationMs: Math.max(0, finished.getTime() - started.getTime()),
          finishedAt: finished.toISOString(),
          provider: this.name,
          retryCount,
          startedAt: started.toISOString(),
          status: 'completed',
          ...(options.model === undefined ? {} : { model: options.model }),
          ...(thread.id === null ? {} : { threadId: thread.id }),
        },
      };
    } catch (error) {
      const finished = this.now();
      const fallbackPlan: AiPlan = {
        ...input.baselinePlan,
        generatedAt: finished.toISOString(),
        provider: 'baseline',
      };
      const validated = new ProbePlanValidator().validate(
        input.snapshot,
        fallbackPlan.probeRequests,
        this.now,
      );
      const message = error instanceof Error ? error.message : String(error);
      return {
        analysis: createFallbackAnalysis(
          input.snapshot,
          fallbackPlan,
          'baseline',
          this.now,
          `Codex 分析不可用，已降级到本地基线分类：${message}`,
        ),
        plan: fallbackPlan,
        probeAudit: markProbeRequestsOffline(validated.audit),
        run: {
          durationMs: Math.max(0, finished.getTime() - started.getTime()),
          error: message,
          finishedAt: finished.toISOString(),
          provider: this.name,
          retryCount,
          startedAt: started.toISOString(),
          status: 'degraded',
          ...(options.model === undefined ? {} : { model: options.model }),
          ...(threadId === undefined ? {} : { threadId }),
        },
      };
    }
  }
}

async function runStructured<T>(
  thread: Thread,
  prompt: string,
  schema: typeof AiPlanProposalSchema | typeof AiAnalysisProposalSchema,
  signal: AbortSignal,
  maxRetries: number,
): Promise<{ retryCount: number; value: T }> {
  const initial = await runTurn(thread, prompt, signal, maxRetries);
  let result = initial.result;
  let transportRetries = initial.retryCount;
  for (let retryCount = 0; retryCount <= maxRetries; retryCount += 1) {
    try {
      const value = parseJson(result);
      assertSchema(schema, value);
      return { retryCount: transportRetries + retryCount, value: value as T };
    } catch (error) {
      if (retryCount === maxRetries) throw error;
      const repair = await runTurn(thread, repairPrompt(error), signal, maxRetries);
      result = repair.result;
      transportRetries += repair.retryCount;
    }
  }
  throw new Error('Codex structured output retry loop ended unexpectedly.');
}

async function runTurn(
  thread: Thread,
  prompt: string,
  signal: AbortSignal,
  maxRetries: number,
): Promise<{ result: RunResult; retryCount: number }> {
  for (let retryCount = 0; retryCount <= maxRetries; retryCount += 1) {
    try {
      return { result: await thread.run(prompt, { signal }), retryCount };
    } catch (error) {
      if (retryCount === maxRetries || signal.aborted || !isTransientError(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * (retryCount + 1)));
    }
  }
  throw new Error('Codex transport retry loop ended unexpectedly.');
}

function isTransientError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /overloaded|temporar|try again|stream disconnected|connection|ECONN|rate limit|timeout/i.test(
    message,
  );
}

function parseJson(result: RunResult): unknown {
  const source = result.finalResponse.trim();
  const unfenced = source.startsWith('```')
    ? source.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    : source;
  try {
    return JSON.parse(unfenced) as unknown;
  } catch (error) {
    throw new Error(
      `Codex returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function repairPrompt(error: unknown): string {
  const detail =
    error instanceof SchemaValidationError || error instanceof Error
      ? error.message
      : String(error);
  return `上一轮输出未通过本地校验：${detail}\n请只返回符合上一轮 JSON Schema 的完整 JSON 对象，不要添加 Markdown、解释或命令。`;
}

interface ClassificationBatch {
  candidates: unknown[];
  evidenceIndex: unknown[];
}

function classificationPrompt(batch: ClassificationBatch): string {
  return `下面是 OpSense 本地基线已保留的服务候选和对应 Evidence 索引：
${JSON.stringify(batch)}

任务：审查本批候选。只在基线分类需要调整时输出对应 serviceAssessments 或 pathAssessments；无需复制未变化的条目。在确有证据缺口时提出 probeRequests。

硬约束：
1. 不得调用工具、执行命令、修改文件、访问网络、连接服务器或输出远程 Shell 命令。
2. 不得删除候选或修改状态、端口、路径、ID、部署方式等事实字段。
3. role 仅可为 application、middleware、infrastructure、system、unknown。
4. reportPlacement 仅可为 primary、supporting、system_summary、needs_review。
5. 普通 Linux 系统 unit 可归入 system_summary；失败、外部监听、自定义路径、Docker、Compose 候选不得静默隐藏。
6. ProbeRequest 只允许 directory_metadata、directory_listing、config_summary、path_search，禁止输出 Shell。
7. path_search 搜索词只能来自已采集服务名、进程可执行名、systemd unit、容器镜像或 Compose 标签。
8. 所有判断只能引用 evidence-index.json 中存在的 Evidence ID，AI 确定程度不得为 confirmed。
9. 返回完整 JSON，不要 Markdown。`;
}

function finalPrompt(snapshot: ScanSnapshot, plan: AiPlan, probeAudit: unknown): string {
  return `基于同一 thread 中的分类结果和以下紧凑事实生成最终分析提案：
${JSON.stringify(finalAnalysisPayload(snapshot, plan, probeAudit))}

要求：
1. 不要再次输出服务或路径分类，本地会从已治理计划合并。
2. hostSummary、storageSummary、serviceSummaries、findings、unknowns 必须明确区分事实与推断。
3. 只能引用输入中列出的 Evidence ID；不得调用工具或执行命令，不得把 inferred/unknown 写成 confirmed，不得编造密码、连接串、服务依赖或运维流程。
4. 重要结论必须引用存在的 Evidence ID；证据不足时写入 unknowns。
5. 为证据充分且有交付价值的主要服务、支撑组件或待确认候选生成 serviceSummaries，避免为普通系统服务逐条写摘要。
6. 只返回符合 JSON Schema 的完整 JSON，不要 Markdown、命令或额外说明。`;
}

function classificationBatches(snapshot: ScanSnapshot, baseline: AiPlan): ClassificationBatch[] {
  const assessmentById = new Map(baseline.serviceAssessments.map((item) => [item.serviceId, item]));
  const units = new Map(snapshot.systemdUnits.map((item) => [item.id, item]));
  const processes = new Map(snapshot.processes.map((item) => [item.pid, item]));
  const sockets = new Map(snapshot.sockets.map((item) => [item.id, item]));
  const containers = new Map(snapshot.containers.map((item) => [item.id, item]));
  const candidates = snapshot.services.flatMap((service) => {
    const baselineAssessment = assessmentById.get(service.id);
    if (baselineAssessment?.reportPlacement === 'system_summary') return [];
    return [
      {
        baseline: baselineAssessment,
        service: {
          id: service.id,
          name: service.name,
          displayName: service.displayName,
          status: service.status,
          deploymentType: service.deploymentType,
          enabledAtBoot: service.enabledAtBoot,
          startCommand: service.startCommand,
          paths: {
            deploy: service.deployDirectories,
            config: service.configFiles,
            environment: service.environmentFiles,
            log: service.logLocations,
            data: service.dataDirectories,
          },
          units: service.systemdUnitIds.flatMap((id) => {
            const unit = units.get(id);
            return unit === undefined
              ? []
              : [
                  {
                    id,
                    name: unit.name,
                    description: unit.description,
                    execStart: unit.execStart,
                    fragmentPath: unit.fragmentPath,
                  },
                ];
          }),
          processes: service.processIds.flatMap((pid) => {
            const process = processes.get(pid);
            return process === undefined
              ? []
              : [{ pid, command: process.command, executablePath: process.executablePath }];
          }),
          sockets: service.socketIds.flatMap((id) => {
            const socket = sockets.get(id);
            return socket === undefined
              ? []
              : [
                  {
                    id,
                    protocol: socket.protocol,
                    address: socket.localAddress,
                    port: socket.localPort,
                    exposed: socket.exposed,
                  },
                ];
          }),
          containers: service.containerIds.flatMap((id) => {
            const container = containers.get(id);
            return container === undefined
              ? []
              : [
                  {
                    id,
                    name: container.name,
                    image: container.image,
                    state: container.state,
                    mounts: container.mounts,
                    ports: container.ports,
                  },
                ];
          }),
          evidenceIds: service.evidenceIds,
        },
      },
    ];
  });
  const batches: ClassificationBatch[] = [];
  for (let index = 0; index < candidates.length; index += 30) {
    const values = candidates.slice(index, index + 30);
    const ids = new Set(values.flatMap((item) => item.service.evidenceIds));
    batches.push({
      candidates: values,
      evidenceIndex: snapshot.evidence
        .filter((item) => ids.has(item.id))
        .map((item) => ({
          id: item.id,
          kind: item.kind,
          source: item.source,
          field: item.field,
          status: item.status,
        })),
    });
  }
  return batches.length === 0 ? [{ candidates: [], evidenceIndex: [] }] : batches;
}

function mergeProposals(proposals: readonly AiPlanProposal[]): AiPlanProposal {
  const serviceAssessments = new Map<string, AiPlanProposal['serviceAssessments'][number]>();
  const pathAssessments = new Map<string, AiPlanProposal['pathAssessments'][number]>();
  const probeRequests = new Map<string, AiPlanProposal['probeRequests'][number]>();
  for (const proposal of proposals) {
    for (const item of proposal.serviceAssessments) serviceAssessments.set(item.serviceId, item);
    for (const item of proposal.pathAssessments) pathAssessments.set(item.path, item);
    for (const item of proposal.probeRequests) probeRequests.set(item.id, item);
  }
  return {
    pathAssessments: [...pathAssessments.values()],
    probeRequests: [...probeRequests.values()],
    serviceAssessments: [...serviceAssessments.values()],
  };
}

function finalAnalysisPayload(snapshot: ScanSnapshot, plan: AiPlan, probeAudit: unknown): unknown {
  const assessmentById = new Map(plan.serviceAssessments.map((item) => [item.serviceId, item]));
  const visibleServices = snapshot.services
    .filter((service) => assessmentById.get(service.id)?.reportPlacement !== 'system_summary')
    .map((service) => ({
      id: service.id,
      name: service.displayName ?? service.name,
      status: service.status,
      deploymentType: service.deploymentType,
      assessment: assessmentById.get(service.id),
      evidenceIds: service.evidenceIds,
    }));
  const relevantEvidenceIds = new Set([
    ...visibleServices.flatMap((item) => item.evidenceIds),
    ...(snapshot.storage?.disks.flatMap((item) => item.evidenceIds) ?? []),
    ...(snapshot.storage?.mounts.flatMap((item) => item.evidenceIds) ?? []),
  ]);
  return {
    host: snapshot.host,
    storage:
      snapshot.storage === undefined
        ? null
        : {
            diskCount: snapshot.storage.disks.length,
            disks: snapshot.storage.disks.map((item) => ({
              name: item.name,
              path: item.path,
              sizeBytes: item.sizeBytes,
              evidenceIds: item.evidenceIds,
            })),
            mounts: snapshot.storage.mounts.map((item) => ({
              source: item.source,
              target: item.target,
              fileSystemType: item.fileSystemType,
              totalBytes: item.totalBytes,
              usedBytes: item.usedBytes,
              availableBytes: item.availableBytes,
              readOnly: item.readOnly,
              evidenceIds: item.evidenceIds,
            })),
          },
    network:
      snapshot.network === undefined
        ? null
        : {
            interfaces: snapshot.network.interfaces,
            firewall: snapshot.network.firewall,
            dns: snapshot.network.dns,
          },
    services: visibleServices,
    evidenceIndex: snapshot.evidence
      .filter(
        (item) =>
          relevantEvidenceIds.has(item.id) || /^(?:host|storage|network)\./.test(item.source),
      )
      .map((item) => ({
        id: item.id,
        kind: item.kind,
        source: item.source,
        field: item.field,
        status: item.status,
      })),
    factualFindings: snapshot.findings,
    probeAudit,
  };
}

function governAnalysis(
  snapshot: ScanSnapshot,
  candidate: AiAnalysis,
  plan: AiPlan,
  model: string | undefined,
  threadId: string | undefined,
  now: () => Date,
): AiAnalysis {
  const serviceIds = new Set(snapshot.services.map((item) => item.id));
  const evidenceIds = new Set(snapshot.evidence.map((item) => item.id));
  return {
    ...candidate,
    findings: candidate.findings
      .filter((item) => item.evidenceIds.every((id) => evidenceIds.has(id)))
      .map((item) => ({
        ...item,
        confidence: item.confidence === 'confirmed' ? 'inferred' : item.confidence,
      })),
    generatedAt: now().toISOString(),
    pathAssessments: plan.pathAssessments,
    provider: 'codex',
    serviceAssessments: plan.serviceAssessments,
    serviceSummaries: candidate.serviceSummaries
      .filter((item) => serviceIds.has(item.serviceId))
      .map((item) => ({
        ...item,
        evidenceIds: item.evidenceIds.filter((id) => evidenceIds.has(id)),
      })),
    ...(model === undefined ? {} : { model }),
    ...(threadId === undefined ? {} : { threadId }),
  };
}

function timeoutSignal(external: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return external === undefined ? timeout : AbortSignal.any([external, timeout]);
}
