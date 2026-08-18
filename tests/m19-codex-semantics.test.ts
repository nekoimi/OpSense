import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  AgentRuntime,
  ContextBuilder,
  FileAgentSessionStore,
  ProbeGovernor,
  ToolRouter,
  createAgentSession,
} from '@opsense/agent-runtime';
import { buildCodexClassificationBatches } from '@opsense/ai-codex';
import { BaselineRelevanceClassifier } from '@opsense/ai-provider';
import { buildEvidenceIndex } from '@opsense/discovery';
import {
  applyProjectionDecision,
  applyWikiNarrative,
  assertCodexClassificationComplete,
  buildInventoryProjection,
  promoteOrphanProcessCandidates,
} from '@opsense/projection';
import {
  createReportFileNames,
  createReportModel,
  generateReportArtifacts,
  validateDocxBuffer,
} from '@opsense/report';
import type { AgentDecision, ScanSnapshot, ServiceRecord } from '@opsense/schema';
import { createRunWorkspaceLayout, ensureRunWorkspace, writeJsonAtomic } from '@opsense/workspace';
import { describe, expect, it } from 'vitest';

import { prepareAgentWorkflow } from '../apps/cli/src/workflows/agent-workflow.js';
import { runReportWorkflow } from '../apps/cli/src/workflows/report-workflow.js';
import { readFixture } from './support/read-fixture.js';

