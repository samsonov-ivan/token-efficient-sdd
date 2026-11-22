// Shared transport, accounting, and sandbox for public local-model pilots.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { digest, writeJson } from '../../packages/cli/dist/harness/io.js';
import { runnerEnvironment } from '../../packages/cli/dist/harness/runner.js';
import { normalize } from '../../packages/cli/dist/meter/usage.js';

export function loopbackEndpoint(raw) {
  const endpoint = new URL(raw);
  assert(
    endpoint.protocol === 'http:' &&
      endpoint.hostname === '127.0.0.1' &&
      endpoint.port &&
      !endpoint.username &&
      !endpoint.password &&
      !endpoint.search &&
      !endpoint.hash &&
      /^\/v1\/?$/.test(endpoint.pathname),
    'Expected http://127.0.0.1:PORT/v1',
  );
  return endpoint;
}
export const pilotEnvironment = (runtime) => ({
  ...runnerEnvironment(runtime),
  PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
  LANG: 'en_US.UTF-8',
  NO_PROXY: '127.0.0.1',
  HTTP_PROXY: 'http://127.0.0.1:1',
  HTTPS_PROXY: 'http://127.0.0.1:1',
});
export function pilotSandbox(repo) {
  const sandbox = '/usr/bin/sandbox-exec';
  assert(existsSync(sandbox), 'This pilot requires the macOS sandbox-exec profile');
  const exec = promisify(execFile);
  function sandboxProfile(readable, writable, port, protectedPaths = []) {
    const ancestors = new Set(['/']);
    for (let path of readable) {
      while (path !== dirname(path)) {
        path = dirname(path);
        ancestors.add(path);
      }
    }
    const paths = (paths) => paths.map((p) => `(subpath ${JSON.stringify(p)})`).join(' ');
    return `(version 1)(allow default)(deny network*)(deny file-read-data)(deny file-write*)
  (allow file-read-data ${[...ancestors].map((p) => `(literal ${JSON.stringify(p)})`).join(' ')} ${paths(['/usr', '/bin', '/sbin', '/System', '/Library/Apple', '/private/etc', '/dev', '/private/var/db/timezone', '/private/var/db/dyld', ...readable])})
  (allow file-write* (literal "/dev/null") ${paths(writable)})
  (deny file-write* ${paths([join(repo, '.git'), ...protectedPaths])})
  ${port ? `(allow network-outbound (remote tcp "localhost:${port}"))` : ''}`;
  }
  async function command(binary, args, env, profile, limit) {
    try {
      const child = exec(sandbox, ['-p', profile, binary, ...args], {
        cwd: repo,
        env,
        timeout: limit,
        killSignal: 'SIGKILL',
        maxBuffer: 32 * 1024 * 1024,
      });
      child.child.stdin.end();
      return { ...(await child), code: 0 };
    } catch (err) {
      return {
        stdout: err.stdout ?? '',
        stderr: err.stderr ?? '',
        code: err.code ?? 1,
        signal: err.signal ?? null,
      };
    }
  }
  return { sandboxProfile, command };
}
function usageFrom(bytes, type, status) {
  const issues = [];
  let usage = null;
  const sse = type.includes('text/event-stream');
  try {
    const text = bytes.toString('utf8').replaceAll('\r\n', '\n');
    const parts = sse
      ? text
          .split('\n\n')
          .map((block) =>
            block
              .split('\n')
              .filter((l) => l.startsWith('data:'))
              .map((l) => l.slice(5).trimStart())
              .join('\n'),
          )
          .filter(Boolean)
      : [text];
    if (sse && parts.at(-1) !== '[DONE]') issues.push('missing SSE end marker');
    for (const part of parts) {
      if (part === '[DONE]') continue;
      const value = JSON.parse(part);
      if (value.error) issues.push('upstream returned error');
      if (value.usage) {
        if (usage && JSON.stringify(usage) !== JSON.stringify(value.usage))
          issues.push('conflicting usage');
        usage = value.usage;
      }
    }
  } catch {
    issues.push('unparseable upstream response');
  }
  if (!usage) issues.push('missing provider usage');
  else
    try {
      normalize('openai-chat', usage);
    } catch {
      issues.push('invalid provider usage');
    }
  if (status !== 200) issues.push('upstream HTTP status ' + status);
  return { usage, issues };
}

