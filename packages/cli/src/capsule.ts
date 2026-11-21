import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { requirementPattern, scenarioPattern } from './quality/change.js';
import { sorted } from './quality/types.js';

interface Heading {
  depth: number;
  title: string;
  start: number;
}

interface RequirementName {
  id: string;
  name: string;
}

interface Requirement extends RequirementName {
  path: string;
  operation: string;
  scenarios: string[];
  renamedFrom?: RequirementName;
  text: string;
}

// Ignore Markdown inside fenced examples when locating headings and checkboxes.
// Offsets into the original text keep line endings, indentation and blank lines intact.
export function markdownLines(source: string) {
  const lines: { start: number; text: string; literal: boolean }[] = [];
  let fence = '';
  for (const match of source.matchAll(/[^\r\n]*(?:\r\n|\n|\r|$)/g)) {
    if (!match[0]) break;
    const text = match[0].replace(/[\r\n]+$/, '');
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(text);
    const literal = Boolean(fence || marker);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1].startsWith(fence) && !marker[2].trim()) fence = '';
    }
    lines.push({ start: match.index, text, literal });
  }
  return lines;
}

function headings(source: string): Heading[] {
  return markdownLines(source).flatMap(({ start, text, literal }) => {
    const m = !literal && /^ {0,3}(#{1,6})[ \t]+(.+?)\s*$/.exec(text);
    return m ? [{ start, depth: m[1].length, title: headingTitle(m[2]) }] : [];
  });
}

function headingTitle(text: string) {
  return text.replace(/[ \t]+#+[ \t]*$/, '').trim();
}

function refs(text: string) {
  const prose = markdownLines(text)
    .filter((line) => !line.literal)
    .map((line) => line.text)
    .join('\n');
  return sorted([
    ...(prose.match(requirementPattern) ?? []),
    ...(prose.match(scenarioPattern) ?? []),
  ]);
}

function taskText(source: string, id: string, path: string) {
  const lines = markdownLines(source);
  const starts = lines.flatMap((line, i) => {
    const match = !line.literal && /^(\s*)[-*+]\s+\[[ xX]\]\s+(\d+(?:\.\d+)+)\b/.exec(line.text);
    return match && match[2] === id ? [{ index: i, indent: match[1].length }] : [];
  });
  if (starts.length !== 1)
    throw new Error(`Expected one task ${id} in ${path}, found ${starts.length}`);
  const { index, indent } = starts[0];
  let end = index + 1;
  while (end < lines.length) {
    const line = lines[end].text;
    if (line.trim() && (line.search(/\S/) <= indent || /^\s*[-*+]\s+\[[ xX]\]/.test(line))) break;
    end++;
  }
  return source.slice(lines[index].start, lines[end]?.start ?? source.length);
}

// Public change artifacts can be uncommitted during apply. Accept only regular
// files in real directories, including every component under the project root.
function entry(root: string, path: string) {
  let current = root;
  for (const part of path.split('/')) {
    current = join(current, part);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (!stat) return undefined;
    if (stat.isSymbolicLink()) throw new Error(`Symlink in capsule input: ${path}`);
    if (current === join(root, path)) return stat;
    if (!stat.isDirectory()) throw new Error(`Invalid artifact path: ${path}`);
  }
}

function read(root: string, path: string) {
  if (!entry(root, path)?.isFile()) throw new Error(`Missing regular file: ${path}`);
  return readFileSync(join(root, path), 'utf8');
}

function specFiles(root: string, dir: string): string[] {
  if (!entry(root, dir)) return [];
  const files: string[] = [];
  for (const name of readdirSync(join(root, dir), { withFileTypes: true })) {
    const path = `${dir}/${name.name}`;
    if (name.isSymbolicLink()) throw new Error(`Symlink in capsule input: ${path}`);
    if (name.isDirectory()) files.push(...specFiles(root, path));
    else if (name.name === 'spec.md') files.push(path);
  }
  return files.sort();
}

function readRequirements(root: string, path: string): Requirement[] {
  const source = read(root, path);
  const all = headings(source);
  return all.flatMap<Requirement>((heading, i) => {
    if (heading.depth === 2 && /^(?:RENAMED|REMOVED) Requirements$/i.test(heading.title)) {
      const end = all.slice(i + 1).find((h) => h.depth <= 2)?.start ?? source.length;
      const section = source.slice(heading.start, end);
      const lines = markdownLines(section).flatMap((line) => {
        const match =
          !line.literal &&
          /^\s*(?:[-*+]\s+)?(?:(FROM|TO):\s*)?`?###\s*Requirement:\s*(.+?)`?\s*$/i.exec(line.text);
        if (!match) return [];
        const name = headingTitle(match[2]);
        const id = name.match(requirementPattern)?.[0];
        return id ? [{ ...line, id, name, side: match[1]?.toUpperCase() }] : [];
      });
      if (/^REMOVED/i.test(heading.title)) {
        const removals = lines.filter((line) => !line.side);
        return removals.map(({ id, name, start }, i) => ({
          path,
          id,
          name,
          scenarios: [],
          text: section.slice(start, removals[i + 1]?.start ?? section.length),
          operation: heading.title,
        }));
      }
      const directives: Requirement[] = [];
      let previous: (typeof lines)[number] | undefined;
      for (const line of lines) {
        if (line.side === 'FROM' && !previous) {
          previous = line;
        } else if (line.side === 'TO' && previous) {
          directives.push({
            path,
            id: line.id,
            name: line.name,
            renamedFrom: { id: previous.id, name: previous.name },
            scenarios: [],
            operation: heading.title,
            text: section.slice(previous.start, line.start + line.text.length),
          });
          previous = undefined;
        } else throw new Error(`Unpaired rename directive in ${path}: ${line.text}`);
      }
      if (previous) throw new Error(`Unpaired rename for ${previous.id} in ${path}`);
      return directives;
    }
    if (heading.depth !== 3 || !/^Requirement:\s*/i.test(heading.title)) return [];
    const name = heading.title.replace(/^Requirement:\s*/i, '');
    const id = name.match(requirementPattern)?.[0];
    if (!id) return [];
    const group = all
      .slice(0, i)
      .reverse()
      .find((h) => h.depth <= 2);
    const operation = group?.depth === 2 ? group.title : '';
    if (/^(?:REMOVED|RENAMED) Requirements$/i.test(operation)) return [];
    const end =
      all.slice(i + 1).find((h) => h.depth < 3 || (h.depth === 3 && /^Requirement:/i.test(h.title)))
        ?.start ?? source.length;
    const scenarios = all
      .slice(i + 1)
      .filter((h) => h.start < end && h.depth === 4 && /^Scenario:/i.test(h.title))
      .flatMap((h) => h.title.match(scenarioPattern)?.slice(0, 1) ?? []);
    return [{ path, operation, id, name, scenarios, text: source.slice(heading.start, end) }];
  });
}

function relatedRequirements(root: string, change: string, task: string, taskPath: string) {
  const wanted = refs(task);
  if (!wanted.length)
    throw new Error(`Task has no requirement or scenario reference in ${taskPath}`);
  const native = specFiles(root, `${change}/specs`);
  const flat = `${change}/specs.md`;
  if (entry(root, flat) && native.length)
    throw new Error(`Conflicting flat and native specs in ${change}`);
  const paths = native.length ? native : [flat];
  const deltas = paths.flatMap((path) => readRequirements(root, path));
  const matches = (r: Requirement, id: string) => r.id === id || r.scenarios.includes(id);
  let base: Requirement[] | undefined;
  const baseRequirements = () => {
    base ??= specFiles(root, 'openspec/specs').flatMap((path) => readRequirements(root, path));
    return base;
  };
  const combined = new Set<Requirement>();
  for (const r of deltas) {
    const from = r.renamedFrom;
    if (!from) continue;
    const basePath = r.path.startsWith(`${change}/specs/`) ? r.path.slice(change.length + 1) : null;
    const originals = baseRequirements().filter(
      (original) =>
        original.name === from.name && (!basePath || original.path === `openspec/${basePath}`),
    );
    if (originals.length !== 1)
      throw new Error(
        `Expected one source requirement for rename of ${from.id} in ${r.path}, found ${originals.length}`,
      );
    const modifications = deltas.filter(
      (delta) =>
        delta.path === r.path &&
        delta.name === r.name &&
        /^MODIFIED Requirements$/i.test(delta.operation),
    );
    if (modifications.length === 1) {
      const [modified] = modifications;
      r.text += `\n\n${modified.text}`;
      r.operation += ` + ${modified.operation}`;
      r.scenarios = modified.scenarios;
      combined.add(modified);
      continue;
    }
    const [original] = originals;
    r.text += `\n\nOriginal text: \`${original.path}\`\n\n${original.text}`;
    r.scenarios = original.scenarios;
  }
  const changed = deltas.filter((delta) => !combined.has(delta));
  const selected = new Set<Requirement>();
  const seen = new Set<string>();
  for (const id of wanted) {
    if (seen.has(id)) continue;
    seen.add(id);
    let candidates = changed.filter((r) => matches(r, id));
    if (!candidates.length) {
      candidates = baseRequirements().filter(
        (r) =>
          matches(r, id) &&
          !changed.some((delta) => r.id === delta.id || r.id === delta.renamedFrom?.id),
      );
    }
    if (candidates.length !== 1)
      throw new Error(
        `${candidates.length ? 'Ambiguous' : 'Dangling'} reference ${id} in capsule for ${taskPath}; check ${change}/ and openspec/specs/`,
      );
    const [r] = candidates;
    if (selected.has(r)) continue;
    selected.add(r);
    wanted.push(...refs(r.text).filter((ref) => !matches(r, ref) && ref !== r.renamedFrom?.id));
  }
  return [...selected].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : a.id < b.id ? -1 : 1,
  );
}

function filesIn(text: string) {
  return sorted(Array.from(text.matchAll(/`([^\s`]+\.[a-zA-Z][\w-]*)`/g), (match) => match[1]));
}

function relatedDesign(source: string, task: string, ids: Set<string>) {
  const sections = headings(source);
  const files = filesIn(task);
  const keep = new Set<number>();
  const ancestors: number[] = [];
  const inScope = new Set<number>();
  let matched = false;
  for (let i = 0; i < sections.length; i++) {
    const h = sections[i];
    while (ancestors.length && sections[ancestors[ancestors.length - 1]].depth >= h.depth)
      ancestors.pop();
    const text = source.slice(h.start, sections[i + 1]?.start ?? source.length);
    const linked = refs(text);
    const related = linked.some((ref) => ids.has(ref)) || files.some((file) => text.includes(file));
    matched ||= related;
    // Unscoped rules can constrain every task (invariants, shared interfaces, errors).
    if (
      (!linked.length && (!ancestors.length || inScope.has(ancestors[ancestors.length - 1]))) ||
      related
    ) {
      inScope.add(i);
      keep.add(i);
      for (const parent of ancestors) keep.add(parent);
    }
    ancestors.push(i);
  }
  if (!sections.length || (!matched && source.length <= 4096)) return source;
  if (!keep.size) return 'No matching design section. Read the full design at the path above.';
  return (
    source.slice(0, sections[0].start) +
    sections
      .map((h, i) =>
        keep.has(i) ? source.slice(h.start, sections[i + 1]?.start ?? source.length) : '',
      )
      .join('')
  );
}

export function buildCapsule(
  root: string,
  changeId: string,
  taskId: string,
  options: { enabled?: boolean } = {},
) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(changeId)) throw new Error(`Invalid change ID: ${changeId}`);
  if (!/^\d+(?:\.\d+)+$/.test(taskId)) throw new Error(`Invalid task ID: ${taskId}`);
  const config = parse(read(root, 'frugal.yaml'));
  if ((options.enabled ?? config?.flags?.capsule) !== true)
    throw new Error('Task capsules require flags.capsule: true in frugal.yaml');
  const dir = `openspec/changes/${changeId}`;
  const taskPath = `${dir}/tasks.md`;
  const task = taskText(read(root, taskPath), taskId, taskPath);
  const reqs = relatedRequirements(root, dir, task, taskPath);
  const ids = new Set(reqs.flatMap((r) => [r.id, ...r.scenarios]));
  const designPath = `${dir}/design.md`;
  const design = read(root, designPath);
  if (!design.trim()) throw new Error(`Empty design: ${designPath}`);
  const excerpt = relatedDesign(design, task, ids);
  const files = filesIn(`${task}\n${excerpt}`);
  const handoffPath = `${dir}/handoff.md`;
  const handoff = entry(root, handoffPath)
    ? read(root, handoffPath)
    : 'No handoff has been recorded.';
  const marker = `task_${taskId.replaceAll('.', '_')}`;
  const selector = config.test?.per_task_selector;
  if (typeof config.test?.command !== 'string' || !config.test.command.trim())
    throw new Error('Missing test.command in frugal.yaml');
  if (selector !== undefined && typeof selector !== 'string')
    throw new Error('Invalid test.per_task_selector in frugal.yaml');
  const test = [
    config.test.command,
    selector?.replaceAll('{task_marker}', marker).replaceAll('{task_id}', taskId),
  ]
    .filter(Boolean)
    .join(' ');
  const projectRules = 'openspec/config.yaml';
  return [
    `# Task ${taskId} · ${changeId}`,
    `Source: \`${taskPath}\`\n\n${task}`,
    '## Requirements and scenarios',
    ...reqs.map((r) => `Source: \`${r.path}\` ${r.operation}\n\n${r.text}`),
    `## Design\n\nSource: \`${designPath}\`\n\n${excerpt}`,
    '## Referenced files',
    files.length
      ? files.map((f) => `- \`${f}\``).join('\n')
      : 'No file paths named in the task or selected design.',
    `## Handoff\n\nSource: \`${handoffPath}\`\n\n${handoff}`,
    '## Tests',
    `Command: \`${test}\` (frugal.yaml)\nTag tests with TASK-${taskId} and their SCN IDs.` +
      (selector?.includes('{task_marker}') ? ` Selector marker: \`${marker}\`.` : '') +
      (entry(root, projectRules) ? ` See \`${projectRules}\` for project conventions.` : ''),
    `Полная спека: \`${dir}/\`. Читай её, только если капсулы недостаточно.`,
  ].join('\n\n');
}

export function capsule(args: string[]) {
  const [change, task, option, repo] = args;
  if (
    !change ||
    !task ||
    !(args.length === 2 || (args.length === 4 && option === '--repo' && repo))
  )
    throw new Error('Usage: frugal capsule <change> <task> [--repo DIR]');
  console.log(buildCapsule(resolve(repo ?? '.'), change, task));
}
