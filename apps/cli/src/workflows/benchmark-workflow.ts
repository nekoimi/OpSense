import { readFile } from 'node:fs/promises';

import { benchmarkRun, compareBenchmarks } from '@opsense/evaluation';
import type { BenchmarkComparison, RunBenchmark } from '@opsense/evaluation';
import { PipelineRunSchema, RunMetricsSchema, assertSchema } from '@opsense/schema';
import { ensureRunWorkspace } from '@opsense/workspace';

export interface BenchmarkWorkflowOptions {
  compare?: [string, string];
  run?: string;
  workspace?: string;
}

export async function runBenchmarkWorkflow(
  options: BenchmarkWorkflowOptions,
): Promise<RunBenchmark | BenchmarkComparison> {
  if (options.compare !== undefined) {
    const [baselineId, candidateId] = options.compare;
    return compareBenchmarks(
      await loadBenchmark(baselineId, options.workspace),
      await loadBenchmark(candidateId, options.workspace),
    );
  }
  if (options.run === undefined) throw new Error('Specify --run or --compare.');
  return loadBenchmark(options.run, options.workspace);
}

async function loadBenchmark(runId: string, workspace?: string): Promise<RunBenchmark> {
  const layout = await ensureRunWorkspace(runId, workspace);
  const [runValue, metricsValue] = await Promise.all([
    readJson(layout.pipelineRunFile),
    readJson(layout.metricsFile),
  ]);
  assertSchema(PipelineRunSchema, runValue);
  assertSchema(RunMetricsSchema, metricsValue);
  return benchmarkRun(runValue, metricsValue);
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, 'utf8')) as unknown;
}
