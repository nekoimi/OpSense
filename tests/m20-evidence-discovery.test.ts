import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  applyDiscoveryPlan,
  applyProjectionDecision,
  applyWikiNarrative,
  buildInventoryProjection,
} from '@opsense/projection';
import { ProbePlanValidator } from '@opsense/ai-provider';
import {
  ContextBuilder,
  ProbeGovernor,
  ToolRouter,
  createAgentSession,
} from '@opsense/agent-runtime';
import { buildEvidenceIndex } from '@opsense/discovery';
import { generateReportArtifacts } from '@opsense/report';
import type {
  AgentDecision,
  PlanDiscoveryArguments,
  ScanSnapshot,
  ServiceRecord,
} from '@opsense/schema';
import { buildServiceWikiProjection } from '@opsense/wiki';
import { describe, expect, it } from 'vitest';

import { readFixture } from './support/read-fixture.js';

describe('M20 evidence-driven discovery', () => {
  it('paginates the complete process, container, and systemd inventories for Codex', async () => {
    const snapshot = await snapshotWithServices();
    snapshot.processes = Array.from({ length: 25 }, (_, index) => ({
      ...redisProcess(),
      command: `/opt/application-${index}/server`,
      executablePath: `/opt/application-${index}/server`,
      id: `process:${1000 + index}`,
      pid: 1000 + index,
    }));
    snapshot.containers = Array.from({ length: 18 }, (_, index) => ({
      environmentKeys: [],
      evidenceIds: ['evidence:m20'],
      id: `container:${index}`,
      image: `example/application:${index}`,
      labels: {},
      mounts: [],
      name: `application-${index}`,
      networks: [],
      ports: [],
      runtime: 'docker' as const,
      state: 'running',
    }));
    snapshot.systemdUnits = Array.from({ length: 17 }, (_, index) => ({
      ...redisUnit(),
      id: `systemd:application-${index}.service`,
      mainPid: 1000 + index,
      name: `application-${index}.service`,
    }));
    const projection = buildInventoryProjection(snapshot, {
      mode: 'agent',
      workflowVersion: 'm20_evidence_driven',
    });
    const context = new ContextBuilder({ projection });

    expect(context.readSection('processes', 12, 12)).toHaveLength(12);
    expect(context.readSection('processes', 24, 12)).toMatchObject([{ id: 'process:1024' }]);
    expect(context.readSection('containers', 12, 12)).toHaveLength(6);
    expect(context.readSection('systemd_units', 12, 12)).toHaveLength(5);
  });

  it('keeps a systemd Redis listener visible when Compose candidates fill the first page', async () => {
    const snapshot = await snapshotWithServices();
    const composeSeed = snapshot.services[1]!;
    const composeServices = Array.from({ length: 30 }, (_, index) => ({
      ...structuredClone(composeSeed),
      composeProjectIds: [`compose:project-${index}`],
      deployDirectories: [],
      deploymentType: 'compose' as const,
      id: `service:compose:application-${index}`,
      name: `application-${index}`,
    }));
    snapshot.services = [...composeServices, redisService()];
    snapshot.processes = [redisProcess()];
    snapshot.sockets = [redisSocket()];
    snapshot.systemdUnits = [redisUnit()];
    const projection = buildInventoryProjection(snapshot, {
      mode: 'agent',
      workflowVersion: 'm20_evidence_driven',
    });
    const context = new ContextBuilder({
      evidenceIndex: buildEvidenceIndex(projection),
      projection,
    });

    const built = context.build({ budget: {}, round: 1, stage: 'bootstrapping' });
    const visibleIds = (built.l1.services as { id: string }[]).map((item) => item.id);

    expect(visibleIds).toContain('service:systemd:redis-server.service');
    expect(built.l0.counts).toMatchObject({ candidates: 31, candidatesOmitted: 19 });
    expect(built.l1.discovery).toMatchObject({
      highValueLeadCounts: {
        total: 31,
        byDeploymentType: { compose: 30, systemd: 1 },
      },
    });
  });

  it('rejects a completed discovery plan that omits a listening systemd service', async () => {
    const snapshot = await snapshotWithServices();
    snapshot.services.push(redisService());
    snapshot.processes = [redisProcess()];
    snapshot.sockets = [redisSocket()];
    snapshot.systemdUnits = [redisUnit()];
    const projection = buildInventoryProjection(snapshot, {
      mode: 'agent',
      workflowVersion: 'm20_evidence_driven',
    });

    expect(() => applyDiscoveryPlan(projection, discoveryPlan(true, 'resolved'))).toThrow(
      'service:systemd:redis-server.service',
    );
  });

  it('reopens an older completed workspace when a required systemd service was not selected', async () => {
    const snapshot = await snapshotWithServices();
    const previous = buildInventoryProjection(snapshot, {
      mode: 'agent',
      workflowVersion: 'm20_evidence_driven',
    });
    applyDiscoveryPlan(previous, discoveryPlan(false, 'investigating'));
    applyProjectionDecision(previous, serviceDecision('service:order-api'));
    applyDiscoveryPlan(previous, discoveryPlan(true, 'resolved'));
    expect(previous.classificationCompleted).toBe(true);

    snapshot.services.push(redisService());
    snapshot.processes = [redisProcess()];
    snapshot.sockets = [redisSocket()];
    snapshot.systemdUnits = [redisUnit()];
    const rebuilt = buildInventoryProjection(snapshot, {
      mode: 'agent',
      previousProjection: previous,
      workflowVersion: 'm20_evidence_driven',
    });

    expect(rebuilt.classificationCompleted).toBe(false);
    expect(rebuilt.discoveryWorkspace).toMatchObject({
      discoveryCompleted: false,
      planningCompleted: false,
    });
    expect(rebuilt.candidateServiceCount).toBe(1);
  });

  it('presents active investigations as a twelve-service evidence batch', async () => {
    const snapshot = await snapshotWithServices();
    const seed = snapshot.services[1]!;
    snapshot.services = Array.from({ length: 15 }, (_, index) => ({
      ...structuredClone(seed),
      deployDirectories: [`/opt/application-${index}`],
      id: `service:application-${index}`,
      name: `application-${index}`,
    }));
    const projection = buildInventoryProjection(snapshot, {
      mode: 'agent',
      workflowVersion: 'm20_evidence_driven',
    });
    const serviceIds = snapshot.services.map((item) => item.id);
    applyDiscoveryPlan(projection, {
      discoveryCompleted: false,
      discoveredServices: [],
      filteredGroups: [],
      investigations: [
        {
          evidenceIds: ['evidence:m20'],
          investigationId: 'investigation:applications',
          label: '应用服务批次',
          priority: 'high',
          reason: '批量检查具有自定义部署路径的应用服务。',
          serviceIds,
          sourceObjectIds: serviceIds,
          status: 'investigating',
        },
      ],
      planningCompleted: true,
      reason: '建立应用服务批量调查计划。',
      unresolvedQuestions: [],
    });

    const context = new ContextBuilder({ projection });
    const built = context.build({ budget: {}, round: 1, stage: 'investigating' });

    expect(built.l0.counts).toMatchObject({ candidatesShown: 12, candidatesOmitted: 3 });
    expect(built.l1.services).toHaveLength(12);
    expect(context.readSection('services', 3, 12)).toHaveLength(12);
  });

  it('discards the legacy full-review queue when migrating an M19 projection', async () => {
    const snapshot = await snapshotWithServices();
    const legacy = buildInventoryProjection(snapshot, {
      mode: 'agent',
      workflowVersion: 'm19_full_candidate_review',
    });
    applyProjectionDecision(legacy, serviceDecision('service:system-helper'));

    expect(legacy.reviewedServiceIds).toContain('service:system-helper');
    expect(legacy.serviceAssessments.length).toBeGreaterThan(0);

    const migrated = buildInventoryProjection(snapshot, {
      mode: 'agent',
      previousProjection: legacy,
      workflowVersion: 'm20_evidence_driven',
    });

    expect(migrated.discoveryWorkspace?.workflowVersion).toBe('m20_evidence_driven');
    expect(migrated.candidateServiceCount).toBe(0);
    expect(migrated.reviewedServiceCount).toBe(0);
    expect(migrated.reviewedServiceIds).toEqual([]);
    expect(migrated.serviceAssessments).toEqual([]);
    expect(migrated.pathAssessments).toEqual([]);
    expect(migrated.classificationThreadId).toBeUndefined();
  });

  it('keeps raw services out of the review queue until Codex selects an investigation', async () => {
    const snapshot = await snapshotWithServices();
    const projection = buildInventoryProjection(snapshot, {
      mode: 'agent',
      workflowVersion: 'm20_evidence_driven',
    });

    expect(projection.services).toHaveLength(2);
    expect(projection.serviceAssessments).toEqual([]);
    expect(projection.candidateServiceCount).toBe(0);
    expect(projection.discoveryWorkspace).toMatchObject({
      discoveryCompleted: false,
      planningCompleted: false,
      workflowVersion: 'm20_evidence_driven',
    });

    const plan = discoveryPlan(false, 'selected');
    applyDiscoveryPlan(projection, plan, { threadId: 'codex-thread-m20' });

    expect(projection.candidateServiceCount).toBe(1);
    expect(projection.discoveryWorkspace?.filteredGroups).toHaveLength(1);
    expect(projection.discoveryWorkspace?.filteredGroups[0]?.sourceObjectIds).toEqual([
      'service:system-helper',
    ]);
    expect(() =>
      applyProjectionDecision(projection, serviceDecision('service:system-helper')),
    ).toThrow('尚未进入 Codex 调查工作区');
  });

  it('renders only Codex-selected and assessed services in an M20 Wiki', async () => {
    const projection = buildInventoryProjection(await snapshotWithServices(), {
      mode: 'agent',
      workflowVersion: 'm20_evidence_driven',
    });
    applyDiscoveryPlan(projection, discoveryPlan(false, 'investigating'));
    applyProjectionDecision(projection, serviceDecision('service:order-api'));
    applyDiscoveryPlan(projection, discoveryPlan(true, 'resolved'));

    expect(projection.classificationCompleted).toBe(true);
    expect(buildServiceWikiProjection(projection).serviceIds).toEqual(['service:order-api']);
  });

  it('generates an M20 report after all Codex-selected services are reviewed', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'opsense-m20-report-'));
    try {
      const projection = buildInventoryProjection(await snapshotWithServices(), {
        mode: 'agent',
        workflowVersion: 'm20_evidence_driven',
      });
      applyDiscoveryPlan(projection, discoveryPlan(false, 'investigating'), {
        threadId: 'codex-thread-m20-planning',
      });
      applyProjectionDecision(projection, serviceDecision('service:order-api'), {
        threadId: 'codex-thread-m20-classification',
      });
      applyDiscoveryPlan(projection, discoveryPlan(true, 'resolved'), {
        threadId: 'codex-thread-m20-final',
      });
      applyWikiNarrative(projection, wikiNarrative(['service:order-api']), {
        threadId: 'codex-thread-m20-composition',
      });

      const artifacts = await generateReportArtifacts(projection, {
        formats: [],
        outputDirectory: root,
        requireCodexClassification: true,
      });

      expect(projection.services).toHaveLength(2);
      expect(projection.reviewedServiceCount).toBe(1);
      expect(artifacts.quality.passed).toBe(true);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it('rejects an M20 report while a Codex-selected service remains unreviewed', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'opsense-m20-incomplete-report-'));
    try {
      const projection = buildInventoryProjection(await snapshotWithServices(), {
        mode: 'agent',
        workflowVersion: 'm20_evidence_driven',
      });
      applyDiscoveryPlan(projection, discoveryPlan(true, 'resolved'), {
        threadId: 'codex-thread-m20-incomplete',
      });

      await expect(
        generateReportArtifacts(projection, {
          formats: [],
          outputDirectory: root,
          requireCodexClassification: true,
        }),
      ).rejects.toThrow('服务 0/1');
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it('rejects an AI Wiki narrative that invents Evidence IDs', async () => {
    const projection = buildInventoryProjection(await snapshotWithServices(), {
      mode: 'agent',
      workflowVersion: 'm20_evidence_driven',
    });
    applyDiscoveryPlan(projection, discoveryPlan(false, 'investigating'));
    applyProjectionDecision(projection, serviceDecision('service:order-api'));
    applyDiscoveryPlan(projection, discoveryPlan(true, 'resolved'), {
      threadId: 'codex-thread-m20-final',
    });
    const narrative = wikiNarrative(['service:order-api']);
    narrative.serviceDescriptions[0]!.evidenceIds = ['evidence:invented'];

    expect(() =>
      applyWikiNarrative(projection, narrative, { threadId: 'codex-thread-m20-composition' }),
    ).toThrow('不存在的 Evidence ID');
  });

  it('includes service and image identities in the final Wiki composition source', async () => {
    const snapshot = await snapshotWithServices();
    snapshot.services[1] = {
      ...snapshot.services[1]!,
      containerIds: ['container:minio'],
      id: 'service:minio',
      name: 'minio',
    };
    snapshot.containers = [
      {
        environmentKeys: [],
        evidenceIds: ['evidence:m20'],
        id: 'container:minio',
        image: 'minio/minio:RELEASE.2026-08-01',
        labels: {},
        mounts: [],
        name: 'minio',
        networks: [],
        ports: [
          {
            containerPort: 9000,
            hostAddress: '0.0.0.0',
            hostPort: 9000,
            protocol: 'tcp',
          },
        ],
        runtime: 'docker',
        state: 'running',
      },
    ];
    const projection = buildInventoryProjection(snapshot, {
      mode: 'agent',
      workflowVersion: 'm20_evidence_driven',
    });
    const plan = discoveryPlan(false, 'investigating');
    plan.investigations[0]!.serviceIds = ['service:minio'];
    plan.investigations[0]!.sourceObjectIds = ['service:minio'];
    applyDiscoveryPlan(projection, plan);
    applyProjectionDecision(projection, serviceDecision('service:minio'));
    plan.discoveryCompleted = true;
    plan.investigations[0]!.status = 'resolved';
    applyDiscoveryPlan(projection, plan, { threadId: 'codex-thread-minio' });

    const source = new ContextBuilder({ projection }).build({
      budget: {},
      round: 1,
      stage: 'composing',
    }).l1.wiki_source;

    expect(JSON.stringify(source)).toContain('minio/minio:RELEASE.2026-08-01');
    expect(JSON.stringify(source)).toContain('service:minio');
  });

  it('allows governed probes only for services selected by the Codex investigation plan', async () => {
    const snapshot = await snapshotWithServices();
    const projection = buildInventoryProjection(snapshot, {
      mode: 'agent',
      workflowVersion: 'm20_evidence_driven',
    });
    applyDiscoveryPlan(projection, discoveryPlan(false, 'investigating'));
    const session = createAgentSession({
      scanId: snapshot.session.id,
      workflowVersion: 'm20_evidence_driven',
    });
    const router = new ToolRouter({
      context: new ContextBuilder({ projection }),
      governor: new ProbeGovernor({ snapshot, session }),
      projection,
    });
    router.setSession(session);

    const result = await router.execute(
      'execute_governed_probe',
      {
        request: {
          evidenceIds: ['evidence:m20'],
          expectedFields: ['directory metadata'],
          id: 'probe:m20-unselected',
          kind: 'directory_metadata',
          maxBytes: 1024,
          path: '/tmp',
          reason: 'should be rejected before execution',
          targetServiceId: 'service:system-helper',
          timeoutMs: 1000,
        },
      },
      'turn:m20-probe',
    );

    expect(result.status).toBe('failed');
    expect(result.summary).toContain('尚未进入 Codex 调查工作区');
  });

  it('executes a batch of governed probes through the existing safety governor', async () => {
    const snapshot = await snapshotWithServices();
    const projection = buildInventoryProjection(snapshot, {
      mode: 'agent',
      workflowVersion: 'm20_evidence_driven',
    });
    applyDiscoveryPlan(projection, discoveryPlan(false, 'investigating'));
    const session = createAgentSession({
      scanId: snapshot.session.id,
      workflowVersion: 'm20_evidence_driven',
    });
    const executed: string[] = [];
    const reconciled: string[] = [];
    const router = new ToolRouter({
      context: new ContextBuilder({ projection }),
      governor: new ProbeGovernor({
        snapshot,
        session,
        executor: {
          execute: async (request) => {
            executed.push(request.id);
            return {
              evidenceIds: ['evidence:m20'],
              reason: `已执行 ${request.id}。`,
              status: 'completed',
            };
          },
        },
        reconcile: (request) => {
          reconciled.push(request.id);
        },
      }),
      projection,
    });
    router.setSession(session);

    const result = await router.execute(
      'execute_governed_probe',
      {
        requests: [
          {
            evidenceIds: ['evidence:m20'],
            expectedFields: ['directory metadata'],
            id: 'probe:m20-directory-metadata',
            kind: 'directory_metadata',
            maxBytes: 4096,
            path: '/opt/order-api',
            reason: '确认应用部署目录元数据。',
            targetServiceId: 'service:order-api',
            timeoutMs: 1000,
          },
          {
            evidenceIds: ['evidence:m20'],
            expectedFields: ['directory entries'],
            id: 'probe:m20-directory-listing',
            kind: 'directory_listing',
            maxBytes: 4096,
            maxDepth: 2,
            maxMatches: 20,
            path: '/opt/order-api',
            reason: '确认应用部署目录结构。',
            targetServiceId: 'service:order-api',
            timeoutMs: 1000,
          },
        ],
      },
      'turn:m20-probe-batch',
    );

    expect(result.status).toBe('completed');
    expect(result.summary).toContain('2/2');
    expect(executed).toHaveLength(2);
    expect(reconciled).toEqual(executed);
    expect(session.budgets.usedRequests).toBe(2);
  });

  it('validates runtime probes against the target service evidence', async () => {
    const snapshot = await snapshotWithServices();
    snapshot.systemdUnits = [
      {
        activeState: 'active',
        environmentFiles: [],
        evidenceIds: ['evidence:m20'],
        execReload: [],
        execStart: ['/opt/order-api/start'],
        fragmentPath: '/etc/systemd/system/order-api.service',
        id: 'systemd:order-api.service',
        name: 'order-api.service',
        subState: 'running',
      },
    ];
    snapshot.services[1]!.systemdUnitIds = ['systemd:order-api.service'];
    const request = {
      evidenceIds: ['evidence:m20'],
      expectedFields: ['unit state'],
      id: 'probe:m20-unit',
      kind: 'systemd_unit' as const,
      maxBytes: 4096,
      reason: 'confirm unit state',
      targetServiceId: 'service:order-api',
      timeoutMs: 1000,
      unitName: 'order-api.service',
    };
    const invalid = { ...request, targetServiceId: 'service:system-helper' };

    const result = new ProbePlanValidator().validate(snapshot, [request, invalid]);

    expect(result.accepted).toEqual([request]);
    expect(result.audit.records[1]?.reason).toContain('不属于目标服务');
  });

  it('creates a Codex-discovered service from existing raw evidence objects', async () => {
    const projection = buildInventoryProjection(await snapshotWithServices(), {
      mode: 'agent',
      workflowVersion: 'm20_evidence_driven',
    });
    const plan = discoveryPlan(false, 'investigating');
    plan.discoveredServices = [
      {
        deploymentType: 'process',
        evidenceIds: ['evidence:m20'],
        name: 'custom-order-worker',
        reason: '原始服务记录关联的启动线索需要作为独立部署单元追踪。',
        serviceId: 'service:agent:custom-order-worker',
        sourceObjectIds: ['service:order-api'],
        status: 'running',
        unknownFields: ['configFiles', 'logLocations'],
      },
    ];
    plan.investigations = [
      {
        evidenceIds: ['evidence:m20'],
        investigationId: 'investigation:custom-order-worker',
        label: '自定义订单工作进程',
        priority: 'high',
        reason: '需要确认自定义工作进程的用途与运行目录。',
        serviceIds: ['service:agent:custom-order-worker'],
        sourceObjectIds: ['service:order-api'],
        status: 'investigating',
      },
    ];

    applyDiscoveryPlan(projection, plan);

    expect(
      projection.services.find((item) => item.id === 'service:agent:custom-order-worker'),
    ).toMatchObject({
      deploymentType: 'process',
      name: 'custom-order-worker',
      unknownFields: ['configFiles', 'logLocations'],
    });
  });
});

