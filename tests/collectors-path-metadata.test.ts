import { PATH_METADATA_BATCH_SIZE, collectPathMetadataSnapshot } from '@opsense/collectors';
import type { PathSeedRecord } from '@opsense/schema';
import { SafeCommandExecutor, getCommandSpec, renderCommand } from '@opsense/ssh';
import type { RawCommandResult, RemoteCommandTransport } from '@opsense/ssh';
import { describe, expect, it } from 'vitest';

describe('v3 path metadata collection', () => {
  it('collects up to 64 paths per stat command without reading configuration files', async () => {
    const seeds = Array.from({ length: 130 }, (_, index) => seed(`/opt/app-${index}`));
    const outputs = new Map<string, string>();
    for (let index = 0; index < seeds.length; index += PATH_METADATA_BATCH_SIZE) {
      const batch = seeds.slice(index, index + PATH_METADATA_BATCH_SIZE);
      outputs.set(
        renderCommand(getCommandSpec('directory.stat-batch'), {
          paths: batch.map((item) => item.path),
        }).execution,
        batch.map((item) => `directory\t4096\troot\troot\t755\t0\t${item.path}`).join('\n'),
      );
    }
    const transport = new FixtureTransport(outputs);
    const result = await collectPathMetadataSnapshot(new SafeCommandExecutor(transport), seeds, {
      opsenseVersion: '3.0.0',
    });

    expect(result.artifacts).toHaveLength(130);
    expect(result.evidence).toHaveLength(3);
    expect(result.unknowns).toEqual([]);
    expect(transport.commands).toHaveLength(3);
    expect(transport.commands.join('\n')).not.toContain("'cat'");
  });
});

class FixtureTransport implements RemoteCommandTransport {
  public readonly commands: string[] = [];

  public constructor(private readonly outputs: ReadonlyMap<string, string>) {}

  public executeRaw(command: string): Promise<RawCommandResult> {
    this.commands.push(command);
    const stdout = this.outputs.get(command);
    return Promise.resolve(
      stdout === undefined
        ? {
            durationMs: 1,
            exitCode: 127,
            status: 'command_missing',
            stderr: 'command not found',
            stderrBytes: 17,
            stdout: '',
            stdoutBytes: 0,
          }
        : {
            durationMs: 1,
            exitCode: 0,
            status: 'success',
            stderr: '',
            stderrBytes: 0,
            stdout,
            stdoutBytes: Buffer.byteLength(stdout),
          },
    );
  }
}

function seed(seedPath: string): PathSeedRecord {
  return {
    confidence: 'confirmed',
    id: `path-seed:${seedPath.slice('/opt/'.length)}`,
    path: seedPath,
    sources: [
      {
        evidenceIds: ['evidence:test'],
        sourceId: 'process:test',
        sourceType: 'process.working_directory',
      },
    ],
  };
}
