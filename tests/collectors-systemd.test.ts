import { parseSystemdUnits } from '@opsense/collectors';
import { describe, expect, it } from 'vitest';

import { readFixture } from './support/read-fixture.js';

describe('M4 systemd parser', () => {
  it('merges runtime state, enablement, details, and installed stopped units', async () => {
    const [units, files, details] = await Promise.all([
      readFixture('m4/systemd-units.txt'),
      readFixture('m4/systemd-files.txt'),
      readFixture('m4/systemd-details.txt'),
    ]);
    const parsed = parseSystemdUnits(units, files, details, {
      details: 'evidence:service.systemd-details',
      files: 'evidence:service.systemd-files',
      units: 'evidence:service.systemd-units',
    });

    expect(parsed.find((unit) => unit.name === 'order-api.service')).toMatchObject({
      activeState: 'active',
      enabledState: 'enabled',
      environmentFiles: ['/etc/order-api/order-api.env'],
      fragmentPath: '/etc/systemd/system/order-api.service',
      mainPid: 2341,
      workingDirectory: '/opt/order-api',
    });
    const startCommand = parsed.find((unit) => unit.name === 'order-api.service')?.execStart[0];
    expect(startCommand).toContain('--token [REDACTED]');
    expect(startCommand).not.toContain('top-secret');
    expect(parsed.find((unit) => unit.name === 'legacy-worker.service')).toMatchObject({
      enabledState: 'disabled',
      execStart: [],
      name: 'legacy-worker.service',
    });
  });
});
