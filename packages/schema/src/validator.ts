import { createRequire } from 'node:module';

import type { Ajv as AjvInstance, ErrorObject, Options } from 'ajv';
import type { FormatsPlugin } from 'ajv-formats';
import type { Static, TSchema } from '@sinclair/typebox';

const require = createRequire(import.meta.url);
const Ajv = require('ajv') as new (options?: Options) => AjvInstance;
const addFormats = require('ajv-formats') as FormatsPlugin;

export type ValidationResult<T> =
  { data: T; errors: []; valid: true } | { errors: string[]; valid: false };

export class SchemaValidationError extends Error {
  public readonly validationErrors: string[];

  public constructor(validationErrors: string[]) {
    super(`Schema validation failed: ${validationErrors.join('; ')}`);
    this.name = 'SchemaValidationError';
    this.validationErrors = validationErrors;
  }
}

function createAjv(): AjvInstance {
  const ajv = new Ajv({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv;
}

function formatErrors(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map((error) => {
    const location = error.instancePath.length > 0 ? error.instancePath : '/';
    return `${location} ${error.message ?? 'is invalid'}`;
  });
}

export function validateSchema<T extends TSchema>(
  schema: T,
  value: unknown,
): ValidationResult<Static<T>> {
  const validate = createAjv().compile<Static<T>>(schema);

  if (validate(value)) {
    return { data: value, errors: [], valid: true };
  }

  return { errors: formatErrors(validate.errors), valid: false };
}

export function assertSchema<T extends TSchema>(
  schema: T,
  value: unknown,
): asserts value is Static<T> {
  const result = validateSchema(schema, value);
  if (!result.valid) {
    throw new SchemaValidationError(result.errors);
  }
}
