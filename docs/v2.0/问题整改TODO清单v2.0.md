# OpSense v2 问题整改 TODO 清单

## 1. 文档说明

本文档记录对当前 v2 实现进行代码检查后发现的架构偏差和整改任务，重点解决以下问题：

1. Codex 已经接入 Agent 流程，但尚未真正控制服务语义分类和最终投影。
2. v1 的固定名称、固定目录和正则规则仍在决定服务角色、报告位置和路径用途。
3. 部分被本地基线隐藏的服务不会进入 Codex 上下文，Codex 无法纠正错误分类。
4. Agent 可能在未完成候选审查、未更新投影的情况下提前结束。
5. v2 Wiki 仍存在绕过 Codex、直接使用本地基线生成的路径。

本清单不否定 M12-M17 已完成的结构、采集、安全、Schema、报告渲染和 CLI 工作，而是补齐“Codex 是 v2 Agent 的决策核心”这一尚未闭环的能力。

任务状态约定：

```text
[ ] 未开始
[-] 进行中
[x] 已完成
[!] 阻塞
```

优先级约定：

```text
Must    不完成则 v2 不能视为 Codex Agent
Should  建议在 v2 正式验收前完成
Later   不进入本轮整改
```

## 2. 审计结论

### 2.1 总体结论

当前实现更接近“本地规则生成投影，Codex 提供有限建议”的工作流，还不是“Codex 观察证据、形成判断、修改投影并生成 Wiki”的 Agent 闭环。

主要数据流现状：

```text
Snapshot
  -> v1 本地语义规则分类
  -> 本地 Projection/Wiki
  -> Codex 读取部分候选并返回决策外壳
  -> update_projection 未真正修改投影
```

整改后的目标数据流：

```text
Snapshot
  -> 本地确定性索引、过滤和 candidateHints
  -> Codex 审查全部候选
  -> Codex 输出结构化语义判断
  -> 本地验证 Evidence ID 和安全约束
  -> 原子更新最终 Projection
  -> 质量门禁验证 Codex 审查覆盖率
  -> Word / HTML / Markdown Wiki
```

### 2.2 问题清单

| 编号 | 优先级 | 问题 | 当前影响 | 代码位置 |
| --- | --- | --- | --- | --- |
| ISSUE-01 | P0 | `update_projection` 只返回对象 ID，没有修改投影 | Codex 即使作出判断，最终 Wiki 也不会采用 | `apps/cli/src/workflows/agent-workflow.ts:125` |
| ISSUE-02 | P0 | 投影和报告允许在无 Codex 分析时回退到 baseline | 违反 v2 Codex 硬依赖，可能生成伪装成 Agent 结果的 Wiki | `packages/projection/src/index.ts:38`、`apps/cli/src/workflows/report-workflow.ts:44` |
| ISSUE-03 | P0 | baseline 判为 `system_summary` 的服务不会发送给 Codex | 本地误判无法被模型纠正，非标准业务服务可能被静默隐藏 | `packages/ai-codex/src/index.ts:477` |
| ISSUE-04 | P0 | 连续两轮只读或无投影变化即结束为 `partial` | Agent 可能在没有完成分类任务时提前收敛 | `packages/agent-runtime/src/runtime.ts:202` |
| ISSUE-05 | P0 | `ProjectionChange` 没有携带实际分类字段 | 工具协议无法表达角色、用途、展示位置和路径语义 | `packages/schema/src/agent.ts:53` |
| ISSUE-06 | P1 | Agent 上下文中的候选信息过少 | Codex 缺少当前分类、路径、端口、unit、进程和容器证据，难以可靠判断 | `packages/agent-runtime/src/context.ts:190` |
| ISSUE-07 | P1 | v1 服务名、产品名和目录规则仍被当作最终语义 | Doris、Hadoop、MinIO、自研程序和非标准路径仍受硬编码覆盖范围限制 | `packages/ai-provider/src/baseline.ts`、`packages/core/src/normalization.ts`、`packages/wiki/src/index.ts` |
| ISSUE-08 | P1 | Codex 预检能力没有接入生产 Agent Runtime 创建流程 | 文档声明的 Codex 硬依赖在真实 Agent 入口没有完整执行 | `apps/cli/src/workflows/agent-workflow.ts:127` |
| ISSUE-09 | P1 | 缺少 Codex 分类完成度元数据和 Wiki 生成门禁 | 无法区分“Codex 已完整审查”和“只运行过一次 Codex 调用” | Projection、AgentSession 和报告工作流 |

