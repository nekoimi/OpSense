# OpSense TODO 任务清单 v1.0

## 1. 文档说明

本文档依据《需求初稿 v1.0》和《技术方案 v1.0》拆分 OpSense 第一版开发任务。

第一版最终目标：

```bash
opsense inspect --host server.example.com --user ops --provider codex
```

执行后在用户本机生成：

```text
~/.opsense/runs/<scan-id>/snapshot.json
~/.opsense/runs/<scan-id>/ai-output.json
~/.opsense/reports/<host>/<scan-time>/服务器巡检报告-<服务器标识>-<YYYY-MM-DD_HH-mm-ss>.docx
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
Must    第一版必须完成
Should  第一版尽量完成，不阻塞最小闭环
Later   明确放到后续版本
```

---

## 2. 里程碑总览

| 里程碑 | 内容 | 主要交付物 | 依赖 |
| --- | --- | --- | --- |
| M0 | 项目骨架 | 可运行的 TypeScript CLI | 无 |
| M1 | 数据契约与本地工作区 | Schema、配置和运行目录 | M0 |
| M2 | SSH 与安全命令执行 | 可靠的只读远程执行层 | M0、M1 |
| M3 | 系统与存储采集 | 主机基础快照 | M2 |
| M3.1 | 发行版适配与命令降级层 | 跨发行版逻辑探针与降级证据 | M3 |
| M4 | 服务探测 | systemd、进程、端口、Docker 清单 | M2、M3.1 |
| M5 | 定向目录与配置探测 | 路径、配置、日志和数据位置 | M4 |
| M6 | 归一化与服务归并 | 统一 ServiceRecord 和证据索引 | M3、M4、M5 |
| M7 | 脱敏与安全检查 | 可安全持久化和发送给 AI 的快照 | M1-M6 |
| M8 | 基础报告与 Word 输出 | 不依赖 AI 的 `.docx` 报告 | M6、M7 |
| M9 | Codex 接入 | AI 分析结果和增强报告 | M7、M8 |
| M10 | CLI 端到端编排 | `scan/analyze/report/inspect` | M2-M9 |
| M11 | 测试、打包与发布 | 可安装的第一版 CLI | M10 |

关键路径：

```text
M0 -> M1 -> M2 -> M3 -> M3.1 -> M4 -> M5 -> M6 -> M7 -> M8 -> M9 -> M10 -> M11
```

---

## 3. M0：项目骨架

### M0-01 初始化 workspace

- [x] `Must` 创建 pnpm workspace。
- [x] `Must` 创建 `apps/cli`。
- [x] `Must` 创建 `packages/schema`、`ssh`、`collectors`、`core`、`redaction`、`report`、`workspace`、`ai-provider`、`ai-codex`。
- [x] `Must` 创建 `prompts`、`fixtures` 和 `tests` 目录。
- [x] `Must` 统一 TypeScript、ESM、构建输出和路径别名配置。

验收条件：

- `pnpm install` 成功。
- `pnpm build` 成功。
- 所有 workspace package 可以互相引用。

### M0-02 建立工程质量工具

- [x] `Must` 配置 TypeScript 严格模式。
- [x] `Must` 配置 ESLint 和格式化工具。
- [x] `Must` 配置 Vitest。
- [x] `Must` 增加 `build`、`test`、`lint`、`typecheck` 脚本。
- [ ] `Should` 增加提交前检查脚本。

验收条件：

- 空项目的构建、测试、类型检查和 lint 全部通过。

### M0-03 建立 CLI 入口

- [x] `Must` 使用 `commander` 创建 `opsense` 命令。
- [x] `Must` 创建 `scan`、`analyze`、`report`、`inspect` 子命令占位。
- [x] `Must` 支持 `--help` 和 `--version`。
- [x] `Must` 定义统一退出码和顶层异常处理。
- [x] `Should` 支持 `--verbose` 和 `--quiet`。

验收条件：

- 本地可以运行 `opsense --help`。
- 未实现的子命令返回明确提示，不输出堆栈垃圾信息。

---

## 4. M1：数据契约与本地工作区

### M1-01 定义扫描会话模型