export async function openTransport({ endpoint, model, limits, timeout, tools, signal }) {
  // Each lease is bound to a single task. Late traffic cannot be attributed to the next task.
  const tickets = new Map();
  const server = createServer(async (req, res) => {
    const ticket = tickets.get(req.headers.authorization);
    if (!ticket || req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(403).end();
      return;
    }
    const { arm, task } = ticket;
    const attempt = ticket.calls.length + 1;
    const stem = join(ticket.dir, 'calls', String(attempt).padStart(4, '0'));
    const meta = {
      arm,
      task,
      attempt,
      status: null,
      content_type: '',
      usage: null,
      complete: false,
      issues: ['incomplete request'],
    };
    ticket.calls.push(meta);
    writeJson(stem + '.meta.json', meta);
    let finish;
    ticket.pending.push(
      new Promise((r) => {
        finish = r;
      }),
    );
    const chunks = [];
    const abort = new AbortController();
    res.once('close', () => {
      if (!res.writableEnded) abort.abort();
    });
    try {
      const input = [];
      for await (const chunk of req) input.push(chunk);
      const body = JSON.parse(Buffer.concat(input));
      if (body.stream) body.stream_options = { ...body.stream_options, include_usage: true };
      const wire = JSON.stringify(body);
      writeFileSync(stem + '.request.json', wire);
      meta.request_sha256 = digest(wire);
      meta.has_assistant_history = body.messages.some((m) => m.role === 'assistant');
      assert.equal(body.model, model);
      assert(
        (body.tools ?? []).every((tool) => tools.includes(tool.function?.name)),
        'Unexpected tool exposed to model',
      );
      assert.equal(body.max_tokens ?? body.max_completion_tokens, limits.output);
      assert.equal(body.temperature, 0);
      const response = await fetch(new URL('/v1/chat/completions', endpoint), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: wire,
        redirect: 'error',
        signal: AbortSignal.any([
          abort.signal,
          AbortSignal.timeout(timeout),
          ...(signal ? [signal] : []),
        ]),
      });
      meta.status = response.status;
      meta.content_type = response.headers.get('content-type') ?? '';
      res.writeHead(response.status, { 'content-type': meta.content_type });
      for await (const chunk of response.body) {
        chunks.push(Buffer.from(chunk));
        res.write(chunk);
      }
      Object.assign(meta, usageFrom(Buffer.concat(chunks), meta.content_type, meta.status));
    } catch (err) {
      const partial = usageFrom(Buffer.concat(chunks), meta.content_type, meta.status);
      Object.assign(meta, partial);
      meta.issues.push('transport: ' + err.message);
      if (!res.headersSent && !res.destroyed) res.writeHead(502);
    } finally {
      const bytes = Buffer.concat(chunks);
      writeFileSync(stem + '.response', bytes);
      meta.response_sha256 = digest(bytes);
      meta.complete = meta.issues.length === 0;
      writeJson(stem + '.meta.json', meta);
      res.end();
      finish();
    }
  });
  await new Promise((ok, fail) => server.once('error', fail).listen(0, '127.0.0.1', ok));
  const port = server.address().port;
  return {
    port,
    async stage(arm, task, dir, invoke) {
      const token = randomUUID();
      const ticket = { arm, task, dir, calls: [], pending: [] };
      tickets.set('Bearer ' + token, ticket);
      try {
        const result = await invoke(token);
        return { result, calls: ticket.calls };
      } finally {
        tickets.delete('Bearer ' + token);
        await Promise.all(ticket.pending);
      }
    },
    close: () => new Promise((ok) => server.close(ok)),
  };
}
export function account(events, calls) {
  const finish = events.filter((e) => e.type === 'step_finish');
  const count = (usage) => ({
    prompt: usage.t_in + usage.t_cache_read + usage.t_cache_write,
    completion: usage.t_out + usage.t_reasoning,
  });
  const sum = (list) =>
    list.reduce(
      (a, b) => ({ prompt: a.prompt + b.prompt, completion: a.completion + b.completion }),
      { prompt: 0, completion: 0 },
    );
  const measured = (schema, items) =>
    items.flatMap((x) => {
      try {
        return [count(normalize(schema, x))];
      } catch {
        return [];
      }
    });
  const native = measured(
    'opencode-v1',
    finish.map((e) => e.part.tokens),
  );
  const provider = measured(
    'openai-chat',
    calls.map((c) => c.usage),
  );
  const known = sum(provider);
  const complete = calls.length > 0 && calls.every((c) => c.complete);
  return {
    requests: calls.length,
    known_provider: known,
    complete_provider_usage: complete,
    provider_rpt: complete ? known.prompt + known.completion : null,
    native_steps: finish.length,
    native_known: sum(native),
    reconciliation:
      complete &&
      native.length === finish.length &&
      JSON.stringify(provider) === JSON.stringify(native),
  };
}
export async function publicChecks(dir, repo, fixtureFile, env, limit = 20_000) {
  const { command, sandboxProfile } = pilotSandbox(repo);
  const score = `const {evaluate}=await import(process.argv[1]); console.log(JSON.stringify(await evaluate(process.cwd())));`;
  const proc = await command(
    process.execPath,
    ['--input-type=module', '-e', score, pathToFileURL(fixtureFile).href],
    env,
    sandboxProfile([repo, dirname(fixtureFile), dirname(dirname(process.execPath))], [], null),
    limit,
  );
  writeFileSync(join(dir, 'quality.stderr'), proc.stderr);
  writeFileSync(join(dir, 'quality.stdout'), proc.stdout);
  try {
    return proc.code === 0 ? JSON.parse(proc.stdout) : null;
  } catch {
    return null;
  }
}
