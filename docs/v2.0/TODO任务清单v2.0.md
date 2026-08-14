# OpSense TODO 任务清单 v2.0

## 1. 文档说明

本文档依据以下文档拆分 v2 的可执行开发任务：

* 《需求迭代v2.0.md》
* 《Agent设计方案v2.0.md》
* 当前 M0-M10 已落地代码和测试

v2 的最终目标是：

```text
opsense agent
  -> 本地可恢复 Agent 会话
  -> 受控证据读取和补探测
  -> 服务知识条目与服务器 Wiki 文档
  -> Word / HTML / Markdown 产物
```

`scan`、`analyze`、`report` 和 `inspect` 保留为脚本化、调试和兼容入口；`opsense agent` 是 v2 的主入口。

v2 Agent 必须依赖可用的 Codex。Codex CLI/SDK、登录状态、模型和 Thread 能力均通过预检后，才允许创建可运行的 AgentSession；预检或运行失败时只保存失败现场，不生成 v2 Agent Wiki。

当前 M0-M10 的采集、SSH、发行版降级、服务发现、目录探测、归一化、脱敏和基础报告能力作为复用底座，不做无目标重写。v2 的结构调整重点是新增 Agent Runtime、资源投影和会话式 CLI，并切断报告对原始快照的直接依赖。

任务状态约定：

```text
[ ] 未开始
[-] 进行中
[x] 已完成
[!] 阻塞
```

优先级约定：

```text
Must    v2 最小可用闭环必须完成
Should  首期建议完成，不阻塞 Agent 最小闭环
Later   不进入 v2 首期
```

## 2. 里程碑总览

| 里程碑 | 内容 | 主要交付物 | 依赖 |
| --- | --- | --- | --- |
| M12 | v2 架构契约与资源投影 | Agent/Projection Schema、新包边界、报告输入切换 | M0-M11 |
| M13 | 服务知识条目模型 | `ServiceWikiEntry`、完整度评分、服务视图 | M12 |
| M14 | 服务发现与非标准路径增强 | 证据驱动候选、未知项和受控补探测种子 | M12、M13 |
| M15 | Agent Runtime | Agent loop、结构化工具、预算、Codex Thread 适配器 | M12-M14 |
| M16 | CLI Agent 会话 | `opsense agent`、REPL、恢复、transcript | M15 |
| M17 | Wiki 文档与质量门禁 | Word/HTML/Markdown Wiki、过滤审查、产物索引 | M13-M16 |
| M18 | 样本评估与发布验收 | Linux/Docker/非标准服务样本、性能和安全验收 | M12-M17 |

关键路径：

```text
M12 -> M13 -> M14 -> M15 -> M16 -> M17 -> M18
```

## 3. M12：v2 架构契约与资源投影

### M12-01 固化 v2 模块边界

- [x] `Must` 新增 `packages/agent-runtime`，只负责 Agent 会话、循环、工具路由、预算和恢复。
- [x] `Must` 新增 `packages/projection`，负责主机资源可见性、服务 Wiki 投影和报告质量门禁。
- [x] `Must` 将 `packages/ai-provider` 的职责收窄为 Provider/Thread 适配、候选基线分类和通用 AI 契约。
- [x] `Must` 禁止 `packages/report` 直接依赖 `@opsense/ai-provider` 的分类实现。
- [x] `Must` 保留现有 `collectors`、`ssh`、`redaction` 和 `core` 的公共 API 兼容层。
- [x] `Should` 更新 workspace、TypeScript path alias、Vitest alias。
- [ ] `Should` 增加新包级 README。

验收条件：

- `report` 包只接收投影或 ReportModel，不读取原始快照完成业务分类。
- Agent Runtime 可以使用测试替身单独测试，但生产 Agent 不允许绕过 Codex。
- M0-M10 现有测试不因包拆分出现无意回归。

### M12-02 定义 Agent 契约

- [x] `Must` 定义 `AgentSession`、`AgentTurn`、`AgentDecision`、`AgentResponse`。
- [x] `Must` 定义 `AgentHypothesis`、`ProbeBudget`、`ToolActivity` 和 `TranscriptEntry`。
- [x] `Must` 定义 Agent 阶段、终态、错误、失败和中断状态。
- [x] `Must` 定义 `nextAction`、`unresolvedQuestions` 和 `nextSuggestions` 字段。
- [x] `Must` 所有结构提供 TypeBox Schema、TypeScript 类型和 fixture。
- [x] `Must` 对模型输出执行严格 Schema 校验，禁止把非结构化文本写入事实字段。

