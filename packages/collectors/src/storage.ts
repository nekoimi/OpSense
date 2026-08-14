import type {
  DiskRecord,
  FstabEntry,
  MountRecord,
  PartitionRecord,
  StorageLayerRecord,
  StorageSnapshot,
  SwapDeviceRecord,
} from '@opsense/schema';

export interface DfRecord {
  available: number;
  source: string;
  target: string;
  total: number;
  used: number;
}

export interface LsblkParseResult {
  disks: DiskRecord[];
  layers: StorageLayerRecord[];
}

const NETWORK_FILE_SYSTEMS = new Set([
  '9p',
  'ceph',
  'cifs',
  'fuse.sshfs',
  'glusterfs',
  'nfs',
  'nfs4',
  'smb3',
]);
const PSEUDO_FILE_SYSTEMS = new Set([
  'autofs',
  'bpf',
  'cgroup',
  'cgroup2',
  'configfs',
  'debugfs',
  'devpts',
  'efivarfs',
  'fusectl',
  'hugetlbfs',
  'mqueue',
  'proc',
  'pstore',
  'securityfs',
  'sysfs',
  'tracefs',
]);
const TEMPORARY_FILE_SYSTEMS = new Set(['devtmpfs', 'ramfs', 'tmpfs']);

export interface StorageSnapshotInput {
  collectedAt: string;
  dfBytes?: string | undefined;
  dfInodes?: string | undefined;
  dfBytesEvidenceId: string;
  dfInodesEvidenceId: string;
  findmnt?: string | undefined;
  findmntEvidenceId: string;
  fstab?: string | undefined;
  fstabEvidenceId: string;
  lsblk?: string | undefined;
  lsblkEvidenceId: string;
  swap?: string | undefined;
  swapEvidenceId: string;
}

export function parseStorageSnapshot(input: StorageSnapshotInput): StorageSnapshot {
  const blockDevices = parseLsblk(input.lsblk ?? '', input.lsblkEvidenceId);
  return {
    collectedAt: input.collectedAt,
    disks: blockDevices.disks,
    fstabEntries: parseFstab(input.fstab ?? '', input.fstabEvidenceId),
    layers: blockDevices.layers,
    mounts: parseMounts(
      input.findmnt ?? '',
      input.dfBytes ?? '',
      input.dfInodes ?? '',
      input.findmntEvidenceId,
      input.dfBytesEvidenceId,
      input.dfInodesEvidenceId,
    ),
    swapDevices: parseSwapDevices(input.swap ?? '', input.swapEvidenceId),
  };
}

export function parseLsblk(source: string, evidenceId: string): LsblkParseResult {
  if (source.trim().length === 0) {
    return { disks: [], layers: [] };
  }
  const parsed = JSON.parse(source) as unknown;
  if (!isRecord(parsed) || !Array.isArray(parsed.blockdevices)) {
    throw new Error('lsblk output does not contain blockdevices.');
  }

  const disks: DiskRecord[] = [];
  const layers: StorageLayerRecord[] = [];
  for (const value of parsed.blockdevices) {
    const device = asRecord(value);
    if (device === undefined) {
      continue;
    }
    collectLayers(device, layers, evidenceId, undefined);
    const type = stringValue(device.type) ?? 'unknown';
    if (type === 'loop' || type === 'rom') {
      continue;
    }
    const name = stringValue(device.name) ?? stringValue(device.kname) ?? 'unknown';
    const id = makeId('disk', name);
    const partitions: PartitionRecord[] = [];
    collectPartitions(device, id, partitions, evidenceId);
    const model = stringValue(device.model)?.trim();
    const serial = stringValue(device.serial)?.trim();
    const rotational = booleanValue(device.rota);
    const removable = booleanValue(device.rm);
    disks.push({
      evidenceIds: [evidenceId],
      id,
      name,
      partitions,
      path: stringValue(device.path) ?? `/dev/${name}`,
      sizeBytes: parseByteSize(device.size),
      type,
      ...(model === undefined || model.length === 0 ? {} : { model }),
      ...(removable === undefined ? {} : { removable }),
      ...(rotational === undefined ? {} : { rotational }),
      ...(serial === undefined || serial.length === 0 ? {} : { serial }),
    });
  }
  return { disks, layers: deduplicateLayers(layers) };
}

