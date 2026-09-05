import { createHash } from 'node:crypto';
import path from 'node:path';

import { ResourceGraphSchema, assertSchema } from '@opsense/schema';
import type {
  PathSeedRecord,
  ResourceEdge,
  ResourceEdgeKind,
  ResourceGraph,
  ResourceNode,
  ScanSnapshot,
  SystemdUnitRecord,
} from '@opsense/schema';

const STRONG_EDGE_KINDS = new Set<ResourceEdgeKind>([
  'unit_main_process',
  'process_socket',
  'process_cgroup_unit',
  'process_container',
  'container_compose_service',
  'container_publishes_port',
  'container_mounts_path',
  'unit_references_path',
  'process_references_path',
]);

export interface ResourceGraphBuildOptions {
  now?: () => Date;
}

export function buildResourceGraph(
  snapshot: ScanSnapshot,
  options: ResourceGraphBuildOptions = {},
): ResourceGraph {
  const nodes = buildNodes(snapshot);
  const nodeIds = new Set(nodes.map((node) => node.resourceId));
  const edges = buildEdges(snapshot).filter(
    (edge) => nodeIds.has(edge.fromId) && nodeIds.has(edge.toId),
  );
  const graph: ResourceGraph = {
    components: connectedComponents(nodes, edges),
    edges,
    generatedAt: (options.now ?? (() => new Date()))().toISOString(),
    graphId: stableId('resource-graph', snapshot.session.id),
    nodes,
    schemaVersion: '3.0',
    sourceScanId: snapshot.session.id,
  };
  assertSchema(ResourceGraphSchema, graph);
  return graph;
}

function buildNodes(snapshot: ScanSnapshot): ResourceNode[] {
  const hostNodes: ResourceNode[] =
    snapshot.host === undefined
      ? []
      : [
          node(
            stableId('host', snapshot.host.hostname),
            'host',
            snapshot.host.hostname,
            stableId('host-source', snapshot.host.hostname),
            [],
            { architecture: snapshot.host.architecture },
          ),
        ];
  const unitNodes = snapshot.systemdUnits.map((unit) =>
    node(unit.id, 'systemd_unit', unit.name, unit.id, unit.evidenceIds, {
      activeState: unit.activeState,
      enabledState: unit.enabledState,
      fragmentPath: unit.fragmentPath,
      mainPid: unit.mainPid,
      workingDirectory: unit.workingDirectory,
    }),
  );
  const processNodes = snapshot.processes.map((process) =>
    node(process.id, 'process', processName(process.command), process.id, process.evidenceIds, {
      cgroup: process.cgroup,
      command: process.command,
      containerId: process.containerId,
      executablePath: process.executablePath,
      parentPid: process.parentPid,
      pid: process.pid,
      workingDirectory: process.workingDirectory,
    }),
  );
  const socketNodes = snapshot.sockets.map((socket) =>
    node(
      socket.id,
      'socket',
      `${socket.protocol}:${socket.localPort}`,
      socket.id,
      socket.evidenceIds,
      {
        exposed: socket.exposed,
        listening: socket.listening,
        localAddress: socket.localAddress,
        localPort: socket.localPort,
        protocol: socket.protocol,
      },
    ),
  );
  const containerNodes = snapshot.containers.map((container) =>
    node(container.id, 'container', container.name, container.id, container.evidenceIds, {
      image: container.image,
      ports: container.ports,
      processId: container.processId,
      state: container.state,
    }),
  );
  const composeNodes = snapshot.composeProjects.map((project) =>
    node(project.id, 'compose_project', project.name, project.id, project.evidenceIds, {
      configFiles: project.configFiles,
      workingDirectory: project.workingDirectory,
    }),
  );
  const mountNodes = (snapshot.storage?.mounts ?? []).map((mount) =>
    node(mount.id, 'mount', mount.target, mount.id, mount.evidenceIds, {
      fileSystemType: mount.fileSystemType,
      network: mount.network,
      source: mount.source,
      target: mount.target,
    }),
  );
  const pathNodes = pathNodesForSnapshot(snapshot);
  return [
    ...hostNodes,
    ...unitNodes,
    ...processNodes,
    ...socketNodes,
    ...containerNodes,
    ...composeNodes,
    ...mountNodes,
    ...pathNodes,
  ].sort((left, right) => left.resourceId.localeCompare(right.resourceId));
}

function pathNodesForSnapshot(snapshot: ScanSnapshot): ResourceNode[] {
  const byPath = new Map<
    string,
    { classification: string; evidenceIds: Set<string>; sourceObjectId: string }
  >();
  for (const seed of snapshot.pathSeeds ?? []) {
    byPath.set(seed.path, {
      classification: classifyPath(seed.path, seed),
      evidenceIds: new Set(seed.sources.flatMap((source) => source.evidenceIds)),
      sourceObjectId: seed.id,
    });
  }
  for (const artifact of snapshot.artifacts) {
    const existing = byPath.get(artifact.path);
    if (existing === undefined) {
      byPath.set(artifact.path, {
        classification: classifyPath(artifact.path),
        evidenceIds: new Set(artifact.evidenceIds),
        sourceObjectId: artifact.id,
      });
    } else {
      artifact.evidenceIds.forEach((id) => existing.evidenceIds.add(id));
    }
  }
  return [...byPath.entries()].map(([pathValue, value]) =>
    node(
      pathResourceId(pathValue),
      'path',
      pathValue,
      value.sourceObjectId,
      [...value.evidenceIds],
      { classification: value.classification, path: pathValue },
    ),
  );
}

