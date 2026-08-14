import type {
  CollectionStatus,
  CommandCapability,
  CpuSnapshot,
  EvidenceRecord,
  HostSnapshot,
  MountRecord,
  NetworkSnapshot,
  StorageSnapshot,
} from '@opsense/schema';
import { getCommandSpec, toCollectionStatus } from '@opsense/ssh';
import type { CommandExecutionResult, DistributionFamily, SafeCommandExecutor } from '@opsense/ssh';

import { parseCpuInfo, parseCpuSnapshot, parseHostSnapshot, parseMemoryInfo } from './host.js';
import {
  parseDns,
  parseIpAddresses,
  parseIpAddressesText,
  parseIpRoutes,
  parseIpRoutesText,
  summarizeFirewall,
} from './network.js';
import {
  enrichMounts,
  parseDf,
  parseFindmntMounts,
  parseFstab,
  parseLsblk,
  parseLsblkPairs,
  parseMountInfo,
  parseProcSwaps,
  parseSwapDevices,
} from './storage.js';
import type { DfRecord, LsblkParseResult } from './storage.js';
import { detectDistributionFamily, probeFailureSummary, runProbe } from './probe.js';
import type { ProbeAttempt, ProbeOutcome, ProbeSpec, ProbeVariant } from './probe.js';

const ALL_DISTRIBUTIONS = ['debian', 'rhel', 'alpine', 'unknown'] as const;

const OS_RELEASE_PROBE: ProbeSpec<string> = rawProbe('host.os-release', true, [
  variant('host.os-release', nonEmptyOutput),
]);

const M3_PROBES: readonly ProbeSpec<unknown>[] = [
  rawProbe('host.kernel-release', true, [variant('host.kernel-release', nonEmptyOutput)]),
  rawProbe('host.architecture', true, [variant('host.architecture', nonEmptyOutput)]),
  rawProbe('host.hostname', true, [variant('host.hostname', nonEmptyOutput)]),
  rawProbe('host.hostname-fqdn', false, [variant('host.hostname-fqdn', nonEmptyOutput)]),
  rawProbe('host.timezone', true, [
    variant('host.timezone', nonEmptyOutput),
    variant('host.timezone-file', nonEmptyOutput),
    variant('host.timezone-link', (result) => parseTimezoneLink(nonEmptyOutput(result))),
  ]),
  rawProbe('host.uptime', true, [variant('host.uptime', nonEmptyOutput)]),
  rawProbe('host.virtualization', false, [
    {
      ...variant('host.virtualization', (result) => {
        const output = outputIncludingEmpty(result);
        if (result.exitCode === 1 && (result.stderr.trim().length > 0 || output !== 'none')) {
          throw new Error('systemd-detect-virt exit 1 is only accepted for a none result.');
        }
        if (result.exitCode === 0 && output.length === 0) {
          throw new Error('virtualization output is empty.');
        }
        return output;
      }),
      acceptedExitCodes: [0, 1],
    },
    variant('host.virtualization-dmi', nonEmptyOutput),
  ]),
  {
    id: 'host.cpu',
    required: true,
    variants: [
      variant('host.lscpu', (result) => validCpu(parseCpuSnapshot(result.stdout, undefined))),
      variant('host.lscpu-text', (result) => validCpu(parseCpuSnapshot(undefined, result.stdout))),
      variant('host.cpuinfo', (result) => validCpu(parseCpuInfo(result.stdout))),
    ],
  },
  {
    id: 'host.memory',
    required: true,
    variants: [
      variant('host.memory', (result) => {
        const memory = parseMemoryInfo(result.stdout);
        if (memory.totalBytes <= 0) throw new Error('meminfo does not contain MemTotal.');
        return memory;
      }),
    ],
  },
  {
    id: 'storage.block-devices',
    required: true,
    variants: [
      variant('storage.lsblk', (result) => parseLsblk(result.stdout, evidenceId(result.commandId))),
      variant('storage.lsblk-basic', (result) =>
        parseLsblk(result.stdout, evidenceId(result.commandId)),
      ),
      variant('storage.lsblk-pairs', (result) =>
        parseLsblkPairs(result.stdout, evidenceId(result.commandId)),
      ),
    ],
  },
  {
    id: 'storage.mounts',
    required: true,
    variants: [
      variant('storage.findmnt', (result) =>
        nonEmptyMounts(parseFindmntMounts(result.stdout, evidenceId(result.commandId))),
      ),
      variant('storage.mountinfo', (result) =>
        nonEmptyMounts(parseMountInfo(result.stdout, evidenceId(result.commandId))),
      ),
    ],
  },
  {
    id: 'storage.df-bytes',
    required: true,
    variants: [
      variant('storage.df-bytes', (result) => nonEmptyDf(parseDf(result.stdout))),
      variant('storage.df-kilobytes', (result) => nonEmptyDf(parseDf(result.stdout, 1024))),
    ],
  },
  {
    id: 'storage.df-inodes',
    required: true,
    variants: [variant('storage.df-inodes', (result) => nonEmptyDf(parseDf(result.stdout)))],
  },
  {
    id: 'storage.fstab',
    required: true,
    variants: [
      variant('storage.fstab', (result) => parseFstab(result.stdout, evidenceId(result.commandId))),
    ],
  },
  {
    id: 'storage.swap',
    required: true,
    variants: [
      variant('storage.swap', (result) =>
        parseSwapDevices(result.stdout, evidenceId(result.commandId)),
      ),
      variant('storage.swap-proc', (result) =>
        parseProcSwaps(result.stdout, evidenceId(result.commandId)),
      ),
    ],
  },
  {
    id: 'network.addresses',
    required: true,
    variants: [
      variant('network.addresses', (result) =>
        parseIpAddresses(result.stdout, evidenceId(result.commandId)),
      ),
      variant('network.addresses-text', (result) =>
        parseIpAddressesText(result.stdout, evidenceId(result.commandId)),
      ),
    ],
  },
  {
    id: 'network.routes',
    required: true,
    variants: [
      variant('network.routes', (result) => parseIpRoutes(result.stdout)),
      variant('network.routes-text', (result) => parseIpRoutesText(result.stdout)),
    ],
  },
  {
    id: 'network.dns',
    required: true,
    variants: [variant('network.dns', (r) => parseDns(r.stdout))],
  },
  rawProbe('firewall', false, [
    variant('firewall.firewalld', (result) => result),
    variant('firewall.ufw', (result) => result),
    variant('firewall.nft', (result) => result),
    variant('firewall.iptables', (result) => result),
  ]),
  packageManagerProbe(),
];

