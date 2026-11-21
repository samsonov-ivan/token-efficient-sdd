import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { normalize } from '../src/meter/usage.js';
import { meterRun } from '../src/meter.js';

const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const now = 1788000000000;
const units = { input: 90, output: 8, reasoning: 2, cache: { read: 10, write: 0 }, total: 110 };

function step(sessionID: string, name: string, tokens = units) {
  return {
    id: `prt_${name}`,
    sessionID,
    messageID: `msg_${name}`,
    type: 'step-finish',
    tokens,
    cost: 0.15,
  };
}
function envelope(part: ReturnType<typeof step>) {
  return `${JSON.stringify({ type: 'step_finish', sessionID: part.sessionID, timestamp: now, part })}\n`;
}
function exported(session: string, name: string, parent?: string) {
  const p = step(session, name);
  return {
    info: { id: session, parentID: parent, tokens: units },
    messages: [
      {
        info: {
          id: p.messageID,
          role: 'assistant',
          modelID: 'demo',
          providerID: 'local',
          time: { completed: now },
        },
        parts: [p],
      },
    ],
  };
}
function fixture(withChild = false) {
  const dir = mkdtempSync(join(tmpdir(), 'frugal-meter-'));
  created.push(dir);
  mkdirSync(join(dir, 'raw/exports'), { recursive: true });
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({
      run_id: 'r',
      branch: 'base',
      model: 'local/demo',
      provider: 'local',
      dry_run: true,
      stages: [{ stage: 'apply', task: '2.1', session_id: 'ses_root' }],
    }),
  );
  writeFileSync(join(dir, 'raw/events.jsonl'), envelope(step('ses_root', 'first')));
  writeFileSync(join(dir, 'raw/exports/first.json'), JSON.stringify(exported('ses_root', 'first')));
  if (withChild)
    writeFileSync(
      join(dir, 'raw/exports/second.json'),
      JSON.stringify(exported('ses_child', 'second', 'ses_root')),
    );
  return dir;
}
function calls(dir: string) {
  return readFileSync(join(dir, 'calls.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}
const providerRow = {
  request_id: 'req-1',
  session_id: 'ses_root',
  part_id: 'prt_first',
  message_id: 'msg_first',
  model_id: 'demo',
  provider_id: 'local',
  source_schema: 'openai-chat',
  ts: now,
  usage: {
    prompt_tokens: 100,
    prompt_tokens_details: { cached_tokens: 10 },
    completion_tokens: 10,
    completion_tokens_details: { reasoning_tokens: 2 },
    total_tokens: 110,
  },
};

describe('token semantics', () => {
  it('subtracts OpenAI cache reads and overlapping reasoning exactly once', () => {
    expect(normalize('openai-chat', providerRow.usage)).toEqual({
      t_in: 90,
      t_cache_read: 10,
      t_cache_write: 0,
      t_out: 8,
      t_reasoning: 2,
    });
  });
  it('preserves Anthropic non-cached input and cache writes/reads separately', () => {
    expect(
      normalize('anthropic-messages', {
        input_tokens: 2,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 23,
        output_tokens: 8,
      }),
    ).toEqual({ t_in: 2, t_cache_read: 100, t_cache_write: 23, t_out: 8, t_reasoning: 0 });
  });
  it.each([
    { ...units, output: -1 },
    { ...units, total: 190 },
    { ...units, reasoning: null },
  ])('rejects incomplete/impossible counters', (units) =>
    expect(() => normalize('opencode-v1', units)).toThrow(),
  );
});

describe('offline reconciliation', () => {
  it('counts a repeated CLI step once, includes nested calls and preserves stable output', async () => {
    const dir = fixture(true);
    appendFileSync(join(dir, 'raw/events.jsonl'), envelope(step('ses_root', 'first')));
    const summary = await meterRun(dir);
    expect(summary.issues).toEqual([]);
    expect(summary).toMatchObject({
      complete: true,
      rpt: 220,
      call_count: 2,
      cost: 0.3,
      by_stage: { apply: { rpt: 220 } },
    });
    const before = readFileSync(join(dir, 'calls.jsonl'), 'utf8');
    expect(calls(dir)[1]).toMatchObject({
      task: '2.1',
      stage: 'apply',
      parent_session_id: 'ses_root',
      raw_ref: 'raw/exports/second.json#/messages/0/parts/0',
    });
    expect(await meterRun(dir)).toEqual(summary);
    expect(readFileSync(join(dir, 'calls.jsonl'), 'utf8')).toBe(before);
  });
  it('keeps a truncated attempt visible and refuses a total', async () => {
    const dir = fixture();
    appendFileSync(join(dir, 'raw/events.jsonl'), '{');
    expect(await meterRun(dir)).toMatchObject({
      complete: false,
      rpt: null,
      known_rpt: 110,
      issues: ['raw/events.jsonl#L2: invalid JSON'],
    });
  });
  it('reports divergent counters for a stable call ID without double counting', async () => {
    const dir = fixture(true);
    const changed = step('ses_root', 'first', { ...units, input: 91, total: 111 });
    appendFileSync(join(dir, 'raw/events.jsonl'), envelope(changed));
    const result = await meterRun(dir);
    expect(result).toMatchObject({ complete: false, rpt: null, known_rpt: 110, call_count: 2 });
    expect(calls(dir)[0].usage_status).toBe('conflict');
  });
  it('rejects omitted and unconfirmed zero usage', async () => {
    const dir = fixture();
    const p = step('ses_root', 'first', {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
      total: 0,
    });
    writeFileSync(join(dir, 'raw/events.jsonl'), envelope(p));
    const exp = exported('ses_root', 'first');
    exp.info.tokens = p.tokens;
    exp.messages[0].parts = [p];
    writeFileSync(join(dir, 'raw/exports/first.json'), JSON.stringify(exp));
    expect(await meterRun(dir)).toMatchObject({ complete: false, rpt: null });
    expect(calls(dir)[0].usage_status).toBe('unknown');
  });
  it('checks real model identity across the isolated session tree', async () => {
    const dir = fixture(true);
    const child = exported('ses_child', 'second', 'ses_root');
    child.messages[0].info.modelID = 'other';
    writeFileSync(join(dir, 'raw/exports/second.json'), JSON.stringify(child));
    const result = await meterRun(dir);
    expect(result.complete).toBe(false);
    expect(result.issues.join(' ')).toContain('different model');
    expect(calls(dir)[1].model).toBe('local/other');
  });
  it('joins a request ledger and counts billed retry and detached service calls', async () => {
    const dir = fixture();
    const retry = {
      ...providerRow,
      request_id: 'req-2',
      part_id: null,
      message_id: null,
      attempt: 2,
      kind: 'retry',
    };
    const title = { ...retry, request_id: 'req-3', kind: 'service', attempt: 1 };
    writeFileSync(
      join(dir, 'raw/provider.jsonl'),
      [providerRow, retry, title, title].map((r) => JSON.stringify(r)).join('\n'),
    );
    const result = await meterRun(dir);
    expect(result.issues).toEqual([]);
    expect(result).toMatchObject({
      complete: true,
      call_count: 3,
      rpt: 330,
      coverage: 'provider-ledger',
    });
    expect(calls(dir).map((c) => c.attempt)).toContain(2);
  });
  it('flags interrupted steps, dangling source exports and different session sums', async () => {
    const dir = fixture();
    appendFileSync(
      join(dir, 'raw/events.jsonl'),
      `${JSON.stringify({ type: 'step_start', timestamp: now, sessionID: 'ses_root', part: { sessionID: 'ses_root', id: 'prt_interrupt', messageID: 'msg_lost', type: 'step-start' } })}\n`,
    );
    const exp = exported('ses_root', 'first');
    exp.info.tokens = { ...units, input: 91, total: 111 };
    writeFileSync(join(dir, 'raw/exports/first.json'), JSON.stringify(exp));
    const { issues, rpt } = await meterRun(dir);
    expect(rpt).toBeNull();
    expect(issues.some((x) => x.includes('unfinished step'))).toBe(true);
    expect(issues.some((x) => x.includes('session totals disagree'))).toBe(true);
  });
  it('reads actual SQLite tables in readonly mode, counts child rows once across DB & export', async () => {
    const dir = fixture(true);
    const db = join(dir, 'raw/opencode.db');
    const sql = [
      'CREATE TABLE session(id TEXT,parent_id TEXT,tokens_input INTEGER,tokens_output INTEGER,tokens_reasoning INTEGER,tokens_cache_read INTEGER,tokens_cache_write INTEGER)',
      'CREATE TABLE message(id TEXT,session_id TEXT,data TEXT)',
      'CREATE TABLE part(id TEXT,message_id TEXT,session_id TEXT,time_created INTEGER,data TEXT)',
    ];
    for (const [session, name, parent] of [
      ['ses_root', 'first', null],
      ['ses_child', 'second', 'ses_root'],
    ] as const) {
      const p = step(session, name);
      sql.push(
        `INSERT INTO session VALUES('${session}',${parent ? `'${parent}'` : 'NULL'},90,8,2,10,0)`,
        `INSERT INTO message VALUES('${p.messageID}','${session}','{"role":"assistant","modelID":"demo","providerID":"local"}')`,
        `INSERT INTO part VALUES('${p.id}','${p.messageID}','${session}',${now},'${JSON.stringify(p)}')`,
      );
    }
    execFileSync('sqlite3', [db], { input: `${sql.join(';')};`, encoding: 'utf8' });
    const result = await meterRun(dir);
    expect(result.issues).toEqual([]);
    expect(result).toMatchObject({ call_count: 2, rpt: 220 });
    expect(calls(dir)[0].sources).toContain('raw/opencode.db#part/prt_first');
  });
});
