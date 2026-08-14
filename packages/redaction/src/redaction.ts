import type {
  EvidenceRecord,
  RedactionMode,
  RedactionReport,
  ScanSnapshot,
  Sensitivity,
} from '@opsense/schema';

export const REDACTION_RULES_VERSION = '1.0.0';
export const REDACTED_VALUE = '[REDACTED]';

const SENSITIVITY_PRIORITY: Record<Sensitivity, number> = {
  public: 0,
  internal: 1,
  sensitive: 2,
  secret: 3,
};

const SECRET_KEY_SUFFIXES = [
  'password',
  'passwd',
  'passphrase',
  'pwd',
  'token',
  'secret',
  'apikey',
  'authorization',
  'cookie',
  'credential',
  'privatekey',
  'clientsecret',
  'accesskey',
  'secretkey',
  'connectionstring',
  'dsn',
] as const;
const SENSITIVE_KEY_PATTERN =
  /(?:user(?:name)?|owner|group|host|address|gateway|dns|path|directory|file|command|argument|url|uri|endpoint)/i;
const PUBLIC_KEY_PATTERN =
  /(?:version|architecture|platform|distribution|protocol|family|status|state|enabled|available|count|size|port)$/i;
const COMMAND_LINE_KEY_PATTERN =
  /^(?:command|execStart|execReload|startCommand|stopCommand|restartCommand)$/i;
const COMMAND_TOKEN_ARRAY_KEY_PATTERN = /^arguments$/i;
const COMMAND_KEY_PATTERN =
  /^(?:command|arguments|execStart|execReload|startCommand|stopCommand|restartCommand)$/i;
