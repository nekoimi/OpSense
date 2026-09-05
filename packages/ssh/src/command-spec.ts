import { CommandSpecError } from './errors.js';

export type DistributionFamily = 'debian' | 'rhel' | 'alpine' | 'unknown';
export type CommandParameterValue = number | string | readonly string[];
export type SudoPolicy = 'never' | 'allowed' | 'required';

export interface CommandParameterSpec {
  allowedValues?: readonly string[];
  kind: 'string' | 'integer' | 'port' | 'path' | 'enum' | 'string_list' | 'path_list';
  max?: number;
  maxItems?: number;
  maxLength?: number;
  min?: number;
  minItems?: number;
  optional?: boolean;
  pattern?: RegExp;
  sensitive?: boolean;
}

export type CommandToken = { literal: string } | { flag?: string; parameter: string };

export interface CommandSpec {
  arguments: readonly CommandToken[];
  executable: string;
  id: string;
  maxOutputBytes: number;
  parameters: Readonly<Record<string, CommandParameterSpec>>;
  requiredCommands: readonly string[];
  sudo: SudoPolicy;
  supportedDistributions: readonly DistributionFamily[];
  timeoutMs: number;
}

export interface RenderedCommand {
  audit: string;
  execution: string;
  sudoUsed: boolean;
}

export interface RenderCommandOptions {
  sudoPassword?: boolean;
  useSudo?: boolean;
}

export function renderCommand(
  spec: CommandSpec,
  values: Readonly<Record<string, CommandParameterValue>> = {},
  options: RenderCommandOptions = {},
): RenderedCommand {
  validateExecutable(spec.executable);
  validateProvidedParameters(spec, values);

  const executionTokens: string[] = [];
  const auditTokens: string[] = [];
  const sudoUsed = spec.sudo === 'required' || options.useSudo === true;

  if (sudoUsed && spec.sudo === 'never') {
    throw new CommandSpecError(
      'COMMAND_SUDO_FORBIDDEN',
      `Command '${spec.id}' does not allow sudo.`,
    );
  }

  if (sudoUsed) {
    pushToken(executionTokens, 'sudo');
    if (options.sudoPassword === true) {
      pushToken(executionTokens, '-S');
      pushToken(executionTokens, '-k');
      pushToken(executionTokens, '-p');
      pushToken(executionTokens, '');
    } else {
      pushToken(executionTokens, '-n');
    }
    pushToken(executionTokens, '--');
    pushToken(auditTokens, 'sudo');
    if (options.sudoPassword === true) {
      pushToken(auditTokens, '-S');
      pushToken(auditTokens, '-k');
      pushToken(auditTokens, '-p');
      pushToken(auditTokens, '');
    } else {
      pushToken(auditTokens, '-n');
    }
    pushToken(auditTokens, '--');
  }

  pushToken(executionTokens, spec.executable);
  pushToken(auditTokens, spec.executable);

  for (const token of spec.arguments) {
    if ('literal' in token) {
      validateToken(token.literal, `literal argument in '${spec.id}'`);
      pushToken(executionTokens, token.literal);
      pushToken(auditTokens, token.literal);
      continue;
    }

    const parameterSpec = spec.parameters[token.parameter];
    if (parameterSpec === undefined) {
      throw new CommandSpecError(
        'COMMAND_SPEC_INVALID',
        `Command '${spec.id}' references undefined parameter '${token.parameter}'.`,
      );
    }
    const value = values[token.parameter];
    if (value === undefined && parameterSpec.optional === true) {
      continue;
    }
    if (value === undefined) {
      throw new CommandSpecError(
        'COMMAND_PARAMETER_REQUIRED',
        `Command '${spec.id}' requires parameter '${token.parameter}'.`,
      );
    }

    const normalized = validateParameter(token.parameter, parameterSpec, value);
    if (token.flag !== undefined) {
      validateToken(token.flag, `flag for '${token.parameter}'`);
      pushToken(executionTokens, token.flag);
      pushToken(auditTokens, token.flag);
    }
    for (const item of normalized) {
      pushToken(executionTokens, item);
      pushToken(
        auditTokens,
        parameterSpec.sensitive === true ? '[REDACTED]' : `[${token.parameter}]`,
      );
    }
  }

  return {
    audit: auditTokens.join(' '),
    execution: executionTokens.join(' '),
    sudoUsed,
  };
}

