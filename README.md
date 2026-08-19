# OpSense

> 本地优先、Codex 驱动的 Linux 服务器发现 Agent。通过只读 SSH 收集运行证据，识别真实部署服务，并生成 HTML、Word 和 Markdown 服务器 Wiki。

[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![pnpm](https://img.shields.io/badge/pnpm-10.x-F69220?logo=pnpm&logoColor=white)](https://pnpm.io/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Status](https://img.shields.io/badge/status-alpha-E5A50A)](#项目状态)

OpSense 面向需要快速理解陌生 Linux 服务器的开发和运维人员。它不会只输出一份系统巡检摘要，而是关联 systemd unit、进程、监听端口、Docker/Compose、目录、配置、日志和数据路径，让 Codex 完成服务筛选、按需调查、服务归并和 Wiki 撰写。

项目当前以本地 CLI 运行，不包含 Web 管理后台。每次任务只调查一台服务器，扫描数据、Agent 会话和报告均保存在本地工作区。

## 核心能力

- **多来源服务发现**：关联 systemd、`ps` 进程树、socket、cgroup、Docker/Compose 和非标准部署目录，避免只识别容器服务。
- **证据驱动 Agent**：Codex 先过滤普通 Linux 系统服务，再对有效部署候选进行调查；证据不足时可以申请受控只读补探测。
- **发行版适配**：支持 Debian、RHEL、Alpine 及未知 Linux 发行版，并为命令缺失、选项差异和非 JSON 输出提供降级路径。
- **服务器 Wiki**：由 AI 组织服务器定位、部署架构、服务分组、服务用途、端口、配置、日志、数据路径、风险和待确认事项。
- **多格式报告**：生成自包含 HTML、Word（DOCX）和 Markdown；HTML/Word 包含 OpSense 水印与版权标识。
- **本地可恢复会话**：扫描、Projection、Codex Thread、ToolActivity 和报告产物可审计；超时或限流后可以通过 Session ID 继续。
- **安全与脱敏**：命令白名单、主机密钥校验、结构化探测治理、敏感字段分级和报告前二次脱敏均为默认行为。

## 工作流程

```mermaid
flowchart LR
    A[只读 SSH 扫描] --> B[Snapshot 原始证据]
    B --> C[轻量服务过滤索引]
    C --> D[Codex 调查计划]
    D --> E[按需只读补探测]
    E --> F[服务归并与语义判断]
    F --> G[Codex 撰写服务器 Wiki]
    G --> H[HTML / Word / Markdown]
```

本地规则只负责采集、关联、安全约束和防遗漏门禁，不负责最终业务语义判断。Docker/Compose、监听端口、直接运行进程、自定义 systemd unit、失败服务和非标准路径候选不能被静默过滤。

## 项目状态

OpSense 目前处于 **Alpha** 阶段，适合在可控环境中试用和参与开发：

- 已完成系统、存储、服务、目录、归一化、脱敏和基础报告链路。
- 当前采用必须依赖 Codex 的证据驱动 Agent 工作流。
- 当前仍在持续优化大规模服务清单下的 Token 消耗、调查收敛速度和真实服务器兼容性。
- CLI、Schema 和本地工作区可能在后续版本发生不兼容调整。

## 环境要求

本地环境：

- Node.js `>= 22`，仓库当前使用 `24.14.0`
- pnpm `10.x`
- 可用并已登录的 Codex CLI/SDK
- Windows PowerShell、PowerShell 7 或其他能够运行 Node.js 的终端

目标服务器：

- Linux 服务器和可用的 SSH 账户
- 账户能够读取需要调查的系统、进程、容器和部署目录信息
- 非 root 账户需要具备必要命令的 sudo 权限；无法使用 `sudo -n` 时，交互式终端会隐藏提示一次 sudo 密码并在本次运行中复用
- Docker 信息的完整度取决于 SSH 账户是否有权访问 Docker daemon

## 快速开始

### 1. 获取源码

```powershell
git clone https://github.com/nekoimi/OpSense.git
cd OpSense
fnm use
pnpm install
```

仓库默认使用 `https://registry.npmmirror.com/` 作为 npm registry。

### 2. 检查 Codex 和项目环境

```powershell
codex --version
pnpm run check
pnpm dev -- --help
```

OpSense 不会在 Codex 不可用时降级生成一份看似完整的 Wiki。请先确保本机 Codex 登录状态、模型和 Thread 能力正常。

### 3. 完整扫描并生成 Wiki

推荐使用 SSH 私钥：

```powershell
pnpm --filter @opsense/cli dev -- agent `
  --host server.example.com `
  --port 22 `
  --user ops `
  --identity "C:\Users\me\.ssh\id_ed25519" `
  --accept-new-host-key `
  --provider codex `
  --model gpt-5.6-luna `
  --workspace "$HOME\.opsense" `
  --complete `
  --max-agent-rounds 16 `
  --max-agent-runs 200 `
  --max-probes 20 `
  --turn-timeout-ms 300000
```

在可信内网中也可以临时使用密码。下面的写法不会把密码明文写入 PowerShell 历史：

```powershell
$sshPassword = Read-Host "SSH password" -MaskInput

pnpm --filter @opsense/cli dev -- agent `
  --host server.example.com `
  --port 22 `
  --user ops `
  --password $sshPassword `
  --accept-new-host-key `
  --provider codex `
  --model gpt-5.6-luna `
  --workspace "$HOME\.opsense" `
  --complete `
  --max-agent-rounds 16 `
  --max-agent-runs 200 `
  --max-probes 20 `
  --turn-timeout-ms 300000
```

命令行密码仍可能短暂出现在本机进程参数中，生产环境应优先使用 SSH Agent 或私钥认证。OpSense 不会把密码写入配置、Snapshot、审计日志或报告。

使用非 root SSH 账户时，OpSense 会优先检查无密码的非交互式 sudo。若当前终端可交互且 `sudo -n` 不可用，会显示 `Sudo password:` 并隐藏读取一次密码；后续只读提权命令复用进程内密码，不会重复询问。sudo 密码通过 SSH channel stdin 发送，不会写入命令参数、配置、本地工作区或审计日志。CI 等非交互环境应为所需只读命令配置 `NOPASSWD` sudo。

Agent 运行期间的心跳会显示当前 Turn、当前动作、调查状态、服务评估数量、计划/调查/Wiki 门禁，以及最近一次工具调用的结果。服务评估达到总数不等于整个工作流完成；只有“调查收尾”和“Wiki”门禁也完成后，`--complete` 才会退出并生成文档。

## 继续中断的任务

发生 Codex 超时、限流或手动中断时，使用日志中的 `Agent session` 继续。恢复不需要重新扫描服务器，也不需要再次提供 SSH 密码：

```powershell
pnpm --filter @opsense/cli dev -- agent `
  --resume <agent-session-id> `
  --provider codex `
  --model gpt-5.6-luna `
  --workspace "$HOME\.opsense" `
  --complete `
  --max-agent-runs 200 `
  --turn-timeout-ms 300000
```

`--max-agent-runs` 是 `--complete` 的自动运行批次上限，每个批次最多执行 `--max-agent-rounds` 个模型 Turn。限流恢复时可以先使用 `--once --max-agent-rounds 1` 只执行一个 Turn，确认进度后再继续。

也可以从已有 Snapshot 创建新的 Agent 会话：

```powershell
pnpm --filter @opsense/cli dev -- agent `
  --scan <scan-id> `
  --provider codex `
  --model gpt-5.6-luna `
  --workspace "$HOME\.opsense" `
  --complete
```

## CLI 命令

| 命令              | 用途                                 |
| ----------------- | ------------------------------------ |
| `opsense scan`    | 只执行只读 SSH 采集并保存 Snapshot   |
| `opsense agent`   | 启动或恢复 Codex 服务器 Wiki Agent   |
| `opsense report`  | 从已完成的 Agent Projection 生成报告 |
| `opsense analyze` | 兼容旧版 Codex/Baseline 分析流程     |
| `opsense inspect` | 兼容旧版的扫描、分析、报告端到端流程 |

查看完整参数：

```powershell
pnpm dev -- --help
pnpm dev -- agent --help
pnpm dev -- report --help
```

单独从已完成的 Agent Projection 生成报告：

```powershell
pnpm dev -- report `
  --scan <scan-id> `
  --profile wiki `
  --format docx,html,markdown `
  --workspace "$HOME\.opsense"
```

## 本地工作区

默认工作区为 `~/.opsense`，可通过 `--workspace` 修改：

```text
~/.opsense/
|-- config.json
|-- known-hosts.json
|-- runs/
|   `-- <scan-id>/
|       |-- snapshot.json
|       |-- agent-session.json
|       |-- agent-projection.json
|       |-- agent-turns.jsonl
|       |-- agent-transcript.jsonl
|       |-- audit.jsonl
|       `-- redaction-report.json
`-- reports/
    `-- <host>/
        `-- <scan-time>/
            |-- index.html
            |-- 服务器Wiki文档-<host>-<time>.docx
            `-- README.md
```

报告不会展示内部 Evidence 附录或 Evidence ID。底层证据仍保存在本地 Projection 和审计文件中，用于质量门禁、问题追踪和恢复调查。

## 安全模型

OpSense 的目标是调查服务器，而不是管理或修改服务器：

- 初始扫描只能执行版本化的只读命令目录。
- Codex 不能提交任意 Shell 字符串，只能申请结构化、受预算约束的探测请求。
- 路径探测受根目录、深度、数量、输出大小、超时和文件系统边界限制。
- 默认排除 `/proc`、`/sys`、容器 overlay、缓存、依赖树和数据库内部数据目录。
- 不读取进程环境变量值；Docker 环境变量只保留键名。
- 已知主机密钥保存在本地，首次连接必须显式使用 `--accept-new-host-key`。
- Secret、Token、连接串凭据、私钥和敏感命令参数会在持久化和 AI 输入前脱敏。
- 报告输出执行独立的残留敏感信息检查。

尽管如此，请使用最小权限 SSH 账户，并在生产服务器首次运行前审阅命令目录与配置。

## Monorepo 架构

| 模块                     | 职责                                             |
| ------------------------ | ------------------------------------------------ |
| `apps/cli`               | CLI 命令、进度显示和端到端编排                   |
| `packages/ssh`           | SSH 连接、known-hosts 和安全命令执行             |
| `packages/collectors`    | 系统、存储、网络、systemd、进程、容器和目录采集  |
| `packages/discovery`     | 原始证据索引、候选发现和高价值服务保护           |
| `packages/projection`    | 服务归并、调查计划和 AI 语义投影                 |
| `packages/agent-runtime` | Agent 上下文、工具路由、预算、恢复和完成门禁     |
| `packages/ai-codex`      | Codex Thread、结构化输出和决策修复               |
| `packages/report`        | HTML、DOCX、Markdown 渲染与质量检查              |
| `packages/schema`        | Snapshot、Agent、Projection、Wiki 和报告数据契约 |
| `packages/redaction`     | 数据分级、脱敏和残留 Secret 检查                 |
| `packages/workspace`     | 本地目录、配置、原子写入和会话持久化             |

## 开发

```powershell
pnpm run build
pnpm run typecheck
pnpm run lint
pnpm run test
pnpm run check
```

提交 Pull Request 前请确保 `pnpm run check` 通过。测试使用 Vitest，SSH 和采集器测试默认基于本地 Fixture，不会连接真实服务器。

## 参与贡献

欢迎通过 [GitHub Issues](https://github.com/nekoimi/OpSense/issues) 提交发行版兼容问题、服务漏识别样本、报告建议和安全问题复现。Pull Request 应尽量保持改动范围清晰，并为行为变化补充测试。

提交问题时请先移除 IP、用户名、路径中的个人信息、配置内容和任何凭据。不要上传真实 `~/.opsense` 工作区。

## 许可证

本项目基于 [MIT License](LICENSE) 开源。