- [x] `Must` 定义 `ScanSession`。
- [x] `Must` 定义扫描 ID、目标主机标识、开始和结束时间。
- [x] `Must` 定义执行阶段、总体状态和部分失败状态。
- [x] `Must` 定义 OpSense 版本、规则版本和配置摘要。

### M1-02 定义基础实体 Schema

- [x] `Must` 定义 `HostSnapshot`。
- [x] `Must` 定义 `StorageSnapshot`、Disk、Partition、FileSystem、Mount。
- [x] `Must` 定义 `NetworkSnapshot`、Interface、Route、Dns、FirewallSummary。
- [x] `Must` 定义 `ProcessRecord` 和 `SocketRecord`。
- [x] `Must` 定义 `SystemdUnitRecord`。
- [x] `Must` 定义 `ContainerRecord` 和 `ComposeProjectRecord`。
- [x] `Must` 定义 `ArtifactRecord`、`EvidenceRecord` 和 `FindingRecord`。
- [x] `Must` 定义 `ServiceRecord` 和 `AiAnalysis`。

验收条件：

- 每个实体同时提供 TypeScript 类型和 JSON Schema。
- 使用 AJV 可以校验合法和非法 fixture。

### M1-03 定义证据与确定程度

- [x] `Must` 实现 `confirmed`、`inferred`、`unknown`、`conflict`。
- [x] `Must` 每条证据包含来源、采集时间、字段、状态和敏感级别。
- [x] `Must` 明确 AI 无权把 `inferred/unknown` 提升为 `confirmed`。
- [x] `Must` 定义命令失败、命令缺失和权限不足的证据格式。

### M1-04 实现本地工作区

- [x] `Must` 创建 `~/.opsense/config.json`。
- [x] `Must` 创建 `runs/<scan-id>`。
- [x] `Must` 创建 `reports/<host>/<scan-time>`。
- [x] `Must` 安全写入 `meta.json`、`snapshot.json` 和审计日志。
- [x] `Must` 使用临时文件加原子替换，避免中断产生半个 JSON 文件。
- [x] `Should` 支持通过参数覆盖工作区根目录。

### M1-05 实现配置加载

- [x] `Must` 定义配置 Schema 和默认值。
- [x] `Must` 支持配置文件和 CLI 参数合并。
- [x] `Must` 明确 CLI 参数优先级高于配置文件。
- [x] `Must` 拒绝在配置中保存密码和私钥正文。
- [x] `Must` 校验超时、目录深度、文件数和输出大小范围。

---

## 5. M2：SSH 与安全命令执行

### M2-01 SSH 连接

- [x] `Must` 使用 `ssh2` 实现 SSH 连接。
- [x] `Must` 支持 SSH Agent。
- [x] `Must` 支持私钥文件。
- [x] `Should` 支持 CLI 明文密码输入，但不得写入配置、审计、快照或报告。
- [x] `Must` 支持连接超时和 keepalive。
- [x] `Must` 默认启用主机指纹校验。
- [x] `Must` 对首次连接和指纹变化给出明确处理方式。

### M2-02 统一命令执行器

- [x] `Must` 定义 `CommandSpec`。
- [x] `Must` 定义命令 ID、固定模板、允许参数、超时和最大输出大小。
- [x] `Must` 返回 stdout、stderr、退出码、执行时间和截断状态。
- [x] `Must` 支持命令级超时和取消。
- [x] `Must` 禁止将任意用户输入直接拼接为 shell 命令。
- [x] `Must` 记录命令审计信息，但不记录敏感参数。

### M2-03 只读命令允许列表

- [x] `Must` 建立系统、存储、网络、服务和目录扫描命令清单。
- [x] `Must` 为每条命令标记支持的发行版和依赖命令。
- [x] `Must` 为每条命令标记是否需要 `sudo`。
- [x] `Must` 禁止启停服务、修改文件、安装软件、修改用户和磁盘操作。
- [x] `Must` 增加单元测试，证明外部输入不能突破命令模板。

### M2-04 权限探测

- [x] `Must` 获取当前用户、UID 和用户组。
- [x] `Must` 探测 `sudo -n` 是否可用。
- [x] `Must` 输出 `unprivileged`、`partial_privileged` 或 `privileged`。
- [x] `Must` 权限不足时继续扫描其他项目。
- [ ] `Must` 在最终报告中展示权限缺口。

