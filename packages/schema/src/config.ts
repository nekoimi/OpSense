import { Type, type Static } from '@sinclair/typebox';

export const SudoModeSchema = Type.Union([
  Type.Literal('auto'),
  Type.Literal('always'),
  Type.Literal('never'),
]);

export const ReportFormatSchema = Type.Union([
  Type.Literal('docx'),
  Type.Literal('markdown'),
  Type.Literal('html'),
]);

export const OpsenseConfigSchema = Type.Object(
  {
    ssh: Type.Object(
      {
        connectTimeoutMs: Type.Integer({ minimum: 1000, maximum: 300_000 }),
        commandTimeoutMs: Type.Integer({ minimum: 1000, maximum: 3_600_000 }),
        strictHostKeyChecking: Type.Boolean(),
        identityFile: Type.Optional(Type.String({ minLength: 1 })),
      },
      { additionalProperties: false },
    ),
    scan: Type.Object(
      {
        maxDirectoryDepth: Type.Integer({ minimum: 1, maximum: 20 }),
        maxFilesPerDirectory: Type.Integer({ minimum: 1, maximum: 100_000 }),
        maxCommandOutputBytes: Type.Integer({ minimum: 1024, maximum: 100_000_000 }),
        crossFileSystems: Type.Boolean(),
        useSudo: SudoModeSchema,
      },
      { additionalProperties: false },
    ),
    ai: Type.Object(
      {
        enabled: Type.Boolean(),
        provider: Type.String({ minLength: 1 }),
        maxRetries: Type.Integer({ minimum: 0, maximum: 10 }),
      },
      { additionalProperties: false },
    ),
    report: Type.Object(
      {
        formats: Type.Array(ReportFormatSchema, { minItems: 1, uniqueItems: true }),
      },
      { additionalProperties: false },
    ),
    workspace: Type.Object(
      {
        rootDirectory: Type.Optional(Type.String({ minLength: 1 })),
      },
      { additionalProperties: false },
    ),
  },
  { $id: 'OpsenseConfig', additionalProperties: false },
);

export type OpsenseConfig = Static<typeof OpsenseConfigSchema>;

export const DEFAULT_OPSENSE_CONFIG: OpsenseConfig = {
  ssh: {
    connectTimeoutMs: 10_000,
    commandTimeoutMs: 30_000,
    strictHostKeyChecking: true,
  },
  scan: {
    maxDirectoryDepth: 4,
    maxFilesPerDirectory: 5_000,
    maxCommandOutputBytes: 5_000_000,
    crossFileSystems: false,
    useSudo: 'auto',
  },
  ai: {
    enabled: true,
    provider: 'codex',
    maxRetries: 2,
  },
  report: {
    formats: ['docx'],
  },
  workspace: {},
};

export interface OpsenseConfigOverrides {
  ai?: Partial<OpsenseConfig['ai']>;
  report?: Partial<OpsenseConfig['report']>;
  scan?: Partial<OpsenseConfig['scan']>;
  ssh?: Partial<OpsenseConfig['ssh']>;
  workspace?: Partial<OpsenseConfig['workspace']>;
}
