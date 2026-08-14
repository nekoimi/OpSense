import type {
  ComposeProjectRecord,
  ContainerMount,
  ContainerPortMapping,
  ContainerRecord,
} from '@opsense/schema';

export interface DockerPsSummary {
  id: string;
  image: string;
  name: string;
  state: string;
}

interface ComposeListProject {
  configFiles: string[];
  name: string;
}

export function parseDockerPs(source: string): DockerPsSummary[] {
  const containers: DockerPsSummary[] = [];
  for (const line of source.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    const value = JSON.parse(line) as unknown;
    if (!isRecord(value)) continue;
    const id = stringValue(value.ID) ?? stringValue(value.Id);
    const name = stringValue(value.Names) ?? stringValue(value.Name);
    const image = stringValue(value.Image);
    const state = stringValue(value.State) ?? stringValue(value.Status) ?? 'unknown';
    if (id !== undefined && name !== undefined && image !== undefined) {
      containers.push({ id, image, name, state });
    }
  }
  return containers;
}

export function parseDockerPsBasic(source: string): DockerPsSummary[] {
  const containers: DockerPsSummary[] = [];
  for (const line of source.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    const [id, name, image, state] = line.split('\t');
    if (id !== undefined && name !== undefined && image !== undefined) {
      containers.push({ id, image, name, state: state?.trim() || 'unknown' });
    }
  }
  return containers;
}

export function minimalContainer(summary: DockerPsSummary, evidenceId: string): ContainerRecord {
  return {
    environmentKeys: [],
    evidenceIds: [evidenceId],
    id: containerRecordId(summary.id),
    image: summary.image,
    labels: {},
    mounts: [],
    name: summary.name.replace(/^\//, ''),
    networks: [],
    ports: [],
    runtime: 'docker',
    state: summary.state,
  };
}

export function parseDockerInspect(
  source: string,
  evidenceId: string,
  summary?: DockerPsSummary,
): ContainerRecord {
  const parsed = JSON.parse(source) as unknown;
  const item = Array.isArray(parsed) ? asRecord(parsed[0]) : asRecord(parsed);
  if (item === undefined) throw new Error('docker inspect output does not contain a container.');

  const config = asRecord(item.Config) ?? {};
  const state = asRecord(item.State) ?? {};
  const hostConfig = asRecord(item.HostConfig) ?? {};
  const networkSettings = asRecord(item.NetworkSettings) ?? {};
  const id = stringValue(item.Id) ?? summary?.id;
  const name = (stringValue(item.Name) ?? summary?.name)?.replace(/^\//, '');
  const image = stringValue(config.Image) ?? summary?.image;
  if (id === undefined || name === undefined || image === undefined) {
    throw new Error('docker inspect output is missing Id, Name, or Image.');
  }

  const restartPolicy = stringValue(asRecord(hostConfig.RestartPolicy)?.Name);
  const healthStatus = stringValue(asRecord(state.Health)?.Status);
  const processId = nonNegativeInteger(state.Pid);
  const startedAt = dateTime(stringValue(state.StartedAt));
  const imageId = stringValue(item.Image);
  const labels = stringMap(config.Labels);
  return {
    environmentKeys: environmentKeys(config.Env),
    evidenceIds: [evidenceId],
    id: containerRecordId(id),
    image,
    labels,
    mounts: parseMounts(item.Mounts),
    name,
    networks: Object.keys(asRecord(networkSettings.Networks) ?? {}),
    ports: parsePorts(networkSettings.Ports),
    runtime: 'docker',
    state: stringValue(state.Status) ?? summary?.state ?? 'unknown',
    ...(healthStatus === undefined ? {} : { healthStatus }),
    ...(processId === undefined ? {} : { processId }),
    ...(restartPolicy === undefined ? {} : { restartPolicy }),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(imageId === undefined ? {} : { imageId }),
  };
}

export function buildComposeProjects(
  containers: ContainerRecord[],
  composeListSource: string | undefined,
  composeEvidenceId: string | undefined,
): ComposeProjectRecord[] {
  const listed = parseComposeList(composeListSource ?? '');
  const projects = new Map<
    string,
    {
      configFiles: Set<string>;
      evidenceIds: Set<string>;
      services: Map<string, Set<string>>;
      workingDirectory: string | undefined;
    }
  >();

  for (const item of listed) {
    projects.set(item.name, {
      configFiles: new Set(item.configFiles),
      evidenceIds: new Set(composeEvidenceId === undefined ? [] : [composeEvidenceId]),
      services: new Map(),
      workingDirectory: undefined,
    });
  }

  for (const container of containers) {
    const projectName = container.labels['com.docker.compose.project'];
    const serviceName = container.labels['com.docker.compose.service'];
    if (projectName === undefined || serviceName === undefined) continue;
    const existing = projects.get(projectName) ?? {
      configFiles: new Set<string>(),
      evidenceIds: new Set<string>(),
      services: new Map<string, Set<string>>(),
      workingDirectory: undefined,
    };
    const services = existing.services.get(serviceName) ?? new Set<string>();
    services.add(container.id);
    existing.services.set(serviceName, services);
    container.evidenceIds.forEach((id) => existing.evidenceIds.add(id));
    splitConfigFiles(container.labels['com.docker.compose.project.config_files']).forEach((path) =>
      existing.configFiles.add(path),
    );
    const workingDirectory = container.labels['com.docker.compose.project.working_dir'];
    if (existing.workingDirectory === undefined && workingDirectory !== undefined) {
      existing.workingDirectory = workingDirectory;
    }
    projects.set(projectName, existing);
  }

  return [...projects.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, project]) => ({
      configFiles: [...project.configFiles],
      evidenceIds: [...project.evidenceIds],
      id: makeId('compose', name),
      name,
      services: [...project.services.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([serviceName, containerIds]) => ({
          containerIds: [...containerIds],
          name: serviceName,
        })),
      ...(project.workingDirectory === undefined
        ? {}
        : { workingDirectory: project.workingDirectory }),
    }));
}