## 3. 架构职责边界

### 3.1 必须保留在本地确定性层

- SSH 命令白名单、参数校验和禁止危险命令。
- 密码、私钥、Token、环境变量和配置内容脱敏。
- Evidence ID 生成、引用校验、Schema 校验和原子持久化。
- 探测次数、路径根、目录深度、读取字节数、超时和输出大小限制。
- `/proc`、`/sys`、`/dev`、Docker overlay、rootfs、veth 等运行时噪声的硬过滤。
- 保证失败服务、外部监听端口、容器候选和自定义路径候选不能被静默丢弃。
- 报告敏感信息检查、证据完整性检查和质量门禁。

这些规则属于安全与数据完整性边界，Codex 不得绕过或覆盖。

### 3.2 必须由 Codex 作出最终判断

- 服务角色和报告位置。
- 服务用途、业务重要性和状态解释。
- 系统服务、业务服务、中间件、边缘服务和待确认服务的语义分类。
- 路径属于部署、配置、日志、数据、备份还是无关路径。
- 是否需要对非标准服务或非标准路径继续调查。
- 服务知识条目的组织、用途描述、未知项和人工复核项。

### 3.3 v1 规则的允许用途

v1 的固定名称、正则和目录判断不得继续写入最终事实，只允许转换为以下非权威提示：

```text
candidateHints:
  matchedPatterns
  possibleRoles
  possiblePathKinds
  discoveryReasons
  prioritySignals
```

`candidateHints` 必须明确标识 `source=local_heuristic`，Codex 可以接受、修改或拒绝；最终投影中不得把提示直接标记为 `confirmed`。

## 4. M19：Codex 服务语义分类闭环

### M19-01 扩展结构化决策契约

- [x] `Must` 新增 `ServiceAssessmentUpdate` Schema，至少包含 `serviceId`、`role`、`reportPlacement`、`importance`、`purpose`、`statusInterpretation`、`confidence`、`evidenceIds`、`unknowns` 和 `reviewItems`。
- [x] `Must` 新增 `PathAssessmentUpdate` Schema，包含 `path`、`pathRole`、`serviceId`、`confidence`、`evidenceIds` 和判断说明。
- [x] `Must` 扩展 `ProjectionChangeSchema`，使其携带可应用的结构化变更值，而不只是 `objectId`、`operation` 和 `summary`。
- [x] `Must` 明确允许的枚举、字段级 Evidence ID 要求和 `confirmed/inferred/unknown` 约束。
- [x] `Must` 对不存在的对象、Evidence ID、服务 ID、路径和非法状态转换拒绝应用，并写入 ToolActivity。
- [ ] `Should` 为 Schema 增加版本号，支持后续新增字段时迁移已有 AgentSession。

验收条件：

- 测试中的 Codex 决策可以真实改变一个服务的角色、报告位置、用途和路径分类。
- 非法或无证据的变更无法进入最终投影。

### M19-02 实现真实 Projection Mutation

- [x] `Must` 替换 `agent-workflow.ts` 中仅返回对象 ID 的 `applyProjectionUpdate` 占位实现。
- [x] `Must` 在 `packages/projection` 中实现唯一的 Projection 更新入口，避免 CLI、Wiki 和 Runtime 分别修改对象。
- [x] `Must` 更新服务评估、可见性、路径语义、未知项和复核项，并返回实际发生变化的字段路径。
- [x] `Must` 每次变更后重新执行 Schema、Evidence ID、安全边界和质量约束校验。
- [x] `Must` 使用临时文件加原子替换持久化 `agent-projection.json`，失败时保留旧版本。
- [x] `Must` 将变更前后摘要、Codex response/thread ID 和 Evidence ID 写入 Agent turn 审计记录。
- [x] `Should` 支持幂等应用，同一个 `projection_update` 重试时不得重复追加内容。

验收条件：

- `projectionChanges` 记录的是实际字段变化，不再只是模型声称修改过的对象 ID。
- 中断或写盘失败后可以恢复到最后一个合法投影。

### M19-03 全量候选进入 Codex 审查（已被 M20 替代）