验收条件：

- 可以连接测试服务器并安全执行 `uname`。
- 超时、断网、错误指纹、权限不足都有明确错误。
- 任何扫描路径都不能触发修改服务器状态的命令。

---

## 6. M3：系统与存储采集

### M3-01 预检与主机信息

- [x] `Must` 采集 `/etc/os-release`。
- [x] `Must` 采集 Kernel 和 CPU 架构。
- [x] `Must` 采集主机名、时区、运行时间和虚拟化特征。
- [x] `Must` 探测必要命令是否存在。
- [x] `Must` 生成主机能力清单。

### M3-02 CPU、内存和 Swap

- [x] `Must` 解析 `lscpu -J`，并实现文本回退解析。
- [x] `Must` 解析 `/proc/meminfo`。
- [x] `Must` 采集 Swap 设备和使用情况。
- [x] `Must` 所有容量使用字节存储，报告层负责格式化。

### M3-03 磁盘、分区和文件系统

- [x] `Must` 解析 `lsblk -J -O`。
- [x] `Must` 解析 `findmnt -J`。
- [x] `Must` 解析 `df -B1` 和 `df -i`。
- [x] `Must` 读取 `/etc/fstab` 的挂载声明。
- [x] `Should` 探测 LVM。
- [x] `Should` 探测软件 RAID。
- [x] `Must` 标记只读、网络和临时文件系统。

### M3-04 网络与 DNS

- [x] `Must` 解析 `ip -j addr`。
- [x] `Must` 解析 `ip -j route`。
- [x] `Must` 读取 DNS 配置。
- [x] `Must` 区分回环、内网、公网和未知地址。
- [x] `Should` 采集默认网关和主路由表摘要。

### M3-05 防火墙、用户和软件环境

- [x] `Must` 探测 nftables、iptables、firewalld 或 UFW。
- [x] `Must` 只生成规则摘要，避免无界输出。
- [ ] `Should` 采集用户、用户组和可登录 Shell 概况。
- [x] `Should` 识别包管理器。
- [ ] `Should` 采集关键软件版本，不默认导出全部软件包清单。

验收条件：

- `opsense scan` 可以生成仅包含系统、存储和网络的合法 `snapshot.json`。
- 缺少某个命令时生成未知项，不导致整个扫描失败。

---

## 6.1 M3.1：发行版适配与命令降级层

### M3.1-01 发行版识别与逻辑探针

- [x] `Must` 在其他 M3 探针前读取 `/etc/os-release`。
- [x] `Must` 将发行版归类为 `debian`、`rhel`、`alpine` 或 `unknown`。
- [x] `Must` 定义与具体命令解耦的 `ProbeSpec`、`ProbeVariant` 和 `ProbeOutcome`。
- [x] `Must` 根据发行版选择并排序可用命令变体。
- [x] `Must` 探针之间最多并发 4 个 SSH 通道，单个探针的变体顺序执行。

### M3.1-02 命令降级与证据

- [x] `Must` 在命令缺失、参数不支持、权限不足或解析失败时尝试下一变体。
- [x] `Must` 保留每次命令尝试及解析失败的独立 evidence。
- [x] `Must` 仅在必需逻辑探针的全部变体失败后生成一个 unknown。
- [x] `Must` 可选探针全部失败时不把扫描状态改为 `partial`。
- [x] `Must` 所有降级命令继续使用静态只读允许列表，禁止任意 `sh -c`。

### M3.1-03 首批兼容矩阵

- [x] `Must` CPU 支持 `lscpu -J`、文本 `lscpu`、`/proc/cpuinfo`。
- [x] `Must` 磁盘支持完整 JSON、基础 JSON 和 `lsblk -P`。
- [x] `Must` 挂载支持 `findmnt -J` 和 `/proc/self/mountinfo`。
- [x] `Must` 容量支持 `df -B1 -P` 和 `df -k -P` 本地换算。
- [x] `Must` Swap 支持 `swapon --show` 和 `/proc/swaps`。
- [x] `Must` 网络支持 `ip` JSON 和单行文本输出。
- [x] `Should` 时区、虚拟化、防火墙和包管理器支持有序替代来源。

