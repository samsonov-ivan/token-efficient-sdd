// Re-import the archived sources into a separate directory, without a provider or access to the performer.
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import Ajv from 'ajv';
import { meterRun } from '../packages/cli/dist/meter.js';

const project = fileURLToPath(new URL('../', import.meta.url));
const ajv = new Ajv({ strict: true, allowUnionTypes: true });
function schema(name) {
  return ajv.compile(JSON.parse(readFileSync(join(project, 'schemas', name + '.schema.json'), 'utf8')));
}
const validateManifest = schema('manifest');
const validateCall = schema('call');
function check(validate, value) {
  if (!validate(value)) throw new Error(ajv.errorsText(validate.errors));
}
function archiveDigest(directory, name) {
  return createHash('sha256').update(readFileSync(join(directory, name))).digest('hex');
}

async function verify(directory) {
  const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
  if (manifest.run_id !== basename(directory)) throw new Error('run ID differs from the archive directory name');
  if (manifest.kind !== 'meter-smoke') check(validateManifest, manifest);
  const tmp = mkdtempSync(join(tmpdir(), 'frugal-replay-'));
  try {
    const result = await meterRun(directory, tmp);
    const saved = JSON.parse(readFileSync(join(directory, 'meter.json'), 'utf8'));
    // The earliest archived V1 controls predate raw-input fingerprints.
    // Their normalized ledger and every stored summary field must still match exactly.
    const { raw_sha256, ...withoutInputDigests } = result;
    const hasRawDigests = Object.hasOwn(saved, 'raw_sha256');
    const reconstructed = {...raw_sha256};
    // sqlite may materialize an empty checkpoint file when the archive is opened.
    const wal = 'raw/opencode.db-wal';
    if (!Object.hasOwn(saved.raw_sha256 ?? {}, wal) && reconstructed[wal] === createHash('sha256').digest('hex')) {
      delete reconstructed[wal];
    }
    const comparison = hasRawDigests ? {...result, raw_sha256: reconstructed} : withoutInputDigests;
    if (!isDeepStrictEqual(comparison, saved)) {
      throw new Error('meter.json differs from the raw replay');
    }
    const controlFile = join(directory, 'reconciliation.json');
    const control = existsSync(controlFile) ? JSON.parse(readFileSync(controlFile, 'utf8')) : {};
    const componentCheck = control.fields_match ?? control.matched ?? null;
    for (const name of ['calls.jsonl', 'stages.csv']) {
      if (archiveDigest(directory, name) !== archiveDigest(tmp, name)) throw new Error(name + ' differs from the raw replay');
    }
    const lines = readFileSync(join(tmp, 'calls.jsonl'), 'utf8').trim();
    if (lines) for (const line of lines.split('\n')) check(validateCall, JSON.parse(line));
    return { id: manifest.run_id, dry_run: manifest.dry_run, status: manifest.status, complete_usage: result.complete, source_hashes_recorded: hasRawDigests, external_components_match: componentCheck, calls: result.call_count, rpt: result.rpt };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const root = resolve(process.argv[2] ?? join(project, 'bench', 'runs'));
if (process.argv.length > 3) throw new Error('Usage: node scripts/replay.mjs [run-directory | bench/runs]');
const dirs = existsSync(join(root,'manifest.json')) ? [root] : readdirSync(root,{withFileTypes:true})
  .filter(entry => entry.isDirectory() && existsSync(join(root, entry.name, 'manifest.json')))
  .map(entry => join(root,entry.name)).sort();

if (!dirs.length) {
  console.error('No archived runs found.');
  process.exitCode = 1;
}
for (const dir of dirs) {
  try {
    console.log(JSON.stringify(await verify(dir)));
  } catch (error) {
    console.error(basename(dir) + ': ' + String(error.message ?? error));
    process.exitCode = 1;
  }
}
