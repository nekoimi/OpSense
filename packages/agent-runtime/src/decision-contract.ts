import {
  ComposeWikiArgumentsSchema,
  ExecuteGovernedProbeArgumentsSchema,
  ListCandidatesArgumentsSchema,
  PlanDiscoveryArgumentsSchema,
  ReadContextArgumentsSchema,
  ReadEvidenceArgumentsSchema,
  SchemaValidationError,
  UpdateProjectionArgumentsSchema,
  validateSchema,
} from '@opsense/schema';
import type { AgentToolName } from '@opsense/schema';

const ID_RULE =
  'Every ID must be a non-empty existing or newly requested identifier matching ^[A-Za-z0-9][A-Za-z0-9._:-]*$. IDs cannot contain spaces, slashes, or brackets.';

const PROBE_COMMON_CONTRACT = `Every ProbeRequest has exactly these common fields plus the kind-specific fields below:
{"id":"valid-id","kind":"one allowed kind","targetServiceId":"existing-service-id","reason":"non-empty string","expectedFields":["non-empty string",...],"evidenceIds":["existing-evidence-id",...],"maxBytes":1024..5000000,"timeoutMs":1000..60000}
ProbeRequest kind-specific fields:
- directory_metadata: {"path":"non-empty collected path"}
- directory_listing: {"path":"non-empty collected path","maxDepth":1..8,"maxMatches":1..1000}
- config_summary: {"path":"non-empty collected path"}
- path_search: {"searchRoot":"non-empty collected path","searchTerm":"non-empty evidence-derived term","maxDepth":1..8,"maxMatches":1..1000}
- systemd_unit: {"unitName":"non-empty collected unit name"}
- process_runtime: {"pid":1..4194304}
- process_cgroup: {"pid":1..4194304}
- socket_ownership: {"socketId":"existing-socket-id"}
- container_inspect: {"containerId":"existing-container-id"}
- compose_metadata: {"composeProjectId":"existing-compose-project-id"}
- log_metadata: {"path":"non-empty collected path"}
No ProbeRequest accepts shell text, command text, or additional properties.`;

