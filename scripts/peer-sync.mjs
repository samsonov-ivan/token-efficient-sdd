import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url));
const statusFiles = new Map([
  ['codex/frugal-integration', 'docs/collaboration/owner.md'],
  ['codex/frugal-friend', 'docs/collaboration/friend.md'],
]);

function runGit(args) {
  const result = spawnSync('git', args, {
    cwd: project,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
  });
  if (result.error) throw new Error('Could not run Git. Check that Git is available in this worktree.');
  return result;
}

function git(args, errorMessage) {
  const result = runGit(args);
  if (result.status !== 0) throw new Error(errorMessage);
  return result.stdout.trimEnd();
}

function showStatus() {
  git([
    'fetch', '--prune', '--no-prune-tags', '--no-tags', '--no-recurse-submodules', 'origin',
    '+refs/heads/codex/frugal-*:refs/remotes/origin/codex/frugal-*',
  ], 'Could not fetch origin. Check connectivity and Git credentials.');

  for (const [branch, path] of statusFiles) {
    console.log(`\norigin/${branch}`);
    const remoteRef = `refs/remotes/origin/${branch}`;
    const result = runGit(['rev-parse', '--verify', '--quiet', `${remoteRef}^{commit}`]);
    if (result.status === 1) {
      console.log('Branch is absent on origin.');
      continue;
    }
    if (result.status !== 0) throw new Error(`Could not read origin/${branch}.`);

    const commit = result.stdout.trim();
    console.log(git(['log', '-3', '--format=%h %aI %s', commit], `Could not read history for origin/${branch}.`));
    const pathExists = git(['ls-tree', '--name-only', commit, '--', path], `Could not locate ${path}.`);
    const contents = pathExists
      ? git(['show', `${commit}:${path}`], `Could not read ${path}.`)
      : '(absent)';
    console.log(`\n${path}\n${contents}`);
  }
}

function publish() {
  const ref = git(['symbolic-ref', '--quiet', 'HEAD'], 'Check out a collaboration branch before publishing.');
  const branch = ref.replace(/^refs\/heads\//, '');
  if (!statusFiles.has(branch)) {
    throw new Error('Publish is available only on codex/frugal-integration and codex/frugal-friend.');
  }

  const commit = git(['rev-parse', '--verify', `${ref}^{commit}`], `No commit to publish on ${branch}.`);
  const changes = git(['status', '--porcelain=v1', '--untracked-files=normal', '--ignore-submodules=none'], 'Could not check local changes.');
  if (changes) console.error('Uncommitted changes are present. Only committed changes will be published.');

  const result = runGit([
    '-c', 'remote.origin.mirror=false', 'push', '--porcelain', '--no-follow-tags',
    '--recurse-submodules=no', 'origin', `${commit}:${ref}`,
  ]);
  if (result.status === 0) {
    console.log(`origin/${branch} confirmed at ${commit}.`);
    return;
  }
  if (result.stdout.includes('[rejected] (non-fast-forward)') || result.stdout.includes('[rejected] (fetch first)')) {
    throw new Error(`origin/${branch} has advanced. Run status and reconcile the branch before publishing again.`);
  }
  throw new Error(`Could not publish to origin/${branch}. Check connectivity, Git credentials, and branch permissions.`);
}

try {
  const [command, ...extra] = process.argv.slice(2);
  if (extra.length || (command !== 'status' && command !== 'publish')) {
    throw new Error('Usage: node scripts/peer-sync.mjs status|publish');
  }
  if (command === 'status') showStatus();
  else publish();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
