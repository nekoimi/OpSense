import {
  buildComposeProjects,
  parseDockerInspect,
  parseDockerPs,
  parseDockerPsBasic,
} from '@opsense/collectors';
import { describe, expect, it } from 'vitest';

import { readFixture } from './support/read-fixture.js';

describe('M4 Docker and Compose parsers', () => {
  it('parses the legacy-compatible tabular container list fallback', () => {
    expect(
      parseDockerPsBasic(
        'abcdef123456\tweb\tnginx:1.27\trunning\n1234567890ab\tworker\tnode:22\texited\n',
      ),
    ).toEqual([
      { id: 'abcdef123456', image: 'nginx:1.27', name: 'web', state: 'running' },
      { id: '1234567890ab', image: 'node:22', name: 'worker', state: 'exited' },
    ]);
  });

  it('parses inspect data without retaining environment values or sensitive labels', async () => {
    const summaries = parseDockerPs(await readFixture('m4/docker-ps.jsonl'));
    const container = parseDockerInspect(
      await readFixture('m4/docker-inspect-web.json'),
      'evidence:docker.inspect:abcdef123456',
      summaries[0],
    );

    expect(container).toMatchObject({
      healthStatus: 'healthy',
      image: 'nginx:1.27',
      name: 'web',
      processId: 3456,
      restartPolicy: 'unless-stopped',
      state: 'running',
    });
    expect(container.environmentKeys).toEqual(['PATH', 'API_TOKEN']);
    expect(JSON.stringify(container)).not.toContain('secret-value');
    expect(container.labels['example.password']).toBe('[REDACTED]');
    expect(container.mounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ destination: '/etc/nginx/nginx.conf', readOnly: true }),
      ]),
    );
    expect(container.ports[0]).toMatchObject({ containerPort: 80, hostPort: 8080 });
  });

  it('groups containers into Compose projects using labels and compose ls', async () => {
    const summaries = parseDockerPs(await readFixture('m4/docker-ps.jsonl'));
    const container = parseDockerInspect(
      await readFixture('m4/docker-inspect-web.json'),
      'evidence:docker.inspect:abcdef123456',
      summaries[0],
    );
    const projects = buildComposeProjects(
      [container],
      await readFixture('m4/compose-ls.json'),
      'evidence:docker.compose-ls',
    );

    expect(projects[0]).toMatchObject({
      configFiles: ['/srv/shop/compose.yml', '/srv/shop/compose.prod.yml'],
      name: 'shop',
      workingDirectory: '/srv/shop',
    });
    expect(projects[0]?.services[0]).toMatchObject({
      containerIds: [container.id],
      name: 'web',
    });
    expect(buildComposeProjects([container], undefined, undefined)[0]).toMatchObject({
      name: 'shop',
      workingDirectory: '/srv/shop',
    });
  });
});
