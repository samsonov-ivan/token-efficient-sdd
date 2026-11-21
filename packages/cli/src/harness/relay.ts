import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { closeSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { type GoVariant, isGoVariant } from './go.js';

const GO = 'https://opencode.ai/inference/go/openai/v1';
const CHAT = '/chat/completions';
const MAX_BODY = 32 * 1024 * 1024;
const MAX_EVENT = 4 * 1024 * 1024;
const HOP_HEADERS = [
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];

type Json = Record<string, unknown>;
type Options = { runDir: string; model: string; variant?: GoVariant } & (
  | { fixture: true; upstream: string }
  | { fixture?: false; apiKey: string }
);

function object(value: unknown): Json | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null;
}

function fixtureURL(base: string): URL {
  const url = new URL(base);
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    !url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('Relay fixtures require an explicit loopback HTTP URL');
  url.pathname = url.pathname.replace(/\/$/, '') + CHAT;
  return url;
}

function authorized(value: string | undefined, token: string): boolean {
  const supplied = Buffer.from(value ?? '');
  const expected = Buffer.from(`Bearer ${token}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function sendError(res: ServerResponse, status: number, message: string) {
  if (res.destroyed) return;
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message } }));
}

function dropped(conn: string | undefined | null): Set<string> {
  return new Set([
    ...HOP_HEADERS,
    ...(conn?.split(',').map((field) => field.trim().toLowerCase()) ?? []),
  ]);
}

async function readRequest(req: IncomingMessage): Promise<{ json: Json; body: string } | null> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) return null;
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks).toString('utf8');
  try {
    const json = object(JSON.parse(body));
    return json && { json, body };
  } catch {
    return null;
  }
}

function requestHeaders(req: IncomingMessage, apiKey: string | null, lease: string): Headers {
  const result = new Headers();
  const omit = dropped(req.headers.connection);
  omit.add('authorization');
  omit.add('cookie');
  for (const [name, value] of Object.entries(req.headers)) {
    if (omit.has(name) || name.startsWith('x-frugal-') || value == null) continue;
    const joined = Array.isArray(value) ? value.join(', ') : value;
    if (!joined.includes(lease) && !name.includes(lease)) result.set(name, joined);
  }
  result.set('accept-encoding', 'identity');
  if (apiKey) result.set('authorization', `Bearer ${apiKey}`);
  return result;
}

class Capture {
  private readonly decoder = new TextDecoder();
  private pending = '';
  private data: string[] = [];
  private dataSize = 0;
  private done = false;
  private disabled = false;
  id: string | null = null;
  model: string | null = null;
  usage: Json | null = null;
  readonly issues = new Set<string>();

  push(chunk: Uint8Array) {
    if (this.disabled) return;
    this.pending += this.decoder.decode(chunk, { stream: true });
    // Split on line feeds so CRLF also works when its bytes straddle sockets.
    let newline = this.pending.indexOf('\n');
    while (newline >= 0) {
      this.line(this.pending.slice(0, newline).replace(/\r$/, ''));
      this.pending = this.pending.slice(newline + 1);
      newline = this.pending.indexOf('\n');
    }
    if (this.pending.length > MAX_EVENT) this.overflow();
  }

  finish() {
    if (this.pending || this.data.length) this.issues.add('unterminated SSE frame');
    if (!this.done) this.issues.add('missing SSE end marker');
  }

  private overflow() {
    this.pending = '';
    this.data = [];
    this.disabled = true;
    this.issues.add('SSE frame exceeds relay limit');
  }

  private line(line: string) {
    if (line.startsWith('data:')) {
      const field = line.slice(5).replace(/^ /, '');
      this.dataSize += field.length + 1;
      if (this.dataSize > MAX_EVENT) this.overflow();
      else this.data.push(field);
      return;
    }
    if (line || !this.data.length) return;
    const data = this.data.join('\n');
    this.data = [];
    this.dataSize = 0;
    if (this.done) this.issues.add('SSE data after end marker');
    else if (data === '[DONE]') this.done = true;
    else this.payload(data, true);
  }

  payload(text: string, streaming = false) {
    let value: Json | null;
    try {
      value = object(JSON.parse(text));
    } catch {
      value = null;
    }
    if (!value) {
      this.issues.add('invalid JSON in upstream response');
      return;
    }
    if (streaming && value.error != null) this.issues.add('upstream SSE reported an error');
    if (typeof value.id === 'string') {
      if (this.id && this.id !== value.id) this.issues.add('conflicting completion IDs');
      this.id ??= value.id;
    }
    if (typeof value.model === 'string') {
      if (this.model && this.model !== value.model) this.issues.add('conflicting upstream models');
      this.model ??= value.model;
    }
    if (value.usage != null) {
      const next = object(value.usage);
      if (!next) this.issues.add('invalid upstream usage');
      else {
        if (this.usage && JSON.stringify(this.usage) !== JSON.stringify(next))
          this.issues.add('conflicting upstream usage');
        this.usage = next;
      }
    }
  }
}

// Only withhold a suffix that can form a credential in the next chunk.
class CredentialCheck {
  private tail = Buffer.alloc(0);
  constructor(private readonly secrets: string[]) {}

  push(bytes: Uint8Array): Buffer {
    const data = Buffer.concat([this.tail, bytes]);
    let keep = 0;
    for (const secret of this.secrets) {
      if (data.includes(secret)) throw new Error('Provider response contained a credential');
      const encoded = Buffer.from(secret);
      for (let length = Math.min(encoded.length - 1, data.length); length > keep; length--) {
        if (encoded.subarray(0, length).equals(data.subarray(data.length - length))) {
          keep = length;
          break;
        }
      }
    }
    this.tail = data.subarray(data.length - keep);
    return data.subarray(0, data.length - keep);
  }

  finish(): Buffer {
    return this.tail;
  }
}

async function deliver(res: ServerResponse, bytes: Uint8Array) {
  if (res.destroyed || !bytes.length || res.write(bytes)) return;
  await new Promise<void>((resolve) => {
    const done = () => {
      res.off('drain', done);
      res.off('close', done);
      resolve();
    };
    res.once('drain', done);
    res.once('close', done);
  });
}

function goBilling(usage: Json | null): boolean {
  const go = object(usage?.opencode);
  const source = go?.billing_source;
  const allowance = go?.allowance;
  return (
    usage?.cost === 0 &&
    (source === 'go' || source === 'go-plus') &&
    typeof allowance === 'number' &&
    Number.isFinite(allowance) &&
    allowance >= 0
  );
}

export async function startUsageRelay(options: Options) {
  const model = options.model.replace(/^opencode-go\//, '');
  if (!/^[a-zA-Z0-9_.:-]+$/.test(model)) throw new Error('Invalid model for the OpenCode Go relay');
  const apiKey = options.fixture ? null : options.apiKey;
  if (!options.fixture && (!apiKey || /\s/.test(apiKey)))
    throw new Error('Missing or invalid OpenCode Go key');
  const upstream = options.fixture ? fixtureURL(options.upstream) : new URL(GO + CHAT);
  const lease = randomBytes(32).toString('hex');
  const secrets = apiKey ? [apiKey, lease] : [lease];
  const secretIn = (text: string) => secrets.some((secret) => text.includes(secret));
  const safeId = (value: unknown) =>
    typeof value === 'string' && value.length <= 512 && value.length > 0 && !secretIn(value)
      ? value
      : null;

  const raw = join(options.runDir, 'raw');
  mkdirSync(raw, { recursive: true, mode: 0o700 });
  const log = openSync(join(raw, 'relay.jsonl'), 'ax', 0o600);
  const write = (value: Json) => writeFileSync(log, `${JSON.stringify(value)}\n`);
  let queued = Promise.resolve();
  let blocked = false;
  let closing = false;
  let shutdown: Promise<void> | null = null;

  async function call(req: IncomingMessage, res: ServerResponse) {
    if (res.destroyed) return;
    if (blocked || closing) {
      sendError(res, 402, 'OpenCode Go relay is stopped');
      return;
    }
    const input = await readRequest(req);
    if (!input || input.json.model !== model || secretIn(input.body)) {
      sendError(res, 400, 'Expected a Chat Completions request for the configured model');
      return;
    }
    const routeSession = safeId(req.headers['x-opencode-session']);
    if (!routeSession || !req.headers['user-agent']) {
      sendError(res, 400, 'OpenCode Go requires the coding client and session headers');
      return;
    }
    const candidate = input.json.reasoning_effort;
    const reasoningEffort = isGoVariant(candidate) && !secretIn(candidate) ? candidate : undefined;
    const correlation = {
      session_id: safeId(req.headers['x-frugal-session-id']) ?? routeSession,
      user_id: safeId(req.headers['x-frugal-message-id']),
      assistant_id: safeId(req.headers['x-frugal-assistant-id']),
      agent: safeId(req.headers['x-frugal-agent']),
      requested_model: model,
      reasoning_effort: reasoningEffort,
    };
    const id = randomUUID();
    write({ event: 'begin', id, ts: new Date().toISOString(), ...correlation });
    if (options.variant && reasoningEffort !== options.variant) {
      blocked = true;
      const issue = 'OpenCode Go reasoning effort differs from the selected variant';
      write({
        event: 'end',
        id,
        ts: new Date().toISOString(),
        ...correlation,
        status: 400,
        complete: false,
        issues: [issue],
      });
      sendError(res, 400, issue);
      return;
    }
    const streamOptions = object(input.json.stream_options);
    const body =
      input.json.stream === true && streamOptions?.include_usage !== true
        ? JSON.stringify({
            ...input.json,
            stream_options: { ...streamOptions, include_usage: true },
          })
        : input.body;
    const capture = new Capture();
    const guard = new CredentialCheck(secrets);
    let status: number | null = null;
    let requestId: string | null = null;
    const timeout = AbortSignal.timeout(5 * 60_000);
    const abortDownstream = () => res.destroy();
    timeout.addEventListener('abort', abortDownstream, { once: true });
    try {
      const reply = await fetch(upstream, {
        method: 'POST',
        body,
        headers: requestHeaders(req, apiKey, lease),
        redirect: 'manual',
        signal: timeout,
      });
      status = reply.status;
      requestId =
        safeId(reply.headers.get('x-request-id')) ??
        safeId(reply.headers.get('x-opencode-request-id'));
      const stream = reply.headers.get('content-type')?.toLowerCase().includes('text/event-stream');
      const omit = dropped(reply.headers.get('connection'));
      for (const name of ['content-encoding', 'set-cookie', 'location']) omit.add(name);
      for (const [name, value] of reply.headers) {
        if (!omit.has(name) && !secretIn(value) && !res.destroyed) res.setHeader(name, value);
      }
      if (!res.destroyed) {
        res.writeHead(status >= 300 && status < 400 ? 502 : status);
        res.flushHeaders();
      }
      const bytes: Buffer[] = [];
      let size = 0;
      const reader = reply.body?.getReader();
      if (reader) {
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            if (stream) capture.push(chunk.value);
            else {
              size += chunk.value.length;
              if (size <= MAX_EVENT) bytes.push(Buffer.from(chunk.value));
            }
            await deliver(res, guard.push(chunk.value));
          }
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      }
      if (input.json.stream === true && reply.ok && !stream)
        capture.issues.add('upstream did not return requested SSE');
      if (stream) capture.finish();
      else if (size > MAX_EVENT) capture.issues.add('JSON response exceeds relay limit');
      else capture.payload(Buffer.concat(bytes).toString('utf8'));
      await deliver(res, guard.finish());
    } catch {
      capture.issues.add(
        timeout.aborted ? 'upstream request timed out' : 'upstream transport failed',
      );
    } finally {
      timeout.removeEventListener('abort', abortDownstream);
    }

    if (!capture.usage) capture.issues.add('missing upstream usage');
    if (capture.usage && secretIn(JSON.stringify(capture.usage))) {
      capture.usage = null;
      capture.issues.add('upstream usage contained a credential');
    }
    if (capture.model !== model) capture.issues.add('missing or different upstream model');
    if (!(requestId ?? safeId(capture.id))) capture.issues.add('missing upstream request ID');
    if (!goBilling(capture.usage)) capture.issues.add('Go subscription billing unverified');
    if (status === 401 || status === 402 || status === 403 || status === 429)
      capture.issues.add('provider denied authorization or available quota');
    if (status != null && status >= 300 && status < 400)
      capture.issues.add('unexpected provider redirect');
    if (capture.issues.size) blocked = true;
    write({
      event: 'end',
      id,
      ts: new Date().toISOString(),
      ...correlation,
      status,
      upstream_id: requestId ?? safeId(capture.id),
      completion_id: safeId(capture.id),
      model_id: safeId(capture.model),
      usage: capture.usage,
      complete: capture.issues.size === 0,
      issues: [...capture.issues].sort(),
    });
    if (status === null || capture.issues.has('upstream transport failed')) {
      sendError(res, 502, 'OpenCode Go relay could not finish the provider response');
    } else if (!res.destroyed) {
      res.end();
    }
  }

  const server = createServer((req, res) => {
    if (req.method !== 'POST' || ![CHAT, `/v1${CHAT}`].includes(req.url ?? '')) {
      sendError(res, 404, 'Relay accepts only Chat Completions');
      return;
    }
    if (!authorized(req.headers.authorization, lease)) {
      sendError(res, 401, 'Relay credentials are required');
      return;
    }
    // Hold the next request until the prior request's billing check is recorded.
    queued = queued
      .then(() => call(req, res))
      .catch(() => {
        blocked = true;
        sendError(res, 502, 'OpenCode Go relay failed');
      });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    closeSync(log);
    throw error;
  }
  const address = server.address();
  if (typeof address !== 'object' || !address) throw new Error('Missing relay address');
  return {
    port: address.port,
    token: lease,
    close() {
      shutdown ??= new Promise<void>((resolve, reject) => {
        closing = true;
        server.close((error) => {
          void queued
            .then(() => {
              closeSync(log);
              if (error) reject(error);
              else resolve();
            })
            .catch(reject);
        });
      });
      return shutdown;
    },
  };
}
