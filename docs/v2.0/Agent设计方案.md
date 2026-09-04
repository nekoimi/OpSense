# OpSense Agent 设计方案

## 1. 文档目的

本文档定义 OpSense 的 Agent 运行时、能力边界、上下文、状态、工具协议、Codex 接入方式、失败处理和验收标准。

本文档解决的问题不是“如何调用一次 Codex”，而是：

> 如何让用户通过本地 CLI 与 Codex Agent 持续交互，使 Agent 在安全边界内观察扫描结果、提出服务和路径假设、申请证据、验证判断，并按需生成服务器 Wiki 文档。

本文档依赖：

* `docs/需求文档.md`
* 现有的扫描、归一化、脱敏、ProbePlan 和报告能力
* `@openai/codex-sdk` 的 Thread 能力

首期 Agent 仍然是本地 CLI Agent，不建设 Web Agent 服务，不引入远程 Agent 主机，不允许模型直接连接服务器。Codex 是 Agent 的硬依赖，Word、HTML 和 Markdown 是 Agent 会话的输出产物。

## 2. 设计结论

### 2.1 Agent 的定义

OpSense Agent 是一个由 Codex 驱动、由本地程序托管的循环：

```text
模型读取上下文和能力
  -> 模型选择下一步动作
  -> 本地校验并执行能力
  -> 执行结果进入上下文
  -> 模型继续判断或结束
```

Agent 不是一组固定 Prompt 的串联，也不是允许 AI 自由执行 Shell 的远程运维机器人。

### 2.2 信任边界

模型可以负责：

* 识别服务语义和用途。
* 发现证据缺口。
* 判断哪些网络、挂载和系统服务应该进入正文、摘要或附录。
* 选择下一个结构化工具动作。
* 组织服务器 Wiki 文档和服务知识条目。
* 发现事实冲突、过度推断和未确认字段。

模型不能负责：

* 直接构造和执行远程 Shell。
* 修改原始快照中的事实。
* 绕过本地路径、命令、深度、字节和请求数限制。
* 自行扩大 SSH 权限或访问未脱敏数据。
* 将推断内容写成确定事实。
* 修改目标服务器状态。

### 2.3 首期复杂度

首期采用单 Agent、单 Codex Thread、有限工具和可恢复会话：

* 默认最多 6 个 Agent turn。
* 默认最多 1 轮远程补探测。
* 默认最多 8 个结构化补探测请求。
* 每一轮最多读取本地上下文预算和输出预算由本地控制。
* 不实现多 Agent 并行协作，不实现自动子 Agent，不实现长期记忆库。
* Agent 启动前必须完成 Codex CLI/SDK、登录、模型和 Thread 能力预检；预检失败不创建可运行会话。

只有在样本评估证明单 Agent 上下文不足时，才考虑拆分子 Agent。

## 3. 总体架构

```text
+------------------ 本地 OpSense CLI ------------------+
|                                                      |
|  Agent Command / CLI REPL                           |
|       |                                              |
|  Agent Orchestrator                                  |
|   |- Session Store                                   |
|   |- Context Builder                                 |
|   |- Budget / State Guard                            |
|   |- Tool Router                                     |
|   `- Report Quality Gate                             |
|       |                                              |
|       +--> CodexProvider / Codex Thread              |
|       |       只读取脱敏 AI workspace                 |
|       |                                              |
|       +--> Local Structured Tools                    |
|               |- Snapshot / Evidence Reader          |
|               |- Candidate and Projection Reader     |
|               |- Governed Probe Executor             |
|               |- Projection / Wiki Builder           |
|               `- Report Reviewer                      |
|                                                      |
+------------------------------------------------------+
                       |
                       v
          SSH SafeCommandExecutor（只读命令模板）
                       |
                       v
                 目标 Linux 服务器
```

### 3.1 模块职责

#### `AgentOrchestrator`

负责启动、恢复和结束 Agent，会话状态、轮数、超时、取消、预算和最终结果持久化。

#### `InteractiveCli`

负责 `opsense agent` 的交互体验：接收自然语言问题和固定命令、展示阶段和工具调用摘要、维护同一 Agent session 的上下文，并将 AgentResponse 渲染为终端可读内容。CLI 不承担服务判断和报告分类。

#### `ContextBuilder`

负责为模型按需提供脱敏、压缩、分层的上下文，不把完整快照一次性塞入 Prompt。

