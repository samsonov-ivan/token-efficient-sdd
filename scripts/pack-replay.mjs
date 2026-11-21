import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';

const usage = [
  'Usage: node scripts/pack-replay.mjs --out NEW_DIRECTORY RUN_DIR ...',
  '       node scripts/pack-replay.mjs --out NEW_DIRECTORY --runs RUNS_DIR --run-id ID [--run-id ID ...]',
].join('\n');
const safeId = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const sha256 = /^[a-f0-9]{64}$/;
const rawSource = /^raw\/(?:(?:events|provider|relay)\.jsonl|export\.json|opencode\.db(?:-wal)?|events\/[A-Za-z0-9][A-Za-z0-9._-]*\.jsonl|exports\/[A-Za-z0-9][A-Za-z0-9._-]*\.json)$/;
const finishedStatuses = new Set(['complete', 'failed', 'interrupted']);

function directory(path) {
  if (!lstatSync(path).isDirectory()) throw new Error('Expected a directory without a symlink: ' + path);
  return realpathSync(path);
}

function parseJson(bytes, name) {
  try {
    return JSON.parse(bytes);
  } catch {
    throw new Error('Invalid JSON in ' + name);
  }
}

function fingerprint(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
}

function readArchiveFile(root, name, fingerprints) {
  const path = join(root, name);
  const parent = dirname(path);
  if (directory(parent) !== parent) throw new Error('Symlink in archive path: ' + name);
  const before = lstatSync(path, { bigint: true });
  if (!before.isFile()) throw new Error('Expected a regular archive file: ' + name);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const expected = fingerprint(before);
    if (fingerprint(fstatSync(fd, { bigint: true })) !== expected) throw new Error('Archive changed: ' + name);
    const bytes = readFileSync(fd);
    if (fingerprint(fstatSync(fd, { bigint: true })) !== expected) throw new Error('Archive changed: ' + name);
    fingerprints.set(path, expected);
    return bytes;
  } finally {
    closeSync(fd);
  }
}

function copyRun(root, output, fingerprints) {
  const id = basename(root);
  const manifest = readArchiveFile(root, 'manifest.json', fingerprints);
  const run = parseJson(manifest, id + '/manifest.json');
  if (run?.run_id !== id) throw new Error('Run ID differs from the archive directory name: ' + id);
  if (!finishedStatuses.has(run.status) || !Number.isFinite(Date.parse(run.finished_at))) {
    throw new Error('Archive run has not finished: ' + id);
  }

  const meter = readArchiveFile(root, 'meter.json', fingerprints);
  const summary = parseJson(meter, id + '/meter.json');
  if (summary?.run_id !== id || summary.dry_run !== run.dry_run) throw new Error('Meter and manifest identify different runs: ' + id);
  const rawNames = Object.keys(summary.raw_sha256 ?? {}).sort();
  if (!rawNames.length) throw new Error('Archive has no raw input digests: ' + id);
  if (rawNames.some((name) => !rawSource.test(name))) {
    throw new Error('Archive lists an unsupported raw source: ' + id);
  }
  const files = [
    ['calls.jsonl', summary.sha256?.['calls.jsonl']],
    ['stages.csv', summary.sha256?.['stages.csv']],
    ...rawNames.map((name) => [name, summary.raw_sha256[name]]),
  ];
  for (const [name, digest] of files) {
    if (typeof digest !== 'string' || !sha256.test(digest)) throw new Error('Missing or invalid SHA-256: ' + id + '/' + name);
  }

  const target = join(output, id);
  mkdirSync(target, { mode: 0o700 });
  for (const [name, digest] of files) {
    const bytes = readArchiveFile(root, name, fingerprints);
    if (createHash('sha256').update(bytes).digest('hex') !== digest) throw new Error('SHA-256 differs: ' + id + '/' + name);
    const file = join(target, name);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
  }
  writeFileSync(join(target, 'manifest.json'), manifest, { flag: 'wx', mode: 0o600 });
  writeFileSync(join(target, 'meter.json'), meter, { flag: 'wx', mode: 0o600 });
}

function outputPath(value) {
  const path = resolve(value);
  const parent = realpathSync(dirname(path));
  for (let current = parent; ; current = dirname(current)) {
    if (existsSync(join(current, '.git'))) throw new Error('Choose an output directory outside Git worktrees');
    if (current === dirname(current)) break;
  }
  return join(parent, basename(path));
}

function pack() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean' },
      out: { type: 'string' },
      runs: { type: 'string' },
      'run-id': { type: 'string', multiple: true },
    },
  });
  if (values.help) {
    console.log(usage);
    return;
  }
  const ids = values['run-id'] ?? [];
  const selected = values.runs ? ids.length && !positionals.length : positionals.length && !ids.length;
  if (!values.out || !selected) {
    throw new Error(usage);
  }
  if (ids.some((id) => !safeId.test(id))) throw new Error('Invalid run ID');
  const archive = values.runs && directory(resolve(values.runs));
  const inputs = archive ? ids.map((id) => join(archive, id)) : positionals.map((input) => resolve(input));
  const roots = inputs.map(directory).sort();
  const names = roots.map((root) => basename(root));
  if (names.some((id) => !safeId.test(id))) throw new Error('Invalid run directory name');
  if (new Set(names).size !== names.length) throw new Error('Duplicate run IDs');
  const output = outputPath(values.out);
  if (roots.some((root) => output === root || output.startsWith(root + sep))) {
    throw new Error('Choose an output directory outside the source archives');
  }

  mkdirSync(output, { mode: 0o700 });
  try {
    const fingerprints = new Map();
    for (const root of roots) copyRun(root, output, fingerprints);
    for (const [file, expected] of fingerprints) {
      if (fingerprint(lstatSync(file, { bigint: true })) !== expected) throw new Error('Archive changed during copy: ' + file);
    }
  } catch (error) {
    rmSync(output, { recursive: true, force: true });
    throw error;
  }
  console.log(`Private replay pack: ${output} (${roots.length} runs)`);
}

try {
  pack();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
