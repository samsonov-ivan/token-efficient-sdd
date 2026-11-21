import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { collect, type Inputs, type Observation, sourceHashes } from './meter/sources.js';
import {
  type Entry,
  equal,
  fields,
  id,
  record,
  rpt,
  type Tokens,
  timestamp,
} from './meter/usage.js';

interface Stage {
  stage: string;
  task: string | null;
  review_iter: number | null;
  start: string | null;
  end: string | null;
}
const other: Stage = { stage: 'other', task: null, review_iter: null, start: null, end: null };
const stages = new Set([
  'spec',
  'propose',
  'specs',
  'design',
  'tasks',
  'apply',
  'review',
  'fix',
  'verify',
  'other',
]);
function stageMap(manifest: Entry) {
  const result = new Map<string, Stage[]>();
  function add(session: unknown, info: Entry) {
    if (session == null) return;
    const name = info.stage ?? info.name;
    const mapped = name === 'implement' ? 'apply' : name === 'proposal' ? 'propose' : String(name);
    const stage = stages.has(mapped) ? mapped : 'other';
    const task = info.task ?? info.task_id;
    const iter = info.review_iter ?? info.iter ?? info.review_round;
    const item = {
      stage,
      task: typeof task === 'string' ? task : null,
      review_iter: typeof iter === 'number' ? iter : null,
      start: timestamp(info.started_at),
      end: timestamp(info.finished_at ?? info.ended_at),
    };
    const key = id(session);
    const list = result.get(key) ?? [];
    list.push(item);
    result.set(key, list);
  }
  if (Array.isArray(manifest.stages))
    for (const row of manifest.stages) {
      const info = record(row);
      add(info.session_id, info);
    }
  for (const [key, v] of Object.entries(record(manifest.sessions ?? {}))) {
    if (!result.has(key)) add(key, record(v));
  }
  return result;
}

function findStage(
  map: Map<string, Stage[]>,
  data: Inputs,
  session: string,
  ts: string | null,
): Stage {
  const visited = new Set<string>();
  let current: string | null = session;
  while (current != null) {
    if (visited.has(current)) {
      data.issues.add(`session/${session}: cycle in session tree`);
      return other;
    }
    visited.add(current);
    const all = map.get(current);
    if (all?.length) {
      const options =
        all.length === 1
          ? all
          : all.filter(
              (s) => ts && (s.start === null || s.start <= ts) && (s.end === null || ts <= s.end),
            );
      if (options.length === 1) return options[0];
      const ambiguous = options.length ? options : all;
      if (ambiguous.every((s) => ['propose', 'specs', 'design', 'tasks', 'spec'].includes(s.stage)))
        return { ...other, stage: 'spec' };
      return other;
    }
    current = data.parents.get(current) ?? null;
  }
  return other;
}

