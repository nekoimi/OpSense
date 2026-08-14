import path from 'node:path';

import ini from 'ini';
import { parse as parseJsonc } from 'jsonc-parser';
import { parse as parseToml } from 'smol-toml';
import { parseDocument } from 'yaml';

import type { ArtifactRecord } from '@opsense/schema';
import type { Confidence } from '@opsense/schema';

import { normalizePathSeed, pathId } from './path-seeds.js';

export interface DirectoryEntry {
  fileType: 'directory' | 'file' | 'other' | 'symlink';
  group?: string;
  linkTarget?: string;
  mode?: string;
  modifiedAt?: string;
  owner?: string;
  path: string;
  sizeBytes?: number;
}

export type ConfigFormat = 'ini' | 'json' | 'toml' | 'yaml';

export interface ConfigSummary {
  format: ConfigFormat;
  keyCount: number;
  topLevelKeys: string[];
}

export function parseFindEntries(source: string): DirectoryEntry[] {
  return source.split(/\r?\n/).flatMap((line) => {
    if (line.length === 0) return [];
    const fields = line.split('\t');
    if (fields.length < 7) return [];
    const [type, size, owner, group, mode, modified, entryPath, linkTarget] = fields;
    const normalized = normalizeDiscoveredPath(entryPath);
    if (type === undefined || normalized === undefined) return [];
    return [
      directoryEntry(
        normalized,
        findFileType(type),
        size,
        owner,
        group,
        mode,
        modified,
        linkTarget,
      ),
    ];
  });
}

export function parseStatEntries(source: string): DirectoryEntry[] {
  return source.split(/\r?\n/).flatMap((line) => {
    if (line.length === 0) return [];
    const fields = line.split('\t');
    if (fields.length < 7) return [];
    const [type, size, owner, group, mode, modified, entryPath] = fields;
    const normalized = normalizeDiscoveredPath(entryPath);
    if (type === undefined || normalized === undefined) return [];
    return [
      directoryEntry(normalized, statFileType(type), size, owner, group, mode, modified, undefined),
    ];
  });
}

export function artifactFromEntry(
  entry: DirectoryEntry,
  evidenceId: string,
  confidence: Confidence,
): ArtifactRecord {
  return {
    confidence,
    evidenceIds: [evidenceId],
    exists: true,
    fileType: entry.fileType,
    id: pathId('artifact', entry.path),
    kind: classifyArtifact(entry),
    path: entry.path,
    ...(entry.group === undefined ? {} : { group: entry.group }),
    ...(entry.linkTarget === undefined ? {} : { linkTarget: entry.linkTarget }),
    ...(entry.mode === undefined ? {} : { mode: entry.mode }),
    ...(entry.modifiedAt === undefined ? {} : { modifiedAt: entry.modifiedAt }),
    ...(entry.owner === undefined ? {} : { owner: entry.owner }),
    ...(entry.sizeBytes === undefined ? {} : { sizeBytes: entry.sizeBytes }),
  };
}

export function configFormat(filePath: string): ConfigFormat | undefined {
  const basename = path.posix.basename(filePath).toLowerCase();
  const extension = path.posix.extname(basename);
  if (extension === '.json' || basename === 'package.json') return 'json';
  if (extension === '.yaml' || extension === '.yml') return 'yaml';
  if (extension === '.toml') return 'toml';
  if (extension === '.ini' || extension === '.cnf' || extension === '.service') return 'ini';
  return undefined;
}

export function parseConfigSummary(format: ConfigFormat, source: string): ConfigSummary {
  let parsed: unknown;
  switch (format) {
    case 'json':
      parsed = parseJsonDocument(source);
      break;
    case 'yaml': {
      const document = parseDocument(source, {
        prettyErrors: false,
        strict: false,
        uniqueKeys: false,
      });
      if (document.errors.length > 0) throw document.errors[0];
      parsed = document.toJS({ maxAliasCount: 20 }) as unknown;
      break;
    }
    case 'toml':
      parsed = parseToml(source);
      break;
    case 'ini':
      parsed = ini.parse(source);
      break;
  }
  const keys = isRecord(parsed) ? Object.keys(parsed).sort().slice(0, 200) : [];
  return { format, keyCount: countKeys(parsed), topLevelKeys: keys };
}

