import crypto from 'node:crypto';

import type { DiscoveryCandidate, EvidenceIndex, InventoryProjection } from '@opsense/schema';

export type ContextSection =
  | 'host'
  | 'storage'
  | 'network'
  | 'services'
  | 'processes'
  | 'containers'
  | 'systemd_summary'
  | 'path_candidates'
  | 'findings'
  | 'visibility_summary';

export interface AgentContext {
  l0: Record<string, unknown>;
  l1: Record<string, unknown>;
  l2?: Record<string, unknown>;
  hash: string;
}

export interface ContextBuilderOptions {
  projection: InventoryProjection;
  evidenceIndex?: EvidenceIndex;
  redact?: (value: unknown) => unknown;
}

export class ContextBuilder {
  private readonly projection: InventoryProjection;
  private readonly evidenceIndex: EvidenceIndex | undefined;
  private readonly redact: (value: unknown) => unknown;

  public constructor(options: ContextBuilderOptions) {
    this.projection = options.projection;
    this.evidenceIndex = options.evidenceIndex;
    this.redact = options.redact ?? redactContext;
  }

  public build(options: {
    stage: string;
    round: number;
    budget: unknown;
    recent?: unknown[];
  }): AgentContext {
    const p = this.projection;
    const rankedCandidates = this.rankedCandidates();
    const contextCandidates = rankedCandidates.slice(0, 20);
    const l0 = this.redact({
      scanId: p.sourceSnapshotId,
      stage: options.stage,
      round: options.round,
      budget: options.budget,
      counts: {
        services: p.services.length,
        candidates: rankedCandidates.length,
        candidatesShown: contextCandidates.length,
        candidatesOmitted: Math.max(0, rankedCandidates.length - contextCandidates.length),
        evidence: p.evidence.length,
        findings: p.findings.length,
        filtered: p.filteredCounts,
      },
      unresolvedQuestions: p.unknowns.slice(0, 40),
      recent: options.recent ?? [],
    }) as Record<string, unknown>;
    const l1 = this.redact({
      host: p.host === undefined ? undefined : compactHost(p.host),
      storage: compactStorage(p),
      network: compactNetwork(p),
      services: contextCandidates.map(compactCandidate),
      processes: p.processes.slice(0, 20).map((item) => ({
        id: item.id,
        pid: item.pid,
        parentPid: item.parentPid,
        command: item.command.slice(0, 240),
        executablePath: item.executablePath?.slice(0, 240),
        evidenceIds: item.evidenceIds.slice(0, 4),
      })),
      containers: p.containers.slice(0, 8).map((item) => ({
        id: item.id,
        name: item.name,
        image: item.image,
        state: item.state,
        ports: item.ports.slice(0, 4).map((port) => ({
          containerPort: port.containerPort,
          hostAddress: port.hostAddress,
          hostPort: port.hostPort,
          protocol: port.protocol,
        })),
        evidenceIds: item.evidenceIds.slice(0, 4),
      })),
      evidence: p.evidence.slice(0, 20).map((item) => ({
        id: item.id,
        kind: item.kind,
        source: item.source,
        status: item.status,
      })),
      systemd_summary: compactSystemd(p),
      path_candidates: (p.pathSeeds ?? []).slice(0, 10).map((item) => ({
        id: item.id,
        path: item.path,
        confidence: item.confidence,
        sources: item.sources.slice(0, 2).map((source) => ({
          sourceId: source.sourceId,
          sourceType: source.sourceType,
          evidenceIds: source.evidenceIds.slice(0, 3),
        })),
      })),
      findings: p.findings.map((item) => ({
        id: item.id,
        severity: item.severity,
        title: item.title,
        description: item.description,
        evidenceIds: item.evidenceIds,
      })),
      visibility_summary: compactVisibility(p),
    }) as Record<string, unknown>;
    const context = { l0, l1, hash: hashValue({ l0, l1 }) };
    return context;
  }

  private candidateRank(a: DiscoveryCandidate, b: DiscoveryCandidate): number {
    const score = (item: DiscoveryCandidate): number => {
      const service = this.projection.services.find((candidate) => candidate.id === item.serviceId);
      const exposed = service?.socketIds.some((id) =>
        this.projection.sockets.some((socket) => socket.id === id && socket.exposed),
      );
      const abnormal = this.projection.findings.some((finding) =>
        finding.evidenceIds.some((id) => item.evidenceIds.includes(id)),
      );
      return (
        (abnormal ? 8 : 0) +
        (exposed ? 6 : 0) +
        (item.sourceKind === 'mixed' ? 4 : item.sourceKind === 'container' ? 3 : 1) +
        (item.signals.length > 0 ? 2 : 0) +
        (item.unknowns.length > 0 ? 1 : 0)
      );
    };
    return score(b) - score(a) || a.displayName.localeCompare(b.displayName);
  }