### M12-04 Codex 硬依赖预检

- [x] `Must` 在 Agent 启动前检查 Codex CLI/SDK 是否可调用。
- [x] `Must` 检查 Codex 登录状态、凭据、模型和 Thread 创建能力。
- [x] `Must` 预检失败时返回专用 CodexUnavailable 退出码。
- [x] `Must` 预检失败时不连接服务器、不执行 Agent 工具、不生成 v2 Agent Wiki。
- [x] `Must` 将预检错误和修复提示写入 AgentSession。
- [ ] `Should` 提供独立的 `opsense agent doctor` 诊断命令。

### M12-03 定义资源投影契约

- [x] `Must` 定义 `InventoryProjection`。
- [x] `Must` 定义 `VisibilityDecision`：`primary`、`supporting`、`summary`、`appendix`、`filtered`。
- [x] `Must` 定义 `resourceClass`、`visibilityReason`、`relatedServiceIds` 和 `evidenceIds`。
- [x] `Must` 定义 `ServiceWikiProjection` 和 `RiskFinding`。
- [x] `Must` 保证 `filtered` 只改变展示投影，不删除原始快照对象。

## 4. M13：服务知识条目模型

### M13-01 ServiceWikiEntry

- [x] `Must` 定义 `ServiceWikiEntry` 和 `WikiEntryDraft` Schema。
- [x] `Must` 覆盖身份、用途、角色、状态、部署方式和证据置信度。
- [x] `Must` 覆盖部署目录、配置文件、环境文件、端口、数据、日志和备份路径。
- [x] `Must` 覆盖 systemd unit、Compose service、容器、镜像、进程和运行用户关联。
- [x] `Must` 覆盖生命周期入口，并区分 `confirmed`、`inferred` 和 `unknown`。
- [x] `Must` 覆盖 `confirmedFacts`、`inferences`、`unknowns` 和 `reviewItems`。

### M13-02 服务完整度和证据门禁

- [x] `Must` 定义主要服务最低关键字段集合。
- [x] `Must` 实现服务完整度评分和证据覆盖率。
- [x] `Must` 确保每个主要服务至少关联一个进程、unit、容器、端口、目录或配置证据。
- [x] `Must` 禁止没有 Evidence ID 的确定性结论进入 Wiki 正文。
- [x] `Must` 对证据冲突保留多个来源，不隐式选择一个值。
- [x] `Should` 为服务条目生成稳定锚点，供 HTML、Markdown 和 Word 目录链接使用。

### M13-03 确定性服务视图

- [x] `Must` 将 `primary_application`、`infrastructure_service`、`edge_service`、`supporting_component`、`container_platform` 和 `system_service` 区分开。
- [x] `Must` 普通发行版 systemd 服务只进入摘要或异常列表。
- [x] `Must` 统一主机端口、容器端口和容器内部端口的表达方式。
- [x] `Must` 支持一个服务合并多个容器、进程和 Compose service。
- [x] `Must` 为无法确认的候选生成 `needs_review` 条目，不静默丢弃。

## 5. M14：服务发现与非标准路径增强

### M14-01 证据驱动的候选生成

- [x] `Must` 将进程、父子关系、cgroup、unit、端口、容器、镜像、Compose 标签和路径建立可查询索引。
- [x] `Must` 将候选来源和归并规则写入 Evidence 图。
- [x] `Must` 降低对固定服务名称和固定目录名称的依赖。
- [x] `Must` 识别无标准名称的 Java、Go、Rust、Shell 和自研程序候选。
- [ ] `Should` 增加 Doris、Hadoop、MinIO、RustFS、FastDFS 等样本的识别 fixture。

### M14-02 受控路径调查种子

- [x] `Must` 从已知 Evidence 生成目录元数据、目录列表、配置摘要和路径搜索候选。
- [x] `Must` 搜索根只能来自已采集部署根、数据挂载或服务路径。
- [x] `Must` 搜索词只能来自已有服务、进程、unit、镜像或 Compose 线索。
- [x] `Must` 明确排除 `/proc`、`/sys`、`/dev`、`/run`、overlay2 和运行时内部目录。
- [x] `Must` 保留被拒绝探测的原因，供 Agent 和用户查看。

