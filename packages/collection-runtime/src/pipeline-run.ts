import {
  PIPELINE_SCHEMA_VERSION,
  PIPELINE_WORKFLOW_VERSION,
  PipelineRunSchema,
  assertSchema,
} from '@opsense/schema';
import type {
  PipelineBudgets,
  PipelineProfile,
  PipelineRun,
  PipelineStage,
  PipelineState,
} from '@opsense/schema';

export const DEFAULT_PIPELINE_BUDGETS: PipelineBudgets = {
  maxAiCalls: 3,
  maxProbeRequests: 20,
  maxProbeRounds: 1,
  maxSessionDurationMs: 600_000,
  maxSessionTokens: 500_000,
  maxSessionTurns: 12,
};

export interface CreatePipelineRunOptions {
  budgets?: Partial<PipelineBudgets>;
  now?: () => Date;
  profile?: PipelineProfile;
  runId: string;
  target: { host: string; port: number; user?: string };
}

export class PipelineRunTracker {
  private readonly now: () => Date;
  private run: PipelineRun;

  public constructor(options: CreatePipelineRunOptions) {
    this.now = options.now ?? (() => new Date());
    const at = this.now().toISOString();
    this.run = {
      budgets: { ...DEFAULT_PIPELINE_BUDGETS, ...options.budgets },
      completedStages: [],
      currentStage: 'created',
      outputFiles: [],
      profile: options.profile ?? 'standard',
      runId: options.runId,
      schemaVersion: PIPELINE_SCHEMA_VERSION,
      startedAt: at,
      state: 'created',
      target: options.target,
      updatedAt: at,
      workflowVersion: PIPELINE_WORKFLOW_VERSION,
    };
    assertSchema(PipelineRunSchema, this.run);
  }

  public transition(stage: PipelineStage): PipelineRun {
    this.run.currentStage = stage;
    this.run.state =
      stage === 'created' ? 'created' : stage === 'inventory_ready' ? 'inventory_ready' : 'running';
    this.run.updatedAt = this.now().toISOString();
    return this.snapshot();
  }

  public checkpoint(
    stage: PipelineStage,
    hashes: { outputHash?: string; sourceHash?: string } = {},
  ): PipelineRun {
    const checkpoint = {
      finishedAt: this.now().toISOString(),
      stage,
      ...(hashes.outputHash === undefined ? {} : { outputHash: hashes.outputHash }),
      ...(hashes.sourceHash === undefined ? {} : { sourceHash: hashes.sourceHash }),
    };
    this.run.completedStages = [
      ...this.run.completedStages.filter((item) => item.stage !== stage),
      checkpoint,
    ];
    this.run.updatedAt = checkpoint.finishedAt;
    return this.snapshot();
  }

  public addOutputFiles(files: readonly string[]): PipelineRun {
    this.run.outputFiles = [...new Set([...this.run.outputFiles, ...files])];
    this.run.updatedAt = this.now().toISOString();
    return this.snapshot();
  }

  public finish(
    state: Extract<PipelineState, 'completed' | 'partial' | 'failed' | 'interrupted'>,
    failure?: { code: string; message: string; retryable: boolean; stage?: PipelineStage },
  ): PipelineRun {
    const at = this.now().toISOString();
    this.run.state = state;
    this.run.updatedAt = at;
    this.run.finishedAt = at;
    if (failure !== undefined) {
      this.run.lastError = {
        code: failure.code,
        message: failure.message,
        retryable: failure.retryable,
        stage: failure.stage ?? this.run.currentStage,
      };
    } else {
      delete this.run.lastError;
    }
    return this.snapshot();
  }

  public snapshot(): PipelineRun {
    const snapshot = structuredClone(this.run);
    assertSchema(PipelineRunSchema, snapshot);
    return snapshot;
  }
}