const ENVIRONMENT_KEYS = new Set(['environmentkeys', 'toplevelkeys']);
const ENVIRONMENT_VALUE_KEY_PATTERN = /^(?:env|environment|environmentvariables)$/i;
const CONTENT_KEY_PATTERN = /^(?:content|raw|text|body|value)$/i;
const PRIVATE_KEY_BLOCK_PATTERN =
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const BEARER_PATTERN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi;
const CLOUD_CREDENTIAL_PATTERN =
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\b(?:ghp|github_pat|glpat|xox[baprs]|sk)-[A-Za-z0-9_-]{12,}\b/g;
const DATABASE_URI_PATTERN =
  /\b((?:jdbc:)?(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqp|amqps|mssql):\/\/)([^\s/@]+(?::[^\s/@]*)?@)?([^\s?#]+)(\?[^\s#]*)?/gi;
const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"<>]+/gi;
const SECRET_QUERY_KEY_PATTERN =
  /^(?:access_token|api[-_]?key|auth|authorization|code|credential|key|password|signature|sig|secret|token|x-amz-signature)$/i;
const CONNECTION_PAIR_PATTERN =
  /\b(password|pwd|user(?:\s+id)?|uid|access\s+token|api\s*key|secret)\s*=\s*([^;,\s]+)/gi;
const COMMAND_INLINE_PATTERN =
  /((?:--?)(?:[A-Za-z0-9]+[-_])*(?:password|passwd|passphrase|pwd|token|secret|api[-_]?key|authorization|credential)(?:[-_][A-Za-z0-9]+)*)(=|\s+)(?:"[^"]*"|'[^']*'|\S+)/gi;
const ASSIGNMENT_PATTERN =
  /\b((?:[A-Za-z0-9]+_)*(?:PASSWORD|PASSWD|PASSPHRASE|TOKEN|SECRET|API_KEY|AUTHORIZATION|CREDENTIAL)(?:_[A-Za-z0-9]+)*)=([^;\s]+)/gi;
const SHORT_PASSWORD_PATTERN = /(^|\s)-p(?:\s+|=)(?:"[^"]*"|'[^']*'|\S+)/gi;

export interface RedactionFinding {
  path: string;
  ruleId: string;
}

export interface RedactionOptions {
  mode: RedactionMode;
  now?: () => Date;
  passes?: 1 | 2;
}

export interface RedactionResult<T> {
  report: RedactionReport;
  value: T;
}

interface RedactionState {
  hits: Map<string, number>;
  sensitivityCounts: Record<Sensitivity, number>;
}

interface WalkContext {
  environmentFile: boolean;
  key?: string;
  path: string;
  preserveKeyNames: boolean;
}

export class RedactionError extends Error {
  public readonly findings: RedactionFinding[];

  public constructor(findings: RedactionFinding[]) {
    super(`Sensitive data remained after redaction (${findings.length} finding(s)).`);
    this.name = 'RedactionError';
    this.findings = findings;
  }
}

export function redactSnapshot(
  snapshot: ScanSnapshot,
  now: () => Date = () => new Date(),
): RedactionResult<ScanSnapshot> {
  const classified: ScanSnapshot = {
    ...snapshot,
    evidence: snapshot.evidence.map(classifyEvidence),
  };
  const result = redactPayload(classified, { mode: 'persistence', now, passes: 1 });
  return { report: result.report, value: { ...result.value, redaction: result.report } };
}

export function redactForAiInput<T>(
  value: T,
  now: () => Date = () => new Date(),
): RedactionResult<T> {
  return redactPayload(value, { mode: 'ai', now, passes: 2 });
}

export function redactForReport<T>(
  value: T,
  now: () => Date = () => new Date(),
): RedactionResult<T> {
  return redactPayload(value, { mode: 'report', now, passes: 1 });
}

export function redactForAudit<T>(
  value: T,
  now: () => Date = () => new Date(),
): RedactionResult<T> {
  return redactPayload(value, { mode: 'audit', now, passes: 1 });
}

export function redactPayload<T>(value: T, options: RedactionOptions): RedactionResult<T> {
  const passes = options.passes ?? 1;
  const combinedState = createState();
  let sanitized: unknown = value;
  for (let pass = 0; pass < passes; pass += 1) {
    const state = createState();
    sanitized = redactNode(
      sanitized,
      { environmentFile: false, path: '$', preserveKeyNames: false },
      state,
    );
    mergeState(combinedState, state);
  }
  const findings = scanForSecrets(sanitized);
  if (findings.length > 0) throw new RedactionError(findings);
  const totalMatches = [...combinedState.hits.values()].reduce((total, count) => total + count, 0);
  const report: RedactionReport = {
    generatedAt: (options.now ?? (() => new Date()))().toISOString(),
    mode: options.mode,
    passes,
    ruleHits: [...combinedState.hits.entries()]
      .map(([ruleId, count]) => ({ count, ruleId }))
      .sort((left, right) => left.ruleId.localeCompare(right.ruleId)),
    rulesVersion: REDACTION_RULES_VERSION,
    secretScanPassed: true,
    sensitivityCounts: combinedState.sensitivityCounts,
    totalMatches,
  };
  return { report, value: sanitized as T };
}

export function scanForSecrets(value: unknown): RedactionFinding[] {
  const findings: RedactionFinding[] = [];
  scanNode(value, '$', undefined, false, findings);
  return findings;
}

export function classifySensitivity(key: string | undefined, value: unknown): Sensitivity {
  if (key !== undefined && isSecretKey(key) && !isKeyNameCollection(key)) return 'secret';
  if (typeof value === 'string') {
    if (containsSecretPattern(value)) return 'secret';
    if (key !== undefined && SENSITIVE_KEY_PATTERN.test(key)) return 'sensitive';
    if (looksLikeSensitivePath(value) || looksLikeNetworkAddress(value)) return 'sensitive';
  }
  if (key !== undefined && PUBLIC_KEY_PATTERN.test(key)) return 'public';
  return 'internal';
}

function redactNode(value: unknown, context: WalkContext, state: RedactionState): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value, context, state);
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    if (context.key !== undefined && COMMAND_TOKEN_ARRAY_KEY_PATTERN.test(context.key)) {
      return redactCommandTokenArray(value, context, state);
    }
    if (context.key !== undefined && COMMAND_LINE_KEY_PATTERN.test(context.key)) {
      return value.map((item, index) =>
        typeof item === 'string'
          ? redactCommandLine(item, state)
          : redactNode(item, childContext(context, String(index)), state),
      );
    }
    if (context.key !== undefined && ENVIRONMENT_VALUE_KEY_PATTERN.test(context.key)) {
      return value.map((item, index) =>
        typeof item === 'string'
          ? redactEnvironmentAssignment(item, `${context.path}[${index}]`, state)
          : redactNode(item, childContext(context, String(index)), state),
      );
    }
    return value.map((item, index) =>
      redactNode(item, childContext(context, String(index)), state),
    );
  }

  const source = value as Record<string, unknown>;
  const environmentFile =
    context.environmentFile ||
    Object.entries(source).some(
      ([key, item]) =>
        /^(?:path|file|filePath|source)$/i.test(key) &&
        typeof item === 'string' &&
        looksLikeEnvironmentFile(item),
    );
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(source)) {
    const preserveKeyNames = isKeyNameCollection(key);
    const child = {
      environmentFile,
      key,
      path: `${context.path}.${key}`,
      preserveKeyNames,
    };
    if (environmentFile && CONTENT_KEY_PATTERN.test(key) && typeof item === 'string') {
      const keys = extractEnvironmentKeys(item);
      if (keys.length > 0) {
        recordHit(state, 'environment.values-removed');
        state.sensitivityCounts.secret += 1;
        result[key] = keys;
        continue;
      }
    }
    if (
      isSecretKey(key) &&
      !preserveKeyNames &&
      !isSafeRedactedValue(item) &&
      !isSafeSecretMetric(context.path, key, item)
    ) {
      recordHit(state, 'field.secret-key');
      state.sensitivityCounts.secret += 1;
      result[key] = REDACTED_VALUE;
      continue;
    }
    result[key] = redactNode(item, child, state);
  }
  return result;
}

