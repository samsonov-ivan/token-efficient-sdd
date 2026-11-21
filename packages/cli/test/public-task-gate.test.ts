import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { flagsFor } from '../src/harness/plan.js';
import { Container, runnerEnvironment } from '../src/harness/runner.js';
import { createTaskGate, publicTaskConfig } from '../src/harness/task-gate.js';

const target = { language: 'python', test: { command: 'python -m pytest -q', report: 'junit' } };

it('selects the new controller flags independently on unchanged frozen target configurations', () => {
  const defaults = { incremental_review: true };
  expect(flagsFor('baseline', defaults, [])).toEqual({ incremental_review: false });
  expect(flagsFor('optimized', {}, ['capsule'])).toEqual({ capsule: true });
  expect(flagsFor('baseline', {}, ['capsule'])).toEqual({ capsule: false });
  expect(flagsFor('ablation', defaults, ['session_per_task'])).toEqual({
    incremental_review: false,
    session_per_task: true,
  });
  expect(() => flagsFor('optimized', {}, ['typo'])).toThrow(/Unknown/);
});

it('uses the frozen Python interpreter and checks public suite paths before a live run', () => {
  expect(
    publicTaskConfig({ ...target, test: { ...target.test, command: 'python3 -m pytest' } }),
  ).toEqual({ src: ['.'], tests: ['tests'], python: 'python3', quiet: false });
  expect(() => publicTaskConfig({ ...target, paths: { src: ['../outside'] } })).toThrow(/paths/);
  expect(() =>
    publicTaskConfig({ ...target, test: { ...target.test, command: 'make check' } }),
  ).toThrow(/pytest/);
});

it('rejects missing JUnit on an apparently successful retry and preserves both outputs', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'frugal-task-gate-'));
  try {
    mkdirSync(join(root, 'tmp'));
    const repo = join(root, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    let trial = 0;
    const gate = createTaskGate(
      root,
      repo,
      join(root, 'evidence'),
      publicTaskConfig(target),
      30,
      async (args) => {
        if (!trial++) {
          const path = args
            .find((arg) => arg.startsWith('--junitxml='))
            ?.slice('--junitxml='.length);
          if (!path) throw new Error('Expected JUnit output argument');
          writeFileSync(path, '<testsuite tests="1"><testcase name="check"/></testsuite>');
        }
        return { code: 0, stdout: 'public output', stderr: '' };
      },
    );
    expect(existsSync(join(root, 'evidence/opt'))).toBe(false);
    expect((await gate('1.1', 1)).passed).toBe(true);
    const retry = await gate('1.1', 2);
    expect(retry.passed).toBe(false);
    expect(retry.summary).toContain('public output');
    const full = retry.summary.split('Full output: ')[1];
    expect(full).toMatch(/\/\.git\/frugal-public-tests-[a-f0-9-]+\.log$/);
    expect(readFileSync(full, 'utf8')).toBe('public output');
    expect(readFileSync(join(root, 'evidence/opt/public-tests/1.1-attempt-2.log'), 'utf8')).toBe(
      'public output',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('refuses to publish through a replaced Git directory and retains the archived output', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'frugal-task-gate-'));
  try {
    const repo = join(root, 'repo');
    const gitDir = join(repo, '.git');
    const outside = join(root, 'outside');
    mkdirSync(gitDir, { recursive: true });
    mkdirSync(join(root, 'tmp'));
    mkdirSync(outside);
    const gate = createTaskGate(
      root,
      repo,
      join(root, 'evidence'),
      publicTaskConfig(target),
      30,
      async () => {
        rmSync(gitDir, { recursive: true });
        symlinkSync(outside, gitDir);
        return { code: 1, stdout: 'E AssertionError: expected 3', stderr: '' };
      },
    );
    await expect(gate('1.1', 1)).rejects.toThrow(/Unsafe public task log directory/);
    expect(readdirSync(outside)).toEqual([]);
    expect(readFileSync(join(root, 'evidence/opt/public-tests/1.1-attempt-1.log'), 'utf8')).toBe(
      'E AssertionError: expected 3',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it.runIf(process.env.FRUGAL_TEST_IMAGE)(
  'runs only the exact public task and rejects skipped, xfail or empty selections in Docker',
  async () => {
    const parent = realpathSync(process.platform === 'darwin' ? '/tmp' : tmpdir());
    const root = mkdtempSync(join(parent, 'frugal-task-gate-'));
    const archive = mkdtempSync(join(parent, 'frugal-public-evidence-'));
    try {
      const repo = join(root, 'repo');
      mkdirSync(join(repo, 'tests'), { recursive: true });
      mkdirSync(join(repo, '.git'));
      writeFileSync(
        join(repo, 'tests/test_fixture.py'),
        [
          'import pytest',
          '@pytest.mark.task("1.1")',
          'def test_pass():',
          '    assert 1 + 1 == 2',
          '@pytest.mark.task("1.10")',
          'def test_fail():',
          '    assert 1 + 1 == 3',
          '@pytest.mark.task("1.2")',
          '@pytest.mark.skip(reason="fixture")',
          'def test_skip():',
          '    assert False',
          '@pytest.mark.task("1.3")',
          '@pytest.mark.xfail(reason="fixture")',
          'def test_xfail():',
          '    assert False',
          '',
        ].join('\n'),
      );
      const image = await Container.imageID(process.env.FRUGAL_TEST_IMAGE ?? '');
      const c = new Container(root, repo, runnerEnvironment(root), image, 'public-gate-test');
      await c.verifyIsolation(archive);
      const check = createTaskGate(root, repo, archive, publicTaskConfig(target), 30, (args) =>
        c.exec(args),
      );
      for (const task of ['1.1', '1.10', '1.2', '1.3', '1.4']) {
        expect((await check(task, 1)).passed, task).toBe(task === '1.1');
      }
    } finally {
      rmSync(archive, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  },
  120000,
);
