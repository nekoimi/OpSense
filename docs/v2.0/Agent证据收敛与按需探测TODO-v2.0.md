# OpSense v2 Agent 证据收敛与按需探测 TODO

## 1. 背景与目标

当前 M19 的实现将 `snapshot.services` 中的每个 systemd unit 直接初始化为待 Codex 审查的服务候选，并要求逐项完成服务和路径语义判断。这虽然避免了本地规则静默隐藏非标准业务服务，但会让 `systemd-sysusers.service`、`systemd-tmpfiles-setup.service` 等普通系统单元消耗大量 Agent turn，且把 Codex 降级为后置分类器。

本轮优化将 Agent 重构为“证据驱动的信息收敛者”：原始快照是可检索证据库，不是报告服务清单；只有 Codex 识别、归并并确认值得保留的对象，才进入服务工作区和服务器 Wiki。

目标流程：

```text
Codex 预检
  -> 一次 SSH 基础普查，保存原始 Snapshot / Evidence
  -> Codex 阅读压缩索引，筛选、分组并规划调查
  -> Codex 按需调用受控 SSH 补探测，补充具体证据
  -> Codex 归并有效服务、部署单元、路径和端口
  -> Codex 总结并按 Wiki 模块组织内容
  -> 本地质量门禁
  -> HTML / Word / Markdown 服务器 Wiki
```

任务状态约定：

```text
[ ] 未开始
[-] 进行中
[x] 已完成
[!] 阻塞
```

优先级约定：

```text
Must    不完成则不能称为证据驱动 Agent
Should  首期建议完成
Later   不进入本轮
```

## 2. 架构原则与边界

### 2.1 原始事实与 Wiki 对象分离

- [ ] `Must` 明确 `ScanSnapshot`、`Evidence`、systemd unit、进程、端口、目录和挂载均是原始事实，不等同于服务知识条目。
- [ ] `Must` 禁止由 `snapshot.services` 一对一预创建待报告服务，或以“所有服务均已审查”为完成条件。
- [ ] `Must` 由 Codex 基于 Evidence 创建或归并最终的服务、部署单元、配置、日志、数据目录和端口关联。
- [ ] `Must` 被过滤的原始对象不删除，保留数量、过滤原因和 Evidence ID，供审计和后续追问。
- [ ] `Must` 报告只能消费已收敛的 Wiki Projection，不能平铺 Snapshot。

### 2.2 Codex 与本地层职责

Codex 必须决定：

- 哪些原始线索值得保留、合并、暂缓或过滤。
- 是否需要补充 SSH 证据，以及应调查哪个对象。
- 服务角色、用途、重要性、部署方式、路径用途和报告模块。
- 是否存在证据不足、冲突或需要人工复核的事项。

本地确定性层只能负责：

- SSH 认证、命令模板、参数校验、超时、字节数、目录深度和请求预算。
- 禁止危险命令、禁止目录、脱敏、Schema/Evidence ID 校验和原子持久化。
- Docker runtime mount、容器内部网络、伪文件系统等确定性运行时噪声过滤。
- AgentSession、审计记录、失败恢复和报告安全质量门禁。

本地不得通过固定产品名、unit 名、目录名或正则直接确定业务/系统服务语义；这类信息最多作为明确标识为 `local_heuristic` 的非权威提示。

## 3. M20：证据驱动发现与按需探测 Agent

当前状态：`[-]` 已完成 M20 工作区、Codex 筛选计划、调查对象门禁、受控 unit/PID/cgroup/socket/容器/Compose/日志探测、发现服务归并、M20 Prompt/CLI 状态和基础回归测试；真实 Codex 服务器验收仍待完成。

### M20-01 重构工作区与收敛状态

- [ ] `Must` 将现有 Agent Projection 拆分为 `rawEvidenceIndex`、`discoveryWorkspace` 和 `wikiProjection` 三个逻辑层。
- [ ] `Must` `rawEvidenceIndex` 只保存脱敏后的原始对象索引、关联关系和 Evidence ID，不写入服务语义结论。
- [ ] `Must` `discoveryWorkspace` 保存 Codex 选出的调查对象、候选服务、分组过滤决策、假设、待探测项和未决问题。
- [ ] `Must` `wikiProjection` 只保存由 Codex 收敛后的服务知识条目和系统摘要。
- [ ] `Must` 将 `classificationCompleted` 改为 `discoveryCompleted`：它表示 Codex 已完成当前证据范围内的有效信息收敛，不表示每个 systemd unit 都有一条独立 assessment。
- [ ] `Must` 迁移或废弃 `reviewedServiceIds = snapshot.services` 的全量覆盖率门禁。
- [ ] `Must` 保持已有 AgentSession 可恢复；旧会话在恢复时明确显示为 `legacy_full_candidate_review`，不得混用新旧完成条件。

