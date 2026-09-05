import type {
  BatchDiscoveryArtifact,
  BatchDiscoveryInput,
  BatchReconciliationInput,
  DeploymentInventory,
  EvidenceRecord,
  InventoryRevision,
  PostReportAgentResult,
  WikiProjectionV3,
  WikiRevision,
  WikiNarrativeResult,
} from '@opsense/schema';

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

export interface BatchReconciliationAdapter {
  readonly name: string;
  reconcile(
    input: BatchReconciliationInput,
    options?: BatchDiscoveryOptions,
  ): Promise<BatchDiscoveryArtifact>;
}

export interface WikiComposer {
  readonly name: string;
  compose(
    inventory: DeploymentInventory,
    options?: BatchDiscoveryOptions,
  ): Promise<WikiNarrativeResult>;
}

export interface PostReportAgentInput {
  inventory: DeploymentInventory;
  wiki: WikiProjectionV3;
  evidence: EvidenceRecord[];
  inventoryRevisions: InventoryRevision[];
  wikiRevisions: WikiRevision[];
  prompt: string;
}

export interface PostReportAgentOptions {
  maxRetries?: number;
  model?: string;
  signal?: AbortSignal;
  threadId?: string;
  timeoutMs?: number;
}

export interface PostReportAgentAdapter {
  readonly name: string;
  investigate(
    input: PostReportAgentInput,
    options?: PostReportAgentOptions,
  ): Promise<PostReportAgentResult>;
}