#### `ToolRouter`

负责解析模型的结构化工具调用，校验 Schema，执行本地工具，并将工具结果写回 Thread。

#### `ProbeGovernor`

负责检查补探测请求的路径来源、服务引用、最大深度、命中数、字节数、超时时间和总预算。

#### `ProjectionBuilder`

负责从原始快照、Agent 决策和补充证据生成资源展示投影和服务器 Wiki 文档草稿，不直接让模型输出最终事实数据库。

#### `ReportQualityGate`

负责在 Word/HTML 渲染前检查网络噪声、挂载噪声、普通系统服务展开、证据引用、未知字段和敏感数据。

## 4. Agent 循环

### 4.1 循环模型

Agent 运行时保持一个简单循环，不将每一步判断硬编码为固定流程：

```text
while session.canContinue:
    context = contextBuilder.nextContext(session)
    decision = codexThread.run(context, tools)

    if decision.kind == "tool_call":
        result = toolRouter.execute(decision.toolCall)
        session.appendToolResult(result)
        continue

    if decision.kind == "draft_update":
        projectionBuilder.apply(decision.patch)
        session.appendDraft(decision)
        continue

    if decision.kind == "final":
        qualityGate.validate(decision.output)
        session.complete(decision.output)
        break

    session.fail("invalid agent decision")
```

本地程序控制“能不能继续”和“动作是否合法”，模型控制“下一步最有价值的观察或判断是什么”。

### 4.2 运行阶段

阶段用于状态展示和质量门禁，不用于限制模型只能按固定顺序思考：

```text
created
  -> bootstrapping
  -> investigating
  -> enriching
  -> validating
  -> composing
  -> reviewing
  -> completed / partial / failed / interrupted
```

模型可以在 `investigating` 阶段读取证据、修改假设或申请补探测；本地运行时在达到预算、没有新增信息或质量通过时结束。

### 4.3 收敛条件

Agent 在以下任意条件满足时结束：

* 主要服务已经达到最低证据覆盖率。
* 主机网络和主机挂载展示投影已经完成。
* 连续两轮没有产生新的证据、服务分类或报告变更。
* 达到最大 turn、最大时间、最大 Token 或最大补探测预算。
* Codex Thread 创建、恢复或调用失败，经过有限重试后将会话置为 `failed`，保留现场供恢复。
* 用户发送 Ctrl+C，安全停止当前动作并关闭 SSH。

## 4.4 CLI Agent 交互模型

主入口和非交互入口：

```bash
opsense agent --host <host> --user <user> --provider codex
opsense agent --scan <scan-id> --provider codex
opsense agent --resume <agent-session-id>
opsense agent --scan <scan-id> --prompt "列出对外暴露的主要服务" --once
```

交互式固定命令：

* `status`：显示阶段、预算、覆盖率和最近动作。
* `services`：列出主要服务、支撑组件和待确认候选。
* `show <service-id>`：查看指定服务知识条目和证据缺口。
* `review`：查看风险、冲突和待人工确认事项。
* `wiki`：执行质量检查并生成服务器 Wiki 文档产物。
* `resume`：从当前状态继续未完成的调查。
* `exit`：安全结束会话并持久化状态。

自然语言问题和固定命令共用同一个 AgentSession。`--once` 只执行一轮并输出 AgentResponse，不进入 REPL。`--complete` 在首次 SSH 扫描后自动恢复本地 AgentSession，直到 Codex 完成全部服务与路径审查，并自动生成 HTML、Word 和 Markdown 服务器 Wiki；该模式不重新连接服务器。

每轮返回统一的 `AgentResponse`：

```text
AgentResponse
  |- message
  |- observations
  |- toolActivity
  |- evidenceReferences
  |- updatedEntities
  |- unresolvedQuestions
  |- wikiArtifacts
  `- nextSuggestions
