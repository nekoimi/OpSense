import { createHash } from 'node:crypto';
import path from 'node:path';

import type {
  ArtifactRecord,
  ComposeProjectRecord,
  ContainerRecord,
  EvidenceRecord,
  ProcessRecord,
  ServiceRecord,
  SocketRecord,
  SystemdUnitRecord,
} from '@opsense/schema';

export const NORMALIZER_VERSION = '1.0.0';

export interface NormalizationInput {
  artifacts: readonly ArtifactRecord[];
  collectedAt: string;
  composeProjects: readonly ComposeProjectRecord[];
  containers: readonly ContainerRecord[];
  evidence: readonly EvidenceRecord[];
  opsenseVersion: string;
  processes: readonly ProcessRecord[];
  sockets: readonly SocketRecord[];
  systemdUnits: readonly SystemdUnitRecord[];
  unknowns: readonly string[];
}

export interface NormalizationResult {
  artifacts: ArtifactRecord[];
  composeProjects: ComposeProjectRecord[];
  containers: ContainerRecord[];
  evidence: EvidenceRecord[];
  processes: ProcessRecord[];
  services: ServiceRecord[];
  sockets: SocketRecord[];
  systemdUnits: SystemdUnitRecord[];
  unknowns: string[];
}

interface MergeEdge {
  left: string;
  right: string;
  rule: string;
}

interface ServiceGroup {
  composeServices: Array<{ project: ComposeProjectRecord; serviceName: string }>;
  containers: ContainerRecord[];
  nodes: Set<string>;
  processes: ProcessRecord[];
  rules: Set<string>;
  systemdUnits: SystemdUnitRecord[];
}

interface ServicePaths {
  associationRoots: Set<string>;
  configFiles: Set<string>;
  dataDirectories: Set<string>;
  deployDirectories: Set<string>;
  environmentFiles: Set<string>;
  evidenceIds: Set<string>;
  logLocations: Set<string>;
}

export function normalizeAndMergeServices(input: NormalizationInput): NormalizationResult {
  const processes = normalizeProcesses(input.processes);
  const sockets = normalizeSockets(input.sockets);
  const systemdUnits = normalizeSystemdUnits(input.systemdUnits);
  const containers = normalizeContainers(input.containers);
  const composeProjects = normalizeComposeProjects(input.composeProjects);
  const artifacts = normalizeArtifacts(input.artifacts);
  const normalizedEvidence = normalizeEvidence(input.evidence);
  const graph = buildServiceGraph({ composeProjects, containers, processes, systemdUnits });
  const servicesAndEvidence = buildServices(
    graph,
    { artifacts, sockets },
    {
      collectedAt: normalizeDateTime(input.collectedAt),
      opsenseVersion: input.opsenseVersion,
    },
  );

  return {
    artifacts,
    composeProjects,
    containers,
    evidence: mergeEvidence(normalizedEvidence, servicesAndEvidence.evidence),
    processes,
    services: servicesAndEvidence.services,
    sockets,
    systemdUnits,
    unknowns: sortedUnique(input.unknowns),
  };
}