### M14-03 过滤规则样本

- [x] `Must` 增加 Docker bridge、veth、overlay、Compose network 样本。
- [x] `Must` 增加 overlay2、rootfs、shm、proc、sysfs 和 runtime mount 样本。
- [x] `Must` 增加业务数据挂载与容器运行时挂载混合样本。
- [x] `Must` 验证过滤后业务挂载仍能回溯到服务。

## 6. M15：Agent Runtime

### M15-01 Agent Loop

- [ ] `Must` 实现 `AgentRuntime.start()`、`runTurn()`、`resume()` 和 `interrupt()`。
- [ ] `Must` 实现“读取上下文 -> 模型决策 -> 工具执行 -> 结果回写 -> 收敛”的循环。
- [ ] `Must` 由本地代码控制轮数、时间、Token、补探测和输出预算。
- [ ] `Must` 由模型决定下一步最有价值的观察或判断，不把流程硬编码为固定 Prompt 串联。
- [ ] `Must` 连续两轮无有效变化时结束 Agent。
- [ ] `Must` Codex Thread 创建、恢复或调用失败时重试并持久化失败现场，不静默切换为 v2 基线 Wiki。

### M15-02 上下文构建

- [ ] `Must` 实现 L0 运行摘要、L1 结构化索引和 L2 证据详情。
- [ ] `Must` 默认不将完整快照一次性写入 Prompt。
- [ ] `Must` 对普通 systemd 服务、容器网络和运行时挂载做聚合压缩。
- [ ] `Must` 按异常、对外暴露和服务关联程度排序候选。
- [ ] `Must` 对上下文中的所有敏感字段执行二次脱敏扫描。

### M15-03 五类结构化能力

- [ ] `Must` 实现 `read_context`。
- [ ] `Must` 实现 `read_evidence`。
- [ ] `Must` 实现 `list_candidates`。
- [ ] `Must` 实现 `execute_governed_probe`。
- [ ] `Must` 实现 `update_projection`。
- [ ] `Must` 所有能力使用固定 JSON Schema，不接受 Shell 字符串。
- [ ] `Must` 所有工具调用记录 ToolActivity、参数摘要、结果状态和 Evidence ID。

### M15-04 ProbeGovernor

- [ ] `Must` 将现有 `ProbePlanValidator` 改造成会话级预算控制器。
- [ ] `Must` 持久化最大轮数、请求数、读取字节、超时和已消耗量。
- [ ] `Must` 每次执行前校验服务、证据、路径来源、深度、命中数和禁止目录。
- [ ] `Must` 每次执行后重新归一化、脱敏并更新投影。
- [ ] `Must` 单个探测失败只影响对应字段，不导致整个 Agent 失败。
- [ ] `Should` 支持短时 SSH 连接复用，但不得把连接对象持久化到 AgentSession。

### M15-05 Codex Thread Adapter

- [ ] `Must` 将现有 `CodexProvider.analyze()` 保留为兼容入口。
- [ ] `Must` 新增结构化 Thread turn 适配器。
- [ ] `Must` 固定 `approvalPolicy=never`、`networkAccessEnabled=false`、`sandboxMode=read-only`。
- [ ] `Must` 支持 Thread 创建、恢复、超时、格式修复和失败现场保存。
- [ ] `Must` 不向 Thread 写入 SSH 密码、私钥、未脱敏快照或完整环境变量。
- [ ] `Must` 将模型决策映射为 `tool_call`、`projection_update` 或 `final`。

## 7. M16：CLI Agent 会话

### M16-01 `opsense agent` 命令

- [ ] `Must` 支持 `--host --port --user --provider codex` 新建会话，v2 不提供非 Codex Provider。
- [ ] `Must` 支持 `--scan <scan-id>` 基于已有快照进入会话。
- [ ] `Must` 支持 `--resume <agent-session-id>` 恢复会话。
- [ ] `Must` 支持 `--prompt <text>` 和 `--once` 非交互模式。
- [ ] `Must` 支持 `--focus-service`、`--max-agent-rounds` 和 `--max-probes`。
- [ ] `Must` 启动时输出 Agent session ID 和本地目录。