function redactString(value: string, context: WalkContext, state: RedactionState): string {
  const sensitivity = context.preserveKeyNames
    ? 'sensitive'
    : classifySensitivity(context.key, value);
  state.sensitivityCounts[sensitivity] += 1;
  if (context.preserveKeyNames || value === REDACTED_VALUE) return value;
  if (context.key !== undefined && isSecretKey(context.key)) {
    recordHit(state, 'field.secret-key');
    return REDACTED_VALUE;
  }
  if (context.key !== undefined && COMMAND_KEY_PATTERN.test(context.key)) {
    return redactCommandLine(value, state);
  }
  if (context.key !== undefined && ENVIRONMENT_VALUE_KEY_PATTERN.test(context.key)) {
    return redactEnvironmentAssignment(value, context.path, state);
  }
  let sanitized = value;
  sanitized = replaceWithRule(
    sanitized,
    PRIVATE_KEY_BLOCK_PATTERN,
    REDACTED_VALUE,
    'content.private-key',
    state,
  );
  sanitized = sanitizeDatabaseUris(sanitized, state);
  sanitized = sanitizeUrls(sanitized, state);
  sanitized = replaceWithRule(
    sanitized,
    CONNECTION_PAIR_PATTERN,
    '$1=[REDACTED]',
    'connection.key-value',
    state,
  );
  sanitized = replaceWithRule(
    sanitized,
    ASSIGNMENT_PATTERN,
    '$1=[REDACTED]',
    'content.secret-assignment',
    state,
  );
  sanitized = replaceWithRule(
    sanitized,
    BEARER_PATTERN,
    '$1 [REDACTED]',
    'content.authorization',
    state,
  );
  sanitized = replaceWithRule(sanitized, JWT_PATTERN, REDACTED_VALUE, 'content.jwt', state);
  sanitized = replaceWithRule(
    sanitized,
    CLOUD_CREDENTIAL_PATTERN,
    REDACTED_VALUE,
    'content.cloud-credential',
    state,
  );
  return sanitized;
}

function redactCommandLine(value: string, state: RedactionState): string {
  let sanitized = value;
  sanitized = replaceWithRule(
    sanitized,
    COMMAND_INLINE_PATTERN,
    '$1$2[REDACTED]',
    'command.sensitive-option',
    state,
  );
  sanitized = replaceWithRule(
    sanitized,
    ASSIGNMENT_PATTERN,
    '$1=[REDACTED]',
    'command.sensitive-assignment',
    state,
  );
  sanitized = replaceWithRule(
    sanitized,
    SHORT_PASSWORD_PATTERN,
    '$1-p [REDACTED]',
    'command.short-password',
    state,
  );
  return redactString(
    sanitized,
    { environmentFile: false, path: '$command', preserveKeyNames: false },
    state,
  );
}

