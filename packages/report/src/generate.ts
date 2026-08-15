import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { redactForReport } from '@opsense/redaction';
import { buildServiceWikiProjection } from '@opsense/wiki';
import {
  InventoryProjectionSchema,
  ReportModelSchema,
  ServiceWikiProjectionSchema,
  ScanSnapshotSchema,
  assertSchema,
} from '@opsense/schema';
import type {
  InventoryProjection,
  ReportModel,
  ScanSnapshot,
  ServiceWikiProjection,
} from '@opsense/schema';

import { renderDocxReport } from './docx.js';
import { createReportFileNames } from './filename.js';
import { renderHtmlReport } from './html.js';
import { renderMarkdownBundle } from './markdown.js';
import { buildReportModel } from './model.js';
import { validateDocxBuffer } from './validation.js';
import type { DocxValidationResult } from './validation.js';
import {
  assertReportQuality,
  evaluateReportQuality,
  type ReportProfile,
  type ReportQualityResult,
} from './quality.js';

export type ReportFormat = 'docx' | 'html' | 'markdown';

export interface GenerateReportOptions {
  formats?: readonly ReportFormat[];
  now?: () => Date;
  outputDirectory: string;
  profile?: ReportProfile;
  sourceSnapshot?: ScanSnapshot;
  timeZone?: string;
  wikiProjection?: ServiceWikiProjection;
}

export interface GeneratedReportArtifacts {
  docxFile?: string;
  docxValidation?: DocxValidationResult;
  htmlFile?: string;
  markdownFiles: string[];
  modelFile: string;
  outputDirectory: string;
  projectionFile: string;
  qualityFile: string;
  quality: ReportQualityResult;
  redactionReportFile: string;
  snapshotFile?: string;
  wikiProjectionFile: string;
}

export async function generateReportArtifacts(
  projection: InventoryProjection,
  options: GenerateReportOptions,
): Promise<GeneratedReportArtifacts> {
  const formats = new Set(options.formats ?? ['docx', 'html', 'markdown']);
  const now = options.now ?? (() => new Date());
  assertSchema(InventoryProjectionSchema, projection);
  const reportProjection = redactForReport(projection, now);
  assertSchema(InventoryProjectionSchema, reportProjection.value);
  const wiki =
    options.wikiProjection ?? buildServiceWikiProjection(reportProjection.value, { now });
  assertSchema(ServiceWikiProjectionSchema, wiki);
  const model = buildReportModel(reportProjection.value, { now });
  const redacted = redactForReport(model, now);
  assertSchema(ReportModelSchema, redacted.value);
  const quality = evaluateReportQuality(reportProjection.value, redacted.value, wiki, {
    now,
    ...(options.profile === undefined ? {} : { profile: options.profile }),
  });
  assertReportQuality(quality);
  await mkdir(options.outputDirectory, { recursive: true });

  const fileNames = createReportFileNames(redacted.value, {
    ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }),
  });
  const modelFile = path.join(options.outputDirectory, 'report-model.json');
  const projectionFile = path.join(options.outputDirectory, 'inventory-projection.json');
  const wikiProjectionFile = path.join(options.outputDirectory, 'wiki-projection.json');
  const qualityFile = path.join(options.outputDirectory, 'report-quality.json');
  const redactionReportFile = path.join(options.outputDirectory, 'redaction-report.json');
  const writes = [
    writeAtomic(modelFile, `${JSON.stringify(redacted.value, null, 2)}\n`),
    writeAtomic(projectionFile, `${JSON.stringify(reportProjection.value, null, 2)}\n`),
    writeAtomic(wikiProjectionFile, `${JSON.stringify(wiki, null, 2)}\n`),
    writeAtomic(qualityFile, `${JSON.stringify(quality, null, 2)}\n`),
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
    quality,
    qualityFile,
    redactionReportFile,
    wikiProjectionFile,
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
