import { ReportModelSchema, assertSchema } from '@opsense/schema';
import type { InventoryProjection, ReportModel, ReportService } from '@opsense/schema';

export interface BuildReportModelOptions {
  now?: () => Date;
}

export function buildReportModel(
  projection: InventoryProjection,
  options: BuildReportModelOptions = {},
): ReportModel {
  const generatedAt = (options.now ?? (() => new Date()))().toISOString();
  const scannedAt = projection.session.finishedAt ?? projection.session.startedAt;
  const displayHost = projection.host?.hostname ?? projection.session.target.host;
  const socketById = new Map(projection.sockets.map((socket) => [socket.id, socket]));
  const containerById = new Map(
    projection.containers.map((container) => [container.id, container]),
  );
  const analysis = projection.analysis;
  const assessmentByService = new Map(
    projection.serviceAssessments.map((assessment) => [assessment.serviceId, assessment]),
  );
  const serviceIndex = projection.services
    .map((service): ReportService => {
      const assessment = assessmentByService.get(service.id);
      if (assessment === undefined) {
        throw new Error(`Missing report assessment for service '${service.id}'.`);
      }
      const ports = new Set<string>();
      for (const socketId of service.socketIds) {
        const socket = socketById.get(socketId);
        if (socket !== undefined) {
          ports.add(
            `${socket.protocol.toUpperCase()} ${formatEndpoint(socket.localAddress, socket.localPort)}${socket.exposed ? ' (external)' : ' (local)'}`,
          );
        }
      }
      for (const containerId of service.containerIds) {
        const container = containerById.get(containerId);
        for (const port of container?.ports ?? []) {
          ports.add(
            `${port.protocol.toUpperCase()} ${formatEndpoint(port.hostAddress ?? '0.0.0.0', port.hostPort ?? port.containerPort)} -> ${port.containerPort}`,
          );
        }
      }
      const classifiedPaths = servicePathsForReport(projection, service);
      const semanticEvidenceIds = (projection.pathAssessments ?? [])
        .filter((item) => item.serviceIds.includes(service.id))
        .flatMap((item) => item.evidenceIds);
      return {
        assessmentConfidence: assessment.confidence,
        assessmentReason: assessment.reason,
        confidence: service.confidence,
        configFiles: classifiedPaths.config,
        conflictFields: [...(service.conflictFields ?? [])],
        dataDirectories: classifiedPaths.data,
        deployDirectories: classifiedPaths.deploy,
        deploymentType: service.deploymentType,
        ...(service.displayName === undefined ? {} : { displayName: service.displayName }),
        ...(service.enabledAtBoot === undefined ? {} : { enabledAtBoot: service.enabledAtBoot }),
        environmentFiles: classifiedPaths.environment,
        evidenceIds: [
          ...new Set([...service.evidenceIds, ...assessment.evidenceIds, ...semanticEvidenceIds]),
        ],
        id: service.id,
        logLocations: classifiedPaths.log,
        name: service.name,
        ports: [...ports].sort(),
        processIds: [...service.processIds],
        ...((assessment.purpose ?? service.purpose) === undefined
          ? {}
          : { purpose: assessment.purpose ?? service.purpose }),
        reportPlacement: assessment.reportPlacement,
        role: assessment.role,
        ...(service.startCommand === undefined ? {} : { startCommand: service.startCommand }),
        status: service.status,
        unknownFields: [...service.unknownFields],
      };
    })
    .sort(compareServices);
  const services = serviceIndex.filter((service) => service.reportPlacement !== 'system_summary');
  const systemServiceRecords = serviceIndex.filter(
    (service) => service.reportPlacement === 'system_summary',
  );

  const model: ReportModel = {
    ...(analysis === undefined ? {} : { aiAnalysis: analysis }),
    disks: (projection.storage?.disks ?? []).map((disk) => ({
      evidenceIds: [...disk.evidenceIds],
      fileSystemTypes: [
        ...new Set(
          disk.partitions.flatMap((partition) =>
            partition.fileSystemType === undefined ? [] : [partition.fileSystemType],
          ),
        ),
      ].sort(),
      ...(disk.model === undefined ? {} : { model: disk.model }),
      mountPoints: [
        ...new Set(disk.partitions.flatMap((partition) => partition.mountPoints)),
      ].sort(),
      name: disk.name,
      path: disk.path,
      sizeBytes: disk.sizeBytes,
      type: disk.type,
    })),
    evidence: projection.evidence.map((evidence) => ({
      collectedAt: evidence.collectedAt,
      ...(evidence.commandId === undefined ? {} : { commandId: evidence.commandId }),
      id: evidence.id,
      kind: evidence.kind,
      ...(evidence.message === undefined ? {} : { message: evidence.message }),
      sensitivity: evidence.sensitivity,
      source: evidence.source,
      status: evidence.status,
    })),
    findings: [...projection.findings],
    host: {
      ...(projection.host?.architecture === undefined
        ? {}
        : { architecture: projection.host.architecture }),
      ...(projection.host?.memory.availableBytes === undefined
        ? {}
        : { availableMemoryBytes: projection.host.memory.availableBytes }),
      ...(projection.host?.cpu.model === undefined ? {} : { cpuModel: projection.host.cpu.model }),
      ...(projection.host?.fqdn === undefined ? {} : { fqdn: projection.host.fqdn }),
      hostname: displayHost,
      ...(projection.host?.kernelVersion === undefined
        ? {}
        : { kernelVersion: projection.host.kernelVersion }),
      ...(projection.host?.cpu.logicalCores === undefined
        ? {}
        : { logicalCores: projection.host.cpu.logicalCores }),
      ...(projection.host?.operatingSystem.prettyName === undefined
        ? {}
        : { operatingSystem: projection.host.operatingSystem.prettyName }),
      ...(projection.host?.packageManager === undefined
        ? {}
        : { packageManager: projection.host.packageManager }),
      ...(projection.host?.cpu.physicalCores === undefined
        ? {}
        : { physicalCores: projection.host.cpu.physicalCores }),
      ...(projection.host?.memory.swapTotalBytes === undefined
        ? {}
        : { swapTotalBytes: projection.host.memory.swapTotalBytes }),
      ...(projection.host?.timezone === undefined ? {} : { timezone: projection.host.timezone }),
      ...(projection.host?.memory.totalBytes === undefined
        ? {}
        : { totalMemoryBytes: projection.host.memory.totalBytes }),
      ...(projection.host?.uptimeSeconds === undefined
        ? {}
        : { uptimeSeconds: projection.host.uptimeSeconds }),
      ...(projection.host?.virtualization === undefined
        ? {}
        : { virtualization: projection.host.virtualization }),
    },
    metadata: {
      displayHost,
      generatedAt,
      opsenseVersion: projection.session.opsenseVersion,
      scanId: projection.session.id,
      scannedAt,
      schemaVersion: projection.session.schemaVersion,
      state: projection.session.state,
      targetHost: projection.session.target.host,
      targetPort: projection.session.target.port,
      ...(projection.classificationProvider === undefined
        ? {}
        : { classificationProvider: projection.classificationProvider }),
      ...(projection.classificationCompleted === undefined
        ? {}
        : { classificationCompleted: projection.classificationCompleted }),
      ...(projection.session.target.user === undefined
        ? {}
        : { targetUser: projection.session.target.user }),
      title:
        projection.classificationProvider === 'codex' && projection.classificationCompleted === true
          ? `${displayHost} 服务器 Wiki 文档`
          : `${displayHost} 服务器巡检报告`,
    },
    mounts: (projection.storage?.mounts ?? []).map((mount) => {
      const percent = usagePercent(mount.usedBytes, mount.totalBytes);
      return {
        ...(mount.availableBytes === undefined ? {} : { availableBytes: mount.availableBytes }),
        evidenceIds: [...mount.evidenceIds],
        fileSystemType: mount.fileSystemType,
        network: mount.network,
        readOnly: mount.readOnly,
        source: mount.source,
        target: mount.target,
        ...(mount.totalBytes === undefined ? {} : { totalBytes: mount.totalBytes }),
        ...(percent === undefined ? {} : { usagePercent: percent }),
        ...(mount.usedBytes === undefined ? {} : { usedBytes: mount.usedBytes }),
      };
    }),
    network: {
      defaultRoutes: (projection.network?.routes ?? [])
        .filter((route) => route.isDefault)
        .map(
          (route) =>
            `${route.destination}${route.gateway === undefined ? '' : ` via ${route.gateway}`}${route.device === undefined ? '' : ` dev ${route.device}`}`,
        ),
      dnsServers: [...(projection.network?.dns.servers ?? [])],
      ...(projection.network?.firewall.active === undefined
        ? {}
        : { firewallActive: projection.network.firewall.active }),
      ...(projection.network?.firewall.backend === undefined
        ? {}
        : { firewallBackend: projection.network.firewall.backend }),
      interfaces: (projection.network?.interfaces ?? []).map((networkInterface) => ({
        addresses: networkInterface.addresses.map(
          (address) => `${address.address}/${address.prefixLength} (${address.classification})`,
        ),
        evidenceIds: [...networkInterface.evidenceIds],
        ...(networkInterface.macAddress === undefined
          ? {}
          : { macAddress: networkInterface.macAddress }),
        ...(networkInterface.mtu === undefined ? {} : { mtu: networkInterface.mtu }),
        name: networkInterface.name,
        ...(networkInterface.state === undefined ? {} : { state: networkInterface.state }),
      })),
      searchDomains: [...(projection.network?.dns.searchDomains ?? [])],
    },
    ...(projection.redaction === undefined ? {} : { redaction: projection.redaction }),
    services,
    summary: {
      artifactCount: projection.artifacts.length,
      containerCount: projection.containers.length,
      diskCount: projection.storage?.disks.length ?? 0,
      evidenceCount: projection.evidence.length,
      findingCount: projection.findings.length + (analysis?.findings.length ?? 0),
      interfaceCount: projection.network?.interfaces.length ?? 0,
      mountCount: projection.storage?.mounts.length ?? 0,
      needsReviewServiceCount: serviceIndex.filter(
        (service) => service.reportPlacement === 'needs_review',
      ).length,
      primaryServiceCount: serviceIndex.filter((service) => service.reportPlacement === 'primary')
        .length,
      runningServiceCount: services.filter((service) => service.status === 'running').length,
      serviceCount: serviceIndex.length,
      stoppedServiceCount: services.filter((service) => service.status === 'stopped').length,
      supportingServiceCount: serviceIndex.filter(
        (service) => service.reportPlacement === 'supporting',
      ).length,
      systemServiceCount: systemServiceRecords.length,
      unknownCount: projection.unknowns.length + (analysis?.unknowns.length ?? 0),
    },
    serviceIndex,
    systemServices: {
      attentionServices: systemServiceRecords.filter((service) => service.status === 'failed'),
      failedCount: systemServiceRecords.filter((service) => service.status === 'failed').length,
      runningCount: systemServiceRecords.filter((service) => service.status === 'running').length,
      totalCount: systemServiceRecords.length,
    },
    unknowns: [...projection.unknowns],
  };
  assertSchema(ReportModelSchema, model);
  return model;
}

