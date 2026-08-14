import type { FindingRecord, ReportModel, ReportService } from '@opsense/schema';
import JSZip from 'jszip';
import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Header,
  HeadingLevel,
  PageBreak,
  PageNumber,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableLayoutType,
  TableOfContents,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType,
} from 'docx';

import { REPORT_WATERMARK, reportCopyrightNotice } from './branding.js';
import {
  displayBoolean,
  displayList,
  formatBytes,
  formatDateTime,
  formatDuration,
  statusLabel,
} from './format.js';

const BODY_FONT = { ascii: 'Arial', eastAsia: 'Microsoft YaHei', hAnsi: 'Arial' } as const;
const MONO_FONT = { ascii: 'Consolas', eastAsia: 'Microsoft YaHei', hAnsi: 'Consolas' } as const;
const ACCENT = '167B68';
const DARK = '252C30';
const LIGHT = 'EEF2F1';
const BORDER = 'C7CFD3';

export async function renderDocxReport(model: ReportModel): Promise<Buffer> {
  const document = createDocxDocument(model);
  return addCopyrightWatermark(await Packer.toBuffer(document));
}

export function createDocxDocument(model: ReportModel): Document {
  const copyrightNotice = reportCopyrightNotice(model.metadata.generatedAt);
  return new Document({
    creator: 'OpSense',
    description: `${model.metadata.displayHost} 服务器环境与部署服务巡检报告`,
    features: { updateFields: true },
    keywords: 'OpSense, Linux, 服务器巡检, 部署服务',
    sections: [
      {
        children: buildDocumentChildren(model),
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  text(`${copyrightNotice} · `, { color: '69747B', size: 18 }),
                  new TextRun({ children: [PageNumber.CURRENT], font: BODY_FONT, size: 18 }),
                  text(' / '),
                  new TextRun({ children: [PageNumber.TOTAL_PAGES], font: BODY_FONT, size: 18 }),
                ],
              }),
            ],
          }),
          first: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [text(copyrightNotice, { color: '69747B', size: 18 })],
              }),
            ],
          }),
        },
        headers: {
          default: new Header({
            children: [
              new Paragraph({
                border: { bottom: { color: BORDER, size: 4, style: BorderStyle.SINGLE } },
                children: [text(model.metadata.displayHost, { bold: true, color: DARK })],
                spacing: { after: 100 },
              }),
            ],
          }),
          first: new Header({ children: [new Paragraph('')] }),
        },
        properties: {
          page: {
            margin: { bottom: 900, footer: 450, header: 450, left: 900, right: 900, top: 900 },
          },
          titlePage: true,
        },
      },
    ],
    styles: {
      default: {
        document: {
          paragraph: { spacing: { after: 120, line: 320 } },
          run: { color: DARK, font: BODY_FONT, size: 20 },
        },
        heading1: {
          paragraph: { keepNext: true, spacing: { after: 180, before: 280 } },
          run: { bold: true, color: DARK, font: BODY_FONT, size: 32 },
        },
        heading2: {
          paragraph: { keepNext: true, spacing: { after: 120, before: 220 } },
          run: { bold: true, color: ACCENT, font: BODY_FONT, size: 26 },
        },
        heading3: {
          paragraph: { keepNext: true, spacing: { after: 100, before: 180 } },
          run: { bold: true, color: DARK, font: BODY_FONT, size: 22 },
        },
        title: {
          paragraph: { alignment: AlignmentType.CENTER, spacing: { after: 240 } },
          run: { bold: true, color: DARK, font: BODY_FONT, size: 46 },
        },
      },
    },
    subject: 'Linux 服务器环境与部署服务巡检',
    title: model.metadata.title,
  });
}

async function addCopyrightWatermark(buffer: Buffer): Promise<Buffer> {
  const zip = await JSZip.loadAsync(buffer);
  const headerNames = Object.keys(zip.files).filter((name) => /^word\/header\d+\.xml$/.test(name));
  if (headerNames.length === 0) throw new Error('Invalid DOCX: no header parts for watermark.');
  for (const [index, headerName] of headerNames.entries()) {
    const entry = zip.file(headerName);
    const xml = await entry?.async('string');
    if (xml === undefined || !xml.includes('</w:p>')) {
      throw new Error(`Invalid DOCX header part: ${headerName}.`);
    }
    if (!xml.includes('OpSenseWatermark')) {
      zip.file(headerName, xml.replace('</w:p>', `${watermarkXml(index + 1)}</w:p>`));
    }
  }
  return zip.generateAsync({ compression: 'DEFLATE', type: 'nodebuffer' });
}

