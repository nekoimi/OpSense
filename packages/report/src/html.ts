import type { FindingRecord, ReportModel, ReportService } from '@opsense/schema';

import { REPORT_WATERMARK, reportCopyrightNotice } from './branding.js';
import {
  displayBoolean,
  displayList,
  formatBytes,
  formatDateTime,
  formatDuration,
  statusLabel,
  targetHostLabel,
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
      <dl class="target-meta">
        <div><dt>${targetHostLabel(model.metadata.targetHost)}</dt><dd>${escapeHtml(model.metadata.targetHost)}</dd></div>
        <div><dt>SSH 端口</dt><dd>${model.metadata.targetPort}</dd></div>
        <div><dt>扫描时间</dt><dd>${escapeHtml(formatDateTime(model.metadata.scannedAt))}</dd></div>
      </dl>
    </div>
    <dl class="top-meta">
      <div><dt>扫描 ID</dt><dd>${escapeHtml(model.metadata.scanId)}</dd></div>
      <div><dt>报告生成</dt><dd>${escapeHtml(formatDateTime(model.metadata.generatedAt))}</dd></div>
      <div><dt>语义来源</dt><dd>${escapeHtml(classificationLabel(model.metadata.classificationProvider, model.metadata.classificationCompleted))}</dd></div>
    </dl>
  </header>
  <div class="layout">
    <nav class="sidebar" aria-label="报告目录">
      <a href="#summary">服务器概览</a>
      <a href="#architecture">架构关系</a>
      <a href="#services">服务目录</a>
      <a href="#handbook">服务手册</a>
      <a href="#system">主机基线</a>
      <a href="#storage">存储与挂载</a>
      <a href="#network">网络</a>
      <a href="#findings">风险与待办</a>
    </nav>
    <main>
      ${renderSummary(model)}
      ${renderWikiNarrative(model)}
      ${renderServices(model)}
      ${renderSystem(model)}
      ${renderStorage(model)}
      ${renderNetwork(model)}
      ${renderFindings(model)}
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
    ['已识别服务', model.summary.serviceCount],
    ['主要服务', model.summary.primaryServiceCount],
    ['支撑组件', model.summary.supportingServiceCount],
    ['系统服务', model.summary.systemServiceCount],
    ['待确认', model.summary.needsReviewServiceCount],
    ['风险', model.summary.findingCount],
  ];
  return `<section id="summary">
    <div class="section-heading"><p>01</p><h2>服务器概览</h2></div>
    <div class="metrics">${metrics
      .map(
        ([label, value]) =>
          `<div class="metric"><span>${escapeHtml(label)}</span><strong>${value}</strong></div>`,
      )
      .join('')}</div>
    ${model.wikiNarrative === undefined ? '' : `<div class="executive-summary"><p class="kicker">运行定位</p>${renderNarrativeText(model.wikiNarrative.executiveSummary)}</div>`}
    ${model.wikiNarrative !== undefined || model.aiAnalysis === undefined ? '' : `<aside class="ai-note"><strong>AI 分析（兼容模式）</strong><p>${escapeHtml(model.aiAnalysis.hostSummary)}</p></aside>`}
  </section>`;
}

