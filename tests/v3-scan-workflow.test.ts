import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  BatchDiscoveryArtifactSchema,
  PipelineRunSchema,
  RunMetricsSchema,
  assertSchema,
} from '@opsense/schema';
import type { SshConnection } from '@opsense/ssh';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runScanWorkflow } from '../apps/cli/src/workflows/scan-workflow.js';
import { runDiscoveryWorkflow } from '../apps/cli/src/workflows/discovery-workflow.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('v3 scan workflow profiles', () => {
  it('skips recursive directory collection by default and persists v3 run artifacts', async () => {
    const workspace = await temporaryWorkspace();
    const collectM5 = vi.fn(async () => directoryResult());
    const result = await runScanWorkflow(baseOptions(workspace), undefined, {
      ...dependencies(),
      collectM5,
    });

    expect(collectM5).not.toHaveBeenCalled();
    expect(result.pipelineRun.profile).toBe('standard');
    expect(result.pipelineRun.state).toBe('inventory_ready');
    expect(result.snapshot.pathSeeds).toEqual([]);

    const persistedRun: unknown = JSON.parse(await readFile(result.layout.pipelineRunFile, 'utf8'));
    const persistedMetrics: unknown = JSON.parse(await readFile(result.layout.metricsFile, 'utf8'));
    assertSchema(PipelineRunSchema, persistedRun);
    assertSchema(RunMetricsSchema, persistedMetrics);
    await expect(readFile(result.layout.resourceGraphFile, 'utf8')).resolves.toContain(
      'resource-graph',
    );
    await expect(readFile(result.layout.candidateSetFile, 'utf8')).resolves.toContain('candidates');
    await expect(readFile(result.layout.inventoryFile, 'utf8')).resolves.toContain('unverified');

    const discovery = await runDiscoveryWorkflow({
      provider: 'noop',
      scan: result.scanId,
      timeoutMs: 1_000,
      workspace,
    });
    const persistedDiscovery: unknown = JSON.parse(
      await readFile(result.layout.discoveryFile, 'utf8'),
    );
    assertSchema(BatchDiscoveryArtifactSchema, persistedDiscovery);
    expect(discovery.artifact.run.status).toBe('degraded');
    expect(discovery.pipelineRun.completedStages).toEqual(
      expect.arrayContaining([expect.objectContaining({ stage: 'discovering' })]),
    );
    expect(discovery.metrics.ai.failedCalls).toBe(1);
  });

  it('runs recursive directory collection only for the deep profile', async () => {
    const workspace = await temporaryWorkspace();
    const collectM5 = vi.fn(async () => directoryResult());
    const result = await runScanWorkflow(
      { ...baseOptions(workspace), profile: 'deep' },
      undefined,
      { ...dependencies(), collectM5 },
    );

    expect(collectM5).toHaveBeenCalledTimes(1);
    expect(result.pipelineRun.profile).toBe('deep');
  });
});

function baseOptions(workspace: string) {
  return {
    host: 'server.example.com',
    port: 22,
    user: 'ops',
    workspace,
  } as const;
}

function dependencies() {
  const close = vi.fn();
  return {
    connect: async () => ({ close }) as unknown as SshConnection,
    detectPermissions: async () => ({
      groups: ['ops'],
      level: 'unprivileged' as const,
      results: [],
      sudoNonInteractive: false,
      uid: 1000,
      user: 'ops',
    }),
    collectM3: async () => ({
      evidence: [],
      host: {
        architecture: 'x86_64',
        capabilities: [],
        collectedAt: '2026-09-05T00:00:00.000Z',
        cpu: { architecture: 'x86_64', logicalCores: 2 },
        hostname: 'server',
        kernelVersion: '6.8.0',
        memory: {
          availableBytes: 512,
          swapFreeBytes: 0,
          swapTotalBytes: 0,
          totalBytes: 1024,
        },
        operatingSystem: { id: 'linux', name: 'Linux', prettyName: 'Linux' },
        uptimeSeconds: 60,
      },
      network: {
        collectedAt: '2026-09-05T00:00:00.000Z',
        dns: { searchDomains: [], servers: [] },
        firewall: { backend: 'unknown' as const, evidenceIds: [], summary: [] },
        interfaces: [],
        routes: [],
      },
      storage: {
        collectedAt: '2026-09-05T00:00:00.000Z',
        disks: [],
        fstabEntries: [],
        layers: [],
        mounts: [],
        swapDevices: [],
      },
      unknowns: [],
    }),
    collectM4: async () => ({
      composeProjects: [],
      containers: [],
      evidence: [],
      processes: [],
      sockets: [],
      systemdUnits: [],
      unknowns: [],
    }),
  };
}

function directoryResult() {
  return { artifacts: [], evidence: [], pathSeeds: [], unknowns: [] };
}

async function temporaryWorkspace(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'opsense-v3-scan-'));
  temporaryDirectories.push(directory);
  return directory;
}