export function parseLsblkPairs(source: string, evidenceId: string): LsblkParseResult {
  const records = source
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map(parseKeyValueLine);
  if (records.length === 0 && source.trim().length > 0) {
    throw new Error('lsblk pairs output does not contain records.');
  }

  const byName = new Map<string, Record<string, unknown>>();
  for (const record of records) {
    const normalized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      normalized[key.toLowerCase()] = value;
    }
    const name = stringValue(normalized.name);
    if (name !== undefined) {
      byName.set(name, normalized);
    }
  }

  const roots: Record<string, unknown>[] = [];
  for (const device of byName.values()) {
    const parentName = stringValue(device.pkname);
    const parent = parentName === undefined ? undefined : byName.get(parentName);
    if (parent === undefined) {
      roots.push(device);
      continue;
    }
    const children = Array.isArray(parent.children) ? parent.children : [];
    children.push(device);
    parent.children = children;
  }
  return parseLsblk(JSON.stringify({ blockdevices: roots }), evidenceId);
}

export function parseMounts(
  findmntSource: string,
  dfBytesSource: string,
  dfInodesSource: string,
  findmntEvidenceId: string,
  dfBytesEvidenceId: string,
  dfInodesEvidenceId: string,
): MountRecord[] {
  return enrichMounts(
    parseFindmntMounts(findmntSource, findmntEvidenceId),
    parseDf(dfBytesSource),
    parseDf(dfInodesSource),
    dfBytesEvidenceId,
    dfInodesEvidenceId,
  );
}

export function parseFindmntMounts(source: string, evidenceId: string): MountRecord[] {
  if (source.trim().length === 0) return [];
  const parsed = JSON.parse(source) as unknown;
  if (!isRecord(parsed) || !Array.isArray(parsed.filesystems)) {
    throw new Error('findmnt output does not contain filesystems.');
  }
  const mounts: MountRecord[] = [];

  const visit = (value: unknown): void => {
    const item = asRecord(value);
    if (item === undefined) {
      return;
    }
    const target = stringValue(item.target);
    const source = stringValue(item.source);
    const fileSystemType = stringValue(item.fstype);
    if (target !== undefined && source !== undefined && fileSystemType !== undefined) {
      const options = splitOptions(stringValue(item.options));
      mounts.push({
        evidenceIds: [evidenceId],
        fileSystemType,
        id: makeId('mount', target),
        network: isNetworkFileSystem(fileSystemType, source),
        options,
        pseudo: PSEUDO_FILE_SYSTEMS.has(fileSystemType),
        readOnly: options.includes('ro'),
        source,
        target,
        temporary: TEMPORARY_FILE_SYSTEMS.has(fileSystemType),
      });
    }
    if (Array.isArray(item.children)) {
      item.children.forEach(visit);
    }
  };
  parsed.filesystems.forEach(visit);
  return mounts;
}

export function parseMountInfo(source: string, evidenceId: string): MountRecord[] {
  const mounts: MountRecord[] = [];
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const separator = line.indexOf(' - ');
    if (separator < 0) continue;
    const left = line.slice(0, separator).split(' ');
    const right = line.slice(separator + 3).split(' ');
    const target = decodeMountInfoField(left[4]);
    const mountOptions = left[5];
    const fileSystemType = right[0];
    const mountSource = decodeMountInfoField(right[1]);
    if (
      target === undefined ||
      mountOptions === undefined ||
      fileSystemType === undefined ||
      mountSource === undefined
    ) {
      continue;
    }
    const options = splitOptions(mountOptions);
    mounts.push({
      evidenceIds: [evidenceId],
      fileSystemType,
      id: makeId('mount', target),
      network: isNetworkFileSystem(fileSystemType, mountSource),
      options,
      pseudo: PSEUDO_FILE_SYSTEMS.has(fileSystemType),
      readOnly: options.includes('ro'),
      source: mountSource,
      target,
      temporary: TEMPORARY_FILE_SYSTEMS.has(fileSystemType),
    });
  }
  return mounts;
}

