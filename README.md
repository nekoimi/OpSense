# OpSense

> 本地优先、证据驱动的 Linux 服务器部署发现工具。通过只读 SSH 快速识别服务器部署内容，并生成 Markdown、HTML 和 DOCX 报告。

OpSense v3 将首次盘点改为固定、可度量的流水线。它批量采集 systemd、进程、端口、Docker/Compose 和路径元数据，在本地构建 Resource Graph 与高价值候选，再使用少量 Codex 结构化调用完成语义归并、可选补探测和 Wiki 撰写。

项目目前处于 Alpha 阶段。v3 是全新主线，不兼容旧工作区、CLI、Projection 或 Agent Session。

## 工作流程

```text
只读 SSH 批量采集
  → Resource Graph
  → 本地 Deployment Candidate / unverified Inventory
  → Batch Discovery
  → 最多一轮 Governed Probe + Reconciliation
  → 稳定 Deployment Inventory
  → Wiki Projection
  → Markdown / HTML / DOCX
```

报告生成后，可以让 Agent 针对稳定 Inventory 继续调查。Agent 不连接服务器、不重新扫描，也不覆盖基线文件；它只追加 Inventory Revision 和 Wiki Revision。

## 核心约束

- 初扫不递归读取全部目录或配置内容。
- systemd、Docker inspect 和路径 stat 使用批处理，避免逐对象 N+1。
- Docker、Compose、监听进程、自定义 unit、自定义路径和冲突对象必须保留或明确标记待确认。
- standard profile 默认最多一轮 Probe，Pipeline AI 调用有全局硬预算。
- Codex 输出必须通过本地 Schema、Service/Candidate/Object/Evidence 引用和完整度校验。
- Codex 不可用时保留语义状态为 `unverified` 的本地 Inventory。
- 所有服务器操作都来自只读命令目录；凭据不写入工作区。

## 环境要求

- Node.js `>= 22`
- pnpm `10.x`
- Linux 目标服务器和可用的 SSH 账户
- 需要 AI 语义归并时，本机 Codex SDK 已登录

## 快速开始

```powershell
pnpm install
pnpm run check
pnpm dev -- --help
```

完整扫描并生成三种报告：

```powershell
pnpm dev -- inspect `
  --host server.example.com `
  --port 22 `
  --user ops `
  --identity "C:\Users\me\.ssh\id_ed25519" `
  --accept-new-host-key `
  --profile standard `
  --provider codex `
  --workspace "$HOME\.opsense"
```

也可以分阶段执行：

```powershell
pnpm dev -- scan --host server.example.com --user ops --identity "C:\Users\me\.ssh\id_ed25519"
pnpm dev -- discover --scan <scan-id> --provider codex
pnpm dev -- report --inventory <inventory-id>
```

报告后调查：

```powershell
pnpm dev -- agent `
  --inventory <inventory-id> `
  --prompt "说明订单服务的部署位置、端口和仍缺少的证据" `
  --provider codex
```

## CLI

| 命令                | 用途                                              |
| ------------------- | ------------------------------------------------- |
| `opsense scan`      | 批量采集证据并生成本地候选与 unverified Inventory |
| `opsense discover`  | 对已有扫描执行 Batch Discovery                    |
| `opsense inspect`   | 执行 v3 完整流水线并生成三种报告                  |
| `opsense report`    | 从稳定 Inventory 离线重建报告                     |
| `opsense agent`     | 对稳定 Inventory 执行报告后调查并追加 Revision    |
| `opsense benchmark` | 查看或比较持久化运行的性能指标                    |

## 工作区

```text
~/.opsense/
|-- config.json
|-- known-hosts.json
|-- runs/<scan-id>/
|   |-- run.json
|   |-- metrics.json
|   |-- snapshot.json
|   |-- resource-graph.json
|   |-- candidates.json
|   |-- discovery.json
|   |-- probe-plan.json
|   |-- probe-results.json
|   |-- inventory.json
|   |-- wiki.json
|   |-- inventory-revisions.jsonl
|   `-- wiki-revisions.jsonl
`-- reports/<host>/<scan-time>/
    |-- README.md
    |-- index.html
    `-- 服务器部署清单.docx
```

## 性能和发布验收

```powershell
pnpm run evaluate:v3
pnpm dev -- benchmark --run <run-id>
pnpm dev -- benchmark --compare <old-run-id> <new-run-id>
pnpm run release:v3
```

`evaluate:v3` 执行仓库内六类合成样本门禁。`release:v3` 还要求 Debian/Ubuntu、RHEL/Rocky、非 systemd、Docker/Compose、自研服务和最小权限六类真实服务器脱敏指标；缺少真实证据时会按设计阻止发布。

详细设计和验收规则见 [docs/v3.0/README.md](docs/v3.0/README.md)。

## Monorepo

| 模块                                         | 职责                                                      |
| -------------------------------------------- | --------------------------------------------------------- |
| `apps/cli`                                   | CLI 和端到端 Pipeline 编排                                |
| `packages/collection-runtime`                | 全局 Scheduler、Pipeline 状态和指标                       |
| `packages/collectors`                        | 系统、服务、容器与路径批量采集                            |
| `packages/correlation`                       | Resource Graph 和确定性关联                               |
| `packages/discovery`                         | Candidate 保护、Batch 校验、Probe 治理和稳定 Inventory    |
| `packages/ai-provider` / `packages/ai-codex` | Batch Discovery、Reconciliation、Wiki 和报告后 Agent 接口 |
| `packages/wiki` / `packages/report`          | v3 Wiki 质量门禁与三格式渲染                              |
| `packages/evaluation`                        | 基准比较和发布指标门禁                                    |
| `packages/schema`                            | v3 数据契约                                               |
| `packages/redaction`                         | 脱敏和敏感信息控制                                        |
| `packages/ssh`                               | 主机密钥、只读命令与 SSH 执行                             |
| `packages/workspace`                         | 原子持久化与工作区布局                                    |

## 开发

```powershell
pnpm run build
pnpm run typecheck
pnpm run lint
pnpm run test
pnpm run check
```

测试使用本地 fixture，不会连接真实服务器。
