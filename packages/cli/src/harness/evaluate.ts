import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { gates } from '../gates.js';
import { parseReport } from '../quality/suites.js';
import type { Suite } from '../quality/types.js';
import { digest, git, hashTree, readJson, writeJson } from './io.js';
import { Container, platformBin, runnerEnvironment, safeFile } from './runner.js';
import type { Plan } from './plan.js';

// Both evaluator workspaces are created only after the last model process exits.
// Record the original inventory even when tests fail on the unchanged base.
export type EvaluationInputs = Pick<
  Plan,
  'bundle' | 'pin' | 'feature' | 'oracle' | 'expectedHash' | 'inputs' | 'project' | 'oracleHash'
>;
export async function evaluate(
  plan: EvaluationInputs,
  runDir: string,
  finalCommit: string,
  image: string,
) {
  if (
    hashTree(plan.oracle) !== plan.oracleHash ||
    hashTree(join(plan.inputs, 'expected.yaml')) !== plan.expectedHash
  )
    throw new Error('Frozen QA inputs changed');
  const dir = join(runDir, 'evaluation');
  mkdirSync(dir, { recursive: true });
  const suites: Suite[] = [];
  const inventory: { public: string[]; hidden: string[] } = { public: [], hidden: [] };

  for (const revision of ['base', 'final'] as const) {
    const root = mkdtempSync(join(realpathSync(tmpdir()), 'frugal-evaluator-'));
    const repo = join(root, 'repo');
    git(root, [
      'clone',
      '--no-local',
      revision === 'base' ? plan.bundle : join(runDir, 'final.bundle'),
      repo,
    ]);
    git(repo, ['checkout', '--detach', revision === 'base' ? plan.pin : finalCommit]);
    git(repo, ['remote', 'remove', 'origin']);

    const env = runnerEnvironment(root);
    const container = new Container(root, repo, env, image, `evaluate-${root.split('/').pop()}`);
    const config = parse(git(repo, ['show', `${plan.pin}:frugal.yaml`]));
    if (config.test?.report !== 'junit' || typeof config.test?.command !== 'string')
      throw new Error('Run evaluation needs a configured JUnit test command');
    // Read the oracle only in this new workspace and never execute repository code on the host.
    const oracle = join(root, 'hidden_tests');
    cpSync(plan.oracle, oracle, { recursive: true });
    for (const kind of ['public', 'hidden'] as const) {
      const name = `${revision}-${kind}`;
      const report = join(root, 'tmp', `${name}.xml`);
      const args = kind === 'hidden' ? [oracle] : [];
      // Command is frozen in the trusted base commit. Arguments are passed separately.
      const result = await container.exec(
        [
          'sh',
          '-c',
          `exec ${config.test.command} "$@"`,
          'frugal-test',
          ...args,
          '--rootdir=.',
          '--junitxml',
          report,
        ],
        {
          onLine: (line, stderr) => {
            writeFileSync(join(dir, name + (stderr ? '.stderr' : '.stdout')), `${line}\n`, {
              flag: 'a',
            });
          },
        },
      );
      const xml = safeFile(root, report);
      writeFileSync(join(dir, `${name}.xml`), xml);
      const cases = parseReport('junit', xml.toString('utf8'));
      if (revision === 'base') {
        inventory[kind] = Array.from(cases.keys()).sort();
        if (
          kind === 'public' &&
          (result.code !== 0 || [...cases.values()].some((s) => s !== 'passed'))
        )
          throw new Error('Original public regression suite failed');
      } else {
        suites.push({
          kind,
          format: 'junit',
          path: `${name}.xml`,
          sha256: digest(xml),
          exit_code: result.code,
          expected_tests: inventory[kind],
        });
      }
    }
  }
  const evidence = join(dir, 'evidence.json');
  writeJson(evidence, {
    final_commit: finalCommit,
    suites,
    links: [],
    semantic: [],
    review: readJson(join(runDir, 'b0/quality-review.json')),
  });

  // Preserve the exact input that WP-05 and the independent reviewer will inspect offline.
  writeFileSync(join(dir, 'expected.yaml'), readFileSync(join(plan.inputs, 'expected.yaml')));
  writeJson(join(dir, 'inputs.json'), {
    final_commit: finalCommit,
    change: plan.feature,
    expected_hash: plan.expectedHash,
    oracle_hash: plan.oracleHash,
    evidence_hash: hashTree(evidence),
    bundle_hash: hashTree(join(runDir, 'final.bundle')),
  });
  // Test processes could edit their checkout. Rebuild the snapshot before using git/OpenSpec outside Docker.
  const finalRepo = restoreFinal(runDir, finalCommit);
  const guardDir = join(runDir, 'quality');
  const options = [
    '--repo',
    finalRepo,
    '--change',
    plan.feature,
    '--expected',
    join(dir, 'expected.yaml'),
    '--evidence',
    evidence,
    '--out',
    guardDir,
    '--openspec',
    platformBin(plan.project, 'openspec'),
  ];
  await gates([...options, '--prepare']);
  const code = await gates(options);
  const result = existsSync(join(guardDir, 'gates.json'))
    ? readJson<Record<string, unknown>>(join(guardDir, 'gates.json'))
    : {};
  return {
    code,
    gates: result,
    hidden: (result.suites as { hidden?: Record<string, unknown> } | undefined)?.hidden ?? {
      evaluated: false,
    },
  };
}

export function restoreFinal(runDir: string, finalCommit: string) {
  if (!/^[0-9a-f]{40,64}$/.test(finalCommit)) throw new Error('Invalid final commit');
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'frugal-final-'));
  const repo = join(dir, 'repo');
  git(dir, ['clone', '--no-local', join(runDir, 'final.bundle'), repo]);
  git(repo, ['checkout', '--detach', finalCommit]);
  if (git(repo, ['rev-parse', 'HEAD']) !== finalCommit) throw new Error('Final SHA mismatch');
  return repo;
}