function redactCommandTokenArray(
  values: unknown[],
  context: WalkContext,
  state: RedactionState,
): unknown[] {
  const result: unknown[] = [];
  let redactNext = false;
  values.forEach((item, index) => {
    if (typeof item !== 'string') {
      result.push(redactNode(item, childContext(context, String(index)), state));
      return;
    }
    state.sensitivityCounts.sensitive += 1;
    if (redactNext) {
      result.push(REDACTED_VALUE);
      recordHit(state, 'command.sensitive-option');
      redactNext = false;
      return;
    }
    const inline = /^(--?[A-Za-z0-9_-]+)=(.*)$/.exec(item);
    if (inline?.[1] !== undefined && isSensitiveCommandOption(inline[1])) {
      result.push(`${inline[1]}=${REDACTED_VALUE}`);
      recordHit(state, 'command.sensitive-option');
      return;
    }
    if (/^-p=.+$/i.test(item)) {
      result.push(`-p=${REDACTED_VALUE}`);
      recordHit(state, 'command.short-password');
      return;
    }
    result.push(redactString(item, childContext(context, String(index)), state));
    redactNext = item === '-p' || isSensitiveCommandOption(item);
  });
  return result;
}

function redactEnvironmentAssignment(value: string, path: string, state: RedactionState): string {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(value);
  if (match?.[1] === undefined || match[2] === undefined) {
    return redactString(value, { environmentFile: false, path, preserveKeyNames: false }, state);
  }
  if (match[2].length === 0) return `${match[1]}=`;
  recordHit(state, 'environment.value');
  state.sensitivityCounts.secret += 1;
  return `${match[1]}=${REDACTED_VALUE}`;
}

function sanitizeDatabaseUris(value: string, state: RedactionState): string {
  return value.replace(
    DATABASE_URI_PATTERN,
    (
      match: string,
      scheme: string,
      credentials: string | undefined,
      location: string,
      query: string | undefined,
    ) => {
      const sanitized = `${scheme}${credentials === undefined ? '' : `${REDACTED_VALUE}@`}${location}${query === undefined ? '' : `?${REDACTED_VALUE}`}`;
      if (sanitized !== match) recordHit(state, 'connection.database-uri');
      return sanitized;
    },
  );
}

function sanitizeUrls(value: string, state: RedactionState): string {
  return value.replace(URL_PATTERN, (match) => {
    let suffix = '';
    let source = match;
    while (/[),.;]$/.test(source)) {
      suffix = source.slice(-1) + suffix;
      source = source.slice(0, -1);
    }
    let sanitized = source.replace(/(:\/\/)[^/@\s]+@/, `$1${REDACTED_VALUE}@`);
    const queryIndex = sanitized.indexOf('?');
    if (queryIndex >= 0) {
      const prefix = sanitized.slice(0, queryIndex + 1);
      const query = sanitized.slice(queryIndex + 1);
      sanitized =
        prefix +
        query
          .split('&')
          .map((part) => {
            const separator = part.indexOf('=');
            if (separator < 0) return part;
            const key = part.slice(0, separator);
            return SECRET_QUERY_KEY_PATTERN.test(decodeURIComponentSafe(key))
              ? `${key}=${REDACTED_VALUE}`
              : part;
          })
          .join('&');
    }
    if (sanitized !== source) recordHit(state, 'url.credentials-or-query');
    return sanitized + suffix;
  });
}

function scanNode(
  value: unknown,
  path: string,
  key: string | undefined,
  preserveKeyNames: boolean,
  findings: RedactionFinding[],
): void {
  if (value === null || value === undefined) return;
  if (typeof value === 'string') {
    if (preserveKeyNames || value === REDACTED_VALUE) return;
    for (const ruleId of remainingSecretRules(value, key)) findings.push({ path, ruleId });
    return;
  }
  if (typeof value !== 'object') return;
  if (Array.isArray(value)) {
    if (key !== undefined && COMMAND_TOKEN_ARRAY_KEY_PATTERN.test(key)) {
      scanCommandTokenArray(value, path, preserveKeyNames, findings);
      return;
    }
    value.forEach((item, index) =>
      scanNode(item, `${path}[${index}]`, key, preserveKeyNames, findings),
    );
    return;
  }
  for (const [childKey, item] of Object.entries(value as Record<string, unknown>)) {
    const preserve = isKeyNameCollection(childKey);
    if (
      isSecretKey(childKey) &&
      !preserve &&
      !isSafeRedactedValue(item) &&
      !isSafeSecretMetric(path, childKey, item)
    ) {
      findings.push({ path: `${path}.${childKey}`, ruleId: 'field.secret-key' });
      continue;
    }
    scanNode(item, `${path}.${childKey}`, childKey, preserve, findings);
  }
}

