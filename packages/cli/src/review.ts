import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { Ajv } from 'ajv';
import { writeJson } from './harness/io.js';
import { safePath } from './quality/snapshot.js';
import type { SpecRequirement } from './quality/types.js';

const bundled = new URL('./findings.schema.json', import.meta.url);
const schema = JSON.parse(
  readFileSync(
    existsSync(bundled)
      ? bundled
      : new URL('../../../schemas/findings.schema.json', import.meta.url),
    'utf8',
  ),
);
interface Finding {
  id: string;
  status: 'open' | 'resolved' | 'closed';
  severity: 'blocking' | 'major' | 'minor' | 'info' | 'warning' | 'nit';
  req_ids: string[];
  file?: string;
  line?: number | null;
  message: string;
  suggestion?: string | null;
}
interface Findings {
  change_id: string;
  iteration: number;
  scope: 'full' | 'delta';
  findings: Finding[];
  verdict: 'approved' | 'pass' | 'accept' | 'changes_requested';
}
const ajv = new Ajv({ strict: true, allowUnionTypes: true });
const validate = ajv.compile<Findings>(schema);
type Flags = Record<string, unknown>;
interface Packet {
  change_id: string;
  iteration: number;
  tree: string;
  instructions: string;
  diff: string;
  fullPatch: string;
  openFindings: Finding[];
  gates: { summary: string; fullPath: string; ok: boolean; tree: string };
}
export interface ReviewPacket extends Packet {
  scope: Findings['scope'];
  final: boolean;
  previousTree?: string;
  fallback?: string;
  closedFindingIds: string[];
  conventions: string;
  specificationPaths: string[];
  checklist?: { requirement: SpecRequirement; check: string }[];
  outputSchema?: object;
}
export interface FixPacket extends Packet {
  scope: 'hunks' | 'full';
}
interface ReviewOptions {
  mode: 'baseline' | 'optimized';
  flags: Flags;
  changeId: string;
  repo: string;
  baseTree: string;
  // A fresh directory outside the working tree, under the run evidence directory.
  archive: string;
}
interface ReviewDriver {
  snapshot(): Promise<string>;
  context(tree: string): Promise<{
    requirements: SpecRequirement[];
    conventions: string;
    gates: Packet['gates'];
  }>;
  // Without checklist_review, the adapter normalizes its native review into
  // findings JSON. The runner must retain the native transcript in either mode.
  review(packet: ReviewPacket): Promise<string>;
  fix(packet: FixPacket): Promise<void>;
  verify(tree: string): Promise<boolean>;
}
function git(repo: string, args: string[]) {
  return execFileSync('git', ['-C', repo, ...args], {
    env: {
      PATH: process.env.PATH,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_NO_REPLACE_OBJECTS: '1',
      GIT_TERMINAL_PROMPT: '0',
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
}
function treeId(id: string) {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(id)) throw new Error('Expected a Git snapshot ID');
  return id;
}
function diff(repo: string, from: string, to: string, file?: string) {
  return git(repo, [
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--no-renames',
    '--no-color',
    '--binary',
    '--full-index',
    '--src-prefix=a/',
    '--dst-prefix=b/',
    '--unified=3',
    treeId(from),
    treeId(to),
    '--',
    ...(file ? [`:(top,literal)${file}`] : []),
    ':(exclude,glob)**/hidden_tests/**',
    ':(exclude,glob)**/.env',
    ':(exclude,glob)**/.env.*',
  ]);
}
const compareIds = (a: { id: string }, b: { id: string }) =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

function applyFindings(raw: string, request: ReviewPacket, previous: Finding[]) {
  const report: unknown = JSON.parse(raw);
  if (!validate(report))
    throw new Error(`Invalid findings.json: ${ajv.errorsText(validate.errors)}`);
  for (const field of ['change_id', 'iteration', 'scope'] as const)
    if (report[field] !== request[field]) throw new Error(`Stale findings.json: ${field}`);
  const ledger = new Map(previous.map((f) => [f.id, f]));
  const updated = new Set<string>();
  for (const f of report.findings) {
    if (updated.has(f.id)) throw new Error(`Duplicate finding ID: ${f.id}`);
    const old = ledger.get(f.id);
    if (old?.severity === 'blocking' && f.severity !== 'blocking')
      throw new Error(`Cannot downgrade blocking finding: ${f.id}`);
    updated.add(f.id);
    ledger.set(f.id, f);
  }
  const findings = [...ledger.values()].sort(compareIds);
  const blocked = findings.some((f) => f.status === 'open' && f.severity === 'blocking');
  if ((report.verdict === 'changes_requested') !== blocked)
    throw new Error('Review verdict disagrees with open blocking findings');
  return { report: { ...report, findings }, updated };
}

// Git produces one patch per literal path. Match findings against the new
// side of each hunk, where the reviewer inspected the working tree.
function fixHunks(repo: string, base: string, tree: string, open: Finding[]) {
  const files = new Map<string, number[]>();
  for (const f of open) {
    if (!f.file || !safePath(f.file) || f.file.includes('\0') || !f.line) return;
    const lines = files.get(f.file) ?? [];
    lines.push(f.line);
    files.set(f.file, lines);
  }
  const result: string[] = [];
  for (const file of [...files.keys()].sort()) {
    const patch = diff(repo, base, tree, file);
    const headers = [...patch.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@[^\n]*$/gm)];
    const pending = new Set(files.get(file));
    const selected: string[] = [];
    for (const [index, header] of headers.entries()) {
      const start = Number(header[1]);
      const end = start + Number(header[2] ?? 1);
      const found = [...pending].filter((n) => n >= start && n < end);
      if (found.length) {
        selected.push(patch.slice(header.index, headers[index + 1]?.index));
        for (const line of found) pending.delete(line);
      }
    }
    if (pending.size || !selected.length) return;
    result.push(patch.slice(0, headers[0].index), ...selected);
  }
  return result.join('');
}

export async function runOptimizedReview(options: ReviewOptions, driver: ReviewDriver) {
  const { mode, flags, repo, baseTree, archive, changeId } = options;
  const incremental = flags.incremental_review === true;
  const checklist = flags.checklist_review === true;
  const targeted = flags.targeted_fix === true;
  if (mode !== 'optimized' || !(incremental || checklist || targeted)) return undefined;

  // Reusing a previous attempt could leave stale approval evidence on disk.
  const pathFromRepo = relative(
    realpathSync(repo),
    join(realpathSync(dirname(archive)), basename(archive)),
  );
  if (!(pathFromRepo === '..' || pathFromRepo.startsWith(`..${sep}`) || isAbsolute(pathFromRepo)))
    throw new Error('Review evidence must be outside the worktree');
  mkdirSync(archive);
  let findings: Finding[] = [];
  const findingTrees = new Map<string, string>();
  let previousTree: string | undefined;
  let expectedTree: string | undefined;
  let needsFinal = false;
  const rounds = [];
  for (let iteration = 1; iteration <= 5; iteration++) {
    const tree = treeId(await driver.snapshot());
    if (expectedTree !== undefined && tree !== expectedTree)
      throw new Error('Snapshot changed between review rounds');
    const final = needsFinal || iteration === 5;
    const dir = join(archive, `round-${iteration}`);
    mkdirSync(dir);
    const fullPatch = join(dir, 'full.patch');
    const full = diff(repo, baseTree, tree);
    writeFileSync(fullPatch, full);
    let patch = full;
    let scope: Findings['scope'] = 'full';
    let fallback: string | undefined;
    if (incremental && !final && previousTree) {
      try {
        patch = diff(repo, previousTree, tree);
        scope = 'delta';
      } catch {
        fallback = 'Previous snapshot diff unavailable; review the complete change.';
      }
    }
    const context = await driver.context(tree);
    if ((await driver.snapshot()) !== tree) throw new Error('Review context modified its snapshot');
    if (context.gates.ok !== true || context.gates.tree !== tree)
      throw new Error('Review requires green gates for the current snapshot');
    if (
      !context.gates.summary.trim() ||
      !isAbsolute(context.gates.fullPath) ||
      !lstatSync(context.gates.fullPath, { throwIfNoEntry: false })?.isFile()
    )
      throw new Error('Missing review gate evidence');
    if (!context.requirements.length)
      throw new Error('No specification requirements supplied for review');
    const request: ReviewPacket = {
      change_id: changeId,
      iteration,
      scope,
      final,
      tree,
      instructions:
        scope === 'delta'
          ? 'Check open findings and regressions introduced by this fix. Read the full patch when needed.'
          : 'Review the complete change against the specification, tests and cross-file behavior.',
      diff: patch,
      fullPatch,
      ...(scope === 'delta' ? { previousTree } : {}),
      ...(fallback ? { fallback } : {}),
      openFindings: findings.filter((f) => f.status === 'open'),
      closedFindingIds: findings.filter((f) => f.status !== 'open').map((f) => f.id),
      gates: context.gates,
      conventions: context.conventions,
      specificationPaths: [...new Set(context.requirements.map((r) => r.path))].sort(),
    };
    if (checklist) {
      request.outputSchema = schema;
      request.instructions +=
        ' Return findings JSON using stable IDs. Keep the blocking severity when resolving or reopening a blocker. Explicitly resolve fixed issues. Request changes while blocking findings remain.';
      if (scope === 'full')
        request.checklist = [...context.requirements].sort(compareIds).map((requirement) => ({
          requirement,
          check: 'Inspect implementation and tests for this requirement and every scenario.',
        }));
    }
    if (scope === 'delta') writeFileSync(join(dir, 'delta.patch'), patch);
    const raw = await driver.review(request);
    writeFileSync(join(dir, 'review-output.txt'), raw);
    if ((await driver.snapshot()) !== tree) throw new Error('Review modified its snapshot');
    const { report, updated } = applyFindings(raw, request, findings);
    writeJson(join(dir, 'findings.json'), report);
    findings = report.findings;
    for (const id of updated) findingTrees.set(id, tree);
    const blocked = report.verdict === 'changes_requested';
    rounds.push({
      round: iteration,
      tree,
      scope,
      final,
      verdict: report.verdict,
      fullPatch,
      ...(previousTree ? { previousTree } : {}),
      ...(fallback ? { fallback } : {}),
    });
    writeJson(join(archive, 'rounds.json'), rounds);

    if ((final && !blocked) || iteration === 5) {
      const verified = await driver.verify(tree);
      if ((await driver.snapshot()) !== tree) throw new Error('Verify modified its snapshot');
      if (blocked) throw new Error('Five review rounds exhausted with open blockers');
      if (!verified) throw new Error('Verification failed');
      return { rounds, findings, tree };
    }
    needsFinal = !blocked;
    expectedTree = tree;
    if (blocked) {
      const open = findings.filter((f) => f.status === 'open');
      // Omitted findings keep their prior status, but their lines may have shifted.
      const hunks =
        targeted && open.every((f) => findingTrees.get(f.id) === tree)
          ? fixHunks(repo, baseTree, tree, open)
          : undefined;
      await driver.fix({
        change_id: changeId,
        iteration,
        tree,
        instructions:
          'Fix blocking issues and major issues within the change. Keep minor issues in the report.',
        openFindings: open,
        fullPatch,
        gates: context.gates,
        scope: hunks === undefined ? 'full' : 'hunks',
        diff: hunks ?? full,
      });
      expectedTree = treeId(await driver.snapshot());
      if (expectedTree === tree) throw new Error('Fix did not change its snapshot');
    }
    previousTree = tree;
  }
  throw new Error('Review loop terminated without verification');
}
