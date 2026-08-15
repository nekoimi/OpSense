import { ReportQualityResultSchema, assertSchema } from '@opsense/schema';
import type { InventoryProjection, ReportModel, ServiceWikiProjection } from '@opsense/schema';

export type ReportProfile = 'wiki' | 'summary' | 'audit';
export type QualityIssueSeverity = 'error' | 'warning';

export interface ReportQualityIssue {
  code: string;
  message: string;
  severity: QualityIssueSeverity;
  serviceId?: string;
  evidenceIds: string[];
}

export interface ReportQualityResult {
  checkedAt: string;
  issueCount: number;
  issues: ReportQualityIssue[];
  passed: boolean;
  profile: ReportProfile;
}

export interface ReportQualityOptions {
  now?: () => Date;
  profile?: ReportProfile;
}

const CONTAINER_INTERFACE_PATTERN = /^(?:docker\d*|br-[a-f0-9]+|veth|cni|flannel|cali|tunl)/i;
const RUNTIME_MOUNT_PATTERN =
  /(?:overlay2|containers\/storage|containerd|podman|docker\/containers)/i;
const PSEUDO_MOUNT_PATTERN = /^\/(?:proc|sys|dev|run)(?:\/|$)/;

export function evaluateReportQuality(
  projection: InventoryProjection,
  model: ReportModel,
  wiki: ServiceWikiProjection,
  options: ReportQualityOptions = {},
): ReportQualityResult {
  const issues: ReportQualityIssue[] = [];
  const profile = options.profile ?? 'wiki';
  const now = options.now ?? (() => new Date());
  const add = (
    code: string,
    message: string,
    severity: QualityIssueSeverity,
    evidenceIds: readonly string[] = [],
    serviceId?: string,
  ): void => {
    issues.push({
      code,
      evidenceIds: [...new Set(evidenceIds)],
      message,
      severity,
      ...(serviceId === undefined ? {} : { serviceId }),
    });
  };

  for (const item of model.network.interfaces) {
    if (CONTAINER_INTERFACE_PATTERN.test(item.name))
      add(
        'CONTAINER_NETWORK_NOISE',
        `报告正文包含容器网络接口：${item.name}。`,
        'error',
        item.evidenceIds,
      );
  }
  for (const item of model.mounts) {
    if (
      RUNTIME_MOUNT_PATTERN.test(`${item.source} ${item.target}`) ||
      PSEUDO_MOUNT_PATTERN.test(item.target)
    )
      add(
        'RUNTIME_MOUNT_NOISE',
        `报告正文包含运行时或伪文件系统挂载：${item.target}。`,
        'error',
        item.evidenceIds,
      );
  }

  const visibleServiceIds = new Set(model.services.map((item) => item.id));
  for (const item of model.services) {
    if (item.role === 'system' || item.reportPlacement === 'system_summary')
      add(
        'SYSTEM_SERVICE_EXPANDED',
        `普通系统服务不应逐条出现在服务正文：${item.name}。`,
        'error',
        item.evidenceIds,
        item.id,
      );
    if (item.reportPlacement === 'primary' || item.reportPlacement === 'supporting') {
      if (item.purpose === undefined || item.purpose.length === 0)
        add(
          'SERVICE_PURPOSE_MISSING',
          `主要服务缺少用途摘要：${item.name}。`,
          'warning',
          item.evidenceIds,
          item.id,
        );
      if (item.status.length === 0 || item.deploymentType.length === 0)
        add(
          'SERVICE_FACT_MISSING',
          `服务缺少状态或部署方式：${item.name}。`,
          'error',
          item.evidenceIds,
          item.id,
        );
      if (item.evidenceIds.length === 0)
        add(
          'SERVICE_EVIDENCE_MISSING',
          `主要服务没有 Evidence ID：${item.name}。`,
          'error',
          [],
          item.id,
        );
    }
    if (item.startCommand !== undefined && item.evidenceIds.length === 0)
      add(
        'LIFECYCLE_EVIDENCE_MISSING',
        `生命周期命令没有证据门禁：${item.name}。`,
        'error',
        [],
        item.id,
      );
    for (const port of item.ports) {
      if (item.evidenceIds.length === 0)
        add(
          'PORT_EVIDENCE_MISSING',
          `端口无法关联主机暴露面的证据：${item.name} ${port}。`,
          'error',
          [],
          item.id,
        );
    }
    for (const unknown of item.unknownFields) {
      if (!model.unknowns.includes(unknown))
        add(
          'UNKNOWN_NOT_SURFACED',
          `服务未知字段未进入 unknowns/reviewItems：${item.name} / ${unknown}。`,
          'error',
          item.evidenceIds,
          item.id,
        );
    }
  }
  for (const item of wiki.entries) {
    if (!visibleServiceIds.has(item.serviceId)) continue;
    if (
      item.confidence === 'confirmed' &&
      item.confirmedFacts.some((claim) => claim.evidenceIds.length === 0)
    )
      add(
        'CONFIRMED_CLAIM_WITHOUT_EVIDENCE',
        `确定性 Wiki 结论缺少 Evidence ID：${item.identity.name}。`,
        'error',
        item.evidence.evidenceIds,
        item.serviceId,
      );
    if (
      item.unknowns.length > 0 &&
      !item.reviewItems.some((review) => review.includes('确认') || review.includes('证据'))
    )
      add(
        'UNKNOWN_NOT_REVIEWABLE',
        `Wiki 未知项没有对应待确认事项：${item.identity.name}。`,
        'warning',
        item.evidence.evidenceIds,
        item.serviceId,
      );
  }
  for (const finding of model.findings) {
    if (finding.confidence === 'confirmed' && finding.evidenceIds.length === 0)
      add('FINDING_EVIDENCE_MISSING', `确定性发现缺少 Evidence ID：${finding.title}。`, 'error');
  }
  if (profile === 'audit' && projection.evidence.length === 0)
    add('AUDIT_EVIDENCE_EMPTY', '审计 profile 没有可交叉引用的 Evidence。', 'error');

  const result: ReportQualityResult = {
    checkedAt: now().toISOString(),
    issueCount: issues.length,
    issues,
    passed: issues.every((item) => item.severity !== 'error'),
    profile,
  };
  assertSchema(ReportQualityResultSchema, result);
  return result;
}

export function assertReportQuality(result: ReportQualityResult): void {
  const errors = result.issues.filter((item) => item.severity === 'error');
  if (errors.length > 0)
    throw new Error(`报告质量门禁失败：${errors.map((item) => item.message).join('；')}`);
}
