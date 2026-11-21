import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { readJson, writeJson } from '../src/harness/io.js';
import { invocationStem, replay } from '../src/harness/replay.js';
import { meterRun } from '../src/meter.js';

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'frugal-replay-session-'));
  dirs.push(dir);
  function apply(task: string, args: string[]) {
    return replay(dir, 'fixture', dir, 'fixture', {
      stage: 'apply',
      task,
      args,
      fixture: { answer: `Completed ${task}` },
    });
  }
  return { dir, apply };
}

it('reconciles a retry, a second task in the same session and a fresh session, all at the same time', async () => {
  const { dir, apply } = fixture();
  const now = Date.UTC(2026, 10, 21);
  vi.spyOn(Date, 'now').mockReturnValue(now);
  const first = apply('1.1', []);
  const session = first.replaySessionId;
  const retry = apply('1.1', ['--session', session, '--', 'retry']);
  const next = apply('1.2', ['--session', session, '--', 'next']);
  const fresh = apply('1.3', []);
  expect([retry.replaySessionId, next.replaySessionId]).toEqual([session, session]);
  expect(fresh.replaySessionId).not.toBe(session);
  const stages = [first, retry, next, fresh].map((result, i) => {
    appendFileSync(join(dir, 'raw/events.jsonl'), result.stdout);
    return {
      session_id: result.replaySessionId,
      stage: 'apply',
      task: ['1.1', '1.1', '1.2', '1.3'][i],
      message_ids: [JSON.parse(result.stdout.split('\n')[0]).part.messageID],
      started_at: new Date(now).toISOString(),
      finished_at: new Date(now).toISOString(),
    };
  });
  const manifest = {
    run_id: 'fixture',
    branch: 'opt',
    dry_run: true,
    provider: 'mock',
    model: 'mock/replay',
    stages,
  };
  writeJson(join(dir, 'manifest.json'), manifest);
  const exp = readJson<{
    info: { tokens: { input: number; output: number } };
    messages: { info: { id: string } }[];
  }>(join(dir, 'raw/exports', `${session}.json`));
  expect(exp.info.tokens).toMatchObject({ input: 33, output: 15 });
  expect(new Set(exp.messages.map((m) => m.info.id))).toEqual(
    new Set(stages.slice(0, 3).flatMap((stage) => stage.message_ids)),
  );
  appendFileSync(join(dir, 'raw/events.jsonl'), retry.stdout);
  const result = await meterRun(dir);
  expect(result).toMatchObject({ complete: true, call_count: 4, rpt: 64, issues: [] });
  const calls = readFileSync(join(dir, 'calls.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  for (const s of stages)
    expect(calls.filter((c) => s.message_ids.includes(c.message_id))).toMatchObject([
      { task: s.task, stage: 'apply', session_id: s.session_id },
    ]);
  expect(await meterRun(dir)).toEqual(result);

  stages[1].message_ids.push(stages[0].message_ids[0]);
  writeJson(join(dir, 'manifest.json'), manifest);
  expect((await meterRun(dir)).issues.join(' ')).toContain('multiple stages claim message');
});

it('rejects nonexistent or malformed continuations before applying any fixture mutation', () => {
  const { dir } = fixture();
  const mutate = vi.fn();
  for (const args of [
    ['--session'],
    ['--session', 'ses_missing'],
    ['--session', '../other'],
    ['--session', 'ses_x', '--session', 'ses_y'],
  ])
    expect(() =>
      replay(dir, 'fixture', dir, 'fixture', {
        stage: 'apply',
        args,
        fixture: { answer: 'ok', mutate },
      }),
    ).toThrow(/session/);
  expect(mutate).not.toHaveBeenCalled();
});

it('keeps original stems and distinguishes task retries and literal prompt text', () => {
  const { apply } = fixture();
  expect(invocationStem({ stage: 'apply' })).toBe('apply-0');
  expect(invocationStem({ stage: 'apply', task: '2.1', attempt: 1 })).toBe('apply-2.1');
  expect(invocationStem({ stage: 'apply', task: '2.1', attempt: 2 })).toBe('apply-2.1-attempt-2');
  expect(() => invocationStem({ stage: 'apply', attempt: 0 })).toThrow(/attempt/);
  const first = apply('1.1', []);
  const fresh = apply('1.1', ['--', '--session', first.replaySessionId]);
  expect(fresh.replaySessionId).not.toBe(first.replaySessionId);
});

it('flags a nested call whose parent session spans multiple tasks with no distinguishing timestamp', async () => {
  const { dir, apply } = fixture();
  const first = apply('1.1', []);
  const next = apply('1.2', ['--session', first.replaySessionId]);
  const child = apply('child', []);
  const file = join(dir, 'raw/exports', `${child.replaySessionId}.json`);
  const exported = readJson<{ info: { id: string; parentID?: string } }>(file);
  exported.info.parentID = first.replaySessionId;
  writeJson(file, exported);
  const stages = [first, next].map((result, index) => ({
    stage: 'apply',
    task: `1.${index + 1}`,
    session_id: result.replaySessionId,
    message_ids: [JSON.parse(result.stdout.split('\n')[0]).part.messageID],
  }));
  appendFileSync(join(dir, 'raw/events.jsonl'), first.stdout + next.stdout);
  writeJson(join(dir, 'manifest.json'), {
    run_id: 'fixture',
    branch: 'opt',
    dry_run: true,
    provider: 'mock',
    model: 'mock/replay',
    stages,
  });
  const result = await meterRun(dir);
  expect(result).toMatchObject({ complete: false, rpt: null, known_rpt: 48, call_count: 3 });
  expect(result.issues.join(' ')).toContain('ambiguous stage');
});
