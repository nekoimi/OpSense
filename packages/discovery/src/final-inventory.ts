import { createHash } from 'node:crypto';

import { DeploymentInventorySchema, assertSchema } from '@opsense/schema';
import type {
  BatchDiscoveryArtifact,
  DeploymentCandidate,
  DeploymentCandidateSet,
  DeploymentInventory,
  ResourceGraph,
  ScanSnapshot,
} from '@opsense/schema';

export function buildFinalDeploymentInventory(
  snapshot: ScanSnapshot,
  graph: ResourceGraph,
  candidateSet: DeploymentCandidateSet,
  discovery: BatchDiscoveryArtifact,
  options: { now?: () => Date } = {},
): DeploymentInventory {
  if (discovery.decision.sourceCandidateSetHash.length === 0 || !discovery.completion.complete) {
    throw new Error('Cannot finalize an incomplete Batch Discovery result.');
  }
  const candidates = new Map(
    candidateSet.candidates.map((candidate) => [candidate.candidateId, candidate]),
  );
  const services = discovery.decision.services.map((draft) => {
    const sources = draft.sourceCandidateIds.map((id) => {
      const candidate = candidates.get(id);
      if (candidate === undefined)
        throw new Error(`Discovery service references unknown candidate '${id}'.`);
      return candidate;
    });
    const evidenceIds = unique([
      ...draft.evidenceIds,
      ...sources.flatMap((candidate) => candidate.evidenceIds),
    ]);
    const sourceObjectIds = unique(sources.flatMap((candidate) => candidate.sourceObjectIds));
    return {
      attribution: {
        name: attributed(draft.name, 'inferred', 'codex', draft.evidenceIds),
        ...(draft.purpose === undefined
          ? {}
          : { purpose: attributed(draft.purpose, draft.confidence, 'codex', draft.evidenceIds) }),
        role: attributed(draft.role, draft.confidence, 'codex', draft.evidenceIds),
      },
      composeProjectIds: unique(sources.flatMap((candidate) => candidate.composeProjectIds)),
      confidence: draft.confidence,
      containerIds: unique(sources.flatMap((candidate) => candidate.containerIds)),
      deploymentHints: unique(sources.flatMap((candidate) => candidate.deploymentHints)),
      evidenceIds,
      imageNames: unique(sources.flatMap((candidate) => candidate.imageNames)),
      name: draft.name,
      pathIds: unique(sources.flatMap((candidate) => candidate.pathIds)),
      ports: uniqueBy(
        sources.flatMap((candidate) => candidate.exposedPorts),
        (item) => JSON.stringify(item),
      ),
      processIds: unique(sources.flatMap((candidate) => candidate.processIds)),
      ...(draft.purpose === undefined ? {} : { purpose: draft.purpose }),
      reviewItems: draft.reviewItems,
      role: draft.role,
      serviceId: stableId('service', sourceObjectIds.sort().join('|')),
      socketIds: unique(sources.flatMap((candidate) => candidate.socketIds)),
      sourceCandidateIds: draft.sourceCandidateIds,
      sourceObjectIds,
      unitIds: unique(sources.flatMap((candidate) => candidate.unitIds)),
      unknownFields: draft.unknownFields,
    };
  });
  const retainedUnknowns = discovery.decision.retainedUnknownCandidateIds.map((id) => {
    const candidate = candidates.get(id);
    if (candidate === undefined) throw new Error(`Unknown retained candidate '${id}'.`);
    return serviceFromUnknownCandidate(candidate);
  });
  const allServices = [...services, ...retainedUnknowns].sort((left, right) =>
    left.serviceId.localeCompare(right.serviceId),
  );
  const sourceEvidenceHash = hash(
    JSON.stringify([...snapshot.evidence].sort((left, right) => left.id.localeCompare(right.id))),
  );
  const unresolvedQuestions = unique([
    ...discovery.decision.unresolvedQuestions,
    ...allServices.flatMap((service) =>
      service.unknownFields.map((field) => `${service.name}: ${field}`),
    ),
    ...discovery.decision.filteredCandidateIds.flatMap((id) => {
      const candidate = candidates.get(id);
      return candidate?.exposedPorts.some((port) => port.exposed) === true
        ? [`Filtered candidate ${id} owns an exposed port and requires review.`]
        : [];
    }),
  ]);
  const rawObjectCount = graph.nodes.filter((node) => node.kind !== 'host').length;
  const filteredObjectCount = candidateSet.filteredGroups.reduce(
    (total, group) => total + group.objectCount,
    0,
  );
  const semanticStatus =
    discovery.run.status === 'degraded'
      ? ('unverified' as const)
      : retainedUnknowns.length > 0 ||
          unresolvedQuestions.length > 0 ||
          allServices.some((service) => service.role === 'needs_review')
        ? ('partially_verified' as const)
        : ('verified' as const);
  const contentHash = hash(
    JSON.stringify({
      filteredCandidateIds: discovery.decision.filteredCandidateIds,
      services: allServices,
      sourceEvidenceHash,
      sourceScanId: snapshot.session.id,
    }),
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
    exposedPorts: uniqueBy(
      allServices.flatMap((service) => service.ports),
      (item) => JSON.stringify(item),
    ),
    filteredCandidateIds: discovery.decision.filteredCandidateIds,
    filteredGroups: candidateSet.filteredGroups,
    findings: snapshot.findings,
    generatedAt: (options.now ?? (() => new Date()))().toISOString(),
    host: {
      hostname: snapshot.host?.hostname ?? snapshot.session.target.host,
      operatingSystem: snapshot.host?.operatingSystem.prettyName ?? 'unknown',
    },
    inventoryId: stableId('inventory', `${snapshot.session.id}|${contentHash}`),
    schemaVersion: '3.0',
    semanticStatus,
    services: allServices,
    sourceDecisionId: discovery.decision.decisionId,
    sourceEvidenceHash,
    sourceScanId: snapshot.session.id,
    unresolvedQuestions,
  };
  assertSchema(DeploymentInventorySchema, inventory);
  return inventory;
}