function watermarkXml(index: number): string {
  return `<w:r><w:rPr><w:noProof/></w:rPr><w:pict><v:rect id="OpSenseWatermark${index}" o:spid="_x0000_s${2048 + index}" style="position:absolute;margin-left:0;margin-top:0;width:300pt;height:62pt;rotation:315;z-index:-251654144;mso-position-horizontal:center;mso-position-horizontal-relative:margin;mso-position-vertical:center;mso-position-vertical-relative:margin;v-text-anchor:middle" filled="f" stroked="f" o:allowincell="f"><v:textbox inset="0,0,0,0"><w:txbxContent><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Arial" w:eastAsia="Microsoft YaHei" w:hAnsi="Arial"/><w:b/><w:color w:val="D0D6D8"/><w:sz w:val="56"/><w:szCs w:val="56"/></w:rPr><w:t>${REPORT_WATERMARK}</w:t></w:r></w:p></w:txbxContent></v:textbox><w10:wrap type="none" anchorx="margin" anchory="margin"/></v:rect></w:pict></w:r>`;
}

function buildDocumentChildren(model: ReportModel): Array<Paragraph | Table | TableOfContents> {
  return [
    ...cover(model),
    new Paragraph({ children: [new PageBreak()] }),
    heading('目录', 1),
    new TableOfContents('目录', { headingStyleRange: '1-3', hyperlink: true }),
    new Paragraph({ children: [new PageBreak()] }),
    heading('执行摘要', 1),
    summaryTable(model),
    ...(model.aiAnalysis === undefined
      ? []
      : [
          heading('AI 分析（推断层）', 2),
          paragraph(model.aiAnalysis.hostSummary),
          paragraph(model.aiAnalysis.storageSummary),
        ]),
    heading('系统环境', 1, true),
    systemTable(model),
    heading('存储与挂载', 1, true),
    heading('磁盘', 2),
    diskTable(model),
    heading('挂载', 2),
    mountTable(model),
    heading('网络', 1, true),
    networkTable(model),
    keyValueTable([
      ['默认路由', displayList(model.network.defaultRoutes)],
      ['DNS', displayList(model.network.dnsServers)],
      ['搜索域', displayList(model.network.searchDomains)],
      [
        '防火墙',
        `${model.network.firewallBackend ?? '-'} / ${displayBoolean(model.network.firewallActive)}`,
      ],
    ]),
    heading('部署服务清单', 1, true),
    serviceSummaryTable(model),
    heading('服务详情', 1, true),
    ...model.services.flatMap((service) => serviceDetail(service)),
    heading('风险与待确认项', 1, true),
    ...findingParagraphs(model),
    heading('未知项', 2),
    ...unknownParagraphs(model),
    heading('证据附录', 1, true),
    evidenceTable(model),
  ];
}

function cover(model: ReportModel): Paragraph[] {
  return [
    new Paragraph({ spacing: { before: 2200 } }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [text('OPSENSE', { bold: true, color: ACCENT, size: 24 })],
      spacing: { after: 240 },
    }),
    new Paragraph({ heading: HeadingLevel.TITLE, text: model.metadata.title }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [text(`${model.metadata.targetHost}:${model.metadata.targetPort}`, { size: 24 })],
      spacing: { after: 700 },
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [text(`扫描状态：${statusLabel(model.metadata.state)}`)],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [text(`扫描时间：${formatDateTime(model.metadata.scannedAt)}`)],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [text(`报告时间：${formatDateTime(model.metadata.generatedAt)}`)],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [text(`扫描 ID：${model.metadata.scanId}`, { mono: true })],
      spacing: { before: 600 },
    }),
  ];
}

