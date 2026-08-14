import type {
  CommandCapability,
  CpuSnapshot,
  HostSnapshot,
  MemorySnapshot,
  OperatingSystem,
} from '@opsense/schema';

export interface HostSnapshotInput {
  architecture?: string | undefined;
  capabilities: CommandCapability[];
  collectedAt: string;
  cpu?: CpuSnapshot | undefined;
  fqdn?: string | undefined;
  hostname?: string | undefined;
  kernelVersion?: string | undefined;
  lscpuJson?: string | undefined;
  lscpuText?: string | undefined;
  memoryInfo?: string | undefined;
  osRelease?: string | undefined;
  packageManager?: string | undefined;
  timezone?: string | undefined;
  uptime?: string | undefined;
  virtualization?: string | undefined;
}

export function parseHostSnapshot(input: HostSnapshotInput): HostSnapshot {
  const operatingSystem = parseOsRelease(input.osRelease ?? '');
  const architecture = normalizeText(input.architecture) ?? 'unknown';
  const cpu = input.cpu ?? parseCpuSnapshot(input.lscpuJson, input.lscpuText, architecture);
  const memory = parseMemoryInfo(input.memoryInfo ?? '');
  const hostname = normalizeText(input.hostname) ?? 'unknown';
  const fqdn = normalizeText(input.fqdn);
  const timezone = normalizeText(input.timezone);
  const virtualization = normalizeVirtualization(input.virtualization);
  const packageManager = normalizeText(input.packageManager);

  return {
    architecture,
    capabilities: input.capabilities,
    collectedAt: input.collectedAt,
    cpu,
    hostname,
    kernelVersion: normalizeText(input.kernelVersion) ?? 'unknown',
    memory,
    operatingSystem,
    uptimeSeconds: parseUptimeSeconds(input.uptime),
    ...(fqdn === undefined || fqdn === hostname ? {} : { fqdn }),
    ...(packageManager === undefined ? {} : { packageManager }),
    ...(timezone === undefined ? {} : { timezone }),
    ...(virtualization === undefined ? {} : { virtualization }),
  };
}

export function parseOsRelease(source: string): OperatingSystem {
  const values = new Map<string, string>();
  for (const line of source.split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator <= 0 || line.trimStart().startsWith('#')) {
      continue;
    }
    values.set(line.slice(0, separator).trim(), unquoteOsRelease(line.slice(separator + 1).trim()));
  }

  const id = values.get('ID') || 'unknown';
  const name = values.get('NAME') || values.get('PRETTY_NAME') || id;
  const prettyName = values.get('PRETTY_NAME') || name;
  const version = values.get('VERSION');
  const versionId = values.get('VERSION_ID');
  const family = values.get('ID_LIKE')?.split(/\s+/)[0];

  return {
    id,
    name,
    prettyName,
    ...(family === undefined ? {} : { family }),
    ...(version === undefined ? {} : { version }),
    ...(versionId === undefined ? {} : { versionId }),
  };
}

export function parseCpuSnapshot(
  jsonSource: string | undefined,
  textSource: string | undefined,
  architectureFallback = 'unknown',
): CpuSnapshot {
  const fields = parseLscpuJson(jsonSource) ?? parseLscpuText(textSource ?? '');
  const architecture = fields.get('architecture') || architectureFallback;
  const logicalCores = integerField(fields, 'cpu(s)') ?? 0;
  const sockets = integerField(fields, 'socket(s)');
  const coresPerSocket = integerField(fields, 'core(s) per socket');
  const physicalCores =
    sockets !== undefined && coresPerSocket !== undefined ? sockets * coresPerSocket : undefined;
  const model = fields.get('model name') || fields.get('model');

  return {
    architecture,
    logicalCores,
    ...(model === undefined ? {} : { model }),
    ...(physicalCores === undefined ? {} : { physicalCores }),
    ...(sockets === undefined ? {} : { sockets }),
  };
}

