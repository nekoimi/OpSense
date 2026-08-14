import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { redactForAiInput } from '@opsense/redaction';
import {
  AiAnalysisSchema,
  AiAnalysisProposalSchema,
  AiPlanProposalSchema,
  ProbeRequestSchema,
} from '@opsense/schema';
import type { AiPlan, ScanSnapshot } from '@opsense/schema';

export interface AiWorkspaceResult {
  files: string[];
  redactionReportFile: string;
}

export async function buildAiWorkspace(
  snapshot: ScanSnapshot,
  directory: string,
  now: () => Date = () => new Date(),
  baselinePlan?: AiPlan,
): Promise<AiWorkspaceResult> {
  const payloads = createWorkspacePayloads(snapshot);
  const redacted = redactForAiInput(payloads, now);
  const files = new Map<string, unknown | string>([
    ['context.md', contextMarkdown(snapshot)],
    ['host.json', redacted.value.host],
    ['storage.json', redacted.value.storage],
    ['network.json', redacted.value.network],
    ['service-candidates.json', redacted.value.services],
    ['path-candidates.json', redacted.value.paths],
    ['findings.json', redacted.value.findings],
    ['evidence-index.json', redacted.value.evidence],
    ['redaction-report.json', redacted.report],
    ['classification-schema.json', AiPlanProposalSchema],
    ['probe-plan-schema.json', { items: ProbeRequestSchema, type: 'array' }],
    ['analysis-schema.json', AiAnalysisSchema],
    ['analysis-proposal-schema.json', AiAnalysisProposalSchema],
    ...(baselinePlan === undefined
      ? []
      : [['baseline-plan.json', redactForAiInput(baselinePlan, now).value] as const]),
  ]);
  await mkdir(directory, { recursive: true });
  const written: string[] = [];
  for (const [name, value] of files) {
    const file = path.join(directory, name);
    const content = typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`;
    await chmod(file, 0o600).catch(() => undefined);
    await writeFile(file, content, { encoding: 'utf8', mode: 0o600 });
    await chmod(file, 0o444).catch(() => undefined);
    written.push(file);
  }
  return { files: written, redactionReportFile: path.join(directory, 'redaction-report.json') };
}

export function createWorkspacePayloads(snapshot: ScanSnapshot): Record<string, unknown> {
  const units = new Map(snapshot.systemdUnits.map((item) => [item.id, item]));
  const processes = new Map(snapshot.processes.map((item) => [item.pid, item]));
  const sockets = new Map(snapshot.sockets.map((item) => [item.id, item]));
  const containers = new Map(snapshot.containers.map((item) => [item.id, item]));
  const projects = new Map(snapshot.composeProjects.map((item) => [item.id, item]));
  const services = snapshot.services.map((service) => ({
    id: service.id,
    name: service.name,
    displayName: service.displayName,
    purpose: service.purpose,
    status: service.status,
    deploymentType: service.deploymentType,
    enabledAtBoot: service.enabledAtBoot,
    startCommand: service.startCommand,
    systemdUnits: service.systemdUnitIds.flatMap((id) => {
      const unit = units.get(id);
      return unit === undefined
        ? []
        : [
            {
              id,
              name: unit.name,
              description: unit.description,
              execStart: unit.execStart,
              fragmentPath: unit.fragmentPath,
              workingDirectory: unit.workingDirectory,
            },
          ];
    }),
    processes: service.processIds.flatMap((pid) => {
      const process = processes.get(pid);
      return process === undefined
        ? []
        : [
            {
              pid,
              command: process.command,
              executablePath: process.executablePath,
              workingDirectory: process.workingDirectory,
            },
          ];
    }),
    ports: service.socketIds.flatMap((id) => {
      const socket = sockets.get(id);
      return socket === undefined
        ? []
        : [
            {
              protocol: socket.protocol,
              address: socket.localAddress,
              port: socket.localPort,
              exposed: socket.exposed,
            },
          ];
    }),
    containers: service.containerIds.flatMap((id) => {
      const container = containers.get(id);
      return container === undefined
        ? []
        : [
            {
              id,
              name: container.name,
              image: container.image,
              state: container.state,
              mounts: container.mounts,
              ports: container.ports,
              labels: container.labels,
            },
          ];
    }),
    composeProjects: service.composeProjectIds.flatMap((id) => {
      const project = projects.get(id);
      return project === undefined
        ? []
        : [
            {
              id,
              name: project.name,
              workingDirectory: project.workingDirectory,
              configFiles: project.configFiles,
            },
          ];
    }),
    paths: {
      deploy: service.deployDirectories,
      config: service.configFiles,
      environment: service.environmentFiles,
      log: service.logLocations,
      data: service.dataDirectories,
    },
    confidence: service.confidence,
    evidenceIds: service.evidenceIds,
    unknownFields: service.unknownFields,
    conflictFields: service.conflictFields ?? [],
  }));
  const pathServices = new Map<string, Set<string>>();
  for (const service of snapshot.services) {
    for (const value of [
      ...service.deployDirectories,
      ...service.configFiles,
      ...service.environmentFiles,
      ...service.logLocations,
      ...service.dataDirectories,
    ]) {
      const ids = pathServices.get(value) ?? new Set<string>();
      ids.add(service.id);
      pathServices.set(value, ids);
    }
  }
  const allSemanticArtifacts = snapshot.artifacts
    .filter((item) => item.kind !== 'directory' && item.kind !== 'other')
    .sort(
      (left, right) =>
        artifactPriority(left.kind) - artifactPriority(right.kind) ||
        left.path.localeCompare(right.path),
    );
  const semanticArtifacts = allSemanticArtifacts.slice(0, 500);
  const pathValues = [
    ...new Set([
      ...(snapshot.pathSeeds ?? []).map((item) => item.path),
      ...semanticArtifacts.map((item) => item.path),
      ...pathServices.keys(),
    ]),
  ].sort();
  const pathItems = pathValues.map((value) => {
    const seed = snapshot.pathSeeds?.find((item) => item.path === value);
    const artifact = snapshot.artifacts.find((item) => item.path === value);
    return {
      path: value,
      serviceIds: [...(pathServices.get(value) ?? [])],
      kind: artifact?.kind,
      fileType: artifact?.fileType,
      exists: artifact?.exists,
      sizeBytes: artifact?.sizeBytes,
      evidenceIds: [
        ...new Set([
          ...(artifact?.evidenceIds ?? []),
          ...(seed?.sources.flatMap((item) => item.evidenceIds) ?? []),
        ]),
      ],
    };
  });
  const paths = {
    byService: snapshot.services.map((service) => ({
      serviceId: service.id,
      deploy: service.deployDirectories,
      config: service.configFiles,
      environment: service.environmentFiles,
      log: service.logLocations,
      data: service.dataDirectories,
      containerMounts: service.containerIds.flatMap((id) => containers.get(id)?.mounts ?? []),
      evidenceIds: service.evidenceIds,
    })),
    candidates: pathItems,
    omittedCandidateCount: Math.max(0, allSemanticArtifacts.length - semanticArtifacts.length),
    totalCandidateCount: pathItems.length,
  };
  return {
    evidence: snapshot.evidence.map((item) => ({
      id: item.id,
      kind: item.kind,
      source: item.source,
      field: item.field,
      status: item.status,
      collectedAt: item.collectedAt,
      sensitivity: item.sensitivity,
      commandId: item.commandId,
    })),
    findings: snapshot.findings,
    host: snapshot.host ?? null,
    network: snapshot.network ?? null,
    paths,
    services,
    storage: snapshot.storage ?? null,
  };
}

function artifactPriority(kind: string): number {
  return (
    { compose: 0, config: 1, environment: 2, executable: 3, script: 4, data: 5, log: 6, backup: 7 }[
      kind
    ] ?? 8
  );
}

function contextMarkdown(snapshot: ScanSnapshot): string {
  return `# OpSense Codex 分析上下文

- Scan ID: ${snapshot.session.id}
- Target: ${snapshot.session.target.host}:${snapshot.session.target.port}
- Schema: ${snapshot.session.schemaVersion}
- Service candidates: ${snapshot.services.length}
- Evidence records: ${snapshot.evidence.length}

只允许通过只读本地工具读取本目录中的脱敏 JSON。事实字段不可修改；不得访问网络、自行连接服务器或输出远程 Shell。所有补探测只能使用结构化 ProbeRequest，所有判断必须使用给定 JSON Schema，并引用现有 Evidence ID。\n`;
}
