import { Codex } from '@openai/codex-sdk';
import type { RunResult, Thread, ThreadOptions } from '@openai/codex-sdk';
import type {
  PostReportAgentAdapter,
  PostReportAgentInput,
  PostReportAgentOptions,
} from '@opsense/ai-provider';
import { PostReportAgentProposalSchema, assertSchema } from '@opsense/schema';
import type { PostReportAgentProposal, PostReportAgentResult } from '@opsense/schema';

interface CodexClient {
  resumeThread(id: string, options?: ThreadOptions): Thread;
  startThread(options?: ThreadOptions): Thread;
}

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    message: { type: 'string', minLength: 1 },
    inventoryChanges: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          serviceId: { type: 'string' },
          evidenceIds: { type: 'array', items: { type: 'string' } },
          reason: { type: 'string' },
          name: { type: 'string' },
          purpose: { type: 'string' },
          role: {
            type: 'string',
            enum: [
              'primary_application',
              'infrastructure_service',
              'edge_service',
              'supporting_component',
              'container_platform',
              'system_service',
              'needs_review',
            ],
          },
          reviewItems: { type: 'array', items: { type: 'string' } },
        },
        required: ['serviceId', 'evidenceIds', 'reason'],
        additionalProperties: false,
      },
    },
    wikiChanges: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          section: {
            type: 'string',
            enum: ['overview', 'service', 'operations', 'risks'],
          },
          serviceId: { type: 'string' },
          content: { type: 'string' },
          evidenceIds: { type: 'array', items: { type: 'string' } },
          reason: { type: 'string' },
        },
        required: ['section', 'content', 'evidenceIds', 'reason'],
        additionalProperties: false,
      },
    },
    evidenceReferences: { type: 'array', items: { type: 'string' } },
    unresolvedQuestions: { type: 'array', items: { type: 'string' } },
    nextSuggestions: { type: 'array', items: { type: 'string' } },
  },
  required: [
    'message',
    'inventoryChanges',
    'wikiChanges',
    'evidenceReferences',
    'unresolvedQuestions',
    'nextSuggestions',
  ],
  additionalProperties: false,
} as const;

export interface CodexPostReportAgentOptions {
  client?: CodexClient;
  now?: () => Date;
}

export class CodexPostReportAgentAdapter implements PostReportAgentAdapter {
  public readonly name = 'codex';
  private readonly client: CodexClient;
  private readonly now: () => Date;

  public constructor(options: CodexPostReportAgentOptions = {}) {
    this.client = options.client ?? new Codex();
    this.now = options.now ?? (() => new Date());
  }

  public async investigate(
    input: PostReportAgentInput,
    options: PostReportAgentOptions = {},
  ): Promise<PostReportAgentResult> {
    const startedAt = this.now();
    const threadOptions: ThreadOptions = {
      approvalPolicy: 'never',
      modelReasoningEffort: 'low',
      networkAccessEnabled: false,
      sandboxMode: 'read-only',
      skipGitRepoCheck: true,
      ...(options.model === undefined ? {} : { model: options.model }),
    };
    const thread =
      options.threadId === undefined
        ? this.client.startThread(threadOptions)
        : this.client.resumeThread(options.threadId, threadOptions);
    const signal = timeoutSignal(options.signal, options.timeoutMs ?? 120_000);
    const maxRetries = options.maxRetries ?? 1;
    let callCount = 0;
    let repairCount = 0;
    let result = await run(thread, promptFor(input), signal);
    callCount += 1;
    let proposal: PostReportAgentProposal | undefined;
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        proposal = parseProposal(result);
        break;
      } catch (error) {
        lastError = error;
        if (attempt === maxRetries) break;
        repairCount += 1;
        result = await run(
          thread,
          `上一轮输出未通过 Schema 校验：${error instanceof Error ? error.message : String(error)}。请只返回修正后的完整 JSON 对象。`,
          signal,
        );
        callCount += 1;
      }
    }
    if (proposal === undefined)
      throw new Error('Codex post-report response did not pass local schema validation.', {
        cause: lastError,
      });
    const finishedAt = this.now();
    return {
      proposal,
      run: {
        callCount,
        durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
        finishedAt: finishedAt.toISOString(),
        provider: this.name,
        repairCount,
        startedAt: startedAt.toISOString(),
        status: 'completed',
        ...(options.model === undefined ? {} : { model: options.model }),
        ...(thread.id === null ? {} : { threadId: thread.id }),
      },
    };
  }
}

function promptFor(input: PostReportAgentInput): string {
  const referencedIds = new Set([
    ...input.inventory.services.flatMap((service) => service.evidenceIds),
    ...input.inventory.findings.flatMap((finding) => finding.evidenceIds),
    ...input.inventory.filteredGroups.flatMap((group) => group.evidenceIds),
    ...input.inventoryRevisions.flatMap((revision) =>
      revision.changes.flatMap((change) => change.evidenceIds),
    ),
    ...input.wikiRevisions.flatMap((revision) =>
      revision.changes.flatMap((change) => change.evidenceIds),
    ),
  ]);
  const evidence = input.evidence
    .filter((item) => referencedIds.has(item.id))
    .map((item) => ({
      id: item.id,
      kind: item.kind,
      source: item.source,
      field: item.field,
      status: item.status,
      value: compactValue(item.value),
    }));
  return `你是 OpSense v3 报告后调查 Agent。回答用户问题，并且只在现有证据足以支持时提出追加修订。

用户请求：${input.prompt}

稳定 Inventory、当前 Wiki、只读 Evidence 和既有追加修订：
${JSON.stringify({ inventory: input.inventory, wiki: input.wiki, evidence, inventoryRevisions: input.inventoryRevisions, wikiRevisions: input.wikiRevisions })}

约束：
1. 不得执行命令、访问网络、扫描服务器或修改稳定 Inventory/Wiki。
2. inventoryChanges 和 wikiChanges 只是追加修订；所有 serviceId、evidenceIds 必须来自输入。
3. Evidence 不足时不要猜测，写入 unresolvedQuestions。
4. service Wiki 修订必须提供 serviceId；overview、operations、risks 修订不得提供 serviceId。
5. 只返回符合 JSON Schema 的 JSON，不要 Markdown。`;
}

function compactValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return value.length <= 2_000 ? value : `${value.slice(0, 2_000)}…`;
}

function parseProposal(result: RunResult): PostReportAgentProposal {
  const source = result.finalResponse.trim();
  const unfenced = source.startsWith('```')
    ? source.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    : source;
  const value = JSON.parse(unfenced) as unknown;
  assertSchema(PostReportAgentProposalSchema, value);
  return value;
}

function run(thread: Thread, prompt: string, signal: AbortSignal): Promise<RunResult> {
  return thread.run(prompt, { outputSchema: OUTPUT_SCHEMA, signal });
}

function timeoutSignal(external: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return external === undefined ? timeout : AbortSignal.any([external, timeout]);
}
