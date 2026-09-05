import {
  BatchDiscoveryDecisionSchema,
  DiscoveredServiceDraftSchema,
  validateSchema,
} from '@opsense/schema';
import type {
  BatchDiscoveryDecision,
  BatchDiscoveryInput,
  DiscoveryCompletion,
  DiscoveredServiceDraft,
  ItemValidationError,
} from '@opsense/schema';

export interface BatchDiscoveryValidation {
  batchErrors: string[];
  completion: DiscoveryCompletion;
  decision?: BatchDiscoveryDecision;
  itemErrors: ItemValidationError[];
  valid: boolean;
}

export function validateBatchDiscoveryDecision(
  value: unknown,
  input: BatchDiscoveryInput,
  options: { allowProbeRequests?: boolean } = {},
): BatchDiscoveryValidation {
  const emptyCompletion = completion(input, []);
  if (!isRecord(value) || !Array.isArray(value.services)) {
    return invalidBatch(emptyCompletion, ['Discovery output must be an object with services[].']);
  }
  const shellResult = validateSchema(BatchDiscoveryDecisionSchema, { ...value, services: [] });
  if (!shellResult.valid) return invalidBatch(emptyCompletion, shellResult.errors);

  const batchErrors: string[] = [];
  if (shellResult.data.sourceCandidateSetHash !== input.sourceCandidateSetHash) {
    batchErrors.push('sourceCandidateSetHash does not match the submitted candidate set.');
  }
  const candidates = new Map(
    input.candidates.map((candidate) => [candidate.candidateId, candidate]),
  );
  const accepted: DiscoveredServiceDraft[] = [];
  const itemErrors: ItemValidationError[] = [];
  const serviceIds = new Set<string>();
  for (const [index, rawService] of value.services.entries()) {
    const itemId = serviceItemId(rawService, index);
    const parsed = validateSchema(DiscoveredServiceDraftSchema, rawService);
    if (!parsed.valid) {
      itemErrors.push(
        ...parsed.errors.map((message) => ({
          code: 'SCHEMA_INVALID',
          field: schemaField(message),
          itemId,
          message,
        })),
      );
      continue;
    }
    const errors = validateReferences(parsed.data, candidates, input);
    if (serviceIds.has(parsed.data.serviceId)) {
      errors.push({
        code: 'DUPLICATE_SERVICE_ID',
        field: 'serviceId',
        itemId,
        message: `serviceId '${parsed.data.serviceId}' is duplicated.`,
      });
    }
    if (errors.length > 0) {
      itemErrors.push(...errors);
      continue;
    }
    serviceIds.add(parsed.data.serviceId);
    accepted.push(parsed.data);
  }

  const decision: BatchDiscoveryDecision = { ...shellResult.data, services: accepted };
  const candidateReferences = [
    ...accepted.flatMap((service) => service.sourceCandidateIds),
    ...decision.filteredCandidateIds,
    ...decision.retainedUnknownCandidateIds,
  ];
  const invalidOutcomeIds = candidateReferences.filter((id) => !candidates.has(id));
  if (invalidOutcomeIds.length > 0) {
    batchErrors.push(
      `Decision outcomes reference unknown candidates: ${unique(invalidOutcomeIds).join(', ')}.`,
    );
  }
  const visibleEvidenceIds = new Set(input.evidenceIndex.map((item) => item.id));
  const allowedProbeKinds = new Set(input.probePolicy.allowedKinds);
  const acceptedServiceIds = new Set(accepted.map((service) => service.serviceId));
  if (options.allowProbeRequests === false && decision.probeRequests.length > 0) {
    batchErrors.push('Reconciliation cannot request another probe round.');
  }
  if (decision.probeRequests.length > input.probePolicy.maxRequests) {
    batchErrors.push(
      `Probe request count ${decision.probeRequests.length} exceeds budget ${input.probePolicy.maxRequests}.`,
    );
  }
  for (const request of decision.probeRequests) {
    if (!allowedProbeKinds.has(request.kind)) {
      batchErrors.push(`Probe '${request.id}' uses disallowed kind '${request.kind}'.`);
    }
    if (!acceptedServiceIds.has(request.targetServiceId)) {
      batchErrors.push(
        `Probe '${request.id}' references unknown service '${request.targetServiceId}'.`,
      );
    }
    const invalidEvidenceIds = request.evidenceIds.filter((id) => !visibleEvidenceIds.has(id));
    if (invalidEvidenceIds.length > 0) {
      batchErrors.push(
        `Probe '${request.id}' references unavailable evidence: ${invalidEvidenceIds.join(', ')}.`,
      );
    }
  }
  const resultCompletion = completion(input, candidateReferences);
  if (resultCompletion.missingCandidateIds.length > 0) {
    batchErrors.push(
      `Completion gate is missing candidates: ${resultCompletion.missingCandidateIds.join(', ')}.`,
    );
  }
  if (resultCompletion.duplicateCandidateIds.length > 0) {
    batchErrors.push(
      `Candidates have multiple outcomes: ${resultCompletion.duplicateCandidateIds.join(', ')}.`,
    );
  }
  const valid = batchErrors.length === 0 && itemErrors.length === 0 && resultCompletion.complete;
  return { batchErrors, completion: resultCompletion, decision, itemErrors, valid };
}