export function mergeArtifacts(artifacts: readonly ArtifactRecord[]): ArtifactRecord[] {
  const merged = new Map<string, ArtifactRecord>();
  for (const artifact of artifacts) {
    const existing = merged.get(artifact.path);
    if (existing === undefined) {
      merged.set(artifact.path, { ...artifact, evidenceIds: [...artifact.evidenceIds] });
      continue;
    }
    existing.evidenceIds = [...new Set([...existing.evidenceIds, ...artifact.evidenceIds])];
    if (artifactPriority(artifact.kind) > artifactPriority(existing.kind)) {
      existing.kind = artifact.kind;
    }
    if (existing.linkTarget === undefined && artifact.linkTarget !== undefined) {
      existing.linkTarget = artifact.linkTarget;
    }
  }
  return [...merged.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function directoryEntry(
  entryPath: string,
  fileType: DirectoryEntry['fileType'],
  size: string | undefined,
  owner: string | undefined,
  group: string | undefined,
  mode: string | undefined,
  modified: string | undefined,
  linkTarget: string | undefined,
): DirectoryEntry {
  const sizeBytes = nonNegativeInteger(size);
  const modifiedAt = epochSeconds(modified);
  const normalizedLink = normalizeLinkTarget(linkTarget);
  return {
    fileType,
    path: entryPath,
    ...(group === undefined || group.length === 0 ? {} : { group }),
    ...(mode === undefined || mode.length === 0 ? {} : { mode }),
    ...(modifiedAt === undefined ? {} : { modifiedAt }),
    ...(normalizedLink === undefined ? {} : { linkTarget: normalizedLink }),
    ...(owner === undefined || owner.length === 0 ? {} : { owner }),
    ...(sizeBytes === undefined ? {} : { sizeBytes }),
  };
}

function classifyArtifact(entry: DirectoryEntry): ArtifactRecord['kind'] {
  const basename = path.posix.basename(entry.path);
  const lower = basename.toLowerCase();
  if (/^\.env(?:\..+)?$/i.test(basename)) return 'environment';
  if (/^(?:docker-)?compose(?:\.[^.]+)?\.ya?ml$/i.test(basename)) return 'compose';
  if (lower === 'dockerfile' || lower === 'caddyfile' || lower.endsWith('.service')) {
    return 'config';
  }
  if (lower.endsWith('.log') || /\/(?:log|logs)\//i.test(entry.path)) return 'log';
  if (isDataPath(entry.path) && !isConfigDirectory(entry.path)) return 'data';
  if (/\.(?:conf|config|cnf|ini|json|properties|service|toml|xml|ya?ml)$/i.test(lower)) {
    return 'config';
  }
  if (/\.(?:bash|js|mjs|py|sh)$/i.test(lower) || /^(?:deploy|start|stop|restart)/i.test(lower)) {
    return 'script';
  }
  if (entry.fileType === 'directory') return 'directory';
  if (isExecutableMode(entry.mode) || /\/(?:bin|sbin)\//.test(entry.path)) return 'executable';
  return 'other';
}

function normalizeDiscoveredPath(value: string | undefined): string | undefined {
  const normalized = normalizePathSeed(value);
  return normalized;
}

function normalizeLinkTarget(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0 || hasControlCharacters(normalized)
    ? undefined
    : normalized;
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
}

function findFileType(value: string): DirectoryEntry['fileType'] {
  if (value === 'd') return 'directory';
  if (value === 'f') return 'file';
  if (value === 'l') return 'symlink';
  return 'other';
}

function statFileType(value: string): DirectoryEntry['fileType'] {
  const normalized = value.toLowerCase();
  if (normalized.includes('directory')) return 'directory';
  if (normalized.includes('symbolic link')) return 'symlink';
  if (normalized.includes('file')) return 'file';
  return 'other';
}

function nonNegativeInteger(value: string | undefined): number | undefined {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function epochSeconds(value: string | undefined): string | undefined {
  const seconds = Number.parseFloat(value ?? '');
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function countKeys(value: unknown, depth = 0): number {
  if (depth > 20 || value === null || typeof value !== 'object') return 0;
  if (Array.isArray(value))
    return value.reduce((total, item) => total + countKeys(item, depth + 1), 0);
  return Object.entries(value).reduce(
    (total, [, nested]) => total + 1 + countKeys(nested, depth + 1),
    0,
  );
}

function parseJsonDocument(source: string): unknown {
  const errors: Array<{ error: number; length: number; offset: number }> = [];
  const parsed = parseJsonc(source, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  }) as unknown;
  if (errors.length > 0) throw new Error('Invalid JSON or JSONC document.');
  return parsed;
}

function isDataPath(filePath: string): boolean {
  const candidate = filePath.startsWith('/data/') ? filePath.slice('/data'.length) : filePath;
  return /\/(?:data|db|[^/]+_data|mysql\d*|mariadb|mongo(?:db)?|postgres(?:ql)?)(?:\/|$)/i.test(
    candidate,
  );
}

function isConfigDirectory(filePath: string): boolean {
  return /\/(?:conf|config|etc|\.devcontainer)(?:\/|$)/i.test(filePath);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isExecutableMode(mode: string | undefined): boolean {
  const parsed = Number.parseInt(mode ?? '', 8);
  return Number.isInteger(parsed) && (parsed & 0o111) !== 0;
}

function artifactPriority(kind: ArtifactRecord['kind']): number {
  return {
    environment: 9,
    compose: 8,
    config: 7,
    script: 6,
    log: 5,
    data: 4,
    executable: 3,
    directory: 2,
    backup: 1,
    other: 0,
  }[kind];
}