async function snapshotWithServices(): Promise<ScanSnapshot> {
  const snapshot = JSON.parse(await readFixture('schema/minimal-snapshot.json')) as ScanSnapshot;
  snapshot.evidence = [
    {
      collectedAt: '2026-08-17T02:00:00.000Z',
      id: 'evidence:m20',
      kind: 'derived',
      opsenseVersion: '0.1.0',
      sensitivity: 'internal',
      source: 'service.normalization',
      status: 'success',
    },
  ];
  snapshot.services = [service('system-helper', []), service('order-api', ['/opt/order-api'])];
  return snapshot;
}

function service(name: string, deployDirectories: string[]): ServiceRecord {
  return {
    composeProjectIds: [],
    confidence: 'inferred',
    configFiles: [],
    containerIds: [],
    dataDirectories: [],
    deployDirectories,
    deploymentType: 'systemd',
    environmentFiles: [],
    evidenceIds: ['evidence:m20'],
    id: `service:${name}`,
    logLocations: [],
    name,
    processIds: [],
    socketIds: [],
    status: 'running',
    systemdUnitIds: [],
    unknownFields: [],
  };
}

function redisService(): ServiceRecord {
  return {
    ...service('redis-server', []),
    configFiles: ['/etc/redis/redis.conf'],
    dataDirectories: ['/var/lib/redis'],
    id: 'service:systemd:redis-server.service',
    name: 'redis-server',
    processIds: [1182],
    socketIds: ['socket:tcp-ipv4-0.0.0.0-6379'],
    systemdUnitIds: ['systemd:redis-server.service'],
  };
}