验收条件：

- 一个包含 300 个 systemd unit 的快照，不会在工作区自动产生 300 个待报告服务。
- 原始 unit 仍可通过 Evidence ID 追溯，但不必逐一写入 `unknowns/reviewItems`。

### M20-02 Codex 首轮筛选与调查计划

- [ ] `Must` 新增 `plan_discovery` 结构化决策：Codex 根据压缩后的证据索引输出保留组、过滤组、调查优先级和补探测计划。
- [ ] `Must` 支持按证据特征聚合普通系统 unit、内核/启动辅助 unit、无端口后台任务和容器运行时对象；聚合只降低上下文和调用成本，不形成最终语义事实。
- [ ] `Must` 首轮上下文突出端口暴露、失败状态、进程命令行、cgroup、容器/Compose、挂载、用户自定义路径和资源异常。
- [ ] `Must` Codex 可以将一组对象标为 `filtered_system_evidence`，并给出 Evidence ID、理由和统计；不得要求对组内每个对象创建 ServiceAssessment。
- [ ] `Must` 所有包含外部监听、失败状态、容器关联、自定义执行路径、数据挂载或冲突证据的对象不得被批量过滤，必须进入进一步调查或明确的待确认项。
- [ ] `Must` 过滤决策必须可被后续 Codex turn 推翻或提升为调查对象。
- [ ] `Should` 支持 `--focus-service` 或自然语言提示，将匹配证据直接提高到首轮调查优先级。

验收条件：

- `systemd-sysusers.service` 与 `systemd-tmpfiles-setup.service` 可在一次系统证据分组决策中进入系统摘要，不消耗两个独立服务语义回合。
- 一个非标准 Java/Go 程序即使没有本地产品名规则，也能因进程、端口或自定义路径线索进入调查队列。

### M20-03 受控二次 SSH 取证闭环

- [ ] `Must` 将 `execute_governed_probe` 从“预定义候选补探测”调整为由 Codex 调查计划触发的证据补全能力。
- [ ] `Must` 只接受结构化探测意图和受限参数，不接受 Codex 传入任意 Shell 字符串。
- [ ] `Must` 至少支持 unit 定义/状态、PID 命令行与 cgroup、监听端口归属、容器/Compose 元数据、已知根目录受限列表、脱敏配置片段和服务关联日志元数据。
- [ ] `Must` 每次探测必须关联已有 Evidence ID 或 Codex 已创建的调查对象，禁止无目标的大范围目录遍历。
- [ ] `Must` ProbeGovernor 继续限制探测次数、总时长、输出字节数、路径根、递归深度、匹配数和单次命令超时。
- [ ] `Must` 探测结果经过归一化、脱敏和 Evidence ID 生成后才可返回 Codex。
- [ ] `Must` 单次探测被拒绝、超时或失败时，保留原因并让 Codex 决定是否以 `unknown` 收敛，不使整个会话失败。
- [ ] `Should` 在 Agent transcript 中以“调查目的 + 结果摘要”展示探测，而非暴露完整命令和敏感输出。

验收条件：

- Codex 能发现一个疑似部署目录后请求有限详情，并将返回证据归并到对应服务。
- 非法路径、危险命令、无来源探测和超预算探测均在本地被拒绝。

### M20-04 服务归并与 Wiki 模块构建

