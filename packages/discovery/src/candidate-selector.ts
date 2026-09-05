import { createHash } from 'node:crypto';

import { DeploymentCandidateSetSchema, assertSchema } from '@opsense/schema';
import type {
  DeploymentCandidate,
  DeploymentCandidateSet,
  DeploymentHint,
  FilteredEvidenceGroup,
  PortSummary,
  ProtectionSignal,
  ResourceGraph,
  ResourceNode,
  ScanSnapshot,
} from '@opsense/schema';

const CUSTOM_PATH_PATTERN = /^\/(?:app|apps|data|home|opt|srv|usr\/local)(?:\/|$)/;
const CUSTOM_UNIT_PATTERN = /^\/(?:etc|usr\/local\/lib)\/systemd\/system(?:\/|$)/;

export interface CandidateSelectionOptions {
  now?: () => Date;
}

export function selectDeploymentCandidates(
  graph: ResourceGraph,
  snapshot: ScanSnapshot,
  options: CandidateSelectionOptions = {},
): DeploymentCandidateSet {
  const nodesById = new Map(graph.nodes.map((node) => [node.resourceId, node]));
  const candidates: DeploymentCandidate[] = [];
  const filtered = new Map<FilteredEvidenceGroup['category'], ResourceNode[]>();

  for (const component of graph.components) {
    const nodes = component.resourceIds.flatMap((id) => {
      const found = nodesById.get(id);
      return found === undefined ? [] : [found];
    });
    if (!nodes.some(isDeploymentResource)) continue;
    const expanded = expandComponent(nodes, graph, nodesById);
    const signals = protectionSignals(expanded, snapshot);
    if (signals.length > 0) {
      candidates.push(candidateFromNodes(expanded, signals));
    } else {
      for (const node of nodes.filter(isDeploymentResource)) {
        const category = filteredCategory(node);
        filtered.set(category, [...(filtered.get(category) ?? []), node]);
      }
    }
  }

  const candidateSet: DeploymentCandidateSet = {
    candidates: candidates.sort((left, right) => left.candidateId.localeCompare(right.candidateId)),
    filteredGroups: [...filtered.entries()]
      .map(([category, nodes]) => filteredGroup(category, nodes))
      .sort((left, right) => left.groupId.localeCompare(right.groupId)),
    generatedAt: (options.now ?? (() => new Date()))().toISOString(),
    graphId: graph.graphId,
    schemaVersion: '3.0',
    sourceScanId: graph.sourceScanId,
  };
  assertSchema(DeploymentCandidateSetSchema, candidateSet);
  return candidateSet;
}

function expandComponent(
  nodes: readonly ResourceNode[],
  graph: ResourceGraph,
  nodesById: ReadonlyMap<string, ResourceNode>,
): ResourceNode[] {
  const baseIds = new Set(nodes.map((node) => node.resourceId));
  const ids = new Set(baseIds);
  for (const edge of graph.edges) {
    if (edge.kind === 'path_on_mount' && (baseIds.has(edge.fromId) || baseIds.has(edge.toId))) {
      ids.add(edge.fromId);
      ids.add(edge.toId);
    }
  }
  return [...ids]
    .flatMap((id) => {
      const node = nodesById.get(id);
      return node === undefined ? [] : [node];
    })
    .sort((left, right) => left.resourceId.localeCompare(right.resourceId));
}

