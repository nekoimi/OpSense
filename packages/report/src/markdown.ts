import { createHash } from 'node:crypto';

import type { ReportModel, ReportService } from '@opsense/schema';

import {
  displayBoolean,
  displayList,
  formatBytes,
  formatDateTime,
  formatDuration,
  statusLabel,
} from './format.js';
import { sanitizeReportIdentifier } from './filename.js';

export interface MarkdownReportBundle {
  files: ReadonlyMap<string, string>;
}

export function renderMarkdownBundle(model: ReportModel): MarkdownReportBundle {
  const files = new Map<string, string>();
  files.set('README.md', renderOverview(model));
  files.set('system.md', renderSystem(model));
  files.set('storage.md', renderStorage(model));
  files.set('network.md', renderNetwork(model));
  files.set('services.md', renderServices(model));
  files.set('findings.md', renderFindings(model));
  files.set('unknowns.md', renderUnknowns(model));
  files.set('evidence.md', renderEvidence(model));
  for (const service of model.services) {
    files.set(`services/${serviceFileName(service.id)}`, renderService(service));
  }
  return { files };
}

function renderOverview(model: ReportModel): string {
  return `${heading(1, model.metadata.title)}

| 项目 | 内容 |
| --- | --- |
| 扫描目标 | ${cell(model.metadata.targetHost)}:${model.metadata.targetPort} |
| 主机标识 | ${cell(model.metadata.displayHost)} |
| 扫描状态 | ${statusLabel(model.metadata.state)} |
| 扫描时间 | ${formatDateTime(model.metadata.scannedAt)} |
| 报告时间 | ${formatDateTime(model.metadata.generatedAt)} |
| OpSense 版本 | ${cell(model.metadata.opsenseVersion)} |

${heading(2, '执行摘要')}

| 候选总数 | 主要服务 | 支撑组件 | 系统服务 | 待确认 | 风险 | 未知项 |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| ${model.summary.serviceCount} | ${model.summary.primaryServiceCount} | ${model.summary.supportingServiceCount} | ${model.summary.systemServiceCount} | ${model.summary.needsReviewServiceCount} | ${model.summary.findingCount} | ${model.summary.unknownCount} |

${model.aiAnalysis === undefined ? '' : `${heading(2, 'AI 分析（推断层）')}\n\n${markdownText(model.aiAnalysis.hostSummary)}\n`}

${heading(2, '报告文件')}

- [系统环境](system.md)
- [存储与挂载](storage.md)
- [网络](network.md)
- [服务清单](services.md)
- [风险与发现](findings.md)
- [未知项](unknowns.md)
- [证据附录](evidence.md)
`;
}

function renderSystem(model: ReportModel): string {
  const host = model.host;
  return `${heading(1, '系统环境')}

| 项目 | 内容 |
| --- | --- |
| 主机名 | ${cell(host.hostname)} |
| FQDN | ${cell(host.fqdn)} |
| 操作系统 | ${cell(host.operatingSystem)} |
| 内核 | ${cell(host.kernelVersion)} |
| 架构 | ${cell(host.architecture)} |
| CPU | ${cell(host.cpuModel)} |
| 逻辑核心 | ${cell(host.logicalCores)} |
| 物理核心 | ${cell(host.physicalCores)} |
| 内存总量 | ${formatBytes(host.totalMemoryBytes)} |
| 可用内存 | ${formatBytes(host.availableMemoryBytes)} |
| Swap | ${formatBytes(host.swapTotalBytes)} |
| 运行时长 | ${formatDuration(host.uptimeSeconds)} |
| 时区 | ${cell(host.timezone)} |
| 虚拟化 | ${cell(host.virtualization)} |
| 包管理器 | ${cell(host.packageManager)} |
`;
}

