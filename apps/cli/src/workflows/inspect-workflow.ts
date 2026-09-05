import type { ReportFormat } from '@opsense/report';

import {
  runDiscoveryWorkflow,
  type DiscoveryWorkflowOptions,
  type DiscoveryWorkflowResult,
} from './discovery-workflow.js';
import {
  runFinalizeWorkflow,
  type FinalizeWorkflowOptions,
  type FinalizeWorkflowResult,
} from './finalize-workflow.js';
import {
  runProbeWorkflow,
  type ProbeWorkflowOptions,
  type ProbeWorkflowResult,
} from './probe-workflow.js';
import {
  runScanWorkflow,
  type ScanStageHandler,
  type ScanWorkflowOptions,
  type ScanWorkflowResult,
} from './scan-workflow.js';

export interface InspectWorkflowOptions extends Omit<ScanWorkflowOptions, 'retainConnection'> {
  formats: readonly ReportFormat[];
  maxRetries?: number;
  model?: string;
  provider: string;
  threadTimeoutMs: number;
  timeZone?: string;
}

export interface InspectWorkflowDependencies {
  runDiscovery?: (
    options: DiscoveryWorkflowOptions,
    onStage?: ScanStageHandler,
  ) => Promise<DiscoveryWorkflowResult>;
  runFinalize?: (
    options: FinalizeWorkflowOptions,
    scan: ScanWorkflowResult,
    discovery: DiscoveryWorkflowResult,
    decision: DiscoveryWorkflowResult['artifact'],
    snapshot: ScanWorkflowResult['snapshot'],
    onStage?: ScanStageHandler,
  ) => Promise<FinalizeWorkflowResult>;
  runProbe?: (
    options: ProbeWorkflowOptions,
    scan: ScanWorkflowResult,
    discovery: DiscoveryWorkflowResult,
    onStage?: ScanStageHandler,
  ) => Promise<ProbeWorkflowResult>;
  runScan?: (
    options: ScanWorkflowOptions,
    onStage?: ScanStageHandler,
  ) => Promise<ScanWorkflowResult>;
}

export interface InspectWorkflowResult {
  discovery: DiscoveryWorkflowResult;
  finalization: FinalizeWorkflowResult;
  probe?: ProbeWorkflowResult;
  scan: ScanWorkflowResult;
}

export async function runInspectWorkflow(
  options: InspectWorkflowOptions,
  onStage?: ScanStageHandler,
  dependencies: InspectWorkflowDependencies = {},
): Promise<InspectWorkflowResult> {
  let scan: ScanWorkflowResult | undefined;
  try {
    scan = await (dependencies.runScan ?? runScanWorkflow)(
      { ...options, retainConnection: true },
      onStage,
    );
    throwIfAborted(options.signal);
    const discovery = await (dependencies.runDiscovery ?? runDiscoveryWorkflow)(
      {
        provider: options.provider,
        scan: scan.scanId,
        timeoutMs: options.threadTimeoutMs,
        ...(options.config === undefined ? {} : { config: options.config }),
        ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
        ...(options.model === undefined ? {} : { model: options.model }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
      },
      onStage,
    );
    throwIfAborted(options.signal);
    let probe: ProbeWorkflowResult | undefined;
    if (options.profile !== 'fast' && discovery.artifact.run.status === 'completed') {
      probe = await (dependencies.runProbe ?? runProbeWorkflow)(
        {
          provider: options.provider,
          timeoutMs: options.threadTimeoutMs,
          ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
          ...(options.model === undefined ? {} : { model: options.model }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        },
        scan,
        discovery,
        onStage,
      );
      throwIfAborted(options.signal);
    }
    const decision = probe?.discovery ?? discovery.artifact;
    const snapshot = probe?.snapshot ?? scan.snapshot;
    const finalizationContext =
      probe === undefined
        ? discovery
        : { ...discovery, metrics: probe.metrics, pipelineRun: probe.pipelineRun };
    const finalization = await (dependencies.runFinalize ?? runFinalizeWorkflow)(
      {
        provider: options.provider,
        timeoutMs: options.threadTimeoutMs,
        ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
        ...(options.model === undefined ? {} : { model: options.model }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
      scan,
      finalizationContext,
      decision,
      snapshot,
      onStage,
    );
    return { discovery, finalization, ...(probe === undefined ? {} : { probe }), scan };
  } finally {
    scan?.connection?.close();
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new Error('Operation was interrupted.');
}
