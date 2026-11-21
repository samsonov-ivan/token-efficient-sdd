import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { type BaselineRequest, hashBaselineAssets } from '../src/baseline.js';
import { readJson } from '../src/harness/io.js';
import { executeLiveOptimized, validateLiveOptFlags } from '../src/harness/live-opt.js';

const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(
  flags: Record<string, boolean>,
  behavior: { broken?: boolean; reusedSession?: boolean; prechecked?: boolean } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'frugal-live-opt-'));
  roots.push(root);
  const repo = join(root, 'repo');
  const runDir = join(root, 'evidence');
  const feature = 'document-labels';
  const change = join(repo, 'openspec/changes', feature);
  mkdirSync(runDir);
  mkdirSync(repo);
  function git(...args: string[]) {
    return execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    }).trim();
  }
  git('init', '-q');
  const snapshot = async () => {
    git('add', '-A');
    return git('write-tree');
  };
  for (const skill of ['openspec-propose', 'openspec-apply-change', 'openspec-verify-change']) {
    const dir = join(repo, '.agents/skills', skill);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), `Fixture ${skill}`);
  }
  writeFileSync(
    join(repo, 'frugal.yaml'),
    'version: 1\nflags: {capsule: false}\ntest: {command: node --test, report: tap}\n',
  );
  writeFileSync(
    join(repo, 'public.test.mjs'),
    `
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
for (const id of ['1.1','1.2']) test('task-'+id, () => assert.equal(readFileSync(id+'.txt','utf8'),id));
`,
  );
  const tasks = [
    '- [ ] 1.1 Write first label REQ-LABEL-01 SCN-LABEL-01.1.',
    '- [ ] 1.2 Write second label REQ-LABEL-02 SCN-LABEL-02.1.',
  ].join('\n');
  const requests: BaselineRequest[] = [];
  const options: Parameters<typeof executeLiveOptimized>[0] = {
    repo,
    runDir,
    feature,
    configDir: join(root, 'config'),
    assetsRoot: resolve('assets'),
    model: 'local/test',
    requirement: 'Persist both public labels.',
    flags,
    maxRetries: 1,
    snapshot,
    taskInstructions: (id) => `Write a public test for task-${id}.`,
    async checkTask(id) {
      const result = spawnSync(
        process.execPath,
        ['--test', `--test-name-pattern=^task-${id.replace('.', '\\.')}$`, 'public.test.mjs'],
        { cwd: repo, encoding: 'utf8' },
      );
      return {
        passed: result.status === 0,
        summary: `Task ${id} test exited with ${result.status}.`,
      };
    },
    async invoke(request) {
      requests.push(request);
      let answer = 'Completed operation.';
      if (request.stage === 'spec') {
        mkdirSync(join(change, 'specs/labels'), { recursive: true });
        writeFileSync(join(change, 'proposal.md'), 'Persist two labels.');
        writeFileSync(join(change, 'design.md'), 'Store each public label in a plain file.');
        writeFileSync(
          join(change, 'tasks.md'),
          behavior.prechecked ? tasks.replace('[ ]', '[x]') : tasks,
        );
        writeFileSync(
          join(change, 'specs/labels/spec.md'),
          '## ADDED Requirements\n\n' +
            [1, 2]
              .map(
                (i) =>
                  `### Requirement: REQ-LABEL-0${i} Label ${i}\nThe fixture SHALL record label ${i}.\n\n#### Scenario: SCN-LABEL-0${i}.1 Record\n- **WHEN** recorded\n- **THEN** the label exists\n`,
              )
              .join('\n'),
        );
      }
      if (request.stage === 'apply') {
        const id = request.task;
        if (!id) throw new Error('Missing task in apply invocation');
        const good = !behavior.broken && (id !== '1.1' || request.attempt === 2);
        writeFileSync(join(repo, `${id}.txt`), good ? id : 'wrong');
        answer = `Task ${id} attempt ${request.attempt}.\nWrote ${id}.txt.\nCheck public label behavior.`;
      }
      if (request.stage === 'review')
        answer =
          request.reviewIter === 1
            ? 'BLOCKING: Missing external label description.\nVERDICT: CHANGES REQUESTED'
            : 'Verified the descriptions.\nVERDICT: ACCEPT';
      if (request.stage === 'fix')
        writeFileSync(join(repo, 'labels.md'), 'Public label descriptions.');
      if (request.stage === 'verify')
        answer = 'Checked both labels and the documentation.\nVERIFY: PASS';
      const continued = request.args.indexOf('--session');
      const sessionID =
        behavior.reusedSession && request.stage === 'review'
          ? 'session-1'
          : continued >= 0
            ? request.args[continued + 1]
            : `session-${requests.length}`;
      const messageID = `message-${requests.length}`;
      const events = [
        { type: 'tool_use', sessionID, part: { tool: 'read', state: { status: 'completed' } } },
        { type: 'text', sessionID, part: { messageID, text: answer } },
        { type: 'step_finish', sessionID, part: { messageID, reason: 'stop' } },
      ];
      return { stdout: events.map((e) => JSON.stringify(e)).join('\n'), stderr: '', code: 0 };
    },
  };
  return { options, requests, change };
}

