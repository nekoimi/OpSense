import path from 'node:path';

import { BaselineRelevanceClassifier, governAiPlan } from '@opsense/ai-provider';
import { InventoryProjectionSchema, assertSchema } from '@opsense/schema';
import type {
  InventoryProjection,
  AiAnalysis,
  MountRecord,
  NetworkInterface,
  ScanSnapshot,
  ServiceRecord,
  VisibilityDecision,
} from '@opsense/schema';

export interface BuildInventoryProjectionOptions {
  analysis?: AiAnalysis;
  now?: () => Date;
}

const CONTAINER_INTERFACE_PATTERN =
  /^(?:docker(?:\d+)?|br-[a-f0-9]+|veth|virbr|cni|flannel|cali|tunl)/i;
const RUNTIME_MOUNT_PATTERN =
  /(?:overlay2|containers\/storage|containerd|podman|docker\/containers)/i;
const PSEUDO_TARGET_PATTERN = /^\/(?:proc|sys|dev|run)(?:\/|$)/;

export function buildInventoryProjection(
  snapshot: ScanSnapshot,
  options: BuildInventoryProjectionOptions = {},
): InventoryProjection {
  const now = options.now ?? (() => new Date());
  const generatedAt = now().toISOString();
  const baselinePlan = new BaselineRelevanceClassifier().classify(
    snapshot,
    () => new Date(generatedAt),
  );
  const analysis = options.analysis ?? snapshot.aiAnalysis;
  const serviceAssessments =
    analysis === undefined
      ? baselinePlan.serviceAssessments
      : governAiPlan(
          snapshot,
          {
            generatedAt: analysis.generatedAt,
            pathAssessments: analysis.pathAssessments,
            probeRequests: [],
            provider: analysis.provider,
            serviceAssessments: analysis.serviceAssessments,
            ...(analysis.model === undefined ? {} : { model: analysis.model }),
            ...(analysis.threadId === undefined ? {} : { threadId: analysis.threadId }),
          },
          baselinePlan,
          () => new Date(generatedAt),
        ).serviceAssessments;
  const visibilityDecisions: VisibilityDecision[] = [];
  const servicePaths = new Map(
    snapshot.services.map((service) => [service.id, servicePathsFor(service)]),
  );
  const visibleInterfaces = (snapshot.network?.interfaces ?? []).filter((item) => {
    const filtered = isContainerInterface(item);
    visibilityDecisions.push(
      visibilityDecision(
        item.id,
        'network_interface',
        filtered ? 'filtered' : 'primary',
        filtered ? '容器运行时内部网络接口，不进入主机网络正文。' : '主机网络接口候选。',
        'host_interface',
        item.evidenceIds,
      ),
    );
    return !filtered;
  });
  const visibleMounts = (snapshot.storage?.mounts ?? []).filter((item) => {
    const filtered = isRuntimeMount(item);
    const relatedServiceIds = relatedServices(item, servicePaths);
    visibilityDecisions.push(
      visibilityDecision(
        item.id,
        'mount',
        filtered ? 'filtered' : relatedServiceIds.length > 0 ? 'supporting' : 'primary',
        filtered
          ? '容器运行时、伪文件系统或临时挂载，不进入主机存储正文。'
          : relatedServiceIds.length > 0
            ? '挂载路径与已知服务目录关联，保留为服务附属资源。'
            : '主机有效挂载候选。',
        filtered
          ? 'container_runtime_mount'
          : relatedServiceIds.length > 0
            ? 'service_mount'
            : 'host_mount',
        item.evidenceIds,
        relatedServiceIds,
      ),
    );
    return !filtered;
  });
  const filteredInterfaceCount =
    (snapshot.network?.interfaces.length ?? 0) - visibleInterfaces.length;
  const filteredMountCount = (snapshot.storage?.mounts.length ?? 0) - visibleMounts.length;
  const projection: InventoryProjection = {
    artifacts: [...snapshot.artifacts],
    composeProjects: [...snapshot.composeProjects],
    containers: [...snapshot.containers],
    evidence: [...snapshot.evidence],
    filteredCounts: {
      'network.container_network': filteredInterfaceCount,
      'storage.runtime_mount': filteredMountCount,
    },
    findings: [...snapshot.findings],
    generatedAt,
    ...(snapshot.host === undefined ? {} : { host: snapshot.host }),
    ...(snapshot.network === undefined
      ? {}
      : {
          network: {
            ...snapshot.network,
            interfaces: visibleInterfaces,
          },
        }),
    ...(snapshot.pathSeeds === undefined ? {} : { pathSeeds: [...snapshot.pathSeeds] }),
    processes: [...snapshot.processes],
    projectionId: `projection:${snapshot.session.id}`,
    ...(snapshot.redaction === undefined ? {} : { redaction: snapshot.redaction }),
    ...(analysis === undefined ? {} : { analysis }),
    services: [...snapshot.services],
    serviceAssessments,
    session: snapshot.session,
    sockets: [...snapshot.sockets],
    ...(snapshot.storage === undefined
      ? {}
      : {
          storage: {
            ...snapshot.storage,
            mounts: visibleMounts,
          },
        }),
    systemdUnits: [...snapshot.systemdUnits],
    unknowns: [...snapshot.unknowns],
    visibilityDecisions,
    sourceSnapshotId: snapshot.session.id,
  };
  assertSchema(InventoryProjectionSchema, projection);
  return projection;
}

function isContainerInterface(item: NetworkInterface): boolean {
  return CONTAINER_INTERFACE_PATTERN.test(item.name);
}

function isRuntimeMount(item: MountRecord): boolean {
  return (
    item.pseudo ||
    item.temporary ||
    PSEUDO_TARGET_PATTERN.test(item.target) ||
    RUNTIME_MOUNT_PATTERN.test(item.source) ||
    /^(?:overlay|aufs|fuse\.overlayfs)$/i.test(item.fileSystemType)
  );
}

function servicePathsFor(service: ServiceRecord): string[] {
  return [
    ...service.deployDirectories,
    ...service.configFiles,
    ...service.environmentFiles,
    ...service.logLocations,
    ...service.dataDirectories,
  ].map((value) => path.posix.normalize(value));
}

function relatedServices(mount: MountRecord, servicePaths: Map<string, string[]>): string[] {
  const source = path.posix.normalize(mount.source);
  const target = path.posix.normalize(mount.target);
  return [...servicePaths.entries()]
    .filter(([, paths]) =>
      paths.some(
        (candidate) =>
          within(candidate, source) ||
          within(source, candidate) ||
          within(candidate, target) ||
          within(target, candidate),
      ),
    )
    .map(([serviceId]) => serviceId);
}

function visibilityDecision(
  objectId: string,
  objectType: string,
  placement: VisibilityDecision['placement'],
  visibilityReason: string,
  resourceClass: string,
  evidenceIds: readonly string[],
  relatedServiceIds: readonly string[] = [],
): VisibilityDecision {
  return {
    evidenceIds: [...evidenceIds],
    objectId,
    objectType,
    placement,
    relatedServiceIds: [...relatedServiceIds],
    resourceClass,
    userReviewRequired: placement === 'filtered' && relatedServiceIds.length > 0,
    visibilityReason,
  };
}

function within(root: string, candidate: string): boolean {
  const normalizedRoot = root.replace(/\/$/, '');
  return candidate === normalizedRoot || candidate.startsWith(`${normalizedRoot}/`);
}

export type { InventoryProjection } from '@opsense/schema';
