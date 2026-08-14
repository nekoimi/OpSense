import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { redactForReport } from '@opsense/redaction';
import {
  InventoryProjectionSchema,
  ReportModelSchema,
  ScanSnapshotSchema,
  assertSchema,
} from '@opsense/schema';
import type { InventoryProjection, ReportModel, ScanSnapshot } from '@opsense/schema';

import { renderDocxReport } from './docx.js';
import { createReportFileNames } from './filename.js';
import { renderHtmlReport } from './html.js';
import { renderMarkdownBundle } from './markdown.js';
import { buildReportModel } from './model.js';
import { validateDocxBuffer } from './validation.js';
import type { DocxValidationResult } from './validation.js';

export type ReportFormat = 'docx' | 'html' | 'markdown';

export interface GenerateReportOptions {
  formats?: readonly ReportFormat[];
  now?: () => Date;
  outputDirectory: string;
  sourceSnapshot?: ScanSnapshot;
  timeZone?: string;
}

export interface GeneratedReportArtifacts {
  docxFile?: string;
  docxValidation?: DocxValidationResult;
  htmlFile?: string;
  markdownFiles: string[];
  modelFile: string;
  outputDirectory: string;
  projectionFile: string;
  redactionReportFile: string;
  snapshotFile?: string;
}

export async function generateReportArtifacts(
  projection: InventoryProjection,
  options: GenerateReportOptions,
): Promise<GeneratedReportArtifacts> {
  const formats = new Set(options.formats ?? ['docx', 'html', 'markdown']);
  const now = options.now ?? (() => new Date());
  assertSchema(InventoryProjectionSchema, projection);
  const model = buildReportModel(projection, { now });
  const redacted = redactForReport(model, now);
  assertSchema(ReportModelSchema, redacted.value);
  await mkdir(options.outputDirectory, { recursive: true });

  const fileNames = createReportFileNames(redacted.value, {
    ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }),
  });
  const modelFile = path.join(options.outputDirectory, 'report-model.json');
  const projectionFile = path.join(options.outputDirectory, 'inventory-projection.json');
  const redactionReportFile = path.join(options.outputDirectory, 'redaction-report.json');
  const reportProjection = redactForReport(projection, now);
  assertSchema(InventoryProjectionSchema, reportProjection.value);
  const writes = [
    writeAtomic(modelFile, `${JSON.stringify(redacted.value, null, 2)}\n`),
    writeAtomic(projectionFile, `${JSON.stringify(reportProjection.value, null, 2)}\n`),
    writeAtomic(redactionReportFile, `${JSON.stringify(redacted.report, null, 2)}\n`),
  ];
  let snapshotFile: string | undefined;
  if (options.sourceSnapshot !== undefined) {
    snapshotFile = path.join(options.outputDirectory, 'snapshot.json');
    const reportSnapshot = redactForReport(options.sourceSnapshot, now);
    assertSchema(ScanSnapshotSchema, reportSnapshot.value);
    writes.push(writeAtomic(snapshotFile, `${JSON.stringify(reportSnapshot.value, null, 2)}\n`));
  }
  await Promise.all(writes);

  const result: GeneratedReportArtifacts = {
    markdownFiles: [],
    modelFile,
    outputDirectory: options.outputDirectory,
    projectionFile,
    redactionReportFile,
    ...(snapshotFile === undefined ? {} : { snapshotFile }),
  };

  if (formats.has('html')) {
    const htmlFile = path.join(options.outputDirectory, fileNames.html);
    await writeAtomic(htmlFile, renderHtmlReport(redacted.value));
    result.htmlFile = htmlFile;
  }

  if (formats.has('markdown')) {
    const bundle = renderMarkdownBundle(redacted.value);
    for (const [relativePath, content] of bundle.files) {
      const filePath = path.join(options.outputDirectory, relativePath);
      await writeAtomic(filePath, content);
      result.markdownFiles.push(filePath);
    }
  }

  if (formats.has('docx')) {
    const buffer = await renderDocxReport(redacted.value);
    const validation = await validateDocxBuffer(buffer);
    const docxFile = path.join(options.outputDirectory, fileNames.docx);
    await writeAtomic(docxFile, buffer);
    result.docxFile = docxFile;
    result.docxValidation = validation;
  }

  return result;
}

async function writeAtomic(filePath: string, content: string | Uint8Array): Promise<void> {
  const directory = path.dirname(filePath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(temporaryPath, content);
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function createReportModel(projection: InventoryProjection, now?: () => Date): ReportModel {
  return buildReportModel(projection, { ...(now === undefined ? {} : { now }) });
}
