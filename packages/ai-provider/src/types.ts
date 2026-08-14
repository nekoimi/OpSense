import type { AiAnalysis, AiPlan, AiProbeAudit, AiRun, ScanSnapshot } from '@opsense/schema';

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
