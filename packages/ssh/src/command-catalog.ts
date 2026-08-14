import type { CommandSpec } from './command-spec.js';
import { CommandSpecError } from './errors.js';

const ALL_DISTRIBUTIONS = ['debian', 'rhel', 'alpine', 'unknown'] as const;

export const COMMAND_CATALOG = [
  command('permission.uid', 'id', ['-u']),
  command('permission.user', 'id', ['-un']),
  command('permission.groups', 'id', ['-Gn']),
  command('permission.sudo', 'sudo', ['-n', '--', 'true']),
  command('host.uname', 'uname', ['-a']),
  command('host.kernel-release', 'uname', ['-r']),
  command('host.architecture', 'uname', ['-m']),
  command('host.os-release', 'cat', ['/etc/os-release']),
  command('host.hostname', 'hostname', []),
  command('host.hostname-fqdn', 'hostname', ['-f']),
  command('host.timezone', 'timedatectl', ['show', '--property=Timezone', '--value', '--no-pager']),
  command('host.timezone-file', 'cat', ['/etc/timezone']),
  command('host.timezone-link', 'readlink', ['-f', '/etc/localtime']),
  command('host.uptime', 'cat', ['/proc/uptime']),
  command('host.virtualization', 'systemd-detect-virt', []),
  command('host.virtualization-dmi', 'cat', ['/sys/class/dmi/id/product_name']),
  command('host.lscpu', 'lscpu', ['-J']),
  command('host.lscpu-text', 'lscpu', []),
  command('host.cpuinfo', 'cat', ['/proc/cpuinfo']),
  command('host.memory', 'cat', ['/proc/meminfo']),
  command('storage.lsblk', 'lsblk', ['-J', '-b', '-O']),
  command('storage.lsblk-basic', 'lsblk', ['-J', '-b']),
  command('storage.lsblk-pairs', 'lsblk', [
    '-P',
    '-b',
    '-o',
    'NAME,KNAME,PATH,TYPE,SIZE,PKNAME,FSTYPE,UUID,MOUNTPOINT,MODEL,SERIAL,ROTA,RM',
  ]),
  command('storage.findmnt', 'findmnt', ['-J']),
  command('storage.mountinfo', 'cat', ['/proc/self/mountinfo']),
  command('storage.df-bytes', 'df', ['-B1', '-P']),
  command('storage.df-kilobytes', 'df', ['-k', '-P']),
  command('storage.df-inodes', 'df', ['-i', '-P']),
  command('storage.fstab', 'cat', ['/etc/fstab']),
  command('storage.swap', 'swapon', [
    '--show=NAME,TYPE,SIZE,USED,PRIO',
    '--bytes',
    '--noheadings',
    '--raw',
  ]),
  command('storage.swap-proc', 'cat', ['/proc/swaps']),
  command('network.addresses', 'ip', ['-j', 'addr']),
  command('network.addresses-text', 'ip', ['-o', 'addr', 'show']),
  command('network.routes', 'ip', ['-j', 'route']),
  command('network.routes-text', 'ip', ['route', 'show', 'table', 'main']),
  command('network.dns', 'cat', ['/etc/resolv.conf']),
  command('firewall.firewalld', 'firewall-cmd', ['--state'], {
    maxOutputBytes: 100_000,
    sudo: 'allowed',
  }),
  command('firewall.ufw', 'ufw', ['status'], { maxOutputBytes: 500_000, sudo: 'allowed' }),
  command('firewall.nft', 'nft', ['-j', 'list', 'ruleset'], {
    maxOutputBytes: 1_000_000,
    sudo: 'allowed',
  }),
  command('firewall.iptables', 'iptables-save', [], {
    maxOutputBytes: 1_000_000,
    sudo: 'allowed',
  }),
  command('environment.dpkg', 'dpkg-query', ['--version'], { maxOutputBytes: 100_000 }),
  command('environment.rpm', 'rpm', ['--version'], { maxOutputBytes: 100_000 }),
  command('environment.apk', 'apk', ['--version'], { maxOutputBytes: 100_000 }),
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
