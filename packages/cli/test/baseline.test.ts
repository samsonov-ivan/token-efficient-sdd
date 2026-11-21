import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  type BaselineOptions,
  type BaselineRequest,
  executeBaseline,
  hashBaselineAssets,
} from '../src/baseline.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

type Simulate = (request: BaselineRequest, repo: string) => Promise<string | undefined>;

async function fixture(simulate?: Simulate) {
  const root = await mkdtemp(join(tmpdir(), 'frugal-baseline-'));
  roots.push(root);
  const repo = join(root, 'repo');
  const feature = 'set-limit';
  const change = join(repo, 'openspec', 'changes', feature);
  const runDir = join(root, 'run-1');
  const configDir = join(root, 'config');
  const assetsRoot = resolve('assets');
  await mkdir(runDir);
  for (const name of ['openspec-propose', 'openspec-apply-change', 'openspec-verify-change']) {
    const dir = join(repo, '.agents', 'skills', name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'SKILL.md'), `Fixture ${name}`);
  }
  const requests: BaselineRequest[] = [];
  const options: BaselineOptions = {
    repo,
    runDir,
    configDir,
    feature,
    assetsRoot,
    requirement: 'Public brief with literal {{change}}.',
    model: 'fixture/model',
    snapshot: async () => 'a'.repeat(40),
    async invoke(request) {
      requests.push(request);
      if (request.stage === 'spec') {
        await mkdir(join(change, 'specs', 'limits'), { recursive: true });
        await writeFile(join(change, 'proposal.md'), '# Proposal');
        await writeFile(join(change, 'design.md'), '# Design');
        await writeFile(join(change, 'tasks.md'), '- [ ] 1.1 Implement');
        await writeFile(join(change, 'specs', 'limits', 'spec.md'), '## ADDED Requirements');
      }
      if (request.stage === 'apply')
        await writeFile(join(change, 'tasks.md'), '- [x] 1.1 Implement');
      const answer =
        (await simulate?.(request, repo)) ??
        {
          review: 'Reviewed changed limit behavior and checked the boundary test.\nVERDICT: ACCEPT',
          verify: 'Completeness, correctness and coherence checked.\nVERIFY: PASS',
        }[request.stage as 'review' | 'verify'] ??
        'Completed work';
      const sessionID = `ses_${requests.length}`;
      const part = { messageID: `msg_${requests.length}` };
      const stdout = [
        { type: 'tool_use', sessionID, part: { tool: 'read', state: { status: 'completed' } } },
        { type: 'text', sessionID, part: { ...part, text: answer } },
        { type: 'step_finish', sessionID, part: { ...part, reason: 'stop' } },
      ]
        .map((e) => JSON.stringify(e))
        .join('\n');
      return { stdout, stderr: '', code: 0 };
    },
  };
  return { options, requests, repo, runDir };
}

it('dispatches installed stock skills, uses full feedback and fresh same-model sessions', async () => {
  const feedback = 'BLOCKING: Limit is ignored for empty history.\nVERDICT: CHANGES REQUESTED';
  const { options, requests, runDir } = await fixture(async (r) =>
    r.stage === 'review' && r.reviewIter === 1 ? feedback : undefined,
  );
  const result = await executeBaseline(options);
  expect(requests.map((s) => s.stage)).toEqual([
    'spec',
    'apply',
    'review',
    'fix',
    'review',
    'verify',
  ]);
  expect(requests.map((s) => s.args[s.args.indexOf('--model') + 1])).toEqual(
    Array(6).fill('fixture/model'),
  );
  expect(requests.map((s) => s.args.includes('--session'))).toEqual(Array(6).fill(false));
  expect(requests[0].args).toContain('openspec-propose');
  expect(requests[0].args.at(-1)).toContain(options.requirement);
  expect(requests[1].args).toContain('openspec-apply-change');
  expect(requests[2].args).toContain('base-reviewer');
  expect(requests[3].args.at(-1)).toContain(feedback);
  expect(requests.at(-1)?.args).toContain('openspec-verify-change');
  expect(result.reviews.map((r) => r.verdict)).toEqual(['fix', 'pass']);
  expect(result.reviews[1].tree).toEqual('a'.repeat(40));
  expect(result.assetsHash).toEqual(await hashBaselineAssets(options.assetsRoot));
  const files = JSON.parse(
    await readFile(
      join(runDir, 'b0', 'snapshots', `${result.reviews[0].input_snapshot}.json`),
      'utf8',
    ),
  );
  const task = files.find((f: { path: string }) => f.path.endsWith('tasks.md'));
  expect(await readFile(join(runDir, 'b0', 'blobs', task.sha256), 'utf8')).toEqual(
    '- [x] 1.1 Implement',
  );
  expect(await readFile(join(runDir, result.reviews[0].transcript), 'utf8')).toContain(feedback);
  await expect(executeBaseline(options)).rejects.toThrow('EEXIST');
});

