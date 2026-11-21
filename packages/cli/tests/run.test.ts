import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { git, readJson, writeJson } from '../src/harness/io.js';
import { flagsFor, parsePlan } from '../src/harness/plan.js';
import { Container } from '../src/harness/runner.js';
import { type RunManifest, run } from '../src/run.js';

const identity = {
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@localhost',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@localhost',
};
function fixture(flags = '{capsule: false}', mode = 'paired') {
  const project = mkdtempSync(join(tmpdir(), 'frugal-harness-test-'));
  const source = join(project, 'source');
  const out = join(project, 'bench/runs');
  const repo = 'demo',
    feature = 'example-change';
  const input = join(project, 'bench/features', feature);
  const repos = join(project, 'bench/repos');
  mkdirSync(source);
  mkdirSync(input, { recursive: true });
  mkdirSync(repos, { recursive: true });
  git(source, ['init', '-b', 'main']);
  writeFileSync(
    join(source, 'frugal.yaml'),
    `version: 1\nprofile: small\nlanguage: python\nflags: ${flags}\ntest: {command: pytest, report: junit}\n`,
  );
  git(source, ['add', '.']);
  git(source, ['commit', '-m', 'Base'], identity);
  const pin = git(source, ['rev-parse', 'HEAD']);
  git(source, ['bundle', 'create', join(repos, `${repo}.bundle`), 'main']);
  writeFileSync(join(repos, `${repo}.sha`), `${pin}\n`);
  writeFileSync(join(input, 'expected.yaml'), 'repo: demo\nrequirements: []\n');
  writeFileSync(join(input, 'requirement.md'), 'Implement the public example marker.\n');
  cpSync(resolve('assets'), join(project, 'assets'), { recursive: true });
  symlinkSync(resolve('node_modules'), join(project, 'node_modules'));
  git(project, ['init', '-b', 'main']);
  git(project, ['commit', '--allow-empty', '-m', 'Controller'], identity);
  const args = [
    '--project',
    project,
    '--series',
    'test',
    '--feature',
    feature,
    '--mode',
    mode,
    '--dry-run',
  ];
  return { project, out, args, input };
}

const budget = {
  runs: 3,
  mode: 'baseline',
  feature: 'example-change',
  model: 'example/large',
  estimated_cost_per_arm: 10,
  maximum_cost: 40,
  quota_available: 40,
};

