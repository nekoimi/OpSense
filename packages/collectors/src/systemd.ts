import type { SystemdUnitRecord } from '@opsense/schema';

import { redactCommandLine } from './runtime.js';

interface SystemdRuntimeState {
  activeState?: string;
  description?: string;
  loadState?: string;
  subState?: string;
}

export interface SystemdEvidenceIds {
  details: string;
  detailsByUnit?: ReadonlyMap<string, string>;
  files: string;
  units: string;
}

export function parseSystemdUnits(
  unitsSource: string,
  filesSource: string,
  detailsSource: string,
  evidenceIds: SystemdEvidenceIds,
): SystemdUnitRecord[] {
  const runtime = parseUnitList(unitsSource);
  const enabledStates = parseUnitFiles(filesSource);
  const details = parseUnitDetails(detailsSource);
  const names = new Set([...runtime.keys(), ...enabledStates.keys(), ...details.keys()]);

  return [...names]
    .filter((name) => name.endsWith('.service'))
    .sort()
    .map((name) => {
      const runtimeState = runtime.get(name);
      const detail = details.get(name);
      const enabledState = enabledStates.get(name) ?? text(detail?.UnitFileState);
      const evidence = [
        ...(runtimeState === undefined ? [] : [evidenceIds.units]),
        ...(enabledStates.has(name) ? [evidenceIds.files] : []),
        ...(detail === undefined
          ? []
          : [evidenceIds.detailsByUnit?.get(name) ?? evidenceIds.details]),
      ];
      const mainPid = integer(detail?.MainPID);
      const fragmentPath = absolutePath(detail?.FragmentPath);
      const workingDirectory = absolutePath(detail?.WorkingDirectory);
      const user = text(detail?.User);
      const group = text(detail?.Group);
      const description = text(detail?.Description) ?? runtimeState?.description;
      const activeState = runtimeState?.activeState ?? text(detail?.ActiveState);
      const loadState = runtimeState?.loadState ?? text(detail?.LoadState);
      const subState = runtimeState?.subState ?? text(detail?.SubState);
      return {
        environmentFiles: parseEnvironmentFiles(detail?.EnvironmentFiles ?? ''),
        evidenceIds: [...new Set(evidence)],
        execReload: parseExecCommands(detail?.ExecReload ?? ''),
        execStart: parseExecCommands(detail?.ExecStart ?? ''),
        id: makeId('systemd', name),
        name,
        ...(description === undefined ? {} : { description }),
        ...(enabledState === undefined ? {} : { enabledState }),
        ...(fragmentPath === undefined ? {} : { fragmentPath }),
        ...(group === undefined ? {} : { group }),
        ...(mainPid === undefined ? {} : { mainPid }),
        ...(activeState === undefined ? {} : { activeState }),
        ...(loadState === undefined ? {} : { loadState }),
        ...(subState === undefined ? {} : { subState }),
        ...(user === undefined ? {} : { user }),
        ...(workingDirectory === undefined ? {} : { workingDirectory }),
      };
    });
}

export function parseUnitList(source: string): Map<string, SystemdRuntimeState> {
  const units = new Map<string, SystemdRuntimeState>();
  for (const rawLine of source.split(/\r?\n/)) {
    const match = /^\s*(\S+\.service)\s+(\S+)\s+(\S+)\s+(\S+)\s*(.*)$/.exec(rawLine);
    if (match?.[1] === undefined) continue;
    units.set(match[1], {
      ...(match[2] === undefined ? {} : { loadState: match[2] }),
      ...(match[3] === undefined ? {} : { activeState: match[3] }),
      ...(match[4] === undefined ? {} : { subState: match[4] }),
      ...(match[5] === undefined || match[5].trim().length === 0
        ? {}
        : { description: match[5].trim() }),
    });
  }
  return units;
}

export function parseUnitFiles(source: string): Map<string, string> {
  const units = new Map<string, string>();
  for (const rawLine of source.split(/\r?\n/)) {
    const match = /^\s*(\S+\.service)\s+(\S+)/.exec(rawLine);
    if (match?.[1] !== undefined && match[2] !== undefined) units.set(match[1], match[2]);
  }
  return units;
}

export function parseUnitDetails(source: string): Map<string, Record<string, string>> {
  const units = new Map<string, Record<string, string>>();
  for (const block of source.split(/(?:\r?\n){2,}/)) {
    const values: Record<string, string> = {};
    for (const line of block.split(/\r?\n/)) {
      const separator = line.indexOf('=');
      if (separator <= 0) continue;
      values[line.slice(0, separator)] = line.slice(separator + 1);
    }
    const name = text(values.Id);
    if (name?.endsWith('.service') === true) units.set(name, values);
  }
  return units;
}

function parseExecCommands(source: string): string[] {
  if (source.trim().length === 0) return [];
  const commands = [...source.matchAll(/argv\[\]=([^;}]*)(?:[;}])/g)]
    .map((match) => match[1]?.trim())
    .filter((value): value is string => value !== undefined && value.length > 0)
    .map(redactCommandLine);
  return commands.length > 0 ? commands : [redactCommandLine(source.trim())];
}

function parseEnvironmentFiles(source: string): string[] {
  return [
    ...new Set(
      [...source.matchAll(/(?:^|\s)-?(\/[^\s;()]+)/g)].flatMap((match) =>
        match[1] === undefined ? [] : [match[1]],
      ),
    ),
  ];
}

function text(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0 || normalized === '[not set]'
    ? undefined
    : normalized;
}

function absolutePath(value: string | undefined): string | undefined {
  const normalized = text(value);
  return normalized?.startsWith('/') === true ? normalized : undefined;
}

function integer(value: string | undefined): number | undefined {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function makeId(prefix: string, value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9._:-]+/g, '_').replace(/^[_:.-]+/, '');
  return `${prefix}:${normalized || 'unknown'}`;
}