function ledger(manifest: Entry, data: Inputs) {
  const map = stageMap(manifest);
  const run = id(manifest.run_id),
    branch = id(manifest.branch);
  const provider = id(manifest.provider_id ?? manifest.provider);
  const fullModel = id(manifest.model);
  const model =
    typeof manifest.model_id === 'string'
      ? manifest.model_id
      : fullModel.startsWith(`${provider}/`)
        ? fullModel.slice(provider.length + 1)
        : fullModel;
  const groups = new Map<string, Observation[]>();
  for (const row of data.rows) {
    const group = groups.get(row.key) ?? [];
    group.push(row);
    groups.set(row.key, group);
  }
  const observedSessions = new Set<string>();
  const finishByMessage = new Map<string, number>();
  const tokensBySession = new Map<string, Tokens>();
  const calls = [];
  for (const [key, rows] of [...groups.entries()].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    const first = rows[0];
    const hasStorage = rows.some((row) => row.origin === 'storage');
    const hasProvider = rows.some((row) => row.origin === 'provider');
    const hasEvent = rows.some((row) => row.origin === 'event');
    const standalone = data.providerStandalone.has(key);
    const linkedProvider = rows.find((row) => row.origin === 'provider');
    const message = first.message;
    const actual = message == null ? undefined : data.assistant.get(message);
    const actualProvider = actual?.provider ?? linkedProvider?.provider ?? null;
    const actualModel = actual?.model ?? linkedProvider?.model ?? null;
    if (actual?.session && actual.session !== first.session)
      data.issues.add(`${key}: assistant belongs to a different session`);
    if (actualModel !== model || actualProvider !== provider)
      data.issues.add(`${key}: unconfirmed or different model/provider`);
    if (hasEvent && !hasStorage) data.issues.add(`${key}: CLI step missing from storage`);
    if (hasStorage && !hasEvent && map.has(first.session) && !data.parents.get(first.session))
      data.issues.add(`${key}: root step missing from CLI stream`);
    if (data.hasProvider && !hasProvider)
      data.issues.add(`${key}: step missing from provider ledger`);
    if (hasProvider && !standalone && !hasStorage && !hasEvent)
      data.issues.add(`${key}: provider step missing from opencode sources`);
    const go = rows.find((row) => row.origin === 'provider' && row.schema === 'opencode-go-chat');
    const known = go?.tokens ?? rows.find((row) => row.tokens !== null)?.tokens ?? null;
    const reference = go ?? first;
    let cacheReassigned = false;
    let conflict = false;
    const costs = new Set(
      rows.filter((r) => r.origin !== 'provider' && r.cost !== null).map((r) => r.cost),
    );
    if (costs.size > 1) conflict = true;
    const requests = new Set(rows.map((r) => r.request).filter((r) => r !== null));
    if (requests.size > 1) conflict = true;
    for (const row of rows) {
      if (
        row.session !== first.session ||
        (message && row.message && row.message !== message) ||
        (row.model && row.model !== actualModel) ||
        (row.provider && row.provider !== actualProvider)
      )
        conflict = true;
      if (known && row.tokens && !equal(known, row.tokens)) {
        // V1 assigns gateway cache writes to uncached input. Accept only that exact
        // redistribution when the independent API response exposes the billing components.
        const stored = row.tokens;
        const compatible =
          go &&
          row.origin !== 'provider' &&
          stored.t_cache_write === 0 &&
          known.t_cache_write > 0 &&
          stored.t_in === known.t_in + known.t_cache_write &&
          stored.t_cache_read === known.t_cache_read &&
          stored.t_out === known.t_out &&
          stored.t_reasoning === known.t_reasoning;
        if (compatible) cacheReassigned = true;
        else conflict = true;
      }
    }
    const usage = conflict ? 'conflict' : !known || rpt(known) === 0 ? 'unknown' : 'known';
    if (usage !== 'known') data.issues.add(`${key}: ${usage} usage`);
    const ts = first.ts ?? rows.find((r) => r.ts !== null)?.ts ?? null;
    const stage = findStage(map, data, first.session, ts);
    const countable = usage === 'known' ? known : null;
    if (message && !standalone)
      finishByMessage.set(message, (finishByMessage.get(message) ?? 0) + 1);
    const storedTokens = rows.find((row) => row.origin === 'storage' && row.tokens)?.tokens;
    if (storedTokens && countable) {
      const previous = tokensBySession.get(first.session) ?? emptyTokens();
      for (const f of fields) previous[f] += storedTokens[f];
      tokensBySession.set(first.session, previous);
    }
    observedSessions.add(first.session);
    const tokens = countable ?? {
      t_in: null,
      t_cache_read: null,
      t_cache_write: null,
      t_out: null,
      t_reasoning: null,
    };
    calls.push({
      run_id: run,
      branch,
      model: actualProvider && actualModel ? `${actualProvider}/${actualModel}` : null,
      model_id: actualModel,
      provider_id: actualProvider,
      stage: stage.stage,
      task: stage.task,
      review_iter: stage.review_iter,
      session_id: first.session,
      message_id: message,
      parent_session_id: data.parents.get(first.session) ?? null,
      event_key: key,
      request_id: linkedProvider?.request ?? null,
      attempt: linkedProvider?.attempt ?? 1,
      source_schema: reference.schema,
      usage_status: usage,
      ts,
      ...tokens,
      cost: conflict ? null : (linkedProvider?.cost ?? [...costs][0] ?? null),
      ...(go
        ? { billing: record(go.raw.opencode), gateway_cache_write_reassigned: cacheReassigned }
        : {}),
      raw_ref: reference.ref,
      raw: reference.raw,
      sources: [...new Set(rows.map((row) => row.ref))].sort(),
    });
  }
  const starts = new Map<string, number>();
  for (const message of data.started.values()) starts.set(message, (starts.get(message) ?? 0) + 1);
  for (const [message, n] of starts)
    if ((finishByMessage.get(message) ?? 0) < n) data.issues.add(`${message}: unfinished step`);
  for (const message of data.assistant.keys()) {
    if (!finishByMessage.has(message) && !data.syntheticTaskMessages.has(message))
      data.issues.add(`${message}: assistant message has no measured step`);
  }
  for (const ref of data.retryRefs.values()) data.issues.add(`${ref}: retry billing unknown`);
  for (const [session, rows] of map) {
    if (rows.length && !observedSessions.has(session))
      data.issues.add(`session/${session}: registered session has no measured calls`);
  }
  for (const checkpoint of data.totals) {
    const rebuilt = tokensBySession.get(checkpoint.session) ?? emptyTokens();
    if (!equal(checkpoint.tokens, rebuilt))
      data.issues.add(`${checkpoint.ref}: session totals disagree with step parts`);
  }
  for (const session of observedSessions) {
    if (!data.parents.has(session) && !data.hasProvider)
      data.issues.add(`session/${session}: missing session metadata`);
    if (data.parents.has(session) && !data.parents.get(session) && !map.has(session))
      data.issues.add(`session/${session}: unregistered root session in isolated store`);
  }
  return calls;
}