export function parseCpuInfo(source: string, architecture = 'unknown'): CpuSnapshot {
  const processors = source.match(/^processor\s*:/gim)?.length ?? 0;
  const model = firstCpuInfoValue(source, ['model name', 'hardware', 'processor']);
  const physicalIds = cpuInfoValues(source, 'physical id');
  const coreIds = cpuInfoValues(source, 'core id');
  const physicalCores = new Set(
    physicalIds.map((physicalId, index) => `${physicalId}:${coreIds[index] ?? index}`),
  ).size;
  const sockets = new Set(physicalIds).size;

  return {
    architecture,
    logicalCores: processors,
    ...(model === undefined ? {} : { model }),
    ...(physicalIds.length === 0 || physicalCores === 0 ? {} : { physicalCores }),
    ...(physicalIds.length === 0 || sockets === 0 ? {} : { sockets }),
  };
}

export function parseMemoryInfo(source: string): MemorySnapshot {
  const values = new Map<string, number>();
  for (const line of source.split(/\r?\n/)) {
    const match = /^([^:]+):\s+(\d+)\s*(kB)?$/i.exec(line.trim());
    if (match?.[1] === undefined || match[2] === undefined) {
      continue;
    }
    const value = Number.parseInt(match[2], 10);
    values.set(match[1], match[3] === undefined ? value : value * 1024);
  }

  const availableBytes =
    values.get('MemAvailable') ??
    (values.get('MemFree') ?? 0) + (values.get('Buffers') ?? 0) + (values.get('Cached') ?? 0);

  return {
    availableBytes,
    swapFreeBytes: values.get('SwapFree') ?? 0,
    swapTotalBytes: values.get('SwapTotal') ?? 0,
    totalBytes: values.get('MemTotal') ?? 0,
  };
}

export function parseUptimeSeconds(source: string | undefined): number {
  const value = Number.parseFloat(source?.trim().split(/\s+/)[0] ?? '');
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function parseLscpuJson(source: string | undefined): Map<string, string> | undefined {
  if (source === undefined || source.trim().length === 0) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(source) as unknown;
    if (!isRecord(parsed) || !Array.isArray(parsed.lscpu)) {
      return undefined;
    }
    const fields = new Map<string, string>();
    for (const item of parsed.lscpu) {
      if (!isRecord(item) || typeof item.field !== 'string') {
        continue;
      }
      const data =
        typeof item.data === 'string' ? item.data.trim() : String(item.data ?? '').trim();
      fields.set(normalizeField(item.field), data);
    }
    return fields;
  } catch {
    return undefined;
  }
}

function parseLscpuText(source: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of source.split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator <= 0) {
      continue;
    }
    fields.set(normalizeField(line.slice(0, separator)), line.slice(separator + 1).trim());
  }
  return fields;
}

function integerField(fields: ReadonlyMap<string, string>, name: string): number | undefined {
  const value = Number.parseInt(fields.get(name) ?? '', 10);
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

function cpuInfoValues(source: string, name: string): string[] {
  const values: string[] = [];
  for (const line of source.split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator <= 0 || line.slice(0, separator).trim().toLowerCase() !== name) {
      continue;
    }
    values.push(line.slice(separator + 1).trim());
  }
  return values;
}

function firstCpuInfoValue(source: string, names: string[]): string | undefined {
  for (const name of names) {
    const value = cpuInfoValues(source, name)[0];
    if (value !== undefined && value.length > 0 && !/^\d+$/.test(value)) {
      return value;
    }
  }
  return undefined;
}

function normalizeField(value: string): string {
  return value.replace(/:\s*$/, '').trim().toLowerCase();
}

function normalizeText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}

function normalizeVirtualization(value: string | undefined): string | undefined {
  const normalized = normalizeText(value);
  return normalized === undefined || normalized === 'none' ? undefined : normalized;
}

function unquoteOsRelease(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value
      .slice(1, -1)
      .replace(/\\([\\"$`])/g, '$1')
      .replace(/\\n/g, '\n');
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