- [ ] `Must` 新增 `apply_discovery_decision` 或扩展 `update_projection`，支持创建服务知识条目、合并多个 unit/进程/容器、附加路径/端口和记录过滤组。
- [ ] `Must` 服务条目必须由 Codex 决策创建，且至少引用一个有效 Evidence ID。
- [ ] `Must` 支持一个业务服务关联多个 systemd unit、进程、容器、Compose service、端口及部署/配置/日志/数据目录。
- [ ] `Must` 支持没有可确认产品名的服务，以描述性名称和 `unknown/needs_review` 状态进入 Wiki。
- [ ] `Must` 将系统信息、部署服务、中间件与数据服务、网络暴露面、存储与关键目录、风险和待确认事项作为 Codex 可选择的 Wiki 模块，而不是由本地固定服务名称决定。
- [ ] `Must` 将过滤组仅写入“系统与采集范围摘要”或审计附录，正文不逐项展开。
- [ ] `Must` 对所有最终服务字段继续执行 Evidence ID、脱敏和未知项质量门禁。

验收条件：

- Compose service、容器和宿主机端口可以在同一个服务知识条目中展示。
- 大量普通系统 unit 只表现为系统摘要统计，不污染服务索引和待确认事项。

### M20-05 Agent 循环、预算与终止规则

- [ ] `Must` 用“Codex 已完成调查计划、无高价值未决对象、所有必要补探测已执行或明确拒绝、Wiki Projection 通过质量门禁”作为完成条件。
- [ ] `Must` 不再以原始 service/path 数量作为轮次、进度百分比或完成门槛。
- [ ] `Must` Session 显示 `rawEvidence`、`activeInvestigations`、`resolvedServices`、`filteredGroups`、`pendingQuestions` 和剩余预算。
- [ ] `Must` 保持 `partial` 恢复语义：预算耗尽时保存当前调查计划、未执行 Probe 和下一步建议。
- [ ] `Must` 新会话或恢复会话优先继续高价值未决对象，不重复筛选已经稳定过滤的系统证据组。
- [ ] `Must` Codex 不可用、结构化输出无效或证据校验失败时，禁止生成声称完成的 Wiki。
- [ ] `Should` 增加“调查性价比”指标，记录每次补探测新增的有效服务事实、已解决问题或风险。

验收条件：

- 同一台含大量系统 unit 的主机可在合理 Agent turn 内完成，不需要靠 `--max-agent-runs 200` 才有机会收敛。
- CLI 进度不再显示“仍有 260 个服务待语义审查”，而显示实际待调查对象和未决问题。

### M20-06 Prompt、工具契约与审计迁移

- [ ] `Must` 删除“审查每个展示的普通 Linux 系统服务”和“所有 snapshot 服务必须有决策”的 Prompt 约束。
- [ ] `Must` Prompt 明确要求 Codex 先筛选、再按价值调查、最后归并，不得把原始目录或 unit 名当作直接事实。
- [ ] `Must` 将 `list_candidates` 改为读取调查工作区和按证据聚合的索引，不再默认返回全量未审查服务。
- [ ] `Must` 保留 `read_context`、`read_evidence`、`execute_governed_probe` 和 Projection 更新能力的完整 ToolActivity 审计。
- [ ] `Must` 新增筛选决策、过滤组、调查计划、Probe 请求、服务归并和报告生成之间的可追溯链路。
- [ ] `Must` 旧 M19 会话与新 M20 会话使用显式 `workflowVersion` 区分，避免恢复时套用错误 Prompt 或门禁。

## 4. M21：AI 服务器 Wiki 综合撰写

当前状态：`[-]` 本地实现与自动化测试已完成；真实 Codex 验收因上游 503 暂未完成。

- [x] `Must` 新增受 Schema 约束的 `compose_wiki` 工具，持久化 Codex 撰写的执行摘要、系统定位、部署架构、部署布局、运维说明、服务分组、重点发现和待确认项。
- [x] `Must` 将完整已评估服务、容器名、镜像名、端口、路径和 Evidence ID 作为 `wiki_source` 提供给最终撰写阶段。
- [x] `Must` 对能够从服务名、容器名或镜像名可靠识别的产品生成详细服务说明；无法识别的服务允许省略，不强制编造。
- [x] `Must` 服务详细说明和重点发现引用已有 Evidence ID，本地拒绝未知服务、重复描述和虚构 Evidence ID。
- [x] `Must` 调查完成但 `compose_wiki` 未完成时拒绝 `final` 和 v2 Wiki 报告生成。
- [x] `Must` 综合稿件 Thread 必须存在成功的 `compose_wiki` ToolActivity，可与分类 Thread、最终 Thread 不同。
- [x] `Must` HTML、Word、Markdown 以同一份 `WikiNarrative` 作为主叙事，同时保留结构化事实表格和证据附录。
- [x] `Must` 服务或调查投影发生变更时使旧综合稿件失效，防止过期总结进入报告。

