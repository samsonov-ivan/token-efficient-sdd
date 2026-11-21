import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { type Format, message, type ResultStatus, ratio, type Suite, sorted } from './types.js';

type Cases = Map<string, ResultStatus>;
interface XmlCase {
  '@_name'?: string;
  '@_classname'?: string;
  '@_status'?: string;
  failure?: unknown;
  error?: unknown;
  skipped?: unknown;
}
interface XmlSuite {
  '@_tests'?: string;
  testsuite?: XmlSuite[];
  testcase?: XmlCase[];
}
function put(cases: Cases, id: string, status: ResultStatus) {
  if (!id || cases.has(id)) throw new Error(`Missing or duplicate test ID: ${id}`);
  cases.set(id, status);
}
function junit(raw: string): Cases {
  if (/<!DOCTYPE|<!ENTITY/i.test(raw) || XMLValidator.validate(raw) !== true)
    throw new Error('Invalid JUnit XML or prohibited DTD');
  const parsed = new XMLParser({
    ignoreAttributes: false,
    parseAttributeValue: false,
    isArray: (name) => ['testsuite', 'testcase'].includes(name),
  }).parse(raw);
  const cases: Cases = new Map();
  const visit = (suite: XmlSuite) => {
    const before = cases.size;
    for (const child of suite.testsuite ?? []) visit(child);
    for (const entry of suite.testcase ?? []) {
      if (!entry['@_name']) throw new Error('JUnit testcase without name');
      const id = [entry['@_classname'], entry['@_name']].filter(Boolean).join('::');
      const status =
        'failure' in entry || 'error' in entry
          ? 'failed'
          : 'skipped' in entry || ['notrun', 'disabled'].includes(entry['@_status'] ?? '')
            ? 'skipped'
            : 'passed';
      put(cases, id, status);
    }
    if (suite['@_tests'] !== undefined && Number(suite['@_tests']) !== cases.size - before)
      throw new Error('JUnit total differs from emitted cases');
    for (const part of ['error', 'failure'])
      if (part in suite) throw new Error(`JUnit suite-level ${part}`);
  };
  visit(parsed.testsuites ?? parsed);
  return cases;
}
function jest(raw: string): Cases {
  const data = JSON.parse(raw);
  const cases: Cases = new Map();
  for (const suite of data.testResults) {
    let failed = false;
    for (const entry of suite.assertionResults) {
      const id = entry.fullName;
      const status =
        entry.status === 'passed' ? 'passed' : entry.status === 'failed' ? 'failed' : 'skipped';
      if (status === 'failed') failed = true;
      put(cases, id, status);
    }
    if (suite.status === 'failed' && !failed) throw new Error(`Runner suite failed: ${suite.name}`);
  }
  if (data.success === false && ![...cases.values()].includes('failed'))
    throw new Error('Runner failed outside test cases');
  if (Number.isInteger(data.numTotalTests) && data.numTotalTests !== cases.size)
    throw new Error('Runner total differs from emitted test cases');
  return cases;
}
function go(raw: string): Cases {
  const cases: Cases = new Map();
  const started = new Set<string>();
  const ended = new Set<string>();
  const failedPackages = new Set<string>();
  for (const line of raw.trim().split(/\r?\n/)) {
    const e = JSON.parse(line);
    if (!e.Package) throw new Error('Go event missing package');
    if (!e.Test) {
      if (e.Action === 'start') started.add(e.Package);
      if (['pass', 'fail', 'skip'].includes(e.Action)) ended.add(e.Package);
      if (e.Action === 'fail') failedPackages.add(e.Package);
      continue;
    }
    const id = `${e.Package}::${e.Test}`;
    if (e.Action === 'run') started.add(id);
    if (['pass', 'fail', 'skip'].includes(e.Action)) {
      ended.add(id);
      put(cases, id, e.Action === 'pass' ? 'passed' : e.Action === 'fail' ? 'failed' : 'skipped');
    }
  }
  for (const id of started) if (!ended.has(id)) throw new Error(`Incomplete Go result: ${id}`);
  for (const pkg of failedPackages)
    if (![...cases].some(([id, status]) => id.startsWith(`${pkg}::`) && status === 'failed'))
      throw new Error(`Go package build or setup failure: ${pkg}`);
  return cases;
}
export function parseReport(format: Format, raw: string): Cases {
  const parse = { junit, jest, go }[format];
  if (!parse) throw new Error(`Unknown test format: ${format}`);
  const cases = parse(raw);
  if (!cases.size) throw new Error('Empty test suite');
  return cases;
}
export function inspectSuites(suites: Suite[], evidenceDir: string) {
  const results = {
    public: new Map<string, ResultStatus>(),
    hidden: new Map<string, ResultStatus>(),
  };
  const errors = { public: [] as string[], hidden: [] as string[] };
  const refs = new Map<string, string>();
  for (const suite of suites) {
    if (suite.kind !== 'public' && suite.kind !== 'hidden') throw new Error('Unknown suite kind');
    try {
      const base = realpathSync(evidenceDir);
      const path = realpathSync(resolve(base, suite.path));
      const rel = relative(base, path);
      if (isAbsolute(suite.path) || rel.startsWith('..') || isAbsolute(rel))
        throw new Error('Report outside evidence directory');
      const raw = readFileSync(path);
      if (createHash('sha256').update(raw).digest('hex') !== suite.sha256)
        throw new Error('Report hash mismatch');
      const cases = parseReport(suite.format, raw.toString('utf8'));
      for (const [id, status] of cases) {
        put(results[suite.kind], id, status);
        if (suite.kind === 'public') refs.set(id, suite.path);
      }
      if (!Array.isArray(suite.expected_tests) || !suite.expected_tests.length)
        throw new Error('Missing trusted test inventory');
      for (const id of suite.expected_tests)
        if (!cases.has(id)) errors[suite.kind].push(`Missing test: ${id}`);
      if (
        suite.exit_code !== 0 &&
        (suite.exit_code !== 1 || ![...cases.values()].includes('failed'))
      )
        errors[suite.kind].push(`Runner exit ${suite.exit_code}: ${suite.path}`);
    } catch (e) {
      errors[suite.kind].push(`${suite.path}: ${message(e)}`);
    }
  }
  function summary(kind: 'public' | 'hidden') {
    const items = [...results[kind].entries()].sort(([a], [b]) => a.localeCompare(b, 'en'));
    if (!items.length) errors[kind].push(`Missing ${kind} suite results`);
    const passed = items.filter(([, s]) => s === 'passed').length;
    const failed = items.filter(([, s]) => s === 'failed').length;
    const skipped = items.length - passed - failed;
    return {
      total: items.length,
      passed,
      failed,
      skipped,
      rate: ratio(passed, items.length),
      errors: sorted(errors[kind]),
      cases: Object.fromEntries(items),
    };
  }
  return { public: summary('public'), hidden: summary('hidden'), refs };
}
