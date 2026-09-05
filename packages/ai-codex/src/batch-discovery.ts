import { Codex } from '@openai/codex-sdk';
import type { RunResult, Thread, ThreadOptions } from '@openai/codex-sdk';
import { createDegradedBatchDiscoveryArtifact } from '@opsense/ai-provider';
import type {
  BatchDiscoveryAdapter,
  BatchDiscoveryOptions,
  BatchReconciliationAdapter,
} from '@opsense/ai-provider';
import { validateBatchDiscoveryDecision } from '@opsense/discovery';
import {
  BatchDiscoveryArtifactSchema,
  BatchDiscoveryDecisionSchema,
  assertSchema,
} from '@opsense/schema';
import type {
  BatchDiscoveryArtifact,
  BatchDiscoveryInput,
  BatchDiscoveryRun,
  BatchReconciliationInput,
} from '@opsense/schema';

interface CodexClient {
  resumeThread(id: string, options?: ThreadOptions): Thread;
  startThread(options?: ThreadOptions): Thread;
}

export interface CodexBatchDiscoveryAdapterOptions {
  client?: CodexClient;
  now?: () => Date;
}

export class CodexBatchDiscoveryAdapter
  implements BatchDiscoveryAdapter, BatchReconciliationAdapter
{
  public readonly name = 'codex';
  private readonly client: CodexClient;
  private readonly now: () => Date;

  public constructor(options: CodexBatchDiscoveryAdapterOptions = {}) {
    this.client = options.client ?? new Codex();
    this.now = options.now ?? (() => new Date());
  }

  public async discover(
    input: BatchDiscoveryInput,
    options: BatchDiscoveryOptions = {},
    initialPrompt = discoveryPrompt(input),
    allowProbeRequests = true,
  ): Promise<BatchDiscoveryArtifact> {
    const startedAt = this.now();
    const maxCalls = options.maxCalls ?? 3;
    const maxRetries = options.maxRetries ?? 2;
    const usage = emptyUsage();
    let callCount = 0;
    let repairCount = 0;
    let threadId = options.threadId;
    const signal = timeoutSignal(options.signal, options.timeoutMs ?? 120_000);
    try {
      const threadOptions: ThreadOptions = {
        approvalPolicy: 'never',
        modelReasoningEffort: 'low',
        networkAccessEnabled: false,
        sandboxMode: 'read-only',
        skipGitRepoCheck: true,
        ...(options.model === undefined ? {} : { model: options.model }),
      };
      const thread =
        threadId === undefined
          ? this.client.startThread(threadOptions)
          : this.client.resumeThread(threadId, threadOptions);
      let result = await runTurn(thread, initialPrompt, signal, maxRetries, () => {
        if (callCount >= maxCalls) throw new Error('Batch Discovery AI call budget exhausted.');
        callCount += 1;
      });
      addUsage(usage, result.usage);
      threadId = thread.id ?? threadId;

      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        const validation = validationForResult(result, input, allowProbeRequests);
        if (validation.valid && validation.decision !== undefined) {
          const finishedAt = this.now();
          const artifact: BatchDiscoveryArtifact = {
            batchErrors: [],
            completion: validation.completion,
            decision: validation.decision,
            itemErrors: [],
            run: {
              callCount,
              durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
              finishedAt: finishedAt.toISOString(),
              provider: this.name,
              repairCount,
              startedAt: startedAt.toISOString(),
              status: 'completed',
              usage,
              ...(options.model === undefined ? {} : { model: options.model }),
              ...(threadId === undefined ? {} : { threadId }),
            },
            schemaVersion: '3.0',
          };
          assertSchema(BatchDiscoveryArtifactSchema, artifact);
          return artifact;
        }
        if (attempt === maxRetries) {
          throw new Error(describeValidationFailure(validation));
        }
        repairCount += 1;
        result = await runTurn(thread, repairPrompt(validation), signal, maxRetries, () => {
          if (callCount >= maxCalls) throw new Error('Batch Discovery AI call budget exhausted.');
          callCount += 1;
        });
        addUsage(usage, result.usage);
        threadId = thread.id ?? threadId;
      }
      throw new Error('Batch Discovery repair loop ended unexpectedly.');
    } catch (error) {
      const finishedAt = this.now();
      const message = error instanceof Error ? error.message : String(error);
      return createDegradedBatchDiscoveryArtifact(input, {
        error: message,
        finishedAt,
        provider: this.name,
        run: {
          callCount,
          durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
          repairCount,
          usage,
        },
        startedAt,
        ...(options.model === undefined ? {} : { model: options.model }),
        ...(threadId === undefined ? {} : { threadId }),
      });
    }
  }

  public reconcile(
    input: BatchReconciliationInput,
    options: BatchDiscoveryOptions = {},
  ): Promise<BatchDiscoveryArtifact> {
    return this.discover(input.discoveryInput, options, reconciliationPrompt(input), false);
  }
}