describe('isolated run lifecycle', () => {
  it('replays A/B for a requested Go model without subscription billing and resumes completed slots', async () => {
    const { out, args, input } = fixture();
    const requestedModel = 'opencode-go/deepseek-v4.1-flash';
    args.push('--model', requestedModel);
    expect(await run(args)).toBe(0);
    const a = join(out, 'test-1-base-a1'),
      b = join(out, 'test-1-opt-a1');
    const ma = readJson<RunManifest>(join(a, 'manifest.json')),
      mb = readJson<RunManifest>(join(b, 'manifest.json'));
    expect(ma).toMatchObject({
      branch: 'base',
      mode: 'baseline',
      dry_run: true,
      status: 'complete',
      accepted: false,
      flags: { capsule: false },
    });
    expect(mb).toMatchObject({
      branch: 'opt',
      pair_id: ma.pair_id,
      baseline_hash: ma.baseline_hash,
      flags: { capsule: false },
    });
    expect(ma.isolation.root).not.toBe(mb.isolation.root);
    for (const manifest of [ma, mb]) {
      const { root } = manifest.isolation;
      if (!root) throw new Error('Missing isolated performer root');
      expect(dirname(root)).toBe(realpathSync(tmpdir()));
      expect(basename(root)).toMatch(/^frugal-arm-[0-9a-f]{10}$/);
      expect(statSync(root).mode & 0o777).toBe(0o700);
    }
    writeFileSync(join(ma.isolation.root, 'repo', 'only-in-first'), 'private');
    expect(existsSync(join(mb.isolation.root, 'repo', 'only-in-first'))).toBe(false);
    expect(existsSync(join(mb.isolation.root, 'repo', 'hidden_tests'))).toBe(false);
    expect(new Set([...ma.stages, ...mb.stages].map((s) => s.session_id)).size).toBe(
      ma.stages.length + mb.stages.length,
    );
    for (const dir of [a, b]) {
      const meter = readJson<{ known_rpt: number; complete: boolean }>(join(dir, 'meter.json'));
      expect(meter.complete).toBe(true);
      const manifest = readJson<RunManifest>(join(dir, 'manifest.json'));
      expect(manifest).toMatchObject({
        model: 'mock/replay',
        requested_model: requestedModel,
        metering: { relay_required: false },
      });
      expect(manifest.metering.allowed_billing_sources).toBeUndefined();
      expect(manifest.metering.max_balance_charge).toBeUndefined();
      expect(manifest.stages.map((s) => s.stage)).toEqual(['spec', 'apply', 'review', 'verify']);
      expect(existsSync(join(dir, 'final.bundle'))).toBe(true);
    }
    expect(await run([...args, '--resume'])).toBe(0);
    expect(existsSync(join(out, 'test-1-base-a2'))).toBe(false);
    await expect(run([...args, '--variant', 'max', '--resume'])).rejects.toThrow(
      'Frozen run inputs changed',
    );
    writeFileSync(join(input, 'requirement.md'), 'Changed');
    await expect(run([...args, '--resume'])).rejects.toThrow('Frozen run inputs changed');
  }, 60000);
  it.each(['paired', 'ablation'] as const)(
    'executes the capsule and review flags in a %s replay',
    async (mode) => {
      const flags = ['capsule', 'checklist_review', 'incremental_review', 'targeted_fix'];
      const { out, args } = fixture(`{${flags.map((flag) => `${flag}: false`).join(', ')}}`, mode);
      expect(await run([...args, ...flags.flatMap((flag) => ['--flag', flag])])).toBe(0);
      const branch = mode === 'paired' ? 'opt' : `ablation-${flags.join('-')}`;
      const dir = join(out, `test-1-${branch}-a1`);
      const manifest = readJson<RunManifest>(join(dir, 'manifest.json'));
      expect(manifest).toMatchObject({
        dry_run: true,
        model: 'mock/replay',
        flags: Object.fromEntries(flags.map((flag) => [flag, true])),
        status: 'complete',
        pipeline_complete: true,
        accepted: false,
        gates: { evaluated: false },
        hidden: { evaluated: false },
      });
      expect(manifest.stages.map(({ stage }) => stage)).toEqual([
        'spec',
        'apply',
        'apply',
        'review',
        'fix',
        'review',
        'review',
        'verify',
      ]);
      expect(manifest.stages.filter(({ task }) => task).map(({ task }) => task)).toEqual([
        '1.1',
        '1.2',
      ]);
      expect(new Set(manifest.stages.map(({ session_id }) => session_id)).size).toBe(7);
      if (mode === 'paired') {
        const base = join(out, 'test-1-base-a1');
        expect(readJson<RunManifest>(join(base, 'manifest.json'))).toMatchObject({
          flags: Object.fromEntries(flags.map((flag) => [flag, false])),
        });
        expect(existsSync(join(base, 'opt'))).toBe(false);
        expect(existsSync(join(base, 'baseline.json'))).toBe(true);
      }

      const opt = join(dir, 'opt');
      const capsule = readFileSync(join(opt, 'inputs/apply-1.1.txt'), 'utf8');
      expect(capsule).toContain('The replay fixture SHALL persist `replay-marker.txt`.');
      expect(capsule).toContain('SCN-REPLAY-01.1');
      expect(capsule).not.toContain('REQ-REPLAY-02');
      expect(existsSync(join(opt, 'inputs/apply-1.2.txt'))).toBe(true);
      const review = join(opt, 'review');
      const rounds = readJson<{ tree: string }[]>(join(review, 'rounds.json'));
      expect(rounds).toMatchObject([
        { scope: 'full', final: false, verdict: 'changes_requested' },
        { scope: 'delta', final: false, verdict: 'approved', previousTree: rounds[0].tree },
        { scope: 'full', final: true, verdict: 'approved', tree: rounds[1].tree },
      ]);
      expect(rounds[0].tree).not.toBe(rounds[1].tree);
      const delta = readFileSync(join(review, 'round-2/delta.patch'), 'utf8');
      expect(delta).toContain('+synthetic lifecycle fixture');
      expect(delta).not.toContain('replay-sidecar.txt');
      expect(readFileSync(join(review, 'round-3/full.patch'), 'utf8')).toContain(
        'replay-sidecar.txt',
      );
      expect(readJson(join(review, 'round-2/findings.json'))).toMatchObject({
        findings: [{ id: 'F-REPLAY-01', status: 'resolved' }],
      });
      expect(readJson(join(opt, 'verify.json'))).toEqual({ tree: rounds[2].tree, passed: true });
      const {
        final_commit,
        isolation: { root },
      } = manifest;
      if (!root || !final_commit) throw new Error('Missing final fixture snapshot');
      const performer = join(root, 'repo');
      expect(git(performer, ['rev-parse', 'HEAD^{tree}'])).not.toBe(rounds[2].tree);
      expect(git(performer, ['rev-parse', `${final_commit}^{tree}`])).toBe(rounds[2].tree);
      expect(readJson(join(dir, 'meter.json'))).toMatchObject({
        complete: true,
        call_count: manifest.stages.length,
        known_rpt: 16 * manifest.stages.length,
      });
      const calls = readFileSync(join(dir, 'calls.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(calls.filter(({ stage }) => stage === 'apply').map(({ task }) => task)).toEqual([
        '1.1',
        '1.2',
      ]);
    },
    60000,
  );
  it.each([
    { h01: false, h02: false, mode: 'optimized' },
    { h01: true, h02: false, mode: 'ablation' },
    { h01: false, h02: true, mode: 'ablation' },
    { h01: true, h02: true, mode: 'paired' },
  ])(
    'replays session_per_task=$h01 and capsule=$h02 independently ($mode)',
    async ({ h01, h02, mode }) => {
      const selected = [...(h02 ? ['capsule'] : []), ...(h01 ? ['session_per_task'] : [])];
      const { project, out, args } = fixture('{session_per_task: false, capsule: false}', mode);
      const branch = mode === 'ablation' ? `ablation-${selected.join('-')}` : 'opt';
      const dir = join(out, `test-1-${branch}-a1`);
      const base = join(out, 'test-1-base-a1');
      onTestFinished(() => {
        for (const arm of [dir, base]) {
          if (!existsSync(join(arm, 'manifest.json'))) continue;
          const root = readJson<RunManifest>(join(arm, 'manifest.json')).isolation.root;
          if (root) rmSync(root, { recursive: true, force: true });
        }
        rmSync(project, { recursive: true, force: true });
      });

      // Equal timestamps are legal. Shared-session task attribution must survive a clock collision.
      if (h02 && !h01) vi.useFakeTimers({ toFake: ['Date'] });
      try {
        if (h02 && !h01) vi.setSystemTime(new Date('2026-11-22T00:00:00Z'));
        expect(await run([...args, ...selected.flatMap((flag) => ['--flag', flag])])).toBe(0);
      } finally {
        if (h02 && !h01) vi.useRealTimers();
      }
      const manifest = readJson<RunManifest>(join(dir, 'manifest.json'));
      expect(manifest).toMatchObject({
        flags: { session_per_task: h01, capsule: h02 },
        model: 'mock/replay',
        dry_run: true,
        status: 'complete',
        pipeline_complete: true,
        accepted: false,
      });
      const split = h01 || h02;
      expect(manifest.stages.map(({ stage }) => stage)).toEqual(
        split
          ? ['spec', 'apply', 'apply', 'review', 'verify']
          : ['spec', 'apply', 'review', 'verify'],
      );
      expect(readJson(join(dir, 'meter.json'))).toMatchObject({
        complete: true,
        call_count: split ? 5 : 4,
        known_rpt: 16 * (split ? 5 : 4),
      });
      if (mode === 'paired') {
        const baseline = readJson<RunManifest>(join(base, 'manifest.json'));
        expect(baseline).toMatchObject({
          flags: { session_per_task: false, capsule: false },
          pair_id: manifest.pair_id,
          baseline_hash: manifest.baseline_hash,
          model: manifest.model,
          status: 'complete',
        });
        expect(baseline.stages.map(({ stage }) => stage)).toEqual([
          'spec',
          'apply',
          'review',
          'verify',
        ]);
        expect(readJson(join(base, 'baseline.json'))).toMatchObject({
          protocol: 'B0',
          status: 'completed',
        });
        expect(existsSync(join(base, 'opt'))).toBe(false);
      }
      const change = 'openspec/changes/example-change';
      if (!manifest.isolation.root || !manifest.final_commit)
        throw new Error('Missing final snapshot');
      const repo = join(manifest.isolation.root, 'repo');
      const tasks = git(repo, ['show', `${manifest.final_commit}:${change}/tasks.md`]);
      expect(tasks).toContain('[x] 1.1');
      expect(tasks).toContain('[x] 1.2');
      for (const marker of ['replay-marker.txt', 'replay-sidecar.txt']) {
        expect(git(repo, ['show', `${manifest.final_commit}:${marker}`])).toBe(
          'synthetic lifecycle fixture',
        );
      }
      expect(existsSync(join(repo, change, 'handoff.md'))).toBe(h01);
      expect(readJson(join(dir, 'opt/verify.json'))).toEqual({
        tree: git(repo, ['rev-parse', `${manifest.final_commit}^{tree}`]),
        passed: true,
      });
      if (!split) {
        expect(manifest.stages.find(({ stage }) => stage === 'apply')?.task).toBeUndefined();
        expect(existsSync(join(dir, 'opt/inputs/apply-0.txt'))).toBe(true);
        expect(existsSync(join(dir, 'opt/inputs/apply-1.1.txt'))).toBe(false);
        return;
      }
      const inputs = ['1.1', '1.2'].map((id) =>
        readFileSync(join(dir, `opt/inputs/apply-${id}.txt`), 'utf8'),
      );
      if (h02) {
        expect(inputs[0]).toContain('The replay fixture SHALL persist `replay-marker.txt`.');
        expect(inputs[0]).not.toContain('REQ-REPLAY-02');
        expect(inputs[1]).toContain('The replay fixture SHALL persist `replay-sidecar.txt`.');
      } else {
        for (const [i, prompt] of inputs.entries()) {
          expect(prompt).toContain(`1.${i + 1}`);
          expect(prompt).toContain(`${change}/`);
          expect(prompt).not.toContain('## Requirements and scenarios');
        }
      }
      if (h01) {
        const handoff = git(repo, ['show', `${manifest.final_commit}:${change}/handoff.md`]);
        const first = handoff
          .match(/^## TASK-1\.1\s*\n([\s\S]+?)(?=^## TASK-1\.2\s*$)/m)?.[1]
          .trim();
        if (!first) throw new Error('Missing handoff for completed task 1.1 before task 1.2');
        expect(first).toContain('replay-marker.txt');
        expect(inputs[0]).not.toContain(first);
        expect(inputs[1]).toContain(first);
      }

      type Event = { type: string; sessionID: string; part: { id: string; messageID: string } };
      type Call = {
        event_key: string;
        stage: string;
        task: string;
        message_id: string;
        session_id: string;
      };
      const apply = manifest.stages.filter(({ stage }) => stage === 'apply');
      expect(apply.map(({ task }) => task)).toEqual(['1.1', '1.2']);
      const finishes = apply.map(({ task }) => {
        const events: Event[] = readFileSync(join(dir, `raw/stages/apply-${task}.stdout`), 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        const finish = events.filter((event) => event.type === 'step_finish');
        expect(finish).toHaveLength(1);
        return finish[0];
      });
      expect(finishes.map((event) => event.sessionID)).toEqual(apply.map((row) => row.session_id));
      expect(new Set(finishes.map((event) => event.sessionID)).size).toBe(h01 ? 2 : 1);
      expect(new Set(finishes.map((event) => event.part.messageID)).size).toBe(2);
      expect(new Set(finishes.map((event) => event.part.id)).size).toBe(2);
      const calls: Call[] = readFileSync(join(dir, 'calls.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      for (const [i, event] of finishes.entries()) {
        expect(calls.filter((row) => row.event_key === event.part.id)).toEqual([
          expect.objectContaining({
            stage: 'apply',
            task: apply[i].task,
            message_id: event.part.messageID,
            session_id: event.sessionID,
          }),
        ]);
        const exported = readJson<{
          messages: { info: { id: string }; parts: { id: string }[] }[];
        }>(join(dir, 'raw/exports', `${event.sessionID}.json`));
        const message = exported.messages.find((row) => row.info.id === event.part.messageID);
        expect(message?.parts.map((part) => part.id)).toContain(event.part.id);
      }
    },
    60000,
  );
  it('selects an E0 budget plan independently of its experiment ID and binds it on resume', async () => {
    const { project, out } = fixture();
    const plans = join(project, 'bench/plans');
    writeJson(join(plans, 'E0.json'), { ...budget, model: 'example/medium' });
    writeJson(join(plans, 'E0-large.json'), budget);
    writeJson(join(plans, 'E0-large-copy.json'), budget);
    const args = ['--project', project, '--experiment', 'E0', '--dry-run'];
    expect(parsePlan(args)).toMatchObject({
      calibration: true,
      requested: 'example/medium',
      runs: 3,
    });
    expect(() => parsePlan([...args, '--budget-plan', '../E0'])).toThrow('Invalid budget plan');
    expect(() => parsePlan(['--project', project, '--budget-plan', 'E0-large'])).toThrow(
      '--budget-plan requires --experiment',
    );

    const series = [...args, '--runs', '1', '--series', 'test'];
    const large = [...series, '--budget-plan', 'E0-large'];
    expect(await run(large)).toBe(0);
    expect(readJson<RunManifest>(join(out, 'test-1-base-a1/manifest.json'))).toMatchObject({
      experiment: 'E0',
      requested_model: 'example/large',
      status: 'complete',
    });
    expect(await run([...large, '--resume'])).toBe(0);
    await expect(run([...series, '--budget-plan', 'E0-large-copy', '--resume'])).rejects.toThrow(
      'Frozen run inputs changed',
    );
  }, 60000);
  it('checks the registered configuration and quota for a selected live budget plan', () => {
    const { project } = fixture();
    git(project, ['add', 'assets', 'bench/features', 'bench/repos']);
    git(project, ['commit', '-m', 'Benchmark inputs'], identity);
    const plan = join(project, 'bench/plans/E0-large.json');
    writeJson(plan, budget);
    const args = ['--project', project, '--experiment', 'E0', '--budget-plan', 'E0-large'];
    expect(() => parsePlan(args)).toThrow('Missing frozen hidden oracle');
    expect(() => parsePlan([...args, '--model', 'example/medium'])).toThrow(
      'matching registered experiment',
    );
    writeJson(plan, { ...budget, quota_available: 38 });
    expect(() => parsePlan(args)).toThrow('matching registered experiment');
  });
  it('uses a short canonical parent for macOS Docker arms and still probes isolation', async () => {
    const { project, out, args, input } = fixture();
    const temp = mkdtempSync(join(realpathSync(tmpdir()), 'frugal-long-performer-path-'));
    const image = vi.spyOn(Container, 'imageID').mockResolvedValue(`sha256:${'0'.repeat(64)}`);
    const verify = vi
      .spyOn(Container.prototype, 'verifyIsolation')
      .mockRejectedValue(new Error('Stop at isolation probe'));
    const stop = vi.spyOn(Container.prototype, 'stop').mockResolvedValue(undefined);
    vi.stubEnv('TMPDIR', temp);
    let root: string | null = null;
    try {
      expect(await run([...args, '--image', 'frugal-test'])).toBe(1);
      const manifest = readJson<RunManifest>(join(out, 'test-1-base-a1/manifest.json'));
      root = manifest.isolation.root;
      if (!root) throw new Error('Missing isolated performer root');
      const expectedParent = process.platform === 'darwin' ? realpathSync('/tmp') : temp;
      expect(dirname(root)).toBe(expectedParent);
      expect(statSync(root).mode & 0o777).toBe(0o700);
      expect(verify).toHaveBeenCalledWith(resolve(project), out, join(input, 'hidden_tests'));
    } finally {
      vi.unstubAllEnvs();
      image.mockRestore();
      verify.mockRestore();
      stop.mockRestore();
      if (root) rmSync(root, { recursive: true, force: true });
      rmSync(temp, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  });
  it('keeps the interrupted attempt and its usage, allocates a new ID and preserves the completed arm', async () => {
    const { out, args } = fixture();
    expect(await run(args)).toBe(0);
    const dir = join(out, 'test-1-base-a1');
    const manifest = readJson<RunManifest>(join(dir, 'manifest.json'));
    manifest.status = 'running';
    manifest.finished_at = null;
    writeJson(join(dir, 'manifest.json'), manifest);
    await expect(run([...args, '--resume'])).rejects.toThrow('active');
    const owner = readJson<{ host: string; pid: number }>(join(dir, 'owner.json'));
    owner.pid = 2147483647;
    writeJson(join(dir, 'owner.json'), owner);
    expect(await run([...args, '--resume'])).toBe(0);
    expect(readJson<RunManifest>(join(dir, 'manifest.json')).status).toBe('interrupted');
    expect(
      readJson<{ known_rpt: number; complete: boolean }>(join(dir, 'meter.json')).known_rpt,
    ).toBeGreaterThan(0);
    expect(readJson<RunManifest>(join(out, 'test-1-base-a2/manifest.json')).prior_run_id).toBe(
      manifest.run_id,
    );
    expect(existsSync(join(out, 'test-1-opt-a2'))).toBe(false);
  }, 60000);
  it('forces B0 flags off and rejects unknown ablations', () => {
    expect(flagsFor('baseline', { capsule: true }, [])).toEqual({ capsule: false });
    expect(flagsFor('ablation', { capsule: true, repomap: true }, ['capsule'])).toEqual({
      capsule: true,
      repomap: false,
    });
    expect(() => flagsFor('ablation', { capsule: true }, ['wrong'])).toThrow('Unknown');
  });
  it('refuses to certify a synthetic run through offline evaluation', async () => {
    const { out, args } = fixture();
    expect(await run(args)).toBe(0);
    await expect(run(['--evaluate-only', join(out, 'test-1-base-a1')])).rejects.toThrow(
      'finished real model pipeline',
    );
  }, 60000);
});