function validateReferences(
  service: DiscoveredServiceDraft,
  candidates: ReadonlyMap<string, BatchDiscoveryInput['candidates'][number]>,
  input: BatchDiscoveryInput,
): ItemValidationError[] {
  const errors: ItemValidationError[] = [];
  const sourceCandidates = service.sourceCandidateIds.flatMap((id) => {
    const candidate = candidates.get(id);
    if (candidate !== undefined) return [candidate];
    errors.push(
      referenceError(service.serviceId, 'sourceCandidateIds', id, [...candidates.keys()]),
    );
    return [];
  });
  const allowedObjectIds = new Set(
    sourceCandidates.flatMap((candidate) => candidate.sourceObjectIds),
  );
  const allowedEvidenceIds = new Set(
    sourceCandidates.flatMap((candidate) => candidate.evidenceIds),
  );
  for (const id of service.sourceObjectIds) {
    if (!allowedObjectIds.has(id)) {
      errors.push(referenceError(service.serviceId, 'sourceObjectIds', id, [...allowedObjectIds]));
    }
  }
  for (const id of service.evidenceIds) {
    if (!allowedEvidenceIds.has(id)) {
      errors.push(referenceError(service.serviceId, 'evidenceIds', id, [...allowedEvidenceIds]));
    }
  }
  if (service.confidence === 'confirmed') {
    errors.push({
      allowedValues: ['inferred', 'unknown'],
      code: 'AI_CONFIDENCE_FORBIDDEN',
      field: 'confidence',
      itemId: service.serviceId,
      message: 'AI semantic classification cannot claim confirmed confidence.',
    });
  }
  const visibleEvidenceIds = new Set(input.evidenceIndex.map((item) => item.id));
  for (const id of service.evidenceIds) {
    if (!visibleEvidenceIds.has(id)) {
      errors.push(referenceError(service.serviceId, 'evidenceIds', id, [...visibleEvidenceIds]));
    }
  }
  return errors;
}

function referenceError(
  itemId: string,
  field: string,
  value: string,
  allowedValues: string[],
): ItemValidationError {
  return {
    allowedValues,
    code: 'REFERENCE_NOT_FOUND',
    field,
    itemId,
    message: `'${value}' is not available in the submitted candidate context.`,
  };
}

function completion(
  input: BatchDiscoveryInput,
  references: readonly string[],
): DiscoveryCompletion {
  const counts = new Map<string, number>();
  for (const id of references) counts.set(id, (counts.get(id) ?? 0) + 1);
  const candidateIds = input.candidates.map((candidate) => candidate.candidateId).sort();
  const handledCandidateIds = candidateIds.filter((id) => (counts.get(id) ?? 0) > 0);
  const missingCandidateIds = candidateIds.filter((id) => !counts.has(id));
  const duplicateCandidateIds = candidateIds.filter((id) => (counts.get(id) ?? 0) > 1);
  return {
    complete: missingCandidateIds.length === 0 && duplicateCandidateIds.length === 0,
    duplicateCandidateIds,
    handledCandidateIds,
    missingCandidateIds,
  };
}

function invalidBatch(
  completionValue: DiscoveryCompletion,
  batchErrors: string[],
): BatchDiscoveryValidation {
  return {
    batchErrors,
    completion: completionValue,
    itemErrors: [],
    valid: false,
  };
}

function serviceItemId(value: unknown, index: number): string {
  return isRecord(value) && typeof value.serviceId === 'string'
    ? value.serviceId
    : `services[${index}]`;
}

function schemaField(message: string): string {
  return message.split(' ')[0]?.replace(/^\//, '').replaceAll('/', '.') || 'service';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}