export function enrichMounts(
  mounts: MountRecord[],
  byteRecords: DfRecord[],
  inodeRecords: DfRecord[],
  bytesEvidenceId: string,
  inodesEvidenceId: string,
): MountRecord[] {
  const byteUsage = new Map(byteRecords.map((record) => [record.target, record]));
  const inodeUsage = new Map(inodeRecords.map((record) => [record.target, record]));
  return mounts.map((mount) => {
    const bytes = byteUsage.get(mount.target);
    const inodes = inodeUsage.get(mount.target);
    return {
      ...mount,
      evidenceIds: [
        ...mount.evidenceIds,
        ...(bytes === undefined ? [] : [bytesEvidenceId]),
        ...(inodes === undefined ? [] : [inodesEvidenceId]),
      ],
      ...(bytes === undefined
        ? {}
        : {
            availableBytes: bytes.available,
            totalBytes: bytes.total,
            usedBytes: bytes.used,
          }),
      ...(inodes === undefined ? {} : { inodeTotal: inodes.total, inodeUsed: inodes.used }),
    };
  });
}

export function parseDf(source: string, blockSize = 1): DfRecord[] {
  const records: DfRecord[] = [];
  for (const line of source.split(/\r?\n/).slice(1)) {
    const match = /^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+\d+%\s+(.+)$/.exec(line.trim());
    if (match === null) {
      continue;
    }
    records.push({
      available: Number.parseInt(match[4] ?? '0', 10) * blockSize,
      source: match[1] ?? 'unknown',
      target: match[5] ?? 'unknown',
      total: Number.parseInt(match[2] ?? '0', 10) * blockSize,
      used: Number.parseInt(match[3] ?? '0', 10) * blockSize,
    });
  }
  return records;
}

export function parseFstab(source: string, evidenceId: string): FstabEntry[] {
  const entries: FstabEntry[] = [];
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) {
      continue;
    }
    const fields = line.split(/\s+/);
    if (fields.length < 4) {
      continue;
    }
    const sourceValue = fields[0];
    const target = fields[1];
    const fileSystemType = fields[2];
    if (sourceValue === undefined || target === undefined || fileSystemType === undefined) {
      continue;
    }
    const dump = optionalInteger(fields[4]);
    const pass = optionalInteger(fields[5]);
    entries.push({
      evidenceIds: [evidenceId],
      fileSystemType,
      options: splitOptions(fields[3]),
      source: sourceValue,
      target,
      ...(dump === undefined ? {} : { dump }),
      ...(pass === undefined ? {} : { pass }),
    });
  }
  return entries;
}

export function parseSwapDevices(source: string, evidenceId: string): SwapDeviceRecord[] {
  const devices: SwapDeviceRecord[] = [];
  for (const line of source.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 4 || fields[0] === '') {
      continue;
    }
    const name = fields[0];
    const type = fields[1];
    if (name === undefined || type === undefined) {
      continue;
    }
    const priority = optionalInteger(fields[4]);
    devices.push({
      evidenceIds: [evidenceId],
      id: makeId('swap', name),
      name,
      sizeBytes: nonNegativeInteger(fields[2]),
      type,
      usedBytes: nonNegativeInteger(fields[3]),
      ...(priority === undefined ? {} : { priority }),
    });
  }
  return devices;
}

export function parseProcSwaps(source: string, evidenceId: string): SwapDeviceRecord[] {
  const lines = source.split(/\r?\n/);
  if (/^Filename\s+/i.test(lines[0]?.trim() ?? '')) lines.shift();
  return parseSwapDevices(
    lines
      .map((line) => {
        const fields = line.trim().split(/\s+/);
        if (fields.length < 5) return '';
        return `${fields[0]} ${fields[1]} ${Number(fields[2]) * 1024} ${Number(fields[3]) * 1024} ${fields[4]}`;
      })
      .join('\n'),
    evidenceId,
  );
}

