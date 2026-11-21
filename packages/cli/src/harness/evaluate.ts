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

  let regressionOk = false;
  let frozenReport = 'final-public.xml';
  let changedTests: string[] = [];
  const stages = [
    ['base', 'public'],
    ['base', 'hidden'],
    ['final', 'public'],
    ['final', 'hidden'],
    ['regression', 'public'],
  ] as const;
  for (const [revision, kind] of stages) {
    if (revision === 'regression' && !changedTests.length) continue;
    // A previous test process may have modified its checkout. Each invocation starts on the selected Git tree.
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
    const config = parse(git(repo, ['show', `${plan.pin}:frugal.yaml`]));
    if (config.test?.report !== 'junit' || typeof config.test?.command !== 'string')
      throw new Error('Run evaluation needs a configured JUnit test command');
    const paths = (values: unknown): string[] => {
      if (
        !Array.isArray(values) ||
        !values.length ||
        values.some(
          (p) =>
            typeof p !== 'string' ||
            p.startsWith('/') ||
            p.split('/').includes('..') ||
            p.startsWith('-'),
        )
      )
        throw new Error('Expected relative paths in frozen repository configuration');
      return values;
    };
    const originalTests = paths(config.paths?.tests ?? ['tests']);
    const pytestConfigs = [
      'pytest.ini',
      '.pytest.ini',
      'pyproject.toml',
      'tox.ini',
      'setup.cfg',
      'conftest.py',
    ];
    const frozenFiles = git(repo, [
      'ls-tree',
      '-r',
      '--name-only',
      plan.pin,
      '--',
      ...originalTests,
      ...pytestConfigs,
    ])
      .split('\n')
      .filter(Boolean);
    if (!frozenFiles.length) throw new Error('Empty frozen regression inventory');
    if (revision === 'final' && kind === 'public') {
      changedTests = git(repo, ['diff', '--name-only', plan.pin, finalCommit, '--', ...frozenFiles])
        .split('\n')
        .filter(Boolean);
    }
    if (revision === 'regression') {
      // Re-run original test bodies against final production code, even when candidate tests reuse the same IDs.
      git(repo, ['restore', '--source', plan.pin, '--staged', '--worktree', '--', ...frozenFiles]);
    }
    const env = runnerEnvironment(root);
    env.PYTHONPATH = paths(config.paths?.src ?? ['.'])
      .map((p) => join(repo, p))
      .join(':');
    const container = new Container(root, repo, env, image, `evaluate-${root.split('/').pop()}`);
    const name = `${revision}-${kind}`;
    const report = join(root, 'tmp', `${name}.xml`);
    const args: string[] = [];
    if (kind === 'hidden') {
      const oracle = join(root, 'hidden_tests');
      cpSync(plan.oracle, oracle, { recursive: true });
      if (hashTree(oracle) !== plan.oracleHash)
        throw new Error('Oracle changed while preparing evaluator');
      args.push(oracle);
    }
    const pytestConfig = pytestConfigs.slice(0, -1).find((file) => existsSync(join(repo, file)));
    if (pytestConfig) args.push('-c', pytestConfig);
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
      if (kind === 'public') {
        regressionOk =
          result.code === 0 && inventory.public.every((id) => cases.get(id) === 'passed');
        frozenReport = `${name}.xml`;
      }
      if (revision === 'final')
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
  writeJson(join(dir, 'frozen-regression.json'), {
    ok: regressionOk,
    base_commit: plan.pin,
    final_commit: finalCommit,
    changed: changedTests,
    expected_tests: inventory.public,
    path: frozenReport,
    report_sha256: hashTree(join(dir, frozenReport)),
  });
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
    regression_hash: hashTree(join(dir, 'frozen-regression.json')),
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
    code: regressionOk ? code : 1,
    gates: { ...result, frozen_regression: regressionOk },
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