function buildServiceGraph(input: {
  composeProjects: ComposeProjectRecord[];
  containers: ContainerRecord[];
  processes: ProcessRecord[];
  systemdUnits: SystemdUnitRecord[];
}): { edges: MergeEdge[]; groups: ServiceGroup[]; nodeRoots: Map<string, string> } {
  const unionFind = new UnionFind();
  const edges: MergeEdge[] = [];
  const processNodes = new Map<number, string>();
  const unitNodes = new Map<string, string>();
  const containerNodes = new Map<string, string>();
  const composeNodes = new Map<
    string,
    { node: string; project: ComposeProjectRecord; serviceName: string }
  >();

  for (const process of input.processes) {
    const node = processNode(process.pid);
    unionFind.add(node);
    processNodes.set(process.pid, node);
  }
  for (const unit of input.systemdUnits) {
    const node = unitNode(unit.id);
    unionFind.add(node);
    unitNodes.set(unit.name, node);
  }
  for (const container of input.containers) {
    const node = containerNode(container.id);
    unionFind.add(node);
    containerNodes.set(container.id, node);
  }
  for (const project of input.composeProjects) {
    for (const service of project.services) {
      const node = composeNode(project.id, service.name);
      unionFind.add(node);
      composeNodes.set(node, { node, project, serviceName: service.name });
    }
  }

  const link = (left: string | undefined, right: string | undefined, rule: string): void => {
    if (left === undefined || right === undefined) return;
    unionFind.union(left, right);
    edges.push({ left, right, rule });
  };

  for (const unit of input.systemdUnits) {
    if (unit.mainPid !== undefined && unit.mainPid > 0) {
      link(unitNodes.get(unit.name), processNodes.get(unit.mainPid), 'systemd.main-pid');
    }
  }
  for (const process of input.processes) {
    const node = processNodes.get(process.pid);
    const cgroupUnit = extractSystemdUnit(process.cgroup);
    if (cgroupUnit !== undefined) {
      link(node, unitNodes.get(cgroupUnit), 'process.cgroup-systemd');
    }
    const container = findContainer(process.containerId, input.containers);
    if (container !== undefined) {
      link(node, containerNodes.get(container.id), 'process.cgroup-container');
    }
  }
  for (const container of input.containers) {
    if (container.processId !== undefined && container.processId > 0) {
      link(
        containerNodes.get(container.id),
        processNodes.get(container.processId),
        'container.init-pid',
      );
    }
  }
  const anchoredPids = new Set([
    ...input.systemdUnits.flatMap((unit) =>
      unit.mainPid === undefined || unit.mainPid === 0 ? [] : [unit.mainPid],
    ),
    ...input.containers.flatMap((container) =>
      container.processId === undefined || container.processId === 0 ? [] : [container.processId],
    ),
  ]);
  const childrenByParent = new Map<number, ProcessRecord[]>();
  for (const process of input.processes) {
    if (process.parentPid === undefined || process.parentPid === 0) continue;
    const children = childrenByParent.get(process.parentPid) ?? [];
    children.push(process);
    childrenByParent.set(process.parentPid, children);
  }
  for (const anchorPid of anchoredPids) {
    const anchorNode = processNodes.get(anchorPid);
    if (anchorNode === undefined) continue;
    const queue = [...(childrenByParent.get(anchorPid) ?? [])];
    const visited = new Set<number>();
    while (queue.length > 0) {
      const child = queue.shift();
      if (child === undefined || visited.has(child.pid)) continue;
      visited.add(child.pid);
      if (anchoredPids.has(child.pid) && child.pid !== anchorPid) continue;
      link(anchorNode, processNodes.get(child.pid), 'process.parent-service');
      queue.push(...(childrenByParent.get(child.pid) ?? []));
    }
  }
  for (const project of input.composeProjects) {
    for (const service of project.services) {
      const compose = composeNodes.get(composeNode(project.id, service.name));
      for (const id of service.containerIds) {
        const container = findContainer(id, input.containers);
        link(
          compose?.node,
          container === undefined ? undefined : containerNodes.get(container.id),
          'compose.service-label',
        );
      }
    }
  }

  const standaloneSignatures = new Map<string, string>();
  const anchoredRoots = new Set(
    [
      ...unitNodes.values(),
      ...containerNodes.values(),
      ...[...composeNodes.values()].map((item) => item.node),
    ].map((node) => unionFind.find(node)),
  );
  for (const process of input.processes) {
    if (process.containerId !== undefined || extractSystemdUnit(process.cgroup) !== undefined) {
      continue;
    }
    const signature = processSignature(process);
    const node = processNodes.get(process.pid);
    if (node === undefined || anchoredRoots.has(unionFind.find(node))) continue;
    const existing = standaloneSignatures.get(signature);
    if (existing === undefined) standaloneSignatures.set(signature, node);
    else link(existing, node, 'process.runtime-signature');
  }

  const groupedNodes = new Map<string, Set<string>>();
  for (const node of unionFind.nodes()) {
    const root = unionFind.find(node);
    const nodes = groupedNodes.get(root) ?? new Set<string>();
    nodes.add(node);
    groupedNodes.set(root, nodes);
  }
  const nodeRoots = new Map<string, string>();
  for (const [root, nodes] of groupedNodes) {
    for (const node of nodes) nodeRoots.set(node, root);
  }

  const groups = [...groupedNodes.entries()].flatMap(([root, nodes]) => {
    const processes = input.processes.filter((item) => nodes.has(processNode(item.pid)));
    const systemdUnits = input.systemdUnits.filter((item) => nodes.has(unitNode(item.id)));
    const containers = input.containers.filter((item) => nodes.has(containerNode(item.id)));
    const composeServices = [...composeNodes.values()]
      .filter((item) => nodes.has(item.node))
      .map(({ project, serviceName }) => ({ project, serviceName }));
    if (
      systemdUnits.length === 0 &&
      containers.length === 0 &&
      composeServices.length === 0 &&
      processes.every(isKernelThread)
    ) {
      return [];
    }
    return [
      {
        composeServices,
        containers,
        nodes,
        processes,
        rules: new Set(
          edges
            .filter(
              (edge) => nodeRoots.get(edge.left) === root && nodeRoots.get(edge.right) === root,
            )
            .map((edge) => edge.rule),
        ),
        systemdUnits,
      },
    ];
  });

  return { edges, groups, nodeRoots };
}

