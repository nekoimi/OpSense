import { readFile } from 'node:fs/promises';

import { assessReleaseSamples, parseReleaseSamples } from '../packages/evaluation/src/index.js';

const syntheticOnly = process.argv.includes('--synthetic-only');
const synthetic = parseReleaseSamples(
  JSON.parse(await readFile('fixtures/evaluation/v3-release-samples.json', 'utf8')) as unknown,
);
const real = syntheticOnly ? [] : await readOptionalRealSamples();
const assessment = assessReleaseSamples([...synthetic, ...real]);
const evaluatedGates = syntheticOnly
  ? assessment.gates.filter((gate) => gate.metric !== 'realServerEvidenceComplete')
  : assessment.gates;

const passed = evaluatedGates.every((gate) => gate.passed);
process.stdout.write(
  `${JSON.stringify({ ...assessment, gates: evaluatedGates, passed }, null, 2)}\n`,
);
if (!passed) process.exitCode = 1;

async function readOptionalRealSamples() {
  try {
    return parseReleaseSamples(
      JSON.parse(
        await readFile('fixtures/evaluation/v3-real-server-samples.local.json', 'utf8'),
      ) as unknown,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}
