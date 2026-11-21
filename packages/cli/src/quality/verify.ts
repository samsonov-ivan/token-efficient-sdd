import { basename, extname } from 'node:path';
import { requirementPattern } from './change.js';
import { resolveIdentities } from './inference.js';
import { isTestFile, type Snapshot } from './snapshot.js';
import { inspectSuites } from './suites.js';
import {
  type Change,
  type Evidence,
  type Expected,
  type Link,
  message,
  ratio,
  type SourceRef,
  sorted,
} from './types.js';

const taskId = /^\d+(?:\.\d+)+$/;
export function validateExpected(e: Expected) {
  const ids = new Set<string>();
  function insert(s: string, pattern: RegExp) {
    if (typeof s !== 'string' || !pattern.test(s) || ids.has(s))
      throw new Error(`Invalid or duplicate expected ID: ${s}`);
    ids.add(s);
  }
  if (e.version !== 1 || !e.requirements?.length || !e.tasks?.length)
    throw new Error('Missing or unsupported expected behaviors/tasks');
  for (const r of e.requirements) {
    insert(r.id, /^REQ-[A-Z][A-Z0-9-]*-\d+$/);
    if (!r.scenarios?.length) throw new Error(`No expected scenarios: ${r.id}`);
    for (const s of r.scenarios) {
      insert(s.id, /^SCN-[A-Z][A-Z0-9-]*-\d+\.\d+$/);
      if (!s.description?.trim()) throw new Error(`Missing expected behavior: ${s.id}`);
    }
  }
  const reqs = new Set(e.requirements.map((r) => r.id));
  for (const t of e.tasks) {
    insert(t.id, taskId);
    if (!t.requirements?.length || t.requirements.some((r) => !reqs.has(r)))
      throw new Error(`Unbound expected task: ${t.id}`);
  }
}
const repeated = (values: string[]) => sorted(values.filter((v, i) => values.indexOf(v) < i));
// Compare only unconditional boundary statements with an identical subject in the
// requirement and its cited design paragraph. Other prose goes to semantic review.
function boundaryConflicts(change: Change): string[] {
  const errors: string[] = [];
  const boundaries = (text: string) =>
    Array.from(
      text.matchAll(
        /\b((?:upper|lower) (?:endpoint|bound)(?: of [\w.-]+)?) (?:is|shall be|must be) (inclusive|exclusive)(?=[.;\n]|$)/gi,
      ),
      (match) => [match[1].toLowerCase(), match[2].toLowerCase()] as const,
    );
  const paragraphs = change.design.split(/\n\s*\n/);
  for (const req of change.requirements) {
    const cited = paragraphs.filter((p) => p.match(requirementPattern)?.includes(req.id));
    for (const [subject, specValue] of boundaries(req.statement ?? '')) {
      for (const [other, designValue] of boundaries(cited.join('\n'))) {
        if (other === subject && designValue !== specValue)
          errors.push(
            `${req.id} contradictory ${subject}: spec ${specValue}, design ${designValue}`,
          );
      }
    }
  }
  return errors;
}
export function consistencyErrors(change: Change, e: Expected) {
  const errors = [
    ...change.errors,
    ...boundaryConflicts(change),
    ...(change.missingIds ?? []).map((m) => `Missing ${m.kind} ID at ${m.path}: ${m.text}`),
  ];
  const real = change.requirements.filter((r) => !r.removed);
  const reqs = new Map(real.map((r) => [r.id, r]));
  const scns = real.flatMap((r) => r.scenarios);
  const tasks = new Map(change.tasks.map((t) => [t.id, t]));
  const allRefs = new Set([...reqs.keys(), ...scns]);
  const usedRefs = new Set(change.tasks.flatMap((t) => t.refs));
  for (const r of change.requirements)
    if (r.removed && !e.removed?.includes(r.id))
      errors.push(`Unapproved removed requirement: ${r.id}`);
  for (const id of repeated([
    ...change.requirements.map((r) => r.id),
    ...scns,
    ...change.tasks.map((t) => t.id),
  ]))
    errors.push(`Duplicate ID: ${id}`);
  for (const id of allRefs) if (!usedRefs.has(id)) errors.push(`No task references ${id}`);
  const designReqs = new Set([
    ...(change.design.match(requirementPattern) ?? []),
    ...(change.designRefs ?? []),
  ]);
  for (const id of reqs.keys())
    if (!designReqs.has(id)) errors.push(`No design decision for ${id}`);
  const validRefs = new Set([...allRefs, ...(change.baseRefs ?? [])]);
  for (const id of designReqs)
    if (!validRefs.has(id)) errors.push(`Unknown design reference ${id}`);
  for (const task of change.tasks) {
    if (!task.done) errors.push(`Unfinished task ${task.id}`);
    if (!task.refs.length) errors.push(`Task has no obligation: ${task.id}`);
    for (const ref of task.refs)
      if (!validRefs.has(ref)) errors.push(`Dangling reference ${ref} in task ${task.id}`);
  }
  for (const req of e.requirements) {
    if (!reqs.has(req.id)) errors.push(`Missing expected requirement ${req.id}`);
    for (const scn of req.scenarios)
      if (!reqs.get(req.id)?.scenarios.includes(scn.id))
        errors.push(`Missing expected scenario ${req.id}/${scn.id}`);
  }
  for (const task of e.tasks) {
    const actual = tasks.get(task.id);
    if (!actual) errors.push(`Missing expected task ${task.id}`);
    else
      for (const id of task.requirements)
        if (!actual.refs.includes(id)) errors.push(`Task ${task.id} lost ${id}`);
  }
  return sorted(errors);
}
function anchor(snapshot: Snapshot, ref: SourceRef) {
  if (!Number.isSafeInteger(ref?.line) || ref.line < 1 || !ref.text?.trim())
    throw new Error('Missing line evidence');
  const lines = snapshot.read(ref.path).split(/\r?\n/);
  if (lines[ref.line - 1]?.trim() !== ref.text.trim())
    throw new Error(`Stale source line: ${ref.path}:${ref.line}`);
  return lines;
}
function checkAssertion(snapshot: Snapshot, l: Link, infer: boolean) {
  const lines = anchor(snapshot, l.assertion);
  const codeLines = anchor(snapshot, l.code);
  if (
    isTestFile(l.code.path) ||
    !isTestFile(l.assertion.path) ||
    l.code.path === l.assertion.path ||
    /\.(?:md|ya?ml|json|txt|xml)$/i.test(l.code.path)
  )
    throw new Error('Expected separate production and test sources');
  if (/^\s*(?:#|\/\/|\/\*|\*|$)/.test(codeLines[l.code.line - 1]))
    throw new Error('Code reference is a comment');
  const a = l.assertion.text.trim();
  if (
    !/^(?:assert\s|(?:await\s+)?(?:expect|assert(?:That|Equals|True|False|Throws)?|self\.assert\w+)\s*\(|with\s+pytest\.raises\s*\(|(?:t\.(?:Errorf|Fatalf)|assert\.(?:equal|Equal|deepEqual|NoError|strictEqual))\s*\()/.test(
      a,
    )
  )
    throw new Error(`No recognized executable assertion: ${a}`);
  if (
    /^assert\s+(?:True|False|None|[-+]?\d+(?:\.\d+)?|["'][^"']*["'])(?:\s*(?:==|!=|is|>=?|<=?)\s*(?:True|False|None|[-+]?\d+|["'][^"']*["']))?(?:\s*#.*)?$/.test(
      a,
    ) ||
    /\b(?:expect|assert(?:True|False)?)\s*\(\s*(?:true|false|\d+|["'][^"']*["'])\s*\)/i.test(a) ||
    /^assert\s+(\w+(?:\.\w+)*)\s*(?:==|is)\s*\1\s*$/.test(a)
  )
    throw new Error(`Constant or tautological assertion: ${a}`);
  const before = lines.slice(0, l.assertion.line).join('\n');
  const file = basename(l.assertion.path);
  const ext = extname(file);
  let testContext = before;
  if (ext === '.py') {
    const defs = [...before.matchAll(/^(\s*)(?:async\s+)?def\s+([\w]+)\s*\(/gm)];
    const f = defs.at(-1);
    const id = l.test.split('::').at(-1)?.split('[')[0];
    if (!f || f[2] !== id) throw new Error(`Assertion is outside reported test ${l.test}`);
    const module = l.test.split('::')[0].split('.');
    if (!module.includes(basename(file, '.py')))
      throw new Error(`JUnit class does not match test file: ${l.test}`);
    const start = before.slice(0, f.index).split('\n');
    let n = start.length - 1;
    while (n >= 0 && (!start[n].trim() || /^\s*@/.test(start[n]))) n--;
    testContext = start.slice(n + 1).join('\n') + before.slice(f.index);
  } else if (['.ts', '.tsx', '.js', '.mjs', '.jsx', '.cjs'].includes(ext)) {
    const title = [
      ...before.matchAll(/\b(?:it|test)(?:\.\w+)?\s*\(\s*["'\x60]([^"'\x60]+)["'\x60]/g),
    ].at(-1);
    if (!title || !l.test.endsWith(title[1]))
      throw new Error(`Assertion is outside reported test ${l.test}`);
    testContext = before.slice(title.index);
  } else if (ext === '.go') {
    const test = [...before.matchAll(/^func\s+(Test\w+)\s*\(/gm)].at(-1);
    const name = l.test.split('::').at(-1);
    if (!test || name?.split('/')[0] !== test[1])
      throw new Error(`Assertion is outside reported Go test ${l.test}`);
    testContext = before.slice(test.index);
  } else if (ext === '.java') {
    const test = [...before.matchAll(/\bvoid\s+(\w+)\s*\(/g)].at(-1);
    if (!test || l.test.split('::').at(-1)?.replace(/\(\)$/, '') !== test[1])
      throw new Error(`Assertion is outside reported JUnit test ${l.test}`);
    testContext = before.slice(before.lastIndexOf('@Test', test.index));
  } else throw new Error(`Unsupported test source: ${file}`);
  if (!infer || !l.inferred) {
    const scnName = l.scenario.toLowerCase().replaceAll('-', '_').replaceAll('.', '_');
    if (
      !(
        testContext.includes(l.scenario) ||
        l.test.includes(l.scenario) ||
        l.test.toLowerCase().includes(scnName)
      )
    )
      throw new Error(`Missing scenario marker: ${l.scenario}`);
    if (
      !testContext.includes(`TASK-${l.task}`) &&
      !l.test.includes(`TASK-${l.task}`) &&
      !testContext.includes(`task("${l.task}")`) &&
      !testContext.includes(`task('${l.task}')`)
    )
      throw new Error(`Missing task marker: ${l.task}`);
  } else if (!l.reason?.trim()) throw new Error('Inferred link needs independent reason');
}
export function evaluate(
  change: Change,
  e: Expected,
  ev: Evidence,
  snapshot: Snapshot,
  evidenceDir: string,
  infer: boolean,
) {
  if (ev.final_commit !== snapshot.commit)
    throw new Error(`Evidence does not match final commit ${snapshot.commit}`);
  validateExpected(e);
  if (infer) change = resolveIdentities(change, e, ev, snapshot);
  const suites = inspectSuites(ev.suites, evidenceDir);
  const consistency = consistencyErrors(change, e);
  const traceErrors: string[] = [];
  const semanticErrors: string[] = [];
  const reviewErrors: string[] = [];
  const reqs = change.requirements.filter((r) => !r.removed);
  const tasks = new Map(change.tasks.map((t) => [t.id, t]));
  const requirements = new Map(
    e.requirements.map((r) => [r.id, new Set(r.scenarios.map((s) => s.id))]),
  );
  for (const req of reqs) {
    if (!requirements.has(req.id)) requirements.set(req.id, new Set());
    for (const scn of req.scenarios) requirements.get(req.id)?.add(scn);
  }
  const realScns = new Map(reqs.flatMap((r) => r.scenarios.map((s) => [s, r] as const)));
  const allScns = new Set([...requirements.values()].flatMap((s) => [...s]));
  const requiredTasks = new Set(e.tasks.map((t) => t.id));
  const allTasks = new Set([...requiredTasks, ...tasks.keys()]);
  for (const task of tasks.values()) {
    if (!task.text.includes('[no-test]')) continue;
    const approval = ev.exempt_tasks?.find((e) => e.task === task.id);
    if (
      requiredTasks.has(task.id) ||
      !/\[no-test\]\s*[:—-]?\s*[^[\]\s].+/i.test(task.text) ||
      !approval?.reason?.trim()
    ) {
      traceErrors.push(`Unverified no-test exception: ${task.id}`);
    } else {
      allTasks.delete(task.id);
    }
  }
  const coveredScns = new Set<string>(),
    coveredTasks = new Set<string>();
  const rows = [];
  for (const link of [...ev.links].sort((a, b) =>
    [a.scenario, a.task, a.test]
      .join('/')
      .localeCompare([b.scenario, b.task, b.test].join('/'), 'en'),
  )) {
    const req = realScns.get(link.scenario);
    try {
      if (!req) throw new Error('Unknown or missing spec scenario');
      const task = tasks.get(link.task);
      if (!task || !task.refs.includes(req.id) || !task.refs.includes(link.scenario))
        throw new Error('Task must reference scenario and requirement');
      if (suites.public.cases[link.test] !== 'passed')
        throw new Error('Test missing or did not pass');
      checkAssertion(snapshot, link, infer);
      coveredScns.add(link.scenario);
      if (allTasks.has(link.task)) coveredTasks.add(link.task);
      rows.push({
        req_id: req.id,
        scenario_id: link.scenario,
        spec_ref: req.path,
        design_ref: change.designPath,
        task_ids: [link.task],
        code_ref: link.code,
        test_id: link.test,
        assertion: link.assertion,
        run_result_ref: suites.refs.get(link.test),
        final_commit: snapshot.commit,
        verdict: 'pass',
        inferred: link.inferred === true,
      });
    } catch (err) {
      traceErrors.push(`${[link.scenario, link.task, link.test].join('/')}: ${message(err)}`);
    }
  }
  for (const scn of allScns)
    if (!coveredScns.has(scn)) traceErrors.push(`Uncovered scenario ${scn}`);
  for (const task of allTasks)
    if (!coveredTasks.has(task)) traceErrors.push(`Uncovered task ${task}`);
  const semanticOK = new Set<string>();
  for (const id of requirements.keys()) {
    const verdicts = ev.semantic.filter((s) => s.requirement === id);
    if (verdicts.length === 1 && verdicts[0].verdict === 'pass' && verdicts[0].reason?.trim())
      semanticOK.add(id);
    else
      semanticErrors.push(
        `${id}: ${verdicts.map((v) => v.reason).join(', ') || 'Missing independent semantic verification'}`,
      );
  }
  if (!ev.review.length || ev.review.length > 5) reviewErrors.push('Expected 1 to 5 review rounds');
  for (const [i, r] of ev.review.entries()) {
    const final = i === ev.review.length - 1;
    if (
      r.round !== i + 1 ||
      !r.summary?.trim() ||
      !r.scope?.trim() ||
      !/^[a-f0-9]{40,64}$/.test(r.tree ?? r.commit ?? '') ||
      r.verdict !== (final ? 'pass' : 'fix')
    )
      reviewErrors.push(`Incomplete review evidence in round ${i + 1}`);
    if (final && r.tree !== snapshot.tree && r.commit !== snapshot.commit)
      reviewErrors.push('Last review does not cover evaluated snapshot');
  }
  const passReq = [...requirements].filter(
    ([id, scns]) =>
      scns.size > 0 &&
      reqs.some((r) => r.id === id) &&
      [...scns].every((s) => coveredScns.has(s) && realScns.get(s)?.id === id),
  ).length;
  const expectedScns = e.requirements.flatMap((r) => r.scenarios.map((s) => [r.id, s.id] as const));
  const check = (errs: string[]) => ({ ok: !errs.length, errors: sorted(errs) });
  const suiteErrors = (s: typeof suites.public) => [
    ...s.errors,
    ...(s.passed === s.total ? [] : ['Required suite has failing or skipped tests']),
  ];
  const checks = {
    validate: check(change.errors),
    consistency: check(consistency),
    trace: check(traceErrors),
    full_suite: check(suiteErrors(suites.public)),
    review: check(reviewErrors),
    hidden: check([
      ...suites.hidden.errors,
      ...(suites.hidden.skipped ? ['Required hidden tests skipped'] : []),
    ]),
    semantic: check(semanticErrors),
  };
  const errors = sorted(Object.values(checks).flatMap((c) => c.errors));
  const metrics = {
    Cov_req: ratio(passReq, requirements.size),
    Cov_scn: ratio(coveredScns.size, allScns.size),
    Cov_task: ratio(coveredTasks.size, allTasks.size),
    Cov_expected: ratio(
      expectedScns.filter(([r, s]) => realScns.get(s)?.id === r && semanticOK.has(r)).length,
      expectedScns.length,
    ),
    Green: suites.public.rate,
    Cons: Number(checks.validate.ok && checks.consistency.ok && checks.semantic.ok),
    Q_hidden: checks.hidden.ok ? suites.hidden.rate : null,
    R: ev.review.length,
  };
  return {
    gates: {
      version: 1,
      final_commit: snapshot.commit,
      ok: errors.length === 0,
      metrics,
      checks,
      suites: { public: suites.public, hidden: suites.hidden },
      errors,
      warnings: change.warnings,
    },
    trace: {
      aliases: infer ? (ev.aliases ?? []) : [],
      artifact_links: infer ? (ev.artifact_links ?? []) : [],
      version: 1,
      final_commit: snapshot.commit,
      rows,
      errors: sorted(traceErrors),
    },
  };
}