### M16-02 REPL 交互

- [ ] `Must` 支持自然语言问题。
- [ ] `Must` 支持 `status`、`services`、`show <service-id>`、`review`、`wiki`、`resume` 和 `exit`。
- [ ] `Must` 显示当前阶段、轮数、预算、Codex 状态和工具调用摘要。
- [ ] `Must` 对长响应支持分页、折叠或摘要显示。
- [ ] `Must` 同一 session 连续追问至少三个问题且共享上下文。
- [ ] `Must` Ctrl+C 后安全取消当前动作、保存 transcript 并关闭活动 SSH 连接。

### M16-03 会话持久化和恢复

- [ ] `Must` 新增 `agent-session.json`、`agent-turns.jsonl` 和 `agent-transcript.jsonl`。
- [ ] `Must` 持久化假设、工具调用、预算、投影变更、错误和未解决问题。
- [ ] `Must` 恢复原 Codex Thread、上下文摘要、已成功 ProbeRequest 和当前投影。
- [ ] `Must` 恢复时不得重复执行已成功的补探测。
- [ ] `Must` 会话文件经过 Schema 校验和敏感信息扫描。

## 8. M17：服务器 Wiki 文档与质量门禁

### M17-01 Projection Builder

- [ ] `Must` 实现 `InventoryProjection` 构建。
- [ ] `Must` 实现主机网络过滤：隐藏 bridge、veth、overlay 和容器内部网络。
- [ ] `Must` 实现主机存储过滤：隐藏 overlay2、rootfs、shm、proc、sysfs 和临时挂载。
- [ ] `Must` 将宿主机数据挂载映射到对应服务知识条目。
- [ ] `Must` 为每个过滤对象保存类别、原因和统计。
- [ ] `Must` 普通系统服务只进入摘要、异常列表或附录。

### M17-02 WikiBuilder

- [ ] `Must` 从 `ServiceWikiProjection` 生成服务器概览和服务知识条目。
- [ ] `Must` 生成服务索引、服务角色、用途摘要、部署位置、端口、配置、日志和数据章节。
- [ ] `Must` 对生命周期命令执行证据门禁。
- [ ] `Must` 将事实、推断、未知和待确认事项分栏展示。
- [ ] `Must` 生成 Evidence ID 交叉引用。
- [ ] `Must` 支持 `wiki`、`summary` 和 `audit` 三种报告 profile。

### M17-03 ReportQualityGate

- [ ] `Must` 检查正文是否出现容器网络和运行时挂载噪声。
- [ ] `Must` 检查正文是否逐条展开普通 systemd 服务。
- [ ] `Must` 检查每个主要服务是否具备用途、状态、部署方式和证据。
- [ ] `Must` 检查每个重要端口是否能关联主机暴露面或待确认项。
- [ ] `Must` 检查确定性结论是否引用 Evidence ID。
- [ ] `Must` 检查未知字段是否进入 `unknowns` 或 `reviewItems`。
- [ ] `Must` 通过脱敏和敏感数据扫描后才能渲染。

### M17-04 Word/HTML/Markdown 输出

- [ ] `Must` 将 `packages/report` 改为只接收最终投影。
- [ ] `Must` 保持 Word、HTML、Markdown 使用同一份 Wiki 数据。
- [ ] `Must` 保留中文文件名、服务器标识、常见扫描时间和 OpSense 版权标识。
- [ ] `Must` HTML 支持背景水印、离线打开和长路径换行。
- [ ] `Must` Word 支持页眉、页脚、版权标识、合理水印和目录。
- [ ] `Must` 报告产物写入 `AgentResponse.wikiArtifacts` 和 session 输出索引。

## 9. M18：样本评估与发布验收

### M18-01 样本集

- [ ] `Must` 建立 Debian/Ubuntu、RHEL/Rocky、Alpine 样本。
- [ ] `Must` 建立 systemd、Docker、Compose 混合样本。
- [ ] `Must` 建立 Nginx + 应用 + 数据库 + Redis + MinIO 样本。
- [ ] `Must` 建立 Doris、Hadoop、自研 Java/Go 服务和非标准目录样本。
- [ ] `Must` 建立大量 Docker 网络和挂载噪声样本。

### M18-02 Agent 质量指标