function summaryTable(model: ReportModel): Table {
  return createTable(
    ['服务总数', '运行中', '已停止', '容器', '磁盘', '挂载', '风险', '未知项'],
    [
      [
        model.summary.serviceCount,
        model.summary.runningServiceCount,
        model.summary.stoppedServiceCount,
        model.summary.containerCount,
        model.summary.diskCount,
        model.summary.mountCount,
        model.summary.findingCount,
        model.summary.unknownCount,
      ],
    ],
  );
}

function systemTable(model: ReportModel): Table {
  const host = model.host;
  return keyValueTable([
    ['主机名', host.hostname],
    ['FQDN', host.fqdn],
    ['操作系统', host.operatingSystem],
    ['内核版本', host.kernelVersion],
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
  ]);
}

function diskTable(model: ReportModel): Table {
  return createTable(
    ['名称', '路径', '型号', '容量', '文件系统', '挂载点'],
    model.disks.map((disk) => [
      disk.name,
      disk.path,
      disk.model ?? '-',
      formatBytes(disk.sizeBytes),
      displayList(disk.fileSystemTypes),
      displayList(disk.mountPoints),
    ]),
    new Set([1, 5]),
  );
}

function mountTable(model: ReportModel): Table {
  return createTable(
    ['来源', '挂载点', '文件系统', '总量', '已用', '使用率', '只读'],
    model.mounts.map((mount) => [
      mount.source,
      mount.target,
      mount.fileSystemType,
      formatBytes(mount.totalBytes),
      formatBytes(mount.usedBytes),
      mount.usagePercent === undefined ? '-' : `${mount.usagePercent}%`,
      displayBoolean(mount.readOnly),
    ]),
    new Set([0, 1]),
  );
}

function networkTable(model: ReportModel): Table {
  return createTable(
    ['接口', '状态', 'MAC', 'MTU', '地址'],
    model.network.interfaces.map((item) => [
      item.name,
      item.state ?? '-',
      item.macAddress ?? '-',
      item.mtu ?? '-',
      displayList(item.addresses),
    ]),
    new Set([2, 4]),
  );
}

function serviceSummaryTable(model: ReportModel): Table {
  return createTable(
    ['服务', '状态', '部署方式', '端口', '确定程度'],
    model.services.map((service) => [
      service.displayName ?? service.name,
      statusLabel(service.status),
      service.deploymentType,
      displayList(service.ports),
      statusLabel(service.confidence),
    ]),
    new Set([3]),
  );
}

function serviceDetail(service: ReportService): Array<Paragraph | Table> {
  return [
    heading(service.displayName ?? service.name, 2),
    keyValueTable(
      [
        ['服务 ID', service.id],
        ['状态', statusLabel(service.status)],
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
      ],
      new Set([0, 6, 7, 8, 9, 10, 11, 12, 15]),
    ),
    ...(service.purpose === undefined ? [] : [heading('用途说明', 3), paragraph(service.purpose)]),
  ];
}

function findingParagraphs(model: ReportModel): Paragraph[] {
  const factual = model.findings.flatMap((finding) => findingBlock(finding, false));
  const ai = (model.aiAnalysis?.findings ?? []).flatMap((finding) => findingBlock(finding, true));
  return factual.length === 0 && ai.length === 0
    ? [paragraph('无风险记录。')]
    : [...factual, ...ai];
}

function findingBlock(finding: FindingRecord, ai: boolean): Paragraph[] {
  return [
    heading(`${ai ? '[AI 推断] ' : ''}[${statusLabel(finding.severity)}] ${finding.title}`, 2),
    paragraph(finding.description),
    paragraph(
      `确定程度：${statusLabel(finding.confidence)}；Evidence：${displayList(finding.evidenceIds)}`,
      true,
    ),
  ];
}

function unknownParagraphs(model: ReportModel): Paragraph[] {
  const values = [
    ...model.unknowns,
    ...(model.aiAnalysis?.unknowns ?? []).map((item) => `[AI] ${item}`),
  ];
  return values.length === 0
    ? [paragraph('无。')]
    : values.map(
        (value) =>
          new Paragraph({ bullet: { level: 0 }, children: [text(value)], spacing: { after: 60 } }),
      );
}