```

`message` 面向用户，其他字段供 CLI 展示、审计和后续轮次使用；事实内容必须来自结构化投影和 Evidence ID。

## 5. Agent 能力设计

首期只提供 5 类能力。能力少而清晰，避免让模型在大量相似工具中迷失。

### 5.1 `read_context`

读取脱敏上下文索引或指定章节。

允许的 section：

* `host`
* `storage`
* `network`
* `services`
* `processes`
* `containers`
* `systemd_summary`
* `path_candidates`
* `findings`
* `visibility_summary`

限制：

* 只能读取已生成的 AI workspace 或本地投影。
* 默认返回摘要、数量和 ID，不返回完整原始大对象。
* 需要详情时必须通过 ID 分页读取。
* 不返回密码、密钥、环境变量值和未脱敏内容。

### 5.2 `read_evidence`

根据 Evidence ID 读取某条证据的结构化摘要。

返回字段：

* Evidence ID。
* 来源命令或来源文件。
* 采集时间。
* 状态。
* 脱敏后的值摘要。
* 关联服务、路径和资源对象。

限制：

* 单次最多读取固定数量 Evidence。
* 超长 stdout 只能读取解析后的摘要和局部片段。
* 被脱敏规则替换的内容不可恢复。

### 5.3 `list_candidates`

获取一次性轻量服务过滤索引。默认返回当前全部服务候选，单次最多 500 条；超过上限时才根据 `nextOffset` 读取下一页。

每个条目只保留服务过滤需要的关键信息：服务 ID、名称、部署方式、运行状态、systemd 描述或关键命令、容器镜像、监听端口、单个路径提示、保护标记和一个可用于规划的 Evidence ID。不返回完整目录集合、挂载、容器详情、进程参数、当前路径评估或 Evidence ID 列表。

模型可以据此判断：

* 哪些服务可能是主要部署服务。
* 哪些 systemd unit 只是操作系统服务。
* 哪些候选证据不足，需要进一步调查。

该能力只读，不改变分类结果。完整索引读取进度持久化到 AgentSession；同一页被重复请求时只返回已读状态，防止 Codex Thread 切换后重复传输大块上下文。进程、容器、systemd unit、路径、网络和存储详情必须通过 `read_context` 或 `read_evidence` 按需读取。

### 5.4 `execute_governed_probe`

执行一个由模型提出的结构化 `ProbeRequest`。模型不能提供 Shell 字符串，只能选择以下类型：

* `directory_metadata`
* `directory_listing`
* `config_summary`
* `path_search`

本地执行前必须经过：

1. Schema 校验。
2. 引用 Evidence ID 校验。
3. 目标服务 ID 校验。
4. 搜索根目录和已知路径来源校验。
5. 禁止目录校验：`/proc`、`/sys`、`/dev`、`/run`、overlay storage 等。
6. 深度、命中数、超时、单请求字节和总预算校验。
7. 审计记录生成。

执行结果只返回解析后的结构化证据，并重新进入归一化和脱敏流程。

### 5.5 `update_projection`

提交结构化的展示决策或服务器 Wiki 草稿，不直接覆盖原始快照。

允许的更新对象：

* `VisibilityDecision`：正文、摘要、附录或过滤。
* `ServiceAssessment`：角色、用途、置信度和理由。
* `ServiceWikiEntryDraft`：服务知识条目字段草稿。
* `FindingDraft`：风险和待确认事项。

每个更新必须包含：

* 目标对象 ID。
* 新值。
* 理由。
* Evidence ID 列表。
* 置信度。
* 是否需要人工确认。

本地 Projection Builder 负责拒绝没有证据引用、越权改变事实字段或违反报告策略的更新。

## 6. 上下文设计

### 6.1 上下文分层

上下文按成本和相关性分为三层：

#### L0：运行摘要

每轮都提供：

* 目标服务器和 scan ID。
* 当前 Agent 阶段、轮数和预算。
* 服务候选数量、主要服务数量、待确认数量。
* 当前报告完整度和未解决问题。
* 最近一轮工具结果摘要。

#### L1：结构化索引

按需提供：

* 服务候选索引。
* 主机网络和主机挂载候选索引。
* 进程、容器、unit、端口和路径之间的关联索引。
* Evidence ID 索引。

#### L2：证据详情

只在模型选择具体对象后提供：

* 指定 Evidence 详情。
* 指定服务的运行态详情。
* 指定目录的元数据和列表。
* 指定配置的脱敏结构摘要。

### 6.2 上下文压缩

* 大列表按重要性、异常状态、对外暴露和与主要服务的关联排序。
* 普通 systemd 服务只提供统计和异常索引。
* Docker 内部网络和运行时挂载默认为聚合计数，不逐条占用上下文。
* 重复证据只保留主证据 ID 和来源关系。
* 已被模型确认且没有新变化的上下文不重复发送全文。

### 6.3 知识按需加载

Agent 不在每次调用中注入全部规则，而根据任务加载：

* 服务分类规则。
* 主机网络过滤规则。
* 主机挂载过滤规则。
* 服务器 Wiki 文档和服务知识条目字段规范。
* Linux/systemd/Docker/Compose 解析说明。
* 非标准服务识别提示。

## 7. Codex 接入设计

### 7.1 Thread 使用方式

每个 AgentSession 对应一个 Codex Thread：

* 首次运行使用 `startThread`。
* 恢复运行使用 `resumeThread(threadId)`。
* Thread 工作目录只包含脱敏 AI workspace 和 Agent 临时状态。
* `approvalPolicy` 固定为 `never`。
* `networkAccessEnabled` 固定为 `false`。
* `sandboxMode` 使用只读模式。
* 不将 SSH 密码、私钥或原始快照放入 Thread 工作目录。

### 7.2 Prompt 组成

每轮 Prompt 由四部分组成：

```text
System Contract
  + Domain Knowledge
  + Current Context
  + Available Tools and Budgets