验收条件：

- MinIO、Nexus、数据库等可识别服务具有面向运维人员的产品用途和部署说明，而不是只展示名称与字段表格。
- 报告包含由 Codex 撰写的服务器级概览、部署架构、服务分组和运维说明。
- Codex 不可用或综合稿件不符合 Schema 时，不生成声称完成的 v2 Wiki。

## 5. 测试与验收

### 5.1 单元与集成测试

- [ ] `Must` 验证 Snapshot 中的普通 systemd unit 不会自动创建等量的服务审查任务。
- [ ] `Must` 验证 Codex 可以通过一个聚合筛选决策过滤多个普通系统 unit，并保留可追溯统计与 Evidence ID。
- [ ] `Must` 验证包含外部端口、失败状态、容器关联或自定义路径的对象无法被批量隐藏。
- [ ] `Must` 验证 Codex 调用受控二次探测后，新证据能更新调查对象并归并到服务条目。
- [ ] `Must` 验证任意 Shell 字符串、禁止路径、无来源参数、超时和超预算探测均被拒绝。
- [ ] `Must` 验证 Codex 结构化输出错误、SSH 中断和预算耗尽后可恢复，不生成伪完成 Wiki。
- [ ] `Must` 验证 HTML、Word、Markdown 仅使用收敛后的 Wiki Projection，普通系统 unit 不逐项出现在服务正文。

### 5.2 真实服务器验收

- [ ] `Must` 对普通 Linux 主机验证：系统 unit 被聚合，服务索引仅保留有效部署服务、重要支撑组件和明确待确认对象。
- [ ] `Must` 对 Docker/Compose 主机验证：容器、镜像、Compose、宿主机端口和挂载被正确归并；bridge、veth、overlay 不进入正文。
- [ ] `Must` 对非标准服务验证：Doris、Hadoop、MinIO 或自研 Java/Go 服务至少一种可由 Codex 结合证据发现，无需新增产品名硬编码。
- [ ] `Must` 对不确定服务验证：保留证据、未知项和人工复核建议，不虚构服务用途、路径或操作命令。
- [ ] `Must` 记录总 Agent turn、Codex 请求、补探测次数、有效服务数、过滤组数量和总耗时，与旧全量审查流程比较。

## 6. 实施顺序与提交建议

```text
M20-01 工作区与收敛状态
  -> M20-02 首轮筛选与调查计划
  -> M20-03 受控二次 SSH 取证
  -> M20-04 服务归并与 Wiki 模块
  -> M20-05 循环、预算和终止规则
  -> M20-06 Prompt、工具契约与会话迁移
  -> M21 AI 服务器 Wiki 综合撰写
  -> 测试与真实服务器验收
```

建议拆分提交：

1. `refactor: separate raw evidence from agent discovery workspace`
2. `feat: add codex discovery planning and evidence grouping`
3. `feat: drive governed probes from codex investigations`
4. `refactor: build wiki services from codex discovery decisions`
5. `fix: converge agent by investigation completeness instead of unit coverage`
6. `test: cover evidence-driven discovery and system-unit grouping`

## 7. Definition of Done

- [ ] 原始 Snapshot 是可检索证据库，不再等同于服务器 Wiki 的服务目录。
- [ ] Codex 在首轮即可筛选和分组普通系统对象，不逐项耗费服务审查回合。
- [ ] Codex 可以根据发现结果发起受控、只读、可审计的二次 SSH 取证。
- [ ] 最终服务、部署路径、配置、日志、数据和端口均由 Codex 基于 Evidence 归并产生。
- [ ] 过滤不删除事实，并可在后续调查中被 Codex 推翻。
- [ ] 普通 systemd unit、容器网络和运行时挂载不污染 Wiki 正文或未决问题列表。
- [ ] Agent 以有效调查完成度而非原始 unit 数量收敛，并可在预算耗尽后恢复。
- [ ] HTML、Word、Markdown 从同一份经质量门禁的服务器 Wiki Projection 生成。
- [x] HTML、Word、Markdown 使用同一份 Codex `WikiNarrative` 作为知识手册主叙事，并包含可识别服务的 AI 详细说明。
