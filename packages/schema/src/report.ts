import { Type, type Static } from '@sinclair/typebox';

import { AiAnalysisSchema, AiServiceRoleSchema, ReportPlacementSchema } from './ai.js';
import {
  AiConfidenceSchema,
  ConfidenceSchema,
  DateTimeSchema,
  IdSchema,
  NonEmptyStringSchema,
  ScanStateSchema,
  SensitivitySchema,
} from './common.js';
import { FindingRecordSchema } from './evidence.js';
import { RedactionReportSchema } from './redaction.js';
import { DeploymentTypeSchema, ServiceStatusSchema } from './service.js';

export const ReportMetadataSchema = Type.Object(
  {
    displayHost: NonEmptyStringSchema,
    generatedAt: DateTimeSchema,
    opsenseVersion: NonEmptyStringSchema,
    scanId: IdSchema,
    scannedAt: DateTimeSchema,
    schemaVersion: NonEmptyStringSchema,
    state: ScanStateSchema,
    targetHost: NonEmptyStringSchema,
    targetPort: Type.Integer({ minimum: 1, maximum: 65_535 }),
    targetUser: Type.Optional(NonEmptyStringSchema),
    title: NonEmptyStringSchema,
  },
  { additionalProperties: false },
);

export const ReportSummarySchema = Type.Object(
  {
    artifactCount: Type.Integer({ minimum: 0 }),
    containerCount: Type.Integer({ minimum: 0 }),
    diskCount: Type.Integer({ minimum: 0 }),
    evidenceCount: Type.Integer({ minimum: 0 }),
    findingCount: Type.Integer({ minimum: 0 }),
    interfaceCount: Type.Integer({ minimum: 0 }),
    mountCount: Type.Integer({ minimum: 0 }),
    primaryServiceCount: Type.Integer({ minimum: 0 }),
    runningServiceCount: Type.Integer({ minimum: 0 }),
    serviceCount: Type.Integer({ minimum: 0 }),
    stoppedServiceCount: Type.Integer({ minimum: 0 }),
    supportingServiceCount: Type.Integer({ minimum: 0 }),
    systemServiceCount: Type.Integer({ minimum: 0 }),
    needsReviewServiceCount: Type.Integer({ minimum: 0 }),
    unknownCount: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const ReportProfileSchema = Type.Union([
  Type.Literal('wiki'),
  Type.Literal('summary'),
  Type.Literal('audit'),
]);

export const ReportQualityIssueSchema = Type.Object(
  {
    code: NonEmptyStringSchema,
    message: NonEmptyStringSchema,
    severity: Type.Union([Type.Literal('error'), Type.Literal('warning')]),
    serviceId: Type.Optional(IdSchema),
    evidenceIds: Type.Array(IdSchema),
  },
  { additionalProperties: false },
);

export const ReportQualityResultSchema = Type.Object(
  {
    checkedAt: DateTimeSchema,
    issueCount: Type.Integer({ minimum: 0 }),
    issues: Type.Array(ReportQualityIssueSchema),
    passed: Type.Boolean(),
    profile: ReportProfileSchema,
  },
  { $id: 'ReportQualityResult', additionalProperties: false },
);

export const ReportHostSchema = Type.Object(
  {
    architecture: Type.Optional(Type.String()),
    availableMemoryBytes: Type.Optional(Type.Integer({ minimum: 0 })),
    cpuModel: Type.Optional(Type.String()),
    fqdn: Type.Optional(Type.String()),
    hostname: NonEmptyStringSchema,
    kernelVersion: Type.Optional(Type.String()),
    logicalCores: Type.Optional(Type.Integer({ minimum: 0 })),
    operatingSystem: Type.Optional(Type.String()),
    packageManager: Type.Optional(Type.String()),
    physicalCores: Type.Optional(Type.Integer({ minimum: 0 })),
    swapTotalBytes: Type.Optional(Type.Integer({ minimum: 0 })),
    timezone: Type.Optional(Type.String()),
    totalMemoryBytes: Type.Optional(Type.Integer({ minimum: 0 })),
    uptimeSeconds: Type.Optional(Type.Integer({ minimum: 0 })),
    virtualization: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const ReportDiskSchema = Type.Object(
  {
    evidenceIds: Type.Array(IdSchema),
    fileSystemTypes: Type.Array(Type.String()),
    model: Type.Optional(Type.String()),
    mountPoints: Type.Array(Type.String()),
    name: NonEmptyStringSchema,
    path: NonEmptyStringSchema,
    sizeBytes: Type.Integer({ minimum: 0 }),
    type: NonEmptyStringSchema,
  },
  { additionalProperties: false },
);

export const ReportMountSchema = Type.Object(
  {
    availableBytes: Type.Optional(Type.Integer({ minimum: 0 })),
    evidenceIds: Type.Array(IdSchema),
    fileSystemType: NonEmptyStringSchema,
    network: Type.Boolean(),
    readOnly: Type.Boolean(),
    source: NonEmptyStringSchema,
    target: NonEmptyStringSchema,
    totalBytes: Type.Optional(Type.Integer({ minimum: 0 })),
    usagePercent: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
    usedBytes: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

export const ReportNetworkInterfaceSchema = Type.Object(
  {
    addresses: Type.Array(Type.String()),
    evidenceIds: Type.Array(IdSchema),
    macAddress: Type.Optional(Type.String()),
    mtu: Type.Optional(Type.Integer({ minimum: 0 })),
    name: NonEmptyStringSchema,
    state: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const ReportNetworkSchema = Type.Object(
  {
    defaultRoutes: Type.Array(Type.String()),
    dnsServers: Type.Array(Type.String()),
    firewallActive: Type.Optional(Type.Boolean()),
    firewallBackend: Type.Optional(Type.String()),
    interfaces: Type.Array(ReportNetworkInterfaceSchema),
    searchDomains: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);

export const ReportServiceSchema = Type.Object(
  {
    assessmentConfidence: AiConfidenceSchema,
    assessmentReason: NonEmptyStringSchema,
    confidence: ConfidenceSchema,
    configFiles: Type.Array(Type.String()),
    conflictFields: Type.Array(Type.String()),
    dataDirectories: Type.Array(Type.String()),
    deployDirectories: Type.Array(Type.String()),
    deploymentType: DeploymentTypeSchema,
    displayName: Type.Optional(Type.String()),
    enabledAtBoot: Type.Optional(Type.Boolean()),
    environmentFiles: Type.Array(Type.String()),
    evidenceIds: Type.Array(IdSchema),
    id: IdSchema,
    logLocations: Type.Array(Type.String()),
    name: NonEmptyStringSchema,
    ports: Type.Array(Type.String()),
    processIds: Type.Array(Type.Integer({ minimum: 1 })),
    purpose: Type.Optional(Type.String()),
    reportPlacement: ReportPlacementSchema,
    role: AiServiceRoleSchema,
    startCommand: Type.Optional(Type.String()),
    status: ServiceStatusSchema,
    unknownFields: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);

export const ReportSystemServiceSummarySchema = Type.Object(
  {
    failedCount: Type.Integer({ minimum: 0 }),
    runningCount: Type.Integer({ minimum: 0 }),
    totalCount: Type.Integer({ minimum: 0 }),
    attentionServices: Type.Array(ReportServiceSchema),
  },
  { additionalProperties: false },
);

export const ReportEvidenceSchema = Type.Object(
  {
    collectedAt: DateTimeSchema,
    commandId: Type.Optional(Type.String()),
    id: IdSchema,
    kind: NonEmptyStringSchema,
    message: Type.Optional(Type.String()),
    sensitivity: SensitivitySchema,
    source: NonEmptyStringSchema,
    status: NonEmptyStringSchema,
  },
  { additionalProperties: false },
);

export const ReportModelSchema = Type.Object(
  {
    aiAnalysis: Type.Optional(AiAnalysisSchema),
    disks: Type.Array(ReportDiskSchema),
    evidence: Type.Array(ReportEvidenceSchema),
    findings: Type.Array(FindingRecordSchema),
    host: ReportHostSchema,
    metadata: ReportMetadataSchema,
    mounts: Type.Array(ReportMountSchema),
    network: ReportNetworkSchema,
    redaction: Type.Optional(RedactionReportSchema),
    services: Type.Array(ReportServiceSchema),
    serviceIndex: Type.Array(ReportServiceSchema),
    summary: ReportSummarySchema,
    systemServices: ReportSystemServiceSummarySchema,
    unknowns: Type.Array(Type.String()),
  },
  { $id: 'ReportModel', additionalProperties: false },
);

export type ReportDisk = Static<typeof ReportDiskSchema>;
export type ReportEvidence = Static<typeof ReportEvidenceSchema>;
export type ReportHost = Static<typeof ReportHostSchema>;
export type ReportMetadata = Static<typeof ReportMetadataSchema>;
export type ReportModel = Static<typeof ReportModelSchema>;
export type ReportMount = Static<typeof ReportMountSchema>;
export type ReportNetwork = Static<typeof ReportNetworkSchema>;
export type ReportNetworkInterface = Static<typeof ReportNetworkInterfaceSchema>;
export type ReportService = Static<typeof ReportServiceSchema>;
export type ReportSummary = Static<typeof ReportSummarySchema>;
export type ReportSystemServiceSummary = Static<typeof ReportSystemServiceSummarySchema>;
export type ReportProfile = Static<typeof ReportProfileSchema>;
export type ReportQualityIssue = Static<typeof ReportQualityIssueSchema>;
export type ReportQualityResult = Static<typeof ReportQualityResultSchema>;