```

#### System Contract

固定声明：

* 事实优先、证据优先和未知优先。
* 只能通过结构化工具行动。
* 不得执行任意 Shell 或网络操作。
* 不得把推断写成事实。
* 必须返回符合 JSON Schema 的 AgentTurn。

#### Domain Knowledge

根据当前任务按需加载服务分类、过滤策略和手册字段说明。

#### Current Context

由 `ContextBuilder` 生成，包括当前阶段、摘要、候选、假设、最近工具结果和未解决问题。

#### Available Tools and Budgets

声明工具名称、参数 Schema、剩余预算和拒绝处理方式。

### 7.3 结构化输出

Agent 每一轮必须返回以下联合类型之一：

```text
AgentDecision
  |- tool_call
  |    |- toolName
  |    |- arguments
  |    `- reason
  |
  |- projection_update
  |    |- changes
  |    `- evidenceIds
  |
  `- final
       |- inventoryProjection
       |- serviceWikiEntries
       |- findings
       |- unresolvedQuestions
       `- qualitySummary
```

解析失败时由本地程序发起有限次数的格式修复；修复失败则将当前 AgentSession 置为 `failed`，不接受非结构化文本作为事实结果。

## 8. Agent 状态和持久化

### 8.1 AgentSession

```text
AgentSession
  |- sessionId
  |- scanId
  |- provider
  |- model
  |- threadId
  |- state
  |- currentStage
  |- startedAt / updatedAt / finishedAt
  |- turnCount
  |- probeRound
  |- budgets
  |- coverage
  |- userMessages
  |- agentResponses
  |- transcript
  |- unresolvedQuestions
  |- lastError
  `- outputFiles
```

### 8.2 AgentTurn

```text
AgentTurn
  |- turnId
  |- sequence
  |- startedAt / finishedAt
  |- inputContextHash
  |- decision
  |- toolCalls
  |- evidenceAdded
  |- projectionChanges
  |- tokenUsage
  |- status
  `- error
```

### 8.3 AgentResponse

CLI 面向用户展示的响应与 Agent 内部决策分离，响应必须能够引用本轮观察、工具活动和更新后的实体：

```text
AgentResponse
  |- responseId
  |- sessionId
  |- turnId
  |- message
  |- observations
  |- toolActivity
  |- evidenceReferences
  |- updatedEntities
  |- unresolvedQuestions
  |- wikiArtifacts
  `- nextSuggestions
```

同一会话中的每条用户消息、AgentResponse 和固定命令都必须进入 transcript，便于 `--resume` 后继续对话和审计。

### 8.4 本地文件

建议在每个 run 目录中增加：

```text
agent-session.json
agent-turns.jsonl
agent-transcript.jsonl
agent-hypotheses.json
agent-projection.json
agent-review.json
```

文件必须经过本地脱敏和 Schema 校验。不得写入 SSH 密码、私钥、完整环境变量值或未脱敏配置内容。

## 9. 服务发现与 Agent 协作

### 9.1 确定性层先做什么

底层扫描和归一化先提供：

* systemd unit、进程、PID、父子进程和启动路径。
* 监听 socket、主机端口和容器端口映射。
* Docker/Compose 容器、镜像、项目、服务名和宿主机挂载。
* 目录元数据、候选配置和路径种子。
* 主机磁盘、有效挂载、网络接口和路由。