async function runTurn(
  thread: Thread,
  prompt: string,
  signal: AbortSignal,
  maxRetries: number,
  onCall: () => void,
): Promise<RunResult> {
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      onCall();
      return await thread.run(prompt, { outputSchema: BatchDiscoveryDecisionSchema, signal });
    } catch (error) {
      if (attempt === maxRetries || signal.aborted || !isTransientError(error)) throw error;
    }
  }
  throw new Error('Batch Discovery transport retry loop ended unexpectedly.');
}

function discoveryPrompt(input: BatchDiscoveryInput): string {
  return `OpSense Batch Discovery contract ${input.contractVersion}.

Classify and merge every protected deployment candidate in this single payload:
${JSON.stringify(input)}

Return exactly one BatchDiscoveryDecision JSON object. Requirements:
1. Every candidateId must occur exactly once across services[].sourceCandidateIds, filteredCandidateIds, or retainedUnknownCandidateIds. Merge candidates only when the supplied facts support one deployment unit.
2. Preserve Docker, Compose, exposed/listening sockets, failed units, custom units/paths, service storage, and conflict candidates. When semantic evidence is insufficient, use needs_review or retainedUnknownCandidateIds; never silently omit them.
3. sourceObjectIds must belong to the service's source candidates. evidenceIds may only use IDs supplied on those candidates. AI semantic confidence may only be inferred or unknown.
4. Do not alter factual ports, paths, runtime state, deployment hints, object IDs, or evidence. Do not invent dependencies or business purpose.
5. Probe requests are optional and must use only probePolicy.allowedKinds, stay within its budget, cite supplied evidence, and contain no shell command.
6. Copy sourceCandidateSetHash exactly. Return JSON only; do not call tools, read files, access the network, or execute commands.`;
}

function reconciliationPrompt(input: BatchReconciliationInput): string {
  return `OpSense Batch Reconciliation contract ${input.contractVersion}.

Revise the original Batch Discovery decision once using the governed probe results:
${JSON.stringify(input)}

Return exactly one complete BatchDiscoveryDecision JSON object. Preserve all deterministic facts and candidate coverage. Use newEvidence only to resolve unknown fields, review items, merge decisions, and requested semantics. Do not claim confirmed semantic confidence. Do not request a second probe round. probeRequests must be empty. Copy discoveryInput.sourceCandidateSetHash exactly. Return JSON only; do not call tools, read files, access the network, or execute commands.`;
}

function repairPrompt(validation: ReturnType<typeof validateBatchDiscoveryDecision>): string {
  const acceptedServiceIds =
    validation.decision?.services.map((service) => service.serviceId) ?? [];
  return `The Batch Discovery result failed local validation.
Batch errors: ${JSON.stringify(validation.batchErrors)}
Item errors: ${JSON.stringify(validation.itemErrors)}
Missing candidates: ${JSON.stringify(validation.completion.missingCandidateIds)}
Duplicate candidates: ${JSON.stringify(validation.completion.duplicateCandidateIds)}
Already valid service IDs: ${JSON.stringify(acceptedServiceIds)}

Return a corrected complete BatchDiscoveryDecision JSON object using the same original candidate payload. Preserve valid items and IDs. Fix only the listed errors. Every candidate must have exactly one outcome and sourceCandidateSetHash must match. Return JSON only.`;
}

function describeValidationFailure(
  validation: ReturnType<typeof validateBatchDiscoveryDecision>,
): string {
  return `Batch Discovery validation failed after repair: ${[
    ...validation.batchErrors,
    ...validation.itemErrors.map(
      (error) => `${error.itemId}.${error.field} ${error.code}: ${error.message}`,
    ),
  ].join('; ')}`;
}

function validationForResult(
  result: RunResult,
  input: BatchDiscoveryInput,
  allowProbeRequests: boolean,
): ReturnType<typeof validateBatchDiscoveryDecision> {
  try {
    return validateBatchDiscoveryDecision(parseJson(result), input, { allowProbeRequests });
  } catch (error) {
    return {
      batchErrors: [
        `Discovery output is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      ],
      completion: {
        complete: false,
        duplicateCandidateIds: [],
        handledCandidateIds: [],
        missingCandidateIds: input.candidates.map((candidate) => candidate.candidateId),
      },
      itemErrors: [],
      valid: false,
    };
  }
}

function parseJson(result: RunResult): unknown {
  const source = result.finalResponse.trim();
  const unfenced = source.startsWith('```')
    ? source.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    : source;
  return JSON.parse(unfenced) as unknown;
}

function emptyUsage(): BatchDiscoveryRun['usage'] {
  return { cachedInputTokens: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
}

function addUsage(target: BatchDiscoveryRun['usage'], usage: RunResult['usage']): void {
  if (usage === null) return;
  target.cachedInputTokens += usage.cached_input_tokens;
  target.inputTokens += usage.input_tokens;
  target.outputTokens += usage.output_tokens;
  target.reasoningTokens += usage.reasoning_output_tokens;
}

function isTransientError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /overloaded|temporar|try again|stream disconnected|connection|ECONN|rate limit|timeout/i.test(
    message,
  );
}

function timeoutSignal(external: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return external === undefined ? timeout : AbortSignal.any([external, timeout]);
}