function collectPartitions(
  parent: Record<string, unknown>,
  diskId: string,
  partitions: PartitionRecord[],
  evidenceId: string,
): void {
  if (!Array.isArray(parent.children)) {
    return;
  }
  for (const value of parent.children) {
    const child = asRecord(value);
    if (child === undefined) {
      continue;
    }
    const name = stringValue(child.name) ?? stringValue(child.kname) ?? 'unknown';
    const fileSystemType = stringValue(child.fstype);
    const uuid = stringValue(child.uuid);
    partitions.push({
      evidenceIds: [evidenceId],
      id: makeId('partition', name),
      mountPoints: mountPoints(child),
      name,
      parentDiskId: diskId,
      path: stringValue(child.path) ?? `/dev/${name}`,
      sizeBytes: parseByteSize(child.size),
      ...(fileSystemType === undefined ? {} : { fileSystemType }),
      ...(uuid === undefined ? {} : { uuid }),
    });
    collectPartitions(child, diskId, partitions, evidenceId);
  }
}

function collectLayers(
  device: Record<string, unknown>,
  layers: StorageLayerRecord[],
  evidenceId: string,
  parentPath: string | undefined,
): void {
  const name = stringValue(device.name) ?? stringValue(device.kname) ?? 'unknown';
  const path = stringValue(device.path) ?? `/dev/${name}`;
  const type = stringValue(device.type) ?? '';
  const layerType = type === 'lvm' ? 'lvm' : type.startsWith('raid') ? 'raid' : undefined;
  if (layerType !== undefined) {
    layers.push({
      devices: parentPath === undefined ? [] : [parentPath],
      evidenceIds: [evidenceId],
      id: makeId(layerType, name),
      name,
      sizeBytes: parseByteSize(device.size),
      type: layerType,
    });
  }
  if (Array.isArray(device.children)) {
    for (const child of device.children) {
      const record = asRecord(child);
      if (record !== undefined) {
        collectLayers(record, layers, evidenceId, path);
      }
    }
  }
}

function deduplicateLayers(layers: StorageLayerRecord[]): StorageLayerRecord[] {
  return [...new Map(layers.map((layer) => [layer.id, layer])).values()];
}

function mountPoints(device: Record<string, unknown>): string[] {
  const values = Array.isArray(device.mountpoints)
    ? device.mountpoints
    : device.mountpoint === undefined
      ? []
      : [device.mountpoint];
  return values.filter((value): value is string => typeof value === 'string' && value.length > 0);
}

function isNetworkFileSystem(fileSystemType: string, source: string): boolean {
  return (
    NETWORK_FILE_SYSTEMS.has(fileSystemType) || source.startsWith('//') || /^[^/]+:/.test(source)
  );
}

function parseKeyValueLine(line: string): Record<string, string> {
  const values: Record<string, string> = {};
  const pattern = /([A-Z0-9_]+)="((?:\\.|[^"])*)"/g;
  for (const match of line.matchAll(pattern)) {
    if (match[1] !== undefined && match[2] !== undefined) {
      values[match[1]] = match[2].replace(/\\x([0-9a-f]{2})/gi, (_, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      );
    }
  }
  return values;
}

function decodeMountInfoField(value: string | undefined): string | undefined {
  return value?.replace(/\\([0-7]{3})/g, (_, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );
}

function splitOptions(value: string | undefined): string[] {
  return (
    value
      ?.split(',')
      .map((option) => option.trim())
      .filter(Boolean) ?? []
  );
}

function makeId(prefix: string, value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9._:-]+/g, '_').replace(/^[_:.-]+/, '');
  return `${prefix}:${normalized || 'unknown'}`;
}

function optionalInteger(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function nonNegativeInteger(value: unknown): number {
  const parsed = optionalInteger(value);
  return parsed !== undefined && parsed >= 0 ? parsed : 0;
}

function parseByteSize(value: unknown): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
  }
  const normalized = String(value ?? '').trim();
  const match = /^(\d+(?:\.\d+)?)\s*([KMGTPE])?(?:i?B)?$/i.exec(normalized);
  if (match?.[1] === undefined) {
    return 0;
  }
  const amount = Number.parseFloat(match[1]);
  const units = ['', 'K', 'M', 'G', 'T', 'P', 'E'];
  const exponent = units.indexOf((match[2] ?? '').toUpperCase());
  return Number.isFinite(amount) && exponent >= 0 ? Math.round(amount * 1024 ** exponent) : 0;
}

function booleanValue(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') {
    return value;
  }
  if (value === 0 || value === '0') {
    return false;
  }
  if (value === 1 || value === '1') {
    return true;
  }
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