export function quotePosixShellArgument(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function validateProvidedParameters(
  spec: CommandSpec,
  values: Readonly<Record<string, CommandParameterValue>>,
): void {
  for (const key of Object.keys(values)) {
    if (spec.parameters[key] === undefined) {
      throw new CommandSpecError(
        'COMMAND_PARAMETER_UNKNOWN',
        `Command '${spec.id}' does not define parameter '${key}'.`,
      );
    }
  }
}

function validateExecutable(executable: string): void {
  if (!/^[A-Za-z0-9_+./-]+$/.test(executable)) {
    throw new CommandSpecError('COMMAND_EXECUTABLE_INVALID', `Unsafe executable: ${executable}`);
  }
}

function validateToken(value: string, label: string): void {
  if (value.includes('\0') || /[\r\n]/.test(value)) {
    throw new CommandSpecError('COMMAND_TOKEN_INVALID', `Invalid ${label}.`);
  }
}

function validateParameter(
  name: string,
  spec: CommandParameterSpec,
  value: CommandParameterValue,
): readonly string[] {
  if (spec.kind === 'string_list' || spec.kind === 'path_list') {
    if (!Array.isArray(value)) {
      throw new CommandSpecError(
        'COMMAND_PARAMETER_INVALID',
        `Parameter '${name}' must be a list.`,
      );
    }
    const minimum = spec.minItems ?? 1;
    const maximum = spec.maxItems ?? 64;
    if (value.length < minimum || value.length > maximum) {
      throw new CommandSpecError(
        'COMMAND_PARAMETER_INVALID',
        `Parameter '${name}' must contain between ${minimum} and ${maximum} items.`,
      );
    }
    const scalarSpec: CommandParameterSpec = {
      ...spec,
      kind: spec.kind === 'path_list' ? 'path' : 'string',
    };
    return value.map((item) => validateScalarParameter(name, scalarSpec, item));
  }
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new CommandSpecError(
      'COMMAND_PARAMETER_INVALID',
      `Parameter '${name}' does not accept a list.`,
    );
  }
  return [validateScalarParameter(name, spec, value)];
}

function validateScalarParameter(
  name: string,
  spec: CommandParameterSpec,
  value: number | string,
): string {
  const normalized = String(value);
  validateToken(normalized, `value for '${name}'`);
  if (hasControlCharacters(normalized)) {
    throw new CommandSpecError(
      'COMMAND_PARAMETER_INVALID',
      `Parameter '${name}' contains control characters.`,
    );
  }

  if (spec.maxLength !== undefined && normalized.length > spec.maxLength) {
    throw new CommandSpecError('COMMAND_PARAMETER_INVALID', `Parameter '${name}' is too long.`);
  }

  if (spec.kind === 'path' && !normalized.startsWith('/')) {
    throw new CommandSpecError(
      'COMMAND_PARAMETER_INVALID',
      `Path parameter '${name}' must be absolute.`,
    );
  }

  if (spec.kind === 'integer' || spec.kind === 'port') {
    const parsed = typeof value === 'number' ? value : Number(value);
    const minimum = spec.kind === 'port' ? 1 : spec.min;
    const maximum = spec.kind === 'port' ? 65_535 : spec.max;
    if (
      !Number.isInteger(parsed) ||
      (minimum !== undefined && parsed < minimum) ||
      (maximum !== undefined && parsed > maximum)
    ) {
      throw new CommandSpecError(
        'COMMAND_PARAMETER_INVALID',
        `Parameter '${name}' must be a valid ${spec.kind}.`,
      );
    }
  }

  if (spec.kind === 'enum' && !spec.allowedValues?.includes(normalized)) {
    throw new CommandSpecError(
      'COMMAND_PARAMETER_INVALID',
      `Parameter '${name}' is not an allowed value.`,
    );
  }

  if (spec.pattern !== undefined && !spec.pattern.test(normalized)) {
    throw new CommandSpecError(
      'COMMAND_PARAMETER_INVALID',
      `Parameter '${name}' does not match the required pattern.`,
    );
  }

  return normalized;
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
}

function pushToken(target: string[], value: string): void {
  target.push(quotePosixShellArgument(value));
}
