import { createHash } from 'node:crypto';

import { BatchDiscoveryInputSchema, assertSchema } from '@opsense/schema';
import type {
  BatchDiscoveryCandidate,
  BatchDiscoveryInput,
  DeploymentCandidate,
  DeploymentCandidateSet,
  PipelineBudgets,
  ResourceGraph,
  ResourceNode,
  ScanSnapshot,
} from '@opsense/schema';

const ALLOWED_PROBE_KINDS = [
  'directory_metadata',
  'directory_listing',
  'config_summary',
  'path_search',
  'systemd_unit',
  'process_runtime',
  'process_cgroup',
  'socket_ownership',
  'container_inspect',
  'compose_metadata',
  'log_metadata',
] as const;

export function candidateSetHash(candidateSet: DeploymentCandidateSet): string {
  return createHash('sha256').update(JSON.stringify(candidateSet)).digest('hex');
}

export function buildBatchDiscoveryInput(
  snapshot: ScanSnapshot,
  graph: ResourceGraph,
  candidateSet: DeploymentCandidateSet,
  budgets: Pick<PipelineBudgets, 'maxProbeRequests' | 'maxProbeRounds'>,
): BatchDiscoveryInput {
  const nodesByResourceId = new Map(graph.nodes.map((node) => [node.resourceId, node]));
  const nodesBySourceId = new Map(graph.nodes.map((node) => [node.sourceObjectId, node]));
  const candidates = candidateSet.candidates.map((candidate) =>
    compactCandidate(candidate, nodesByResourceId, nodesBySourceId),
  );
  const visibleEvidenceIds = new Set(candidates.flatMap((candidate) => candidate.evidenceIds));
  const input: BatchDiscoveryInput = {
    candidates,
    contractVersion: 'batch-discovery-v1',
    evidenceIndex: snapshot.evidence
      .filter((evidence) => visibleEvidenceIds.has(evidence.id))
      .map((evidence) => ({
        id: evidence.id,
        kind: evidence.kind,
        source: evidence.source,
        status: evidence.status,
        ...(evidence.field === undefined ? {} : { field: evidence.field }),
      })),
    filteredGroups: candidateSet.filteredGroups.map((group) => ({
      category: group.category,
      groupId: group.groupId,
      objectCount: group.objectCount,
      reason: group.reason,
      sampleNames: group.sampleNames.slice(0, 10),
    })),
    host: {
      architecture: snapshot.host?.architecture ?? 'unknown',
      hostname: snapshot.host?.hostname ?? snapshot.session.target.host,
      operatingSystem: snapshot.host?.operatingSystem.prettyName ?? 'unknown',
    },
    probePolicy: {
      allowedKinds: [...ALLOWED_PROBE_KINDS],
      maxRequests: budgets.maxProbeRequests,
      maxRounds: budgets.maxProbeRounds,
    },
    sourceCandidateSetHash: candidateSetHash(candidateSet),
    sourceScanId: candidateSet.sourceScanId,
  };
  assertSchema(BatchDiscoveryInputSchema, input);
  return input;
}

function compactCandidate(
  candidate: DeploymentCandidate,
  nodesByResourceId: ReadonlyMap<string, ResourceNode>,
  nodesBySourceId: ReadonlyMap<string, ResourceNode>,
): BatchDiscoveryCandidate {
  const units = resources(candidate.unitIds, nodesBySourceId, [
    'activeState',
    'enabledState',
    'fragmentPath',
    'mainPid',
    'workingDirectory',
  ]);
  const processes = resources(candidate.processIds, nodesBySourceId, [
    'command',
    'executablePath',
    'pid',
    'workingDirectory',
  ]);
  const containers = resources(candidate.containerIds, nodesBySourceId, [
    'image',
    'processId',
    'state',
  ]);
  const composeProjects = resources(candidate.composeProjectIds, nodesBySourceId, [
    'configFiles',
    'workingDirectory',
  ]);
  const paths = resources(candidate.pathIds, nodesByResourceId, ['classification', 'path']);
  return {
    candidateId: candidate.candidateId,
    composeProjects: composeProjects.slice(0, 4),
    containers: containers.slice(0, 4),
    deploymentHints: candidate.deploymentHints,
    evidenceIds: candidate.evidenceIds.slice(0, 12),
    imageNames: candidate.imageNames.slice(0, 4),
    paths: paths.slice(0, 12),
    ports: candidate.exposedPorts.slice(0, 8),
    processes: processes.slice(0, 4),
    protectionSignals: candidate.protectionSignals,
    sourceObjectIds: candidate.sourceObjectIds,
    ...(candidate.suggestedName === undefined ? {} : { suggestedName: candidate.suggestedName }),
    totals: {
      composeProjects: candidate.composeProjectIds.length,
      containers: candidate.containerIds.length,
      evidence: candidate.evidenceIds.length,
      paths: candidate.pathIds.length,
      ports: candidate.exposedPorts.length,
      processes: candidate.processIds.length,
      units: candidate.unitIds.length,
    },
    units: units.slice(0, 4),
    unresolvedFields: candidate.unresolvedFields,
  };
}

function resources(
  ids: readonly string[],
  nodes: ReadonlyMap<string, ResourceNode>,
  attributeNames: readonly string[],
): BatchDiscoveryCandidate['units'] {
  return ids.flatMap((id) => {
    const node = nodes.get(id);
    if (node === undefined) return [];
    const attributes = Object.fromEntries(
      attributeNames.flatMap((name) =>
        node.attributes[name] === undefined ? [] : [[name, node.attributes[name]]],
      ),
    );
    return [{ attributes, id: node.sourceObjectId, name: node.name }];
  });
}