确定性层不负责猜测服务业务用途，但必须保证关联 ID、来源和状态准确。

### 9.2 Agent 重点判断什么

Agent 重点处理：

* 这是业务应用、基础设施、边缘代理还是普通系统服务。
* 多个进程、容器和目录是否属于同一个部署服务。
* 非标准目录和非标准服务名称的语义用途。
* 哪些挂载是服务数据，哪些只是容器运行时实现。
* 哪些端口是主机对外暴露，哪些只在容器内部使用。
* 服务知识条目还缺少哪些关键事实。

### 9.3 服务覆盖率

每个主要服务计算覆盖率：

```text
coverage = 已确认的关键字段数量 / 关键字段总数
```

关键字段至少包括：

* purpose
* status
* deploymentType
* deployDirectory
* ports
* configFiles
* logLocations
* dataDirectories
* lifecycle
* evidenceIds

覆盖率不足时，Agent 可以申请受控补探测；达到阈值或预算耗尽时，必须明确列出未知字段。

## 10. 资源过滤与 Agent 决策

### 10.1 本地规则优先

以下过滤不交给模型单独决定：

* `/proc`、`/sys`、`/dev`、`/run` 等伪文件系统。
* Docker overlay2、容器 rootfs、shm 和运行时内部挂载。
* veth、Docker bridge、overlay 等默认容器网络。
* 无业务关联的普通 systemd 服务。
* 明显的缓存、依赖目录、源代码控制目录和运行时临时目录。

Agent 只能在本地规则允许的候选范围内，决定是否提升为服务附属信息或附录信息。

### 10.2 VisibilityDecision

模型可以提出：

```text
VisibilityDecision
  |- objectId
  |- objectType
  |- placement: primary | supporting | summary | appendix | filtered
  |- reason
  |- confidence
  |- evidenceIds
  `- userReviewRequired
```

Projection Builder 必须检查：

* 对象是否存在。
* Evidence ID 是否存在。
* placement 是否与资源过滤硬规则冲突。
* 是否把主机内部资源错误提升为主机对外资源。
* 是否有足够证据支撑服务归属。

## 11. 服务器 Wiki 文档生成

### 11.1 WikiEntryDraft

Agent 生成的服务器 Wiki 草稿不能直接渲染，必须先经过本地 Schema 和质量检查：

```text
WikiEntryDraft
  |- identity
  |- oneLineSummary
  |- purpose
  |- status
  |- deployment
  |- locations
  |- exposure
  |- lifecycle
  |- configuration
  |- storage
  |- logging
  |- evidence
  |- confirmedFacts
  |- inferences
  |- unknowns
  `- reviewItems
```

### 11.2 生命周期证据门禁

启动、停止、重启和日志查看方式按来源分级：

* `confirmed`：直接来自 systemd unit、Compose 文件或明确脚本。
* `inferred`：根据已确认部署方式和命令结构推断，但必须标记推断。
* `unknown`：没有足够证据，不生成确定命令。

Agent 不得仅根据服务名称套用常见启停命令。

### 11.3 报告质量检查

`ReportQualityGate` 至少检查：

* 每个主要服务是否有用途、状态、部署方式和证据。
* 每个正文端口是否能关联主机暴露或服务。
* 正文是否出现容器网络和容器 rootfs 噪声。
* 正文是否逐条展开普通系统服务。
* 每个确定结论是否引用 Evidence ID。
* 未确认字段是否进入 unknowns/reviewItems。
* 报告模型和脱敏扫描是否通过。

### 11.4 Codex 综合撰写门禁

服务调查完成后，Agent 不能直接把结构化字段填入模板并结束。Codex 必须调用 `compose_wiki`，基于完整的 `wiki_source` 生成并持久化 `WikiNarrative`：

* 服务器执行摘要、系统定位、部署架构、部署与数据布局、运维说明。
* 按实际语义组织的服务分组和重点发现。
* 可根据服务名、容器名和镜像名可靠识别的产品级服务说明，例如将明确的 MinIO 镜像说明为兼容 S3 API 的对象存储服务。
* 无法可靠识别的服务允许不生成产品说明，不得为了覆盖率编造用途。
* 服务说明和重点发现必须引用已有 Evidence ID；路径、端口、依赖、命令、备份和恢复能力不得脱离证据扩写。

