import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
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
function fixture() {
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
    'version: 1\nprofile: small\nlanguage: python\nflags: {capsule: true}\ntest: {command: pytest, report: junit}\n',
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
    'paired',
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
      flags: { capsule: true },
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