function renderWikiNarrative(model: ReportModel): string {
  const narrative = model.wikiNarrative;
  if (narrative === undefined) return renderFallbackArchitecture(model);
  const serviceById = new Map(model.serviceIndex.map((service) => [service.id, service]));
  const visibleServiceIndex = new Map(model.services.map((service, index) => [service.id, index]));
  const groups = narrative.serviceGroups
    .map((group) => {
      const services = group.serviceIds.flatMap((id) => {
        const service = serviceById.get(id);
        if (service === undefined) return [];
        const index = visibleServiceIndex.get(id);
        const label = escapeHtml(service.displayName ?? service.name);
        return [
          index === undefined
            ? `<span class="service-node">${label}<small>${escapeHtml(service.deploymentType)}</small></span>`
            : `<a class="service-node" href="#service-${index}">${label}<small>${escapeHtml(service.deploymentType)}</small></a>`,
        ];
      });
      return `<article class="topology-group"><header><h3>${escapeHtml(group.title)}</h3>${renderNarrativeText(group.summary)}</header><div class="service-nodes">${services.join('') || '<span class="empty">暂无关联服务</span>'}</div></article>`;
    })
    .join('');
  const findings = narrative.keyFindings
    .map(
      (finding) =>
        `<article class="finding severity-${escapeHtml(finding.severity)}"><p class="finding-meta">${escapeHtml(statusLabel(finding.severity))}</p><h3>${escapeHtml(finding.title)}</h3>${renderNarrativeText(finding.summary)}</article>`,
    )
    .join('');
  return `<section id="architecture">
    <div class="section-heading"><p>02</p><h2>运行架构与服务关系</h2></div>
    <div class="overview-grid">
      ${overviewBlock('系统定位', narrative.systemOverview)}
      ${overviewBlock('部署架构', narrative.architectureOverview)}
      ${overviewBlock('目录与数据', narrative.deploymentOverview)}
      ${overviewBlock('运维关注', narrative.operationsOverview)}
    </div>
    <div class="topology">
      <div class="host-node"><span>${escapeHtml(model.metadata.displayHost)}</span><small>${escapeHtml(model.host.operatingSystem ?? 'Linux 服务器')}</small></div>
      <div class="topology-rail" aria-hidden="true"></div>
      <div class="topology-groups">${groups || '<p class="empty">未形成服务分组。</p>'}</div>
    </div>
    <h3 class="subsection-title">重点发现</h3><div class="finding-list">${findings || '<p class="empty">无额外重点发现。</p>'}</div>
  </section>`;
}

function renderFallbackArchitecture(model: ReportModel): string {
  const nodes = model.services
    .map(
      (service, index) =>
        `<a class="service-node" href="#service-${index}">${escapeHtml(service.displayName ?? service.name)}<small>${escapeHtml(service.deploymentType)}</small></a>`,
    )
    .join('');
  return `<section id="architecture">
    <div class="section-heading"><p>02</p><h2>运行架构与服务关系</h2></div>
    <div class="topology">
      <div class="host-node"><span>${escapeHtml(model.metadata.displayHost)}</span><small>${escapeHtml(model.host.operatingSystem ?? 'Linux 服务器')}</small></div>
      <div class="topology-rail" aria-hidden="true"></div>
      <article class="topology-group"><header><h3>已识别部署单元</h3><p class="narrative-text">兼容模式仅展示部署归属，不推断服务依赖关系。</p></header><div class="service-nodes">${nodes || '<span class="empty">暂无部署服务</span>'}</div></article>
    </div>
  </section>`;
}

function overviewBlock(title: string, value: string): string {
  return `<article class="overview-block"><h3>${escapeHtml(title)}</h3>${renderNarrativeText(value)}</article>`;
}

function renderNarrativeText(value: string): string {
  return value
    .split(/\n{2,}/)
    .filter((paragraph) => paragraph.trim().length > 0)
    .map((paragraph) => `<p class="narrative-text">${escapeHtml(paragraph.trim())}</p>`)
    .join('');
}