function redisProcess() {
  return {
    arguments: ['/etc/redis/redis.conf', '--supervised', 'systemd', '--daemonize', 'no'],
    cgroup: '0::/system.slice/redis-server.service',
    command: '/usr/bin/redis-server /etc/redis/redis.conf --supervised systemd --daemonize no',
    evidenceIds: ['evidence:m20'],
    executablePath: '/usr/bin/redis-server',
    id: 'process:1182',
    pid: 1182,
  };
}

function redisSocket() {
  return {
    containerIds: [],
    evidenceIds: ['evidence:m20'],
    exposed: true,
    family: 'ipv4' as const,
    id: 'socket:tcp-ipv4-0.0.0.0-6379',
    listening: true,
    localAddress: '0.0.0.0',
    localPort: 6379,
    processIds: [1182],
    processNames: ['redis-server'],
    protocol: 'tcp' as const,
  };
}

function redisUnit() {
  return {
    activeState: 'active',
    environmentFiles: [],
    evidenceIds: ['evidence:m20'],
    execReload: [],
    execStart: ['/usr/bin/redis-server /etc/redis/redis.conf --supervised systemd --daemonize no'],
    fragmentPath: '/lib/systemd/system/redis-server.service',
    id: 'systemd:redis-server.service',
    mainPid: 1182,
    name: 'redis-server.service',
    subState: 'running',
  };
}

