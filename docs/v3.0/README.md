# OpSense v3.0 设计文档

v3.0 将 OpSense 的首次服务器盘点从“多轮 Agent 调查”调整为“固定高性能流水线”，优先快速产出部署清单，再对少量高价值未知项执行受控补探测。交互式 Agent 移到报告生成之后，用于继续调查和修订 Wiki。

v3.0 是未正式发布项目的全新主线，不兼容旧版数据、CLI、工作区或 Agent Session，也不建设双轨兼容和迁移层。

## 文档索引

- [架构设计 v3.0](./架构设计v3.0.md)：产品流程、架构分层、模块职责、完成门禁、安全边界和关键架构决策。
- [技术方案 v3.0](./技术方案v3.0.md)：命令批处理、采集调度、资源图、数据契约、AI 批量调用、测试和全新主线实施里程碑。

## 核心目标

- 一分钟内优先产出证据型部署清单。
- 正常完整流程只执行 2～3 次 Codex 应用层调用。
- 默认最多一轮按需补探测。
- systemd、Docker、路径和配置采集不再产生逐对象 N+1 调用。
- Codex 不可用时保留可用的本地扫描结果，并明确标记语义未经 AI 确认。

## 当前落地状态

首批 v3.0 基础改造已经进入主线，完成内容包括：

- 新增 `PipelineRun v3`、全局预算和 `RunMetrics v3` Schema。
- 每次扫描持续写入 `run.json` 与 `metrics.json`，记录阶段、检查点、SSH 命令次数和耗时。
- 新增共享 Collection Scheduler，支持统一并发、优先级、依赖、取消和运行内语义缓存。
- M3、M4、M5 采集器已移除各自重复的并发辅助实现，统一使用 Collection Runtime。
- M3 与 M4 基线采集已并行运行，并由同一个全局 Scheduler 限制为最多 4 个 SSH channel；审计写入改为阶段末汇合，不阻塞后续 channel 调度。
- systemd 详情按 48 个 unit 分块、Docker inspect 按 48 个容器分块；失败批次使用二分隔离，正常路径不再逐对象查询。
- 初始路径元数据按 64 个路径执行批量 `stat`，不读取配置内容。
- `scan` 与 `inspect` 支持 `--profile fast|standard|deep`，默认 `standard`。
- `fast` 和 `standard` 初扫只构建路径种子；仅 `deep` 执行原 M5 递归目录与配置读取，从默认链路移除主要 N+1 来源。
- 新增独立 Correlation 模块，构建 host、unit、process、socket、container、Compose、mount 和 path 的 Resource Graph；只有确定性强边参与自动归并。
- 新增高价值 Candidate 保护与普通系统对象聚合，并在 `inventory_ready` 阶段持久化 `resource-graph.json`、`candidates.json` 和语义状态为 `unverified` 的本地 `inventory.json`。
- `opsense discover --scan <scan-id>` 使用 v3 Batch Discovery：一次提交全部紧凑候选，持久化 `discovery-input.json` 与 `discovery.json`。
- Batch Discovery 对 ServiceDraft 逐项执行 Schema 和 Candidate/Object/Evidence 引用校验，并用 Completion Gate 阻止候选遗漏、重复归属和输入哈希错配；修复只在同一 Codex thread 内进行。
- 每个候选最多向 Codex 携带 4 个 unit、4 个进程、4 个容器、4 个 Compose 项目、8 个端口、12 个路径和 12 个 Evidence ID，超出部分只记录计数。
- Codex 不可用或修复失败时，所有受保护候选会进入 `retainedUnknownCandidateIds`，已有本地清单不被覆盖。
- M34 受控补探测会依次执行来源与预算治理、语义去重、祖先路径覆盖合并和批量调度；unit、container、stat 批次上限分别为 48、48、64，目录型任务最多 2 并发。
- 补探测对象级结果先脱敏回流 Evidence，随后最多执行一次同 thread Reconciliation；修正阶段禁止申请第二轮 Probe，并共享 Pipeline 的 AI 调用硬预算。
- Batch Discovery 结果会冻结为 ID 稳定的 Deployment Inventory；Service ID 由本地依据来源对象生成，Codex 只负责有证据引用的名称、角色与用途归因。
- Wiki 由稳定 Inventory 构建确定性骨架，可在同一 Codex thread 内一次完成叙述层撰写；本地质量门禁校验 Inventory hash、Service/Evidence 引用与覆盖率。
- Markdown、HTML、DOCX 报告只消费 v3 Inventory 与 Wiki，不再依赖 Agent final turn；`opsense report --inventory <inventory-id>` 可离线重建三种格式。
- `inspect` 已切换为 `scan → discover → governed probe（可选）→ finalize → report` 的 v3 固定主链路。
- 报告后 Agent 只接受 `--inventory <inventory-id> --prompt <text>`，不连接服务器、不触发扫描，也不覆盖稳定 Inventory/Wiki；修订以 append-only 的 `inventory-revisions.jsonl` 与 `wiki-revisions.jsonl` 保存。
- 旧 Projection 包、旧首次扫描 Agent loop、`--max-agent-runs`、旧报告渲染链和对应兼容 Schema/测试已删除。

当前已完成 M30～M36 的代码链。M37 的仓库内样本评测、准确率/性能发布门禁仍在建设；真实服务器 P95 一分钟验收需要在目标环境保存脱敏指标，在完成该验收前不能把当前状态视为 v3.0 Definition of Done。