function renderSystem(model: ReportModel): string {
  const host = model.host;
  return `<section id="system">
    <div class="section-heading"><p>04</p><h2>主机运行基线</h2></div>
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
    <div class="section-heading"><p>05</p><h2>存储与挂载</h2></div>
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
    <div class="section-heading"><p>06</p><h2>网络与访问面</h2></div>
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
  return `<section id="services">
    <div class="section-heading"><p>03</p><h2>服务目录</h2></div>
    ${renderServiceGroup(model, '主要部署服务', 'primary')}
    ${renderServiceGroup(model, '支撑组件', 'supporting')}
    ${renderServiceGroup(model, '待确认候选', 'needs_review')}
    <div class="system-strip"><strong>系统服务摘要</strong><span>${model.systemServices.totalCount} 个 unit</span><span>${model.systemServices.runningCount} 个运行中</span><span>${model.systemServices.failedCount} 个失败</span><span>需关注：${escapeHtml(displayList(model.systemServices.attentionServices.map((item) => item.name)))}</span></div>
    <div id="handbook" class="handbook-heading"><p>服务手册</p><span>按部署单元记录用途、运行方式、端口和目录</span></div>
    <div class="service-list">${model.services.map(renderServiceDetails).join('')}</div>
  </section>`;
}

function renderServiceGroup(
  model: ReportModel,
  title: string,
  placement: ReportService['reportPlacement'],
): string {
  const rows = model.services
    .flatMap((service, index) =>
      service.reportPlacement !== placement
        ? []
        : [
            `<tr><td><a href="#service-${index}">${escapeHtml(service.displayName ?? service.name)}</a></td><td>${badge(service.status)}</td><td>${escapeHtml(service.deploymentType)}</td><td>${escapeHtml(roleLabel(service.role))}</td><td>${renderPortSummary(service.ports, index)}</td></tr>`,
          ],
    )
    .join('');
  return `<h3>${escapeHtml(title)}</h3>${table(
    ['服务', '状态', '部署方式', '角色', '监听端口'],
    rows,
    'service-directory',
  )}`;
}

function renderServiceDetails(service: ReportService, index: number): string {
  return `<details id="service-${index}" class="service" ${service.status === 'failed' ? 'open' : ''}>
    <summary><span><strong>${escapeHtml(service.displayName ?? service.name)}</strong><small>${escapeHtml(service.deploymentType)} · ${escapeHtml(roleLabel(service.role))}</small></span>${badge(service.status)}</summary>
    <div class="service-body">
      ${service.description === undefined && service.purpose === undefined ? '' : `<div class="service-description">${renderNarrativeText(service.description ?? service.purpose ?? '')}</div>`}
      <div class="service-facts">
        ${factGroup('运行', [
          ['服务标识', service.id],
          ['开机启动', displayBoolean(service.enabledAtBoot)],
          ['进程 PID', service.processIds.join(', ') || '-'],
          ['启动命令', service.startCommand ?? '-'],
        ])}
        ${factGroup('网络', [
          ['监听端口', service.ports],
          ['当前状态', statusLabel(service.status)],
        ])}
        ${factGroup('目录与配置', [
          ['部署目录', service.deployDirectories],
          ['配置文件', service.configFiles],
          ['环境文件', service.environmentFiles],
          ['日志位置', service.logLocations],
          ['数据目录', service.dataDirectories],
        ])}
      </div>
      ${service.unknownFields.length === 0 && service.conflictFields.length === 0 ? '' : `<div class="review-note"><strong>待确认</strong><span>${escapeHtml(displayList([...service.unknownFields, ...service.conflictFields]))}</span></div>`}
    </div>
  </details>`;
}

function factGroup(
  title: string,
  rows: ReadonlyArray<readonly [string, string | readonly string[]]>,
): string {
  return `<article><h4>${escapeHtml(title)}</h4><dl>${rows
    .map(
      ([label, value]) =>
        `<div><dt>${escapeHtml(label)}</dt><dd>${Array.isArray(value) ? renderCodeList(value) : shouldUseCode(label) ? `<code>${escapeHtml(value)}</code>` : escapeHtml(value)}</dd></div>`,
    )
    .join('')}</dl></article>`;
}

function renderPortSummary(ports: readonly string[], serviceIndex: number): string {
  if (ports.length === 0) return '<span class="empty">-</span>';
  const visible = ports.slice(0, 3).map((port) => `<code>${escapeHtml(port)}</code>`);
  if (ports.length > visible.length)
    visible.push(
      `<a class="port-more" href="#service-${serviceIndex}">另 ${ports.length - visible.length} 个，查看详情</a>`,
    );
  return `<div class="port-summary">${visible.join('')}</div>`;
}

function renderCodeList(values: readonly string[]): string {
  if (values.length === 0) return '<span class="empty">-</span>';
  return `<ul class="fact-list">${values.map((value) => `<li><code>${escapeHtml(value)}</code></li>`).join('')}</ul>`;
}

function roleLabel(value: ReportService['role']): string {
  return {
    application: '应用',
    container_platform: '容器平台',
    edge: '边缘入口',
    infrastructure: '基础设施',
    middleware: '中间件',
    system: '系统服务',
    unknown: '未知',
  }[value];
}

function classificationLabel(provider: string | undefined, completed: boolean | undefined): string {
  if (provider === 'codex')
    return completed === true ? 'Codex Agent（完整审查）' : 'Codex Agent（未完成）';
  if (provider === 'legacy') return 'Legacy AI 分析（兼容模式）';
  return 'Baseline 本地规则（兼容模式）';
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
    <div class="section-heading"><p>07</p><h2>风险、未知项与运维待办</h2></div>
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
  </article>`;
}

