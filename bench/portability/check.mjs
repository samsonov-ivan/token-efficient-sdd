import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repos = JSON.parse(fs.readFileSync(path.join(here, 'repos.json'), 'utf8'));
const [id, outputDir, localSource] = process.argv.slice(2);
if (!Object.hasOwn(repos, id) || !outputDir) {
  console.error('Usage: node check.mjs <google-uuid|yocto-queue> <new-evidence-dir> [local-source]');
  process.exit(2);
}

const spec = repos[id];
const output = path.resolve(outputDir);
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.mkdirSync(output);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'frugal-portability-'));
const repo = path.join(temp, 'repo');
const log = fs.openSync(path.join(output, 'commands.log'), 'wx');
const env = {
  PATH: process.env.PATH, HOME: temp, TMPDIR: temp, LANG: 'C', GIT_CONFIG_NOSYSTEM: '1',
  npm_config_cache: process.env.npm_config_cache ?? path.join(temp, 'npm-cache'),
  GOTOOLCHAIN: 'local', GOPROXY: 'off', GOCACHE: path.join(temp, 'go-cache'),
  GOPATH: path.join(temp, 'go-path'), NO_COLOR: '1', CI: 'true',
};
const record = { id, ...spec, node: process.version, checks: [], passed: false };
function run(args, cwd = repo) {
  const result = spawnSync(args[0], args.slice(1), { cwd, env, encoding: 'utf8', maxBuffer: 16 << 20 });
  fs.writeSync(log, `$ ${JSON.stringify(args)}\n${result.stdout ?? ''}${result.stderr ?? ''}\n`);
  record.checks.push({ command: args, exit: result.status });
  if (result.status !== 0) throw new Error(`Command failed: ${args[0]} ${args[1]} (${result.error ?? result.status})`);
  return result.stdout.trim();
}
function sha(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
try {
  fs.mkdirSync(repo);
  run(['git', 'init', '-q']);
  run(['git', 'fetch', '--quiet', '--depth=1', localSource ? path.resolve(localSource) : spec.url, spec.commit]);
  run(['git', 'checkout', '--quiet', '--detach', 'FETCH_HEAD']);
  if (run(['git', 'rev-parse', 'HEAD']) !== spec.commit) throw new Error('Unexpected checkout');
  record.licenseSha256 = sha(path.join(repo, spec.licenseFile));
  if (id === 'yocto-queue') {
    const lock = path.join(here, id, 'package-lock.json');
    record.lockSha256 = sha(lock);
    fs.copyFileSync(lock, path.join(repo, 'package-lock.json'));
    record.npm = run(['npm', '--version']);
    run(['npm', 'ci', '--package-lock=true', '--ignore-scripts', '--no-fund', '--no-audit']);
    run(['node', '--input-type=module', '-e', "import Queue from './index.js'; if ('peekLast' in Queue.prototype) process.exit(1);"]);
    fs.unlinkSync(path.join(repo, 'package-lock.json'));
  } else {
    record.go = run(['go', 'version']);
    const api = run(['go', 'doc', '-short', '.']);
    if (/^\s*func ParseCanonical\(/m.test(api)) throw new Error('Proposed API already present');
  }
  const testOutput = run(spec.test);
  if (id === 'google-uuid') {
    const events = testOutput.split(/\r?\n/).map((line) => JSON.parse(line));
    const tests = events.filter((event) => event.Test && ['pass', 'skip', 'fail'].includes(event.Action));
    record.tests = Object.fromEntries(['pass', 'skip', 'fail'].map((state) => [state, tests.filter((test) => test.Action === state).length]));
    if (!record.tests.pass || record.tests.skip || record.tests.fail) throw new Error('Incomplete Go regression suite');
  }
  if (run(['git', 'status', '--porcelain=v1']) !== '') throw new Error('Checkout changed during checks');
  record.passed = true;
} catch (error) {
  record.error = error.message;
  process.exitCode = 1;
} finally {
  fs.closeSync(log);
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(record, null, 2) + '\n');
  fs.rmSync(temp, { recursive: true, force: true });
  console.log(`${id} ${record.passed ? 'PASS' : 'FAIL'} — ${output}`);
}