> 该任务解决了“本地 baseline 静默隐藏业务服务”的问题，但其“每个 `snapshot.services` 对象逐项审查”的完成条件已不适用。后续以《Agent证据收敛与按需探测TODO-v2.0.md》M20 为准：Codex 必须能够访问所有原始 Evidence 并作出筛选决策，但原始 systemd unit 不再一对一等同于待报告服务。

- [x] `Must` 移除 `classificationBatches()` 对 baseline `system_summary` 服务的跳过逻辑。
- [x] `Must` 所有 `snapshot.services` 和未归并的高价值候选都必须进入 Codex 审查队列。
- [x] `Must` baseline 只提供排序和 `candidateHints`，不得决定候选是否具有被 Codex 审查的资格。
- [x] `Must` 对候选分批、分页和摘要，避免一次性塞入完整快照导致上下文溢出。
- [x] `Must` 保证失败状态、外部监听端口、容器、自定义路径和高资源占用候选优先审查。
- [x] `Must` Codex 无法确认的候选必须形成 `unknown` 或 `needs_review` 决策，不得静默隐藏。
- [x] `Should` 保存每批候选的开始位置、完成状态和重试次数，支持 Thread 恢复后续跑。

验收条件：

- 任一本地 baseline 误判为系统服务的业务候选，Codex 都有机会将其提升为主要服务或支撑组件。
- 候选总数等于已作出 Codex 决策的数量，不确认也必须有明确决策记录。

### M19-04 补充 Agent 上下文

- [x] `Must` `list_candidates` 返回当前 assessment、candidateHints 和是否已由 Codex 审查。
- [x] `Must` 候选摘要包含关联端口、监听地址、systemd unit、进程、容器、镜像、Compose 标签和关键路径。
- [x] `Must` 展示每类信息对应的 Evidence ID，不把无来源摘要交给 Codex 当作事实。
- [x] `Must` `read_evidence` 支持按服务和字段读取必要详情，避免重复注入整个快照。
- [x] `Must` 上下文明确区分 `local_heuristic`、`codex_inference` 和 `confirmed_evidence`。
- [x] `Must` 所有新增上下文继续执行脱敏和大小限制。
- [x] `Should` 对大量普通 systemd 候选提供批量摘要，但不能因此跳过逐项语义决策。

### M19-05 重构 Agent 收敛条件

- [x] `Must` 删除“连续两轮无 Evidence 或 Projection 变化就直接结束”的单一收敛判断。
- [x] `Must` 只有满足候选审查覆盖率、必需字段处理状态和 Projection 持久化要求后，才允许进入 `completed`。
- [x] `Must` 只读轮次不应自动视为无效，读取证据和形成判断可以跨多个 turn 完成。
- [x] `Must` 达到轮数或预算上限但审查未完成时进入 `partial`，并保存未审查候选和恢复游标。
- [x] `Must` Codex 返回 `final` 时仍由本地代码校验完成条件，不允许模型绕过质量门禁。
- [x] `Should` 记录停止原因：`classification_complete`、`budget_exhausted`、`user_interrupted`、`codex_failed` 或 `quality_gate_failed`。

建议完成条件：

```text
classificationCompleted = true
AND reviewedServiceCount = candidateServiceCount
AND pendingProjectionChanges = 0
AND projectionSchemaValid = true
AND reportQualityGatePassed = true
```

### M19-06 Codex 硬依赖和报告门禁

- [x] `Must` 在生产 `AgentRuntime` 创建时注入并执行 `CodexSdkPreflightProbe`。
- [x] `Must` 预检失败时不连接服务器、不执行探测、不生成 v2 Wiki。
- [x] `Must` 为最终投影增加 `classificationProvider=codex`、`classificationCompleted`、`reviewedServiceCount`、`candidateServiceCount` 和 `threadId`。
- [x] `Must` v2 Wiki 生成前验证 Codex 分类元数据和对应 AgentSession/Thread 审计记录。
- [x] `Must` Codex 调用失败、上下文耗尽或结构化输出修复失败时，只保存失败现场，不回退到 baseline Wiki。
- [x] `Must` 修改 `runReportWorkflow()`：兼容报告可以继续读取旧数据，但 v2 `wiki` profile 必须拒绝无完整 Codex 投影的输入。
- [x] `Must` 修改 `buildInventoryProjection()`：生产 v2 路径不允许通过 `analysis === undefined` 自动采用 baseline 作为最终分类。
- [ ] `Should` 增加 `opsense agent doctor`，独立检查 Codex SDK、登录、模型和 Thread 创建能力。

