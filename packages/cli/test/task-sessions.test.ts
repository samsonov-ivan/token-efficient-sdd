import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { buildCapsule } from '../src/capsule.js';
import { runTaskSessions, type TaskApplyInput } from '../src/task-sessions.js';

const changeId = 'example';
const change = `openspec/changes/${changeId}`;
const list = [
  '## Work',
  '- [x] 5.1 Already implemented [REQ-API-01]',
  '```md',
  '- [ ] 90.8 Example checkbox',
  '```',
  '* [ ] 2.3 Change API [REQ-API-01]',
  '- [ ] 1.4 Document API [REQ-API-01]',
  '',
].join('\r\n');
const note = (id: string) => `Implemented ${id}\nAPI create()\nTests in tests/example.test.ts`;
const pass = { passed: true, summary: 'Passed the task test.' };
let repo: string;
const target = (file: string) => join(repo, change, file);
const read = (file: string) => readFileSync(target(file), 'utf8');
const put = (file: string, text: string) => writeFileSync(target(file), text);
const options = () => ({ repo, changeId, sessionPerTask: true, capsule: false, maxRetries: 1 });

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'frugal-task-sessions-'));
  mkdirSync(target('specs/api'), { recursive: true });
  writeFileSync(join(repo, 'frugal.yaml'), 'flags: {}\ntest:\n  command: npm test\n');
  put(
    'specs/api/spec.md',
    '## ADDED Requirements\n### Requirement: REQ-API-01 Public interface\nThe interface SHALL remain public.\n#### Scenario: SCN-API-01.1\n- **WHEN** called\n- **THEN** it returns success.\n',
  );
  put('design.md', '## Design\nREQ-API-01 uses create().\n');
  put('tasks.md', list);
});
afterEach(() => rmSync(repo, { force: true, recursive: true }));

it('gates checked boxes, pins retries to the same session, passes handoffs to fresh sessions and preserves all other bytes', async () => {
  const calls: TaskApplyInput[] = [];
  const gate = vi
    .fn()
    .mockResolvedValueOnce({
      passed: false,
      summary: 'Assertion output\nFull log: evidence/task-2.3.log',
    })
    .mockResolvedValue(pass);
  await runTaskSessions(options(), {
    async apply(input) {
      calls.push(input);
      if (input.attempt === 1 && input.taskId === '2.3') {
        put('tasks.md', list.replaceAll('[ ]', '[x]').replace('[x] 90.8', '[ ] 90.8'));
        put('handoff.md', 'Premature handoff');
      }
      return { sessionId: `session-${input.taskId}`, handoff: note(input.taskId) };
    },
    async checkTask(taskId) {
      expect(read('tasks.md')).toContain(`[ ] ${taskId}`);
      if (taskId === '2.3') {
        expect(read('tasks.md')).toContain('[ ] 1.4');
        expect(existsSync(target('handoff.md'))).toBe(false);
      }
      return gate(taskId);
    },
  });
  expect(calls.map(({ taskId, sessionId, attempt }) => [taskId, sessionId, attempt])).toEqual([
    ['2.3', undefined, 1],
    ['2.3', 'session-2.3', 2],
    ['1.4', undefined, 1],
  ]);
  expect(calls[0].prompt).toContain(`${change}/`);
  expect(calls[1].prompt).toContain('Return a 3–7 line handoff');
  expect(calls[1].prompt).toContain('Assertion output\nFull log: evidence/task-2.3.log');
  expect(calls[2].prompt).toContain(note('2.3'));
  expect(read('handoff.md')).toContain(note('1.4'));
  expect(read('tasks.md')).toBe(list.replace('[ ] 2.3', '[x] 2.3').replace('[ ] 1.4', '[x] 1.4'));
  const apply = vi.fn(),
    checkTask = vi.fn();
  expect(await runTaskSessions(options(), { apply, checkTask })).toBe(true);
  expect(apply).not.toHaveBeenCalled();
  expect(checkTask).not.toHaveBeenCalled();
});

it.each([false, true])(
  'emits exact capsules and separates sessions only on H01=%s',
  async (sessionPerTask) => {
    const calls: TaskApplyInput[] = [];
    await runTaskSessions(
      { ...options(), sessionPerTask, capsule: true },
      {
        async apply(input) {
          const expected = buildCapsule(repo, changeId, input.taskId, { enabled: true });
          if (sessionPerTask) {
            expect(input.prompt.startsWith(expected)).toBe(true);
            expect(input.prompt.slice(expected.length)).toContain('Return a 3–7 line handoff');
          } else expect(input.prompt).toBe(expected);
          if (input.taskId === '1.4')
            expect(input.prompt.includes(note('2.3'))).toBe(sessionPerTask);
          calls.push(input);
          return {
            sessionId: sessionPerTask ? `ses_${input.taskId}` : 'shared',
            handoff: sessionPerTask ? note(input.taskId) : '',
          };
        },
        async checkTask() {
          return pass;
        },
      },
    );
    expect(calls.map((c) => c.sessionId)).toEqual([
      undefined,
      sessionPerTask ? undefined : 'shared',
    ]);
    expect(existsSync(target('handoff.md'))).toBe(sessionPerTask);
  },
);

