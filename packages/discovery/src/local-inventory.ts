import { createHash } from 'node:crypto';

import { DeploymentInventorySchema, assertSchema } from '@opsense/schema';
import type {
  DeploymentCandidateSet,
  DeploymentInventory,
  ResourceGraph,
  ScanSnapshot,
} from '@opsense/schema';

export interface LocalInventoryBuildOptions {
  now?: () => Date;
}

export function buildLocalDeploymentInventory(
  snapshot: ScanSnapshot,
  graph: ResourceGraph,
  candidateSet: DeploymentCandidateSet,
  options: LocalInventoryBuildOptions = {},
): DeploymentInventory {
  const sourceEvidenceHash = hash(
    JSON.stringify([...snapshot.evidence].sort((left, right) => left.id.localeCompare(right.id))),
  );
  const services = candidateSet.candidates.map((candidate) => ({
    attribution: {
      name: {
        certainty: 'inferred' as const,
        evidenceIds: candidate.evidenceIds,
        source: 'correlation' as const,
        value: candidate.suggestedName ?? candidate.candidateId,
      },
      role: {
        certainty: 'unknown' as const,
        evidenceIds: candidate.evidenceIds,
        source: 'correlation' as const,
        value: 'needs_review',
      },
    },
    composeProjectIds: candidate.composeProjectIds,
    confidence: 'inferred' as const,
    containerIds: candidate.containerIds,
    deploymentHints: candidate.deploymentHints,
    evidenceIds: candidate.evidenceIds,
    imageNames: candidate.imageNames,
    name: candidate.suggestedName ?? candidate.candidateId,
    pathIds: candidate.pathIds,
    ports: candidate.exposedPorts,
    processIds: candidate.processIds,
    role: 'needs_review' as const,
    reviewItems: ['AI semantic discovery has not been completed.'],
    serviceId: stableId('service', candidate.sourceObjectIds.join('|')),
    socketIds: candidate.socketIds,
    sourceCandidateIds: [candidate.candidateId],
    sourceObjectIds: candidate.sourceObjectIds,
    unitIds: candidate.unitIds,
    unknownFields: candidate.unresolvedFields,
  }));
  const rawObjectCount = graph.nodes.filter((node) => node.kind !== 'host').length;
  const filteredObjectCount = candidateSet.filteredGroups.reduce(
    (total, group) => total + group.objectCount,
    0,
  );
  const inventory: DeploymentInventory = {
    coverage: {
      candidateCount: candidateSet.candidates.length,
      filteredObjectCount,
      protectedObjectCount: new Set(
        candidateSet.candidates.flatMap((candidate) => candidate.sourceObjectIds),
      ).size,
      rawObjectCount,
    },
    exposedPorts: uniquePorts(services.flatMap((service) => service.ports)),
    filteredGroups: candidateSet.filteredGroups,
    findings: snapshot.findings,
    filteredCandidateIds: [],
    generatedAt: (options.now ?? (() => new Date()))().toISOString(),
    host: {
      hostname: snapshot.host?.hostname ?? snapshot.session.target.host,
      operatingSystem: snapshot.host?.operatingSystem.prettyName ?? 'unknown',
    },
    inventoryId: stableId('inventory', `${snapshot.session.id}|${sourceEvidenceHash}`),
    schemaVersion: '3.0',
    semanticStatus: 'unverified',
    services,
    sourceEvidenceHash,
    sourceScanId: snapshot.session.id,
    unresolvedQuestions: services.flatMap((service) =>
      service.unknownFields.map((field) => `${service.name}: ${field}`),
    ),
  };
  assertSchema(DeploymentInventorySchema, inventory);
  return inventory;
}

function uniquePorts<T>(ports: readonly T[]): T[] {
  return [...new Map(ports.map((port) => [JSON.stringify(port), port])).values()];
}

function stableId(prefix: string, value: string): string {
  return `${prefix}:${hash(value).slice(0, 20)}`;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
