import type {
  AiAnalysis,
  AiPlan,
  AiProbeAudit,
  AiRun,
  BatchDiscoveryArtifact,
  BatchDiscoveryInput,
  ScanSnapshot,
} from '@opsense/schema';

export interface AnalysisInput {
  aiInputDirectory: string;
  baselinePlan: AiPlan;
  snapshot: ScanSnapshot;
}

export interface AnalysisOptions {
  maxRetries?: number;
  model?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  threadId?: string;
}

export interface AnalysisResult {
  analysis: AiAnalysis;
  plan: AiPlan;
  probeAudit: AiProbeAudit;
  run: AiRun;
}

export interface AiProvider {
  readonly name: string;
  analyze(input: AnalysisInput, options?: AnalysisOptions): Promise<AnalysisResult>;
}

export interface BatchDiscoveryOptions {
  maxCalls?: number;
  maxRetries?: number;
  model?: string;
  signal?: AbortSignal;
  threadId?: string;
  timeoutMs?: number;
}

export interface BatchDiscoveryAdapter {
  readonly name: string;
  discover(
    input: BatchDiscoveryInput,
    options?: BatchDiscoveryOptions,
  ): Promise<BatchDiscoveryArtifact>;
}
