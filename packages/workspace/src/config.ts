import { constants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  DEFAULT_OPSENSE_CONFIG,
  OpsenseConfigSchema,
  SchemaValidationError,
  assertSchema,
} from '@opsense/schema';
import type { OpsenseConfig, OpsenseConfigOverrides } from '@opsense/schema';

import { ConfigError } from './errors.js';
import { writeJsonAtomic } from './json.js';
import { createWorkspaceLayout } from './paths.js';
import { ensureWorkspace } from './workspace.js';

export interface LoadConfigOptions {
  cliOverrides?: OpsenseConfigOverrides;
  createIfMissing?: boolean;
  explicitPath?: string;
  workspaceRoot?: string;
}

export interface LoadedConfig {
  config: OpsenseConfig;
  created: boolean;
  sourcePath: string;
}

export async function loadConfig({
  cliOverrides = {},
  createIfMissing = true,
  explicitPath,
  workspaceRoot,
}: LoadConfigOptions = {}): Promise<LoadedConfig> {
  const workspace = createWorkspaceLayout(workspaceRoot);
  const sourcePath = path.resolve(explicitPath ?? workspace.configFile);
  const fileExists = await exists(sourcePath);

  let fileConfig: unknown = {};
  if (fileExists) {
    fileConfig = await readConfigFile(sourcePath);
  } else if (createIfMissing) {
    await ensureWorkspace(workspaceRoot);
    await writeJsonAtomic(sourcePath, DEFAULT_OPSENSE_CONFIG);
  }

  rejectEmbeddedCredentials(fileConfig);
  rejectEmbeddedCredentials(cliOverrides);

  const config = mergeConfig(DEFAULT_OPSENSE_CONFIG, fileConfig, cliOverrides);
  try {
    assertSchema(OpsenseConfigSchema, config);
  } catch (error) {
    if (error instanceof SchemaValidationError) {
      throw new ConfigError('CONFIG_INVALID', error.message, error);
    }
    throw error;
  }

  return { config, created: !fileExists && createIfMissing, sourcePath };
}

export function summarizeConfig(config: OpsenseConfig): Record<string, unknown> {
  return {
    ai: config.ai,
    report: config.report,
    scan: config.scan,
    ssh: {
      commandTimeoutMs: config.ssh.commandTimeoutMs,
      connectTimeoutMs: config.ssh.connectTimeoutMs,
      identityFileConfigured: config.ssh.identityFile !== undefined,
      strictHostKeyChecking: config.ssh.strictHostKeyChecking,
    },
    workspace: {
      customRootConfigured: config.workspace.rootDirectory !== undefined,
    },
  };
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readConfigFile(filePath: string): Promise<unknown> {
  try {
    const source = await readFile(filePath, 'utf8');
    return JSON.parse(source) as unknown;
  } catch (error) {
    throw new ConfigError('CONFIG_READ_FAILED', `Failed to read config file: ${filePath}`, error);
  }
}

function mergeConfig(
  defaults: OpsenseConfig,
  fileConfig: unknown,
  cliOverrides: OpsenseConfigOverrides,
): unknown {
  const file = asRecord(fileConfig, 'config');
  return {
    ...file,
    ai: { ...defaults.ai, ...asRecord(file.ai, 'config.ai'), ...cliOverrides.ai },
    report: {
      ...defaults.report,
      ...asRecord(file.report, 'config.report'),
      ...cliOverrides.report,
    },
    scan: { ...defaults.scan, ...asRecord(file.scan, 'config.scan'), ...cliOverrides.scan },
    ssh: { ...defaults.ssh, ...asRecord(file.ssh, 'config.ssh'), ...cliOverrides.ssh },
    workspace: {
      ...defaults.workspace,
      ...asRecord(file.workspace, 'config.workspace'),
      ...cliOverrides.workspace,
    },
  };
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === undefined) {
    return {};
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigError('CONFIG_INVALID_SHAPE', `${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function rejectEmbeddedCredentials(value: unknown, pathSegments: string[] = []): void {
  if (typeof value === 'string') {
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value)) {
      throw new ConfigError(
        'CONFIG_SECRET_FORBIDDEN',
        `Private key content is not allowed in config at ${formatPath(pathSegments)}.`,
      );
    }
    return;
  }

  if (value === null || typeof value !== 'object') {
    return;
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (
      ['apikey', 'password', 'passphrase', 'privatekey', 'secret', 'token'].includes(normalizedKey)
    ) {
      throw new ConfigError(
        'CONFIG_SECRET_FORBIDDEN',
        `Credential field '${key}' is not allowed in config at ${formatPath(pathSegments)}.`,
      );
    }
    rejectEmbeddedCredentials(nestedValue, [...pathSegments, key]);
  }
}

function formatPath(pathSegments: string[]): string {
  return pathSegments.length > 0 ? pathSegments.join('.') : '<root>';
}