export const M3_COMMAND_IDS = [
  OS_RELEASE_PROBE.variants[0]?.commandId ?? 'host.os-release',
  ...new Set(M3_PROBES.flatMap((probe) => probe.variants.map((item) => item.commandId))),
];

export const M3_COMMAND_CONCURRENCY = 4;

const SUDO_COMMANDS = new Set([
  'firewall.firewalld',
  'firewall.ufw',
  'firewall.nft',
  'firewall.iptables',
]);

export interface M3CollectionOptions {
  commandTimeoutMs?: number;
  maxOutputBytes?: number;
  now?: () => Date;
  opsenseVersion: string;
  signal?: AbortSignal;
  useSudo?: boolean;
}

export interface M3CollectionResult {
  evidence: EvidenceRecord[];
  host: HostSnapshot;
  network: NetworkSnapshot;
  storage: StorageSnapshot;
  unknowns: string[];
}

export async function collectM3Snapshot(
  executor: SafeCommandExecutor,
  options: M3CollectionOptions,
): Promise<M3CollectionResult> {
  const executionOptions = {
    ...(options.commandTimeoutMs === undefined
      ? {}
      : { commandTimeoutMs: options.commandTimeoutMs }),
    ...(options.maxOutputBytes === undefined ? {} : { maxOutputBytes: options.maxOutputBytes }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    useSudo: (commandId: string) => options.useSudo === true && SUDO_COMMANDS.has(commandId),
  };
  const osReleaseOutcome = await runProbe(executor, OS_RELEASE_PROBE, 'unknown', executionOptions);
  const distribution = detectDistributionFamily(osReleaseOutcome.value ?? '');
  const outcomes = await mapWithConcurrency(M3_PROBES, M3_COMMAND_CONCURRENCY, (probe) =>
    runProbe(executor, probe, distribution, executionOptions),
  );
  const allOutcomes: ProbeOutcome<unknown>[] = [osReleaseOutcome, ...outcomes];
  const attempts = allOutcomes.flatMap((outcome) => outcome.attempts);
  const collectedAt = (options.now ?? (() => new Date()))().toISOString();
  const evidence = attempts.map((attempt) =>
    createCommandEvidence(attempt, options.opsenseVersion),
  );
  const unknowns = allOutcomes.flatMap((outcome) => {
    const summary = probeFailureSummary(outcome);
    return summary === undefined ? [] : [summary];
  });
  const capabilities = buildCapabilities(attempts);

  const architecture = probeValue(outcomes, 'host.architecture', 'unknown');
  const cpu = probeValue<CpuSnapshot>(outcomes, 'host.cpu', {
    architecture,
    logicalCores: 0,
  });
  const host = parseHostSnapshot({
    architecture,
    capabilities,
    collectedAt,
    cpu: cpu.architecture === 'unknown' ? { ...cpu, architecture } : cpu,
    fqdn: probeValue(outcomes, 'host.hostname-fqdn', undefined),
    hostname: probeValue(outcomes, 'host.hostname', undefined),
    kernelVersion: probeValue(outcomes, 'host.kernel-release', undefined),
    memoryInfo: undefined,
    osRelease: osReleaseOutcome.value,
    packageManager: probeValue(outcomes, 'environment.package-manager', undefined),
    timezone: probeValue(outcomes, 'host.timezone', undefined),
    uptime: probeValue(outcomes, 'host.uptime', undefined),
    virtualization: probeValue(outcomes, 'host.virtualization', undefined),
  });
  const memory = probeValue<HostSnapshot['memory']>(outcomes, 'host.memory', host.memory);

  const blockDevices = probeValue<LsblkParseResult>(outcomes, 'storage.block-devices', {
    disks: [],
    layers: [],
  });
  const mountOutcome = outcomeById<MountRecord[]>(outcomes, 'storage.mounts');
  const dfBytesOutcome = outcomeById<DfRecord[]>(outcomes, 'storage.df-bytes');
  const dfInodesOutcome = outcomeById<DfRecord[]>(outcomes, 'storage.df-inodes');
  const mounts = enrichMounts(
    mountOutcome?.value ?? [],
    dfBytesOutcome?.value ?? [],
    dfInodesOutcome?.value ?? [],
    evidenceId(dfBytesOutcome?.selectedCommandId ?? 'storage.df-bytes'),
    evidenceId(dfInodesOutcome?.selectedCommandId ?? 'storage.df-inodes'),
  );
  const storage: StorageSnapshot = {
    collectedAt,
    disks: blockDevices.disks,
    fstabEntries: probeValue(outcomes, 'storage.fstab', []),
    layers: blockDevices.layers,
    mounts,
    swapDevices: probeValue(outcomes, 'storage.swap', []),
  };

  const firewallResults = new Map(
    outcomeById(outcomes, 'firewall')?.attempts.map((attempt) => [
      attempt.result.commandId,
      attempt.result,
    ]) ?? [],
  );
  const network: NetworkSnapshot = {
    collectedAt,
    dns: probeValue(outcomes, 'network.dns', { searchDomains: [], servers: [] }),
    firewall: summarizeFirewall(firewallResults),
    interfaces: probeValue(outcomes, 'network.addresses', []),
    routes: probeValue(outcomes, 'network.routes', []),
  };

  return { evidence, host: { ...host, memory }, network, storage, unknowns };
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const runWorker = async (): Promise<void> => {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      const value = values[index];
      if (value !== undefined) results[index] = await worker(value);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, runWorker));
  return results;
}