it('delegates unchanged all-off behavior even without a change', async () => {
  const apply = vi.fn();
  expect(
    await runTaskSessions(
      { ...options(), repo: join(repo, 'missing'), sessionPerTask: false },
      { apply, checkTask: vi.fn() },
    ),
  ).toBe(false);
  expect(apply).not.toHaveBeenCalled();
});

it('stops after the configured retry budget, retaining the prior accepted state', async () => {
  const apply = vi.fn(async ({ taskId }: TaskApplyInput) => ({
    sessionId: 'ses-1',
    handoff: note(taskId),
  }));
  const checkTask = vi.fn(async () => ({
    passed: false,
    summary: 'assertion failed; see evidence/test.log',
  }));
  await expect(runTaskSessions(options(), { apply, checkTask })).rejects.toThrow(
    /after 2 attempt.*evidence\/test.log/,
  );
  expect(apply).toHaveBeenCalledTimes(2);
  expect(checkTask).toHaveBeenCalledTimes(2);
  expect(read('tasks.md')).toBe(list);
  expect(existsSync(target('handoff.md'))).toBe(false);
});

it.each(['', 'ses 01', 'ses\n02'])('rejects an invalid session ID %j', async (sessionId) => {
  const checkTask = vi.fn();
  await expect(
    runTaskSessions(options(), { apply: async () => ({ sessionId, handoff: '' }), checkTask }),
  ).rejects.toThrow(/session ID/);
  expect(checkTask).not.toHaveBeenCalled();
  expect(read('tasks.md')).toBe(list);
});

it('rejects a retry that returns a different session', async () => {
  await expect(
    runTaskSessions(options(), {
      apply: async ({ attempt }) => ({ sessionId: `different-${attempt}`, handoff: '' }),
      checkTask: async () => ({ passed: false, summary: 'fix the failing assertion' }),
    }),
  ).rejects.toThrow(/session ID for task 2.3, attempt 2/);
  expect(read('tasks.md')).toBe(list);
});

it.each([false, true])(
  'rejects an incorrect session on the next task (fresh=%s)',
  async (fresh) => {
    await expect(
      runTaskSessions(
        { ...options(), capsule: true, sessionPerTask: fresh },
        {
          apply: async ({ taskId }) => ({
            sessionId: fresh ? 'reused' : `new-${taskId}`,
            handoff: note(taskId),
          }),
          checkTask: async () => pass,
        },
      ),
    ).rejects.toThrow(/session ID for task 1.4/);
    expect(read('tasks.md')).toBe(list.replace('[ ] 2.3', '[x] 2.3'));
  },
);

it('rejects an invalid handoff before claiming completion and replaces a previously published section on resume', async () => {
  put('handoff.md', 'Prior notes\n\n## TASK-2.3\n\nOld partial publication\n');
  const apply = async ({ taskId }: TaskApplyInput) => ({
    sessionId: `ses_${taskId}`,
    handoff: note(taskId),
  });
  await expect(
    runTaskSessions(options(), {
      apply: async () => ({ sessionId: 'a', handoff: 'one line' }),
      checkTask: async () => pass,
    }),
  ).rejects.toThrow(/3–7/);
  expect(read('tasks.md')).toBe(list);
  await runTaskSessions(options(), { apply, checkTask: async () => pass });
  const handoff = read('handoff.md');
  expect(handoff.split('## TASK-2.3')).toHaveLength(2);
  expect(handoff).not.toContain('Old partial publication');
  expect(handoff.startsWith('Prior notes')).toBe(true);
});

it('cleans up premature checkbox edits even when apply throws', async () => {
  await expect(
    runTaskSessions(options(), {
      apply: async () => {
        put('tasks.md', list.replace('[ ] 2.3', '[x] 2.3'));
        throw new Error('transport stopped');
      },
      checkTask: vi.fn(),
    }),
  ).rejects.toThrow('transport stopped');
  expect(read('tasks.md')).toBe(list);
});

it('rejects duplicate IDs, unnumbered tasks and a symlinked handoff before invoking apply', async () => {
  const callbacks = { apply: vi.fn(), checkTask: vi.fn() };
  put('tasks.md', `${list}- [ ] 1.4 Duplicate\n`);
  await expect(runTaskSessions(options(), callbacks)).rejects.toThrow(/Duplicate/);
  put('tasks.md', `${list}- [ ] Missing task number\n`);
  await expect(runTaskSessions(options(), callbacks)).rejects.toThrow(/Missing task ID/);
  put('tasks.md', list);
  symlinkSync(target('tasks.md'), target('handoff.md'));
  await expect(runTaskSessions(options(), callbacks)).rejects.toThrow(/regular task artifact/);
  expect(callbacks.apply).not.toHaveBeenCalled();
});

it('restores the accepted plan if apply deletes or rewrites a future task', async () => {
  await expect(
    runTaskSessions(options(), {
      apply: async () => {
        put(
          'tasks.md',
          list.replace('[ ] 2.3', '[x] 2.3').replace('- [ ] 1.4 Document API [REQ-API-01]', ''),
        );
        return { sessionId: 'ses-1', handoff: note('2.3') };
      },
      checkTask: vi.fn(),
    }),
  ).rejects.toThrow(/Task inventory changed/);
  expect(read('tasks.md')).toBe(list);
});
