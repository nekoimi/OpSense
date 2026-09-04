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
- `scan` 与 `inspect` 支持 `--profile fast|standard|deep`，默认 `standard`。
- `fast` 和 `standard` 初扫只构建路径种子；仅 `deep` 执行原 M5 递归目录与配置读取，从默认链路移除主要 N+1 来源。

这一批完成了 M30 的扫描侧骨架，并启动了 M31/M32。全流程指标与预算执行、批量 systemd/Docker/stat、Resource Graph、稳定 Deployment Inventory 和 Batch Discovery 尚未完成，不能把当前状态视为 v3.0 Definition of Done。