`compose_wiki` 成功、综合稿件 Thread 审计通过后，Agent 才接受 `final`。HTML、Word 和 Markdown 使用同一份 AI 稿件作为知识手册主叙事，确定性模板只负责版式、事实表格、脱敏和证据附录。

## 12. 失败和中断

### 12.1 Codex 硬依赖与预检

Agent 启动前执行 Codex 可用性预检，至少验证：

* Codex CLI/SDK 可以被本地进程调用。
* 当前登录状态和凭据可用。
* 指定模型可用。
* 可以创建或恢复 Codex Thread。
* Thread 可以返回符合 AgentDecision Schema 的结构化结果。

预检失败时：

1. 写入 `agent-session.json` 和错误信息。
2. 将 session 标记为 `failed`，返回专用 CodexUnavailable 退出码。
3. 输出修复提示，不执行 Agent 工具、不连接服务器、不生成 Agent Wiki。
4. 保留已有 scan 快照，用户修复 Codex 环境后可以使用 `--resume` 继续。

本地基线分类可以用于扫描后的候选排序和单元测试，但不能替代 Agent 的最终分析。

### 12.2 Codex 运行失败

Codex 模型超时、Thread 中断或结构化输出反复失败时：

1. 按有限次数重试，并记录每次错误和重试次数。
2. 重试失败后保存当前 AgentSession、AgentTurn、transcript 和投影。
3. 将 session 标记为 `failed`，不生成“降级完成”的 Agent Wiki。
4. 用户修复模型、登录或网络环境后，通过 `--resume` 继续。

### 12.3 补探测失败

单个补探测失败不应导致整个 Agent 失败：

* 记录失败状态、错误和 Evidence ID。
* 保留已有服务器 Wiki 草稿和原始候选。
* 将缺失字段加入 `reviewItems`。
* 如果连续失败超过预算，结束 Agent 并生成部分报告。

### 12.4 Ctrl+C

收到第一次 Ctrl+C 时：

* 取消 Codex turn 和当前 SSH 命令。
* 不启动新的补探测。
* 写入当前 AgentSession 和 AgentTurn。
* 关闭 SSH 连接。
* 保留已生成快照和中间报告。
* 返回 `130`。

## 13. 安全设计

### 13.1 模型权限

Codex Thread 使用：

```text
approvalPolicy: never
networkAccessEnabled: false
sandboxMode: read-only
```

模型只读本地脱敏工作区，不读目标服务器、不发网络请求、不写入业务文件。

### 13.2 工具权限

所有有副作用或可能触达服务器的能力必须由本地代码实现。Agent 只能提交结构化参数，本地代码负责：

* 参数校验。
* 路径规范化。
* 白名单检查。
* 超时和输出限制。
* 资源预算。
* 审计记录。
* 结果脱敏。

### 13.3 敏感信息

以下内容不得进入 Agent 上下文和持久化 Agent 文件：

* SSH 密码、私钥和私钥内容。
* 完整环境变量值。
* Secret、Token、Cookie、Authorization 等敏感值。
* 未脱敏配置内容。
* 不必要的用户隐私数据。

## 14. 评估指标

### 14.1 过滤准确性

* 主机网络正文容器内部网络误展示率。
* 主机存储正文容器运行时挂载误展示率。
* 业务数据挂载漏展示率。
* 普通 systemd 服务误提升率。

### 14.2 服务知识条目质量

* 主要服务识别准确率。
* 主要服务证据覆盖率。
* 服务部署目录识别准确率。
* 主机暴露端口关联准确率。
* 生命周期信息证据准确率。
* 未知字段标记完整率。

### 14.3 Agent 效率

* 每个服务器平均 Agent turn 数。
* 每个服务平均补探测请求数。
* 无效或被拒绝 ProbeRequest 比例。
* 连续无进展 turn 比例。
* Codex 预检失败、调用失败和结构化重试比例。
* 从扫描开始到报告完成的总耗时。

### 14.4 报告可用性

通过人工验收检查：

* 能否在 5 分钟内找到主要服务清单。
* 能否在 2 分钟内找到指定服务的部署目录、配置、日志和数据位置。
* 能否区分主机端口与容器内部端口。
* 能否看懂哪些是事实、推断和未知。
* 是否需要翻阅原始附录才能理解主流程。

