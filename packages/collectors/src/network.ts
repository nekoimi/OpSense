import { isIP } from 'node:net';

import type {
  DnsSnapshot,
  FirewallSummary,
  NetworkInterface,
  NetworkSnapshot,
  RouteRecord,
} from '@opsense/schema';
import type { CommandExecutionResult } from '@opsense/ssh';

export interface NetworkSnapshotInput {
  addresses?: string | undefined;
  addressesEvidenceId: string;
  collectedAt: string;
  dns?: string | undefined;
  dnsEvidenceId: string;
  firewallResults: ReadonlyMap<string, CommandExecutionResult>;
  routes?: string | undefined;
  routesEvidenceId: string;
}

export function parseNetworkSnapshot(input: NetworkSnapshotInput): NetworkSnapshot {
  return {
    collectedAt: input.collectedAt,
    dns: parseDns(input.dns ?? ''),
    firewall: summarizeFirewall(input.firewallResults),
    interfaces: parseIpAddresses(input.addresses ?? '', input.addressesEvidenceId),
    routes: parseIpRoutes(input.routes ?? ''),
  };
}

export function parseIpAddresses(source: string, evidenceId: string): NetworkInterface[] {
  if (source.trim().length === 0) {
    return [];
  }
  const parsed = JSON.parse(source) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error('ip address output is not an array.');
  }
  const interfaces: NetworkInterface[] = [];
  for (const value of parsed) {
    const item = asRecord(value);
    const name = item === undefined ? undefined : stringValue(item.ifname);
    if (item === undefined || name === undefined) {
      continue;
    }
    const state = stringValue(item.operstate);
    const macAddress = stringValue(item.address);
    const mtu = optionalNonNegativeInteger(item.mtu);
    const addresses = Array.isArray(item.addr_info)
      ? item.addr_info.flatMap((addressValue) => {
          const address = asRecord(addressValue);
          const familyValue = address === undefined ? undefined : stringValue(address.family);
          const local = address === undefined ? undefined : stringValue(address.local);
          const prefixLength =
            address === undefined ? undefined : optionalNonNegativeInteger(address.prefixlen);
          if (
            local === undefined ||
            prefixLength === undefined ||
            (familyValue !== 'inet' && familyValue !== 'inet6')
          ) {
            return [];
          }
          const scope = stringValue(address?.scope);
          return [
            {
              address: local,
              classification: classifyIpAddress(local),
              family: familyValue === 'inet' ? ('ipv4' as const) : ('ipv6' as const),
              prefixLength,
              ...(scope === undefined ? {} : { scope }),
            },
          ];
        })
      : [];
    interfaces.push({
      addresses,
      evidenceIds: [evidenceId],
      id: makeId('interface', name),
      name,
      ...(macAddress === undefined ? {} : { macAddress }),
      ...(mtu === undefined ? {} : { mtu }),
      ...(state === undefined ? {} : { state }),
    });
  }
  return interfaces;
}

export function parseIpRoutes(source: string): RouteRecord[] {
  if (source.trim().length === 0) {
    return [];
  }
  const parsed = JSON.parse(source) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error('ip route output is not an array.');
  }
  const routes: RouteRecord[] = [];
  for (const value of parsed) {
    const item = asRecord(value);
    if (item === undefined) {
      continue;
    }
    const destination = stringValue(item.dst) ?? 'default';
    const gateway = stringValue(item.gateway);
    const device = stringValue(item.dev);
    const metric = optionalNonNegativeInteger(item.metric);
    const tableValue = item.table;
    const table =
      typeof tableValue === 'string' || typeof tableValue === 'number'
        ? String(tableValue)
        : undefined;
    routes.push({
      destination,
      isDefault: destination === 'default' || destination === '0.0.0.0/0' || destination === '::/0',
      ...(device === undefined ? {} : { device }),
      ...(gateway === undefined ? {} : { gateway }),
      ...(metric === undefined ? {} : { metric }),
      ...(table === undefined ? {} : { table }),
    });
  }
  return routes;
}

export function parseIpAddressesText(source: string, evidenceId: string): NetworkInterface[] {
  const interfaces = new Map<string, NetworkInterface>();
  for (const rawLine of source.split(/\r?\n/)) {
    const match = /^\d+:\s+([^\s:]+)(?:@\S+)?\s+(inet6?)\s+(\S+)\s+.*?\bscope\s+(\S+)/.exec(
      rawLine.trim(),
    );
    if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) continue;
    const [address, prefixSource] = match[3].split('/');
    const prefixLength = Number.parseInt(prefixSource ?? '', 10);
    if (address === undefined || !Number.isInteger(prefixLength)) continue;
    const existing = interfaces.get(match[1]) ?? {
      addresses: [],
      evidenceIds: [evidenceId],
      id: makeId('interface', match[1]),
      name: match[1],
    };
    existing.addresses.push({
      address,
      classification: classifyIpAddress(address),
      family: match[2] === 'inet' ? 'ipv4' : 'ipv6',
      prefixLength,
      ...(match[4] === undefined ? {} : { scope: match[4] }),
    });
    interfaces.set(match[1], existing);
  }
  return [...interfaces.values()];
}

export function parseIpRoutesText(source: string): RouteRecord[] {
  const routes: RouteRecord[] = [];
  for (const rawLine of source.split(/\r?\n/)) {
    const tokens = rawLine.trim().split(/\s+/);
    if (tokens[0] === undefined || tokens[0].length === 0) continue;
    const destination = tokens[0];
    const gateway = tokenAfter(tokens, 'via');
    const device = tokenAfter(tokens, 'dev');
    const metricSource = tokenAfter(tokens, 'metric');
    const metric = optionalNonNegativeInteger(metricSource);
    const table = tokenAfter(tokens, 'table') ?? 'main';
    routes.push({
      destination,
      isDefault: destination === 'default' || destination === '0.0.0.0/0' || destination === '::/0',
      ...(device === undefined ? {} : { device }),
      ...(gateway === undefined ? {} : { gateway }),
      ...(metric === undefined ? {} : { metric }),
      table,
    });
  }
  return routes;
}

