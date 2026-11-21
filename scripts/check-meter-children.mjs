// Exercise real V1 subprocesses against a local provider. This fixture never loads a provider key.
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { meterRun } from '../packages/cli/dist/meter.js';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const scratch = mkdtempSync(join(tmpdir(), 'frugal-children-'));
assert(relative(repoRoot, scratch).startsWith('..'), 'TMPDIR must be outside the project');
const output = process.argv[2] ? resolve(process.argv[2]) : join(scratch, 'capture');
mkdirSync(dirname(output), { recursive: true });
mkdirSync(output);
const raw = join(output, 'raw'),
  cwd = join(scratch, 'repo');
for (const dir of [raw, cwd]) mkdirSync(dir);
const env = {
  PATH: process.env.PATH,
  LANG: 'en_US.UTF-8',
  CI: '1',
  DO_NOT_TRACK: '1',
  OPENCODE_DISABLE_AUTOUPDATE: '1',
  OPENCODE_DISABLE_MODELS_FETCH: '1',
  OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
  GIT_CONFIG_NOSYSTEM: '1',
  NO_COLOR: '1',
};
for (const [key, name] of Object.entries({
  HOME: 'home',
  XDG_CONFIG_HOME: 'config',
  XDG_CACHE_HOME: 'cache',
  XDG_DATA_HOME: 'data',
  XDG_STATE_HOME: 'state',
  OPENCODE_CONFIG_DIR: 'config/opencode',
  TMPDIR: 'tmp',
})) {
  env[key] = join(scratch, name);
  mkdirSync(env[key]);
}
execFileSync('git', ['init', '-q'], { cwd, env });
const opencode = join(repoRoot, 'node_modules/.bin/opencode');
const execute = promisify(execFile);
const invoke = (args) => {
  const proc = execute(opencode, args, { cwd, env, timeout: 90_000, maxBuffer: 32 * 1024 * 1024 });
  proc.child.stdin.end();
  return proc;
};
const fullModel = 'meter-local/demo';
const requests = [];
const server = createServer(async (req, res) => {
  try {
    assert(req.method === 'POST' && req.url.endsWith('/chat/completions'));
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    assert.equal(body.model, 'demo');
    assert.equal(body.stream, true);
    const index = requests.length + 1;
    assert(index <= 5, 'unexpected provider loop');
    const usage = {
      prompt_tokens: index * 100,
      completion_tokens: index * 5,
      total_tokens: index * 105,
    };
    const requestId = 'req-local-' + index;
    requests.push({ request_id: requestId, model: body.model, usage });
    appendFileSync(join(raw, 'observed-requests.jsonl'), JSON.stringify(requests.at(-1)) + '\n');
    const tool = body.tools?.find((t) => t.function.name === 'task');
    const first = index === 1;
    if (first) {
      assert(tool, 'task tool missing');
      writeFileSync(join(raw, 'task-definition.json'), JSON.stringify(tool, null, 2));
    }
    const args = {
      description: 'Compute small fixture',
      prompt: 'Reply child-ok using plain text without calling tools.',
      subagent_type: 'general',
    };
    const delta = first
      ? {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: 'call-child',
              type: 'function',
              function: { name: 'task', arguments: JSON.stringify(args) },
            },
          ],
        }
      : { role: 'assistant', content: 'ok' };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const part of [
      { choices: [{ index: 0, delta, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: first ? 'tool_calls' : 'stop' }], usage },
    ]) {
      res.write(
        'data: ' +
          JSON.stringify({
            id: requestId,
            created: 1,
            model: 'demo',
            object: 'chat.completion.chunk',
            ...part,
          }) +
          '\n\n',
      );
    }
    res.end('data: [DONE]\n\n');
  } catch (error) {
    console.error(error.message);
    res.writeHead(400).end();
  }
});
await new Promise((yes, no) => {
  server.once('error', no);
  server.listen(0, '127.0.0.1', yes);
});
console.log('Capture', output);
const started = new Date().toISOString();
try {
  const version = (await invoke(['--version'])).stdout.trim();
  assert.equal(version, '1.19.6');
  const config = {
    model: fullModel,
    small_model: fullModel,
    enabled_providers: ['meter-local'],
    share: 'disabled',
    autoupdate: false,
    permission: { '*': 'deny', task: 'allow' },
    provider: {
      'meter-local': {
        npm: '@ai-sdk/openai-compatible',
        options: {
          baseURL: `http://127.0.0.1:${server.address().port}/v1`,
          apiKey: 'local-fixture',
        },
        models: { demo: { name: 'Test', limit: { context: 32768, output: 2048 } } },
      },
    },
  };
  writeFileSync(join(cwd, 'opencode.json'), JSON.stringify(config));
  const { stdout, stderr } = await invoke([
    'run',
    '--format',
    'json',
    '--title',
    'Frugal child smoke',
    '--model',
    fullModel,
    'Ask the general subagent to reply ok, then finish.',
  ]);
  writeFileSync(join(raw, 'events.jsonl'), stdout);
  writeFileSync(join(raw, 'opencode.stderr'), stderr);
  const events = stdout
    .trim()
    .split('\n')
    .map((s) => JSON.parse(s));
  const first = events.find((e) => e.type === 'step_finish');
  assert(first, 'no completed step');
  const rootSession = first.sessionID;
  const ended = new Date().toISOString();
  const manifest = {
    schema: 'frugal.meter-smoke.v1',
    kind: 'meter-smoke',
    run_id: basename(output),
    pair_id: null,
    feature_id: 'wp02-child-smoke',
    model: fullModel,
    provider: 'meter-local',
    branch: 'base',
    dry_run: true,
    status: 'complete',
    stages: [
      {
        session_id: rootSession,
        stage: 'apply',
        task: '1',
        started_at: started,
        finished_at: ended,
      },
    ],
    started_at: started,
    finished_at: ended,
    versions: { opencode: version, node: process.version },
    metering: { title_disabled: true },
  };
  writeFileSync(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  writeFileSync(join(raw, 'stats.txt'), (await invoke(['stats'])).stdout);
  writeFileSync(join(raw, 'export.json'), (await invoke(['export', rootSession])).stdout);
  execFileSync(
    'sqlite3',
    ['-readonly', join(env.XDG_DATA_HOME, 'opencode/opencode.db'), '.backup opencode.db'],
    { cwd: raw },
  );
  const meter = await meterRun(output);
  const nCli = events.filter((e) => e.type === 'step_finish').length;
  const calls = readFileSync(join(output, 'calls.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((x) => JSON.parse(x));
  const child = calls.filter((c) => c.parent_session_id === rootSession);
  const providerRpt = requests.reduce((sum, row) => sum + row.usage.total_tokens, 0);
  const discrepancy =
    providerRpt && meter.rpt !== null ? Math.abs(meter.rpt - providerRpt) / providerRpt : null;
  const matched =
    meter.complete &&
    discrepancy === 0 &&
    nCli === 2 &&
    child.length === 1 &&
    child[0].stage === 'apply' &&
    meter.call_count === requests.length &&
    requests.length === 3;
  const result = {
    run_id: manifest.run_id,
    matched,
    provider_requests: requests.length,
    provider_rpt: providerRpt,
    cli_steps: nCli,
    child_steps: child.length,
    child_session_ids: child.map((c) => c.session_id),
    meter_calls: meter.call_count,
    meter_rpt: meter.rpt,
    relative_discrepancy: discrepancy,
    issues: meter.issues,
  };
  writeFileSync(join(output, 'reconciliation.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
  assert(matched, 'See reconciliation and raw artifacts');
} finally {
  server.close();
}