## 15. 实施计划

### A0：CLI Agent 入口

* 新增 `opsense agent` 命令，支持新建、基于 scan 进入和恢复 AgentSession。
* 实现交互式 REPL、自然语言问题、固定命令、`--prompt` 和 `--once`。
* 输出阶段状态、工具调用摘要、证据引用和 Wiki 产物路径。

### A1：Agent 契约和会话状态

* 定义 `AgentSession`、`AgentTurn`、`AgentDecision`、`AgentResponse`、`VisibilityDecision` 和 `WikiEntryDraft` Schema。
* 增加用户消息、transcript 和会话恢复索引。
* 增加状态、预算、恢复和中断机制。
* 暂时使用测试替身验证循环和持久化；Noop 不作为正式运行时 Provider。

### A2：上下文和 5 个基础能力

* 实现 `read_context`、`read_evidence`、`list_candidates`。
* 实现 `execute_governed_probe` 适配现有 ProbePlanValidator。
* 实现 `update_projection` 和本地 Projection Builder。

### A3：Codex Thread Agent

* 将现有 `CodexProvider.analyze()` 改造为 Agent Runtime 适配器。
* 增加结构化 AgentDecision 解析和有限格式修复。
* 支持同一 Codex Thread 的连续追问、Thread resume、超时、失败和审计；失败后不得静默降级为 Wiki。

### A4：资源过滤与报告质量门禁

* 实现主机网络和主机挂载 Projection。
* 实现系统服务摘要和容器噪声过滤。
* 将 ReportModel 改为只接收 Projection，不直接消费原始快照。

### A5：服务器 Wiki 文档生成

* 实现 WikiBuilder 和服务完整度评分。
* 重做 Word/HTML 服务章节、服务索引和待确认事项。
* 增加 Wiki 版、摘要版和审计版报告 profile。

### A6：样本评估和迭代

* 使用 Docker/Compose、systemd、非标准目录、Doris、Hadoop、MinIO 等样本验证。
* 统计过滤准确性、服务知识条目覆盖率和 Agent 成本。
* 只有质量门禁通过后才扩大 Agent 最大轮数或补探测权限。

## 16. 最小验收场景

### 场景一：Docker 噪声过滤

输入包含大量 bridge、veth、overlay、shm 和容器 rootfs 的服务器快照。

预期：

* 主机网络只展示主机网卡、IP、路由、DNS 和发布端口。
* 主机存储只展示真实磁盘、有效挂载和服务业务目录。
* 容器内部对象进入服务附属信息或审计附录。

### 场景二：多服务 Wiki 文档

输入包含 Nginx、业务 API、MySQL、Redis、MinIO 和多个 Compose 项目。

预期：

* 主要服务和支撑组件有清晰索引。
* 每个服务有用途、部署目录、配置、端口、日志、数据和启停证据。
* 普通 systemd 服务只出现在系统摘要。

### 场景三：非标准服务

输入包含 Doris、Hadoop、自研 Java 服务或没有标准目录名的服务。

预期：

* Agent 根据镜像、进程、端口、unit、路径和配置线索形成假设。
* 必要时提出结构化补探测。
* 无法确认时进入待确认服务，不生成虚假用途。

### 场景四：Codex 预检失败

预期：

* 保存 Agent 错误和失败状态。
* 不启动 Agent 工具、不连接服务器、不生成 Agent Wiki。
* 输出 Codex 登录、模型或 Thread 配置修复提示。
* 修复后可以通过 session ID 恢复。

### 场景五：恢复 Agent

在 Agent 执行过程中中断，之后使用 `--resume-agent <session-id>` 继续。

预期：

* 恢复原 Thread、上下文摘要、假设、预算和已执行 ProbeRequest。
* 不重复执行已经成功的补探测。
* 继续生成最终服务器 Wiki 文档。

## 17. 最终原则

OpSense Agent 的目标不是让模型“拥有服务器权限”，而是让模型在严格受控的能力边界内更好地利用已有证据：

```text
采集器保证事实
归一化层保证关联
过滤层保证报告干净
Agent 负责调查和解释
质量门禁保证结果可信
报告层负责知识组织和交接查阅
```

只有这六层职责同时成立，OpSense 才能从“扫描结果摘要”升级为真正可用的服务器 Wiki 文档。