function scanCommandTokenArray(
  values: unknown[],
  path: string,
  preserveKeyNames: boolean,
  findings: RedactionFinding[],
): void {
  let expectsSecretValue = false;
  values.forEach((item, index) => {
    const itemPath = `${path}[${index}]`;
    if (typeof item !== 'string') {
      scanNode(item, itemPath, undefined, preserveKeyNames, findings);
      expectsSecretValue = false;
      return;
    }
    if (preserveKeyNames) return;
    if (expectsSecretValue) {
      if (item !== REDACTED_VALUE) {
        findings.push({ path: itemPath, ruleId: 'command.sensitive-option' });
      }
      expectsSecretValue = false;
      return;
    }
    if (item === REDACTED_VALUE) return;
    const inline = /^(--?[A-Za-z0-9_-]+)=(.*)$/.exec(item);
    if (
      inline?.[1] !== undefined &&
      inline[2] !== REDACTED_VALUE &&
      isSensitiveCommandOption(inline[1])
    ) {
      findings.push({ path: itemPath, ruleId: 'command.sensitive-option' });
    }
    if (/^-p=.+$/i.test(item) && item !== `-p=${REDACTED_VALUE}`) {
      findings.push({ path: itemPath, ruleId: 'command.short-password' });
    }
    for (const ruleId of remainingSecretRules(item, undefined)) {
      findings.push({ path: itemPath, ruleId });
    }
    expectsSecretValue = item === '-p' || isSensitiveCommandOption(item);
  });
}

function remainingSecretRules(value: string, key: string | undefined): string[] {
  const inspected = value.replaceAll(REDACTED_VALUE, '');
  const rules: string[] = [];
  if (PRIVATE_KEY_BLOCK_PATTERN.test(inspected)) rules.push('content.private-key');
  PRIVATE_KEY_BLOCK_PATTERN.lastIndex = 0;
  if (JWT_PATTERN.test(inspected)) rules.push('content.jwt');
  JWT_PATTERN.lastIndex = 0;
  if (BEARER_PATTERN.test(inspected)) rules.push('content.authorization');
  BEARER_PATTERN.lastIndex = 0;
  if (CLOUD_CREDENTIAL_PATTERN.test(inspected)) rules.push('content.cloud-credential');
  CLOUD_CREDENTIAL_PATTERN.lastIndex = 0;
  if (
    /\b(?:jdbc:)?(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqp|amqps|mssql):\/\/[^\s/@]+(?::[^\s/@]*)?@/i.test(
      inspected,
    )
  ) {
    rules.push('connection.database-uri');
  }
  if (
    /\b(?:password|pwd|user(?:\s+id)?|uid|access\s+token|api\s*key|secret)\s*=\s*[^;,\s]+/i.test(
      inspected,
    )
  ) {
    rules.push('connection.key-value');
  }
  if (ASSIGNMENT_PATTERN.test(inspected)) rules.push('content.secret-assignment');
  ASSIGNMENT_PATTERN.lastIndex = 0;
  if (
    /(:\/\/)[^/@\s]+@/.test(inspected) ||
    /[?&](?:access_token|api[-_]?key|auth|authorization|code|credential|key|password|signature|sig|secret|token|x-amz-signature)=[^&#\s]+/i.test(
      inspected,
    )
  ) {
    rules.push('url.credentials-or-query');
  }
  if (key !== undefined && COMMAND_KEY_PATTERN.test(key)) {
    if (redactCommandLine(value, createState()) !== value) {
      rules.push('command.sensitive-option');
    }
  }
  return [...new Set(rules)];
}

function classifyEvidence(evidence: EvidenceRecord): EvidenceRecord {
  const classified = strongestSensitivity([
    evidence.sensitivity,
    classifySensitivity('source', evidence.source),
    classifyValueSensitivity(evidence.value, evidence.field),
  ]);
  return { ...evidence, sensitivity: classified };
}

