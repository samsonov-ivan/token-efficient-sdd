#!/usr/bin/env node
// Exercise the installed CLIs in disposable repositories. No user configuration is imported.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const toolRoot = resolve(process.env.FRUGAL_TOOL_ROOT ?? root);
const bin = join(toolRoot, 'node_modules/.bin');
const binV2 = join(toolRoot, 'tools/opencode-v2/node_modules/.bin');
const plugin = join(root, 'packages/opencode-plugin');
const mode = process.argv[2] ?? 'mock';
assert(
  ['mock', 'live-free', 'live-local'].includes(mode),
  'Usage: node scripts/probe-opencode.mjs [mock|live-free|live-local]',
);
const outside = await realpath(tmpdir());
const pathFromRoot = relative(await realpath(root), outside);
assert(
  pathFromRoot === '..' || pathFromRoot.startsWith('../'),
  'TMPDIR must be outside the project',
);
const run = await mkdtemp(join(outside, 'frugal-probe-'));
const evidence = join(run, 'evidence');
await mkdir(evidence);
console.log(`Evidence: ${evidence}`);
const summary = { mode, started: new Date().toISOString(), node: process.version, checks: {} };

async function write(path, contents) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, { mode: 0o600 });
}

async function environment(line) {
  const base = join(run, line);
  const cwd = join(base, 'repo');
  const paths = {
    HOME: join(base, 'home'),
    XDG_CONFIG_HOME: join(base, 'config'),
    XDG_DATA_HOME: join(base, 'data'),
    XDG_STATE_HOME: join(base, 'state'),
    XDG_CACHE_HOME: join(base, 'cache'),
    TMPDIR: join(base, 'tmp'),
    OPENCODE_CONFIG_DIR: join(base, 'config/opencode'),
  };
  await Promise.all([...Object.values(paths), cwd].map((path) => mkdir(path, { recursive: true })));
  const env = {
    ...paths,
    PATH: `${bin}:${process.env.PATH}`,
    LANG: 'en_US.UTF-8',
    CI: '1',
    FRUGAL_PLUGIN_LOAD_LOG: join(evidence, `${line}-plugin.jsonl`),
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
    DO_NOT_TRACK: '1',
    OPENSPEC_TELEMETRY: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    NO_COLOR: '1',
  };
  return { cwd, env };
}

