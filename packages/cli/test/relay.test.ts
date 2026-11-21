import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startUsageRelay } from '../src/harness/relay.js';

const model = 'deepseek-v4.1-flash';
const usage = {
  prompt_tokens: 130,
  completion_tokens: 15,
  total_tokens: 145,
  cost: 0,
  opencode: {
    billing_source: 'go',
    allowance: 0.0001,
    list_cost: 0.0002,
    tokens: {
      input: 50,
      output: 15,
      reasoning: 7,
      cache_read: 60,
      cache_write_5m: 20,
      cache_write_1h: 0,
    },
  },
};

function frame(data: Record<string, unknown>) {
  return `data: ${JSON.stringify({ id: 'chatcmpl-222', model, ...data })}\r\n\r\n`;
}
const first = frame({ choices: [{ index: 0, delta: { content: 'Привет' } }] });
const last = `${frame({ choices: [], usage })}data: [DONE]\r\n\r\n`;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(
  upstream: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void,
) {
  const runDir = await mkdtemp(join(tmpdir(), 'frugal-go-relay-'));
  cleanups.push(() => rm(runDir, { recursive: true, force: true }));
  const fixture = createServer((req, res) => {
    Promise.resolve(upstream(req, res)).catch(() => res.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    fixture.once('error', reject);
    fixture.listen(0, '127.0.0.1', resolve);
  });
  cleanups.push(() => new Promise<void>((resolve) => fixture.close(() => resolve())));
  const fixtureAddress = fixture.address();
  if (!fixtureAddress || typeof fixtureAddress !== 'object') throw new Error('No fixture address');
  const relay = await startUsageRelay({
    fixture: true,
    upstream: `http://127.0.0.1:${fixtureAddress.port}/native/v1`,
    model: `opencode-go/${model}`,
    runDir,
  });
  cleanups.push(() => relay.close());
  const endpoint = `http://127.0.0.1:${relay.port}/v1/chat/completions`;
  const request = (body: string, headers: Record<string, string> = {}, url = endpoint) =>
    fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'opencode/1.19.6',
        authorization: `Bearer ${relay.token}`,
        'x-opencode-session': 'provider-session',
        'x-opencode-client': 'cli',
        'x-frugal-session-id': 'session-a',
        'x-frugal-message-id': 'user-a',
        ...headers,
      },
      body,
    });
  const ledger = async () =>
    (await readFile(join(runDir, 'raw', 'relay.jsonl'), 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  return { request, ledger, endpoint, relay };
}

const requestBody = JSON.stringify({
  model,
  stream: true,
  temperature: 0.1,
  stream_options: { include_obfuscation: true },
  messages: [{ role: 'user', content: 'source text for the model' }],
});
const streamHeaders = { 'content-type': 'text/event-stream', 'x-request-id': 'req-333' };

describe('OpenCode Go usage relay', () => {
  it('streams original SSE before completion and stores usage apart from headers and prompt', async () => {
    let forwarded: { url?: string; headers: IncomingMessage['headers']; body: string } | undefined;
    let finish!: () => void;
    const release = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const { request, ledger, relay } = await setup(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      forwarded = { url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() };
      res.writeHead(200, streamHeaders);
      const bytes = Buffer.from(first);
      const cut = bytes.indexOf('П') + 1;
      res.write(bytes.subarray(0, cut));
      res.write(bytes.subarray(cut));
      await release;
      res.write(last.slice(0, -1));
      res.end(last.slice(-1));
    });
    const response = await request(requestBody);
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Missing response stream');
    const bytes = [];
    try {
      expect(response.headers.get('x-request-id')).toBe('req-333');
      expect((await ledger()).map((row) => row.event)).toEqual(['begin']);
      let received = 0;
      while (received < Buffer.byteLength(first)) {
        const chunk = await reader.read();
        if (!chunk.value) throw new Error('Upstream ended before the final chunk');
        received += chunk.value.length;
        bytes.push(chunk.value);
      }
      expect(Buffer.concat(bytes).toString()).toBe(first);
      expect(forwarded?.url).toBe('/native/v1/chat/completions');
      expect(forwarded?.headers['x-opencode-session']).toBe('provider-session');
      expect(forwarded?.headers['x-opencode-client']).toBe('cli');
      expect(forwarded?.headers['user-agent']).toBe('opencode/1.19.6');
      expect(forwarded?.headers.authorization).toBeUndefined();
      expect(forwarded?.headers['x-frugal-message-id']).toBeUndefined();
      expect(JSON.parse(forwarded?.body ?? 'null')).toEqual({
        ...JSON.parse(requestBody),
        stream_options: { include_obfuscation: true, include_usage: true },
      });
    } finally {
      finish();
    }
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes.push(chunk.value);
    }
    expect(Buffer.concat(bytes).toString()).toBe(first + last);
    const [begin, end] = await ledger();
    expect(end).toMatchObject({
      id: begin.id,
      event: 'end',
      session_id: 'session-a',
      user_id: 'user-a',
      requested_model: model,
      model_id: model,
      upstream_id: 'req-333',
      completion_id: 'chatcmpl-222',
      status: 200,
      usage,
      complete: true,
      issues: [],
    });
    expect(JSON.stringify([begin, end])).not.toContain(relay.token);
    expect(JSON.stringify([begin, end])).not.toContain('source text for the model');
  });

  it('preserves a request with usage enabled and keeps an observable failed attempt', async () => {
    const requests: string[] = [];
    const original = `  { "model": "${model}", "stream": true, "stream_options": {"include_usage": true} }\n`;
    const { request, ledger } = await setup(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      requests.push(Buffer.concat(chunks).toString());
      if (requests.length === 1) {
        res.writeHead(500, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            id: 'failed-attempt',
            model,
            error: { message: 'fixture status' },
            usage,
          }),
        );
      } else {
        res.writeHead(200, streamHeaders).end(last);
      }
    });
    const failed = await request(original);
    expect(failed.status).toBe(500);
    expect(await failed.json()).toMatchObject({ error: { message: 'fixture status' } });
    const succeeded = await request(original);
    expect(await succeeded.text()).toBe(last);
    expect(requests).toEqual([original, original]);
    expect((await ledger()).filter((row) => row.event === 'end')).toMatchObject([
      { upstream_id: 'failed-attempt', status: 500, complete: true, usage },
      { upstream_id: 'req-333', status: 200, complete: true, usage },
    ]);
  });

  it.each([
    {
      name: 'paid balance',
      content: `${frame({
        usage: {
          ...usage,
          cost: 0.001,
          opencode: { ...usage.opencode, billing_source: 'balance' },
        },
      })}data: [DONE]\n\n`,
      status: 200,
      issue: 'Go subscription billing unverified',
    },
    {
      name: 'unknown usage',
      content: `${first}data: [DONE]\n\n`,
      status: 200,
      issue: 'missing upstream usage',
    },
    {
      name: 'truncated stream',
      content: frame({ usage }),
      status: 200,
      issue: 'missing SSE end marker',
    },
    {
      name: 'quota exceeded',
      content: JSON.stringify({ error: { message: 'fixture quota' } }),
      status: 429,
      issue: 'provider denied authorization or available quota',
    },
  ])('stops before queued calls on $name', async ({ content, status, issue }) => {
    let calls = 0;
    const { request, ledger } = await setup((_req, res) => {
      calls++;
      const headers = status === 429 ? { 'content-type': 'application/json' } : streamHeaders;
      res.writeHead(status, headers).end(content);
    });
    const firstCall = await request(requestBody);
    const nextCall = request(requestBody);
    expect(firstCall.status).toBe(status);
    await firstCall.text();
    expect((await nextCall).status).toBe(402);
    expect(calls).toBe(1);
    const [begin, end] = await ledger();
    expect(end).toMatchObject({ id: begin.id, event: 'end', status, complete: false });
    expect(end.issues).toContain(issue);
  });

  it('keeps credentials out of captured headers, streamed bytes, and the audit log', async () => {
    let lease = '';
    const { request, ledger, relay } = await setup((_req, res) => {
      res.writeHead(200, { ...streamHeaders, 'x-fixture-secret': lease });
      res.write(first);
      const malicious = frame({ usage: { ...usage, leaked: lease } });
      const split = malicious.indexOf(lease) + 10;
      res.write(malicious.slice(0, split));
      setImmediate(() => res.end(malicious.slice(split)));
    });
    lease = relay.token;
    const response = await request(requestBody);
    expect(response.headers.has('x-fixture-secret')).toBe(false);
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Missing response stream');
    const chunks = [];
    await expect(async () => {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        chunks.push(chunk.value);
      }
    }).rejects.toThrow();
    expect(Buffer.concat(chunks).toString()).not.toContain(lease);
    const rows = await ledger();
    expect(rows[1]).toMatchObject({ complete: false, usage: null });
    expect(JSON.stringify(rows)).not.toContain(lease);
  });

  it('rejects wrong leases, routes, models, and remote fixtures before any upstream request', async () => {
    let calls = 0;
    const { request, ledger, endpoint, relay } = await setup((_req, res) => {
      calls++;
      res.end();
    });
    expect((await request(requestBody, { authorization: 'Bearer wrong' })).status).toBe(401);
    expect((await request(requestBody, {}, `${endpoint}?upstream=elsewhere`)).status).toBe(404);
    expect((await request(requestBody.replace(model, 'different-model'))).status).toBe(400);
    expect((await request(requestBody, { 'x-opencode-session': '' })).status).toBe(400);
    expect(
      (await request(requestBody.replace('source text for the model', relay.token))).status,
    ).toBe(400);
    expect(calls).toBe(0);
    expect(await ledger()).toEqual([]);
    await expect(
      startUsageRelay({
        fixture: true,
        upstream: 'https://opencode.ai/inference/go/openai/v1',
        runDir: '/unused',
        model,
      }),
    ).rejects.toThrow('loopback');
  });
});
