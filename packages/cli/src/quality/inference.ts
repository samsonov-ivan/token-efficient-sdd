import type { Snapshot } from './snapshot.js';
import type { Change, Evidence, Expected } from './types.js';

export function resolveIdentities(
  input: Change,
  expected: Expected,
  evidence: Evidence,
  snapshot: Snapshot,
): Change {
  const change = structuredClone(input);
  const ids = {
    requirement: new Set(expected.requirements.map((r) => r.id)),
    scenario: new Set(expected.requirements.flatMap((r) => r.scenarios.map((s) => s.id))),
    task: new Set(expected.tasks.map((t) => t.id)),
  };
  const replacements = new Map<string, string>();
  for (const alias of evidence.aliases ?? []) {
    const matches = (change.missingIds ?? []).filter(
      (m) =>
        m.kind === alias.kind &&
        m.path === alias.path &&
        m.text === alias.text &&
        m.parent === alias.parent,
    );
    if (
      matches.length !== 1 ||
      !ids[alias.kind]?.has(alias.id) ||
      !alias.reason?.trim() ||
      replacements.has(matches[0].token)
    ) {
      change.errors.push(`Unverified or ambiguous artifact alias: ${alias.id}`);
      continue;
    }
    replacements.set(matches[0].token, alias.id);
  }
  change.missingIds = (change.missingIds ?? []).filter((m) => !replacements.has(m.token));
  for (const req of change.requirements) {
    req.id = replacements.get(req.id) ?? req.id;
    req.scenarios = req.scenarios.map((id) => replacements.get(id) ?? id);
  }
  for (const task of change.tasks) task.id = replacements.get(task.id) ?? task.id;
  const allowed = new Set([
    ...ids.requirement,
    ...ids.scenario,
    ...(change.baseRefs ?? []),
    ...change.requirements.flatMap((r) => [r.id, ...r.scenarios]),
  ]);
  const taskPath = change.designPath.replace(/design\.md$/, 'tasks.md');
  for (const link of evidence.artifact_links ?? []) {
    if (
      !link.reason?.trim() ||
      !link.text?.trim() ||
      !Number.isInteger(link.line) ||
      link.line < 1 ||
      !Array.isArray(link.refs) ||
      !link.refs.length ||
      link.refs.some((id) => !allowed.has(id)) ||
      ![change.designPath, taskPath].includes(link.path) ||
      snapshot.read(link.path).split(/\r?\n/)[link.line - 1]?.trim() !== link.text.trim()
    ) {
      change.errors.push(`Invalid inferred artifact link: ${link.path}:${link.line}`);
      continue;
    }
    if (link.path === change.designPath && !link.task) {
      change.designRefs = [...new Set([...(change.designRefs ?? []), ...link.refs])];
    } else {
      const task = change.tasks.find((t) => t.id === link.task);
      if (link.path !== taskPath || !task || task.sourceLine !== link.line)
        change.errors.push(`Inferred task reference points outside its checkbox: ${link.task}`);
      else task.refs = [...new Set([...task.refs, ...link.refs])];
    }
  }
  return change;
}
