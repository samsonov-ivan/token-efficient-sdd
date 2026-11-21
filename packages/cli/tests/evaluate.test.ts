import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { evaluate } from '../src/harness/evaluate.js';
import { command, git, hashTree, readJson, writeJson } from '../src/harness/io.js';
import { Container } from '../src/harness/runner.js';
import { parseReport } from '../src/quality/suites.js';

vi.mock('../src/gates.js', () => ({ gates: vi.fn().mockResolvedValue(0) }));

const pytestAvailable = spawnSync('python3', ['-m', 'pytest', '--version']).status === 0;
const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it.skipIf(!pytestAvailable).each([
  { change: 'added-tests', outcome: 'passed' },
  { change: 'failed-assertion', outcome: 'failed' },
  { change: 'skipped-original', outcome: 'skipped' },
  { change: 'missing-parameter', outcome: undefined },
])(
  'checks the original pytest collection and fixtures on the final code ($change)',
  async ({ change, outcome }) => {
    vi.spyOn(Container.prototype, 'exec').mockImplementation(function (
      this: Container,
      args,
      opts,
    ) {
      roots.push(this.root);
      return command(args[0], args.slice(1), {
        cwd: this.repo,
        env: {
          PATH: process.env.PATH,
          ...this.env,
          HOME: process.env.HOME,
          PYTEST_DISABLE_PLUGIN_AUTOLOAD: '1',
        },
        onLine: opts?.onLine,
      }).then((result) => {
        if (!existsSync(args[args.length - 1])) throw new Error(result.stderr || result.stdout);
        return result;
      });
    });
    const root = mkdtempSync(join(tmpdir(), 'frugal-evaluate-test-'));
    roots.push(root);
    const repo = join(root, 'repo');
    const input = join(root, 'input');
    const oracle = join(root, 'oracle');
    const out = join(root, 'run');
    const bundle = join(root, 'base.bundle');
    mkdirSync(repo);
    git(repo, ['init', '-b', 'main']);
    const file = (path: string, content: string) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    };
    const commit = () => {
      git(repo, ['add', '.']);
      git(repo, [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.com',
        'commit',
        '-m',
        'Fixture',
      ]);
      return git(repo, ['rev-parse', 'HEAD']);
    };
    file(join(input, 'expected.yaml'), 'repo: demo\n');
    file(join(oracle, 'spec_oracle.py'), 'def test_oracle():\n    assert True\n');
    writeJson(join(out, 'b0/quality-review.json'), {});
    file(join(repo, 'pytest.ini'), '[pytest]\npython_files = spec_*.py\ntestpaths = checks more\n');
    file(
      join(repo, 'frugal.yaml'),
      'paths: {tests: [checks], src: [src]}\ntest: {command: python3 -m pytest, report: junit}\n',
    );
    file(join(repo, 'src/product.py'), 'MODE = "base"\nCASES = ["original id"]\n');
    file(
      join(repo, 'checks/conftest.py'),
      'import pytest\n\n@pytest.fixture\ndef value():\n    return 1\n',
    );
    file(
      join(repo, 'checks/spec_original.py'),
      'import pytest\nfrom product import CASES, MODE\n\n' +
        '@pytest.mark.parametrize("case", CASES)\ndef test_original(case, value):\n' +
        '    if MODE == "skipped-original":\n        pytest.skip("regression")\n' +
        '    assert value == 1\n    assert MODE != "failed-assertion"\n',
    );
    file(join(repo, 'more/spec_other.py'), 'def test_other():\n    assert True\n');
    const pin = commit();
    git(repo, ['bundle', 'create', bundle, 'main']);

    const cases = change === 'missing-parameter' ? ['new id'] : ['original id', 'new id'];
    file(
      join(repo, 'src/product.py'),
      `MODE = ${JSON.stringify(change)}\nCASES = ${JSON.stringify(cases)}\n`,
    );
    file(
      join(repo, 'checks/conftest.py'),
      'import pytest\n\n@pytest.fixture\ndef value():\n    return {"new": 2}\n',
    );
    file(
      join(repo, 'checks/spec_original.py'),
      'def test_original(value):\n    assert value["new"] == 2\n',
    );
    file(join(repo, 'checks/spec_new.py'), 'def test_new(value):\n    assert value["new"] == 2\n');
    file(join(repo, 'more/conftest.py'), 'import pytest\n\npytestmark = pytest.mark.skip\n');
    file(join(repo, 'more/spec_added.py'), 'def test_added():\n    assert True\n');
    const final = commit();
    git(repo, ['bundle', 'create', join(out, 'final.bundle'), 'main']);

    const result = await evaluate(
      {
        project: resolve('.'),
        feature: 'fixture',
        bundle,
        pin,
        inputs: input,
        expectedHash: hashTree(join(input, 'expected.yaml')),
        oracle,
        oracleHash: hashTree(oracle),
      },
      out,
      final,
      'test-image',
    );
    const evaluation = join(out, 'evaluation');
    const evidence = readJson<{ ok: boolean; changed: string[]; expected_nodeids: string[] }>(
      join(evaluation, 'frozen-regression.json'),
    );
    expect(result.code).toBe(outcome === 'passed' ? 0 : 1);
    expect(evidence.ok).toBe(outcome === 'passed');
    expect(evidence.changed).toContain('checks/spec_new.py');
    expect(evidence.changed).toContain('more/conftest.py');
    expect(evidence.expected_nodeids).toEqual([
      'checks/spec_original.py::test_original[original id]',
      'more/spec_other.py::test_other',
    ]);
    const junit = (name: string) =>
      parseReport('junit', readFileSync(join(evaluation, name), 'utf8'));
    expect(junit('final-public.xml').get('checks.spec_new::test_new')).toBe('passed');
    expect(junit('final-public.xml').get('more.spec_added::test_added')).toBe('passed');
    const regression = junit('regression-public.xml');
    expect([...regression.keys()].sort()).toEqual(
      change === 'missing-parameter'
        ? ['more.spec_other::test_other']
        : ['checks.spec_original::test_original[original id]', 'more.spec_other::test_other'],
    );
    expect(regression.get('checks.spec_original::test_original[original id]')).toBe(outcome);
  },
  30000,
);