function candidateFromNodes(
  nodes: readonly ResourceNode[],
  protectionSignalsValue: ProtectionSignal[],
): DeploymentCandidate {
  const byKind = (kind: ResourceNode['kind']) => nodes.filter((node) => node.kind === kind);
  const units = byKind('systemd_unit');
  const processes = byKind('process');
  const sockets = byKind('socket');
  const containers = byKind('container');
  const projects = byKind('compose_project');
  const paths = byKind('path');
  const sourceObjectIds = unique(
    nodes.filter(isDeploymentResource).map((node) => node.sourceObjectId),
  ).sort();
  const name = suggestedName(projects, containers, units, processes);
  return {
    candidateId: stableId('candidate', sourceObjectIds.join('|')),
    composeProjectIds: projects.map((node) => node.sourceObjectId),
    containerIds: containers.map((node) => node.sourceObjectId),
    deploymentHints: deploymentHints(nodes),
    evidenceIds: unique(nodes.flatMap((node) => node.evidenceIds)).sort(),
    exposedPorts: portsForNodes(sockets, containers),
    imageNames: unique(containers.flatMap((node) => stringAttribute(node, 'image'))),
    pathIds: paths.map((node) => node.resourceId).sort(),
    processIds: processes.map((node) => node.sourceObjectId).sort(),
    protectionSignals: unique(protectionSignalsValue),
    socketIds: sockets.map((node) => node.sourceObjectId).sort(),
    sourceObjectIds,
    ...(name === undefined ? {} : { suggestedName: name }),
    unitIds: units.map((node) => node.sourceObjectId).sort(),
    unresolvedFields: ['role', 'purpose'],
  };
}

function protectionSignals(
  nodes: readonly ResourceNode[],
  snapshot: ScanSnapshot,
): ProtectionSignal[] {
  const signals: ProtectionSignal[] = [];
  if (nodes.some((node) => node.kind === 'container')) signals.push('docker_deployment');
  if (nodes.some((node) => node.kind === 'compose_project')) signals.push('compose_deployment');
  if (nodes.some((node) => node.kind === 'socket' && node.attributes.exposed === true)) {
    signals.push('exposed_socket');
  }
  if (nodes.some((node) => node.kind === 'socket' && node.attributes.listening === true)) {
    signals.push('listening_process');
  }
  if (
    nodes.some((node) => node.kind === 'systemd_unit' && node.attributes.activeState === 'failed')
  ) {
    signals.push('failed_unit');
  }
  if (
    nodes.some(
      (node) =>
        node.kind === 'systemd_unit' &&
        CUSTOM_UNIT_PATTERN.test(stringAttribute(node, 'fragmentPath')[0] ?? ''),
    )
  ) {
    signals.push('custom_systemd_unit');
  }
  if (
    nodes.some((node) => node.kind === 'path' && CUSTOM_PATH_PATTERN.test(node.name)) ||
    nodes.some(
      (node) =>
        node.kind === 'process' &&
        [
          ...stringAttribute(node, 'executablePath'),
          ...stringAttribute(node, 'workingDirectory'),
        ].some((value) => CUSTOM_PATH_PATTERN.test(value)),
    )
  ) {
    signals.push('custom_service_path');
  }
  if (
    nodes.some((node) => node.kind === 'mount' && /(?:data|log|backup|archive)/i.test(node.name))
  ) {
    signals.push('service_storage');
  }
  const sourceIds = new Set(nodes.map((node) => node.sourceObjectId));
  if (
    snapshot.services.some(
      (service) =>
        (service.conflictFields?.length ?? 0) > 0 &&
        [...service.systemdUnitIds, ...service.containerIds, ...service.composeProjectIds].some(
          (id) => sourceIds.has(id),
        ),
    )
  ) {
    signals.push('evidence_conflict');
  }
  return unique(signals);
}

function deploymentHints(nodes: readonly ResourceNode[]): DeploymentHint[] {
  const hints: DeploymentHint[] = [];
  if (nodes.some((node) => node.kind === 'systemd_unit')) hints.push('systemd');
  if (nodes.some((node) => node.kind === 'process')) hints.push('process');
  if (nodes.some((node) => node.kind === 'container')) hints.push('docker');
  if (nodes.some((node) => node.kind === 'compose_project')) hints.push('compose');
  return hints;
}

