import type { ContainerRecord, ProcessRecord, SocketRecord } from '@opsense/schema';

interface ProcessLinks {
  cwd?: string;
  exe?: string;
}

export function parseProcessList(
  source: string,
  linksSource: string,
  passwdSource: string,
  evidenceIds: { links: string; list: string },
  collectedAt: string,
): ProcessRecord[] {
  const links = parseProcessLinks(linksSource);
  const users = parsePasswd(passwdSource);
  const collectedTime = new Date(collectedAt).getTime();
  const processes: ProcessRecord[] = [];

  for (const rawLine of source.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(rawLine);
    if (match === null) continue;
    const pid = positiveInteger(match[1]);
    const parentPid = nonNegativeInteger(match[2]);
    const userId = nonNegativeInteger(match[3]);
    const elapsedSeconds = nonNegativeInteger(match[4]);
    const cgroup = match[5] === '-' ? undefined : match[5];
    const commandLine = match[6]?.trim();
    if (pid === undefined || commandLine === undefined || commandLine.length === 0) continue;

    const commandTokens = redactCommandTokens(splitCommandLine(commandLine));
    const command = commandTokens.shift() ?? commandLine;
    const processLinks = links.get(pid);
    const containerId = extractContainerId(cgroup);
    const userName = userId === undefined ? undefined : users.get(userId);
    const startedAt =
      elapsedSeconds === undefined || !Number.isFinite(collectedTime)
        ? undefined
        : new Date(collectedTime - elapsedSeconds * 1000).toISOString();
    const processEvidenceIds = [evidenceIds.list];
    if (processLinks !== undefined) processEvidenceIds.push(evidenceIds.links);

    processes.push({
      arguments: commandTokens,
      command: redactInlineSecrets(command),
      evidenceIds: processEvidenceIds,
      id: `process:${pid}`,
      pid,
      ...(cgroup === undefined ? {} : { cgroup }),
      ...(containerId === undefined ? {} : { containerId }),
      ...(processLinks?.cwd === undefined ? {} : { workingDirectory: processLinks.cwd }),
      ...(processLinks?.exe === undefined ? {} : { executablePath: processLinks.exe }),
      ...(parentPid === undefined ? {} : { parentPid }),
      ...(startedAt === undefined ? {} : { startedAt }),
      ...(userId === undefined ? {} : { userId }),
      ...(userName === undefined ? {} : { userName }),
    });
  }
  return processes;
}

export function parseProcessLinks(source: string): Map<number, ProcessLinks> {
  const links = new Map<number, ProcessLinks>();
  for (const line of source.split(/\r?\n/)) {
    const match = /^\/proc\/(\d+)\/(exe|cwd)\t(.+)$/.exec(line.trim());
    if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) continue;
    const pid = positiveInteger(match[1]);
    if (pid === undefined) continue;
    const existing = links.get(pid) ?? {};
    const kind = match[2] as 'cwd' | 'exe';
    existing[kind] = match[3].replace(/\s+\(deleted\)$/, '');
    links.set(pid, existing);
  }
  return links;
}

export function parsePasswd(source: string): Map<number, string> {
  const users = new Map<number, string>();
  for (const line of source.split(/\r?\n/)) {
    const fields = line.split(':');
    const name = fields[0];
    const uid = nonNegativeInteger(fields[2]);
    if (name !== undefined && name.length > 0 && uid !== undefined) users.set(uid, name);
  }
  return users;
}

export function redactCommandLine(source: string): string {
  return redactCommandTokens(splitCommandLine(source)).join(' ');
}

export function parseSsSockets(source: string, evidenceId: string): SocketRecord[] {
  const sockets: SocketRecord[] = [];
  for (const rawLine of source.split(/\r?\n/)) {
    const match = /^\s*(tcp|udp)\S*\s+\S+\s+\d+\s+\d+\s+(\S+)\s+(\S+)(?:\s+(.*))?$/i.exec(rawLine);
    if (match?.[1] === undefined || match[2] === undefined) continue;
    const endpoint = parseEndpoint(match[2]);
    if (endpoint === undefined) continue;
    const processes = parseSsProcesses(match[4] ?? '');
    sockets.push(
      socketRecord(
        match[1].toLowerCase() as 'tcp' | 'udp',
        endpoint,
        processes.pids,
        processes.names,
        evidenceId,
      ),
    );
  }
  return deduplicateSockets(sockets);
}

export function parseNetstatSockets(source: string, evidenceId: string): SocketRecord[] {
  const sockets: SocketRecord[] = [];
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!/^(tcp|udp)/i.test(line)) continue;
    const fields = line.split(/\s+/);
    const protocolSource = fields[0]?.toLowerCase();
    const endpointSource = fields[3];
    if (protocolSource === undefined || endpointSource === undefined) continue;
    const endpoint = parseEndpoint(
      endpointSource,
      protocolSource.endsWith('6') ? 'ipv6' : undefined,
    );
    if (endpoint === undefined) continue;
    const processField = fields.find((field) => /^\d+\//.test(field));
    const processMatch = /^(\d+)\/(.+)$/.exec(processField ?? '');
    sockets.push(
      socketRecord(
        protocolSource.startsWith('tcp') ? 'tcp' : 'udp',
        endpoint,
        processMatch?.[1] === undefined ? [] : [Number.parseInt(processMatch[1], 10)],
        processMatch?.[2] === undefined ? [] : [processMatch[2]],
        evidenceId,
      ),
    );
  }
  return deduplicateSockets(sockets);
}