function keyValueTable(rows: ReadonlyArray<readonly [string, unknown]>): string {
  return `<div class="table-wrap"><table class="kv"><tbody>${rows
    .map(
      ([label, value]) =>
        `<tr><th>${escapeHtml(label)}</th><td>${shouldUseCode(label) ? `<code>${escapeHtml(value ?? '-')}</code>` : escapeHtml(value ?? '-')}</td></tr>`,
    )
    .join('')}</tbody></table></div>`;
}

function table(headers: readonly string[], body: string, className?: string): string {
  const tableClass = className === undefined ? '' : ` class="${escapeHtml(className)}"`;
  const columns =
    className === 'service-directory' ? '<colgroup><col><col><col><col><col></colgroup>' : '';
  return `<div class="table-wrap"><table${tableClass}>${columns}<thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('')}</tr></thead><tbody>${body || `<tr><td colspan="${headers.length}">-</td></tr>`}</tbody></table></div>`;
}

function badge(status: string): string {
  return `<span class="status status-${escapeHtml(status)}">${escapeHtml(statusLabel(status))}</span>`;
}

function shouldUseCode(label: string): boolean {
  return /ID|标识|目录|文件|位置|命令|端口|PID/.test(label);
}

const REPORT_CSS = String.raw`
:root { max-width: 100%; color-scheme: light; font-family: "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", Arial, sans-serif; color: #20262a; background: #fff; }
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body { max-width: 100%; margin: 0; line-height: 1.65; overflow-x: hidden; }
.watermark-layer { position: fixed; inset: -18vh -18vw; z-index: 1000; display: grid; grid-template-columns: repeat(3, minmax(220px, 1fr)); align-content: space-around; gap: 110px 70px; color: #26363a; opacity: .06; pointer-events: none; user-select: none; overflow: hidden; transform: rotate(-24deg) scale(1.08); transform-origin: center; }
.watermark-layer span { font-size: 30px; font-weight: 700; line-height: 1; text-align: center; white-space: nowrap; }
a { color: #086f83; text-decoration: none; }
a:hover { text-decoration: underline; }
.topbar { width: 100%; min-height: 210px; padding: 38px max(32px, calc((100vw - 1440px) / 2)); background: #20272b; color: #fff; display: flex; justify-content: space-between; gap: 48px; align-items: end; }
.topbar > div { min-width: 0; }
.eyebrow, .kicker { margin: 0 0 8px; color: #79c4a5; font-size: 12px; font-weight: 700; text-transform: uppercase; }
h1 { margin: 0; font-size: 34px; line-height: 1.3; overflow-wrap: anywhere; }
.target-meta { display: grid; gap: 3px; margin: 12px 0 0; color: #c7d0d5; }
.target-meta div { display: grid; grid-template-columns: 72px minmax(0, 1fr); gap: 10px; }
.target-meta dt { color: #a8b4ba; }
.target-meta dd { min-width: 0; margin: 0; overflow-wrap: anywhere; }
.top-meta { margin: 0; min-width: 320px; max-width: 100%; }
.top-meta div { display: grid; grid-template-columns: 82px minmax(0, 1fr); border-top: 1px solid #536068; padding: 8px 0; }
.top-meta dt { color: #a8b4ba; }
.top-meta dd { min-width: 0; margin: 0; text-align: right; overflow-wrap: anywhere; word-break: break-all; }
.layout { width: 100%; max-width: 1440px; min-width: 0; margin: 0 auto; display: grid; grid-template-columns: 190px minmax(0, 1fr); gap: 40px; padding: 36px 32px 64px; }
.sidebar { position: sticky; top: 20px; align-self: start; padding: 2px 0; border-top: 3px solid #16836a; }
.sidebar a { display: block; padding: 9px 2px; border-bottom: 1px solid #e1e5e6; color: #4e5a61; font-size: 13px; }
.sidebar a:hover { color: #164f43; text-decoration: none; }
main { max-width: 100%; min-width: 0; }
section { max-width: 100%; min-width: 0; padding: 12px 0 46px; border-bottom: 1px solid #dfe3e5; scroll-margin-top: 16px; }
section + section { padding-top: 38px; }
.section-heading { display: flex; align-items: baseline; gap: 12px; margin-bottom: 22px; }
.section-heading p { margin: 0; color: #16836a; font: 700 12px Consolas, monospace; }
h2 { margin: 0; font-size: 24px; line-height: 1.35; }
h3 { margin: 26px 0 10px; font-size: 16px; }
h4 { margin: 0 0 10px; font-size: 14px; }
.metrics { display: grid; grid-template-columns: repeat(6, minmax(90px, 1fr)); border-block: 1px solid #cfd5d8; }
.metric { min-height: 84px; padding: 14px; border-right: 1px solid #d9dee1; }
.metric:last-child { border-right: 0; }
.metric span { display: block; color: #69747b; font-size: 12px; }
.metric strong { display: block; margin-top: 4px; font-size: 24px; color: #252c30; }
.executive-summary { margin-top: 24px; max-width: 90ch; padding-left: 18px; border-left: 4px solid #b38716; }
.executive-summary .narrative-text { font-size: 16px; }
.narrative-text { max-width: 82ch; margin: 7px 0; line-height: 1.75; white-space: pre-line; }
.overview-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); border-block: 1px solid #d5dadd; }
.overview-block { min-width: 0; padding: 18px 22px 20px 0; border-bottom: 1px solid #e2e6e7; }
.overview-block:nth-child(odd) { border-right: 1px solid #e2e6e7; }
.overview-block:nth-child(even) { padding-left: 22px; }
.overview-block:nth-last-child(-n+2) { border-bottom: 0; }
.overview-block h3 { margin: 0 0 8px; color: #31534a; }
.topology { margin-top: 30px; padding: 24px 0; border-block: 1px solid #d5dadd; }
.host-node { width: min(360px, 100%); margin: 0 auto; padding: 14px 18px; border: 2px solid #2e6f61; text-align: center; background: #f2f8f5; }
.host-node span, .host-node small { display: block; overflow-wrap: anywhere; }
.host-node span { font-weight: 700; }
.host-node small, .service-node small { margin-top: 3px; color: #68747a; font-size: 11px; }
.topology-rail { width: 1px; height: 28px; margin: 0 auto; background: #8c989d; }
.topology-groups { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.topology-group { min-width: 0; border-top: 3px solid #b38716; padding: 14px 0 0; }
.topology-group h3 { margin: 0 0 4px; }
.topology-group header .narrative-text { color: #566168; font-size: 13px; }
.service-nodes { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin-top: 12px; }
.service-node { min-width: 0; padding: 9px 10px; border: 1px solid #cfd6d8; border-radius: 4px; color: #283238; overflow-wrap: anywhere; }
.service-node small { display: block; }
.subsection-title { margin-top: 32px; }
.table-wrap { width: 100%; max-width: 100%; min-width: 0; overflow-x: auto; border-block: 1px solid #d5dadd; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { padding: 10px 9px; border-bottom: 1px solid #e3e6e8; text-align: left; vertical-align: top; overflow-wrap: anywhere; }
thead th { background: #edf0f1; color: #414a50; white-space: nowrap; }
tbody tr:last-child th, tbody tr:last-child td { border-bottom: 0; }
tbody tr:nth-child(even) td { background: #fafbfb; }
.service-directory { min-width: 680px; table-layout: fixed; }
.service-directory col:nth-child(1) { width: 35%; }
.service-directory col:nth-child(2) { width: 11%; }
.service-directory col:nth-child(3) { width: 15%; }
.service-directory col:nth-child(4) { width: 15%; }
.service-directory col:nth-child(5) { width: 24%; }
.port-summary { display: grid; gap: 3px; min-width: 0; }
.port-summary code { display: block; }
.port-more { width: fit-content; margin-top: 2px; font-size: 12px; }
.kv th { width: 190px; background: #f2f4f5; color: #566168; }
code { font-family: Consolas, "SFMono-Regular", monospace; font-size: 12px; overflow-wrap: anywhere; white-space: normal; color: #4a3430; }
progress { width: 110px; height: 8px; accent-color: #16836a; vertical-align: middle; }
.progress-label { margin-left: 8px; white-space: nowrap; }
.system-strip { display: flex; flex-wrap: wrap; gap: 8px 22px; margin: 24px 0; padding: 12px 0; border-block: 1px solid #d5dadd; color: #566168; font-size: 13px; }
.system-strip strong { color: #263238; }
.handbook-heading { display: flex; justify-content: space-between; gap: 16px; align-items: baseline; margin-top: 38px; padding-bottom: 10px; border-bottom: 3px solid #20272b; scroll-margin-top: 16px; }
.handbook-heading p { margin: 0; font-size: 20px; font-weight: 700; }
.handbook-heading span { color: #68747a; font-size: 13px; }
.service { border-bottom: 1px solid #d5dadd; }
.service summary { min-height: 62px; padding: 13px 4px; display: flex; justify-content: space-between; align-items: center; gap: 14px; cursor: pointer; }
.service summary > span:first-child { min-width: 0; }
.service summary strong, .service summary small { display: block; overflow-wrap: anywhere; }
.service summary small { margin-top: 2px; color: #68747a; font-weight: 400; }
.service-body { padding: 4px 0 28px; }
.service-description { max-width: 88ch; margin: 4px 0 18px; padding-left: 14px; border-left: 4px solid #16836a; }
.service-description p:last-child { margin-bottom: 0; }
.service-facts { display: grid; grid-template-columns: 1fr .75fr 1.35fr; border-block: 1px solid #d5dadd; }
.service-facts article { min-width: 0; padding: 15px 16px 12px 0; border-right: 1px solid #e0e4e5; }
.service-facts article + article { padding-left: 16px; }
.service-facts article:last-child { border-right: 0; }
.service-facts dl { margin: 0; }
.service-facts dl div { display: grid; grid-template-columns: 78px minmax(0, 1fr); gap: 8px; padding: 5px 0; }
.service-facts dt { color: #6b767c; font-size: 12px; }
.service-facts dd { min-width: 0; margin: 0; overflow-wrap: anywhere; }
.fact-list { display: grid; gap: 4px; margin: 0; padding: 0; list-style: none; }
.fact-list li { min-width: 0; }
.review-note { display: flex; gap: 12px; margin-top: 14px; padding: 9px 12px; border-left: 3px solid #b38716; background: #fff9e9; font-size: 13px; }
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
footer { padding: 22px 32px 34px; border-top: 1px solid #dfe3e5; color: #68737a; text-align: center; font-size: 12px; }
footer strong, footer span { display: block; }
footer strong { color: #465158; font-weight: 600; }
footer span { margin-top: 4px; }
@media (max-width: 900px) { .topbar { min-height: 0; padding: 28px 20px; align-items: start; flex-direction: column; gap: 24px; } h1 { font-size: 27px; } .top-meta { min-width: 0; width: 100%; } .top-meta div { grid-template-columns: minmax(0, 1fr); gap: 2px; } .top-meta dd { text-align: left; } .layout { width: 100%; grid-template-columns: minmax(0, 1fr); padding: 18px; } .sidebar { max-width: 100%; position: static; display: flex; flex-wrap: wrap; overflow: hidden; border-top: 0; border-bottom: 2px solid #16836a; } .sidebar a { flex: 0 1 auto; padding: 8px 10px; border: 0; font-size: 13px; } section { padding-bottom: 34px; } .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); } .metric { min-width: 0; border-bottom: 1px solid #d9dee1; } .overview-grid, .topology-groups, .service-facts, .finding-list { grid-template-columns: 1fr; } .overview-block, .overview-block:nth-child(even), .overview-block:nth-last-child(-n+2) { padding: 16px 0; border-right: 0; border-bottom: 1px solid #e2e6e7; } .overview-block:last-child { border-bottom: 0; } .service-nodes { grid-template-columns: 1fr; } .service-facts article, .service-facts article + article { padding: 14px 0; border-right: 0; border-bottom: 1px solid #e0e4e5; } .service-facts article:last-child { border-bottom: 0; } .handbook-heading { align-items: start; flex-direction: column; gap: 2px; } .watermark-layer { grid-template-columns: repeat(2, minmax(160px, 1fr)); gap: 90px 35px; } .watermark-layer span { font-size: 22px; } }
@media print { :root { background: #fff; } .topbar { min-height: auto; padding: 18mm 15mm 10mm; background: #fff; color: #000; border-bottom: 2px solid #333; } .target-meta, .target-meta dt, .top-meta dt { color: #444; } .layout { display: block; padding: 0; } .sidebar { display: none; } section { break-inside: auto; padding: 10mm 15mm; } .service, .finding, .topology-group { break-inside: avoid; } a { color: #000; } footer { padding: 8mm 15mm; } .watermark-layer { opacity: .07; } }
`;
