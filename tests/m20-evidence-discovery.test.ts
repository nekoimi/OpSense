import {
  applyDiscoveryPlan,
  applyProjectionDecision,
  buildInventoryProjection,
} from '@opsense/projection';
import { ProbePlanValidator } from '@opsense/ai-provider';
import {
  ContextBuilder,
  ProbeGovernor,
  ToolRouter,
  createAgentSession,
} from '@opsense/agent-runtime';
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