it.each([
  { session_per_task: true, capsule: false },
  { session_per_task: false, capsule: true },
  { session_per_task: true, capsule: true },
])(
  'preserves native stages, real task tests, reviews and snapshot-bound evidence with %o',
  async (flags) => {
    const { options, requests, change } = fixture(flags);
    const result = await executeLiveOptimized(options);
    const stages = requests.map((r) => r.stage);
    expect(stages).toEqual([
      'spec',
      'apply',
      'apply',
      'apply',
      'review',
      'fix',
      'review',
      'verify',
    ]);
    const [spec, first, retry, second, review, fix, , verify] = requests;
    expect(spec.args).toContain('openspec-propose');
    expect(verify.args).toContain('openspec-verify-change');
    expect(review.args).toContain('base-reviewer');
    expect(fix.args.at(-1)).toContain('Missing external label description.');
    for (const req of requests)
      expect(req.args[req.args.indexOf('--model') + 1]).toBe(options.model);
    expect(first.args).toContain('build');
    expect(first.args).not.toContain('--session');
    const session = result.stages[1].session_id;
    expect(retry.args[retry.args.indexOf('--session') + 1]).toBe(session);
    expect(retry.args.at(-1)).toContain('test exited with 1');
    expect(second.args.includes('--session')).toBe(!flags.session_per_task);
    if (second.args.includes('--session'))
      expect(second.args[second.args.indexOf('--session') + 1]).toBe(session);
    expect(second.args.at(-1)).toContain('Write a public test for task-1.2.');
    expect(first.args.at(-1)?.includes('The fixture SHALL record label 1.')).toBe(flags.capsule);
    if (flags.capsule) expect(first.args.at(-1)).not.toContain('The fixture SHALL record label 2.');
    expect(existsSync(join(change, 'handoff.md'))).toBe(flags.session_per_task);
    if (flags.session_per_task) {
      expect(second.args.at(-1)).toContain('Task 1.1 attempt 2.');
      expect(second.args.at(-1)).not.toContain('Task 1.1 attempt 1.');
    }
    const archive = join(options.runDir, 'opt');
    expect(readJson(join(archive, 'task-gates/1.1-attempt-1.json'))).toMatchObject({
      passed: false,
    });
    expect(readJson(join(archive, 'task-gates/1.1-attempt-2.json'))).toMatchObject({
      passed: true,
    });
    expect(readFileSync(join(archive, 'stages/apply-1.1-attempt-2.input.md'), 'utf8')).toBe(
      retry.args.at(-1),
    );
    expect(readJson(join(archive, 'quality-review.json'))).toEqual(result.reviews);
    expect(result.reviews.map((r) => r.verdict)).toEqual(['fix', 'pass']);
    expect(result.reviews.at(-1)?.tree).toBe(await options.snapshot?.());
    expect(result.reviews[0].tree).not.toBe(result.reviews[1].tree);
    const sha = result.reviews.at(-1)?.input_snapshot;
    expect(existsSync(join(archive, 'snapshots', `${sha}.json`))).toBe(true);
    expect(readJson(join(options.runDir, 'optimized.json'))).toMatchObject({
      protocol: 'task-apply',
      status: 'completed',
      flags,
      assets_hash: await hashBaselineAssets(options.assetsRoot),
    });
    expect(existsSync(join(options.runDir, 'b0'))).toBe(false);
    expect(existsSync(join(options.runDir, 'baseline.json'))).toBe(false);
  },
);

it('stops a failed task after its retry budget without publishing approval', async () => {
  const { options, requests, change } = fixture({ session_per_task: true }, { broken: true });
  await expect(executeLiveOptimized(options)).rejects.toThrow(/failed its gate after 2 attempt/);
  expect(requests.map((r) => r.stage)).toEqual(['spec', 'apply', 'apply']);
  expect(readFileSync(join(change, 'tasks.md'), 'utf8')).not.toContain('[x]');
  expect(readJson(join(options.runDir, 'opt/quality-review.json'))).toEqual([]);
  expect(readJson(join(options.runDir, 'optimized.json'))).toMatchObject({ status: 'failed' });
});

it('rejects unchecked task ownership and leaked review sessions', async () => {
  const early = fixture({ session_per_task: true }, { prechecked: true });
  await expect(executeLiveOptimized(early.options)).rejects.toThrow(/already contains completed/);
  expect(early.requests.map((r) => r.stage)).toEqual(['spec']);
  const reused = fixture({ session_per_task: true }, { reusedSession: true });
  await expect(executeLiveOptimized(reused.options)).rejects.toThrow(/Root session reused/);
});

it.each([{}, { capsule: 'auto' }, { capsule: true, incremental_review: true }])(
  'rejects unsupported live configurations %o',
  (flags) => {
    expect(() => validateLiveOptFlags(flags)).toThrow();
  },
);
