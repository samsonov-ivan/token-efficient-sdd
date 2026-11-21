import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { buildCapsule } from '../src/capsule.js';
import { main } from '../src/index.js';

const dir = 'openspec/changes/add-range';
const path = `${dir}/specs/range/spec.md`;
const req = 'REQ-RANGE-01';
const scn = 'SCN-RANGE-01.1';
const block = [
  `### Requirement: ${req} Endpoint`,
  'An endpoint SHALL accept the inclusive upper bound.  ',
  '',
  `#### Scenario: ${scn} At the limit`,
  '- **WHEN** the value is 10',
  '- **THEN** accept it',
  '',
  '~~~~',
  '### Requirement: REQ-EXAMPLE-99 ignored as a heading',
  '~~~~',
  '#### Scenario: SCN-RANGE-01.2 Above the limit',
  '- **THEN** reject it',
  '',
].join('\r\n');
const unrelated = '### Requirement: REQ-OTHER-01 Other work\nBoats SHALL float.\n';
const tasks = `## 1. Range\n- [x] 1.1 Bound \`src/limits.ts\`\n  Retain the inclusive bound [${req}, ${scn}].\n- [ ] 1.2 Other work [REQ-OTHER-01]\n`;
const testConfig = 'test:\n  command: npm test\n  per_task_selector: "-- -t {task_marker}"\n';
let root: string;

function put(path: string, data: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), data);
}

const build = () => buildCapsule(root, 'add-range', '1.1');

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'frugal-capsule-'));
  put('frugal.yaml', `flags: {capsule: true}\n${testConfig}`);
  put(`${dir}/tasks.md`, tasks);
  put(path, `## ADDED Requirements\r\n${block}${unrelated}`);
  put(
    `${dir}/design.md`,
    `# Design\n## Shared constraints\nAlways preserve errors.\n## Limits\nUse \`accept(n: number)\` for ${req}.\n## Module\nCall \`src/limits.ts\` for REQ-OTHER-01.\n## Boats\nBoats implement REQ-OTHER-01.\n### Sails\nPrivate to boats.\n`,
  );
  put(`${dir}/handoff.md`, 'Previous task published the Range interface.\n');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

it('dispatches the CLI, preserves the original task, requirement and all scenarios, and is repeatable', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const run = () => main(['capsule', 'add-range', '1.1', '--repo', root]);
  expect(await run()).toBe(0);
  expect(await run()).toBe(0);
  const [first, second] = log.mock.calls.map(([output]) => output);
  expect(second).toBe(first);
  for (const text of [
    tasks.split('## 1. Range\n')[1].split('- [ ]')[0],
    block,
    path,
    `${dir}/`,
    `${dir}/design.md`,
    'Always preserve errors.',
    'accept(n: number)',
    'Call `src/limits.ts`',
    'Previous task published',
    'npm test -- -t task_1_1',
  ])
    expect(first).toContain(text);
  for (const text of ['Boats SHALL', 'Private to boats.', 'Boats implement', '1.2 Other work'])
    expect(first).not.toContain(text);
});

it('accepts flat specs and resolves a scenario-only link to the complete parent requirement', () => {
  rmSync(join(root, path));
  put(`${dir}/specs.md`, block);
  put(`${dir}/tasks.md`, `- [ ] 1.1 Implement [${scn}]\n`);
  rmSync(join(root, dir, 'handoff.md'));
  expect(build()).toContain(block);
  expect(build()).toContain('No handoff has been recorded');
});

it('resolves linked baseline specs while refusing stale scenarios removed by a changed requirement', () => {
  const base = 'openspec/specs/shared/spec.md';
  put(
    base,
    `## Requirements\n### Requirement: REQ-SHARED-01 global\nThe API SHALL log all errors.\n`,
  );
  put(path, block.replace('inclusive upper bound.', 'inclusive upper bound under REQ-SHARED-01.'));
  expect(build()).toContain('The API SHALL log all errors.');
  expect(build()).toContain(base);
  put(base, block.replace(scn, 'SCN-RANGE-01.9'));
  put(`${dir}/tasks.md`, '- [ ] 1.1 Implement SCN-RANGE-01.9');
  expect(build).toThrow(/Dangling reference SCN-RANGE-01\.9/);
});

it.each([
  ['- [ ] 1.1 no references', /no requirement or scenario reference/],
  ['- [ ] 1.1 REQ-NONE-01', /Dangling reference REQ-NONE-01/],
  ['- [ ] 1.1 SCN-RANGE-01.99', /Dangling reference SCN-RANGE-01\.99/],
  ['- [ ] 1.2 other task', /Expected one task 1.1.*found 0/],
  ['- [ ] 1.1 first\n- [ ] 1.1 second', /Expected one task 1.1.*found 2/],
] as const)('diagnoses invalid task links (%s)', (text, problem) => {
  put(`${dir}/tasks.md`, text);
  expect(build).toThrow(problem);
});

it('rejects ambiguous definitions and flat/native mixtures', () => {
  put(`${dir}/specs/duplicate/spec.md`, block);
  expect(build).toThrow(/Ambiguous reference/);
  put(`${dir}/specs.md`, block);
  expect(build).toThrow(/Conflicting flat and native/);
});

it('respects the boolean flag before reading change artifacts', () => {
  for (const flags of ['{}', '{capsule: false}', '{capsule: "true"}']) {
    put('frugal.yaml', `flags: ${flags}`);
    expect(build).toThrow(/flags.capsule: true/);
  }
});

it('rejects path traversal and symlinked artifact ancestors', () => {
  expect(() => buildCapsule(root, '../other', '1.1')).toThrow(/Invalid change ID/);
  rmSync(join(root, dir, 'specs'), { recursive: true });
  symlinkSync(root, join(root, dir, 'specs'));
  expect(build).toThrow(/Symlink in capsule input/);
});

it('preserves OpenSpec rename directives and the original scenarios, resolving the new ID', () => {
  put('openspec/specs/range/spec.md', block);
  const rename =
    '- FROM: `### Requirement: REQ-RANGE-01 Endpoint`\n- TO: `### Requirement: REQ-BOUND-01 Bound`';
  put(path, `## RENAMED Requirements\n${rename}\n`);
  put(`${dir}/tasks.md`, `- [ ] 1.1 Rename [REQ-BOUND-01, ${scn}]\n`);
  expect(build()).toContain(rename);
  expect(build()).toContain(block);
  expect(build()).toContain('openspec/specs/range/spec.md');
  put(`${dir}/tasks.md`, `- [ ] 1.1 Old [${req}]\n`);
  expect(build).toThrow(/Dangling reference REQ-RANGE-01/);
});

it('honors removed requirement bullets over the previous main spec', () => {
  put('openspec/specs/range/spec.md', block);
  put(path, `## REMOVED Requirements\n* \`### Requirement: ${req} Endpoint\`\n`);
  put(`${dir}/tasks.md`, `- [ ] 1.1 Remove [${req}]\n`);
  expect(build()).toContain('REMOVED Requirements');
  expect(build()).not.toContain('An endpoint SHALL');
  put(`${dir}/tasks.md`, `- [ ] 1.1 Old [${scn}]\n`);
  expect(build).toThrow(/Dangling reference SCN-RANGE-01.1/);
});
