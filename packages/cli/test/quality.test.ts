import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readChange } from '../src/quality/change.js';
import { qualityCommand } from '../src/quality/command.js';
import { pythonTestContext } from '../src/quality/python.js';
import { Snapshot } from '../src/quality/snapshot.js';
import { parseReport } from '../src/quality/suites.js';
import type { Change, Evidence, Expected } from '../src/quality/types.js';
import { consistencyErrors, evaluate } from '../src/quality/verify.js';

const changeId = 'add-range';
const req = 'REQ-RANGE-01',
  scn = 'SCN-RANGE-01.1';
const expected: Expected = {
  version: 1,
  requirements: [
    { id: req, scenarios: [{ id: scn, description: 'The upper endpoint is included.' }] },
  ],
  tasks: [{ id: '1.1', description: 'Support inclusive endpoints', requirements: [req] }],
};
const requirement = `### Requirement: ${req} Inclusive endpoint\nThe client SHALL accept 10. The upper endpoint SHALL be inclusive.\n\n#### Scenario: ${scn} Maximum accepted\n- **WHEN** the value is 10\n- **THEN** the service accepts it.\n`;
const testId = 'tests.test_range::test_limit';
const xml = (body: string) =>
  `<testsuites><testsuite><testcase classname="tests.test_range" name="test_limit">${body}</testcase></testsuite></testsuites>`;
const goodSource = 'def allowed(value):\n    return value <= 10\n';
const testSource = `import pytest\nfrom app.range import allowed\n\n@pytest.mark.scenario('${scn}')\n@pytest.mark.task('1.1')\ndef test_limit():\n    assert allowed(10)\n`;
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});
function fixture(flat = false, testBody = testSource, designBound = 'inclusive', labels = true) {
  const root = mkdtempSync(join(tmpdir(), 'frugal-guard-fixture-'));
  roots.push(root);
  const repo = join(root, 'repo');
  const set = (p: string, content: string) => {
    const target = join(repo, p);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  };
  const folder = `openspec/changes/${changeId}/`;
  set(
    `${folder}proposal.md`,
    '## Why\n\nThis change adds a useful, explicit upper endpoint for customer supplied range values.\n\n## What Changes\n\n- Apply an inclusive endpoint.\n\n## Capabilities\n\n### New Capabilities\n\n- \x60range\x60: Adds inclusive range handling.\n\n## Impact\n\nThe public API changes.\n',
  );
  set(
    `${folder}design.md`,
    `## Decisions\n\n${labels ? `${req}: ` : ''}The upper endpoint is ${designBound}.\n`,
  );
  set(
    `${folder}tasks.md`,
    `## 1. API\n\n- [x] ${labels ? '1.1 ' : ''}Implement the inclusive endpoint${labels ? ` [${req}, ${scn}]` : ''}\n`,
  );
  set(
    folder + (flat ? 'specs.md' : 'specs/range/spec.md'),
    (flat ? '' : '## ADDED Requirements\n\n') +
      (labels ? requirement : requirement.replace(`${req} `, '').replace(`${scn} `, '')),
  );
  set('app/range.py', goodSource);
  set('tests/test_range.py', testBody);
  const git = (args: string[]) =>
    execFileSync('git', args, {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    });
  git(['init', '-q']);
  git(['add', '.']);
  git([
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'fixture',
  ]);
  const snapshot = new Snapshot(repo);
  const read = () => readChange(snapshot, changeId, resolve('node_modules/.bin/openspec'));
  const suite = (kind: 'public' | 'hidden') => {
    const data = xml('');
    const path = `${kind}.xml`;
    writeFileSync(join(root, path), data);
    return {
      kind,
      format: 'junit' as const,
      path,
      sha256: createHash('sha256').update(data).digest('hex'),
      exit_code: 0,
      expected_tests: [testId],
    };
  };
  const evidence: Evidence = {
    final_commit: snapshot.commit,
    suites: [suite('public'), suite('hidden')],
    links: [
      {
        scenario: scn,
        task: '1.1',
        test: testId,
        code: { path: 'app/range.py', line: 2, text: 'return value <= 10' },
        assertion: { path: 'tests/test_range.py', line: 7, text: testBody.split('\n')[6].trim() },
      },
    ],
    semantic: [
      {
        requirement: req,
        verdict: 'pass',
        reason: 'Compared endpoint 10 in the scenario and decision with the inclusive comparison.',
      },
    ],
    review: [
      {
        round: 1,
        tree: snapshot.tree,
        scope: 'Range behavior and endpoint checks',
        verdict: 'pass',
        summary: 'The fix and test cover the inclusive endpoint.',
      },
    ],
  };
  return { root, repo, snapshot, read, evidence };
}