### M3.1-04 兼容性测试

- [x] `Must` 增加 Debian、RHEL 和 Alpine 的 `os-release` fixture。
- [x] `Must` 覆盖主命令成功和命令缺失降级。
- [x] `Must` 覆盖参数不支持和解析失败降级。
- [x] `Must` 覆盖全部变体失败及可选探针失败。
- [x] `Must` 覆盖文本格式回退解析器和容量单位换算。

验收条件：

- 同一逻辑采集项可以在不同 Linux 发行版和命令版本上选择可解析的安全命令。
- 任一降级尝试均可追溯，且只有必需信息最终不可得时扫描才标记为部分完成。

---

## 7. M4：服务探测

### M4-01 systemd 探测

- [x] `Must` 采集 service unit 列表和运行状态。
- [x] `Must` 采集 unit file 启用状态。
- [x] `Must` 提取 `ExecStart`、`ExecReload`、`WorkingDirectory`。
- [x] `Must` 提取 `EnvironmentFile`、`User`、`Group` 和 unit 文件路径。
- [x] `Must` 关联 MainPID。
- [x] `Must` 支持已停止但已安装的服务。

### M4-02 进程探测

- [x] `Must` 采集 PID、PPID、UID、启动时间和命令行。
- [x] `Must` 获取 `/proc/<pid>/exe` 和 `/proc/<pid>/cwd`。
- [x] `Must` 获取 cgroup 信息。
- [x] `Must` 处理进程扫描期间退出的竞态情况。
- [x] `Must` 默认不读取完整 `/proc/<pid>/environ`。

### M4-03 监听端口探测

- [x] `Must` 解析 `ss -lntup`。
- [x] `Must` 记录协议、地址、端口、PID 和进程名。
- [x] `Must` 区分本地监听和对外监听。
- [x] `Must` 支持 IPv4 和 IPv6。

### M4-04 Docker 探测

- [x] `Must` 探测 Docker 是否安装和可访问。
- [x] `Must` 采集运行中和已停止容器。
- [x] `Must` 解析容器名称、镜像、状态和启动时间。
- [x] `Must` 解析端口映射、网络、Bind Mount 和 Volume。
- [x] `Must` 解析 RestartPolicy 和 Healthcheck。
- [x] `Must` 环境变量默认只保留键名。

### M4-05 Docker Compose 探测

- [x] `Must` 从容器标签识别 Compose project 和 service。
- [x] `Must` 提取 Compose working directory 和配置文件路径。
- [x] `Must` 支持 `docker compose ls` 可用与不可用两种情况。
- [x] `Must` 将同一 Compose project 的容器归组。

### M4-06 常见服务入口

- [ ] `Should` 探测 Nginx 配置入口。
- [ ] `Should` 探测 Caddyfile 或 Caddy JSON 配置入口。
- [ ] `Should` 探测 MySQL/MariaDB 配置和数据目录入口。
- [ ] `Should` 探测 PostgreSQL 配置和数据目录入口。
- [ ] `Should` 探测 Redis 配置和数据目录入口。
- [ ] `Should` 探测 cron、systemd timer 和 Supervisor。

验收条件：

- [x] 可以在 fixture 中识别 systemd 应用、普通进程、Docker 容器和 Compose 项目。
- [x] 可以把监听端口关联到对应 PID 或容器。

---

## 8. M5：定向目录与配置探测

### M5-01 路径种子

- [x] `Must` 从 systemd `WorkingDirectory` 生成路径种子。
- [x] `Must` 从 `ExecStart` 和 `EnvironmentFile` 生成路径种子。
- [x] `Must` 从进程 `exe/cwd` 生成路径种子。
- [x] `Must` 从 Docker Bind Mount 和 Volume 生成路径种子。
- [x] `Must` 从 Compose working directory 生成路径种子。
- [ ] `Should` 从 Nginx/Caddy include 和静态目录生成路径种子。
- [x] `Must` 每个路径种子关联来源和确定程度。

### M5-02 路径安全处理

- [x] `Must` 规范化绝对路径。
- [x] `Must` 拒绝空路径、控制字符和非法路径参数。
- [x] `Must` 处理符号链接循环。
- [x] `Must` 默认不跨文件系统边界。
- [x] `Must` 对不可读目录记录权限不足证据。