  public readSection(section: ContextSection, offset = 0, limit = 50): unknown {
    if (section === 'services')
      return this.rankedCandidates()
        .slice(Math.max(0, offset), Math.max(0, offset) + limit)
        .map(compactCandidate);
    const context = this.build({ stage: 'read', round: 0, budget: {} });
    const value = context.l1[section];
    if (Array.isArray(value)) return value.slice(Math.max(0, offset), Math.max(0, offset) + limit);
    return value ?? null;
  }

  private rankedCandidates(): DiscoveryCandidate[] {
    const candidates =
      this.evidenceIndex?.candidates ??
      this.projection.services.map((service) => ({
        candidateId: service.id,
        displayName: service.displayName ?? service.name,
        sourceKind: 'service' as const,
        sourceIds: [service.id],
        mergeRule: 'projection.service',
        evidenceIds: service.evidenceIds,
        runtimeKind: 'unknown' as const,
        confidence: 'unknown' as const,
        signals: [],
        unknowns: [],
      }));
    return [...candidates].sort((a, b) => this.candidateRank(a, b));
  }

  public readEvidence(ids: readonly string[]): unknown[] {
    const wanted = new Set(ids.slice(0, 20));
    return this.projection.evidence
      .filter((item) => wanted.has(item.id))
      .map((item) =>
        this.redact({
          id: item.id,
          kind: item.kind,
          source: item.source,
          status: item.status,
          collectedAt: item.collectedAt,
          value: summarizeValue(item.value),
          message: item.message,
        }),
      );
  }
}

function compactCandidate(item: DiscoveryCandidate): unknown {
  return {
    id: item.candidateId,
    name: item.displayName,
    sourceKind: item.sourceKind,
    runtimeKind: item.runtimeKind,
    confidence: item.confidence,
    signals: item.signals.slice(0, 3),
    unknowns: item.unknowns.slice(0, 3),
    evidenceIds: item.evidenceIds.slice(0, 4),
  };
}

function compactHost(host: InventoryProjection['host']): unknown {
  if (host === undefined) return null;
  return {
    hostname: host.hostname,
    fqdn: host.fqdn,
    architecture: host.architecture,
    operatingSystem: host.operatingSystem,
    cpu: host.cpu,
    memory: { totalBytes: host.memory.totalBytes, availableBytes: host.memory.availableBytes },
    virtualization: host.virtualization,
  };
}

function compactStorage(projection: InventoryProjection): unknown {
  return {
    disks: (projection.storage?.disks ?? []).slice(0, 40).map((item) => ({
      id: item.id,
      name: item.name,
      path: item.path,
      sizeBytes: item.sizeBytes,
      evidenceIds: item.evidenceIds,
    })),
    mounts: (projection.storage?.mounts ?? []).slice(0, 60).map((item) => ({
      id: item.id,
      source: item.source,
      target: item.target,
      fileSystemType: item.fileSystemType,
      totalBytes: item.totalBytes,
      usedBytes: item.usedBytes,
      evidenceIds: item.evidenceIds,
    })),
  };
}

function compactNetwork(projection: InventoryProjection): unknown {
  return {
    interfaces: (projection.network?.interfaces ?? []).slice(0, 80).map((item) => ({
      id: item.id,
      name: item.name,
      addresses: item.addresses.slice(0, 8),
      mtu: item.mtu,
    })),
    routes: projection.network?.routes ?? [],
    firewall: projection.network?.firewall,
    dns: projection.network?.dns,
  };
}

function compactVisibility(projection: InventoryProjection): unknown {
  const counts = new Map<string, number>();
  for (const item of projection.visibilityDecisions) {
    const key = `${item.objectType}:${item.placement}:${item.resourceClass}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, count]) => ({ key, count }));
}

function compactSystemd(projection: InventoryProjection): unknown {
  const units = projection.systemdUnits;
  return {
    total: units.length,
    active: units.filter((item) => item.activeState === 'active').length,
    failed: units
      .filter((item) => item.activeState === 'failed')
      .map((item) => ({ id: item.id, name: item.name, description: item.description })),
  };
}

function summarizeValue(value: unknown): unknown {
  if (typeof value === 'string') return value.length > 500 ? `${value.slice(0, 500)}...` : value;
  if (Array.isArray(value))
    return { type: 'array', count: value.length, sample: value.slice(0, 10) };
  if (value !== null && typeof value === 'object')
    return { type: 'object', keys: Object.keys(value).slice(0, 30) };
  return value;
}

function redactContext(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactContext);
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (
        /(?:password|passwd|secret|token|private[_-]?key|credential|authorization|cookie|env(?:ironment)?)/i.test(
          key,
        )
      )
        result[key] = '[REDACTED]';
      else result[key] = redactContext(child);
    }
    return result;
  }
  if (typeof value === 'string' && /(password|passwd|secret|token|private[_-]?key)=/i.test(value))
    return '[REDACTED]';
  return value;
}

function hashValue(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
