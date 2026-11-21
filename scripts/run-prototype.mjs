import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The public marker fixture is created outside the checkout and scored benchmark.
if (process.argv.length !== 2) {
  console.error('Usage: node scripts/run-prototype.mjs');
  process.exit(2);
}

const root = fileURLToPath(new URL('../', import.meta.url));
const project = mkdtempSync(join(tmpdir(), 'frugal-prototype-'));
const source = join(project, 'source');
const feature = join(project, 'bench/features/example-change');
const repos = join(project, 'bench/repos');
const flags = ['session_per_task', 'capsule', 'checklist_review', 'incremental_review', 'targeted_fix'];
const gitIdentity = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Frugal Prototype',
  GIT_AUTHOR_EMAIL: 'prototype@localhost',
  GIT_COMMITTER_NAME: 'Frugal Prototype',
  GIT_COMMITTER_EMAIL: 'prototype@localhost',
};
function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd,
    env: gitIdentity,
    encoding: 'utf8',
  }).trim();
}

mkdirSync(source);
mkdirSync(feature, { recursive: true });
mkdirSync(repos, { recursive: true });
cpSync(join(root, 'assets'), join(project, 'assets'), { recursive: true });
symlinkSync(join(root, 'node_modules'), join(project, 'node_modules'), 'dir');

git(source, 'init', '-b', 'main');
const fixtureFlags = flags.map((flag) => `  ${flag}: false`).join('\n');
writeFileSync(
  join(source, 'frugal.yaml'),
  `version: 1\nprofile: small\nlanguage: python\nflags:\n${fixtureFlags}\ntest: {command: pytest, report: junit}\n`,
);
git(source, 'add', 'frugal.yaml');
git(source, 'commit', '-m', 'Create the public prototype fixture');
git(source, 'bundle', 'create', join(repos, 'demo.bundle'), 'main');
writeFileSync(join(repos, 'demo.sha'), `${git(source, 'rev-parse', 'HEAD')}\n`);
writeFileSync(join(feature, 'expected.yaml'), 'repo: demo\nrequirements: []\n');
writeFileSync(join(feature, 'requirement.md'), 'Implement the public example markers.\n');

git(project, 'init', '-b', 'main');
git(project, 'commit', '--allow-empty', '-m', 'Initialize the prototype controller');
const cli = join(root, 'packages/cli/bin/frugal.js');
const args = [
  cli,
  'run',
  '--project', project,
  '--mode', 'paired',
  '--feature', 'example-change',
  '--series', 'prototype',
  '--dry-run',
  ...flags.flatMap((flag) => ['--flag', flag]),
];
execFileSync(process.execPath, args, { cwd: root, stdio: ['ignore', 2, 2] });
console.log(join(project, 'bench/runs'));