export const AGENT_TOOL_ARGUMENT_CONTRACTS: Readonly<Record<AgentToolName, string>> = {
  read_context: `arguments must contain exactly:
{"section":"host|storage|network|services|processes|containers|systemd_units|systemd_summary|path_candidates|findings|visibility_summary|discovery|wiki_source","offset"?:integer >= 0,"limit"?:integer 1..12}
section is required. No additional properties.`,
  read_evidence: `arguments must contain at least one of these fields and no others:
{"ids"?:["existing-evidence-id",... 1..20],"serviceId"?:"existing-service-id","field"?:"non-empty field or source fragment"}
An empty object and an empty ids array are invalid.`,
  list_candidates: `arguments may contain only:
{"offset"?:integer >= 0,"limit"?:integer 1..500}
This tool returns a lightweight service-filtering index only. Omit offset and limit to read up to 500 current service candidates in one call. Use read_context for detailed processes, containers, systemd units, paths, network, storage, or findings. No additional properties.`,
  execute_governed_probe: `arguments must use exactly one of these forms:
{"request":ProbeRequest}
{"requests":[ProbeRequest,... 1..4]}
Do not combine request and requests. Prefer requests for 1-4 related evidence gaps.
${PROBE_COMMON_CONTRACT}`,
  plan_discovery: `arguments must contain exactly all seven fields below; no field is optional and no additional property is allowed:
{
  "planningCompleted":boolean,
  "discoveryCompleted":boolean,
  "investigations":[DiscoveryInvestigation,...],
  "discoveredServices":[DiscoveredService,...],
  "filteredGroups":[DiscoveryFilterGroup,...],
  "unresolvedQuestions":[string,...],
  "reason":"non-empty string"
}
DiscoveryInvestigation contains exactly:
{"investigationId":"valid-id","label":"non-empty string","status":"selected|investigating|resolved|needs_review","priority":"critical|high|medium|low","serviceIds":["existing-service-id",...],"sourceObjectIds":["existing-raw-object-id",...],"evidenceIds":["existing-evidence-id",... at least 1],"reason":"non-empty string"}
DiscoveredService contains exactly:
{"serviceId":"valid-id","name":"non-empty string","displayName"?:string,"deploymentType":"systemd|process|docker|compose|unknown","status":"running|stopped|failed|unknown","sourceObjectIds":["existing-raw-object-id",... at least 1],"evidenceIds":["existing-evidence-id",... at least 1],"unknownFields":["non-empty string",...],"reason":"non-empty string"}
DiscoveryFilterGroup contains exactly:
{"groupId":"valid-id","label":"non-empty string","resourceClass":"non-empty string","sourceObjectIds":["existing-raw-object-id",... at least 1],"evidenceIds":["existing-evidence-id",... at least 1],"reason":"non-empty string"}
Existing service IDs returned by list_candidates belong only in investigations; never copy an existing service into discoveredServices. discoveredServices is exclusively for a genuinely new merged identity and its serviceId must start with service:agent:. Every list_candidates item with protected=true must appear in an investigation when planningCompleted=true. Related protected services may share one batch investigation; they do not require one investigation per service.
For investigation status, active, pending, done, complete, and arbitrary values are invalid. Use only selected, investigating, resolved, or needs_review. Every investigation requires priority, label, serviceIds, sourceObjectIds, evidenceIds, and reason. Filter groups do not accept status, priority, serviceIds, resourceType, count, or arbitrary metadata.`,
  update_projection: `arguments must contain exactly:
{"changes":[ServiceAssessmentChange|PathAssessmentChange,... at least 1],"evidenceIds":["existing-evidence-id",...],"reason"?:"non-empty string"}
ServiceAssessmentChange contains exactly:
{"changeType":"service_assessment","objectId":"existing-service-id","operation":"add|update","summary":"non-empty string","assessment":{"serviceId":"same-existing-service-id","role":"application|middleware|infrastructure|edge|container_platform|system|unknown","reportPlacement":"primary|supporting|system_summary|needs_review","importance":"critical|high|medium|low|unknown","purpose"?:string,"statusInterpretation"?:string,"reason":"non-empty string","confidence":"inferred|unknown|conflict","evidenceIds":["existing-evidence-id",...],"unknowns":[string,...],"reviewItems":[string,...]}}
role=system and reportPlacement=system_summary are a single paired classification. For a protected service where systemSummaryAllowed=false, neither value is allowed: change both fields in the same decision. Use an evidence-supported non-system role with primary, supporting, or needs_review; when evidence is insufficient, use role=unknown with reportPlacement=needs_review.
PathAssessmentChange contains exactly:
{"changeType":"path_assessment","objectId":"existing-service-id","operation":"add|update","summary":"non-empty string","assessment":{"serviceId":"same-existing-service-id","path":"non-empty existing collected path","semantic":"deploy|config|data|log|backup|runtime|system|unknown","reason":"non-empty string","confidence":"inferred|unknown|conflict","evidenceIds":["existing-evidence-id",...]}}
No change object or nested assessment accepts additional properties.`,
  compose_wiki: `arguments must contain exactly all nine fields below; no field is optional and no additional property is allowed:
{
  "executiveSummary":"2-4 concise server-level paragraphs separated by blank lines",
  "systemOverview":"concise system environment interpretation without repeating executiveSummary",
  "architectureOverview":"concise deployment architecture and evidence-backed relationship overview",
  "deploymentOverview":"concise deployment layout, configuration, data, log, and exposure overview",
  "operationsOverview":"concise operations, maintenance, risk, backup, and recovery overview",
  "serviceGroups":[{"title":"non-empty group title","summary":"non-empty group narrative","serviceIds":["assessed-service-id",... at least 1]},...],
  "serviceDescriptions":[{"serviceId":"assessed-service-id","description":"detailed operational description","basis":"name, image, runtime, port, path, or evidence basis","evidenceIds":["existing-evidence-id",... at least 1]},...],
  "keyFindings":[{"title":"non-empty title","summary":"non-empty evidence-backed narrative","severity":"info|low|medium|high|critical","evidenceIds":["existing-evidence-id",... at least 1]},...],
  "unresolvedQuestions":["non-empty question",...]
}
Write a professional Chinese server handbook for operations engineers. Keep each overview focused, use short paragraphs separated by blank lines, and do not repeat the same facts across executiveSummary, systemOverview, architectureOverview, deploymentOverview, and operationsOverview. serviceGroups drives the report's deployment relationship view: include every non-system-summary assessed service in exactly one group, use meaningful operational group titles, and describe only evidence-backed grouping relationships rather than inventing dependencies. Explain recognizable products from service/container/image identities (for example, a MinIO image is an object-storage service), but do not invent a description when identity and evidence are insufficient. serviceDescriptions may omit unrecognizable services. Do not invent topology, dependencies, credentials, commands, paths, ports, risks, or Evidence IDs.`,
};

const SHARED_DECISION_CONTRACT = `Every Codex-generated AgentDecision contains exactly these shared fields:
{"decisionId":"valid-id","turnId":"valid-id","kind":"tool_call|final|failed","reason":"non-empty string","nextAction":"non-empty string","unresolvedQuestions":[string,...],"nextSuggestions":[string,...]}
${ID_RULE}`;