function buildServices(
  graph: ReturnType<typeof buildServiceGraph>,
  input: { artifacts: ArtifactRecord[]; sockets: SocketRecord[] },
  options: { collectedAt: string; opsenseVersion: string },
): { evidence: EvidenceRecord[]; services: ServiceRecord[] } {
  const services: ServiceRecord[] = [];
  const evidence: EvidenceRecord[] = [];
  const pathsByGroup = new Map(
    graph.groups.map((group) => [group, collectServicePaths(group)] as const),
  );
  for (const artifact of input.artifacts) {
    const matches = graph.groups.flatMap((group) => {
      const paths = pathsByGroup.get(group);
      if (paths === undefined) return [];
      const roots = [...paths.associationRoots].filter((root) => pathContains(root, artifact.path));
      const root = roots.sort((left, right) => right.length - left.length)[0];
      return root === undefined ? [] : [{ group, paths, root }];
    });
    const maximumLength = Math.max(0, ...matches.map((match) => match.root.length));
    const mostSpecific = matches.filter((match) => match.root.length === maximumLength);
    if (mostSpecific.length === 1 && mostSpecific[0] !== undefined) {
      attachArtifact(mostSpecific[0].group, mostSpecific[0].paths, artifact);
    }
  }

  for (const group of graph.groups) {
    const serviceId = stableServiceId(group);
    const paths = pathsByGroup.get(group) ?? collectServicePaths(group);
    const socketIds = new Set<string>();
    const sourceEvidenceIds = new Set<string>(paths.evidenceIds);

    for (const item of [...group.systemdUnits, ...group.processes, ...group.containers]) {
      item.evidenceIds.forEach((id) => sourceEvidenceIds.add(id));
    }
    for (const item of group.composeServices) {
      item.project.evidenceIds.forEach((id) => sourceEvidenceIds.add(id));
    }
    for (const socket of input.sockets) {
      if (!socketBelongsToGroup(socket, group)) continue;
      socketIds.add(socket.id);
      socket.evidenceIds.forEach((id) => sourceEvidenceIds.add(id));
      group.rules.add(socket.containerIds.length > 0 ? 'socket.container-id' : 'socket.process-id');
    }
    if (!isObservableServiceGroup(group, paths, socketIds)) continue;

    const conflictFields = serviceConflictFields(group);
    const status = serviceStatus(group);
    if (status === 'unknown') addUnique(conflictFields.unknown, 'status');
    if (paths.deployDirectories.size === 0) addUnique(conflictFields.unknown, 'deployDirectories');
    addUnique(conflictFields.unknown, 'purpose');
    const startCommands = sortedUnique(group.systemdUnits.flatMap((unit) => unit.execStart));
    if (startCommands.length > 1) addUnique(conflictFields.conflict, 'startCommand');
    const enabled = enabledAtBoot(group.systemdUnits);
    if (enabled.conflict) addUnique(conflictFields.conflict, 'enabledAtBoot');
    if (group.systemdUnits.length > 0 && enabled.value === undefined && !enabled.conflict) {
      addUnique(conflictFields.unknown, 'enabledAtBoot');
    }
    const derivedEvidenceId = `evidence:service.merge:${hash(serviceId)}`;
    const rawEvidenceIds = sortedUnique(sourceEvidenceIds);
    const confidence =
      conflictFields.conflict.length > 0
        ? 'conflict'
        : group.systemdUnits.length > 0 ||
            group.containers.length > 0 ||
            group.composeServices.length > 0
          ? 'confirmed'
          : 'inferred';
    const identity = serviceIdentity(group);
    const service: ServiceRecord = {
      configFiles: sortedUnique(paths.configFiles),
      confidence,
      conflictFields: conflictFields.conflict,
      containerIds: sortedUnique(group.containers.map((item) => item.id)),
      dataDirectories: sortedUnique(paths.dataDirectories),
      deployDirectories: sortedUnique(paths.deployDirectories),
      deploymentType: identity.deploymentType,
      environmentFiles: sortedUnique(paths.environmentFiles),
      evidenceIds: [...rawEvidenceIds, derivedEvidenceId],
      id: serviceId,
      logLocations: sortedUnique(paths.logLocations),
      name: identity.name,
      processIds: sortedUniqueNumbers(group.processes.map((item) => item.pid)),
      socketIds: sortedUnique(socketIds),
      status,
      systemdUnitIds: sortedUnique(group.systemdUnits.map((item) => item.id)),
      unknownFields: conflictFields.unknown,
      composeProjectIds: sortedUnique(group.composeServices.map((item) => item.project.id)),
      ...(enabled.value === undefined ? {} : { enabledAtBoot: enabled.value }),
      ...(identity.displayName === undefined ? {} : { displayName: identity.displayName }),
      ...(startCommands[0] === undefined ? {} : { startCommand: startCommands[0] }),
    };
    services.push(service);
    evidence.push({
      collectedAt: options.collectedAt,
      field: 'service',
      id: derivedEvidenceId,
      kind: 'derived',
      opsenseVersion: options.opsenseVersion,
      parserVersion: NORMALIZER_VERSION,
      sensitivity: 'internal',
      source: 'normalization.service-merge',
      sourceEvidenceIds: rawEvidenceIds,
      status: 'success',
      value: {
        artifactAssociation: 'path-prefix',
        conflictFields: conflictFields.conflict,
        deploymentType: service.deploymentType,
        rules: sortedUnique(group.rules),
        status: service.status,
        unknownFields: service.unknownFields,
      },
    });
  }

  return {
    evidence: evidence.sort((left, right) => left.id.localeCompare(right.id)),
    services: services.sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function collectServicePaths(group: ServiceGroup): ServicePaths {
  const result: ServicePaths = {
    associationRoots: new Set(),
    configFiles: new Set(),
    dataDirectories: new Set(),
    deployDirectories: new Set(),
    environmentFiles: new Set(),
    evidenceIds: new Set(),
    logLocations: new Set(),
  };
  const addDeploy = (candidate: string | undefined): void => {
    const normalized = normalizeAbsolutePath(candidate);
    if (normalized === undefined || isBroadRoot(normalized)) return;
    result.deployDirectories.add(normalized);
    result.associationRoots.add(normalized);
  };
  const addFile = (
    collection: Set<string>,
    candidate: string | undefined,
    includeParent = true,
  ): void => {
    const normalized = normalizeAbsolutePath(candidate);
    if (normalized === undefined) return;
    collection.add(normalized);
    if (includeParent) {
      const parent = path.posix.dirname(normalized);
      if (!isBroadRoot(parent)) result.associationRoots.add(parent);
    }
  };

  for (const unit of group.systemdUnits) {
    addDeploy(unit.workingDirectory);
    addFile(result.configFiles, unit.fragmentPath);
    unit.environmentFiles.forEach((item) => addFile(result.environmentFiles, item));
    unit.execStart.flatMap(extractAbsolutePaths).forEach((item) => {
      if (looksLikeConfigFile(item)) addFile(result.configFiles, item);
      else addDeploy(path.posix.dirname(item));
    });
  }
  for (const process of group.processes) {
    addDeploy(process.workingDirectory);
    if (process.executablePath !== undefined) addDeploy(path.posix.dirname(process.executablePath));
    process.arguments.flatMap(extractAbsolutePaths).forEach((item) => {
      if (looksLikeConfigFile(item)) addFile(result.configFiles, item);
    });
  }
  for (const container of group.containers) {
    for (const mount of container.mounts) {
      const source = normalizeAbsolutePath(mount.source);
      if (source === undefined) continue;
      if (looksLikeEnvironmentFile(source) || looksLikeEnvironmentFile(mount.destination)) {
        addFile(result.environmentFiles, source);
      } else if (looksLikeConfigFile(source) || looksLikeConfigFile(mount.destination)) {
        addFile(result.configFiles, source);
      } else if (looksLikeLogPath(source) || looksLikeLogPath(mount.destination)) {
        addPathLocation(result.logLocations, source);
        result.associationRoots.add(source);
      } else if (looksLikeDataPath(source) || looksLikeDataPath(mount.destination)) {
        addPathLocation(result.dataDirectories, source);
        result.associationRoots.add(source);
      } else {
        addDeploy(source);
      }
    }
  }
  for (const { project } of group.composeServices) {
    const workingDirectory = normalizeAbsolutePath(project.workingDirectory);
    if (workingDirectory !== undefined && !isBroadRoot(workingDirectory)) {
      result.deployDirectories.add(workingDirectory);
    }
    project.configFiles.forEach((item) => addFile(result.configFiles, item));
  }

  return result;
}

function attachArtifact(group: ServiceGroup, paths: ServicePaths, artifact: ArtifactRecord): void {
  let attached = true;
  if (artifact.fileType === 'directory' && looksLikeLogPath(artifact.path)) {
    addPathLocation(paths.logLocations, artifact.path);
  } else if (artifact.fileType === 'directory' && looksLikeDataPath(artifact.path)) {
    addPathLocation(paths.dataDirectories, artifact.path);
  } else {
    switch (artifact.kind) {
      case 'config':
      case 'compose':
        paths.configFiles.add(artifact.path);
        break;
      case 'environment':
        paths.environmentFiles.add(artifact.path);
        break;
      case 'log':
        addPathLocation(paths.logLocations, artifact.path);
        break;
      case 'data':
        if (artifact.fileType === 'directory')
          addPathLocation(paths.dataDirectories, artifact.path);
        else attached = false;
        break;
      default:
        attached = false;
    }
  }
  if (!attached) return;
  artifact.evidenceIds.forEach((id) => paths.evidenceIds.add(id));
  group.rules.add('artifact.path-prefix');
}

function serviceIdentity(group: ServiceGroup): {
  deploymentType: ServiceRecord['deploymentType'];
  displayName?: string;
  name: string;
} {
  const compose = [...group.composeServices].sort((left, right) =>
    `${left.project.name}/${left.serviceName}`.localeCompare(
      `${right.project.name}/${right.serviceName}`,
    ),
  )[0];
  if (compose !== undefined) {
    return {
      deploymentType: 'compose',
      name: `${compose.project.name}/${compose.serviceName}`,
    };
  }
  const container = [...group.containers].sort((left, right) =>
    left.name.localeCompare(right.name),
  )[0];
  if (container !== undefined) return { deploymentType: 'docker', name: container.name };
  const unit = [...group.systemdUnits].sort((left, right) =>
    left.name.localeCompare(right.name),
  )[0];
  if (unit !== undefined) {
    return {
      deploymentType: 'systemd',
      name: unit.name.replace(/\.service$/, ''),
      ...(unit.description === undefined ? {} : { displayName: unit.description }),
    };
  }
  const process = [...group.processes].sort((left, right) => left.pid - right.pid)[0];
  return {
    deploymentType: process === undefined ? 'unknown' : 'process',
    name: process === undefined ? 'unknown' : processName(process),
  };
}

function stableServiceId(group: ServiceGroup): string {
  const compose = [...group.composeServices].sort((left, right) =>
    `${left.project.id}:${left.serviceName}`.localeCompare(
      `${right.project.id}:${right.serviceName}`,
    ),
  )[0];
  if (compose !== undefined) {
    return `service:${compose.project.id}:${safeIdPart(compose.serviceName)}`;
  }
  const container = [...group.containers].sort((left, right) =>
    left.name.localeCompare(right.name),
  )[0];
  if (container !== undefined) return `service:docker:${safeIdPart(container.name)}`;
  const unit = [...group.systemdUnits].sort((left, right) => left.id.localeCompare(right.id))[0];
  if (unit !== undefined) return `service:${unit.id}`;
  return `service:process:${hash(group.processes.map(processSignature).sort().join('\n'))}`;
}

function serviceConflictFields(group: ServiceGroup): { conflict: string[]; unknown: string[] } {
  const conflict: string[] = [];
  if (
    group.composeServices.length > 1 ||
    (group.composeServices.length === 0 && group.containers.length > 1) ||
    (group.composeServices.length === 0 &&
      group.containers.length === 0 &&
      group.systemdUnits.length > 1)
  ) {
    conflict.push('identity');
  }
  const statuses = new Set(serviceStatusSources(group).filter((status) => status !== 'unknown'));
  if (statuses.size > 1) conflict.push('status');
  return { conflict, unknown: [] };
}

function serviceStatus(group: ServiceGroup): ServiceRecord['status'] {
  const statuses = serviceStatusSources(group);
  if (statuses.includes('failed')) return 'failed';
  if (statuses.includes('running')) return 'running';
  if (statuses.includes('stopped')) return 'stopped';
  return 'unknown';
}

function serviceStatusSources(group: ServiceGroup): ServiceRecord['status'][] {
  return [
    ...group.systemdUnits.map((unit) => systemdStatus(unit)),
    ...group.containers.map((container) => containerStatus(container)),
    ...(group.processes.length > 0 ? (['running'] as const) : []),
  ];
}

function systemdStatus(unit: SystemdUnitRecord): ServiceRecord['status'] {
  if (unit.activeState === 'failed') return 'failed';
  if (unit.activeState === 'active' || unit.subState === 'running') return 'running';
  if (unit.activeState === 'inactive' || unit.activeState === 'deactivating') return 'stopped';
  return 'unknown';
}

function containerStatus(container: ContainerRecord): ServiceRecord['status'] {
  const state = container.state.toLowerCase();
  if (state === 'running' || state === 'restarting' || state === 'paused') return 'running';
  if (state === 'dead') return 'failed';
  if (state === 'exited' || state === 'created' || state === 'removing') return 'stopped';
  return 'unknown';
}

function enabledAtBoot(units: SystemdUnitRecord[]): { conflict: boolean; value?: boolean } {
  const values = new Set(
    units.flatMap((unit) => {
      if (unit.enabledState === 'enabled' || unit.enabledState === 'enabled-runtime') return [true];
      if (unit.enabledState === 'disabled' || unit.enabledState === 'masked') return [false];
      return [];
    }),
  );
  if (values.size !== 1) return { conflict: values.size > 1 };
  const value = [...values][0];
  return value === undefined ? { conflict: false } : { conflict: false, value };
}

function socketBelongsToGroup(socket: SocketRecord, group: ServiceGroup): boolean {
  const processIds = new Set(group.processes.map((item) => item.pid));
  if (socket.processIds.some((pid) => processIds.has(pid))) return true;
  return socket.containerIds.some((id) => group.containers.some((item) => idsMatch(id, item.id)));
}

function isObservableServiceGroup(
  group: ServiceGroup,
  paths: ServicePaths,
  socketIds: Set<string>,
): boolean {
  if (
    group.systemdUnits.length > 0 ||
    group.containers.length > 0 ||
    group.composeServices.length > 0
  ) {
    return true;
  }
  if (group.processes.length > 0 && group.processes.every((process) => process.pid === 1)) {
    return false;
  }
  return (
    socketIds.size > 0 ||
    paths.deployDirectories.size > 0 ||
    paths.configFiles.size > 0 ||
    paths.environmentFiles.size > 0 ||
    paths.logLocations.size > 0 ||
    paths.dataDirectories.size > 0
  );
}

function normalizeProcesses(values: readonly ProcessRecord[]): ProcessRecord[] {
  return [...values]
    .map((item) => ({
      ...item,
      evidenceIds: sortedUnique(item.evidenceIds),
      ...(item.executablePath === undefined
        ? {}
        : { executablePath: normalizeAbsolutePath(item.executablePath) ?? item.executablePath }),
      ...(item.workingDirectory === undefined
        ? {}
        : {
            workingDirectory: normalizeAbsolutePath(item.workingDirectory) ?? item.workingDirectory,
          }),
      ...(item.startedAt === undefined ? {} : { startedAt: normalizeDateTime(item.startedAt) }),
    }))
    .sort((left, right) => left.pid - right.pid);
}

function normalizeSockets(values: readonly SocketRecord[]): SocketRecord[] {
  return [...values]
    .map((item) => ({
      ...item,
      containerIds: sortedUnique(item.containerIds),
      evidenceIds: sortedUnique(item.evidenceIds),
      localAddress: normalizeAddress(item.localAddress),
      processIds: sortedUniqueNumbers(item.processIds),
      processNames: sortedUnique(item.processNames),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function normalizeSystemdUnits(values: readonly SystemdUnitRecord[]): SystemdUnitRecord[] {
  return [...values]
    .map((item) => ({
      ...item,
      environmentFiles: sortedUnique(
        item.environmentFiles.map((value) => normalizeAbsolutePath(value) ?? value),
      ),
      evidenceIds: sortedUnique(item.evidenceIds),
      execReload: uniqueInOrder(item.execReload),
      execStart: uniqueInOrder(item.execStart),
      ...(item.fragmentPath === undefined
        ? {}
        : { fragmentPath: normalizeAbsolutePath(item.fragmentPath) ?? item.fragmentPath }),
      ...(item.workingDirectory === undefined
        ? {}
        : {
            workingDirectory: normalizeAbsolutePath(item.workingDirectory) ?? item.workingDirectory,
          }),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function normalizeContainers(values: readonly ContainerRecord[]): ContainerRecord[] {
  return [...values]
    .map((item) => ({
      ...item,
      environmentKeys: sortedUnique(item.environmentKeys),
      evidenceIds: sortedUnique(item.evidenceIds),
      mounts: [...item.mounts]
        .map((mount) => ({
          ...mount,
          destination: normalizeAbsolutePath(mount.destination) ?? mount.destination,
          ...(mount.source === undefined
            ? {}
            : { source: normalizeAbsolutePath(mount.source) ?? mount.source }),
        }))
        .sort((left, right) => left.destination.localeCompare(right.destination)),
      networks: sortedUnique(item.networks),
      ports: [...item.ports].sort((left, right) =>
        `${left.protocol}:${left.containerPort}:${left.hostAddress ?? ''}:${left.hostPort ?? ''}`.localeCompare(
          `${right.protocol}:${right.containerPort}:${right.hostAddress ?? ''}:${right.hostPort ?? ''}`,
        ),
      ),
      ...(item.startedAt === undefined ? {} : { startedAt: normalizeDateTime(item.startedAt) }),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function normalizeComposeProjects(values: readonly ComposeProjectRecord[]): ComposeProjectRecord[] {
  return [...values]
    .map((item) => ({
      ...item,
      configFiles: sortedUnique(
        item.configFiles.map((value) => normalizeAbsolutePath(value) ?? value),
      ),
      evidenceIds: sortedUnique(item.evidenceIds),
      services: [...item.services]
        .map((service) => ({ ...service, containerIds: sortedUnique(service.containerIds) }))
        .sort((left, right) => left.name.localeCompare(right.name)),
      ...(item.workingDirectory === undefined
        ? {}
        : {
            workingDirectory: normalizeAbsolutePath(item.workingDirectory) ?? item.workingDirectory,
          }),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function normalizeArtifacts(values: readonly ArtifactRecord[]): ArtifactRecord[] {
  return [...values]
    .map((item) => ({
      ...item,
      evidenceIds: sortedUnique(item.evidenceIds),
      path: normalizeAbsolutePath(item.path) ?? item.path,
      ...(item.modifiedAt === undefined ? {} : { modifiedAt: normalizeDateTime(item.modifiedAt) }),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function normalizeEvidence(values: readonly EvidenceRecord[]): EvidenceRecord[] {
  return [...values]
    .map((item) => ({
      ...item,
      collectedAt: normalizeDateTime(item.collectedAt),
      parserVersion: item.parserVersion ?? NORMALIZER_VERSION,
      ...(item.sourceEvidenceIds === undefined
        ? {}
        : { sourceEvidenceIds: sortedUnique(item.sourceEvidenceIds) }),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function mergeEvidence(left: EvidenceRecord[], right: EvidenceRecord[]): EvidenceRecord[] {
  const byId = new Map<string, EvidenceRecord>();
  for (const item of [...left, ...right]) byId.set(item.id, item);
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function findContainer(
  id: string | undefined,
  containers: readonly ContainerRecord[],
): ContainerRecord | undefined {
  return id === undefined ? undefined : containers.find((container) => idsMatch(id, container.id));
}

function idsMatch(left: string, right: string): boolean {
  const leftId = left.replace(/^container:/, '').toLowerCase();
  const rightId = right.replace(/^container:/, '').toLowerCase();
  return leftId === rightId || leftId.startsWith(rightId) || rightId.startsWith(leftId);
}

function extractSystemdUnit(cgroup: string | undefined): string | undefined {
  const match = /(?:^|\/)([^/]+\.service)(?:\/|$)/.exec(cgroup ?? '');
  return match?.[1];
}

function processSignature(process: ProcessRecord): string {
  return [
    process.executablePath ?? process.command,
    process.workingDirectory ?? '',
    process.command,
    process.arguments.join('\u0000'),
  ].join('\u0001');
}

function processName(process: ProcessRecord): string {
  const candidate = process.executablePath ?? process.command;
  return path.posix.basename(candidate) || process.command;
}

function isKernelThread(process: ProcessRecord): boolean {
  return (
    process.executablePath === undefined &&
    process.workingDirectory === undefined &&
    /^\[[^\]]+\]$/.test(process.command)
  );
}

function normalizeAbsolutePath(value: string | undefined): string | undefined {
  const candidate = value?.trim();
  return candidate === undefined || !candidate.startsWith('/') || hasControlCharacters(candidate)
    ? undefined
    : path.posix.normalize(candidate);
}

function normalizeAddress(value: string): string {
  const normalized = value
    .trim()
    .replace(/^\[|\]$/g, '')
    .toLowerCase();
  return normalized.length === 0 ? '*' : normalized;
}

function normalizeDateTime(value: string): string {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : value;
}

function pathContains(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`);
}

function isBroadRoot(value: string): boolean {
  if (
    new Set([
      '/',
      '/bin',
      '/etc',
      '/home',
      '/lib',
      '/lib64',
      '/opt',
      '/root',
      '/run',
      '/sbin',
      '/srv',
      '/tmp',
      '/usr',
      '/var',
      '/var/run',
    ]).has(value)
  ) {
    return true;
  }
  return [
    '/bin/',
    '/lib/',
    '/lib64/',
    '/sbin/',
    '/usr/bin/',
    '/usr/lib/',
    '/usr/lib64/',
    '/usr/sbin/',
    '/usr/share/',
    '/run/',
    '/tmp/',
    '/var/lib/docker/overlay/',
    '/var/lib/docker/overlay2/',
    '/var/run/',
  ].some((prefix) => `${value}/`.startsWith(prefix));
}

function looksLikeConfigFile(value: string): boolean {
  return /(?:^|\/)(?:[^/]+\.(?:conf|config|cnf|ini|json|properties|service|toml|xml|ya?ml)|Caddyfile|Dockerfile)$/i.test(
    value,
  );
}

function looksLikeEnvironmentFile(value: string): boolean {
  return /(?:^|\/)\.env(?:\.[^/]+)?$/i.test(value);
}

function looksLikeLogPath(value: string): boolean {
  return /(?:^|\/)(?:log|logs)(?:\/|$)|\.log$/i.test(value);
}

function looksLikeDataPath(value: string): boolean {
  return /(?:^|\/)(?:data|db|[^/]+_data|mysql\d*|mariadb|mongo(?:db)?|postgres(?:ql)?)(?:\/|$)/i.test(
    value,
  );
}

function extractAbsolutePaths(value: string): string[] {
  return sortedUnique(
    (value.match(/\/(?:[^\s'";,)]|\\.)+/g) ?? []).map((item) => item.replace(/[.:]+$/, '')),
  );
}

function addPathLocation(values: Set<string>, candidate: string): void {
  if ([...values].some((existing) => pathContains(existing, candidate))) return;
  for (const existing of values) {
    if (pathContains(candidate, existing)) values.delete(existing);
  }
  values.add(candidate);
}

function safeIdPart(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9._:-]+/g, '_').replace(/^[_:.-]+/, '');
  return normalized || hash(value);
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function processNode(pid: number): string {
  return `process:${pid}`;
}

function unitNode(id: string): string {
  return `unit:${id}`;
}

function containerNode(id: string): string {
  return `container-node:${id}`;
}

function composeNode(projectId: string, serviceName: string): string {
  return `compose-node:${projectId}:${hash(serviceName)}`;
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function uniqueInOrder(values: Iterable<string>): string[] {
  return [...new Set(values)];
}

function sortedUniqueNumbers(values: Iterable<number>): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

function addUnique(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value);
  values.sort((left, right) => left.localeCompare(right));
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
}

class UnionFind {
  private readonly parent = new Map<string, string>();

  public add(value: string): void {
    if (!this.parent.has(value)) this.parent.set(value, value);
  }

  public find(value: string): string {
    const parent = this.parent.get(value);
    if (parent === undefined) {
      this.add(value);
      return value;
    }
    if (parent === value) return value;
    const root = this.find(parent);
    this.parent.set(value, root);
    return root;
  }

  public nodes(): string[] {
    return [...this.parent.keys()];
  }

  public union(left: string, right: string): void {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot === rightRoot) return;
    const [root, child] = [leftRoot, rightRoot].sort((a, b) => a.localeCompare(b));
    if (root !== undefined && child !== undefined) this.parent.set(child, root);
  }
}