function buildEdges(snapshot: ScanSnapshot): ResourceEdge[] {
  const edges: ResourceEdge[] = [];
  const processesByPid = new Map(snapshot.processes.map((process) => [process.pid, process]));
  const unitsByName = new Map(snapshot.systemdUnits.map((unit) => [unit.name, unit]));
  const containersByRawId = new Map(
    snapshot.containers.map((container) => [rawContainerId(container.id), container]),
  );
  const pathSeeds = snapshot.pathSeeds ?? [];

  for (const unit of snapshot.systemdUnits) {
    const process = unit.mainPid === undefined ? undefined : processesByPid.get(unit.mainPid);
    if (process !== undefined) {
      edges.push(
        edge('unit_main_process', unit.id, process.id, 'systemd-main-pid-v1', [
          ...unit.evidenceIds,
          ...process.evidenceIds,
        ]),
      );
    }
  }
  for (const process of snapshot.processes) {
    const parent =
      process.parentPid === undefined ? undefined : processesByPid.get(process.parentPid);
    if (parent !== undefined) {
      edges.push(
        edge(
          'process_parent',
          parent.id,
          process.id,
          'process-ppid-v1',
          [...parent.evidenceIds, ...process.evidenceIds],
          'inferred',
        ),
      );
    }
    const cgroupUnit = findCgroupUnit(process.cgroup, unitsByName);
    if (cgroupUnit !== undefined) {
      edges.push(
        edge('process_cgroup_unit', process.id, cgroupUnit.id, 'systemd-cgroup-v1', [
          ...process.evidenceIds,
          ...cgroupUnit.evidenceIds,
        ]),
      );
    }
    const container = findProcessContainer(process.containerId, process.cgroup, containersByRawId);
    if (container !== undefined) {
      edges.push(
        edge('process_container', process.id, container.id, 'container-cgroup-v1', [
          ...process.evidenceIds,
          ...container.evidenceIds,
        ]),
      );
    }
  }
  for (const socket of snapshot.sockets) {
    for (const pid of socket.processIds) {
      const process = processesByPid.get(pid);
      if (process !== undefined) {
        edges.push(
          edge('process_socket', process.id, socket.id, 'socket-owner-pid-v1', [
            ...process.evidenceIds,
            ...socket.evidenceIds,
          ]),
        );
      }
    }
    for (const containerId of socket.containerIds) {
      edges.push(
        edge(
          'container_publishes_port',
          containerId,
          socket.id,
          'socket-container-association-v1',
          socket.evidenceIds,
        ),
      );
    }
  }
  for (const container of snapshot.containers) {
    const initProcess =
      container.processId === undefined ? undefined : processesByPid.get(container.processId);
    if (initProcess !== undefined) {
      edges.push(
        edge('process_container', initProcess.id, container.id, 'container-init-pid-v1', [
          ...initProcess.evidenceIds,
          ...container.evidenceIds,
        ]),
      );
    }
    for (const mapping of container.ports) {
      if (mapping.hostPort === undefined) continue;
      for (const socket of snapshot.sockets.filter(
        (item) => item.protocol === mapping.protocol && item.localPort === mapping.hostPort,
      )) {
        edges.push(
          edge('container_publishes_port', container.id, socket.id, 'docker-published-port-v1', [
            ...container.evidenceIds,
            ...socket.evidenceIds,
          ]),
        );
      }
    }
    for (const mount of container.mounts) {
      if (mount.source === undefined || !mount.source.startsWith('/')) continue;
      edges.push(
        edge(
          'container_mounts_path',
          container.id,
          pathResourceId(mount.source),
          'docker-mount-source-v1',
          container.evidenceIds,
        ),
      );
    }
  }
  for (const project of snapshot.composeProjects) {
    for (const service of project.services) {
      for (const containerId of service.containerIds) {
        edges.push(
          edge(
            'container_compose_service',
            containerId,
            project.id,
            'compose-project-label-v1',
            project.evidenceIds,
          ),
        );
      }
    }
  }
  for (const seed of pathSeeds) addPathReferenceEdges(edges, seed);
  for (const seed of pathSeeds) {
    const mount = longestContainingMount(seed.path, snapshot.storage?.mounts ?? []);
    if (mount !== undefined) {
      edges.push(
        edge(
          'path_on_mount',
          pathResourceId(seed.path),
          mount.id,
          'mount-prefix-v1',
          [...seed.sources.flatMap((source) => source.evidenceIds), ...mount.evidenceIds],
          'inferred',
        ),
      );
    }
  }
  return uniqueEdges(edges).sort((left, right) => left.edgeId.localeCompare(right.edgeId));
}

