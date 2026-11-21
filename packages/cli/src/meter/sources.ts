import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { count, type Entry, id, normalize, record, type Tokens, timestamp } from './usage.js';

export interface Observation {
  key: string;
  session: string;
  message: string | null;
  model: string | null;
  provider: string | null;
  ts: string | null;
  schema: string;
  ref: string;
  raw: Entry;
  cost: number | null;
  tokens: Tokens | null;
  origin: 'event' | 'storage' | 'provider';
  attempt: number;
  request: string | null;
}

export class Inputs {
  readonly rows: Observation[] = [];
  readonly issues = new Set<string>();
  readonly parents = new Map<string, string | null>();
  readonly totals: { session: string; tokens: Tokens; ref: string }[] = [];
  readonly started = new Map<string, string>();
  readonly assistant = new Map<
    string,
    { session: string; model: string | null; provider: string | null }
  >();
  readonly providerIds = new Map<string, string>();
  readonly retryRefs = new Map<string, string>();
  readonly providerStandalone = new Set<string>();
  readonly syntheticTaskMessages = new Set<string>();
  hasDb = false;
  hasExport = false;
  hasEvents = false;
  hasProvider = false;

  checked(ref: string, action: () => void) {
    try {
      action();
    } catch (error) {
      this.issues.add(
        `${ref}: ${error instanceof SyntaxError ? 'invalid JSON' : error instanceof Error ? error.message : 'invalid record'}`,
      );
    }
  }

  session(value: Entry, ref: string) {
    const session = id(value.id);
    const parent = value.parentID == null ? null : id(value.parentID);
    if (this.parents.has(session) && this.parents.get(session) !== parent)
      this.issues.add(`${ref}: conflicting session parent`);
    this.parents.set(session, parent);
    if (value.tokens)
      this.totals.push({ session, tokens: normalize('opencode-v1', value.tokens), ref });
  }

  message(value: Entry, session: string, ref: string) {
    if (value.role !== 'assistant') return;
    const key = id(value.id);
    const meta = { session, model: asText(value.modelID), provider: asText(value.providerID) };
    const previous = this.assistant.get(key);
    if (previous && JSON.stringify(previous) !== JSON.stringify(meta))
      this.issues.add(`${ref}: conflicting assistant metadata`);
    this.assistant.set(key, meta);
    if (value.error) this.issues.add(`${ref}: assistant error requires billing reconciliation`);
  }

  part(value: Entry, ref: string, origin: 'event' | 'storage', time: unknown) {
    const session = id(value.sessionID);
    const message = id(value.messageID);
    if (value.type === 'tool' && value.tool === 'task') {
      this.syntheticTaskMessages.add(message);
      return;
    }
    if (value.type === 'retry') {
      this.retryRefs.set(id(value.id), ref);
      return;
    }
    if (value.type === 'step-start') {
      this.started.set(id(value.id), message);
      return;
    }
    if (value.type !== 'step-finish') return;
    const key = id(value.id);
    const raw = record(value.tokens ?? {});
    let tokens: Tokens | null = null;
    this.checked(ref, () => {
      tokens = normalize('opencode-v1', raw);
    });
    this.rows.push({
      key,
      session,
      message,
      model: null,
      provider: null,
      ts: timestamp(time),
      schema: 'opencode-v1',
      ref,
      raw,
      cost: money(value.cost),
      tokens,
      origin,
      attempt: 1,
      request: null,
    });
  }

  provider(value: Entry, ref: string) {
    // A transport ledger must label service calls and billed retries explicitly.
    // No matching by timing or usage size: equal-size calls can be distinct.
    const request = id(value.request_id);
    const schema = id(value.source_schema);
    const session = id(value.session_id);
    const standalone = value.kind === 'service' || value.kind === 'retry';
    const key = standalone ? `provider:${request}` : id(value.part_id);
    const previous = this.providerIds.get(request);
    if (previous && previous !== key) this.issues.add(`${ref}: request linked to two calls`);
    this.providerIds.set(request, key);
    if (standalone) this.providerStandalone.add(key);
    if (value.retry_part_id) this.retryRefs.delete(id(value.retry_part_id));
    const raw = record(value.usage ?? {});
    let tokens: Tokens | null = null;
    this.checked(ref, () => {
      tokens = normalize(schema, raw);
    });
    const attempt = count(value.attempt ?? 1);
    if (!attempt) throw new Error('attempt must be positive');
    this.rows.push({
      key,
      session,
      message: asText(value.message_id),
      model: id(value.model_id),
      provider: id(value.provider_id),
      ts: timestamp(value.ts),
      schema,
      ref,
      raw,
      cost: money(value.cost),
      tokens,
      origin: 'provider',
      attempt,
      request,
    });
  }
}

