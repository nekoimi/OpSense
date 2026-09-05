import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
} from 'docx';
import type { DeploymentInventory, WikiProjectionV3 } from '@opsense/schema';

export interface V3ReportArtifacts {
  docxFile: string;
  htmlFile: string;
  markdownFile: string;
  outputDirectory: string;
}

export async function generateV3Reports(
  inventory: DeploymentInventory,
  wiki: WikiProjectionV3,
  outputDirectory: string,
): Promise<V3ReportArtifacts> {
  await mkdir(outputDirectory, { recursive: true });
  const artifacts: V3ReportArtifacts = {
    docxFile: path.join(outputDirectory, '服务器部署清单.docx'),
    htmlFile: path.join(outputDirectory, 'index.html'),
    markdownFile: path.join(outputDirectory, 'README.md'),
    outputDirectory,
  };
  await Promise.all([
    writeFile(artifacts.markdownFile, renderV3Markdown(inventory, wiki), 'utf8'),
    writeFile(artifacts.htmlFile, renderV3Html(inventory, wiki), 'utf8'),
    writeFile(artifacts.docxFile, await renderV3Docx(inventory, wiki)),
  ]);
  return artifacts;
}

export function renderV3Markdown(inventory: DeploymentInventory, wiki: WikiProjectionV3): string {
  const narrative = wiki.narrative;
  const serviceNarratives = new Map(
    narrative?.serviceDescriptions.map((item) => [item.serviceId, item]) ?? [],
  );
  return `# ${inventory.host.hostname} 服务器部署清单

> Inventory: ${inventory.inventoryId}
>
> 语义状态: ${inventory.semanticStatus}
> 操作系统: ${inventory.host.operatingSystem}

## 执行摘要

${narrative?.executiveSummary ?? '当前报告由确定性本地清单生成，尚未完成 AI 语义撰写。'}

## 部署架构

${narrative?.architectureSummary ?? '架构说明待补充。'}

## 服务清单

${inventory.services
  .map((service) => {
    const description = serviceNarratives.get(service.serviceId);
    return `### ${service.name}

- 角色：${service.role}
- 部署方式：${service.deploymentHints.join(', ') || 'unknown'}
- 端口：${service.ports.map(formatPort).join(', ') || '未发现'}
- 路径对象：${service.pathIds.join(', ') || '未发现'}
- Evidence：${service.evidenceIds.join(', ') || '无'}

${description?.summary ?? service.purpose ?? '用途待确认。'}

${description?.operations.length ? `运维关注：${description.operations.join('；')}` : ''}

${service.reviewItems.length ? `待复核：${service.reviewItems.join('；')}` : ''}`;
  })
  .join('\n\n')}

## 系统对象聚合

${
  inventory.filteredGroups
    .map((group) => `- ${group.category}: ${group.objectCount} 个对象（${group.reason}）`)
    .join('\n') || '- 无'
}

## 未解决问题

${inventory.unresolvedQuestions.map((item) => `- ${item}`).join('\n') || '- 无'}

## 运维关注点

${narrative?.operationsConcerns.map((item) => `- ${item.text} [${item.evidenceIds.join(', ')}]`).join('\n') || '- 无'}

## 人工确认建议

${narrative?.reviewRecommendations.map((item) => `- ${item}`).join('\n') || '- 无'}
`;
}

export function renderV3Html(inventory: DeploymentInventory, wiki: WikiProjectionV3): string {
  const markdown = renderV3Markdown(inventory, wiki);
  const sections = markdown
    .split('\n')
    .map((line) => {
      if (line.startsWith('### ')) return `<h3>${escapeHtml(line.slice(4))}</h3>`;
      if (line.startsWith('## ')) return `<h2>${escapeHtml(line.slice(3))}</h2>`;
      if (line.startsWith('# ')) return `<h1>${escapeHtml(line.slice(2))}</h1>`;
      if (line.startsWith('- ')) return `<li>${escapeHtml(line.slice(2))}</li>`;
      if (line.startsWith('> ')) return `<p class="meta">${escapeHtml(line.slice(2))}</p>`;
      return line.length === 0 ? '' : `<p>${escapeHtml(line)}</p>`;
    })
    .join('\n');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(inventory.host.hostname)} 服务器部署清单</title><style>body{font-family:system-ui,"Microsoft YaHei",sans-serif;max-width:1100px;margin:auto;padding:32px;color:#243038}h1,h2,h3{color:#167b68}h2{border-bottom:1px solid #ccd8d4;padding-bottom:8px}.meta{color:#66736f;margin:4px 0}li{margin:6px 0}p{line-height:1.65}</style></head><body>${sections}</body></html>`;
}

export async function renderV3Docx(
  inventory: DeploymentInventory,
  wiki: WikiProjectionV3,
): Promise<Buffer> {
  const narrative = wiki.narrative;
  const rows = inventory.services.map(
    (service) =>
      new TableRow({
        children: [
          cell(service.name),
          cell(service.role),
          cell(service.deploymentHints.join(', ') || 'unknown'),
          cell(service.ports.map(formatPort).join(', ') || '未发现'),
        ],
      }),
  );
  const document = new Document({
    sections: [
      {
        children: [
          new Paragraph({
            heading: HeadingLevel.TITLE,
            children: [new TextRun(`${inventory.host.hostname} 服务器部署清单`)],
          }),
          paragraph(`语义状态：${inventory.semanticStatus}`),
          paragraph(`操作系统：${inventory.host.operatingSystem}`),
          heading('执行摘要'),
          paragraph(
            narrative?.executiveSummary ?? '当前报告由确定性本地清单生成，尚未完成 AI 语义撰写。',
          ),
          heading('部署架构'),
          paragraph(narrative?.architectureSummary ?? '架构说明待补充。'),
          heading('服务清单'),
          new Table({
            rows: [
              new TableRow({
                children: [cell('名称'), cell('角色'), cell('部署方式'), cell('端口')],
              }),
              ...rows,
            ],
          }),
          heading('未解决问题'),
          ...inventory.unresolvedQuestions.map((item) => paragraph(item)),
        ],
      },
    ],
  });
  return Packer.toBuffer(document);
}

function heading(value: string): Paragraph {
  return new Paragraph({ heading: HeadingLevel.HEADING_1, text: value });
}

function paragraph(value: string): Paragraph {
  return new Paragraph({ text: value });
}

function cell(value: string): TableCell {
  return new TableCell({ children: [paragraph(value)] });
}

function formatPort(port: DeploymentInventory['exposedPorts'][number]): string {
  return `${port.protocol.toUpperCase()} ${port.address ?? '0.0.0.0'}:${port.hostPort}${port.containerPort === undefined ? '' : `→${port.containerPort}`}`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