function emptyTokens(): Tokens {
  return { t_in: 0, t_cache_read: 0, t_cache_write: 0, t_out: 0, t_reasoning: 0 };
}

type Calls = ReturnType<typeof ledger>;
function totals(calls: Calls) {
  const tokens = emptyTokens();
  let knownCost = 0,
    unknownCost = false,
    allKnown = true,
    peak = 0;
  for (const call of calls) {
    if (call.usage_status !== 'known') allKnown = false;
    for (const f of fields) tokens[f] += call[f] ?? 0;
    peak = Math.max(peak, (call.t_in ?? 0) + (call.t_cache_read ?? 0) + (call.t_cache_write ?? 0));
    if (call.cost === null) unknownCost = true;
    else knownCost += call.cost;
  }
  const known = rpt(tokens);
  const denominator = tokens.t_in + tokens.t_cache_read;
  return {
    ...tokens,
    rpt: allKnown ? known : null,
    known_rpt: known,
    cost: unknownCost ? null : knownCost,
    call_count: calls.length,
    peak_context: peak,
    cache_hit_fraction: denominator ? tokens.t_cache_read / denominator : null,
  };
}

export async function meterRun(runDir: string, outputDir = runDir) {
  const manifest = record(JSON.parse(readFileSync(join(runDir, 'manifest.json'), 'utf8')));
  const inputHashes = await sourceHashes(runDir);
  const data = await collect(runDir, id(manifest.provider_id ?? manifest.provider));
  const rules = record(manifest.metering ?? {});
  if (rules.relay_required === true && !data.hasRelay)
    data.issues.add('required raw/relay.jsonl is missing');
  if (JSON.stringify(inputHashes) !== JSON.stringify(await sourceHashes(runDir)))
    data.issues.add('raw inputs changed during import');
  const dry_run = manifest.dry_run === true;
  const calls = ledger(manifest, data);
  const providerRows = new Map(
    data.rows.filter((r) => r.origin === 'provider').map((r) => [r.request, r]),
  );
  const providerRpt = [...providerRows.values()].reduce(
    (sum, row) => sum + (row.tokens ? rpt(row.tokens) : 0),
    0,
  );
  const goCalls = calls.filter((c) => c.billing);
  const billingSum = (key: string) =>
    goCalls.length && goCalls.every((c) => typeof c.billing?.[key] === 'number')
      ? goCalls.reduce((sum, call) => sum + Number(call.billing?.[key]), 0)
      : null;
  if (!data.hasEvents) data.issues.add('missing nonempty CLI event stream');
  if (!data.hasDb && !(dry_run && data.hasExport))
    data.issues.add('missing usable isolated opencode.db');
  if (!calls.length) data.issues.add('no measured calls');
  if (!dry_run && !data.hasProvider && record(manifest.metering ?? {}).title_disabled !== true)
    data.issues.add('background title usage unverified');
  if (Array.isArray(rules.allowed_billing_sources) || rules.max_balance_charge != null) {
    let charge = 0;
    for (const call of calls) {
      if (
        Array.isArray(rules.allowed_billing_sources) &&
        !rules.allowed_billing_sources.includes(call.billing?.billing_source)
      )
        data.issues.add(`${call.event_key}: missing or unauthorized billing source`);
      if (
        rules.max_balance_charge != null &&
        (call.billing == null ||
          typeof call.raw.cost !== 'number' ||
          !Number.isFinite(call.raw.cost) ||
          call.raw.cost < 0)
      )
        data.issues.add(`${call.event_key}: missing or invalid provider balance charge`);
      else charge += Number(call.raw.cost ?? 0);
    }
    if (typeof rules.max_balance_charge === 'number' && charge > rules.max_balance_charge)
      data.issues.add('provider balance charge exceeds run limit');
  }
  const issues = [...data.issues].sort();
  const complete = issues.length === 0;
  const sums = totals(calls);
  const names = [...new Set(calls.map((c) => c.stage))].sort();
  const by_stage = Object.fromEntries(
    names.map((name) => [name, totals(calls.filter((c) => c.stage === name))]),
  );
  const callText = calls.map((c) => `${JSON.stringify(c)}\n`).join('');
  const columns = ['stage', 'rpt', 'known_rpt', 'call_count', ...fields, 'cost'];
  const csv = `${[
    columns.join(','),
    ...Object.entries(by_stage).map(([stage, sum]) =>
      [stage, sum.rpt, sum.known_rpt, sum.call_count, ...fields.map((f) => sum[f]), sum.cost].join(
        ',',
      ),
    ),
  ].join('\n')}\n`;
  const hash = (str: string) => createHash('sha256').update(str).digest('hex');
  const result = {
    run_id: id(manifest.run_id),
    dry_run,
    complete,
    issues,
    ...sums,
    rpt: complete ? sums.rpt : null,
    cost: complete ? sums.cost : null,
    by_stage,
    coverage: data.hasProvider ? 'provider-ledger' : 'opencode-only',
    ...(data.hasRelay
      ? {
          relay: {
            requests_with_usage: providerRows.size,
            known_rpt: providerRpt,
            relative_discrepancy:
              complete && providerRpt > 0
                ? Math.abs(sums.known_rpt - providerRpt) / providerRpt
                : null,
          },
        }
      : {}),
    ...(goCalls.length
      ? {
          opencode_billing: {
            list_cost: billingSum('list_cost'),
            allowance: billingSum('allowance'),
            cache_write_reassignments: goCalls.filter((c) => c.gateway_cache_write_reassigned)
              .length,
          },
        }
      : {}),
    raw_sha256: inputHashes,
    sha256: { 'calls.jsonl': hash(callText), 'stages.csv': hash(csv) },
  };
  mkdirSync(outputDir, { recursive: true });
  const write = (file: string, content: string) => {
    const tmp = join(outputDir, `.${file}.${randomUUID()}.tmp`);
    writeFileSync(tmp, content, { flag: 'wx' });
    renameSync(tmp, join(outputDir, file));
  };
  write('calls.jsonl', callText);
  write('stages.csv', csv);
  write('meter.json', `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

export async function meter(argv: string[]): Promise<number> {
  const [input, flag, destination] = argv;
  if (
    !input ||
    input.startsWith('-') ||
    (argv.length !== 1 && !(argv.length === 3 && flag === '--out' && destination))
  )
    throw new Error('Usage: frugal meter <run-dir> [--out <dir>]');
  const result = await meterRun(input, destination);
  console.log(JSON.stringify(result));
  return result.complete ? 0 : 1;
}
