import { Codex } from '@openai/codex-sdk';
import type { Thread, ThreadOptions } from '@openai/codex-sdk';
import type { CodexPreflightProbe, CodexPreflightResult } from '@opsense/agent-runtime';

interface CodexPreflightClient {
  startThread(options?: ThreadOptions): Thread;
}

const DEFAULT_PREFLIGHT_TIMEOUT_MS = 120_000;
const PREFLIGHT_OUTPUT_SCHEMA = {
  type: 'object',
  properties: { ok: { type: 'boolean', enum: [true] } },
  required: ['ok'],
  additionalProperties: false,
} as const;

export interface CodexSdkPreflightOptions {
  client?: CodexPreflightClient;
  model?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  workingDirectory: string;
}

export class CodexSdkPreflightProbe implements CodexPreflightProbe {
  private readonly client: CodexPreflightClient;

  public constructor(private readonly options: CodexSdkPreflightOptions) {
    this.client = options.client ?? new Codex();
  }

  public async check(): Promise<Omit<CodexPreflightResult, 'checkedAt'>> {
    const thread = this.client.startThread({
      approvalPolicy: 'never',
      networkAccessEnabled: false,
      sandboxMode: 'read-only',
      skipGitRepoCheck: true,
      modelReasoningEffort: 'low',
      workingDirectory: this.options.workingDirectory,
      ...(this.options.model === undefined ? {} : { model: this.options.model }),
    });
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_PREFLIGHT_TIMEOUT_MS;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal =
      this.options.signal === undefined
        ? timeoutSignal
        : AbortSignal.any([this.options.signal, timeoutSignal]);
    let result: Awaited<ReturnType<Thread['run']>>;
    try {
      result = await thread.run(
        'OpSense Codex preflight. Return exactly this JSON object and nothing else: {"ok":true}',
        { outputSchema: PREFLIGHT_OUTPUT_SCHEMA, signal },
      );
    } catch (error) {
      if (this.options.signal?.aborted === true)
        throw new Error('Codex preflight was interrupted by the user.', { cause: error });
      if (timeoutSignal.aborted)
        throw new Error(`Codex preflight timed out after ${timeoutMs} ms.`, { cause: error });
      throw error;
    }
    const validResponse = parsePreflightResponse(result.finalResponse);
    const threadId = thread.id;
    return {
      available: validResponse && threadId !== null,
      checks: {
        login: validResponse,
        model: validResponse,
        sdk: true,
        structuredResponse: validResponse,
        thread: threadId !== null,
      },
      ...(threadId === null ? {} : { threadId }),
      ...(validResponse
        ? {}
        : { error: 'Codex preflight did not return the required structured response.' }),
    };
  }
}

function parsePreflightResponse(value: string): boolean {
  const source = value.trim();
  const unfenced = source.startsWith('```')
    ? source.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    : source;
  try {
    const parsed = JSON.parse(unfenced) as unknown;
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      Object.keys(parsed).length === 1 &&
      'ok' in parsed &&
      parsed.ok === true
    );
  } catch {
    return false;
  }
}