function portsForNodes(
  sockets: readonly ResourceNode[],
  containers: readonly ResourceNode[],
): PortSummary[] {
  const ports: PortSummary[] = sockets.flatMap((node) => {
    const hostPort = numberAttribute(node, 'localPort');
    const protocol = node.attributes.protocol;
    if (hostPort === undefined || (protocol !== 'tcp' && protocol !== 'udp')) return [];
    const address = stringAttribute(node, 'localAddress')[0];
    return [
      {
        ...(address === undefined ? {} : { address }),
        exposed: node.attributes.exposed === true,
        hostPort,
        protocol,
      },
    ];
  });
  for (const node of containers) {
    const mappings = node.attributes.ports;
    if (!Array.isArray(mappings)) continue;
    for (const mappingValue of mappings) {
      if (mappingValue === null || typeof mappingValue !== 'object') continue;
      const mapping = mappingValue as Record<string, unknown>;
      if (
        typeof mapping.hostPort === 'number' &&
        typeof mapping.containerPort === 'number' &&
        (mapping.protocol === 'tcp' || mapping.protocol === 'udp')
      ) {
        ports.push({
          ...(typeof mapping.hostAddress === 'string' ? { address: mapping.hostAddress } : {}),
          containerPort: mapping.containerPort,
          exposed: mapping.hostAddress !== '127.0.0.1' && mapping.hostAddress !== '::1',
          hostPort: mapping.hostPort,
          protocol: mapping.protocol,
        });
      }
    }
  }
  return uniqueBy(ports, (port) => JSON.stringify(port));
}

function filteredGroup(
  category: FilteredEvidenceGroup['category'],
  nodes: readonly ResourceNode[],
): FilteredEvidenceGroup {
  const sourceObjectIds = unique(nodes.map((node) => node.sourceObjectId)).sort();
  return {
    category,
    evidenceIds: unique(nodes.flatMap((node) => node.evidenceIds)),
    groupId: stableId('filtered-group', `${category}|${sourceObjectIds.join('|')}`),
    objectCount: sourceObjectIds.length,
    reason: filteredReason(category),
    sampleNames: unique(nodes.map((node) => node.name)).slice(0, 10),
    sourceObjectIds,
  };
}

function filteredCategory(node: ResourceNode): FilteredEvidenceGroup['category'] {
  if (node.kind === 'systemd_unit' && node.attributes.activeState !== 'active') {
    return 'inactive_unit';
  }
  if (node.kind === 'process' && /^\[.*]$/.test(String(node.attributes.command ?? ''))) {
    return 'kernel_helper';
  }
  if (node.kind === 'process' && node.attributes.parentPid === 1) return 'boot_helper';
  return node.kind === 'process' ? 'runtime_internal' : 'routine_system_service';
}

function filteredReason(category: FilteredEvidenceGroup['category']): string {
  const reasons: Record<FilteredEvidenceGroup['category'], string> = {
    boot_helper: 'Process is a boot-time helper without an independent deployment signal.',
    inactive_unit: 'Unit is inactive and has no custom path, exposed port, or conflict signal.',
    kernel_helper: 'Kernel helper has no user deployment signal.',
    routine_system_service: 'Routine system service has no high-value deployment signal.',
    runtime_internal: 'Runtime process has no listener, container, custom path, or failed state.',
  };
  return reasons[category];
}

function suggestedName(
  projects: readonly ResourceNode[],
  containers: readonly ResourceNode[],
  units: readonly ResourceNode[],
  processes: readonly ResourceNode[],
): string | undefined {
  return (
    projects[0]?.name ??
    containers[0]?.name ??
    units[0]?.name.replace(/\.service$/i, '') ??
    processes[0]?.name
  );
}

function isDeploymentResource(node: ResourceNode): boolean {
  return ['systemd_unit', 'process', 'socket', 'container', 'compose_project'].includes(node.kind);
}

function stringAttribute(node: ResourceNode, key: string): string[] {
  const value = node.attributes[key];
  return typeof value === 'string' && value.length > 0 ? [value] : [];
}

function numberAttribute(node: ResourceNode, key: string): number | undefined {
  const value = node.attributes[key];
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function uniqueBy<T>(values: readonly T[], key: (value: T) => string): T[] {
  return [...new Map(values.map((value) => [key(value), value])).values()];
}

function stableId(prefix: string, value: string): string {
  return `${prefix}:${createHash('sha256').update(value).digest('hex').slice(0, 20)}`;
}
