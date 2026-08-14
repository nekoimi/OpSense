import { Codex } from '@openai/codex-sdk';
import type { Thread, ThreadOptions } from '@openai/codex-sdk';
import type { CodexPreflightProbe, CodexPreflightResult } from '@opsense/agent-runtime';

interface CodexPreflightClient {
  startThread(options?: ThreadOptions): Thread;
}

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
      workingDirectory: this.options.workingDirectory,
      ...(this.options.model === undefined ? {} : { model: this.options.model }),
    });
    const signal = preflightSignal(this.options.signal, this.options.timeoutMs ?? 30_000);
    const result = await thread.run(
      'OpSense Codex preflight. Return exactly this JSON object and nothing else: {"ok":true}',
      { signal },
    );
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

function preflightSignal(external: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return external === undefined ? timeout : AbortSignal.any([external, timeout]);
}