export const AGENT_DECISION_PROMPT_CONTRACT = `${SHARED_DECISION_CONTRACT}

Choose exactly one kind-specific shape:
1. kind=tool_call adds exactly "toolName" and "arguments". toolName must be one of read_context, read_evidence, list_candidates, execute_governed_probe, plan_discovery, update_projection, compose_wiki, and arguments must match that tool's contract below.
2. kind=final adds exactly {"inventoryProjectionId":"valid-id","serviceWikiProjectionId":"valid-id","findingIds":["existing-finding-id",...],"qualitySummary":"non-empty string"}.
3. kind=failed adds exactly {"error":"non-empty string"}.

Projection changes have exactly one representation: use kind=tool_call, toolName=update_projection, and put changes/evidenceIds/reason inside arguments. Never emit kind=projection_update and never combine kind=projection_update with toolName or arguments.

Tool argument contracts:
[read_context]
${AGENT_TOOL_ARGUMENT_CONTRACTS.read_context}

[read_evidence]
${AGENT_TOOL_ARGUMENT_CONTRACTS.read_evidence}

[list_candidates]
${AGENT_TOOL_ARGUMENT_CONTRACTS.list_candidates}

[execute_governed_probe]
${AGENT_TOOL_ARGUMENT_CONTRACTS.execute_governed_probe}

[plan_discovery]
${AGENT_TOOL_ARGUMENT_CONTRACTS.plan_discovery}

[update_projection]
${AGENT_TOOL_ARGUMENT_CONTRACTS.update_projection}

[compose_wiki]
${AGENT_TOOL_ARGUMENT_CONTRACTS.compose_wiki}

Global JSON rules: emit JSON values, not schema notation; include every required field even when its array is empty; omit optional fields rather than setting them to null; do not add properties not listed for the chosen shape; do not emit Markdown, comments, NaN, Infinity, or trailing commas.`;

export function buildAgentDecisionRepairPrompt(error: unknown, candidate: unknown): string {
  const toolName = readAgentToolName(candidate);
  const toolErrors = toolName === undefined ? [] : validateToolArguments(toolName, candidate);
  const detail =
    toolErrors.length > 0
      ? `Tool argument validation errors:\n${toolErrors.map((item) => `- ${item}`).join('\n')}`
      : describeAgentDecisionValidationError(error, candidate);
  const relevantContract =
    toolName === undefined
      ? AGENT_DECISION_PROMPT_CONTRACT
      : `${SHARED_DECISION_CONTRACT}\n\nThe attempted tool is ${toolName}. Its arguments contract is:\n${AGENT_TOOL_ARGUMENT_CONTRACTS[toolName]}`;
  return `The previous AgentDecision failed local schema validation:
${detail}

Repair the complete decision. Preserve all valid IDs, evidence references, facts, and already valid fields. Change only fields needed to satisfy the contract. Do not replace missing evidence with invented IDs. If required facts are unavailable, use allowed unknown/needs_review values or choose a read tool. Return one complete logical AgentDecision; the transport wrapper instructions still apply.

${relevantContract}`;
}

export function describeAgentDecisionValidationError(error: unknown, candidate: unknown): string {
  const toolName = readAgentToolName(candidate);
  if (toolName !== undefined && readDecisionKind(candidate) !== 'tool_call')
    return `kind must be "tool_call" when toolName is "${toolName}"; projection changes must use the single tool_call + update_projection representation.`;
  if (toolName !== undefined) {
    const toolErrors = validateToolArguments(toolName, candidate);
    if (toolErrors.length > 0)
      return `Invalid ${toolName} arguments:\n${toolErrors.map((item) => `- ${item}`).join('\n')}`;
  }
  return conciseValidationError(error);
}

function validateToolArguments(toolName: AgentToolName, candidate: unknown): string[] {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) return [];
  const argumentsValue = (candidate as Record<string, unknown>).arguments;
  switch (toolName) {
    case 'read_context':
      return validationErrors(ReadContextArgumentsSchema, argumentsValue);
    case 'read_evidence':
      return validationErrors(ReadEvidenceArgumentsSchema, argumentsValue);
    case 'list_candidates':
      return validationErrors(ListCandidatesArgumentsSchema, argumentsValue);
    case 'execute_governed_probe':
      return validationErrors(ExecuteGovernedProbeArgumentsSchema, argumentsValue);
    case 'plan_discovery':
      return validationErrors(PlanDiscoveryArgumentsSchema, argumentsValue);
    case 'update_projection':
      return validationErrors(UpdateProjectionArgumentsSchema, argumentsValue);
    case 'compose_wiki':
      return validationErrors(ComposeWikiArgumentsSchema, argumentsValue);
  }
}

function validationErrors(schema: Parameters<typeof validateSchema>[0], value: unknown): string[] {
  const result = validateSchema(schema, value);
  return result.valid ? [] : result.errors;
}

function conciseValidationError(error: unknown): string {
  const errors =
    error instanceof SchemaValidationError
      ? error.validationErrors
      : [error instanceof Error ? error.message : String(error)];
  return [...new Set(errors)].slice(0, 20).join('\n');
}

function readAgentToolName(value: unknown): AgentToolName | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.toolName !== 'string') return undefined;
  return candidate.toolName in AGENT_TOOL_ARGUMENT_CONTRACTS
    ? (candidate.toolName as AgentToolName)
    : undefined;
}

function readDecisionKind(value: unknown): unknown {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>).kind
    : undefined;
}
