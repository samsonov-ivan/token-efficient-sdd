import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { evaluate } from '../src/harness/evaluate.js';
import { git, hashTree, readJson, writeJson } from '../src/harness/io.js';
import { Container } from '../src/harness/runner.js';
import { parseReport } from '../src/quality/suites.js';

// Opt in with a prepared Docker runner. Every repository and test below is public
// synthetic data. The production evaluator mounts its own private per-suite clones.
const requested = process.env.FRUGAL_PUBLIC_EVALUATOR_IMAGE ?? '';
it.skipIf(!requested)(
  'runs five Docker pytest suites for an optimized bundle and requires independent semantic evidence',
  async () => {
    const image = await Container.imageID(requested);
    const root = mkdtempSync(join(realpathSync(tmpdir()), 'frugal-public-eval-'));
    const repo = join(root, 'source'),
      out = join(root, 'run'),
      inputs = join(root, 'public-inputs');
    const oracle = join(root, 'public-oracle'),
      bundle = join(root, 'base.bundle');
    const feature = 'extend-range',
      req = 'REQ-RANGE-01',
      scn = 'SCN-RANGE-01.1';
    const put = (path: string, text: string) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    };
    const commit = (msg: string) => {
      git(repo, ['add', '.']);
      git(repo, [
        '-c',
        'user.name=Public fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '-qm',
        msg,
      ]);
      return git(repo, ['rev-parse', 'HEAD']);
    };
    try {
      mkdirSync(repo);
      git(repo, ['init', '-b', 'main']);
      put(
        join(repo, 'frugal.yaml'),
        'paths: {tests: [tests], src: [src]}\ntest: {command: python3 -m pytest -q, report: junit}\n',
      );
      put(join(repo, 'pytest.ini'), '[pytest]\ntestpaths = tests\n');
      put(join(repo, 'src/range_api.py'), 'def accepted(value):\n    return value < 5\n');
      put(
        join(repo, 'tests/test_original.py'),
        'from range_api import accepted\n\ndef test_ordinary():\n    assert accepted(3)\n',
      );
      const pin = commit('Original public range API');
      git(repo, ['bundle', 'create', bundle, 'main']);
      put(
        join(oracle, 'test_boundary.py'),
        'from range_api import accepted\n\ndef test_endpoint():\n    assert accepted(5)\n',
      );
      writeJson(join(inputs, 'expected.yaml'), {
        version: 1,
        requirements: [
          { id: req, scenarios: [{ id: scn, description: 'The upper boundary is included.' }] },
        ],
        tasks: [{ id: '1.1', description: 'Accept the upper boundary.', requirements: [req] }],
      });
      put(join(repo, 'src/range_api.py'), 'def accepted(value):\n    return value <= 5\n');
      put(
        join(repo, 'tests/test_added.py'),
        'from range_api import accepted\n\ndef test_published_endpoint():\n    assert accepted(5)\n',
      );
      const change = join(repo, 'openspec/changes', feature);
      put(
        join(change, 'proposal.md'),
        '## Why\n\nA public range endpoint must include its upper boundary for this fixture.\n\n## What Changes\n\n- Make the upper endpoint inclusive.\n\n## Capabilities\n\n### New Capabilities\n\n- `range`: Provide inclusive range checks.\n\n## Impact\n\nThe public range API changes.\n',
      );
      put(
        join(change, 'specs/range/spec.md'),
        `## ADDED Requirements\n\n### Requirement: ${req} Inclusive range\nThe system SHALL accept values up to and including 5.\n\n#### Scenario: ${scn} Accept upper bound\n- **WHEN** the input is 5\n- **THEN** return true\n`,
      );
      put(join(change, 'design.md'), `## Design\nCompare inclusively for ${req}.\n`);
      put(join(change, 'tasks.md'), `- [x] 1.1 Include the upper bound [${req}, ${scn}].\n`);
      const final = commit('Implement the synthetic boundary change');
      const review = [
        {
          round: 1,
          tree: git(repo, ['rev-parse', 'HEAD^{tree}']),
          scope: 'full',
          verdict: 'pass',
          summary: 'Reviewed the public range and its endpoint test.',
        },
      ];
      writeJson(join(out, 'opt/quality-review.json'), review);
      git(repo, ['bundle', 'create', join(out, 'final.bundle'), 'main']);
      const result = await evaluate(
        {
          project: resolve('.'),
          feature,
          pin,
          bundle,
          oracle,
          inputs,
          expectedHash: hashTree(join(inputs, 'expected.yaml')),
          oracleHash: hashTree(oracle),
        },
        out,
        final,
        image,
        'optimized',
      );
      const evaluated = join(out, 'evaluation');
      const reports: Record<string, string[]> = {
        'base-public': ['passed'],
        'base-hidden': ['failed'],
        'final-public': ['passed', 'passed'],
        'final-hidden': ['passed'],
        'regression-public': ['passed'],
      };
      for (const [name, values] of Object.entries(reports)) {
        const tests = parseReport('junit', readFileSync(join(evaluated, `${name}.xml`), 'utf8'));
        expect([...tests.values()].sort(), name).toEqual(values);
      }
      const gate = readJson<{
        ok: boolean;
        checks: { review: { ok: boolean }; semantic: { ok: boolean; errors: string[] } };
      }>(join(out, 'quality/gates.json'));
      expect(result.code).toBe(1);
      expect(result.gates.frozen_regression).toBe(true);
      expect(gate.ok).toBe(false);
      expect(gate.checks.review.ok).toBe(true);
      expect(gate.checks.semantic.ok).toBe(false);
      expect(gate.checks.semantic.errors.join(' ')).toContain(
        'Missing independent semantic verification',
      );
      expect(readJson<{ review: unknown }>(join(evaluated, 'evidence.json')).review).toEqual(
        review,
      );
      expect(
        readJson<{ final_commit: string }>(join(out, 'quality/evaluator-request.json'))
          .final_commit,
      ).toBe(final);
      expect(existsSync(join(evaluated, 'accepted.json'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  60000,
);