function buildCapabilities(attempts: ProbeAttempt[]): CommandCapability[] {
  const grouped = new Map<string, CommandExecutionResult[]>();
  for (const { result } of attempts) {
    for (const command of getCommandSpec(result.commandId).requiredCommands) {
      const existing = grouped.get(command) ?? [];
      existing.push(result);
      grouped.set(command, existing);
    }
  }
  return [...grouped.entries()]
    .map(([command, results]) => ({
      available: results.some((result) => result.status !== 'command_missing'),
      command,
      evidenceIds: results.map((result) => evidenceId(result.commandId)),
      status: bestStatus(results.map((result) => toCollectionStatus(result.status))),
    }))
    .sort((left, right) => left.command.localeCompare(right.command));
}

function bestStatus(statuses: CollectionStatus[]): CollectionStatus {
  const priority: CollectionStatus[] = [
    'success',
    'truncated',
    'permission_denied',
    'timeout',
    'failed',
    'not_found',
    'command_missing',
  ];
  return priority.find((status) => statuses.includes(status)) ?? 'failed';
}

function createCommandEvidence(attempt: ProbeAttempt, opsenseVersion: string): EvidenceRecord {
  const result = attempt.result;
  const status = attempt.parseError === undefined ? toCollectionStatus(result.status) : 'failed';
  const message = (attempt.parseError ?? result.errorMessage ?? result.stderr).trim().slice(0, 500);
  return {
    collectedAt: result.finishedAt,
    commandId: result.commandId,
    id: evidenceId(result.commandId),
    kind: 'command_output',
    opsenseVersion,
    sensitivity: 'internal',
    source: result.commandId,
    status,
    value: {
      exitCode: result.exitCode ?? null,
      parseFailed: attempt.parseError !== undefined,
      stderrBytes: result.stderrBytes,
      stdoutBytes: result.stdoutBytes,
      truncated: result.status === 'truncated',
    },
    ...(status === 'success' || message.length === 0 ? {} : { message }),
  };
}