function servicePathsForReport(
  projection: InventoryProjection,
  service: InventoryProjection['services'][number],
): {
  config: string[];
  data: string[];
  deploy: string[];
  environment: string[];
  log: string[];
} {
  if (projection.classificationProvider !== 'codex') {
    return {
      config: [...service.configFiles],
      data: [...service.dataDirectories],
      deploy: [...service.deployDirectories],
      environment: [...service.environmentFiles],
      log: [...service.logLocations],
    };
  }
  const assessments = (projection.pathAssessments ?? []).filter((item) =>
    item.serviceIds.includes(service.id),
  );
  const values = (semantic: (typeof assessments)[number]['semantic']): string[] => [
    ...new Set(assessments.filter((item) => item.semantic === semantic).map((item) => item.path)),
  ];
  const config = values('config');
  return {
    config,
    data: values('data'),
    deploy: values('deploy'),
    environment: service.environmentFiles.filter((item) => config.includes(item)),
    log: values('log'),
  };
}

function formatEndpoint(address: string, port: number): string {
  return address.includes(':') && !address.startsWith('[')
    ? `[${address}]:${port}`
    : `${address}:${port}`;
}

function usagePercent(
  usedBytes: number | undefined,
  totalBytes: number | undefined,
): number | undefined {
  if (usedBytes === undefined || totalBytes === undefined || totalBytes === 0) return undefined;
  return Math.min(100, Math.max(0, Number(((usedBytes / totalBytes) * 100).toFixed(1))));
}

function compareServices(left: ReportService, right: ReportService): number {
  const statusOrder = { failed: 0, running: 1, stopped: 2, unknown: 3 } as const;
  return (
    statusOrder[left.status] - statusOrder[right.status] || left.name.localeCompare(right.name)
  );
}
