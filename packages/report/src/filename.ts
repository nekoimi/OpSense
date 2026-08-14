import path from 'node:path';

import type { ReportModel } from '@opsense/schema';

export interface ReportFileNames {
  docx: string;
  html: string;
}

export interface ReportFileNameOptions {
  timeZone?: string;
}

export function createReportFileNames(
  model: ReportModel,
  options: ReportFileNameOptions = {},
): ReportFileNames {
  const identifier = sanitizeReportIdentifier(model.metadata.targetHost);
  const timestamp = formatLocalFileTimestamp(new Date(model.metadata.scannedAt), options.timeZone);
  return {
    docx: `服务器巡检报告-${identifier}-${timestamp}.docx`,
    html: 'index.html',
  };
}

export function createReportOutputPaths(
  outputDirectory: string,
  model: ReportModel,
  options: ReportFileNameOptions = {},
): ReportFileNames {
  const names = createReportFileNames(model, options);
  return {
    docx: path.join(outputDirectory, names.docx),
    html: path.join(outputDirectory, names.html),
  };
}

export function sanitizeReportIdentifier(value: string, maxLength = 80): string {
  const withoutControlCharacters = [...value.normalize('NFKC')]
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint > 0x1f && codePoint !== 0x7f;
    })
    .join('');
  const normalized = withoutControlCharacters
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/[. ]+$/g, '')
    .replace(/^[_ .-]+|[_ .-]+$/g, '');
  const truncated = [...normalized]
    .slice(0, maxLength)
    .join('')
    .replace(/[. ]+$/g, '');
  if (truncated.length === 0) return '未知服务器';
  return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(truncated)
    ? `服务器_${truncated}`
    : truncated;
}

export function formatLocalFileTimestamp(value: Date, timeZone?: string): string {
  if (Number.isNaN(value.getTime())) throw new Error('Invalid report timestamp.');
  const parts = new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
    minute: '2-digit',
    month: '2-digit',
    second: '2-digit',
    timeZone,
    year: 'numeric',
  }).formatToParts(value);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}_${values.hour}-${values.minute}-${values.second}`;
}