describe('final snapshot quality', () => {
  let f: ReturnType<typeof fixture>;
  let model: Change;
  beforeAll(() => {
    f = fixture();
    model = f.read();
  }, 30_000);
  const run = (e = f.evidence, c = model) =>
    evaluate(c, expected, e, f.snapshot, f.root, false).gates;
  it('reads pinned OpenSpec and traces every obligation to a tracked assertion and runner result', () => {
    const gates = run();
    expect(gates.errors).toEqual([]);
    expect(gates.metrics).toEqual({
      Cov_req: 1,
      Cov_scn: 1,
      Cov_task: 1,
      Cov_expected: 1,
      Green: 1,
      Cons: 1,
      Q_hidden: 1,
      R: 1,
    });
  });
  it('checks flat projection against the same normative obligations', { timeout: 30_000 }, () => {
    const other = fixture(true);
    const result = other.read();
    expect(result.requirements.map((r) => r.id)).toEqual([req]);
    expect(consistencyErrors(result, expected)).toEqual([]);
  });
  it('fails a missing expected test, dangling task link or omitted expected scenario', () => {
    const e = structuredClone(f.evidence);
    e.suites[0].expected_tests.push('deleted baseline test');
    expect(run(e).checks.full_suite.errors.join()).toContain('Missing test');
    const c = structuredClone(model);
    c.tasks[0].refs.push('REQ-GONE-09');
    c.requirements[0].scenarios = [];
    expect(run(f.evidence, c).checks.consistency.errors.join()).toMatch(/Dangling reference/);
    expect(run(f.evidence, c).metrics.Cov_scn).toBe(0);
  });
  it('requires independent semantic evidence and final-state review approval', () => {
    const e = structuredClone(f.evidence);
    e.semantic[0] = {
      requirement: req,
      verdict: 'fail',
      reason: 'Design makes the upper endpoint exclusive',
    };
    e.review[0].tree = '0'.repeat(40);
    const g = run(e);
    expect(g.metrics.Cons).toBe(0);
    expect(g.checks.semantic.errors.join()).toContain('exclusive');
    expect(g.checks.review.ok).toBe(false);
  });
  it(
    'finds a contradictory boundary in strict-valid design without a supplied negative verdict',
    { timeout: 30_000 },
    () => {
      const broken = fixture(false, testSource, 'exclusive');
      const change = broken.read();
      expect(consistencyErrors(change, expected).join()).toContain('contradictory upper endpoint');
    },
  );
  it(
    'binds missing OpenSpec identities and artifact references to independent source evidence',
    { timeout: 30_000 },
    () => {
      const f = fixture(false, testSource, 'inclusive', false);
      const change = f.read();
      const ev = f.evidence;
      ev.aliases = (change.missingIds ?? []).map(({ kind, path, text, parent }) => ({
        kind,
        path,
        text,
        parent,
        id: { requirement: req, scenario: scn, task: '1.1' }[kind],
        reason:
          'Compared the recorded 10 boundary, its decision and corresponding test to the frozen obligation.',
      }));
      expect(ev.aliases.map((a) => a.kind).sort()).toEqual(['requirement', 'scenario', 'task']);
      ev.artifact_links = [
        {
          path: change.designPath,
          line: 3,
          text: 'The upper endpoint is inclusive.',
          refs: [req],
          reason: 'States the same inclusive constraint.',
        },
        {
          path: change.designPath.replace('design.md', 'tasks.md'),
          line: 3,
          text: '- [x] Implement the inclusive endpoint',
          task: '1.1',
          refs: [req, scn],
          reason: 'Implements that exact bound.',
        },
      ];
      expect(evaluate(change, expected, ev, f.snapshot, f.root, false).gates.ok).toBe(false);
      expect(evaluate(change, expected, ev, f.snapshot, f.root, true).gates.errors).toEqual([]);
      ev.links = [];
      expect(evaluate(change, expected, ev, f.snapshot, f.root, true).gates.metrics.Cov_req).toBe(
        0,
      );
    },
  );
  it('blocks stale evidence and invalidated reports', () => {
    const e = structuredClone(f.evidence);
    e.final_commit = 'stale';
    expect(() => run(e)).toThrow(/final commit/);
    e.final_commit = f.snapshot.commit;
    e.suites[0].sha256 = 'stale';
    expect(run(e).checks.full_suite.ok).toBe(false);
  });
  it('rejects passing tests whose assertion only checks a constant', () => {
    const other = fixture(false, testSource.replace('assert allowed(10)', 'assert True'));
    const g = evaluate(model, expected, other.evidence, other.snapshot, other.root, false).gates;
    expect(g.metrics.Cov_req).toBe(0);
    expect(g.errors.join()).toContain('tautological assertion');
  });
  it('traces an assertion after a nested helper in a decorated multiline async test', () => {
    const source = `import pytest
from app.range import allowed

@pytest.mark.scenario(
    '${scn}',
)
@pytest.mark.task('1.1')
async def test_limit(
    endpoint=10,
):
    def value():
        return endpoint

    assert allowed(value())
`;
    const other = fixture(false, source);
    other.evidence.links[0].assertion = {
      path: 'tests/test_range.py',
      line: 14,
      text: 'assert allowed(value())',
    };
    const g = evaluate(model, expected, other.evidence, other.snapshot, other.root, false).gates;
    expect(g.errors).toEqual([]);
    expect(g.metrics.Cov_req).toBe(1);
  });
  it.each([
    [
      'a dead nested helper even when its name matches the reported test',
      '    def test_limit():\n        assert allowed(8)\n\n    assert allowed(10)\n',
    ],
    ['another test', '    assert allowed(10)\n\ndef test_other():\n    assert allowed(8)\n'],
    ['an adjacent class body', '    assert allowed(10)\n\nclass Other:\n    assert allowed(8)\n'],
    ['a triple-quoted string', '    """\n    assert allowed(8)\n    """\n    assert allowed(10)\n'],
  ])('rejects an assertion inside %s', (_description, body) => {
    const assertion = 'assert allowed(8)';
    const source = testSource.replace('    assert allowed(10)\n', body);
    const other = fixture(false, source);
    other.evidence.links[0].assertion = {
      path: 'tests/test_range.py',
      line: source.split('\n').findIndex((line) => line.trim() === assertion) + 1,
      text: assertion,
    };
    const g = evaluate(model, expected, other.evidence, other.snapshot, other.root, false).gates;
    expect(g.metrics.Cov_req).toBe(0);
    expect(g.errors.join()).toContain(`Assertion is outside reported test ${testId}`);
  });
  it('distinguishes class methods with the same test name and accepts parameterized IDs', () => {
    const source = `class TestLower:
    def test_limit(self):
        assert allowed(1)

class TestUpper:
    def test_limit(self):
        assert allowed(10)
`.split('\n');
    const test = 'tests.test_range.TestUpper::test_limit[value::10]';
    expect(pythonTestContext(source, 7, test, 'test_range')).toContain('assert allowed(10)');
    expect(pythonTestContext(source, 3, test, 'test_range')).toBeUndefined();
  });
  it(
    'replays a detached Ed25519 assessment through the CLI and rejects a tampered answer',
    { timeout: 60_000 },
    () => {
      const f = fixture();
      const out = join(f.root, 'quality');
      const evidence = join(f.root, 'evidence.json');
      const oracle = join(f.root, 'expected.yaml');
      writeFileSync(evidence, JSON.stringify({ ...f.evidence, links: [], semantic: [] }));
      writeFileSync(oracle, JSON.stringify(expected));
      const args = [
        '--repo',
        f.repo,
        '--change',
        changeId,
        '--out',
        out,
        '--evidence',
        evidence,
        '--expected',
        oracle,
      ];
      expect(qualityCommand('gates', [...args, '--prepare'])).toBe(0);
      const req = JSON.parse(readFileSync(join(out, 'evaluator-request.json'), 'utf8'));
      expect(req.candidates[0].code_candidates[0].text).toContain('allowed');
      expect(req.candidates[0].assertions[0].text).toContain('assert allowed(10)');
      const review = join(f.root, 'assessment.json'),
        sig = join(f.root, 'assessment.sig'),
        key = join(f.root, 'reviewer.pem');
      const data = JSON.stringify({
        version: 1,
        final_commit: f.snapshot.commit,
        request_sha256: req.request_sha256,
        reviewer: 'Independent fixture reviewer',
        links: f.evidence.links,
        semantic: f.evidence.semantic,
      });
      const pair = generateKeyPairSync('ed25519');
      writeFileSync(review, data);
      writeFileSync(sig, sign(null, Buffer.from(data), pair.privateKey));
      writeFileSync(key, pair.publicKey.export({ format: 'pem', type: 'spki' }));
      const replay = [...args, '--assessment', review, '--signature', sig, '--reviewer-key', key];
      expect(qualityCommand('gates', replay)).toBe(0);
      expect(JSON.parse(readFileSync(join(out, 'gates.json'), 'utf8')).ok).toBe(true);
      writeFileSync(review, `${data} `);
      expect(qualityCommand('gates', replay)).toBe(1);
      expect(JSON.parse(readFileSync(join(out, 'gates.json'), 'utf8')).errors).toContain(
        'Invalid assessment signature',
      );
    },
  );
  it('scores hidden failures separately, rejecting incomplete observations', () => {
    const f = fixture();
    const suite = f.evidence.suites[1];
    const data = xml('<failure>boundary</failure>');
    writeFileSync(join(f.root, suite.path), data);
    suite.sha256 = createHash('sha256').update(data).digest('hex');
    suite.exit_code = 1;
    expect(
      evaluate(model, expected, f.evidence, f.snapshot, f.root, false).gates.metrics.Q_hidden,
    ).toBe(0);
    suite.expected_tests.push('uncollected');
    expect(
      evaluate(model, expected, f.evidence, f.snapshot, f.root, false).gates.metrics.Q_hidden,
    ).toBe(null);
  });
  it('resolves an independently confirmed missing marker only when inference is enabled', () => {
    const other = fixture(
      false,
      testSource.replace("@pytest.mark.task('1.1')", '# task tag missing'),
    );
    const link = other.evidence.links[0];
    link.inferred = true;
    link.reason = 'Test explicitly exercises the endpoint added by 1.1.';
    expect(
      evaluate(model, expected, other.evidence, other.snapshot, other.root, false).gates.ok,
    ).toBe(false);
    expect(
      evaluate(model, expected, other.evidence, other.snapshot, other.root, true).gates.ok,
    ).toBe(true);
  });
});
describe('runner adapters', () => {
  it('reads pytest and Surefire failures and skipped tests', () => {
    expect(parseReport('junit', xml('<skipped type="pytest.xfail"/>')).get(testId)).toBe('skipped');
    expect(parseReport('junit', xml('<failure>bad</failure>')).get(testId)).toBe('failed');
    expect(() => parseReport('junit', '<testcase>')).toThrow();
    expect(() => parseReport('junit', '<testsuite/>')).toThrow();
  });
  it('reads Vitest/Jest without promoting todo to passed', () => {
    expect(
      parseReport(
        'jest',
        JSON.stringify({
          numTotalTests: 1,
          testResults: [{ assertionResults: [{ fullName: testId, status: 'todo' }] }],
        }),
      ).get(testId),
    ).toBe('skipped');
  });
  it('reads Go subtests and blocks a truncated stream', () => {
    const events = ['start', 'run', 'pass', 'pass'].map((Action, i) =>
      JSON.stringify({
        Package: 'm',
        Action,
        ...(i === 1 || i === 2 ? { Test: 'TestRange/Max' } : {}),
      }),
    );
    expect(parseReport('go', events.join('\n')).get('m::TestRange/Max')).toBe('passed');
    expect(() => parseReport('go', events.slice(0, 3).join('\n'))).toThrow(/Incomplete/);
  });
});
