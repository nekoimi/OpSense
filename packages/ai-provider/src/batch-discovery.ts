import { createHash } from 'node:crypto';

import { BatchDiscoveryArtifactSchema, assertSchema } from '@opsense/schema';
import type {
  BatchDiscoveryArtifact,
  BatchDiscoveryInput,
  BatchDiscoveryRun,
} from '@opsense/schema';

import type { BatchDiscoveryAdapter, BatchDiscoveryOptions } from './types.js';

export class NoopBatchDiscoveryAdapter implements BatchDiscoveryAdapter {
  public readonly name = 'noop';

  public discover(
    input: BatchDiscoveryInput,
    options: BatchDiscoveryOptions = {},
  ): Promise<BatchDiscoveryArtifact> {
    return Promise.resolve(
      createDegradedBatchDiscoveryArtifact(input, {
        error: 'Batch Discovery provider is disabled; all candidates remain unverified.',
        provider: this.name,
        ...(options.model === undefined ? {} : { model: options.model }),
        ...(options.threadId === undefined ? {} : { threadId: options.threadId }),
      }),
    );
  }
}

export function createDegradedBatchDiscoveryArtifact(
  input: BatchDiscoveryInput,
  options: {
    error: string;
    finishedAt?: Date;
    model?: string;
    provider: string;
    run?: Partial<Pick<BatchDiscoveryRun, 'callCount' | 'durationMs' | 'repairCount' | 'usage'>>;
    startedAt?: Date;
    threadId?: string;
  },
): BatchDiscoveryArtifact {
  const startedAt = options.startedAt ?? new Date();
  const finishedAt = options.finishedAt ?? startedAt;
  const retainedUnknownCandidateIds = input.candidates.map((candidate) => candidate.candidateId);
  const artifact: BatchDiscoveryArtifact = {
    batchErrors: [options.error],
    completion: {
      complete: true,
      duplicateCandidateIds: [],
      handledCandidateIds: retainedUnknownCandidateIds,
      missingCandidateIds: [],
    },
    decision: {
      decisionId: stableId(
        'discovery-degraded',
        `${input.sourceCandidateSetHash}|${options.error}`,
      ),
      filteredCandidateIds: [],
      probeRequests: [],
      retainedUnknownCandidateIds,
      services: [],
      sourceCandidateSetHash: input.sourceCandidateSetHash,
      summary: 'AI semantic discovery was unavailable; protected candidates remain for review.',
      unresolvedQuestions: [options.error],
    },
    itemErrors: [],
    run: {
      callCount: options.run?.callCount ?? 0,
      durationMs: options.run?.durationMs ?? 0,
      error: options.error,
      finishedAt: finishedAt.toISOString(),
      provider: options.provider,
      repairCount: options.run?.repairCount ?? 0,
      startedAt: startedAt.toISOString(),
      status: 'degraded',
      usage: options.run?.usage ?? {
        cachedInputTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
      },
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.threadId === undefined ? {} : { threadId: options.threadId }),
    },
    schemaVersion: '3.0',
  };
  assertSchema(BatchDiscoveryArtifactSchema, artifact);
  return artifact;
}

function stableId(prefix: string, value: string): string {
  return `${prefix}:${createHash('sha256').update(value).digest('hex').slice(0, 20)}`;
}
