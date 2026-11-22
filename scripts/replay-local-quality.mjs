// Replay the ten public queue scenarios against the model's archived files.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest, readJson } from '../packages/cli/dist/harness/io.js';
import { pilotEnvironment, publicChecks } from './fixtures/local-pilot-transport.mjs';

const roots = process.argv.slice(2);
assert(roots.length, 'Usage: node scripts/replay-local-quality.mjs RUN_DIR [...]');
const fixture = fileURLToPath(new URL('./fixtures/local-context-pilot/fixture.mjs', import.meta.url));
const fixtureHash = digest(readFileSync(fixture));
for (const path of roots) {
  const root = realpathSync(path);
  const run = readJson(join(root, 'run.json'));
  assert.equal(run.fixture_sha256, fixtureHash, 'Evaluator differs from the registered fixture');
  const apply = run.kind === 'local-model-apply-only-pilot';
  assert(apply || run.kind === 'public-local-full-sdd-pilot', 'Unknown public pilot kind');
  for (const arm of apply ? ['shared', 'fresh'] : [run.arm]) {
    const repo = join(root, ...(apply ? [arm, 'final'] : ['final']));
    const expected = apply ? run.summary[arm].final_checks : run.public_checks;
    const scratch = mkdtempSync(join(realpathSync(tmpdir()), 'frugal-public-replay-'));
    try {
      const actual = await publicChecks(scratch, repo, fixture, pilotEnvironment(scratch));
      assert(actual, 'Public evaluator did not finish');
      assert.deepEqual(actual, expected, `${basename(root)} ${arm}: recorded and replayed cases differ`);
      const counts = ['api', 'task1', 'task2'].map((group) => {
        const { passed, total } = actual[group];
        return `${group} ${passed}/${total}`;
      });
      console.log(`${basename(root)} ${arm} · ${counts.join(', ')}`);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}