function renderStorage(model: ReportModel): string {
  const disks = model.disks
    .map(
      (disk) =>
        `| ${cell(disk.name)} | ${code(disk.path)} | ${cell(disk.model)} | ${formatBytes(disk.sizeBytes)} | ${cell(displayList(disk.fileSystemTypes))} | ${cell(displayList(disk.mountPoints))} |`,
    )
    .join('\n');
  const mounts = model.mounts
    .map(
      (mount) =>
        `| ${code(mount.source)} | ${code(mount.target)} | ${cell(mount.fileSystemType)} | ${formatBytes(mount.totalBytes)} | ${formatBytes(mount.usedBytes)} | ${mount.usagePercent === undefined ? '-' : `${mount.usagePercent}%`} | ${displayBoolean(mount.readOnly)} |`,
    )
    .join('\n');
  return `${heading(1, '存储与挂载')}

${heading(2, '磁盘')}

| 名称 | 路径 | 型号 | 容量 | 文件系统 | 挂载点 |
| --- | --- | --- | ---: | --- | --- |
${disks || '| - | - | - | - | - | - |'}

${heading(2, '挂载')}

| 来源 | 挂载点 | 文件系统 | 总量 | 已用 | 使用率 | 只读 |
| --- | --- | --- | ---: | ---: | ---: | --- |
${mounts || '| - | - | - | - | - | - | - |'}
`;
}

function renderNetwork(model: ReportModel): string {
  const interfaces = model.network.interfaces
    .map(
      (item) =>
        `| ${cell(item.name)} | ${cell(item.state)} | ${cell(item.macAddress)} | ${cell(item.mtu)} | ${cell(displayList(item.addresses))} |`,
    )
    .join('\n');
  return `${heading(1, '网络')}

| 接口 | 状态 | MAC | MTU | 地址 |
| --- | --- | --- | ---: | --- |
${interfaces || '| - | - | - | - | - |'}

${heading(2, '路由与 DNS')}

- 默认路由：${cell(displayList(model.network.defaultRoutes))}
- DNS：${cell(displayList(model.network.dnsServers))}
- 搜索域：${cell(displayList(model.network.searchDomains))}
- 防火墙：${cell(model.network.firewallBackend)} / ${displayBoolean(model.network.firewallActive)}
`;
}

function renderServices(model: ReportModel): string {
  const rows = model.services
    .map((service) => {
      const fileName = serviceFileName(service.id);
      return `| [${cell(service.displayName ?? service.name)}](services/${fileName}) | ${statusLabel(service.status)} | ${cell(service.role)} | ${cell(service.reportPlacement)} | ${cell(displayList(service.ports))} | ${statusLabel(service.assessmentConfidence)} |`;
    })
    .join('\n');
  return `${heading(1, '部署服务分类')}

| 服务 | 状态 | 角色 | 报告位置 | 端口 | 分类确定程度 |
| --- | --- | --- | --- | --- | --- |
${rows || '| - | - | - | - | - | - |'}

${heading(2, '系统服务概况')}

- 总数：${model.systemServices.totalCount}
- 运行中：${model.systemServices.runningCount}
- 失败：${model.systemServices.failedCount}
- 需关注 unit：${cell(displayList(model.systemServices.attentionServices.map((item) => item.name)))}

${heading(2, '完整候选索引')}

| 服务 | 状态 | 角色 | 报告位置 | 部署方式 |
| --- | --- | --- | --- | --- |
${model.serviceIndex.map((service) => `| ${cell(service.displayName ?? service.name)} | ${statusLabel(service.status)} | ${cell(service.role)} | ${cell(service.reportPlacement)} | ${cell(service.deploymentType)} |`).join('\n') || '| - | - | - | - | - |'}
`;
}