- [ ] `Must` 统计主要服务识别准确率和证据覆盖率。
- [ ] `Must` 统计网络、挂载和 systemd 噪声误展示率。
- [ ] `Must` 统计有效补探测率、拒绝率、平均 Agent turn 和总耗时。
- [ ] `Must` 统计 Codex 预检失败、调用失败、超时和结构化修复比例。
- [ ] `Must` 人工验证五分钟内找到服务索引、两分钟内找到服务关键路径。

### M18-03 安全和回归

- [ ] `Must` 验证 Agent 永不调用任意 Shell、网络或服务器登录。
- [ ] `Must` 验证密码、私钥、Token 和环境变量值不进入 session、transcript 和报告。
- [ ] `Must` 验证补探测不超出会话预算和批准路径。
- [ ] `Must` 验证 Ctrl+C、SSH 断连、Codex 预检失败、Codex 调用失败和部分采集失败的处理；Codex 失败不得伪装成已完成 Wiki。
- [ ] `Must` 执行 `pnpm run typecheck`、`pnpm test`、`pnpm run lint` 和 `git diff --check`。

### M18-04 Definition of Done

- [ ] `opsense agent --host ...` 可以启动交互式会话。
- [ ] `opsense agent --scan ...` 可以基于已有扫描连续回答问题。
- [ ] `opsense agent --resume ...` 可以恢复 session 和 Codex Thread。
- [ ] `wiki` 命令可以生成服务器 Wiki 的 Word、HTML、Markdown 产物。
- [ ] 报告正文不再平铺 Docker 网络、容器 rootfs 和普通系统服务。
- [ ] 主要服务条目包含部署、端口、配置、日志、数据、生命周期和证据边界。
- [ ] Codex 预检通过后才能启动 Agent；Codex 不可用时只生成失败现场和修复提示，不生成 v2 Agent Wiki。

## 10. 兼容性迁移任务

- [ ] `Must` 保留 `scan`、`analyze`、`report`、`inspect` 的现有脚本化行为。
- [ ] `Must` 为旧的 `ai-plan.json`、`ai-output.json` 提供读取兼容层。
- [ ] `Must` 允许同一 scan 快照重新生成新旧报告格式，且不重新连接服务器。
- [ ] `Must` 将旧 `threadId` 映射为 AgentSession 的 Codex Thread 信息；旧的基线/Noop 结果仅作为兼容数据，不视为 v2 Agent 结果。
- [ ] `Should` 为旧运行目录生成迁移状态提示，不自动修改原始快照。
- [ ] `Should` 在 README 中更新 v2 Agent 主入口和恢复方式。

## 11. 暂不实施

- [ ] `Later` 多 Agent 并行协作。
- [ ] `Later` Web 管理系统、HTTP API、用户和团队权限。
- [ ] `Later` 批量服务器扫描、任务队列和周期调度。
- [ ] `Later` 长期记忆库和跨服务器知识图谱。
- [ ] `Later` 自动执行服务启停、升级、备份或修复。
- [ ] `Later` Kubernetes、云平台和容器编排平台的专用探测。
- [ ] `Later` 完整跨服务业务依赖图和调用链还原。

## 12. v2 Definition of Done

以下条件全部满足后，v2 才视为完成：

- [ ] Agent 是 CLI 主入口，而不是一次性 `analyze` 的别名。
- [ ] AgentSession、AgentTurn、AgentResponse 和 transcript 可以持久化和恢复。
- [ ] Agent 只能通过五类结构化能力工作，不得执行任意 Shell 或网络操作。
- [ ] 补探测使用会话级预算，并且每次执行都有审计记录。
- [ ] 报告只消费 InventoryProjection 和 ServiceWikiProjection。
- [ ] 主机网络和主机存储正文过滤 Docker/容器运行时噪声。
- [ ] 普通 systemd 服务不逐条占用主要服务章节。
- [ ] 主要部署服务形成可追溯的服务知识条目。
- [ ] Word、HTML、Markdown 统一由服务器 Wiki 投影生成，并包含 OpSense 版权标识。
- [ ] Codex 不可用时不得生成 v2 Agent Wiki 文档；必须保存失败现场并支持修复后恢复。
- [ ] 所有 v2 核心测试、样本评估和安全检查通过。
