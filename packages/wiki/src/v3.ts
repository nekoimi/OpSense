import { createHash } from 'node:crypto';

import { WikiProjectionV3Schema, assertSchema } from '@opsense/schema';
import type {
  DeploymentInventory,
  WikiNarrativeProposal,
  WikiProjectionV3,
  WikiQualityResult,
} from '@opsense/schema';

export function deploymentInventoryHash(inventory: DeploymentInventory): string {
  return createHash('sha256').update(JSON.stringify(inventory)).digest('hex');
}

export function buildWikiProjectionV3(
  inventory: DeploymentInventory,
  narrative?: WikiNarrativeProposal,
  options: { now?: () => Date; requireNarrative?: boolean } = {},
): { projection: WikiProjectionV3; quality: WikiQualityResult } {
  const inventoryHash = deploymentInventoryHash(inventory);
  const errors = validateNarrative(inventory, inventoryHash, narrative);
  const services = inventory.services.map((service) => ({
    deploymentHints: service.deploymentHints,
    evidenceIds: service.evidenceIds,
    name: service.name,
    pathIds: service.pathIds,
    ports: service.ports,
    ...(service.purpose === undefined ? {} : { purpose: service.purpose }),
    reviewItems: service.reviewItems,
    role: service.role,
    serviceId: service.serviceId,
    unknownFields: service.unknownFields,
  }));
  const projection: WikiProjectionV3 = {
    filteredGroups: inventory.filteredGroups,
    generatedAt: (options.now ?? (() => new Date()))().toISOString(),
    host: inventory.host,
    inventoryHash,
    inventoryId: inventory.inventoryId,
    projectionId: stableId('wiki', `${inventory.inventoryId}|${inventoryHash}`),
    schemaVersion: '3.0',
    semanticStatus: inventory.semanticStatus,
    services,
    unresolvedQuestions: inventory.unresolvedQuestions,
    ...(narrative === undefined || errors.length > 0 ? {} : { narrative }),
  };
  assertSchema(WikiProjectionV3Schema, projection);
  const narratableServiceIds = new Set(
    services
      .filter((service) => service.role !== 'system_service')
      .map((service) => service.serviceId),
  );
  const described = new Set(
    narrative?.serviceDescriptions
      .filter((item) => narratableServiceIds.has(item.serviceId))
      .map((item) => item.serviceId) ?? [],
  );
  const serviceCoverage =
    narratableServiceIds.size === 0 ? 1 : described.size / narratableServiceIds.size;
  const narrativeClaims = [
    ...(narrative?.serviceDescriptions ?? []),
    ...(narrative?.operationsConcerns ?? []),
  ];
  const evidenceReferenceCoverage =
    narrativeClaims.length === 0
      ? 0
      : narrativeClaims.filter((item) => item.evidenceIds.length > 0).length /
        narrativeClaims.length;
  const requiredErrors =
    options.requireNarrative === true && narrative === undefined
      ? ['Formal Wiki composition requires a Codex narrative.']
      : [];
  const quality: WikiQualityResult = {
    errors: [...errors, ...requiredErrors],
    evidenceReferenceCoverage,
    passed: errors.length === 0 && requiredErrors.length === 0,
    serviceCoverage,
    warnings: [
      ...(narrative === undefined ? ['Wiki contains only the deterministic local skeleton.'] : []),
      ...(serviceCoverage < 1 ? ['Not every non-system service has a narrative description.'] : []),
      ...(narrative !== undefined && evidenceReferenceCoverage < 1
        ? ['Some narrative claims do not cite Evidence IDs.']
        : []),
    ],
  };
  return { projection, quality };
}

export function validateNarrative(
  inventory: DeploymentInventory,
  inventoryHash: string,
  narrative: WikiNarrativeProposal | undefined,
): string[] {
  if (narrative === undefined) return [];
  const errors: string[] = [];
  if (narrative.inventoryId !== inventory.inventoryId)
    errors.push('Narrative inventoryId mismatch.');
  if (narrative.inventoryHash !== inventoryHash) errors.push('Narrative inventoryHash mismatch.');
  const services = new Map(inventory.services.map((service) => [service.serviceId, service]));
  const allEvidenceIds = new Set([
    ...inventory.services.flatMap((service) => service.evidenceIds),
    ...inventory.findings.flatMap((finding) => finding.evidenceIds),
  ]);
  const seen = new Set<string>();
  for (const description of narrative.serviceDescriptions) {
    const service = services.get(description.serviceId);
    if (service === undefined) {
      errors.push(`Narrative references unknown service '${description.serviceId}'.`);
      continue;
    }
    if (seen.has(description.serviceId)) {
      errors.push(`Narrative repeats service '${description.serviceId}'.`);
    }
    seen.add(description.serviceId);
    const allowed = new Set(service.evidenceIds);
    for (const id of description.evidenceIds) {
      if (!allowed.has(id))
        errors.push(
          `Service narrative '${description.serviceId}' references unrelated Evidence '${id}'.`,
        );
    }
  }
  for (const concern of narrative.operationsConcerns) {
    for (const id of concern.evidenceIds) {
      if (!allEvidenceIds.has(id))
        errors.push(`Operations concern references unknown Evidence '${id}'.`);
    }
  }
  return errors;
}

function stableId(prefix: string, value: string): string {
  return `${prefix}:${createHash('sha256').update(value).digest('hex').slice(0, 20)}`;
}
