import {
  associateSocketContainers,
  parseNetstatSockets,
  parseProcessList,
  parseSsSockets,
  redactCommandLine,
} from '@opsense/collectors';
import type { ContainerRecord } from '@opsense/schema';
import { describe, expect, it } from 'vitest';

import { readFixture } from './support/read-fixture.js';

describe('M4 process and socket parsers', () => {
  it('redacts short password options and sensitive shell assignments', () => {
    const command = redactCommandLine(
      'mongo -u app -p raw-secret -pattached DB_PASSWORD=assigned-secret --eval ready',
    );

    expect(command).toBe(
      'mongo -u app -p [REDACTED] -p[REDACTED] DB_PASSWORD=[REDACTED] --eval ready',
    );
    expect(command).not.toContain('raw-secret');
    expect(command).not.toContain('attached');
    expect(command).not.toContain('assigned-secret');
  });

  it('parses process metadata, proc links, cgroups, and redacts command arguments', async () => {
    const [processesSource, linksSource, passwdSource] = await Promise.all([
      readFixture('m4/process-list.txt'),
      readFixture('m4/process-links.txt'),
      readFixture('m4/passwd.txt'),
    ]);
    const processes = parseProcessList(
      processesSource,
      linksSource,
      passwdSource,
      { links: 'evidence:process.links', list: 'evidence:process.list' },
      '2026-08-14T05:00:00.000Z',
    );
    const app = processes.find((process) => process.pid === 2341);
    const container = processes.find((process) => process.pid === 3456);

    expect(app).toMatchObject({
      executablePath: '/usr/bin/node',
      parentPid: 1,
      userId: 1001,
      userName: 'app',
      workingDirectory: '/opt/order-api',
    });
    expect(app?.arguments).toContain('[REDACTED]');
    expect(app?.arguments).not.toContain('top-secret');
    expect(container?.containerId).toMatch(/^container:abcdef123456/);
  });

  it('parses IPv4 and IPv6 listeners and associates sockets with containers', async () => {
    const [ssSource, netstatSource] = await Promise.all([
      readFixture('m4/ss.txt'),
      readFixture('m4/netstat.txt'),
    ]);
    const sockets = parseSsSockets(ssSource, 'evidence:network.sockets');
    const netstat = parseNetstatSockets(netstatSource, 'evidence:network.sockets-netstat');
    const container = containerFixture();
    const associated = associateSocketContainers(
      sockets,
      [
        {
          arguments: [],
          command: 'nginx',
          containerId: container.id,
          evidenceIds: [],
          id: 'process:3456',
          pid: 3456,
        },
      ],
      [container],
    );

    expect(sockets.find((socket) => socket.localPort === 8080)).toMatchObject({
      exposed: true,
      processIds: [2341],
      processNames: ['node'],
    });
    expect(sockets.find((socket) => socket.localPort === 22)).toMatchObject({
      family: 'ipv6',
      localAddress: '::',
    });
    expect(sockets.find((socket) => socket.localPort === 18080)?.exposed).toBe(false);
    expect(netstat).toHaveLength(2);
    expect(associated.find((socket) => socket.localPort === 18080)?.containerIds).toEqual([
      container.id,
    ]);
  });

  it('keeps processes that exit while proc link metadata is being collected', async () => {
    const processes = parseProcessList(
      await readFixture('m4/process-list.txt'),
      '',
      await readFixture('m4/passwd.txt'),
      { links: 'evidence:process.links', list: 'evidence:process.list' },
      '2026-08-14T05:00:00.000Z',
    );

    expect(processes).toHaveLength(4);
    expect(processes.every((process) => process.executablePath === undefined)).toBe(true);
  });
});

function containerFixture(): ContainerRecord {
  return {
    environmentKeys: [],
    evidenceIds: [],
    id: 'container:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
    image: 'nginx:1.27',
    labels: {},
    mounts: [],
    name: 'web',
    networks: [],
    ports: [],
    processId: 3456,
    runtime: 'docker',
    state: 'running',
  };
}
