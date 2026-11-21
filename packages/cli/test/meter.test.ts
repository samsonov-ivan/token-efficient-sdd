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
  it('replays to a separate folder, fingerprints raw inputs and detects changed bytes', async () => {
    const dir = fixture();
    const output = join(dir, 'replay');
    const first = await meterRun(dir, output);
    expect(Object.keys(first.raw_sha256)).toEqual(['raw/events.jsonl', 'raw/exports/first.json']);
    expect(first.raw_sha256['raw/events.jsonl']).toMatch(/^[0-9a-f]{64}$/);
    expect(() => readFileSync(join(dir, 'meter.json'))).toThrow();
    expect(JSON.parse(readFileSync(join(output, 'meter.json'), 'utf8'))).toEqual(first);
    appendFileSync(join(dir, 'raw/events.jsonl'), '\n');
    const next = await meterRun(dir, output);
    expect(next.rpt).toBe(first.rpt);
    expect(next.raw_sha256).not.toEqual(first.raw_sha256);
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

function relayPair() {
  const meta = {
    id: 'transport-1',
    ts: new Date(now).toISOString(),
    session_id: 'ses_root',
    user_id: 'user1',
    agent: 'build',
    requested_model: 'demo',
  };
  const usage = {
    ...providerRow.usage,
    cost: 0,
    opencode: {
      billing_source: 'go',
      list_cost: 0.00023,
      allowance: 0.00043,
      tokens: {
        input: 75,
        output: 10,
        reasoning: 2,
        cache_read: 10,
        cache_write_5m: 10,
        cache_write_1h: 5,
      },
    },
  };
  return [
    { ...meta, event: 'begin' },
    {
      ...meta,
      event: 'end',
      status: 200,
      complete: true,
      issues: [],
      upstream_id: 'upstream-1',
      model_id: 'demo',
      usage,
    },
  ];
}
function relayRun(records: unknown[]) {
  const dir = fixture();
  const path = join(dir, 'raw/exports/first.json');
  const exp = JSON.parse(readFileSync(path, 'utf8'));
  Object.assign(exp.messages[0].info, { parentID: 'user1', agent: 'build' });
  writeFileSync(path, JSON.stringify(exp));
  const manifestPath = join(dir, 'manifest.json');
  const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
  m.metering = {
    relay_required: true,
    max_balance_charge: 0,
    allowed_billing_sources: ['go', 'go-plus'],
  };
  writeFileSync(manifestPath, JSON.stringify(m));
  writeFileSync(
    join(dir, 'raw/relay.jsonl'),
    `${records.map((row) => JSON.stringify(row)).join('\n')}\n`,
  );
  return dir;
}

describe('Go transport ledger', () => {
  it('uses billed cache write breakdown and checks total, price, allowance, and original session stats separately', async () => {
    const dir = relayRun(relayPair());
    const result = await meterRun(dir);
    expect(result.issues).toEqual([]);
    expect(result).toMatchObject({
      rpt: 110,
      t_in: 75,
      t_cache_write: 15,
      cost: 0,
      relay: { requests_with_usage: 1, relative_discrepancy: 0 },
      opencode_billing: { list_cost: 0.00023, allowance: 0.00043, cache_write_reassignments: 1 },
    });
    expect(calls(dir)[0]).toMatchObject({
      raw_ref: 'raw/relay.jsonl#L2',
      source_schema: 'opencode-go-chat',
      request_id: 'upstream-1',
    });
    expect(Object.keys(result.raw_sha256)).toContain('raw/relay.jsonl');
  });
  it.each([
    'missing-response',
    'duplicate',
    'wrong-user',
    'different-output',
    'balance',
    'charged',
    'no-ledger',
    'truncated',
    'error',
  ])('blocks %s', async (problem) => {
    const [b, e] = relayPair();
    const changed = structuredClone(e) as Record<string, unknown>;
    let rows = [b, e] as unknown[];
    if (problem === 'missing-response') rows = [b];
    if (problem === 'duplicate') rows.push(e);
    if (problem === 'wrong-user')
      rows = [
        { ...b, user_id: 'unrelated' },
        { ...e, user_id: 'unrelated' },
      ];
    if (problem === 'different-output') {
      const usage = structuredClone(providerRow.usage);
      Object.assign(usage, { completion_tokens: 9, total_tokens: 109 });
      changed.usage = usage;
      rows = [b, changed];
    }
    if (problem === 'balance' || problem === 'charged') {
      const adjusted = structuredClone(e.usage);
      if (problem === 'balance') adjusted.opencode.billing_source = 'balance';
      else adjusted.cost = 0.001;
      rows = [b, { ...e, usage: adjusted }];
    }
    if (problem === 'error') rows = [b, { ...e, complete: false, issues: ['stream disconnected'] }];
    const dir = relayRun(rows);
    if (problem === 'truncated') appendFileSync(join(dir, 'raw/relay.jsonl'), '{');
    if (problem === 'no-ledger') rmSync(join(dir, 'raw/relay.jsonl'));
    const result = await meterRun(dir);
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.complete).toBe(false);
    expect(result.rpt).toBeNull();
  });
});