describe('M19 Codex semantic classification loop', () => {
  it('starts the v2 Agent projection with neutral candidates instead of baseline facts', async () => {
    const snapshot = await snapshotWithService('cron');
    snapshot.systemdUnits = [
      {
        activeState: 'active',
        environmentFiles: [],
        evidenceIds: ['evidence:service'],
        execReload: [],
        execStart: ['/usr/sbin/cron'],
        fragmentPath: '/lib/systemd/system/cron.service',
        id: 'systemd:cron.service',
        name: 'cron.service',
        subState: 'running',
      },
    ];
    Object.assign(snapshot.services[0]!, {
      configFiles: [],
      dataDirectories: [],
      deployDirectories: [],
      logLocations: [],
      systemdUnitIds: ['systemd:cron.service'],
    });

    const projection = buildInventoryProjection(snapshot, { mode: 'agent' });

    expect(projection.serviceAssessments[0]).toMatchObject({
      classificationSource: 'local_candidate',
      confidence: 'unknown',
      reportPlacement: 'needs_review',
      role: 'unknown',
    });
    expect(projection.classificationCompleted).toBe(false);
    expect(projection.reviewedServiceCount).toBe(0);
  });

  it('promotes high-value orphan processes into Codex-reviewable service candidates', async () => {
    const snapshot = JSON.parse(await readFixture('schema/minimal-snapshot.json')) as ScanSnapshot;
    snapshot.evidence = [
      {
        collectedAt: '2026-08-15T01:00:00.000Z',
        id: 'evidence:process',
        kind: 'runtime_state',
        opsenseVersion: '0.1.0',
        sensitivity: 'internal',
        source: 'process.list',
        status: 'success',
      },
    ];
    snapshot.processes = [
      {
        arguments: ['-jar', '/opt/custom/order-api.jar'],
        command: 'java -jar /opt/custom/order-api.jar',
        evidenceIds: ['evidence:process'],
        executablePath: '/usr/bin/java',
        id: 'process:321',
        pid: 321,
      },
    ];
    const projection = buildInventoryProjection(snapshot, { mode: 'agent' });
    const index = buildEvidenceIndex(projection);

    const added = promoteOrphanProcessCandidates(projection, index.candidates);

    expect(added).toHaveLength(1);
    expect(projection.services[0]).toMatchObject({
      deploymentType: 'process',
      processIds: [321],
    });
    expect(projection.serviceAssessments[0]).toMatchObject({
      classificationSource: 'local_candidate',
      reportPlacement: 'needs_review',
    });
    expect(projection.candidateServiceCount).toBe(1);
    expect(
      buildInventoryProjection(snapshot, { mode: 'agent', previousProjection: projection })
        .services,
    ).toHaveLength(1);
  });

  it('applies Codex service and path decisions and records complete coverage', async () => {
    const snapshot = await snapshotWithService('order-api');
    const projection = buildInventoryProjection(snapshot, { mode: 'agent' });
    const decision = projectionDecision('service:order-api');

    const changed = applyProjectionDecision(projection, decision, {
      now: () => new Date('2026-08-15T02:00:00.000Z'),
      threadId: 'codex-thread-m19',
    });

    expect(changed).toEqual(['service:order-api']);
    expect(projection.serviceAssessments[0]).toMatchObject({
      classificationSource: 'codex',
      importance: 'high',
      purpose: '处理订单请求。',
      reportPlacement: 'primary',
      role: 'application',
    });
    expect(projection.pathAssessments).toHaveLength(4);
    expect(projection.pathAssessments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: '/opt/order-api',
          semantic: 'deploy',
          serviceIds: ['service:order-api'],
        }),
      ]),
    );
    expect(projection).toMatchObject({
      candidateServiceCount: 1,
      classificationCompleted: true,
      classificationProvider: 'codex',
      classificationThreadId: 'codex-thread-m19',
      reviewedServiceCount: 1,
      reviewedServiceIds: ['service:order-api'],
    });
    applyProjectionDecision(projection, decision, { threadId: 'codex-thread-m19' });
    expect(projection.pathAssessments).toHaveLength(4);
    expect(projection.reviewedPathKeys).toHaveLength(4);
    expect(() => assertCodexClassificationComplete(projection)).not.toThrow();
  });

  it('derives the projection-level Evidence ID union from field-level decisions', async () => {
    const snapshot = await snapshotWithService('order-api');
    const projection = buildInventoryProjection(snapshot, { mode: 'agent' });
    const session = createAgentSession({ scanId: snapshot.session.id });
    session.threadId = 'codex-thread-evidence-union';
    const context = new ContextBuilder({ projection });
    const tools = new ToolRouter({
      projection,
      context,
      governor: new ProbeGovernor({ snapshot, session }),
      applyProjectionUpdate: (decision, currentSession) =>
        applyProjectionDecision(projection, decision, { threadId: currentSession.threadId }),
    });
    tools.setSession(session);
    const decision = projectionDecision('service:order-api');
    decision.evidenceIds = [];

    const result = await tools.execute('update_projection', decision, 'turn:evidence-union');

    expect(result.status).toBe('completed');
    expect(result.evidenceIds).toEqual(['evidence:service']);
    expect(projection.classificationCompleted).toBe(true);
  });

  it('rolls back the whole projection update when any change is invalid', async () => {
    const snapshot = await snapshotWithService('order-api');
    const projection = buildInventoryProjection(snapshot, { mode: 'agent' });
    const before = structuredClone(projection);
    const decision = projectionDecision('service:order-api');
    const pathChange = decision.changes[1];
    if (pathChange?.changeType !== 'path_assessment') throw new Error('invalid fixture');
    pathChange.assessment.path = '/invented/not-collected';

    expect(() =>
      applyProjectionDecision(projection, decision, { threadId: 'codex-thread-m19' }),
    ).toThrow('未采集的候选路径');
    expect(projection).toEqual(before);
  });

  it('rejects inferred service decisions without Evidence IDs', async () => {
    const snapshot = await snapshotWithService('order-api');
    const projection = buildInventoryProjection(snapshot, { mode: 'agent' });
    const decision = projectionDecision('service:order-api');
    const serviceChange = decision.changes[0];
    if (serviceChange?.changeType !== 'service_assessment') throw new Error('invalid fixture');
    serviceChange.assessment.evidenceIds = [];

    expect(() =>
      applyProjectionDecision(projection, decision, { threadId: 'codex-thread-m19' }),
    ).toThrow('必须引用 Evidence ID');
  });

  it('does not allow Codex to hide a failed or custom-path service in system summary', async () => {
    const snapshot = await snapshotWithService('failed-api');
    snapshot.services[0]!.status = 'failed';
    const projection = buildInventoryProjection(snapshot, { mode: 'agent' });
    const decision = projectionDecision('service:failed-api');
    const serviceChange = decision.changes[0];
    if (serviceChange?.changeType !== 'service_assessment') throw new Error('invalid fixture');
    serviceChange.assessment.role = 'system';
    serviceChange.assessment.reportPlacement = 'system_summary';

    expect(() =>
      applyProjectionDecision(projection, decision, { threadId: 'codex-thread-m19' }),
    ).toThrow('安全可见性规则');
  });

  it('rejects incoherent system role and report placement combinations', async () => {
    const snapshot = await snapshotWithService('system-helper');
    const projection = buildInventoryProjection(snapshot, { mode: 'agent' });
    const decision = projectionDecision('service:system-helper');
    const serviceChange = decision.changes[0];
    if (serviceChange?.changeType !== 'service_assessment') throw new Error('invalid fixture');
    serviceChange.assessment.role = 'system';
    serviceChange.assessment.reportPlacement = 'supporting';

    expect(() =>
      applyProjectionDecision(projection, decision, { threadId: 'codex-thread-m19' }),
    ).toThrow('system 角色必须与 system_summary 报告位置成对');
  });

  it('keeps baseline system-summary services in Codex classification batches', async () => {
    const snapshot = await snapshotWithService('cron');
    snapshot.systemdUnits = [
      {
        activeState: 'active',
        environmentFiles: [],
        evidenceIds: ['evidence:service'],
        execReload: [],
        execStart: ['/usr/sbin/cron'],
        fragmentPath: '/lib/systemd/system/cron.service',
        id: 'systemd:cron.service',
        name: 'cron.service',
        subState: 'running',
      },
    ];
    Object.assign(snapshot.services[0]!, {
      configFiles: [],
      dataDirectories: [],
      deployDirectories: [],
      logLocations: [],
      systemdUnitIds: ['systemd:cron.service'],
    });
    const baseline = new BaselineRelevanceClassifier().classify(snapshot);

    expect(baseline.serviceAssessments[0]?.reportPlacement).toBe('system_summary');
    expect(buildCodexClassificationBatches(snapshot, baseline)[0]?.candidates).toHaveLength(1);
  });

  it('lets Codex promote a baseline system service and updates all report formats', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'opsense-m19-promote-'));
    try {
      const snapshot = await snapshotWithService('cron');
      Object.assign(snapshot.services[0]!, {
        configFiles: [],
        dataDirectories: [],
        deployDirectories: [],
        logLocations: [],
        systemdUnitIds: ['systemd:cron.service'],
      });
      snapshot.systemdUnits = [
        {
          activeState: 'active',
          environmentFiles: [],
          evidenceIds: ['evidence:service'],
          execReload: [],
          execStart: ['/usr/sbin/cron'],
          fragmentPath: '/lib/systemd/system/cron.service',
          id: 'systemd:cron.service',
          name: 'cron.service',
          subState: 'running',
        },
      ];
      expect(
        new BaselineRelevanceClassifier().classify(snapshot).serviceAssessments[0]?.reportPlacement,
      ).toBe('system_summary');
      const projection = buildInventoryProjection(snapshot, { mode: 'agent' });
      applyProjectionDecision(projection, serviceOnlyDecision('service:cron'), {
        threadId: 'codex-thread-promote',
      });
      applyWikiNarrative(projection, wikiNarrative('service:cron'), {
        threadId: 'codex-thread-promote-wiki',
      });

      const artifacts = await generateReportArtifacts(projection, {
        formats: ['docx', 'html', 'markdown'],
        outputDirectory: root,
        requireCodexClassification: true,
      });

      const html = await readFile(artifacts.htmlFile!, 'utf8');
      const markdown = (
        await Promise.all(artifacts.markdownFiles.map((file) => readFile(file, 'utf8')))
      ).join('\n');
      const docx = (await validateDocxBuffer(await readFile(artifacts.docxFile!))).text;
      for (const output of [html, markdown, docx]) {
        expect(output).toContain('cron');
        expect(output).toContain('该服务承载对应产品或应用的主要运行能力。');
        expect(output).toContain('该服务器运行一个已由 Codex 完成语义审查的主要服务。');
      }
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it('keeps a locally suggested path out of the final report when Codex rejects its role', async () => {
    const snapshot = await snapshotWithService('order-api');
    const projection = buildInventoryProjection(snapshot, { mode: 'agent' });
    const decision = projectionDecision('service:order-api');
    const configChange = decision.changes.find(
      (item) =>
        item.changeType === 'path_assessment' && item.assessment.path.endsWith('/config.yml'),
    );
    if (configChange?.changeType !== 'path_assessment') throw new Error('invalid fixture');
    configChange.assessment.semantic = 'unknown';
    configChange.assessment.confidence = 'unknown';
    configChange.assessment.reason = '现有证据不足以确认该路径是有效配置。';
    applyProjectionDecision(projection, decision, { threadId: 'codex-thread-reject-path' });

    expect(createReportModel(projection).services[0]?.configFiles).toEqual([]);
  });

  it('rejects v2 Wiki output until Codex review and Thread auditing are complete', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'opsense-m19-report-'));
    try {
      const snapshot = await snapshotWithService('order-api');
      const projection = buildInventoryProjection(snapshot, { mode: 'agent' });

      await expect(
        generateReportArtifacts(projection, {
          formats: [],
          outputDirectory: root,
          requireCodexClassification: true,
        }),
      ).rejects.toThrow('Codex 完成全部语义审查');
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it('runs Codex preflight before resolving or connecting to a scan source', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'opsense-m19-preflight-'));
    try {
      await expect(
        prepareAgentWorkflow({
          maxAgentRounds: 1,
          maxProbes: 0,
          port: 22,
          preflight: {
            check: async () => ({
              available: false,
              checks: { login: false, model: false, sdk: true, thread: false },
              error: 'Codex login unavailable for test.',
            }),
          },
          provider: 'codex',
          scan: 'scan-that-does-not-exist',
          workspace: root,
        }),
      ).rejects.toThrow('Codex login unavailable for test');
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it('renders the wiki profile only from the persisted completed Agent Projection', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'opsense-m19-report-workflow-'));
    try {
      const snapshot = await snapshotWithService('order-api');
      const layout = await ensureRunWorkspace(snapshot.session.id, root);
      const projection = buildInventoryProjection(snapshot, { mode: 'agent' });
      applyProjectionDecision(projection, projectionDecision('service:order-api'), {
        threadId: 'codex-thread-m19-report',
      });
      applyWikiNarrative(projection, wikiNarrative('service:order-api'), {
        threadId: 'codex-thread-m19-report-wiki',
      });
      await Promise.all([
        writeJsonAtomic(layout.snapshotFile, snapshot),
        writeJsonAtomic(layout.agentProjectionFile, projection),
      ]);

      const result = await runReportWorkflow({
        formats: [],
        profile: 'wiki',
        scan: snapshot.session.id,
        workspace: root,
      });

      expect(result.artifacts.quality.passed).toBe(true);
      expect(result.artifacts.projectionFile).toContain('inventory-projection.json');
      const model = createReportModel(projection);
      expect(model.metadata).toMatchObject({
        classificationCompleted: true,
        classificationProvider: 'codex',
      });
      expect(model.metadata.title).toContain('服务器 Wiki 文档');
      expect(createReportFileNames(model).docx).toContain('服务器Wiki文档-');
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it('rejects a premature model final and persists a resumable partial session', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'opsense-m19-runtime-'));
    try {
      const snapshot = await snapshotWithService('order-api');
      const projection = buildInventoryProjection(snapshot, { mode: 'agent' });
      const session = createAgentSession({ scanId: snapshot.session.id });
      const store = new FileAgentSessionStore(createRunWorkspaceLayout(snapshot.session.id, root));
      await store.save(session);
      const context = new ContextBuilder({ projection });
      const runtime = new AgentRuntime({
        scanId: snapshot.session.id,
        session,
        store,
        context,
        maxTurns: 1,
        requireClassificationComplete: true,
        thread: {
          start: async () => ({ threadId: 'codex-thread-m19' }),
          resume: async (threadId: string) => ({ threadId }),
          run: async () => ({
            decision: {
              decisionId: 'decision:premature-final',
              findingIds: [],
              inventoryProjectionId: projection.projectionId,
              kind: 'final' as const,
              nextAction: 'wiki',
              nextSuggestions: [],
              qualitySummary: '完成。',
              reason: '尝试提前结束。',
              serviceWikiProjectionId: 'wiki:m19',
              turnId: 'model-turn',
              unresolvedQuestions: [],
            },
          }),
        },
        tools: new ToolRouter({
          projection,
          context,
          governor: new ProbeGovernor({ snapshot, session }),
        }),
      });

      const response = await runtime.start('开始');

      expect(response.message).toContain('语义审查尚未完成');
      expect(runtime.currentSession.state).toBe('partial');
      expect((await store.load()).coverage.classification).toBe(0);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it('keeps the prioritized service context batch small on large inventories', async () => {
    const snapshot = await snapshotWithService('service-0');
    const seed = snapshot.services[0]!;
    snapshot.services = Array.from({ length: 12 }, (_, index) => ({
      ...structuredClone(seed),
      configFiles: [`/etc/service-${index}.conf`],
      dataDirectories: [`/var/lib/service-${index}`],
      deployDirectories: [`/opt/service-${index}`],
      id: `service:service-${index}`,
      logLocations: [`/var/log/service-${index}`],
      name: `service-${index}`,
    }));
    const projection = buildInventoryProjection(snapshot, { mode: 'agent' });
    const context = new ContextBuilder({ projection });

    const built = context.build({ budget: {}, round: 1, stage: 'investigating' });

    expect(built.l0.counts).toMatchObject({ candidatesShown: 2, candidatesOmitted: 10 });
    expect(built.l1.services).toHaveLength(2);
    expect(context.readSection('services', 0, 5)).toHaveLength(5);
  });

  it('grants the configured turn budget again when a partial session resumes', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'opsense-m19-resume-budget-'));
    try {
      const snapshot = await snapshotWithService('order-api');
      const projection = buildInventoryProjection(snapshot, { mode: 'agent' });
      const session = createAgentSession({ scanId: snapshot.session.id });
      const store = new FileAgentSessionStore(createRunWorkspaceLayout(snapshot.session.id, root));
      await store.save(session);
      const context = new ContextBuilder({ projection });
      let starts = 0;
      let resumes = 0;
      const runtime = new AgentRuntime({
        scanId: snapshot.session.id,
        session,
        store,
        context,
        maxTurns: 2,
        thread: {
          start: async () => {
            starts += 1;
            return { threadId: `codex-thread-m19-resume-${starts}` };
          },
          resume: async (threadId: string) => {
            resumes += 1;
            return { threadId };
          },
          run: async () => ({
            decision: {
              arguments: { section: 'host' },
              decisionId: `decision:read-${runtime.currentSession.turnCount + 1}`,
              kind: 'tool_call' as const,
              nextAction: 'continue',
              nextSuggestions: [],
              reason: '读取主机摘要。',
              toolName: 'read_context' as const,
              turnId: 'model-turn',
              unresolvedQuestions: [],
            },
          }),
        },
        tools: new ToolRouter({
          projection,
          context,
          governor: new ProbeGovernor({ snapshot, session }),
        }),
      });

      await runtime.start('开始');
      expect(runtime.currentSession.turnCount).toBe(2);
      expect(runtime.currentSession.state).toBe('partial');
      runtime.currentSession.repairSuggestions = ['历史失败提示'];
      await store.save(runtime.currentSession);

      await runtime.resume('继续');
      expect(runtime.currentSession.turnCount).toBe(4);
      expect(runtime.currentSession.state).toBe('partial');
      expect(runtime.currentSession.repairSuggestions).toEqual([]);
      expect(starts).toBe(4);
      expect(resumes).toBe(0);
      expect(runtime.currentSession.threadId).toBe('codex-thread-m19-resume-4');
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it('completes the runtime loop only after a real Codex projection update', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'opsense-m19-loop-'));
    try {
      const snapshot = await snapshotWithService('order-api');
      const projection = buildInventoryProjection(snapshot, { mode: 'agent' });
      const session = createAgentSession({ scanId: snapshot.session.id });
      const store = new FileAgentSessionStore(createRunWorkspaceLayout(snapshot.session.id, root));
      await store.save(session);
      const context = new ContextBuilder({ projection });
      const tools = new ToolRouter({
        projection,
        context,
        governor: new ProbeGovernor({ snapshot, session }),
        applyProjectionUpdate: (decision, currentSession) =>
          applyProjectionDecision(projection, decision, {
            ...(currentSession.threadId === undefined ? {} : { threadId: currentSession.threadId }),
          }),
        applyWikiComposition: (draft, currentSession) =>
          applyWikiNarrative(projection, draft, {
            ...(currentSession.threadId === undefined ? {} : { threadId: currentSession.threadId }),
          }),
      });
      let turn = 0;
      const runtime = new AgentRuntime({
        scanId: snapshot.session.id,
        session,
        store,
        context,
        maxTurns: 5,
        requireClassificationComplete: true,
        thread: {
          start: async () => ({ threadId: 'codex-thread-m19-loop' }),
          resume: async (threadId: string) => ({ threadId }),
          run: async () => {
            turn += 1;
            if (turn === 1)
              return {
                decision: {
                  arguments: { section: 'services' },
                  decisionId: 'decision:m19-list',
                  kind: 'tool_call' as const,
                  nextAction: 'continue',
                  nextSuggestions: [],
                  reason: '先读取服务候选。',
                  toolName: 'list_candidates' as const,
                  turnId: 'model-turn',
                  unresolvedQuestions: [],
                },
              };
            if (turn === 2)
              return {
                decision: {
                  arguments: { ids: ['evidence:service'] },
                  decisionId: 'decision:m19-evidence',
                  kind: 'tool_call' as const,
                  nextAction: 'continue',
                  nextSuggestions: [],
                  reason: '读取候选证据。',
                  toolName: 'read_evidence' as const,
                  turnId: 'model-turn',
                  unresolvedQuestions: [],
                },
              };
            if (turn === 3) return { decision: projectionDecision('service:order-api') };
            if (turn === 4)
              return {
                decision: {
                  arguments: wikiNarrative('service:order-api'),
                  decisionId: 'decision:m19-compose-wiki',
                  kind: 'tool_call' as const,
                  nextAction: 'continue',
                  nextSuggestions: [],
                  reason: '根据完成的服务语义投影撰写服务器 Wiki。',
                  toolName: 'compose_wiki' as const,
                  turnId: 'model-turn',
                  unresolvedQuestions: [],
                },
              };
            return {
              decision: {
                decisionId: 'decision:m19-final',
                findingIds: [],
                inventoryProjectionId: projection.projectionId,
                kind: 'final' as const,
                nextAction: 'wiki',
                nextSuggestions: [],
                qualitySummary: 'Codex 语义投影已完成。',
                reason: '全部服务和路径已完成审查。',
                serviceWikiProjectionId: 'wiki:m19',
                turnId: 'model-turn',
                unresolvedQuestions: [],
              },
            };
          },
        },
        tools,
      });

      const response = await runtime.start('整理服务 Wiki。');

      expect(response.message).toBe('Codex 语义投影已完成。');
      expect(runtime.currentSession.state).toBe('completed');
      expect(runtime.currentSession.coverage.classification).toBe(1);
      expect(projection.classificationCompleted).toBe(true);
      expect(projection.classificationThreadId).toBe('codex-thread-m19-loop');
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

async function snapshotWithService(name: string): Promise<ScanSnapshot> {
  const snapshot = JSON.parse(await readFixture('schema/minimal-snapshot.json')) as ScanSnapshot;
  snapshot.evidence = [
    {
      collectedAt: '2026-08-15T01:00:00.000Z',
      id: 'evidence:service',
      kind: 'derived',
      opsenseVersion: '0.1.0',
      sensitivity: 'internal',
      source: 'service.normalization',
      status: 'success',
    },
  ];
  snapshot.services = [service(name)];
  return snapshot;
}

function service(name: string): ServiceRecord {
  return {
    composeProjectIds: [],
    confidence: 'inferred',
    configFiles: [`/opt/${name}/config.yml`],
    containerIds: [],
    dataDirectories: [`/data/${name}`],
    deployDirectories: [`/opt/${name}`],
    deploymentType: 'systemd',
    environmentFiles: [],
    evidenceIds: ['evidence:service'],
    id: `service:${name}`,
    logLocations: [`/var/log/${name}`],
    name,
    processIds: [],
    socketIds: [],
    status: 'running',
    systemdUnitIds: [],
    unknownFields: [],
  };
}

function wikiNarrative(serviceId: string) {
  return {
    architectureOverview: '该服务以独立部署单元运行，现有证据未确认额外依赖。',
    deploymentOverview: '部署、配置、数据和日志路径均来自 Codex 审查后的投影。',
    executiveSummary: '该服务器运行一个已由 Codex 完成语义审查的主要服务。',
    keyFindings: [],
    operationsOverview: '运维时应核对服务状态、配置路径、日志和备份策略。',
    serviceDescriptions: [
      {
        basis: '服务名称和服务归一化证据。',
        description: '该服务承载对应产品或应用的主要运行能力。',
        evidenceIds: ['evidence:service'],
        serviceId,
      },
    ],
    serviceGroups: [
      {
        serviceIds: [serviceId],
        summary: '已确认的主要部署服务。',
        title: '主要服务',
      },
    ],
    systemOverview: '服务器提供该服务所需的 Linux 运行环境。',
    unresolvedQuestions: [],
  };
}

function projectionDecision(
  serviceId: string,
): Extract<AgentDecision, { kind: 'projection_update' }> {
  const serviceName = serviceId.replace(/^service:/, '');
  return {
    changes: [
      {
        assessment: {
          confidence: 'inferred',
          evidenceIds: ['evidence:service'],
          importance: 'high',
          purpose: '处理订单请求。',
          reason: '自定义部署路径和服务证据表明这是业务应用。',
          reportPlacement: 'primary',
          reviewItems: [],
          role: 'application',
          serviceId,
          statusInterpretation: '当前正在运行。',
          unknowns: [],
        },
        changeType: 'service_assessment',
        objectId: serviceId,
        operation: 'update',
        summary: '更新服务语义分类。',
      },
      {
        assessment: {
          confidence: 'inferred',
          evidenceIds: ['evidence:service'],
          path: `/opt/${serviceName}`,
          reason: '该路径由服务归一化证据关联到应用。',
          semantic: 'deploy',
          serviceId,
        },
        changeType: 'path_assessment',
        objectId: serviceId,
        operation: 'update',
        summary: '确认部署路径。',
      },
      {
        assessment: {
          confidence: 'inferred',
          evidenceIds: ['evidence:service'],
          path: `/opt/${serviceName}/config.yml`,
          reason: '配置候选由服务证据关联。',
          semantic: 'config',
          serviceId,
        },
        changeType: 'path_assessment',
        objectId: serviceId,
        operation: 'update',
        summary: '确认配置路径。',
      },
      {
        assessment: {
          confidence: 'inferred',
          evidenceIds: ['evidence:service'],
          path: `/var/log/${serviceName}`,
          reason: '日志候选由服务证据关联。',
          semantic: 'log',
          serviceId,
        },
        changeType: 'path_assessment',
        objectId: serviceId,
        operation: 'update',
        summary: '确认日志路径。',
      },
      {
        assessment: {
          confidence: 'inferred',
          evidenceIds: ['evidence:service'],
          path: `/data/${serviceName}`,
          reason: '数据候选由服务证据关联。',
          semantic: 'data',
          serviceId,
        },
        changeType: 'path_assessment',
        objectId: serviceId,
        operation: 'update',
        summary: '确认数据路径。',
      },
    ],
    decisionId: 'decision:m19',
    evidenceIds: ['evidence:service'],
    kind: 'projection_update',
    nextAction: 'continue',
    nextSuggestions: [],
    reason: '应用 Codex 服务语义判断。',
    turnId: 'turn:m19',
    unresolvedQuestions: [],
  };
}

function serviceOnlyDecision(
  serviceId: string,
): Extract<AgentDecision, { kind: 'projection_update' }> {
  return {
    changes: [
      {
        assessment: {
          confidence: 'inferred',
          evidenceIds: ['evidence:service'],
          importance: 'high',
          purpose: '由用户部署并需要纳入服务器知识手册的任务调度服务。',
          reason: 'Codex 根据用户目标和现有 unit 证据将该候选识别为业务服务。',
          reportPlacement: 'primary',
          reviewItems: [],
          role: 'application',
          serviceId,
          statusInterpretation: '当前正在运行。',
          unknowns: [],
        },
        changeType: 'service_assessment',
        objectId: serviceId,
        operation: 'update',
        summary: '将 baseline 系统服务提升为业务服务。',
      },
    ],
    decisionId: 'decision:m19-service-only',
    evidenceIds: ['evidence:service'],
    kind: 'projection_update',
    nextAction: 'continue',
    nextSuggestions: [],
    reason: '应用 Codex 服务语义判断。',
    turnId: 'turn:m19-service-only',
    unresolvedQuestions: [],
  };
}