### M5-03 受限目录扫描

- [x] `Must` 默认最大深度为 4。
- [x] `Must` 默认单目录最大文件数为 5000。
- [x] `Must` 默认只采集名称、类型、大小、属主、权限和修改时间。
- [x] `Must` 排除 `/proc`、`/sys`、`/dev`、`/run` 和容器 overlay 存储层。
- [x] `Must` 排除 `.git`、`node_modules`、cache 和数据库表空间。
- [x] `Must` 对大目录和大文件只记录摘要。
- [x] `Must` 支持扫描超时和结果截断标记。

### M5-04 配置文件识别与解析

- [x] `Must` 识别 Compose YAML、Dockerfile 和 systemd unit。
- [x] `Must` 识别 `.env` 文件位置，但不默认读取值。
- [x] `Should` 识别常见应用入口文件和部署脚本。
- [x] `Must` 使用 YAML、INI、JSON、TOML 等结构化解析方式。
- [x] `Must` 为读取配置内容设置文件大小上限。
- [x] `Must` 解析失败时保留文件元数据和失败证据。

验收条件：

- 不执行全盘 `tree` 或无边界 `find`。
- 可以从服务运行态线索定位部署、配置、日志和数据目录。

---

## 9. M6：归一化与服务归并

### M6-01 原始结果归一化

- [x] `Must` 将命令输出转换为统一实体。
- [x] `Must` 所有记录使用稳定 ID。
- [x] `Must` 保存原始来源、解析器版本和采集时间。
- [x] `Must` 统一容量、时间、地址和路径格式。

### M6-02 服务归并规则

- [x] `Must` 根据 systemd MainPID 关联进程。
- [x] `Must` 根据 cgroup 关联 systemd unit 或容器。
- [x] `Must` 根据 PID 关联监听端口。
- [x] `Must` 根据容器标签归并 Compose 服务。
- [x] `Must` 根据工作目录和可执行路径关联 Artifact。
- [x] `Must` 避免将同一服务重复输出为多个服务。
- [x] `Must` 不推断业务上下游依赖。

### M6-03 冲突与未知项

- [x] `Must` 不同来源值不一致时标记 `conflict`。
- [x] `Must` 权限不足和命令缺失产生 `unknown`。
- [x] `Must` 规则推断标记为 `inferred`。
- [x] `Must` 报告层可以单独列出未知和冲突项。

验收条件：

- systemd、PID、端口和部署目录可以归并为一个 `ServiceRecord`。
- 每个重要字段可以追溯到 evidence ID。

---

## 10. M7：脱敏与安全检查

### M7-01 敏感信息分类

- [x] `Must` 实现 `public/internal/sensitive/secret` 分类。
- [x] `Must` 定义字段级敏感信息规则。
- [x] `Must` 定义文件类型和路径敏感规则。

### M7-02 脱敏规则

- [x] `Must` `.env` 默认只保留键名。
- [x] `Must` 私钥只记录路径、权限和可选指纹。
- [x] `Must` 数据库连接串隐藏用户、密码和查询参数。
- [x] `Must` URL 中凭据、Token 和签名参数替换为 `[REDACTED]`。
- [x] `Must` 命令行中的 password、token、secret 参数脱敏。
- [x] `Must` Docker 环境变量同时使用键名规则和值模式过滤。
- [x] `Must` 对 AI 输入执行第二次脱敏扫描。

### M7-03 安全测试

- [x] `Must` 创建包含假密码、Token、私钥和连接串的 fixture。
- [x] `Must` 断言 secret 不进入 `snapshot.json`。
- [x] `Must` 断言 secret 不进入 AI 输入目录。
- [x] `Must` 断言 secret 不进入日志和报告生成输入；Word 成品验证在 M8-04 完成。
- [x] `Must` 输出脱敏规则版本和命中计数。

验收条件：

- 测试 fixture 中的所有测试密钥均无法在持久化文件中检索到。

---

## 11. M8：基础报告与 Word 输出

### M8-01 报告 ViewModel