async function command(name, binary, args, options, timeout = 90000) {
  const child = spawn(binary, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout = [],
    stderr = [];
  child.stdout.on('data', (data) => stdout.push(data));
  child.stderr.on('data', (data) => stderr.push(data));
  const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
  let code;
  try {
    code = await new Promise((res, rej) => {
      child.once('error', rej);
      child.once('close', res);
    });
  } finally {
    clearTimeout(timer);
  }
  const out = Buffer.concat(stdout).toString(),
    err = Buffer.concat(stderr).toString();
  await write(join(evidence, name + '.stdout'), out);
  await write(join(evidence, name + '.stderr'), err);
  assert.equal(code, 0, `${name} failed (${code}), see ${evidence}`);
  return out.trim();
}

const openspec = join(bin, 'openspec');
const v1 = join(bin, 'opencode');
const v2 = join(binV2, 'opencode');
const spec = (body) => `### Requirement: REQ-PROBE-01 Greeting
The system SHALL return the greeting requested by the probe.

#### Scenario: SCN-PROBE-01 Greetings
- **WHEN** a caller requests a greeting
- **THEN** the greeting is ${body}
`;

async function probeOpenSpec(options) {
  const cmd = (name, args) => command(name, openspec, args, options);
  await cmd('openspec-init', ['init', '--tools', 'opencode', '--scope', 'project']);
  const folder = join(options.cwd, 'openspec');
  const path = join(folder, 'specs/greeting/spec.md');
  await write(
    path,
    '# Greeting Specification\n\n## Purpose\nDefines the externally visible greeting for startup verification.\n\n## Requirements\n\n' +
      spec('hello'),
  );
  const change = 'check-greeting';
  await cmd('openspec-change', ['new', 'change', change]);
  const delta = join(folder, 'changes', change);
  await write(
    join(delta, 'proposal.md'),
    '## Why\n\nVerify the public greeting contract.\n\n## What Changes\n\nReturn a short greeting.\n\n## Capabilities\n\n### Modified Capabilities\n- greeting\n\n## Impact\n\nUpdates greeting response.\n',
  );
  await write(join(delta, 'design.md'), 'Return hi for REQ-PROBE-01.\n');
  await write(join(delta, 'tasks.md'), '## 1. Greeting\n\n- [x] 1.1 Implement REQ-PROBE-01.\n');
  await write(join(delta, 'specs/greeting/spec.md'), '## MODIFIED Requirements\n\n' + spec('hi'));
  await cmd('openspec-validate', [
    'validate',
    change,
    '--type',
    'change',
    '--strict',
    '--json',
    '--no-interactive',
  ]);
  await cmd('openspec-status', ['status', '--change', change, '--json']);
  await cmd('openspec-instructions', ['instructions', 'apply', '--change', change, '--json']);
  await cmd('openspec-archive', ['archive', change, '-y']);
  const merged = await readFile(path, 'utf8');
  assert(merged.includes('the greeting is hi') && !merged.includes('the greeting is hello'));
  assert.equal(merged.split('### Requirement: REQ-PROBE-01').length, 2);
  await cmd('openspec-validate-base', [
    'validate',
    'greeting',
    '--type',
    'spec',
    '--strict',
    '--json',
    '--no-interactive',
  ]);
  const shown = JSON.parse(
    await cmd('openspec-show', ['show', 'greeting', '--type', 'spec', '--json']),
  );
  assert(shown.requirements?.some((r) => r.name.includes('REQ-PROBE-01')));
  summary.checks.strictIdsAndArchive = true;
}

const requests = [];
function startMock() {
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
      res.writeHead(404).end();
      return;
    }
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(body.model, 'smoke');
      requests.push({
        model: body.model,
        stream: body.stream,
        offersPropose: JSON.stringify(body).includes('openspec-propose'),
      });
      const base = { id: 'mock-' + requests.length, created: 1, model: 'smoke' };
      const usage = { prompt_tokens: 80, completion_tokens: 2, total_tokens: 82 };
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const part of [
          {
            choices: [
              { index: 0, delta: { role: 'assistant', content: 'hi' }, finish_reason: null },
            ],
          },
          { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage },
        ])
          res.write(
            'data: ' +
              JSON.stringify({ ...base, object: 'chat.completion.chunk', ...part }) +
              '\n\n',
          );
        res.end('data: [DONE]\n\n');
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            ...base,
            object: 'chat.completion',
            choices: [
              { index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' },
            ],
            usage,
          }),
        );
      }
    } catch {
      res.writeHead(400).end();
    }
  });
  return new Promise((res, rej) => {
    server.once('error', rej);
    server.listen(0, '127.0.0.1', () => res(server));
  });
}

async function startLocalRecorder() {
  const upstream = new URL(process.env.FRUGAL_LOCAL_BASE_URL);
  assert.equal(upstream.protocol, 'http:');
  assert(['localhost', '127.0.0.1', '[::1]'].includes(upstream.hostname));
  assert(!upstream.username && !upstream.password && !upstream.search && !upstream.hash);
  const target = new URL(
    upstream.pathname.replace(/\/$/, '') + '/chat/completions',
    upstream.origin,
  );
  let count = 0;
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions' || ++count !== 1) {
      res.writeHead(400).end('Expected one chat completions request');
      return;
    }
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      await write(join(evidence, 'provider-request.json'), body);
      assert.equal(JSON.parse(body).model, 'SmolLM2-360M-Instruct');
      const upstreamReply = await fetch(target, {
        method: 'POST',
        redirect: 'error',
        headers: { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(60000),
        body,
      });
      const bytes = Buffer.from(await upstreamReply.arrayBuffer());
      await write(join(evidence, 'provider-response.sse'), bytes);
      res
        .writeHead(upstreamReply.status, {
          'content-type': upstreamReply.headers.get('content-type') ?? 'text/event-stream',
        })
        .end(bytes);
    } catch (error) {
      res.writeHead(502).end(error.message);
    }
  });
  return new Promise((res, rej) => {
    server.once('error', rej);
    server.listen(0, '127.0.0.1', () => res(server));
  });
}

