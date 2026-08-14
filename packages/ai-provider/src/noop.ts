import type { AiProvider, AnalysisInput, AnalysisResult } from './types.js';
import { createFallbackAnalysis } from './baseline.js';
import { ProbePlanValidator, markProbeRequestsOffline } from './probe-policy.js';

export class NoopProvider implements AiProvider {
  public readonly name = 'noop';

  public async analyze(input: AnalysisInput): Promise<AnalysisResult> {
    const started = new Date();
    const plan = { ...input.baselinePlan, generatedAt: started.toISOString(), provider: this.name };
    const validated = new ProbePlanValidator().validate(
      input.snapshot,
      plan.probeRequests,
      () => started,
    );
    return Promise.resolve({
      analysis: createFallbackAnalysis(input.snapshot, plan, this.name, () => started),
      plan,
      probeAudit: markProbeRequestsOffline(validated.audit),
      run: {
        durationMs: 0,
        finishedAt: started.toISOString(),
        provider: this.name,
        retryCount: 0,
        startedAt: started.toISOString(),
        status: 'skipped',
      },
    });
  }
}