- [ ] `Must` 定义与输出格式无关的 `ReportModel`。
- [ ] `Must` 将主机、磁盘、网络、服务、风险和未知项转换为报告章节。
- [ ] `Must` 无 AI 时使用事实数据生成完整基础报告。
- [ ] `Must` AI 内容与事实内容分层显示。

### M8-02 Markdown 与 HTML 报告

- [ ] `Must` 生成 `README.md`、`system.md`、`storage.md`、`network.md` 和 `services.md`。
- [ ] `Must` 为每个服务生成详情章节或文件。
- [ ] `Must` 生成风险、未知项和证据附录。
- [ ] `Must` 生成静态 HTML 报告入口 `index.html`。
- [ ] `Must` HTML 与 Word 使用同一份 `ReportModel`，章节和事实数据保持一致。
- [ ] `Must` HTML 报告无需启动本地服务即可离线打开和浏览。
- [ ] `Must` HTML 包含系统、存储、网络、服务、风险、未知项和证据章节。
- [ ] `Must` 对报告内容执行 HTML 转义，不允许采集内容注入脚本或标签。
- [ ] `Must` HTML 在常见桌面浏览器中布局可读，长命令、路径和表格可滚动或换行。

### M8-03 Word 报告生成器

- [ ] `Must` 使用 `docx` 生成 Word 报告。
- [ ] `Must` Word 文件名使用中文，格式为 `服务器巡检报告-{服务器标识}-{YYYY-MM-DD_HH-mm-ss}.docx`。
- [ ] `Must` 文件名中的服务器标识使用扫描目标 IP、主机名或服务名，确保仅查看文件名即可识别目标服务器。
- [ ] `Must` 清理 Windows、macOS 和 Linux 文件名非法字符；IPv6 地址中的 `:` 替换为 `_`。
- [ ] `Must` 限制文件名长度，并使用扫描时间避免同一服务器的报告被覆盖。
- [ ] `Must` 文件名中的扫描时间按本地时区显示，使用常见且文件名安全的 `YYYY-MM-DD_HH-mm-ss` 格式。
- [ ] `Must` 生成封面。
- [ ] `Must` 使用 Heading 1/2/3 标题样式。
- [ ] `Must` 插入可更新的自动目录。
- [ ] `Must` 生成执行摘要。
- [ ] `Must` 生成系统环境章节。
- [ ] `Must` 生成磁盘、分区和挂载表格。
- [ ] `Must` 生成部署服务汇总表和服务详情。
- [ ] `Must` 生成风险、未知项和证据附录。
- [ ] `Must` 添加页眉、页脚和页码。
- [ ] `Must` 命令和路径使用等宽字体。
- [ ] `Must` 长路径和表格内容允许换行。
- [ ] `Must` 服务标题和正文具有合理分页控制。
- [ ] `Must` 配置中文字体和替代字体。

### M8-04 Word 验证

- [ ] `Must` 验证生成文件为有效 ZIP/Open XML 结构。
- [ ] `Must` 使用解析器重新读取核心段落和表格。
- [ ] `Must` 在 Microsoft Word 中打开，不出现修复提示。
- [ ] `Must` 在 WPS 中打开，不出现修复提示。
- [ ] `Must` 检查目录、页码、中文、长路径和分页效果。
- [ ] `Must` 验证中文报告文件名包含服务器标识，并可在 Windows、macOS 和 Linux 本地文件系统正常创建和打开。
- [ ] `Should` 保存一份脱敏示例 Word 报告作为发布样例。

验收条件：

- 不调用 Codex 也能生成可交付的 Word 报告。
- Word 报告包含封面、目录、系统、存储、服务、风险和证据附录。
- 不调用 Codex 也能生成可离线打开的完整 HTML 报告。

---

## 12. M9：Codex 接入

### M9-01 AI Provider 抽象

- [ ] `Must` 定义 `AiProvider` 接口。
- [ ] `Must` 实现 `NoopProvider`。
- [ ] `Must` 定义 `AnalysisInput` 和 `AnalysisResult`。
- [ ] `Must` AI 失败不影响基础报告生成。

### M9-02 AI 输入工作区

- [ ] `Must` 生成 `context.md`。
- [ ] `Must` 生成 host、storage、network、services 和 findings JSON。
- [ ] `Must` 生成 `redaction-report.json`。
- [ ] `Must` 生成 `output-schema.json`。
- [ ] `Must` AI 工作区只包含脱敏后的必要文件。

