import {
  classifyIpAddress,
  parseDns,
  parseIpAddresses,
  parseIpAddressesText,
  parseIpRoutes,
  parseIpRoutesText,
  summarizeFirewall,
} from '@opsense/collectors';
import type { CommandExecutionResult } from '@opsense/ssh';
import { describe, expect, it } from 'vitest';

import { readFixture } from './support/read-fixture.js';

describe('M3 network parsers', () => {
  it('parses interfaces, classifies addresses, and identifies the default route', async () => {
    const [addressesSource, routesSource] = await Promise.all([
      readFixture('m3/ip-address.json'),
      readFixture('m3/ip-route.json'),
    ]);
    const interfaces = parseIpAddresses(addressesSource, 'evidence:network.addresses');
    const routes = parseIpRoutes(routesSource);

    expect(interfaces.flatMap((item) => item.addresses).map((item) => item.classification)).toEqual(
      expect.arrayContaining(['loopback', 'private', 'public']),
    );
    expect(routes[0]).toMatchObject({
      gateway: '192.168.10.1',
      isDefault: true,
      table: 'main',
    });
    expect(classifyIpAddress('not-an-address')).toBe('unknown');
  });

  it('parses DNS without retaining comments', async () => {
    const dns = parseDns(await readFixture('m3/resolv.conf'));

    expect(dns.servers).toEqual(['192.168.10.53', '1.1.1.1']);
    expect(dns.searchDomains).toEqual(['example.internal', 'svc.example.internal']);
  });

  it('parses iproute2 text output when JSON mode is unavailable', async () => {
    const [addressesSource, routesSource] = await Promise.all([
      readFixture('m3/ip-address.txt'),
      readFixture('m3/ip-route.txt'),
    ]);
    const interfaces = parseIpAddressesText(addressesSource, 'evidence:network.addresses-text');
    const routes = parseIpRoutesText(routesSource);

    expect(interfaces.find((item) => item.name === 'eth0')?.addresses[0]).toMatchObject({
      address: '192.168.10.20',
      classification: 'private',
    });
    expect(routes[0]).toMatchObject({
      gateway: '192.168.10.1',
      isDefault: true,
      table: 'main',
    });
  });

  it('summarizes nftables output without retaining the full ruleset', async () => {
    const result = commandResult('firewall.nft', await readFixture('m3/nft.json'));
    const summary = summarizeFirewall(new Map([['firewall.nft', result]]));

    expect(summary).toMatchObject({ backend: 'nftables', active: true });
    expect(summary.summary).toEqual(['tables: 1', 'chains: 1', 'rules: 1']);
  });
});

function commandResult(commandId: string, stdout: string): CommandExecutionResult {
  return {
    commandId,
    durationMs: 1,
    exitCode: 0,
    finishedAt: '2026-08-14T00:00:00.000Z',
    startedAt: '2026-08-14T00:00:00.000Z',
    status: 'success',
    stderr: '',
    stderrBytes: 0,
    stdout,
    stdoutBytes: Buffer.byteLength(stdout),
  };
}