### M19-07 移除 v1 硬编码语义决策

- [x] `Must` 逐项审查 `packages/ai-provider/src/baseline.ts` 中的服务名称、middleware 和产品列表。
- [x] `Must` 将服务角色、用途、重要性和 `reportPlacement` 的规则改成 `candidateHints`，不再生成最终 assessment。v1 兼容命令继续保留 baseline 输出，但 v2 Agent 初始化不执行该分类器。
- [x] `Must` 将 Doris、Hadoop、MinIO 等固定搜索名单改为从现有进程、unit、镜像、Compose 标签和用户提示动态产生搜索词。
- [x] `Must` 审查 `packages/core/src/normalization.ts` 中的路径用途推断，只保留路径标准化、对象关联和候选生成。
- [x] `Must` 审查 `packages/wiki/src/index.ts` 中根据角色名称直接决定 Wiki 类型的逻辑，改为消费 Codex 最终 assessment。
- [x] `Must` 全仓搜索固定产品名、服务名、目录名和用途正则，建立“保留为硬规则 / 转为提示 / 删除”清单。
- [x] `Must` 禁止为某个真实服务器出现的单个服务临时增加产品名或 unit 名硬编码。
- [ ] `Should` 将可复用的领域知识整理为 Codex 按需上下文或 skill，而不是继续扩展 TypeScript 正则表。

允许保留的本地规则示例：

- 容器网络接口和 runtime mount 的确定性噪声过滤。
- 文件扩展名、绝对路径格式和操作系统对象类型识别。
- 从 unit、进程、容器、端口建立候选关联。
- 安全禁止目录和命令白名单。

迁移审计结果：

| 位置 | 处理 | v2 作用 |
| --- | --- | --- |
| `packages/ai-provider/src/baseline.ts` 服务名和 middleware 正则 | 保留为 v1 兼容分类及旧 `analyze` 的 `candidateHints` | v2 Agent 初始化不调用，不写入最终 assessment |
| `packages/ai-provider/src/baseline.ts` 固定 Doris/Hadoop/MinIO 搜索名单 | 删除 | 搜索词改为来自采集到的服务、进程、unit、镜像和标签 |
| `packages/core/src/normalization.ts`、collectors 中的目录类型判断 | 转为候选 | v2 报告只消费 Codex `PathAssessmentUpdate` |
| `packages/wiki/src/index.ts` Nginx、Docker 等角色名称匹配 | 删除 | Wiki role 只消费 Codex assessment |
| Projection/Report 中容器网络、overlay 和伪文件系统规则 | 保留为硬规则 | 仅负责运行时噪声过滤和安全可见性 |
| SSH 命令、禁止路径、脱敏连接串和凭据模式 | 保留为硬规则 | 仅负责执行安全和敏感数据保护 |

### M19-08 质量门禁与兼容性

- [x] `Must` 报告质量门禁检查每个服务未知字段是否进入该服务对应的 `unknowns/reviewItems`，避免跨服务误判。
- [x] `Must` v1 `scan/analyze/report` 保持兼容，但产物必须明确标识 `legacy` 或 `baseline`，不得标识为 v2 Agent Wiki。
- [x] `Must` 旧 `ai-output.json` 只能作为迁移输入或候选提示，不能使 `classificationCompleted=true`。
- [x] `Must` 同一扫描可以在 Codex 恢复后继续审查，不重新连接服务器也能生成 v2 Wiki。
- [x] `Must` README 和 CLI 帮助明确区分兼容报告与 v2 Agent Wiki。
- [ ] `Should` 为已有 run 目录提供只读迁移检查命令，输出缺少的分类和审计字段。

## 5. 测试任务

### 5.1 单元测试