### M9-03 提示词和输出契约

- [ ] `Must` 编写服务器分析提示词。
- [ ] `Must` 禁止将 inferred/unknown 写成 confirmed。
- [ ] `Must` 要求重要结论引用 evidence ID。
- [ ] `Must` 禁止补写不存在的密码、连接信息和业务依赖。
- [ ] `Must` 定义 host summary、service summaries、findings 和 unknowns Schema。

### M9-04 CodexProvider

- [ ] `Must` 接入 `@openai/codex-sdk`。
- [ ] `Must` 创建 Codex thread 并运行分析提示词。
- [ ] `Must` 保存 thread ID 和调用状态。
- [ ] `Must` 解析 `finalResponse`。
- [ ] `Must` 使用 AJV 校验 AI 输出。
- [ ] `Must` 对 JSON 解析或 Schema 错误进行有限重试。
- [ ] `Must` 实现超时和取消。
- [ ] `Must` 将最终结果保存为 `ai-output.json`。

### M9-05 AI 结果治理

- [ ] `Must` 拒绝没有证据的 confirmed 结论。
- [ ] `Must` 拒绝 AI 修改原始 snapshot。
- [ ] `Must` AI 结果作为独立解释层保存。
- [ ] `Must` 在 Word 报告中标记 AI 推断和确定程度。
- [ ] `Should` 支持对同一扫描 thread 继续提问或重新生成报告。

验收条件：

- Codex 可用时生成合法 `ai-output.json` 并增强 Word 报告。
- Codex 不可用或输出非法时，仍生成基础 Word 报告。

---

## 13. M10：CLI 端到端编排

### M10-01 `scan` 命令

- [ ] `Must` 接收 host、port、user 和身份认证参数。
- [ ] `Must` 执行预检、系统扫描、服务扫描和目录扫描。
- [ ] `Must` 生成 `snapshot.json` 和审计日志。
- [ ] `Must` 输出 scan ID 和本地目录。

### M10-02 `analyze` 命令

- [ ] `Must` 接收 scan ID 和 provider。
- [ ] `Must` 验证快照和脱敏状态。
- [ ] `Must` 调用 CodexProvider 或 NoopProvider。
- [ ] `Must` 生成 `ai-output.json`。

### M10-03 `report` 命令

- [ ] `Must` 接收 scan ID 和输出格式。
- [ ] `Must` 默认同时输出 `docx` 和 `html`。
- [ ] `Must` 支持重新生成报告而不重新扫描服务器。
- [ ] `Must` 支持 `docx,markdown,html` 多格式输出和显式格式选择。

### M10-04 `inspect` 命令

- [ ] `Must` 串联 scan、analyze 和 report。
- [ ] `Must` 实时显示当前执行阶段。
- [ ] `Must` 支持 Ctrl+C 安全中断。
- [ ] `Must` Codex 失败时自动降级为基础报告。
- [ ] `Must` 完成后输出 Word 和 HTML 报告绝对路径。

### M10-05 状态和退出码

- [ ] `Must` 实现 created、connecting、collecting、normalizing、redacting、analyzing、rendering 状态。
- [ ] `Must` 实现 completed、partial 和 failed 终态。
- [ ] `Must` 区分连接失败、认证失败、扫描部分失败、AI 失败和报告失败退出码。

验收条件：

- 一条 `opsense inspect` 命令可以完成第一版最小闭环。
- 部分采集失败时仍能输出报告并明确缺失内容。

---

## 14. M11：测试、打包与发布

### M11-01 单元与 Golden 测试

- [ ] `Must` 覆盖命令输出解析器。
- [ ] `Must` 覆盖配置加载和 Schema 校验。
- [ ] `Must` 覆盖服务归并和冲突处理。
- [ ] `Must` 覆盖脱敏规则。
- [ ] `Must` 覆盖 Word 报告生成器。
- [ ] `Must` 覆盖 HTML 报告生成器、离线资源和内容转义。
- [ ] `Must` 覆盖 AI 输出校验和降级路径。

### M11-02 Linux 场景测试