function discoveryPlan(
  discoveryCompleted: boolean,
  status: 'selected' | 'investigating' | 'resolved',
): PlanDiscoveryArguments {
  return {
    discoveryCompleted,
    discoveredServices: [],
    filteredGroups: [
      {
        evidenceIds: ['evidence:m20'],
        groupId: 'discovery-group:system-units',
        label: '常规系统辅助服务',
        reason: '没有端口、容器或自定义路径线索。',
        resourceClass: 'routine_system_service',
        sourceObjectIds: ['service:system-helper'],
      },
    ],
    investigations: [
      {
        evidenceIds: ['evidence:m20'],
        investigationId: 'investigation:order-api',
        label: '订单应用',
        priority: 'high',
        reason: '自定义部署目录需要确认服务用途。',
        serviceIds: ['service:order-api'],
        sourceObjectIds: ['service:order-api'],
        status,
      },
    ],
    planningCompleted: true,
    reason: '根据原始证据筛选系统辅助服务与业务部署线索。',
    unresolvedQuestions: [],
  };
}

function serviceDecision(serviceId: string): Extract<AgentDecision, { kind: 'projection_update' }> {
  return {
    changes: [
      {
        assessment: {
          confidence: 'inferred',
          evidenceIds: ['evidence:m20'],
          importance: 'high',
          purpose: '处理订单请求。',
          reason: '自定义部署目录与服务归一化证据对应。',
          reportPlacement: 'primary',
          reviewItems: [],
          role: 'application',
          serviceId,
          unknowns: [],
        },
        changeType: 'service_assessment',
        objectId: serviceId,
        operation: 'update',
        summary: '确认服务语义。',
      },
    ],
    decisionId: 'decision:m20',
    evidenceIds: ['evidence:m20'],
    kind: 'projection_update',
    nextAction: 'continue',
    nextSuggestions: [],
    reason: '应用 Codex 服务调查结论。',
    turnId: 'turn:m20',
    unresolvedQuestions: [],
  };
}

function wikiNarrative(serviceIds: string[]) {
  return {
    architectureOverview: '订单应用以独立服务形式部署，现有证据未确认更多依赖关系。',
    deploymentOverview: '应用部署目录位于 /opt/order-api，路径角色来自 Codex 证据审查。',
    executiveSummary: '该服务器运行订单应用，并保留可追溯的部署与运行证据。',
    keyFindings: [],
    operationsOverview: '运维时应优先核对应用状态、配置路径和数据备份策略。',
    serviceDescriptions: serviceIds.map((serviceId) => ({
      basis: '服务名称与部署目录证据。',
      description: '订单应用服务，负责承载订单相关请求和业务处理。',
      evidenceIds: ['evidence:m20'],
      serviceId,
    })),
    serviceGroups: [
      {
        serviceIds,
        summary: '订单业务应用服务。',
        title: '业务应用',
      },
    ],
    systemOverview: '服务器提供订单应用运行环境。',
    unresolvedQuestions: [],
  };
}