function addPathReferenceEdges(edges: ResourceEdge[], seed: PathSeedRecord): void {
  for (const source of seed.sources) {
    const kind = source.sourceType.startsWith('systemd.')
      ? 'unit_references_path'
      : source.sourceType.startsWith('process.')
        ? 'process_references_path'
        : source.sourceType.startsWith('docker.mount.')
          ? 'container_mounts_path'
          : undefined;
    if (kind !== undefined) {
      edges.push(
        edge(kind, source.sourceId, pathResourceId(seed.path), `${source.sourceType}-v1`, [
          ...source.evidenceIds,
        ]),
      );
    }
  }
}

function connectedComponents(nodes: ResourceNode[], edges: ResourceEdge[]) {
  const parents = new Map(nodes.map((node) => [node.resourceId, node.resourceId]));
  const find = (id: string): string => {
    const parent = parents.get(id) ?? id;
    if (parent === id) return id;
    const root = find(parent);
    parents.set(id, root);
    return root;
  };
  const union = (left: string, right: string): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parents.set(rightRoot, leftRoot);
  };
  for (const item of edges) if (STRONG_EDGE_KINDS.has(item.kind)) union(item.fromId, item.toId);
  const groups = new Map<string, string[]>();
  for (const nodeValue of nodes) {
    const root = find(nodeValue.resourceId);
    groups.set(root, [...(groups.get(root) ?? []), nodeValue.resourceId]);
  }
  return [...groups.values()]
    .map((resourceIds) => {
      const sorted = resourceIds.sort();
      return { componentId: stableId('component', sorted.join('|')), resourceIds: sorted };
    })
    .sort((left, right) => left.componentId.localeCompare(right.componentId));
}

function node(
  resourceId: string,
  kind: ResourceNode['kind'],
  name: string,
  sourceObjectId: string,
  evidenceIds: readonly string[],
  attributes: Record<string, unknown>,
): ResourceNode {
  return {
    attributes: Object.fromEntries(
      Object.entries(attributes).filter(([, value]) => value !== undefined),
    ),
    evidenceIds: [...new Set(evidenceIds)].sort(),
    kind,
    name,
    resourceId,
    sourceObjectId,
  };
}

function edge(
  kind: ResourceEdgeKind,
  fromId: string,
  toId: string,
  ruleId: string,
  evidenceIds: readonly string[],
  confidence: ResourceEdge['confidence'] = 'confirmed',
): ResourceEdge {
  return {
    confidence,
    edgeId: stableId('edge', `${kind}|${fromId}|${toId}|${ruleId}`),
    evidenceIds: [...new Set(evidenceIds)].sort(),
    fromId,
    kind,
    ruleId,
    toId,
  };
}

function uniqueEdges(edges: ResourceEdge[]): ResourceEdge[] {
  return [...new Map(edges.map((item) => [item.edgeId, item])).values()];
}

function findCgroupUnit(
  cgroup: string | undefined,
  units: ReadonlyMap<string, SystemdUnitRecord>,
): SystemdUnitRecord | undefined {
  if (cgroup === undefined) return undefined;
  return [...units].find(([name]) => cgroup.includes(name))?.[1];
}

function findProcessContainer<T>(
  explicitId: string | undefined,
  cgroup: string | undefined,
  containers: ReadonlyMap<string, T>,
): T | undefined {
  if (explicitId !== undefined) {
    const direct = containers.get(explicitId.toLowerCase());
    if (direct !== undefined) return direct;
  }
  if (cgroup === undefined) return undefined;
  return [...containers].find(([id]) => cgroup.toLowerCase().includes(id))?.[1];
}

function longestContainingMount<T extends { target: string }>(
  pathValue: string,
  mounts: readonly T[],
): T | undefined {
  return [...mounts]
    .filter((mount) => pathValue === mount.target || pathValue.startsWith(`${mount.target}/`))
    .sort((left, right) => right.target.length - left.target.length)[0];
}

function rawContainerId(id: string): string {
  return id.replace(/^container:/, '').toLowerCase();
}

function processName(command: string): string {
  return path.posix.basename(command.trim().split(/\s+/)[0] ?? command) || 'unknown-process';
}

function pathResourceId(value: string): string {
  return stableId('path', value);
}

function classifyPath(value: string, seed?: PathSeedRecord): string {
  if (/^\/(?:proc|sys|dev|run|tmp)(?:\/|$)/.test(value)) return 'forbidden';
  if (/^\/var\/lib\/(?:docker|containers)(?:\/|$)/.test(value)) {
    return 'runtime_internal';
  }
  if (seed?.sources.some((source) => source.sourceType.startsWith('docker.mount.')) === true) {
    return 'mount_source';
  }
  if (/\.(?:conf|config|ini|json|toml|ya?ml|service)$/i.test(value)) {
    return 'file_candidate';
  }
  if (/^\/(?:bin|lib|lib64|sbin|usr\/(?:bin|lib|sbin|share))(?:\/|$)/.test(value)) {
    return 'system_managed';
  }
  return 'directory_candidate';
}

function stableId(prefix: string, value: string): string {
  return `${prefix}:${createHash('sha256').update(value).digest('hex').slice(0, 20)}`;
}