export function parseComposeList(source: string): ComposeListProject[] {
  if (source.trim().length === 0) return [];
  const parsed = JSON.parse(source) as unknown;
  if (!Array.isArray(parsed)) throw new Error('docker compose ls output is not an array.');
  return parsed.flatMap((value) => {
    const item = asRecord(value);
    const name =
      item === undefined ? undefined : (stringValue(item.Name) ?? stringValue(item.name));
    if (item === undefined || name === undefined) return [];
    const files = stringValue(item.ConfigFiles) ?? stringValue(item.configFiles);
    return [{ configFiles: splitConfigFiles(files), name }];
  });
}

function parseMounts(value: unknown): ContainerMount[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((mountValue) => {
    const mount = asRecord(mountValue);
    const type = mount === undefined ? undefined : stringValue(mount.Type);
    const destination = mount === undefined ? undefined : stringValue(mount.Destination);
    if (
      mount === undefined ||
      destination === undefined ||
      (type !== 'bind' && type !== 'volume' && type !== 'tmpfs')
    ) {
      return [];
    }
    const source = stringValue(mount.Source);
    return [
      {
        destination,
        readOnly: mount.RW === false,
        type,
        ...(source === undefined ? {} : { source }),
      },
    ];
  });
}

function parsePorts(value: unknown): ContainerPortMapping[] {
  const ports = asRecord(value);
  if (ports === undefined) return [];
  const mappings: ContainerPortMapping[] = [];
  for (const [key, bindingsValue] of Object.entries(ports)) {
    const match = /^(\d+)\/(tcp|udp)$/.exec(key);
    if (match?.[1] === undefined || match[2] === undefined) continue;
    const containerPort = Number.parseInt(match[1], 10);
    const protocol = match[2] as 'tcp' | 'udp';
    if (!Array.isArray(bindingsValue) || bindingsValue.length === 0) {
      mappings.push({ containerPort, protocol });
      continue;
    }
    for (const bindingValue of bindingsValue) {
      const binding = asRecord(bindingValue);
      if (binding === undefined) continue;
      const hostAddress = stringValue(binding.HostIp);
      const hostPort = nonNegativeInteger(binding.HostPort);
      mappings.push({
        containerPort,
        protocol,
        ...(hostAddress === undefined ? {} : { hostAddress }),
        ...(hostPort === undefined ? {} : { hostPort }),
      });
    }
  }
  return mappings;
}

function environmentKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.flatMap((entry) => {
        if (typeof entry !== 'string') return [];
        const separator = entry.indexOf('=');
        const key = separator < 0 ? entry : entry.slice(0, separator);
        return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? [key] : [];
      }),
    ),
  ];
}

function stringMap(value: unknown): Record<string, string> {
  const record = asRecord(value);
  if (record === undefined) return {};
  return Object.fromEntries(
    Object.entries(record).flatMap(([key, item]) => {
      if (typeof item !== 'string') return [];
      const sensitiveKey =
        /password|passwd|passphrase|token|secret|api[-_]?key|authorization|credential/i.test(key);
      return [[key, sensitiveKey ? '[REDACTED]' : redactInlineSecrets(item)]];
    }),
  );
}

function splitConfigFiles(value: string | undefined): string[] {
  return (
    value
      ?.split(',')
      .map((item) => item.trim())
      .filter((item) => item.startsWith('/')) ?? []
  );
}

function redactInlineSecrets(value: string): string {
  return value.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@');
}

function containerRecordId(id: string): string {
  return `container:${id.toLowerCase()}`;
}

function dateTime(value: string | undefined): string | undefined {
  if (value === undefined || value.startsWith('0001-01-01')) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function makeId(prefix: string, value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9._:-]+/g, '_').replace(/^[_:.-]+/, '');
  return `${prefix}:${normalized || 'unknown'}`;
}
