// Native local-model apply pilot. The controller never supplies assistant responses.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { digest, git, readJson, writeJson } from '../packages/cli/dist/harness/io.js';
import {
  createSettings,
  platformBin,
  runnerEnvironment,
} from '../packages/cli/dist/harness/runner.js';
import { normalize } from '../packages/cli/dist/meter/usage.js';

const project = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const { values: options } = parseArgs({
  options: Object.fromEntries(
    [
      'fixture',
      'endpoint',
      'model',
      'out',
      'steps',
      'timeout-ms',
      'arms',
      'context',
      'max-output',
      'help',
    ].map((k) => [k, { type: k === 'help' ? 'boolean' : 'string' }]),
  ),
});
if (options.help) {
  console.log(
    'node scripts/pilot-task-context.mjs --fixture DIR --endpoint http://127.0.0.1:PORT/v1 --model ID --out NEW_DIR [--arms shared,fresh] [--steps 8] [--timeout-ms 420000] [--context 32768] [--max-output 2048]',
  );
  process.exit(0);
}
const endpoint = new URL(options.endpoint);
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
const model = options.model;
assert(typeof model === 'string' && /^[\w.][\w./:-]*$/.test(model));
const armOrder = (options.arms ?? 'shared,fresh').split(',');
assert.deepEqual([...armOrder].sort(), ['fresh', 'shared']);
const positive = (v) => {
  const n = Number(v);
  assert(Number.isSafeInteger(n) && n > 0);
  return n;
};
const steps = positive(options.steps ?? 8);
const timeout = positive(options['timeout-ms'] ?? 420_000);
const limits = {
  context: positive(options.context ?? 32768),
  output: positive(options['max-output'] ?? 2048),
};
assert(limits.context > limits.output);
const fixtureFile = realpathSync(join(resolve(options.fixture), 'fixture.mjs'));
const fixture = await import(pathToFileURL(fixtureFile).href);
const out = resolve(options.out);
assert(!existsSync(out), 'Choose a new output path');
mkdirSync(out, { recursive: true, mode: 0o700 });
const root = mkdtempSync(join(realpathSync(tmpdir()), 'frugal-apply-pilot-'));
assert(!root.startsWith(project + '/'));
const runtime = join(root, 'runtime');
const repo = join(runtime, 'repo');
const host = realpathSync(platformBin(project, 'opencode'));
const sandbox = '/usr/bin/sandbox-exec';
assert(existsSync(sandbox), 'This pilot requires the macOS sandbox-exec profile');
const envFor = () => ({
  ...runnerEnvironment(runtime),
  PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
  LANG: 'en_US.UTF-8',
  NO_PROXY: '127.0.0.1',
  HTTP_PROXY: 'http://127.0.0.1:1',
  HTTPS_PROXY: 'http://127.0.0.1:1',
});
const exec = promisify(execFile);
function sandboxProfile(readable, writable, port) {
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
  (deny file-write* (subpath ${JSON.stringify(join(repo, '\.git'))}))
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
      (body.tools ?? []).every((tool) => ['edit', 'read', 'write'].includes(tool.function?.name)),
      'Unexpected tool exposed to model',
    );
    assert.equal(body.max_tokens ?? body.max_completion_tokens, limits.output);
    assert.equal(body.temperature, 0);
    const response = await fetch(new URL('/v1/chat/completions', endpoint), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: wire,
      redirect: 'error',
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(timeout)]),
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
const run = {
  controller_commit: git(project, ['rev-parse', 'HEAD']),
  script_sha256: digest(readFileSync(fileURLToPath(import.meta.url))),
  base_by_arm: {},
  summary: {},
  kind: 'local-model-apply-only-pilot',
  endpoint: endpoint.href,
  model,
  steps,
  timeout_ms: timeout,
  limits,
  arms: armOrder,
  opencode_version: '1.19.6',
  fixture_sha256: digest(readFileSync(fixtureFile)),
  spec: fixture.brief,
  handoff: fixture.handoff,
  quality: 'deterministic public checks; no model spec/review/verify',
  results: {},
};
const prompts = {};
const score = `const {evaluate}=await import(process.argv[1]); console.log(JSON.stringify(await evaluate(process.cwd())));`;
async function qualityAt(dir, env) {
  const proc = await command(
    process.execPath,
    ['--input-type=module', '-e', score, pathToFileURL(fixtureFile).href],
    env,
    sandboxProfile([repo, dirname(fixtureFile), dirname(dirname(process.execPath))], [], null),
    20000,
  );
  writeFileSync(join(dir, 'quality.stderr'), proc.stderr);
  writeFileSync(join(dir, 'quality.stdout'), proc.stdout);
  try {
    return proc.code === 0 ? JSON.parse(proc.stdout) : null;
  } catch {
    return null;
  }
}
const snapshot = () => {
  git(repo, ['add', '-A']);
  return git(repo, ['write-tree']);
};
try {
  for (const arm of armOrder) {
    const dir = join(out, arm);
    mkdirSync(dir);
    const env = envFor();
    mkdirSync(repo);
    await fixture.prepare(repo);
    git(repo, ['init', '-q']);
    const base = snapshot();
    assert(!run.input_tree || run.input_tree === base);
    run.input_tree = base;
    const baselineChecks = await qualityAt(dir, env);
    assert(baselineChecks, 'Cannot evaluate initial fixture');
    run.base_by_arm[arm] = { tree: base, checks: baselineChecks };
    const profile = sandboxProfile([runtime, host], [runtime], port);
    const version = await command(host, ['--version'], env, profile, 20000);
    assert.equal(version.stdout.trim(), '1.19.6', JSON.stringify(version));
    run.opencode_version = version.stdout.trim();
    createSettings(env, 'pilot/' + model, `http://127.0.0.1:${port}/v1`, limits, true);
    const configPath = join(env.OPENCODE_CONFIG_DIR, 'opencode.json');
    const config = readJson(configPath);
    config.permission = { '*': 'deny', read: 'allow', edit: 'allow', external_directory: 'deny' };
    config.agent.build = { steps, temperature: 0 };
    config.provider.pilot.models[model].temperature = true;
    config.provider.pilot.models[model].options = { maxOutputTokens: limits.output };
    writeJson(configPath, config);
    const turns = [];
    run.results[arm] = turns;
    for (const task of [1, 2]) {
      const taskDir = join(dir, 'task-' + task);
      mkdirSync(join(taskDir, 'calls'), { recursive: true });
      const prompt = await fixture.promptForTask(repo, task);
      if (task === 2) assert(prompt.includes(fixture.handoff));
      if (prompts[task]) assert.equal(prompt, prompts[task], 'Prompts differ across arms');
      prompts[task] = prompt;
      writeFileSync(join(taskDir, 'prompt.txt'), prompt);
      const token = randomUUID();
      const ticket = { arm, task, dir: taskDir, calls: [], pending: [] };
      tickets.set('Bearer ' + token, ticket);
      const args = [
        'run',
        '--format',
        'json',
        '--model',
        'pilot/' + model,
        '--agent',
        'build',
        '--title',
        'Pilot task ' + task,
      ];
      const continued = arm === 'shared' && task === 2;
      const previous = turns[0]?.session_id;
      if (continued && previous) args.push('--session', previous);
      args.push('--', prompt);
      console.log(`${arm} task ${task}`);
      const result =
        continued && !previous
          ? { code: 1, stdout: '', stderr: 'No session available for continuation' }
          : await command(host, args, { ...env, FRUGAL_RELAY_TOKEN: token }, profile, timeout);
      tickets.delete('Bearer ' + token);
      await Promise.all(ticket.pending);
      writeFileSync(join(taskDir, 'native.jsonl'), result.stdout);
      writeFileSync(join(taskDir, 'native.stderr'), result.stderr);
      const events = result.stdout
        .split(/\r?\n/)
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line)];
          } catch {
            return [];
          }
        });
      const sessions = [...new Set(events.map((e) => e.sessionID).filter(Boolean))];
      let session = sessions.length === 1 ? sessions[0] : null;
      let source = session ? 'native-event' : null;
      if (!session && !sessions.length && (!continued || previous)) {
        const listed = await command(
          host,
          ['session', 'list', '--format', 'json'],
          env,
          profile,
          15000,
        );
        writeFileSync(join(taskDir, 'sessions.json'), listed.stdout);
        if (listed.code === 0) {
          const ids = JSON.parse(listed.stdout)
            .filter((s) => (continued ? s.id === previous : s.title === 'Pilot task ' + task))
            .map((s) => s.id);
          if (ids.length === 1 && /^ses_[a-zA-Z0-9]+$/.test(ids[0])) {
            session = ids[0];
            source = 'session-list';
          }
        }
      }
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
        ticket.calls.map((c) => c.usage),
      );
      const known = sum(provider);
      const complete = ticket.calls.length > 0 && ticket.calls.every((c) => c.complete);
      const sessionOK =
        source === 'native-event' &&
        ticket.calls[0]?.has_assistant_history === continued &&
        (task === 1 || (continued ? session === previous : session !== previous));
      const checks = await qualityAt(taskDir, env);
      const row = {
        task,
        session_id: session,
        session_source: source,
        session_verified: sessionOK,
        prompt_sha256: digest(prompt),
        tree: snapshot(),
        code: result.code,
        signal: result.signal ?? null,
        finish: finish.at(-1)?.part?.reason ?? null,
        requests: ticket.calls.length,
        known_provider: known,
        complete_provider_usage: complete,
        provider_rpt: complete ? known.prompt + known.completion : null,
        native_steps: finish.length,
        native_known: sum(native),
        reconciliation:
          complete &&
          native.length === finish.length &&
          JSON.stringify(provider) === JSON.stringify(native),
        checks,
      };
      writeJson(join(taskDir, 'result.json'), row);
      turns.push(row);
      writeJson(join(out, 'run.json'), run);
      console.log(
        JSON.stringify({
          arm,
          task,
          requests: row.requests,
          complete,
          reconciliation: row.reconciliation,
          session,
          finish: row.finish,
          checks: checks && { task1: checks.task1, task2: checks.task2, api: checks.api },
        }),
      );
    }
    const completeUsage = turns.every((t) => t.complete_provider_usage);
    run.summary[arm] = {
      provider_rpt: completeUsage ? turns.reduce((n, t) => n + t.provider_rpt, 0) : null,
      complete_provider_usage: completeUsage,
      reconciled: turns.every((t) => t.reconciliation),
      session_verified: turns.every((t) => t.session_verified),
      final_checks: turns[1].checks,
    };
    cpSync(repo, join(dir, 'final'), {
      recursive: true,
      filter: (p) => basename(p) !== '.git',
      verbatimSymlinks: true,
    });
    renameSync(runtime, join(root, arm));
  }
} finally {
  writeJson(join(out, 'run.json'), run);
  await new Promise((ok) => server.close(ok));
}
