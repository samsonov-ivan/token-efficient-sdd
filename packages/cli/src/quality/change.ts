import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Snapshot } from './snapshot.js';
import type { Change, MissingId, SpecRequirement, SpecTask } from './types.js';

export const requirementPattern = /\bREQ-[A-Z][A-Z0-9-]*-\d+\b/g;
export const scenarioPattern = /\bSCN-[A-Z][A-Z0-9-]*-\d+\.\d+\b/g;
const label = (text: string, pattern: RegExp) => (text?.match(pattern) ?? [])[0];

interface OpenSpecRequirement {
  name: string;
  text: string;
  scenarios: { name: string; rawText: string }[];
}

type OpenSpecDelta = { spec: string } & (
  | { operation: 'RENAMED'; rename: { from: string; to: string } }
  | { operation: 'ADDED' | 'MODIFIED' | 'REMOVED'; requirement: OpenSpecRequirement }
);

export function readChange(
  snapshot: Snapshot,
  id: string,
  openspec: string,
  flatCapability?: string,
): Change {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error(`Invalid change ID: ${id}`);
  const dir = mkdtempSync(join(tmpdir(), 'frugal-quality-'));
  const project = join(dir, 'repo');
  const prefix = `openspec/changes/${id}/`;
  const errors: string[] = [];
  const warnings: string[] = [];
  const missingIds: MissingId[] = [];
  const identify = (
    kind: MissingId['kind'],
    path: string,
    text: string,
    id?: string,
    parent?: string,
  ) => {
    if (id) return id;
    const token = `unlabeled-${kind}-${missingIds.length + 1}`;
    missingIds.push({ kind, path, text, parent, token });
    return token;
  };
  const requirements: SpecRequirement[] = [];
  const tasks: SpecTask[] = [];
  const spec = (args: string[]) => {
    const res = spawnSync(openspec, args, {
      cwd: project,
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024,
      env: {
        PATH: process.env.PATH,
        HOME: dir,
        XDG_CONFIG_HOME: join(dir, 'config'),
        XDG_DATA_HOME: join(dir, 'data'),
        CI: '1',
        OPENSPEC_TELEMETRY: '0',
        DO_NOT_TRACK: '1',
        NO_COLOR: '1',
      },
    });
    if (res.error) throw res.error;
    if (res.status !== 0)
      throw new Error(`openspec ${args.join(' ')}: ${(res.stdout || res.stderr).trim()}`);
    return JSON.parse(res.stdout);
  };
  try {
    snapshot.materializeOpenSpec(project, id);
    for (const name of ['proposal.md', 'design.md', 'tasks.md'])
      if (!snapshot.read(prefix + name).trim()) errors.push(`Empty ${prefix}${name}`);
    const flat = `${prefix}specs.md`;
    const natives = [...snapshot.files.keys()].filter(
      (path) => path.startsWith(`${prefix}specs/`) && path.endsWith('/spec.md'),
    );
    if (snapshot.files.has(flat) && natives.length)
      throw new Error('Conflicting flat and native spec layouts');
    if (!natives.length && !snapshot.files.has(flat)) throw new Error('Change has no spec files');
    if (!natives.length) {
      const cap = flatCapability ?? id;
      if (!/^[a-z0-9][a-z0-9/-]*$/.test(cap)) throw new Error('Invalid flat capability');
      const src = snapshot.read(flat);
      const projected = /^##\s+(?:ADDED|MODIFIED|REMOVED|RENAMED) Requirements/im.test(src)
        ? src
        : `## ADDED Requirements\n\n${src}`;
      const target = join(project, prefix, 'specs', cap);
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, 'spec.md'), projected);
    }
    const validation = spec([
      'validate',
      id,
      '--type',
      'change',
      '--strict',
      '--no-interactive',
      '--json',
    ]);
    if (
      !validation.items?.length ||
      validation.items.some((item: { valid?: boolean }) => item.valid !== true)
    )
      throw new Error(`Strict OpenSpec validation failed: ${JSON.stringify(validation)}`);
    const change = spec(['show', id, '--type', 'change', '--json']);
    if (!Array.isArray(change.deltas) || !change.deltas.length)
      throw new Error('OpenSpec emitted no deltas');
    const deltas: OpenSpecDelta[] = change.deltas;
    const base = new Map<string, Map<string, OpenSpecRequirement>>();
    const renamed = new Map<string, Map<string, OpenSpecRequirement>>();
    const replacedNames = new Map<string, Set<string>>();
    const readBase = (capability: string) => {
      const cached = base.get(capability);
      if (cached) return cached;
      const model: { requirements: OpenSpecRequirement[] } = spec([
        'show',
        capability,
        '--type',
        'spec',
        '--json',
      ]);
      const originals = new Map(model.requirements.map((r) => [r.name, r]));
      base.set(capability, originals);
      return originals;
    };
    const markReplaced = (capability: string, name: string) => {
      const names = replacedNames.get(capability) ?? new Set<string>();
      names.add(name);
      replacedNames.set(capability, names);
    };
    const currentRequirement = (capability: string, name: string) =>
      renamed.get(capability)?.get(name) ??
      (replacedNames.get(capability)?.has(name) ? undefined : readBase(capability).get(name));
    const deltaPath = (capability: string) => {
      const path = snapshot.files.has(flat) ? flat : `${prefix}specs/${capability}/spec.md`;
      if (!snapshot.files.has(path)) throw new Error(`Delta source is absent: ${path}`);
      return path;
    };
    // The printed delta list puts MODIFIED before RENAMED, but archive resolves renames
    // before applying other operations. Keep only the final name of each rename.
    for (const delta of deltas) {
      if (delta.operation !== 'RENAMED') continue;
      deltaPath(delta.spec);
      const { from, to } = delta.rename;
      const original = currentRequirement(delta.spec, from);
      if (!original) {
        errors.push(`Unknown base requirement: ${from}`);
        continue;
      }
      if (currentRequirement(delta.spec, to)) {
        errors.push(`Rename target already exists: ${to}`);
        continue;
      }
      const names = renamed.get(delta.spec) ?? new Map<string, OpenSpecRequirement>();
      names.delete(from);
      names.set(to, { ...original, name: to });
      renamed.set(delta.spec, names);
      markReplaced(delta.spec, from);
    }
    const recordRequirement = (req: OpenSpecRequirement, path: string) => {
      const reqId = identify('requirement', path, req.name, label(req.name, requirementPattern));
      const scns = req.scenarios.map((s) =>
        identify('scenario', path, s.name, label(s.name, scenarioPattern), req.name),
      );
      if (!scns.length) errors.push(`Requirement without scenarios: ${reqId}`);
      requirements.push({
        id: reqId,
        path,
        scenarios: scns,
        statement: req.text,
        scenario_text: Object.fromEntries(
          req.scenarios.map((s) => [label(s.name, scenarioPattern) ?? s.name, s.rawText]),
        ),
      });
    };
    for (const delta of deltas) {
      const { operation } = delta;
      if (operation === 'RENAMED') continue;
      const path = deltaPath(delta.spec);
      const req = delta.requirement;
      if (operation === 'MODIFIED' || operation === 'REMOVED') {
        const original = currentRequirement(delta.spec, req.name);
        if (!original) {
          errors.push(`Unknown base requirement: ${req.name}`);
          continue;
        }
        markReplaced(delta.spec, req.name);
        renamed.get(delta.spec)?.delete(req.name);
        if (operation === 'REMOVED') {
          requirements.push({
            id: label(req.name, requirementPattern) ?? req.name,
            path,
            scenarios: [],
            removed: true,
          });
          continue;
        }
      } else if (operation !== 'ADDED') throw new Error(`Unsupported delta: ${operation}`);
      recordRequirement(req, path);
    }
    for (const [capability, names] of renamed)
      for (const req of names.values()) recordRequirement(req, deltaPath(capability));
    if (snapshot.files.has(flat)) {
      const original = snapshot.read(flat);
      const reqIds = [...original.matchAll(/^###\s*Requirement:\s*(.*)$/gim)].flatMap(
        (m) => m[1].match(requirementPattern) ?? [],
      );
      const scnIds = [...original.matchAll(/^####\s*Scenario:\s*(.*)$/gim)].flatMap(
        (m) => m[1].match(scenarioPattern) ?? [],
      );
      for (const ref of [...reqIds, ...scnIds])
        if (!requirements.some((r) => r.id === ref || r.scenarios.includes(ref)))
          errors.push(`Flat projection omitted ${ref}`);
    }
    const target = spec(['instructions', 'apply', '--change', id, '--json']);
    if (!Array.isArray(target.tasks) || !target.tasks.length)
      throw new Error('OpenSpec emitted no tasks');
    const rawTaskLines = snapshot.read(`${prefix}tasks.md`).split(/\r?\n/);
    for (const task of target.tasks) {
      const line = Number.isInteger(task.line) ? rawTaskLines[task.line - 1] : undefined;
      const number =
        /^\s*(?:[-*]\s*\[[xX ]\]\s*)?(\d+(?:\.\d+)+)\b/.exec(task.description)?.[1] ??
        /^\s*[-*]\s*\[[xX ]\]\s*(\d+(?:\.\d+)+)\b/.exec(line ?? '')?.[1];
      const text: string = task.description;
      const indexed = Number.isInteger(task.line)
        ? task.line
        : rawTaskLines.findIndex(
            (line) => line.trim().replace(/^[-*]\s*\[[ xX]\]\s*/, '') === text.trim(),
          ) + 1;
      tasks.push({
        sourceLine: indexed || undefined,
        id: identify('task', `${prefix}tasks.md`, text, number),
        text,
        refs: [...(text.match(requirementPattern) ?? []), ...(text.match(scenarioPattern) ?? [])],
        done: task.done === true,
      });
    }
    const design = snapshot.read(`${prefix}design.md`);
    const names = Array.from(
      design.matchAll(/`([^`\n]+\.(?:py|[cm]?jsx?|tsx?|go|java|kt|rs))`/g),
      (m) => m[1],
    );
    for (const name of new Set(names))
      if (!tasks.some((t) => t.text.includes(name)))
        warnings.push(`Design file not referenced by a task: ${name}`);
    const baseRefs = new Set<string>();
    const changed = new Set(requirements.flatMap((r) => [r.id, ...r.scenarios]));
    const linked = [...tasks.flatMap((t) => t.refs), ...(design.match(requirementPattern) ?? [])];
    if (linked.some((id) => !changed.has(id))) {
      for (const path of snapshot.files.keys()) {
        const cap = /^openspec\/specs\/(.+)\/spec\.md$/.exec(path)?.[1];
        if (!cap) continue;
        for (const req of readBase(cap).values()) {
          if (replacedNames.get(cap)?.has(req.name)) continue;
          for (const id of req.name.match(requirementPattern) ?? []) baseRefs.add(id);
          for (const scn of req.scenarios)
            for (const id of scn.name.match(scenarioPattern) ?? []) baseRefs.add(id);
        }
      }
    }
    return {
      missingIds,
      baseRefs: [...baseRefs].sort(),
      requirements,
      tasks,
      design,
      designPath: `${prefix}design.md`,
      errors,
      warnings,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