- [x] `Must` `ProjectionChangeSchema` 接受合法语义更新并拒绝缺少 Evidence ID 的确定性更新。
- [x] `Must` `applyProjectionUpdate` 真正修改投影，并验证幂等、冲突和回滚。
- [x] `Must` baseline 为 `system_summary` 的服务仍进入 Codex classification batch。
- [x] `Must` 缺少 Codex 分类完成元数据时，v2 Wiki 生成失败。
- [x] `Must` Codex 预检失败时没有 SSH、probe 和报告副作用。
- [x] `Must` 两个只读 turn 不会让未完成审查的 Agent 提前结束。
- [x] `Must` 达到预算上限时保存未审查候选和恢复位置。
- [x] `Must` v1 规则输出只出现在 `candidateHints`，不会直接决定最终 role 和 placement。
- [x] `Must` 服务未知字段在对应 Wiki 条目有 `unknowns/reviewItems` 时通过质量门禁。

### 5.2 集成测试

- [x] `Must` 使用 Codex 测试替身完成“列出候选 -> 读取证据 -> 更新投影 -> 生成 Wiki”闭环。
- [x] `Must` 模拟 Codex 将 baseline 系统服务改判为业务服务，并验证最终三种报告同步变化。
- [x] `Must` 模拟 Codex 拒绝本地路径提示，并验证错误提示不会进入最终事实。
- [x] `Must` 模拟结构化输出错误、Thread 中断和恢复，确认不会回退到 baseline。
- [x] `Must` 验证 Word、HTML、Markdown 使用同一份已完成 Codex 审查的 Projection。

### 5.3 真实服务器验收

- [ ] `Must` 普通 Linux 主机：常规系统服务只进入摘要或附录，但每个候选均有 Codex 决策记录。
- [ ] `Must` Docker 主机：bridge、veth、overlay 和容器 runtime mount 不进入正文。
- [ ] `Must` 非标准服务主机：至少覆盖 Doris、Hadoop、MinIO 或一个自研 Java/Go 服务，不依赖新增产品名硬编码完成识别。
- [ ] `Must` 非标准目录主机：Codex 能结合进程、unit、端口和配置证据判断部署、配置、日志和数据目录。
- [ ] `Must` 不确定信息进入 `unknowns/reviewItems`，不生成无证据的生命周期命令或业务依赖。
- [x] `Must` 执行 `pnpm run typecheck`、`pnpm test`、`pnpm run lint`、格式检查和 `git diff --check`。

## 6. 推荐实施顺序

```text
M19-01 决策 Schema
  -> M19-02 Projection Mutation
  -> M19-03 全量候选审查
  -> M19-04 Agent 上下文
  -> M19-05 收敛条件
  -> M19-06 Codex/报告门禁
  -> M19-07 v1 规则迁移
  -> M19-08 兼容性与质量门禁
  -> 单元、集成和真实服务器验收
```

建议拆分提交：

1. `refactor: add codex semantic decision contracts`
2. `feat: apply codex projection updates`
3. `fix: require full candidate review before convergence`
4. `refactor: convert baseline semantics to candidate hints`
5. `fix: enforce codex-complete wiki generation`
6. `test: cover codex semantic classification loop`

## 7. Definition of Done

- [x] 所有服务候选都经过 Codex 结构化审查，或者被 Codex 明确标记为 `unknown/needs_review`。
- [x] Codex 的判断能够真实改变最终 Projection 和 Wiki，不再是只读建议。
- [x] 本地 baseline、产品名和路径规则不再作为最终服务语义事实。
- [x] Codex 不可用、调用失败或分类未完成时不能生成 v2 Agent Wiki。
- [x] Agent 不会因为两个只读 turn 在未完成候选审查时提前结束。
- [x] 每个最终服务角色、用途、路径分类和展示位置都能追溯到 Codex 决策及 Evidence ID。
- [x] Word、HTML、Markdown 报告只消费同一份通过质量门禁的最终 Projection。
- [x] 安全命令、脱敏、资源限制和 runtime 噪声过滤继续由本地确定性层强制执行。
- [x] 不通过添加单个产品或服务名称硬编码来修复真实服务器识别问题。
- [ ] M18 样本评估与发布验收可以基于上述闭环继续执行。

## 8. 暂不包含

- [ ] `Later` 让 Codex 直接执行任意 Shell 或直接登录服务器。
- [ ] `Later` 自动启停、修改配置、部署、升级、备份或修复服务。
- [ ] `Later` 多 Agent 并行分类和跨服务器长期知识图谱。
- [ ] `Later` 完整业务调用链和严格服务依赖关系推断。