function rawProbe<T>(
  id: string,
  required: boolean,
  variants: readonly ProbeVariant<T>[],
): ProbeSpec<T> {
  return { id, required, variants };
}

function variant<T>(
  commandId: string,
  parse: (result: CommandExecutionResult) => T,
  distributions: readonly DistributionFamily[] = ALL_DISTRIBUTIONS,
): ProbeVariant<T> {
  return { commandId, distributions, parse };
}

function packageManagerProbe(): ProbeSpec<string> {
  const manager =
    (name: string) =>
    (result: CommandExecutionResult): string => {
      nonEmptyOutput(result);
      return name;
    };
  return {
    id: 'environment.package-manager',
    required: false,
    variants: [
      variant('environment.dpkg', manager('apt/dpkg'), ['debian']),
      variant('environment.rpm', manager('rpm'), ['debian']),
      variant('environment.apk', manager('apk'), ['debian']),
      variant('environment.rpm', manager('rpm'), ['rhel']),
      variant('environment.dpkg', manager('apt/dpkg'), ['rhel']),
      variant('environment.apk', manager('apk'), ['rhel']),
      variant('environment.apk', manager('apk'), ['alpine']),
      variant('environment.dpkg', manager('apt/dpkg'), ['alpine']),
      variant('environment.rpm', manager('rpm'), ['alpine']),
      variant('environment.dpkg', manager('apt/dpkg'), ['unknown']),
      variant('environment.rpm', manager('rpm'), ['unknown']),
      variant('environment.apk', manager('apk'), ['unknown']),
    ],
  };
}

function nonEmptyOutput(result: CommandExecutionResult): string {
  const output = result.stdout.trim();
  if (output.length === 0) throw new Error('command output is empty.');
  return output;
}

function outputIncludingEmpty(result: CommandExecutionResult): string {
  return result.stdout.trim();
}

function parseTimezoneLink(output: string): string {
  const marker = '/zoneinfo/';
  const index = output.indexOf(marker);
  return index < 0 ? output : output.slice(index + marker.length);
}

function validCpu(cpu: CpuSnapshot): CpuSnapshot {
  if (cpu.logicalCores <= 0) throw new Error('CPU output does not contain logical cores.');
  return cpu;
}

function nonEmptyMounts(mounts: MountRecord[]): MountRecord[] {
  if (mounts.length === 0) throw new Error('mount output does not contain mount records.');
  return mounts;
}

function nonEmptyDf(records: DfRecord[]): DfRecord[] {
  if (records.length === 0) throw new Error('df output does not contain usage records.');
  return records;
}

function outcomeById<T>(
  outcomes: readonly ProbeOutcome<unknown>[],
  id: string,
): ProbeOutcome<T> | undefined {
  return outcomes.find((outcome) => outcome.id === id) as ProbeOutcome<T> | undefined;
}

function probeValue<T>(outcomes: readonly ProbeOutcome<unknown>[], id: string, fallback: T): T {
  return outcomeById<T>(outcomes, id)?.value ?? fallback;
}

function evidenceId(commandId: string): string {
  return `evidence:${commandId}`;
}
