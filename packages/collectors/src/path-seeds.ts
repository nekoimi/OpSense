import { createHash } from 'node:crypto';
import path from 'node:path';

import type {
  ComposeProjectRecord,
  ContainerRecord,
  PathSeedRecord,
  ProcessRecord,
  SystemdUnitRecord,
} from '@opsense/schema';
import type { Confidence } from '@opsense/schema';

export interface PathSeedInput {
  composeProjects: readonly ComposeProjectRecord[];
  containers: readonly ContainerRecord[];
  processes: readonly ProcessRecord[];
  systemdUnits: readonly SystemdUnitRecord[];
}

const EXCLUDED_ROOTS = [
  '/proc',
  '/sys',
  '/dev',
  '/run',
  '/tmp',
  '/var/lib/docker/overlay',
  '/var/lib/docker/overlay2',
  '/var/lib/containers/storage/overlay',
] as const;

const BROAD_ROOTS = new Set(['/', '/etc', '/usr', '/var', '/home', '/opt', '/srv', '/data']);
const SYSTEM_MANAGED_PREFIXES = [
  '/bin/',
  '/boot/',
  '/lib/',
  '/lib64/',
  '/sbin/',
  '/usr/bin/',
  '/usr/lib/',
  '/usr/sbin/',
  '/usr/share/',
] as const;

export function buildPathSeeds(input: PathSeedInput): PathSeedRecord[] {
  const seeds = new Map<string, PathSeedRecord>();
  const add = (
    candidate: string | undefined,
    sourceType: string,
    sourceId: string,
    evidenceIds: readonly string[],
    confidence: Confidence,
  ): void => {
    const normalized = normalizePathSeed(candidate);
    if (normalized === undefined) return;
    const existing = seeds.get(normalized);
    const source = { evidenceIds: [...new Set(evidenceIds)], sourceId, sourceType };
    if (existing === undefined) {
      seeds.set(normalized, {
        confidence,
        id: pathId('path-seed', normalized),
        path: normalized,
        sources: [source],
      });
      return;
    }
    if (
      !existing.sources.some((item) => item.sourceId === sourceId && item.sourceType === sourceType)
    ) {
      existing.sources.push(source);
    }
    existing.confidence = strongerConfidence(existing.confidence, confidence);
  };

  for (const unit of input.systemdUnits) {
    add(unit.workingDirectory, 'systemd.working_directory', unit.id, unit.evidenceIds, 'confirmed');
    add(unit.fragmentPath, 'systemd.fragment_path', unit.id, unit.evidenceIds, 'confirmed');
    for (const environmentFile of unit.environmentFiles) {
      add(environmentFile, 'systemd.environment_file', unit.id, unit.evidenceIds, 'confirmed');
    }
    for (const command of unit.execStart) {
      for (const commandPath of extractAbsolutePaths(command)) {
        add(commandPath, 'systemd.exec_start', unit.id, unit.evidenceIds, 'confirmed');
      }
    }
  }

  for (const process of input.processes) {
    add(process.executablePath, 'process.executable', process.id, process.evidenceIds, 'confirmed');
    add(
      process.workingDirectory,
      'process.working_directory',
      process.id,
      process.evidenceIds,
      'confirmed',
    );
    for (const argument of process.arguments) {
      for (const argumentPath of extractAbsolutePaths(argument)) {
        if (!looksLikeConfigPath(argumentPath)) continue;
        add(argumentPath, 'process.config_argument', process.id, process.evidenceIds, 'inferred');
      }
    }
  }

  for (const container of input.containers) {
    for (const mount of container.mounts) {
      add(
        mount.source,
        `docker.mount.${mount.type}`,
        container.id,
        container.evidenceIds,
        'confirmed',
      );
    }
  }

  for (const project of input.composeProjects) {
    add(
      project.workingDirectory,
      'compose.working_directory',
      project.id,
      project.evidenceIds,
      'confirmed',
    );
    for (const configFile of project.configFiles) {
      add(configFile, 'compose.config_file', project.id, project.evidenceIds, 'confirmed');
    }
  }

  return [...seeds.values()]
    .map((seed) => ({ ...seed, sources: [...seed.sources].sort(compareSources) }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

export function normalizePathSeed(candidate: string | undefined): string | undefined {
  const value = candidate?.trim();
  if (
    value === undefined ||
    value.length === 0 ||
    value.length > 4096 ||
    !value.startsWith('/') ||
    hasControlCharacters(value)
  ) {
    return undefined;
  }
  const normalized = path.posix.normalize(value);
  if (
    normalized === '/' ||
    EXCLUDED_ROOTS.some((root) => normalized === root || normalized.startsWith(`${root}/`))
  ) {
    return undefined;
  }
  return normalized;
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
}

export function isPathSeedScanEligible(seed: PathSeedRecord): boolean {
  return (
    !BROAD_ROOTS.has(seed.path) &&
    !SYSTEM_MANAGED_PREFIXES.some((prefix) => seed.path.startsWith(prefix))
  );
}

export function extractAbsolutePaths(source: string): string[] {
  const matches = source.match(/\/(?:[^\s'";,)\]}]|\\.)+/g) ?? [];
  return [...new Set(matches.map((value) => value.replace(/[.:]+$/, '')))];
}

function looksLikeConfigPath(value: string): boolean {
  return (
    value.startsWith('/') &&
    /(?:^|\/)(?:[^/]+\.(?:conf|config|ini|json|toml|ya?ml)|Caddyfile|Dockerfile|\.env)$/i.test(
      value,
    )
  );
}

function strongerConfidence(left: Confidence, right: Confidence): Confidence {
  const priority: Record<Confidence, number> = {
    conflict: 3,
    confirmed: 2,
    inferred: 1,
    unknown: 0,
  };
  return priority[right] > priority[left] ? right : left;
}

function compareSources(
  left: PathSeedRecord['sources'][number],
  right: PathSeedRecord['sources'][number],
): number {
  return `${left.sourceType}:${left.sourceId}`.localeCompare(
    `${right.sourceType}:${right.sourceId}`,
  );
}

export function pathId(prefix: string, value: string): string {
  return `${prefix}:${createHash('sha256').update(value).digest('hex').slice(0, 16)}`;
}
