import { XMLParser } from 'fast-xml-parser';
import JSZip from 'jszip';

export interface DocxValidationResult {
  entries: string[];
  hasCopyrightNotice: boolean;
  hasUpdateFields: boolean;
  hasWatermark: boolean;
  paragraphCount: number;
  tableCount: number;
  text: string;
}

const REQUIRED_DOCX_ENTRIES = [
  '[Content_Types].xml',
  '_rels/.rels',
  'word/document.xml',
  'word/settings.xml',
  'word/styles.xml',
  'word/_rels/document.xml.rels',
] as const;

export async function validateDocxBuffer(buffer: Buffer): Promise<DocxValidationResult> {
  const zip = await JSZip.loadAsync(buffer, { checkCRC32: true });
  const entries = Object.keys(zip.files).sort();
  const missing = REQUIRED_DOCX_ENTRIES.filter((entry) => zip.file(entry) === null);
  if (missing.length > 0) {
    throw new Error(`Invalid DOCX: missing ${missing.join(', ')}.`);
  }
  const documentXml = await zip.file('word/document.xml')?.async('string');
  const settingsXml = await zip.file('word/settings.xml')?.async('string');
  const headerXml = await readXmlParts(zip, /^word\/header\d+\.xml$/);
  const footerXml = await readXmlParts(zip, /^word\/footer\d+\.xml$/);
  if (documentXml === undefined) throw new Error('Invalid DOCX: document.xml is empty.');
  if (settingsXml === undefined) throw new Error('Invalid DOCX: settings.xml is empty.');
  const parser = new XMLParser({ ignoreAttributes: false });
  const parsed = parser.parse(documentXml) as unknown;
  const textValues: string[] = [];
  collectTextNodes(parsed, textValues);
  const paragraphCount = (documentXml.match(/<w:p(?:\s|>)/g) ?? []).length;
  const tableCount = (documentXml.match(/<w:tbl(?:\s|>)/g) ?? []).length;
  if (paragraphCount === 0) throw new Error('Invalid DOCX: no paragraphs found.');
  return {
    entries,
    hasCopyrightNotice: footerXml.some(
      (xml) => xml.includes('OpSense') && xml.includes('保留所有权利'),
    ),
    hasUpdateFields:
      /<w:updateFields(?:\s[^>]*)?\/>/.test(settingsXml) ||
      /<w:updateFields[^>]*w:val="(?:true|1)"/.test(settingsXml),
    hasWatermark: headerXml.some(
      (xml) => xml.includes('OpSenseWatermark') && xml.includes('OpSense 版权所有'),
    ),
    paragraphCount,
    tableCount,
    text: textValues.join('\n'),
  };
}

async function readXmlParts(zip: JSZip, pattern: RegExp): Promise<string[]> {
  const names = Object.keys(zip.files).filter((name) => pattern.test(name));
  return Promise.all(
    names.map(async (name) => {
      const content = await zip.file(name)?.async('string');
      return content ?? '';
    }),
  );
}

function collectTextNodes(value: unknown, output: string[]): void {
  if (value === null || value === undefined) return;
  if (typeof value === 'string' || typeof value === 'number') return;
  if (Array.isArray(value)) {
    for (const item of value) collectTextNodes(item, output);
    return;
  }
  if (typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'w:t') {
      collectPrimitiveText(item, output);
    } else {
      collectTextNodes(item, output);
    }
  }
}

function collectPrimitiveText(value: unknown, output: string[]): void {
  if (typeof value === 'string' || typeof value === 'number') {
    output.push(String(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPrimitiveText(item, output);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (!key.startsWith('@_')) collectPrimitiveText(item, output);
    }
  }
}