function serviceFromUnknownCandidate(candidate: DeploymentCandidate) {
  const name = candidate.suggestedName ?? candidate.candidateId;
  return {
    attribution: {
      name: attributed(name, 'inferred' as const, 'correlation' as const, candidate.evidenceIds),
      role: attributed(
        'needs_review',
        'unknown' as const,
        'correlation' as const,
        candidate.evidenceIds,
      ),
    },
    composeProjectIds: candidate.composeProjectIds,
    confidence: 'unknown' as const,
    containerIds: candidate.containerIds,
    deploymentHints: candidate.deploymentHints,
    evidenceIds: candidate.evidenceIds,
    imageNames: candidate.imageNames,
    name,
    pathIds: candidate.pathIds,
    ports: candidate.exposedPorts,
    processIds: candidate.processIds,
    reviewItems: [
      'Batch Discovery retained this candidate because semantic evidence was insufficient.',
    ],
    role: 'needs_review' as const,
    serviceId: stableId('service', [...candidate.sourceObjectIds].sort().join('|')),
    socketIds: candidate.socketIds,
    sourceCandidateIds: [candidate.candidateId],
    sourceObjectIds: candidate.sourceObjectIds,
    unitIds: candidate.unitIds,
    unknownFields: candidate.unresolvedFields,
  };
}

function attributed(
  value: string,
  certainty: 'confirmed' | 'inferred' | 'unknown',
  source: 'collector' | 'correlation' | 'codex' | 'human',
  evidenceIds: readonly string[],
) {
  return { certainty, evidenceIds: unique(evidenceIds), source, value };
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)].sort((left, right) => String(left).localeCompare(String(right)));
}

function uniqueBy<T>(values: readonly T[], key: (value: T) => string): T[] {
  return [...new Map(values.map((value) => [key(value), value])).values()];
}

function stableId(prefix: string, value: string): string {
  return `${prefix}:${hash(value).slice(0, 20)}`;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