function asText(value: unknown) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
function money(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function rawFiles(root: string, file: string, folder: string, extension: string) {
  const all: string[] = [];
  if (existsSync(join(root, file))) all.push(file);
  if (existsSync(join(root, folder))) {
    for (const s of readdirSync(join(root, folder)).sort())
      if (s.endsWith(extension)) all.push(`${folder}/${s}`);
  }
  return all;
}

function readExport(data: Inputs, source: Entry, file: string) {
  const info = record(source.info);
  const session = id(info.id);
  data.session(info, `${file}#/info`);
  if (!Array.isArray(source.messages)) throw new Error('missing messages');
  for (const [i, entry] of source.messages.entries()) {
    const message = record(entry);
    const detail = record(message.info);
    const ref = `${file}#/messages/${i}`;
    data.message(detail, session, ref);
    if (!Array.isArray(message.parts)) throw new Error('missing parts');
    for (const [j, entryPart] of message.parts.entries()) {
      const part = record(entryPart);
      if (
        ['retry', 'step-start', 'step-finish'].includes(String(part.type)) ||
        (part.type === 'tool' && part.tool === 'task')
      ) {
        data.part(
          { ...part, sessionID: part.sessionID ?? session, messageID: part.messageID ?? detail.id },
          `${ref}/parts/${j}`,
          'storage',
          record(detail.time ?? {}).completed,
        );
      }
    }
  }
  data.hasExport = true;
}

function readDatabase(data: Inputs, root: string) {
  const file = 'raw/opencode.db';
  const path = join(root, file);
  if (existsSync(`${path}-wal`) && statSync(`${path}-wal`).size > 0) {
    throw new Error('snapshot has an uncheckpointed WAL; export a consistent SQLite backup');
  }
  const uri = pathToFileURL(path);
  uri.searchParams.set('immutable', '1');
  // Query only usage and attribution. Avoid reading prompts, entire outputs, or unrelated tool data.
  const query = (sql: string): Entry[] => {
    const out = execFileSync('sqlite3', ['-readonly', '-batch', '-json', uri.href, sql], {
      encoding: 'utf8',
      maxBuffer: 128 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return JSON.parse(out || '[]').map(record);
  };
  for (const row of query(
    'SELECT id,parent_id,tokens_input,tokens_output,tokens_reasoning,tokens_cache_read,tokens_cache_write FROM session ORDER BY id',
  )) {
    data.session(
      {
        id: row.id,
        parentID: row.parent_id,
        tokens: {
          input: row.tokens_input,
          output: row.tokens_output,
          reasoning: row.tokens_reasoning,
          cache: { read: row.tokens_cache_read, write: row.tokens_cache_write },
        },
      },
      `${file}#session/${row.id}`,
    );
  }
  for (const row of query(
    "SELECT id,session_id,json_extract(data,'$.modelID') AS modelID,json_extract(data,'$.providerID') AS providerID,json_type(data,'$.error') AS errorType FROM message WHERE json_extract(data,'$.role')='assistant' ORDER BY id",
  )) {
    data.message(
      { ...row, error: row.errorType != null && row.errorType !== 'null', role: 'assistant' },
      id(row.session_id),
      `${file}#message/${row.id}`,
    );
  }
  for (const row of query(
    "SELECT id,message_id,session_id,time_created,json_extract(data,'$.type') AS type,json_extract(data,'$.tool') AS tool,json_extract(data,'$.cost') AS cost,json_extract(data,'$.tokens') AS tokens FROM part WHERE json_extract(data,'$.type') IN ('step-finish','step-start','retry') OR (json_extract(data,'$.type')='tool' AND json_extract(data,'$.tool')='task') ORDER BY id",
  )) {
    const ref = `${file}#part/${row.id}`;
    data.checked(ref, () =>
      data.part(
        {
          ...row,
          sessionID: row.session_id,
          messageID: row.message_id,
          tokens: row.tokens == null ? undefined : JSON.parse(id(row.tokens)),
        },
        ref,
        'storage',
        row.time_created,
      ),
    );
  }
  data.hasDb = true;
}

async function lines(
  data: Inputs,
  root: string,
  file: string,
  visit: (row: Entry, ref: string) => void,
) {
  const stream = createInterface({
    input: createReadStream(join(root, file)),
    crlfDelay: Infinity,
  });
  let lineNumber = 0;
  for await (const line of stream) {
    lineNumber++;
    if (!line.trim()) continue;
    const ref = `${file}#L${lineNumber}`;
    data.checked(ref, () => visit(record(JSON.parse(line)), ref));
  }
}

export async function collect(root: string) {
  const data = new Inputs();
  for (const file of rawFiles(root, 'raw/events.jsonl', 'raw/events', '.jsonl')) {
    await lines(data, root, file, (event, ref) => {
      data.hasEvents = true;
      if (event.type === 'error')
        data.issues.add(`${ref}: CLI error requires billing reconciliation`);
      if (event.type !== 'step_start' && event.type !== 'step_finish') return;
      const part = record(event.part);
      if (
        part.type !== String(event.type).replace('_', '-') ||
        (event.sessionID && part.sessionID && event.sessionID !== part.sessionID)
      )
        throw new Error('inconsistent CLI step envelope');
      data.part(
        { ...part, sessionID: part.sessionID ?? event.sessionID },
        ref,
        'event',
        event.timestamp,
      );
    });
  }
  if (existsSync(join(root, 'raw/opencode.db')))
    data.checked('raw/opencode.db', () => readDatabase(data, root));
  for (const file of rawFiles(root, 'raw/export.json', 'raw/exports', '.json')) {
    data.checked(file, () =>
      readExport(data, record(JSON.parse(readFileSync(join(root, file), 'utf8'))), file),
    );
  }
  if (existsSync(join(root, 'raw/provider.jsonl'))) {
    data.hasProvider = true;
    await lines(data, root, 'raw/provider.jsonl', (row, ref) => data.provider(row, ref));
  }
  return data;
}
