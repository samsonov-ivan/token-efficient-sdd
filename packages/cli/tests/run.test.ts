import { mkdtempSync, mkdirSync, cpSync, existsSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { run, type RunManifest } from '../src/run.js';
import { git, readJson, writeJson } from '../src/harness/io.js';
import { flagsFor } from '../src/harness/plan.js';

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
    writeFileSync(join(input, 'requirement.md'), 'Changed');
    await expect(run([...args, '--resume'])).rejects.toThrow('Frozen run inputs changed');
  }, 60000);
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