async function runV1(options, endpoint) {
  await probeOpenSpec(options);
  const id = {
    mock: 'frugal-mock/smoke',
    'live-free': 'opencode/deepseek-v4.1-flash-free',
    'live-local': 'mlx/SmolLM2-360M-Instruct',
  }[mode];
  const provider = id.split('/')[0];
  const config = {
    model: id,
    small_model: id,
    enabled_providers: [provider],
    autoupdate: false,
    share: 'disabled',
    plugin: ['./frugal-plugin/dist/index.js'],
    permission: { '*': 'deny', skill: 'allow' },
  };
  await cp(join(plugin, 'dist'), join(options.cwd, 'frugal-plugin/dist'), { recursive: true });
  await cp(join(plugin, 'package.json'), join(options.cwd, 'frugal-plugin/package.json'));
  if (endpoint) {
    const name = id.slice(provider.length + 1);
    config.provider = {
      [provider]: {
        npm: '@ai-sdk/openai-compatible',
        options: { baseURL: endpoint, apiKey: 'local-fixture', includeUsage: true },
        models: {
          [name]: {
            name,
            limit:
              mode === 'mock' ? { context: 32768, output: 2048 } : { context: 8192, output: 32 },
          },
        },
      },
    };
  }
  if (mode === 'live-local') {
    config.agent = { build: { prompt: 'Answer the user concisely.', temperature: 0 } };
    config.permission = { '*': 'deny' };
  }
  await write(join(options.cwd, 'opencode.json'), JSON.stringify(config));
  const skills = JSON.parse(await command('v1-skills', v1, ['debug', 'skill'], options));
  assert(
    skills.some(
      (skill) => skill.name === 'openspec-propose' && skill.location.includes('.agents/skills/'),
    ),
  );
  summary.checks.v1SkillDiscovery = true;
  const out = await command(
    'v1-events',
    v1,
    [
      'run',
      '--format',
      'json',
      '--title',
      'Frugal WP-00 smoke',
      '--model',
      id,
      'Reply with the single word hi. Do not use tools.',
    ],
    options,
  );
  const events = out
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const finish = events.find((event) => event.type === 'step_finish');
  assert(
    finish?.part?.tokens?.input > 0 && finish?.part?.tokens?.output > 0,
    'Missing accounted step_finish; inspect v1-events.stdout',
  );
  assert(!events.some((event) => event.type === 'error'));
  const sid = finish.sessionID;
  const exp = JSON.parse(await command('v1-export', v1, ['export', sid], options));
  const assistants = exp.messages
    .map((message) => message.info)
    .filter((message) => message.role === 'assistant');
  assert(
    assistants.length &&
      assistants.every(
        (message) =>
          message.modelID === id.slice(provider.length + 1) && message.providerID === provider,
      ),
  );
  await command('v1-stats', v1, ['stats'], options);
  const log = await readFile(options.env.FRUGAL_PLUGIN_LOAD_LOG, 'utf8');
  assert(log.includes('"entry":"server"'));
  Object.assign(summary.checks, {
    v1Plugin: true,
    model: id,
    session: sid,
    stepUsage: finish.part.tokens,
    cost: finish.part.cost,
  });
  if (mode === 'live-local') {
    const raw = await readFile(join(evidence, 'provider-response.sse'), 'utf8');
    const chunks = raw
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data: {'))
      .map((line) => JSON.parse(line.slice(6)));
    const usage = chunks.find((chunk) => chunk.usage)?.usage;
    assert(usage, 'Provider response did not return usage');
    assert.equal(
      usage.prompt_tokens,
      finish.part.tokens.input + finish.part.tokens.cache.read + finish.part.tokens.cache.write,
    );
    assert.equal(usage.completion_tokens, finish.part.tokens.output + finish.part.tokens.reasoning);
    summary.checks.providerUsage = usage;
  }
  if (mode === 'mock') {
    assert.equal(requests.length, 1, 'Unexpected background or repeated model calls');
    assert(requests[0].offersPropose, 'Skills missing from model input');
    summary.checks.v1ModelSeesSkill = true;
  }
}

async function runV2(options) {
  await cp(join(plugin, 'dist'), join(options.cwd, 'frugal-plugin/dist'), { recursive: true });
  await cp(join(plugin, 'package.json'), join(options.cwd, 'frugal-plugin/package.json'));
  await write(join(options.cwd, 'opencode.json'), JSON.stringify({ plugins: ['./frugal-plugin'] }));
  await command('v2-agents', v2, ['debug', 'agents', '--standalone'], options);
  const log = await readFile(options.env.FRUGAL_PLUGIN_LOAD_LOG, 'utf8');
  assert(log.includes('"entry":"setup"'));
  summary.checks.v2Plugin = true;
}

let mock;
try {
  const one = await environment('v1'),
    two = await environment('v2');
  for (const [name, executable, expected, options] of [
    ['openspec', openspec, '2.1.1', one],
    ['v1', v1, '1.19.6', one],
    ['v2', v2, '2.3.2', two],
  ]) {
    const version = await command(name + '-version', executable, ['--version'], options);
    assert.equal(version.replace(/^opencode v/, ''), expected);
    summary.checks[name + 'Version'] = version;
  }
  await command('v1-init', 'git', ['init', '-q'], one);
  await command('v2-init', 'git', ['init', '-q'], two);
  if (mode === 'mock') mock = await startMock();
  else {
    const previous = JSON.parse(await readFile(process.env.FRUGAL_MOCK_SUMMARY ?? '', 'utf8'));
    assert(
      previous.mode === 'mock' &&
        previous.status === 'passed' &&
        previous.checks.v1ModelSeesSkill &&
        previous.checks.v2Plugin,
      'A successful mock probe is required',
    );
  }
  if (mode === 'live-local') mock = await startLocalRecorder();
  await runV1(one, mock ? `http://127.0.0.1:${mock.address().port}/v1` : null);
  await runV2(two);
  summary.status = 'passed';
} catch (error) {
  summary.status = 'failed';
  summary.error = error.message;
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (mock) mock.close();
  await write(join(evidence, 'mock-requests.json'), JSON.stringify(requests, null, 2));
  summary.ended = new Date().toISOString();
  const copied = await readFile(join(run, 'v1/repo/frugal-plugin/dist/index.js')).catch(() => null);
  if (copied) summary.pluginSha256 = createHash('sha256').update(copied).digest('hex');
  if (mode === 'live-local' && process.env.FRUGAL_MLX_SERVER_LOG) {
    await cp(process.env.FRUGAL_MLX_SERVER_LOG, join(evidence, 'mlx-server.log'));
  }
  await write(join(evidence, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  const archive = join(root, 'bench/runs', `wp00-${mode}-${run.split('frugal-probe-').at(-1)}`);
  await mkdir(dirname(archive), { recursive: true });
  await cp(evidence, archive, { recursive: true, force: false, errorOnExist: true });
  // After the CLI exits there are no writers. Preserve any remaining SQLite WAL alongside its database.
  const data = join(run, 'v1/data/opencode');
  await cp(join(data, 'log'), join(archive, 'v1-log'), { recursive: true }).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
  const db = join(data, 'opencode.db');
  for (const suffix of ['', '-wal', '-shm']) {
    await cp(db + suffix, join(archive, 'opencode.db' + suffix)).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
  console.log(`Archive: ${archive}`);
}