function evidenceTable(model: ReportModel): Table {
  return createTable(
    ['Evidence ID', '类型', '来源', '状态', '敏感级别', '采集时间'],
    model.evidence.map((evidence) => [
      evidence.id,
      evidence.kind,
      evidence.source,
      evidence.status,
      evidence.sensitivity,
      formatDateTime(evidence.collectedAt),
    ]),
    new Set([0, 2]),
  );
}

function keyValueTable(
  rows: ReadonlyArray<readonly [string, unknown]>,
  monoRows = new Set<number>(),
): Table {
  return new Table({
    layout: TableLayoutType.AUTOFIT,
    rows: rows.map(
      ([label, value], index) =>
        new TableRow({
          cantSplit: true,
          children: [
            cell(label, { bold: true, fill: LIGHT, width: 24 }),
            cell(value ?? '-', { mono: monoRows.has(index), width: 76 }),
          ],
        }),
    ),
    width: { size: 100, type: WidthType.PERCENTAGE },
  });
}

function createTable(
  headers: readonly string[],
  values: ReadonlyArray<ReadonlyArray<string | number>>,
  monoColumns = new Set<number>(),
): Table {
  const rows = values.length === 0 ? [headers.map(() => '-')] : values;
  return new Table({
    layout: TableLayoutType.AUTOFIT,
    rows: [
      new TableRow({
        cantSplit: true,
        tableHeader: true,
        children: headers.map((header) => cell(header, { bold: true, fill: 'DDE7E3' })),
      }),
      ...rows.map(
        (row) =>
          new TableRow({
            cantSplit: true,
            children: headers.map((_, index) =>
              cell(row[index] ?? '-', { mono: monoColumns.has(index) }),
            ),
          }),
      ),
    ],
    width: { size: 100, type: WidthType.PERCENTAGE },
  });
}

interface CellOptions {
  bold?: boolean;
  fill?: string;
  mono?: boolean;
  width?: number;
}

function cell(value: unknown, options: CellOptions = {}): TableCell {
  return new TableCell({
    borders: {
      bottom: { color: BORDER, size: 2, style: BorderStyle.SINGLE },
      left: { color: BORDER, size: 2, style: BorderStyle.SINGLE },
      right: { color: BORDER, size: 2, style: BorderStyle.SINGLE },
      top: { color: BORDER, size: 2, style: BorderStyle.SINGLE },
    },
    children: [
      new Paragraph({
        children: [
          text(breakLongText(String(value ?? '-')), {
            ...(options.bold === undefined ? {} : { bold: options.bold }),
            ...(options.mono === undefined ? {} : { mono: options.mono }),
            size: 18,
          }),
        ],
        spacing: { after: 0, before: 0 },
        wordWrap: true,
      }),
    ],
    margins: { bottom: 90, left: 100, right: 100, top: 90 },
    ...(options.fill === undefined
      ? {}
      : { shading: { color: 'auto', fill: options.fill, type: ShadingType.CLEAR } }),
    verticalAlign: VerticalAlign.CENTER,
    ...(options.width === undefined
      ? {}
      : { width: { size: options.width, type: WidthType.PERCENTAGE } }),
  });
}

function heading(value: string, level: 1 | 2 | 3, pageBreakBefore = false): Paragraph {
  const levels = {
    1: HeadingLevel.HEADING_1,
    2: HeadingLevel.HEADING_2,
    3: HeadingLevel.HEADING_3,
  } as const;
  return new Paragraph({
    heading: levels[level],
    keepNext: true,
    pageBreakBefore,
    text: value,
  });
}

function paragraph(value: string, mono = false): Paragraph {
  return new Paragraph({ children: [text(breakLongText(value), { mono })] });
}

interface TextOptions {
  bold?: boolean;
  color?: string;
  mono?: boolean;
  size?: number;
}

function text(value: string, options: TextOptions = {}): TextRun {
  return new TextRun({
    ...(options.bold === undefined ? {} : { bold: options.bold }),
    ...(options.color === undefined ? {} : { color: options.color }),
    font: options.mono ? MONO_FONT : BODY_FONT,
    size: options.size ?? 20,
    text: value,
  });
}

function breakLongText(value: string): string {
  return value.replace(/([/\\:._-])/g, '$1\u200B');
}
