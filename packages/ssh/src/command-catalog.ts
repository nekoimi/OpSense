import type { CommandSpec } from './command-spec.js';
import { CommandSpecError } from './errors.js';

const ALL_DISTRIBUTIONS = ['debian', 'rhel', 'alpine', 'unknown'] as const;

export const COMMAND_CATALOG = [
  command('permission.uid', 'id', ['-u']),
  command('permission.user', 'id', ['-un']),
  command('permission.groups', 'id', ['-Gn']),
  command('permission.sudo', 'sudo', ['-n', '--', 'true']),
  command('host.uname', 'uname', ['-a']),
  command('host.os-release', 'cat', ['/etc/os-release']),
  command('host.hostname', 'hostname', []),
  command('host.lscpu', 'lscpu', ['-J']),
  command('host.memory', 'cat', ['/proc/meminfo']),
  command('storage.lsblk', 'lsblk', ['-J', '-O']),
  command('storage.findmnt', 'findmnt', ['-J']),
  command('storage.df-bytes', 'df', ['-B1', '-P']),
  command('storage.df-inodes', 'df', ['-i', '-P']),
  command('network.addresses', 'ip', ['-j', 'addr']),
  command('network.routes', 'ip', ['-j', 'route']),
  command('network.sockets', 'ss', ['-H', '-lntup'], { sudo: 'allowed' }),
  command('service.systemd-units', 'systemctl', [
    'list-units',
    '--type=service',
    '--all',
    '--no-pager',
    '--plain',
  ]),
  command('service.systemd-files', 'systemctl', [
    'list-unit-files',
    '--type=service',
    '--no-pager',
    '--plain',
  ]),
  command('docker.ps', 'docker', ['ps', '-a', '--no-trunc', '--format', '{{json .}}']),
  command('docker.info', 'docker', ['info', '--format', '{{json .}}']),
  {
    arguments: [
      { literal: '--printf' },
      { literal: '%F\t%s\t%U\t%G\t%a\t%Y\t%n\\n' },
      { parameter: 'path' },
    ],
    executable: 'stat',
    id: 'directory.stat',
    maxOutputBytes: 1_000_000,
    parameters: {
      path: { kind: 'path', maxLength: 4096 },
    },
    requiredCommands: ['stat'],
    sudo: 'allowed',
    supportedDistributions: ALL_DISTRIBUTIONS,
    timeoutMs: 15_000,
  },
] as const satisfies readonly CommandSpec[];

const COMMANDS_BY_ID = new Map(COMMAND_CATALOG.map((spec) => [spec.id, spec]));

export function getCommandSpec(id: string): CommandSpec {
  const spec = COMMANDS_BY_ID.get(id);
  if (spec === undefined) {
    throw new CommandSpecError('COMMAND_NOT_ALLOWED', `Command '${id}' is not in the allowlist.`);
  }
  return spec;
}

function command(
  id: string,
  executable: string,
  args: readonly string[],
  overrides: Partial<Pick<CommandSpec, 'maxOutputBytes' | 'sudo' | 'timeoutMs'>> = {},
): CommandSpec {
  return {
    arguments: args.map((literal) => ({ literal })),
    executable,
    id,
    maxOutputBytes: overrides.maxOutputBytes ?? 5_000_000,
    parameters: {},
    requiredCommands: executable === 'sudo' ? ['sudo', 'true'] : [executable],
    sudo: overrides.sudo ?? 'never',
    supportedDistributions: ALL_DISTRIBUTIONS,
    timeoutMs: overrides.timeoutMs ?? 30_000,
  };
}