- [ ] `Must` 测试 Ubuntu 22.04。
- [ ] `Must` 测试 Ubuntu 24.04。
- [ ] `Must` 测试 Debian 12。
- [ ] `Must` 测试 Rocky Linux 9。
- [ ] `Must` 测试普通用户权限。
- [ ] `Must` 测试可用 `sudo -n` 的权限。
- [ ] `Must` 测试 systemd 应用。
- [ ] `Must` 测试 Docker Compose 应用。
- [ ] `Should` 测试 Nginx + 应用 + PostgreSQL 场景。

### M11-03 安全测试

- [ ] `Must` 测试 SSH 主机指纹变化。
- [ ] `Must` 测试恶意主机名、用户名和路径参数。
- [ ] `Must` 测试命令超时和超大输出。
- [ ] `Must` 测试符号链接循环和超大目录。
- [ ] `Must` 测试密码、Token 和私钥不会泄漏。
- [ ] `Must` 检查扫描过程不执行写操作。

### M11-04 端到端验收

- [ ] `Must` 从空工作区执行 `opsense inspect`。
- [ ] `Must` 生成合法 `snapshot.json`。
- [ ] `Must` 生成合法 `ai-output.json` 或记录 AI 降级状态。
- [ ] `Must` 生成文件名包含服务器 IP、主机名或服务名的可打开中文 Word 报告。
- [ ] `Must` 生成无需本地服务即可打开的 `index.html` 报告。
- [ ] `Must` 报告中的服务、端口和路径与测试服务器一致。
- [ ] `Must` 每个重要结论可追溯到 evidence ID。

### M11-05 本地安装与发布

- [ ] `Must` 确定 Node.js 最低版本。
- [ ] `Must` 生成本地可执行命令。
- [ ] `Must` 编写安装、升级和卸载说明。
- [ ] `Must` 编写 SSH 和 Codex 使用前置条件。
- [ ] `Must` 提供脱敏示例快照和示例 Word 报告。
- [ ] `Must` 提供可离线打开的脱敏示例 HTML 报告。
- [ ] `Should` 提供 Windows、macOS 和 Linux 本地运行验证。

---

## 15. 第一版 Definition of Done

以下条件全部满足后，第一版才视为完成：

- [ ] 可以在用户本机安装并运行 `opsense`。
- [ ] 可以通过 SSH 扫描一台 Linux 服务器。
- [ ] 目标服务器不需要安装 Agent 或 OpSense 二进制文件。
- [ ] 扫描过程只执行允许列表中的只读命令。
- [ ] 可以采集系统、CPU、内存、网络、磁盘、分区和挂载信息。
- [ ] 可以采集 systemd、进程、端口、Docker 和 Compose 信息。
- [ ] 可以根据运行态线索定向发现部署、配置、日志和数据目录。
- [ ] 可以把 systemd、PID、端口和目录归并为服务清单。
- [ ] 所有重要结论具有 evidence ID 和确定程度。
- [ ] 密码、Token 和私钥不进入快照、日志、AI 输入和报告。
- [ ] 无 Codex 时可以生成基础 Word 报告。
- [ ] 无 Codex 时可以生成完整静态 HTML 报告。
- [ ] 有 Codex 时可以生成结构化分析并增强 Word 和 HTML 报告。
- [ ] Word 报告可在 Microsoft Word 和 WPS 中正常打开。
- [ ] 权限不足、未知项和冲突信息在报告中明确显示。
- [ ] `opsense inspect` 可以完成端到端流程。
- [ ] 支持的 Linux 发行版测试通过。

---

## 16. 后续版本任务，不进入第一版

- [ ] `Later` 批量扫描多台服务器。
- [ ] `Later` Web 管理后台和 HTTP API。
- [ ] `Later` 用户、团队和权限管理。
- [ ] `Later` 任务队列和周期扫描。
- [ ] `Later` SQLite 或其他历史快照索引。
- [ ] `Later` 快照差异比较和变更时间线。
- [ ] `Later` 常驻 Agent。
- [ ] `Later` Kubernetes 探测。
- [ ] `Later` 云平台资源探测。
- [ ] `Later` 完整服务依赖图和业务调用链。
- [ ] `Later` 自动执行启停、升级、备份或故障修复。