export function parseDns(source: string): DnsSnapshot {
  const servers: string[] = [];
  const searchDomains: string[] = [];
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, '').trim();
    if (line.length === 0 || line.startsWith('#')) {
      continue;
    }
    const [directive, ...values] = line.split(/\s+/);
    if (directive === 'nameserver' && values[0] !== undefined) {
      servers.push(values[0]);
    }
    if (directive === 'search' || directive === 'domain') {
      searchDomains.push(...values);
    }
  }
  return {
    searchDomains: [...new Set(searchDomains)],
    servers: [...new Set(servers)],
    source: '/etc/resolv.conf',
  };
}

export function classifyIpAddress(address: string): 'loopback' | 'private' | 'public' | 'unknown' {
  const family = isIP(address);
  if (family === 4) {
    const octets = address.split('.').map((part) => Number.parseInt(part, 10));
    const first = octets[0];
    const second = octets[1];
    if (first === undefined || second === undefined) {
      return 'unknown';
    }
    if (first === 127) {
      return 'loopback';
    }
    if (first === 0 || first >= 224) {
      return 'unknown';
    }
    if (
      first === 10 ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 169 && second === 254) ||
      (first === 100 && second >= 64 && second <= 127)
    ) {
      return 'private';
    }
    return 'public';
  }
  if (family === 6) {
    const normalized = address.toLowerCase().split('%')[0] ?? '';
    if (normalized === '::1') {
      return 'loopback';
    }
    if (normalized === '::' || normalized.startsWith('ff')) {
      return 'unknown';
    }
    if (/^(fc|fd)/.test(normalized) || /^fe[89ab]/.test(normalized)) {
      return 'private';
    }
    return 'public';
  }
  return 'unknown';
}

export function summarizeFirewall(
  results: ReadonlyMap<string, CommandExecutionResult>,
): FirewallSummary {
  const firewalld = results.get('firewall.firewalld');
  if (firewalld?.status === 'success') {
    const state = firewalld.stdout.trim().toLowerCase();
    return summary(
      'firewalld',
      state === 'running',
      [`state: ${state || 'unknown'}`],
      [evidenceId('firewall.firewalld')],
    );
  }
  const ufw = results.get('firewall.ufw');
  if (ufw?.status === 'success') {
    const statusLine = ufw.stdout.split(/\r?\n/).find((line) => /^status:/i.test(line.trim()));
    const active = statusLine === undefined ? undefined : /status:\s+active/i.test(statusLine);
    return summary(
      'ufw',
      active,
      [statusLine?.trim() ?? 'status: unknown'],
      [evidenceId('firewall.ufw')],
    );
  }
  const nft = results.get('firewall.nft');
  if (nft?.status === 'success') {
    const counts = countNftObjects(nft.stdout);
    return summary(
      'nftables',
      counts.rules > 0,
      [`tables: ${counts.tables}`, `chains: ${counts.chains}`, `rules: ${counts.rules}`],
      [evidenceId('firewall.nft')],
    );
  }
  const iptables = results.get('firewall.iptables');
  if (iptables?.status === 'success') {
    const lines = iptables.stdout.split(/\r?\n/);
    const tables = lines.filter((line) => line.startsWith('*')).length;
    const rules = lines.filter((line) => line.startsWith('-A ')).length;
    return summary(
      'iptables',
      rules > 0,
      [`tables: ${tables}`, `rules: ${rules}`],
      [evidenceId('firewall.iptables')],
    );
  }

  const attempted = [...results.entries()].filter(([id]) => id.startsWith('firewall.'));
  const permissionDenied = attempted.some(([, result]) => result.status === 'permission_denied');
  return summary(
    permissionDenied ? 'unknown' : 'none',
    false,
    [],
    attempted.map(([id]) => evidenceId(id)),
  );
}

function countNftObjects(source: string): { chains: number; rules: number; tables: number } {
  try {
    const parsed = JSON.parse(source) as unknown;
    if (!isRecord(parsed) || !Array.isArray(parsed.nftables)) {
      return { chains: 0, rules: 0, tables: 0 };
    }
    return parsed.nftables.reduce(
      (counts, value) => {
        const item = asRecord(value);
        if (item?.table !== undefined) counts.tables += 1;
        if (item?.chain !== undefined) counts.chains += 1;
        if (item?.rule !== undefined) counts.rules += 1;
        return counts;
      },
      { chains: 0, rules: 0, tables: 0 },
    );
  } catch {
    return { chains: 0, rules: 0, tables: 0 };
  }
}

function summary(
  backend: FirewallSummary['backend'],
  active: boolean | undefined,
  values: string[],
  evidenceIds: string[],
): FirewallSummary {
  return {
    backend,
    evidenceIds,
    summary: values.slice(0, 20),
    ...(active === undefined ? {} : { active }),
  };
}

function evidenceId(commandId: string): string {
  return `evidence:${commandId}`;
}

function makeId(prefix: string, value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9._:-]+/g, '_').replace(/^[_:.-]+/, '');
  return `${prefix}:${normalized || 'unknown'}`;
}

function optionalNonNegativeInteger(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function tokenAfter(tokens: string[], name: string): string | undefined {
  const index = tokens.indexOf(name);
  return index < 0 ? undefined : tokens[index + 1];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
