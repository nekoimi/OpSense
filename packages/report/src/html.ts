import type { FindingRecord, ReportModel, ReportService } from '@opsense/schema';

import { REPORT_WATERMARK, reportCopyrightNotice } from './branding.js';
import {
  displayBoolean,
  displayList,
  formatBytes,
  formatDateTime,
  formatDuration,
  statusLabel,
} from './format.js';

export function renderHtmlReport(model: ReportModel): string {
  const title = escapeHtml(model.metadata.title);
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>${REPORT_CSS}</style>
</head>
<body>
  ${renderWatermarkLayer()}
  <header class="topbar">
    <div>
      <p class="eyebrow">OpSense · ${escapeHtml(statusLabel(model.metadata.state))}</p>
      <h1>${title}</h1>
      <p class="subtitle">${escapeHtml(model.metadata.targetHost)}:${model.metadata.targetPort} · ${escapeHtml(formatDateTime(model.metadata.scannedAt))}</p>
    </div>
    <dl class="top-meta">
      <div><dt>扫描 ID</dt><dd>${escapeHtml(model.metadata.scanId)}</dd></div>
      <div><dt>报告生成</dt><dd>${escapeHtml(formatDateTime(model.metadata.generatedAt))}</dd></div>
    </dl>
  </header>
  <div class="layout">
    <nav class="sidebar" aria-label="报告目录">
      <a href="#summary">执行摘要</a>
      <a href="#system">系统环境</a>
      <a href="#storage">存储与挂载</a>
      <a href="#network">网络</a>
      <a href="#services">部署服务</a>
      <a href="#findings">风险与未知项</a>
      <a href="#evidence">证据附录</a>
    </nav>
    <main>
      ${renderSummary(model)}
      ${renderSystem(model)}
      ${renderStorage(model)}
      ${renderNetwork(model)}
      ${renderServices(model)}
      ${renderFindings(model)}
      ${renderEvidence(model)}
    </main>
  </div>
  <footer><strong>${escapeHtml(reportCopyrightNotice(model.metadata.generatedAt))}</strong><span>OpSense ${escapeHtml(model.metadata.opsenseVersion)} · ${escapeHtml(model.metadata.scanId)}</span></footer>
</body>
</html>
`;
}

function renderWatermarkLayer(): string {
  return `<div class="watermark-layer" aria-hidden="true">${Array.from(
    { length: 24 },
    () => `<span>${escapeHtml(REPORT_WATERMARK)}</span>`,
  ).join('')}</div>`;
}

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderSummary(model: ReportModel): string {
  const metrics = [
    ['服务总数', model.summary.serviceCount],
    ['运行中', model.summary.runningServiceCount],
    ['已停止', model.summary.stoppedServiceCount],
    ['容器', model.summary.containerCount],
    ['磁盘', model.summary.diskCount],
    ['风险', model.summary.findingCount],
    ['未知项', model.summary.unknownCount],
  ];
  return `<section id="summary">
    <div class="section-heading"><p>01</p><h2>执行摘要</h2></div>
    <div class="metrics">${metrics
      .map(
        ([label, value]) =>
          `<div class="metric"><span>${escapeHtml(label)}</span><strong>${value}</strong></div>`,
      )
      .join('')}</div>
    ${
      model.aiAnalysis === undefined
        ? ''
        : `<aside class="ai-note"><strong>AI 分析（推断层）</strong><p>${escapeHtml(model.aiAnalysis.hostSummary)}</p></aside>`
    }
  </section>`;
}

function renderSystem(model: ReportModel): string {
  const host = model.host;
  return `<section id="system">
    <div class="section-heading"><p>02</p><h2>系统环境</h2></div>
    ${keyValueTable([
      ['主机名', host.hostname],
      ['FQDN', host.fqdn],
      ['操作系统', host.operatingSystem],
      ['内核', host.kernelVersion],
      ['架构', host.architecture],
      ['CPU', host.cpuModel],
      ['逻辑 / 物理核心', `${host.logicalCores ?? '-'} / ${host.physicalCores ?? '-'}`],
      [
        '内存总量 / 可用',
        `${formatBytes(host.totalMemoryBytes)} / ${formatBytes(host.availableMemoryBytes)}`,
      ],
      ['Swap', formatBytes(host.swapTotalBytes)],
      ['运行时长', formatDuration(host.uptimeSeconds)],
      ['时区', host.timezone],
      ['虚拟化', host.virtualization],
      ['包管理器', host.packageManager],
    ])}
  </section>`;
}

function renderStorage(model: ReportModel): string {
  const diskRows = model.disks
    .map(
      (disk) =>
        `<tr><td>${escapeHtml(disk.name)}</td><td><code>${escapeHtml(disk.path)}</code></td><td>${escapeHtml(disk.model ?? '-')}</td><td>${escapeHtml(formatBytes(disk.sizeBytes))}</td><td>${escapeHtml(displayList(disk.fileSystemTypes))}</td><td><code>${escapeHtml(displayList(disk.mountPoints))}</code></td></tr>`,
    )
    .join('');
  const mountRows = model.mounts
    .map(
      (mount) =>
        `<tr><td><code>${escapeHtml(mount.source)}</code></td><td><code>${escapeHtml(mount.target)}</code></td><td>${escapeHtml(mount.fileSystemType)}</td><td>${escapeHtml(formatBytes(mount.totalBytes))}</td><td>${escapeHtml(formatBytes(mount.usedBytes))}</td><td>${mount.usagePercent === undefined ? '-' : `<progress max="100" value="${mount.usagePercent}"></progress><span class="progress-label">${mount.usagePercent}%</span>`}</td><td>${escapeHtml(displayBoolean(mount.readOnly))}</td></tr>`,
    )
    .join('');
  return `<section id="storage">
    <div class="section-heading"><p>03</p><h2>存储与挂载</h2></div>
    <h3>磁盘</h3>
    ${table(['名称', '路径', '型号', '容量', '文件系统', '挂载点'], diskRows)}
    <h3>挂载</h3>
    ${table(['来源', '挂载点', '文件系统', '总量', '已用', '使用率', '只读'], mountRows)}
  </section>`;
}

function renderNetwork(model: ReportModel): string {
  const rows = model.network.interfaces
    .map(
      (item) =>
        `<tr><td>${escapeHtml(item.name)}</td><td>${escapeHtml(item.state ?? '-')}</td><td><code>${escapeHtml(item.macAddress ?? '-')}</code></td><td>${item.mtu ?? '-'}</td><td>${item.addresses.map((address) => `<code>${escapeHtml(address)}</code>`).join('<br>')}</td></tr>`,
    )
    .join('');
  return `<section id="network">
    <div class="section-heading"><p>04</p><h2>网络</h2></div>
    ${table(['接口', '状态', 'MAC', 'MTU', '地址'], rows)}
    ${keyValueTable([
      ['默认路由', displayList(model.network.defaultRoutes)],
      ['DNS', displayList(model.network.dnsServers)],
      ['搜索域', displayList(model.network.searchDomains)],
      [
        '防火墙',
        `${model.network.firewallBackend ?? '-'} / ${displayBoolean(model.network.firewallActive)}`,
      ],
    ])}
  </section>`;
}

function renderServices(model: ReportModel): string {
  const rows = model.services
    .map(
      (service, index) =>
        `<tr><td><a href="#service-${index}">${escapeHtml(service.displayName ?? service.name)}</a></td><td>${badge(service.status)}</td><td>${escapeHtml(service.deploymentType)}</td><td>${escapeHtml(displayList(service.ports))}</td><td>${escapeHtml(statusLabel(service.confidence))}</td></tr>`,
    )
    .join('');
  return `<section id="services">
    <div class="section-heading"><p>05</p><h2>部署服务</h2></div>
    ${table(['服务', '状态', '部署方式', '端口', '确定程度'], rows)}
    <div class="service-list">${model.services.map(renderServiceDetails).join('')}</div>
  </section>`;
}

function renderServiceDetails(service: ReportService, index: number): string {
  return `<details id="service-${index}" class="service" ${service.status === 'failed' ? 'open' : ''}>
    <summary><span>${escapeHtml(service.displayName ?? service.name)}</span>${badge(service.status)}</summary>
    <div class="service-body">
      ${keyValueTable([
        ['服务 ID', service.id],
        ['部署方式', service.deploymentType],
        ['确定程度', statusLabel(service.confidence)],
        ['开机启动', displayBoolean(service.enabledAtBoot)],
        ['进程 PID', service.processIds.join(', ') || '-'],
        ['端口', displayList(service.ports)],
        ['部署目录', displayList(service.deployDirectories)],
        ['配置文件', displayList(service.configFiles)],
        ['环境文件', displayList(service.environmentFiles)],
        ['日志位置', displayList(service.logLocations)],
        ['数据目录', displayList(service.dataDirectories)],
        ['启动命令', service.startCommand],
        ['未知字段', displayList(service.unknownFields)],
        ['冲突字段', displayList(service.conflictFields)],
        ['Evidence', displayList(service.evidenceIds)],
      ])}
      ${service.purpose === undefined ? '' : `<p class="purpose">${escapeHtml(service.purpose)}</p>`}
    </div>
  </details>`;
}

function renderFindings(model: ReportModel): string {
  const factual = model.findings.map((finding) => renderFinding(finding, false)).join('');
  const ai = (model.aiAnalysis?.findings ?? [])
    .map((finding) => renderFinding(finding, true))
    .join('');
  const unknowns = [
    ...model.unknowns.map((item) => escapeHtml(item)),
    ...(model.aiAnalysis?.unknowns ?? []).map((item) => `[AI] ${escapeHtml(item)}`),
  ];
  return `<section id="findings">
    <div class="section-heading"><p>06</p><h2>风险与未知项</h2></div>
    <div class="finding-list">${factual || '<p class="empty">无事实层风险记录。</p>'}${ai}</div>
    <h3>未知项</h3>
    ${unknowns.length === 0 ? '<p class="empty">无。</p>' : `<ul>${unknowns.map((item) => `<li>${item}</li>`).join('')}</ul>`}
  </section>`;
}

function renderFinding(finding: FindingRecord, ai: boolean): string {
  return `<article class="finding severity-${escapeHtml(finding.severity)}">
    <p class="finding-meta">${ai ? 'AI 推断 · ' : ''}${escapeHtml(statusLabel(finding.severity))} · ${escapeHtml(statusLabel(finding.confidence))}</p>
    <h3>${escapeHtml(finding.title)}</h3>
    <p>${escapeHtml(finding.description)}</p>
    <code>${escapeHtml(displayList(finding.evidenceIds))}</code>
  </article>`;
}

function renderEvidence(model: ReportModel): string {
  const rows = model.evidence
    .map(
      (evidence) =>
        `<tr><td><code>${escapeHtml(evidence.id)}</code></td><td>${escapeHtml(evidence.kind)}</td><td>${escapeHtml(evidence.source)}</td><td>${escapeHtml(evidence.status)}</td><td>${escapeHtml(evidence.sensitivity)}</td><td>${escapeHtml(formatDateTime(evidence.collectedAt))}</td></tr>`,
    )
    .join('');
  return `<section id="evidence">
    <div class="section-heading"><p>07</p><h2>证据附录</h2></div>
    ${table(['Evidence ID', '类型', '来源', '状态', '敏感级别', '采集时间'], rows)}
  </section>`;
}

function keyValueTable(rows: ReadonlyArray<readonly [string, unknown]>): string {
  return `<div class="table-wrap"><table class="kv"><tbody>${rows
    .map(
      ([label, value]) =>
        `<tr><th>${escapeHtml(label)}</th><td>${shouldUseCode(label) ? `<code>${escapeHtml(value ?? '-')}</code>` : escapeHtml(value ?? '-')}</td></tr>`,
    )
    .join('')}</tbody></table></div>`;
}

function table(headers: readonly string[], body: string): string {
  return `<div class="table-wrap"><table><thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('')}</tr></thead><tbody>${body || `<tr><td colspan="${headers.length}">-</td></tr>`}</tbody></table></div>`;
}

function badge(status: string): string {
  return `<span class="status status-${escapeHtml(status)}">${escapeHtml(statusLabel(status))}</span>`;
}

function shouldUseCode(label: string): boolean {
  return /ID|目录|文件|位置|命令|Evidence|端口/.test(label);
}

const REPORT_CSS = String.raw`
:root { max-width: 100%; color-scheme: light; font-family: "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", Arial, sans-serif; color: #202428; background: #eef1f3; }
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body { max-width: 100%; margin: 0; line-height: 1.55; overflow-x: hidden; }
.watermark-layer { position: fixed; inset: -18vh -18vw; z-index: 1000; display: grid; grid-template-columns: repeat(3, minmax(220px, 1fr)); align-content: space-around; gap: 110px 70px; color: #26363a; opacity: .06; pointer-events: none; user-select: none; overflow: hidden; transform: rotate(-24deg) scale(1.08); transform-origin: center; }
.watermark-layer span { font-size: 30px; font-weight: 700; line-height: 1; text-align: center; white-space: nowrap; }
a { color: #086f83; text-decoration: none; }
a:hover { text-decoration: underline; }
.topbar { width: 100%; max-width: 100%; min-height: 220px; padding: 40px max(32px, calc((100vw - 1480px) / 2)); background: #20272b; color: #fff; display: flex; justify-content: space-between; gap: 40px; align-items: end; }
.topbar > div { min-width: 0; }
.eyebrow { margin: 0 0 8px; color: #8fd0b6; font-size: 13px; font-weight: 700; }
h1 { margin: 0; font-size: 34px; line-height: 1.25; overflow-wrap: anywhere; }
.subtitle { margin: 10px 0 0; color: #c7d0d5; }
.top-meta { margin: 0; min-width: 300px; max-width: 100%; }
.top-meta div { display: grid; grid-template-columns: 80px minmax(0, 1fr); border-top: 1px solid #536068; padding: 8px 0; }
.top-meta dt { color: #9fafb8; }
.top-meta dd { min-width: 0; margin: 0; text-align: right; overflow-wrap: anywhere; word-break: break-all; }
.layout { width: 100%; max-width: 1480px; min-width: 0; margin: 0 auto; display: grid; grid-template-columns: 210px minmax(0, 1fr); gap: 32px; padding: 28px 32px 60px; }
.sidebar { position: sticky; top: 16px; align-self: start; border-left: 3px solid #16836a; padding: 4px 0; }
.sidebar a { display: block; padding: 8px 14px; color: #475159; font-size: 14px; }
.sidebar a:hover { background: #dde9e5; text-decoration: none; color: #164f43; }
main { max-width: 100%; min-width: 0; background: #fff; border: 1px solid #d5dadd; }
section { max-width: 100%; min-width: 0; padding: 30px 34px 36px; border-bottom: 1px solid #dfe3e5; scroll-margin-top: 12px; }
section:last-child { border-bottom: 0; }
.section-heading { display: flex; align-items: baseline; gap: 12px; margin-bottom: 20px; }
.section-heading p { margin: 0; color: #16836a; font: 700 13px Consolas, monospace; }
h2 { margin: 0; font-size: 23px; }
h3 { margin: 26px 0 10px; font-size: 16px; }
.metrics { display: grid; grid-template-columns: repeat(7, minmax(90px, 1fr)); border: 1px solid #cfd5d8; }
.metric { min-height: 88px; padding: 14px; border-right: 1px solid #d9dee1; background: #f7f8f8; }
.metric:last-child { border-right: 0; }
.metric span { display: block; color: #69747b; font-size: 12px; }
.metric strong { display: block; margin-top: 6px; font-size: 25px; color: #252c30; }
.ai-note { margin-top: 18px; padding: 14px 18px; border-left: 4px solid #b38716; background: #fff9e9; }
.ai-note p { margin: 5px 0 0; }
.table-wrap { width: 100%; max-width: 100%; min-width: 0; overflow-x: auto; border: 1px solid #d5dadd; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { padding: 9px 10px; border-bottom: 1px solid #e3e6e8; text-align: left; vertical-align: top; overflow-wrap: anywhere; }
thead th { background: #eceff0; color: #414a50; white-space: nowrap; }
tbody tr:last-child th, tbody tr:last-child td { border-bottom: 0; }
tbody tr:nth-child(even) td { background: #fafbfb; }
.kv th { width: 190px; background: #f2f4f5; color: #566168; }
code { font-family: Consolas, "SFMono-Regular", monospace; font-size: 12px; overflow-wrap: anywhere; white-space: normal; color: #4a3430; }
progress { width: 110px; height: 8px; accent-color: #16836a; vertical-align: middle; }
.progress-label { margin-left: 8px; white-space: nowrap; }
.service-list { margin-top: 24px; border-top: 1px solid #d5dadd; }
.service { border-bottom: 1px solid #d5dadd; }
.service summary { min-height: 48px; padding: 12px 4px; display: flex; justify-content: space-between; align-items: center; gap: 14px; cursor: pointer; font-weight: 700; }
.service-body { padding: 0 0 24px; }
.status { display: inline-block; border: 1px solid #aeb6bb; border-radius: 3px; padding: 2px 7px; font-size: 11px; font-weight: 700; white-space: nowrap; background: #f5f6f6; }
.status-running, .status-completed, .status-success { border-color: #5b9d82; color: #17664f; background: #edf7f2; }
.status-failed, .status-critical { border-color: #be6b63; color: #8b2922; background: #fff1ef; }
.status-stopped, .status-partial { border-color: #b49345; color: #765b17; background: #fff8e6; }
.finding-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.finding { border: 1px solid #d5dadd; border-left: 4px solid #7b858b; padding: 14px 16px; }
.finding h3 { margin: 3px 0 7px; }
.finding p { margin: 4px 0; }
.finding-meta { color: #667179; font-size: 12px; }
.severity-high, .severity-critical { border-left-color: #ae3d33; }
.severity-medium { border-left-color: #b38716; }
.severity-low { border-left-color: #287d8d; }
.empty { color: #68737a; }
.purpose { border-left: 3px solid #b38716; padding-left: 12px; }
footer { padding: 20px 32px 34px; color: #68737a; text-align: center; font-size: 12px; }
footer strong, footer span { display: block; }
footer strong { color: #465158; font-weight: 600; }
footer span { margin-top: 4px; }
@media (max-width: 900px) { .topbar { min-height: 0; padding: 28px 20px; align-items: start; flex-direction: column; gap: 24px; } h1 { font-size: 27px; } .subtitle { overflow-wrap: anywhere; } .top-meta { min-width: 0; width: 100%; } .layout { width: 100%; grid-template-columns: minmax(0, 1fr); padding: 16px; } .sidebar { max-width: 100%; position: static; display: flex; flex-wrap: wrap; overflow: hidden; border-left: 0; border-bottom: 2px solid #16836a; } .sidebar a { flex: 0 1 auto; padding: 8px 10px; font-size: 13px; } section { padding: 24px 18px; } .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); } .metric { min-width: 0; border-bottom: 1px solid #d9dee1; } .finding-list { grid-template-columns: 1fr; } .watermark-layer { grid-template-columns: repeat(2, minmax(160px, 1fr)); gap: 90px 35px; } .watermark-layer span { font-size: 22px; } }
@media print { :root { background: #fff; } .topbar { min-height: auto; padding: 18mm 15mm 10mm; background: #fff; color: #000; border-bottom: 2px solid #333; } .subtitle, .top-meta dt { color: #444; } .layout { display: block; padding: 0; } .sidebar { display: none; } main { border: 0; } section { break-inside: auto; padding: 10mm 15mm; } .service, .finding { break-inside: avoid; } a { color: #000; } footer { padding: 8mm 15mm; } .watermark-layer { opacity: .07; } }
`;