function classifyValueSensitivity(value: unknown, key?: string): Sensitivity {
  const classifications = [classifySensitivity(key, value)];
  if (Array.isArray(value)) {
    classifications.push(...value.map((item) => classifyValueSensitivity(item, key)));
  } else if (value !== null && typeof value === 'object') {
    classifications.push(
      ...Object.entries(value as Record<string, unknown>).map(([childKey, item]) =>
        classifyValueSensitivity(item, childKey),
      ),
    );
  }
  return strongestSensitivity(classifications);
}

function strongestSensitivity(values: Sensitivity[]): Sensitivity {
  return (
    [...values].sort(
      (left, right) => SENSITIVITY_PRIORITY[right] - SENSITIVITY_PRIORITY[left],
    )[0] ?? 'internal'
  );
}

function containsSecretPattern(value: string): boolean {
  return remainingSecretRules(value, undefined).length > 0;
}

function isSecretKey(key: string): boolean {
  const normalized = key.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
  return SECRET_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

function isKeyNameCollection(key: string): boolean {
  return ENVIRONMENT_KEYS.has(key.replace(/[^A-Za-z0-9]/g, '').toLowerCase());
}

function isSensitiveCommandOption(value: string): boolean {
  if (!/^--?/.test(value)) return false;
  const option = value.replace(/^--?/, '');
  return /(?:^|[-_])(?:password|passwd|passphrase|pwd|token|secret|api[-_]?key|authorization|credential)(?:$|[-_])/i.test(
    option,
  );
}

function isSafeRedactedValue(value: unknown): boolean {
  return (
    value === REDACTED_VALUE || value === undefined || value === null || typeof value === 'boolean'
  );
}

function isSafeSecretMetric(path: string, key: string, value: unknown): boolean {
  return path.endsWith('.sensitivityCounts') && key === 'secret' && typeof value === 'number';
}

function looksLikeEnvironmentFile(value: string): boolean {
  return /(?:^|[\\/])\.env(?:\.[^\\/]+)?$/i.test(value);
}

function looksLikeSensitivePath(value: string): boolean {
  return (
    /^(?:[A-Za-z]:[\\/]|\/)/.test(value) ||
    looksLikeEnvironmentFile(value) ||
    /(?:^|[\\/])(?:id_(?:rsa|dsa|ecdsa|ed25519)|[^\\/]+\.(?:key|pem|p12|pfx))$/i.test(value)
  );
}

function looksLikeNetworkAddress(value: string): boolean {
  return /^(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?$/.test(value) || value.includes('://');
}

function extractEnvironmentKeys(value: string): string[] {
  return [
    ...new Set(
      value.split(/\r?\n/).flatMap((line) => {
        const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
        return match?.[1] === undefined ? [] : [match[1]];
      }),
    ),
  ].sort((left, right) => left.localeCompare(right));
}

function replaceWithRule(
  value: string,
  pattern: RegExp,
  replacement: string,
  ruleId: string,
  state: RedactionState,
): string {
  const sanitized = value.replace(pattern, replacement);
  if (sanitized !== value) recordHit(state, ruleId);
  pattern.lastIndex = 0;
  return sanitized;
}

function childContext(context: WalkContext, key: string): WalkContext {
  return {
    environmentFile: context.environmentFile,
    key,
    path: `${context.path}.${key}`,
    preserveKeyNames: context.preserveKeyNames,
  };
}

function recordHit(state: RedactionState, ruleId: string): void {
  state.hits.set(ruleId, (state.hits.get(ruleId) ?? 0) + 1);
}

function createState(): RedactionState {
  return {
    hits: new Map(),
    sensitivityCounts: { internal: 0, public: 0, secret: 0, sensitive: 0 },
  };
}

function mergeState(target: RedactionState, source: RedactionState): void {
  for (const [ruleId, count] of source.hits) {
    target.hits.set(ruleId, (target.hits.get(ruleId) ?? 0) + count);
  }
  for (const sensitivity of Object.keys(target.sensitivityCounts) as Sensitivity[]) {
    target.sensitivityCounts[sensitivity] += source.sensitivityCounts[sensitivity];
  }
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
