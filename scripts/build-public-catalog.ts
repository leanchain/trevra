import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { listSkills } from '../src/server/skills/registry.js';

const sourceRevision = (() => {
  try { return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { return 'unknown'; }
})();
const generatedAt = (() => {
  try { return execFileSync('git', ['log', '-1', '--format=%cI'], { encoding: 'utf8' }).trim(); } catch { return '1970-01-01T00:00:00Z'; }
})();
const modules = listSkills().map(({ manifest }) => ({
  id: manifest.id,
  name: manifest.name,
  version: manifest.version,
  description: manifest.description,
  sideEffect: manifest.sideEffect,
  requiresApproval: manifest.requiresApproval,
  runtime: 'builtin',
  sourceType: 'builtin',
  publisher: { slug: 'trevra', name: 'Trevra', verified: true },
  trust: { signed: false, sbom: true, verifiedRelease: true },
  popularity: { totalRuns: 0, successfulRuns: 0, failedRuns: 0, successRate: null, uniqueWorkspaces: 0, activeInstallations: 0, lastRunAt: null, rank: null },
  source: `src/server/${manifest.id.startsWith('gtm.channel-') ? 'channels' : 'skills'}`
}));

const catalog = {
  schemaVersion: '1.0.0',
  generatedAt,
  sourceRevision,
  project: 'Trevra',
  contract: {
    inputs: 'Zod-validated input schema',
    outputs: 'Zod-validated output schema',
    sideEffects: ['none', 'network-read', 'external-write'],
    approvals: 'Declared per module and enforced by the runner'
  },
  modules
};

const outputs = [
  resolve('src/generated/public-modules.json'),
  resolve('public/catalog/modules.json')
];

for (const output of outputs) {
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
}

console.log(`Published ${modules.length} Trevra modules to the public catalog.`);