function renderService(service: ReportService): string {
  return `${heading(1, service.displayName ?? service.name)}

| 项目 | 内容 |
| --- | --- |
| 服务 ID | ${code(service.id)} |
| 状态 | ${statusLabel(service.status)} |
| 部署方式 | ${cell(service.deploymentType)} |
| 服务角色 | ${cell(service.role)} |
| 报告位置 | ${cell(service.reportPlacement)} |
| 分类理由 | ${cell(service.assessmentReason)} |
| 分类确定程度 | ${statusLabel(service.assessmentConfidence)} |
| 确定程度 | ${statusLabel(service.confidence)} |
| 开机启动 | ${displayBoolean(service.enabledAtBoot)} |
| 进程 PID | ${cell(service.processIds.join(', '))} |
| 端口 | ${cell(displayList(service.ports))} |
| 部署目录 | ${codeList(service.deployDirectories)} |
| 配置文件 | ${codeList(service.configFiles)} |
| 环境文件 | ${codeList(service.environmentFiles)} |
| 日志位置 | ${codeList(service.logLocations)} |
| 数据目录 | ${codeList(service.dataDirectories)} |
| 启动命令 | ${code(service.startCommand)} |
| 未知字段 | ${cell(displayList(service.unknownFields))} |
| 冲突字段 | ${cell(displayList(service.conflictFields))} |
| Evidence | ${cell(displayList(service.evidenceIds))} |

${service.purpose === undefined ? '' : `${heading(2, '用途说明')}\n\n${markdownText(service.purpose)}\n`}
`;
}

function renderFindings(model: ReportModel): string {
  const factual = model.findings
    .map(
      (finding) =>
        `${heading(2, `[${statusLabel(finding.severity)}] ${finding.title}`)}\n\n${markdownText(finding.description)}\n\n- 确定程度：${statusLabel(finding.confidence)}\n- Evidence：${markdownText(displayList(finding.evidenceIds))}`,
    )
    .join('\n\n');
  const ai = (model.aiAnalysis?.findings ?? [])
    .map(
      (finding) =>
        `${heading(2, `[AI/${statusLabel(finding.severity)}] ${finding.title}`)}\n\n${markdownText(finding.description)}\n\n- 确定程度：${statusLabel(finding.confidence)}\n- Evidence：${markdownText(displayList(finding.evidenceIds))}`,
    )
    .join('\n\n');
  return `${heading(1, '风险与发现')}

${factual || '无事实层风险记录。'}

${ai === '' ? '' : `${heading(1, 'AI 风险提示（推断层）')}\n\n${ai}`}
`;
}

function renderUnknowns(model: ReportModel): string {
  const values = [
    ...model.unknowns,
    ...(model.aiAnalysis?.unknowns ?? []).map((item) => `[AI] ${item}`),
  ];
  return `${heading(1, '未知项')}

${values.length === 0 ? '无。' : values.map((item) => `- ${markdownText(item)}`).join('\n')}
`;
}

function renderEvidence(model: ReportModel): string {
  const rows = model.evidence
    .map(
      (evidence) =>
        `| ${code(evidence.id)} | ${cell(evidence.kind)} | ${cell(evidence.source)} | ${cell(evidence.status)} | ${cell(evidence.sensitivity)} | ${formatDateTime(evidence.collectedAt)} |`,
    )
    .join('\n');
  return `${heading(1, '证据附录')}

| Evidence ID | 类型 | 来源 | 状态 | 敏感级别 | 采集时间 |
| --- | --- | --- | --- | --- | --- |
${rows || '| - | - | - | - | - | - |'}
`;
}

function heading(level: 1 | 2, value: string): string {
  return `${'#'.repeat(level)} ${markdownText(value)}`;
}

function cell(value: string | number | undefined): string {
  if (value === undefined || value === '') return '-';
  return markdownText(String(value)).replaceAll('|', '\\|').replaceAll('\n', '<br>');
}

function code(value: string | undefined): string {
  return value === undefined || value === '' ? '-' : `\`${value.replaceAll('`', '\\`')}\``;
}

function codeList(values: readonly string[]): string {
  return values.length === 0 ? '-' : values.map((value) => code(value)).join('<br>');
}

function markdownText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('[', '\\[')
    .replaceAll(']', '\\]');
}

function serviceFileName(serviceId: string): string {
  const digest = createHash('sha256').update(serviceId).digest('hex').slice(0, 8);
  return `${sanitizeReportIdentifier(serviceId, 100)}-${digest}.md`;
}