it.each(['None', 'None found.', 'No blocking findings.'])(
  'continues to verification after an explicit no-findings review: %s',
  async (sentinel) => {
    const answer = `Checked the limit and boundary tests.\nBLOCKING: ${sentinel}\nVERDICT: ACCEPT`;
    const { options, requests } = await fixture(async ({ stage }) =>
      stage === 'review' ? answer : undefined,
    );
    const result = await executeBaseline(options);
    expect(requests.map((r) => r.stage)).toEqual(['spec', 'apply', 'review', 'verify']);
    expect(result.reviews).toMatchObject([{ verdict: 'pass', summary: answer }]);
  },
);

it.each([
  'VERDICT: ACCEPT',
  'Reviewed tests.\nVERDICT: ACCEPT\nVERDICT: CHANGES REQUESTED',
  'BLOCKING: Broken assertion\nVERDICT: ACCEPT',
  'BLOCKING: None found. Broken assertion still fails.\nVERDICT: ACCEPT',
  'BLOCKING: None found.\u2028Broken assertion still fails.\nVERDICT: ACCEPT',
  'BLOCKING: None found.\nBLOCKING: Broken assertion\nVERDICT: ACCEPT',
  'BLOCKING: None found.\nVERDICT: CHANGES REQUESTED',
  'Everything checked\nVERDICT: CHANGES REQUESTED',
  'I think the code is fine.',
])('rejects ambiguous, unsupported or contradictory review output: %s', async (answer) => {
  const { options, runDir } = await fixture(async ({ stage }) =>
    stage === 'review' ? answer : undefined,
  );
  await expect(executeBaseline(options)).rejects.toThrow();
  expect(JSON.parse(await readFile(join(runDir, 'baseline.json'), 'utf8')).status).toBe('failed');
  expect(await readFile(join(runDir, 'b0/stages/review-1.md'), 'utf8')).toContain(answer);
});

it('runs final verification, preserves every round and rejects open findings at the cap', async () => {
  const { options, requests, runDir } = await fixture(async ({ stage }) =>
    stage === 'review'
      ? 'BLOCKING: Negative amount accepted.\nVERDICT: CHANGES REQUESTED'
      : undefined,
  );
  await expect(executeBaseline(options)).rejects.toThrow(/Five review rounds/);
  expect(requests.filter((r) => r.stage === 'review')).toHaveLength(5);
  expect(requests.at(-1)?.stage).toBe('verify');
  expect(JSON.parse(await readFile(join(runDir, 'b0/quality-review.json'), 'utf8'))).toHaveLength(
    5,
  );
});

it('rejects an explicit verification failure after a clean review', async () => {
  const { options } = await fixture(async ({ stage }) =>
    stage === 'verify' ? 'Missing test.\nVERIFY: FAIL' : undefined,
  );
  await expect(executeBaseline(options)).rejects.toThrow(/Verification failed/);
});

it('rejects review that modifies the evaluated snapshot', async () => {
  const { options } = await fixture(async ({ stage }, repo) => {
    if (stage === 'review') await writeFile(join(repo, 'test-result'), 'adjusted');
    return undefined;
  });
  await expect(executeBaseline(options)).rejects.toThrow(/modified the reviewed snapshot/);
});

it('fails closed for truncated or errored opencode streams and repeated root sessions', async () => {
  for (const fault of ['eof', 'event', 'exit', 'reused-session', 'role-fallback', 'uninspected']) {
    const { options } = await fixture();
    const invoke = options.invoke;
    options.invoke = async (req) => {
      const value = await invoke(req);
      if (fault === 'eof') value.stdout = value.stdout.split('\n')[0];
      if (fault === 'uninspected') value.stdout = value.stdout.split('\n').slice(1).join('\n');
      if (fault === 'event') value.stdout += '\n{"type":"error"}';
      if (fault === 'exit') value.code = 2;
      if (fault === 'reused-session') value.stdout = value.stdout.replaceAll(/ses_\d+/g, 'ses_one');
      if (fault === 'role-fallback')
        value.stderr = 'agent unavailable. Falling back to default agent';
      return value;
    };
    await expect(executeBaseline(options)).rejects.toThrow();
  }
});

it('does not copy symlink targets from outside the checkout', async () => {
  const { options, repo, runDir } = await fixture();
  const outside = join(runDir, 'outside.txt');
  await writeFile(outside, 'only on host');
  await symlink(outside, join(repo, 'outside-link'));
  const { stages } = await executeBaseline(options);
  const snapshot = JSON.parse(
    await readFile(join(runDir, 'b0', 'snapshots', `${stages[0].input.content}.json`), 'utf8'),
  );
  const pointer = snapshot.find((e: { path: string }) => e.path === 'outside-link');
  expect(pointer.mode).toBe('120000');
  expect(await readFile(join(runDir, 'b0/blobs', pointer.sha256), 'utf8')).toBe(outside);
});
