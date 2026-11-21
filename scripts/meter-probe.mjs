// Package a completed V1 smoke for offline metering. The V2 probe has its own status.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  mkdtempSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { meterRun } from '../packages/cli/dist/meter.js';

const [probeArg, destArg] = process.argv.slice(2);
assert(probeArg && destArg, 'Usage: node scripts/meter-probe.mjs <probe-root> <new-run-dir>');
const probe = resolve(probeArg),
  dest = resolve(destArg),
  evidence = join(probe, 'evidence');
assert(
  !existsSync(dest),
  'Choose a new destination. Use frugal meter to recalculate an existing snapshot.',
);
const summary = JSON.parse(readFileSync(join(evidence, 'summary.json'), 'utf8'));
const { session, model } = summary.checks;
assert(session && model && summary.checks.v1Plugin, 'V1 smoke did not finish');
mkdirSync(dirname(dest), { recursive: true });
const staging = mkdtempSync(join(dirname(dest), '.import-smoke-'));
const raw = join(staging, 'raw');
mkdirSync(raw);
for (const [from, to] of [
  ['summary.json', 'probe.json'],
  ['v1-events.stdout', 'events.jsonl'],
  ['v1-export.stdout', 'export.json'],
  ['v1-stats.stdout', 'stats.txt'],
  ['mock-requests.json', 'observed-requests.json'],
]) {
  if (existsSync(join(evidence, from))) copyFileSync(join(evidence, from), join(raw, to));
}
// A SQLite backup incorporates committed pages in a WAL. The original source remains read-only.
execFileSync(
  'sqlite3',
  ['-readonly', join(probe, 'v1/data/opencode/opencode.db'), '.backup opencode.db'],
  { cwd: raw, stdio: 'pipe' },
);
const dry_run = summary.mode === 'mock';
const stages = [
  { stage: 'other', session_id: session, started_at: summary.started, finished_at: summary.ended },
];
const manifest = {
  schema: 'frugal.meter-smoke.v1',
  kind: 'meter-smoke',
  run_id: basename(dest),
  pair_id: null,
  feature_id: 'wp00-smoke',
  branch: 'base',
  status: 'complete',
  model,
  provider: model.split('/')[0],
  dry_run,
  stages,
  metering: { title_disabled: true },
  started_at: summary.started,
  finished_at: summary.ended,
  versions: {
    opencode: summary.checks.v1Version,
    openspec: summary.checks.openspecVersion,
    node: summary.node,
  },
  notes: ['Technical V1 runtime smoke; no feature, quality verdict, or pair.'],
};
writeFileSync(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
const totals = await meterRun(staging);
const stats = readFileSync(join(raw, 'stats.txt'), 'utf8');
const displayed = stats.match(/Avg Tokens\/Session\s+([\d.]+[KMB]?)\s*│/i)?.[1];
assert(displayed, 'Missing opencode stats average');
const exact = /^\d+$/.test(displayed) ? Number(displayed) : null;
const observed = dry_run
  ? JSON.parse(readFileSync(join(raw, 'observed-requests.json'), 'utf8')).length
  : null;
const matched =
  totals.complete &&
  totals.call_count === 1 &&
  (exact === null || exact === totals.rpt) &&
  (observed === null || observed === totals.call_count);
const reconciliation = {
  run_id: manifest.run_id,
  source_files: ['raw/events.jsonl', 'raw/opencode.db', 'raw/export.json', 'raw/stats.txt'],
  stats_displayed_average: displayed,
  stats_exact_average: exact,
  provider_requests_observed: observed,
  coverage: totals.coverage,
  meter_rpt: totals.rpt,
  matched,
  issues: totals.issues,
};
writeFileSync(join(staging, 'reconciliation.json'), JSON.stringify(reconciliation, null, 2) + '\n');
renameSync(staging, dest);
console.log(JSON.stringify(reconciliation));
if (!matched) process.exitCode = 1;