export function associateSocketContainers(
  sockets: SocketRecord[],
  processes: ProcessRecord[],
  containers: ContainerRecord[],
): SocketRecord[] {
  const processContainers = new Map(
    processes.flatMap((process) =>
      process.containerId === undefined ? [] : [[process.pid, process.containerId] as const],
    ),
  );
  for (const container of containers) {
    if (container.processId !== undefined && container.processId > 0) {
      processContainers.set(container.processId, container.id);
    }
  }
  return sockets.map((socket) => ({
    ...socket,
    containerIds: [
      ...new Set(
        socket.processIds.flatMap((pid) => {
          const containerId = processContainers.get(pid);
          return containerId === undefined ? [] : [containerId];
        }),
      ),
    ],
  }));
}

function socketRecord(
  protocol: 'tcp' | 'udp',
  endpoint: { address: string; family: 'ipv4' | 'ipv6'; port: number },
  processIds: number[],
  processNames: string[],
  evidenceId: string,
): SocketRecord {
  return {
    containerIds: [],
    evidenceIds: [evidenceId],
    exposed: !isLoopbackAddress(endpoint.address),
    family: endpoint.family,
    id: makeId('socket', `${protocol}-${endpoint.family}-${endpoint.address}-${endpoint.port}`),
    listening: true,
    localAddress: endpoint.address,
    localPort: endpoint.port,
    processIds: [...new Set(processIds.filter((pid) => pid > 0))],
    processNames: [...new Set(processNames)],
    protocol,
  };
}

function parseEndpoint(
  source: string,
  familyHint?: 'ipv4' | 'ipv6',
): { address: string; family: 'ipv4' | 'ipv6'; port: number } | undefined {
  const normalized = source.replace(/^\[|\]$/g, '');
  const separator = normalized.lastIndexOf(':');
  if (separator < 0) return undefined;
  const port = nonNegativeInteger(normalized.slice(separator + 1));
  if (port === undefined || port > 65_535) return undefined;
  const rawAddress = normalized.slice(0, separator).replace(/^\[|\]$/g, '');
  const address =
    rawAddress.length === 0 || rawAddress === '*' ? '*' : (rawAddress.split('%')[0] ?? '*');
  const family = familyHint ?? (address.includes(':') ? 'ipv6' : 'ipv4');
  return { address, family, port };
}

function parseSsProcesses(source: string): { names: string[]; pids: number[] } {
  const names: string[] = [];
  const pids: number[] = [];
  for (const match of source.matchAll(/\("([^"]+)"(?:,pid=(\d+))?/g)) {
    if (match[1] !== undefined) names.push(match[1]);
    if (match[2] !== undefined) pids.push(Number.parseInt(match[2], 10));
  }
  return { names, pids };
}

function deduplicateSockets(sockets: SocketRecord[]): SocketRecord[] {
  const byId = new Map<string, SocketRecord>();
  for (const socket of sockets) {
    const existing = byId.get(socket.id);
    if (existing === undefined) {
      byId.set(socket.id, socket);
      continue;
    }
    existing.processIds = [...new Set([...existing.processIds, ...socket.processIds])];
    existing.processNames = [...new Set([...existing.processNames, ...socket.processNames])];
  }
  return [...byId.values()];
}

function extractContainerId(cgroup: string | undefined): string | undefined {
  if (cgroup === undefined) return undefined;
  const match = /(?:docker[-/]|^|\/)([a-f0-9]{12,64})(?:\.scope|\/|$)/i.exec(cgroup);
  return match?.[1] === undefined ? undefined : `container:${match[1].toLowerCase()}`;
}

function splitCommandLine(source: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  let escaped = false;
  for (const character of source) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      else current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (/\s/.test(character)) {
      if (current.length > 0) tokens.push(current);
      current = '';
    } else {
      current += character;
    }
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

function redactCommandTokens(tokens: string[]): string[] {
  const redacted: string[] = [];
  let redactNext = false;
  for (const token of tokens) {
    if (redactNext) {
      redacted.push('[REDACTED]');
      redactNext = false;
      continue;
    }
    const inline =
      /^(--?[^=]*(?:password|passwd|passphrase|token|secret|api[-_]?key|authorization|credential)[^=]*)=(.*)$/i.exec(
        token,
      );
    if (inline?.[1] !== undefined) {
      redacted.push(`${inline[1]}=[REDACTED]`);
      continue;
    }
    const assignment =
      /^([^=]*(?:password|passwd|passphrase|token|secret|api[-_]?key|authorization|credential)[^=]*)=(.*)$/i.exec(
        token,
      );
    if (assignment?.[1] !== undefined) {
      redacted.push(`${assignment[1]}=[REDACTED]`);
      continue;
    }
    if (/^-p.+$/i.test(token)) {
      redacted.push('-p[REDACTED]');
      continue;
    }
    redacted.push(redactInlineSecrets(token));
    redactNext =
      token === '-p' ||
      /^--?[^=]*(?:password|passwd|passphrase|token|secret|api[-_]?key|authorization|credential)$/i.test(
        token,
      );
  }
  return redacted;
}

function redactInlineSecrets(value: string): string {
  return value.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@');
}

function isLoopbackAddress(address: string): boolean {
  return address === '::1' || address === 'localhost' || /^127\./.test(address);
}

function makeId(prefix: string, value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9._:-]+/g, '_').replace(/^[_:.-]+/, '');
  return `${prefix}:${normalized || 'unknown'}`;
}

function positiveInteger(value: string | undefined): number | undefined {
  const parsed = nonNegativeInteger(value);
  return parsed !== undefined && parsed > 0 ? parsed : undefined;
}

function nonNegativeInteger(value: string | undefined): number | undefined {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}
