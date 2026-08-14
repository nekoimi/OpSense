import { BaselineRelevanceClassifier, governAiPlan } from '@opsense/ai-provider';
import { ReportModelSchema, assertSchema } from '@opsense/schema';
import type { AiAnalysis, AiPlan, ReportModel, ReportService, ScanSnapshot } from '@opsense/schema';

export interface BuildReportModelOptions {
  analysis?: AiAnalysis;
  now?: () => Date;
}

export function buildReportModel(
  snapshot: ScanSnapshot,
  options: BuildReportModelOptions = {},
): ReportModel {
  const generatedAt = (options.now ?? (() => new Date()))().toISOString();
  const scannedAt = snapshot.session.finishedAt ?? snapshot.session.startedAt;
  const displayHost = snapshot.host?.hostname ?? snapshot.session.target.host;
  const socketById = new Map(snapshot.sockets.map((socket) => [socket.id, socket]));
  const containerById = new Map(snapshot.containers.map((container) => [container.id, container]));
  const analysis = options.analysis ?? snapshot.aiAnalysis;
  const baselinePlan = new BaselineRelevanceClassifier().classify(
    snapshot,
    () => new Date(generatedAt),
  );
  const plan =
    analysis === undefined
      ? baselinePlan
      : governAiPlan(snapshot, analysisPlan(analysis), baselinePlan, () => new Date(generatedAt));
  const assessmentByService = new Map(
    plan.serviceAssessments.map((assessment) => [assessment.serviceId, assessment]),
  );
  const serviceIndex = snapshot.services
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
      return {
        assessmentConfidence: assessment.confidence,
        assessmentReason: assessment.reason,
        confidence: service.confidence,
        configFiles: [...service.configFiles],
        conflictFields: [...(service.conflictFields ?? [])],
        dataDirectories: [...service.dataDirectories],
        deployDirectories: [...service.deployDirectories],
        deploymentType: service.deploymentType,
        ...(service.displayName === undefined ? {} : { displayName: service.displayName }),
        ...(service.enabledAtBoot === undefined ? {} : { enabledAtBoot: service.enabledAtBoot }),
        environmentFiles: [...service.environmentFiles],
        evidenceIds: [...service.evidenceIds],
        id: service.id,
        logLocations: [...service.logLocations],
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
    disks: (snapshot.storage?.disks ?? []).map((disk) => ({
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
    evidence: snapshot.evidence.map((evidence) => ({
      collectedAt: evidence.collectedAt,
      ...(evidence.commandId === undefined ? {} : { commandId: evidence.commandId }),
      id: evidence.id,
      kind: evidence.kind,
      ...(evidence.message === undefined ? {} : { message: evidence.message }),
      sensitivity: evidence.sensitivity,
      source: evidence.source,
      status: evidence.status,
    })),
    findings: [...snapshot.findings],
    host: {
      ...(snapshot.host?.architecture === undefined
        ? {}
        : { architecture: snapshot.host.architecture }),
      ...(snapshot.host?.memory.availableBytes === undefined
        ? {}
        : { availableMemoryBytes: snapshot.host.memory.availableBytes }),
      ...(snapshot.host?.cpu.model === undefined ? {} : { cpuModel: snapshot.host.cpu.model }),
      ...(snapshot.host?.fqdn === undefined ? {} : { fqdn: snapshot.host.fqdn }),
      hostname: displayHost,
      ...(snapshot.host?.kernelVersion === undefined
        ? {}
        : { kernelVersion: snapshot.host.kernelVersion }),
      ...(snapshot.host?.cpu.logicalCores === undefined
        ? {}
        : { logicalCores: snapshot.host.cpu.logicalCores }),
      ...(snapshot.host?.operatingSystem.prettyName === undefined
        ? {}
        : { operatingSystem: snapshot.host.operatingSystem.prettyName }),
      ...(snapshot.host?.packageManager === undefined
        ? {}
        : { packageManager: snapshot.host.packageManager }),
      ...(snapshot.host?.cpu.physicalCores === undefined
        ? {}
        : { physicalCores: snapshot.host.cpu.physicalCores }),
      ...(snapshot.host?.memory.swapTotalBytes === undefined
        ? {}
        : { swapTotalBytes: snapshot.host.memory.swapTotalBytes }),
      ...(snapshot.host?.timezone === undefined ? {} : { timezone: snapshot.host.timezone }),
      ...(snapshot.host?.memory.totalBytes === undefined
        ? {}
        : { totalMemoryBytes: snapshot.host.memory.totalBytes }),
      ...(snapshot.host?.uptimeSeconds === undefined
        ? {}
        : { uptimeSeconds: snapshot.host.uptimeSeconds }),
      ...(snapshot.host?.virtualization === undefined
        ? {}
        : { virtualization: snapshot.host.virtualization }),
    },
    metadata: {
      displayHost,
      generatedAt,
      opsenseVersion: snapshot.session.opsenseVersion,
      scanId: snapshot.session.id,
      scannedAt,
      schemaVersion: snapshot.session.schemaVersion,
      state: snapshot.session.state,
      targetHost: snapshot.session.target.host,
      targetPort: snapshot.session.target.port,
      ...(snapshot.session.target.user === undefined
        ? {}
        : { targetUser: snapshot.session.target.user }),
      title: `${displayHost} 服务器巡检报告`,
    },
    mounts: (snapshot.storage?.mounts ?? []).map((mount) => {
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
      defaultRoutes: (snapshot.network?.routes ?? [])
        .filter((route) => route.isDefault)
        .map(
          (route) =>
            `${route.destination}${route.gateway === undefined ? '' : ` via ${route.gateway}`}${route.device === undefined ? '' : ` dev ${route.device}`}`,
        ),
      dnsServers: [...(snapshot.network?.dns.servers ?? [])],
      ...(snapshot.network?.firewall.active === undefined
        ? {}
        : { firewallActive: snapshot.network.firewall.active }),
      ...(snapshot.network?.firewall.backend === undefined
        ? {}
        : { firewallBackend: snapshot.network.firewall.backend }),
      interfaces: (snapshot.network?.interfaces ?? []).map((networkInterface) => ({
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
      searchDomains: [...(snapshot.network?.dns.searchDomains ?? [])],
    },
    ...(snapshot.redaction === undefined ? {} : { redaction: snapshot.redaction }),
    services,
    summary: {
      artifactCount: snapshot.artifacts.length,
      containerCount: snapshot.containers.length,
      diskCount: snapshot.storage?.disks.length ?? 0,
      evidenceCount: snapshot.evidence.length,
      findingCount: snapshot.findings.length + (analysis?.findings.length ?? 0),
      interfaceCount: snapshot.network?.interfaces.length ?? 0,
      mountCount: snapshot.storage?.mounts.length ?? 0,
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
      unknownCount: snapshot.unknowns.length + (analysis?.unknowns.length ?? 0),
    },
    serviceIndex,
    systemServices: {
      attentionServices: systemServiceRecords.filter((service) => service.status === 'failed'),
      failedCount: systemServiceRecords.filter((service) => service.status === 'failed').length,
      runningCount: systemServiceRecords.filter((service) => service.status === 'running').length,
      totalCount: systemServiceRecords.length,
    },
    unknowns: [...snapshot.unknowns],
  };
  assertSchema(ReportModelSchema, model);
  return model;
}

function analysisPlan(analysis: AiAnalysis): AiPlan {
  return {
    generatedAt: analysis.generatedAt,
    pathAssessments: analysis.pathAssessments,
    probeRequests: [],
    provider: analysis.provider,
    serviceAssessments: analysis.serviceAssessments,
    ...(analysis.model === undefined ? {} : { model: analysis.model }),
    ...(analysis.threadId === undefined ? {} : { threadId: analysis.threadId }),
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
