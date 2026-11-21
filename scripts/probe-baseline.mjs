#!/usr/bin/env node
// Local transport test with a scripted responder; it can only request writes inside this fixture.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { executeBaseline } from '../packages/cli/dist/baseline.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = await realpath(tmpdir());
const rel = relative(root, tmp);
assert(rel === '..' || rel.startsWith('..' + sep), 'TMPDIR must be outside the project');
const dir = await mkdtemp(join(tmp, 'frugal-b0-probe-'));
const bin = join(root, 'node_modules/.bin');
const repo = join(dir, 'work');
const runDir = join(dir, 'result');
const configDir = join(dir, 'config/opencode');
const feature = 'check-greeting';
const model = 'local-fixture/smoke';
const brief = 'Add a greeting that returns hello.';
const env = {
  PATH: bin + ':' + process.env.PATH, LANG: 'en_US.UTF-8', CI: '1',
  HOME: join(dir, 'home'), XDG_CONFIG_HOME: join(dir, 'config'), XDG_DATA_HOME: join(dir, 'data'),
  XDG_STATE_HOME: join(dir, 'state'), XDG_CACHE_HOME: join(dir, 'cache'), TMPDIR: join(dir, 'tmp'),
  OPENCODE_CONFIG_DIR: configDir, OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1',
  OPENCODE_DISABLE_DEFAULT_PLUGINS: '1', OPENSPEC_TELEMETRY: '0', DO_NOT_TRACK: '1',
  GIT_CONFIG_NOSYSTEM: '1', NO_COLOR: '1',
};
for (const path of [repo, runDir, configDir, env.HOME, env.TMPDIR, join(env.XDG_CONFIG_HOME, 'openspec')]) {
  await mkdir(path, { recursive: true });
}
const execute = promisify(execFile);
function exec(file, args, options) {
  const result = execute(file, args, options);
  result.child.stdin.end();
  return result;
}
const opts = { cwd: repo, env, timeout: 90000, maxBuffer: 8 * 1024 * 1024 };
await writeFile(join(env.XDG_CONFIG_HOME, 'openspec/config.json'), JSON.stringify({
  profile: 'custom', workflows: ['propose','explore','apply','update','sync','archive','verify'],
  delivery: 'skills', skillsScope: 'project',
}));
await exec(join(bin, 'openspec'), ['init', '--tools', 'opencode', '--scope', 'project', '--no-animation'], opts);

const change = 'openspec/changes/' + feature;
const files = {
  spec: [
    [change + '/proposal.md', '## Why\n\nA stable greeting lets callers confirm the public interface responds.\n\n## What Changes\n\nProvide a greeting.'],
    [change + '/design.md', '# Design\nReturn a string literal.'],
    [change + '/specs/greeting/spec.md', '## ADDED Requirements\n\n### Requirement: Greeting\nThe application SHALL return hello.\n\n#### Scenario: Request\n- **WHEN** called\n- **THEN** it returns hello.'],
    [change + '/tasks.md', '- [ ] 1.1 Implement greeting'],
  ],
  apply: [
    ['greeting.js', 'export const greet = () => "hello";\n'],
    [change + '/tasks.md', '- [x] 1.1 Implement greeting'],
  ],
};
let stage = '';
let readCalls = 0;
let changesWritten = 0;
const requests = [];
const server = createServer(async (req, res) => {
  try {
    assert.equal(req.method, 'POST');
    assert(req.url.endsWith('/chat/completions'));
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(body.model, 'smoke');
    assert.equal(body.stream, true);
    const user = body.messages.find(m => m.role === 'user');
    const prompt = typeof user?.content === 'string' ? user.content : JSON.stringify(user?.content);
    if (stage === 'spec') {
      assert(prompt.includes('openspec-propose') && prompt.includes(brief), 'missing stock proposal or public brief');
    } else if (stage === 'apply' || stage === 'verify') {
      assert(prompt.includes('openspec-' + stage + '-change') && prompt.includes(feature), 'missing stock skill or change ID');
    } else {
      assert(prompt.includes('Review the full change ' + feature), 'missing review instruction');
    }
    const tools = body.tools.map(tool => tool.function.name);
    const turn = requests.length + 1;
    const data = [];
    function useTool(name, args) {
      assert(tools.includes(name), 'Unavailable fixture tool: ' + name);
      data.push({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{
        index: 0, id: 'call_' + turn, type: 'function', function: { name, arguments: JSON.stringify(args) },
      }] }, finish_reason: null }] });
    }
    const file = files[stage]?.[changesWritten];
    let finish = 'stop';
    if ((stage === 'review' || stage === 'verify') && readCalls < 2) {
      const path = readCalls === 0 ? 'greeting.js' : change + '/specs/greeting/spec.md';
      useTool('read', { filePath: join(repo, path) });
      readCalls++;
      finish = 'tool_calls';
    } else if (file && stage === 'apply' && file[0].endsWith('tasks.md') && readCalls === 0) {
      useTool('read', { filePath: join(repo, file[0]) });
      readCalls++;
      finish = 'tool_calls';
    } else if (file) {
      useTool('write', { filePath: join(repo, file[0]), content: file[1] });
      changesWritten++;
      finish = 'tool_calls';
    } else {
      const reply = stage === 'review' ? 'Fixture review of greeting source and specification.\nVERDICT: ACCEPT'
        : stage === 'verify' ? 'Fixture verification of the greeting.\nVERIFY: PASS' : 'Fixture stage complete.';
      data.push({ choices: [{ index: 0, delta: { role: 'assistant', content: reply }, finish_reason: null }] });
    }
    data.push({ choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: {
      prompt_tokens: 80, completion_tokens: 10, total_tokens: 90,
    } });
    requests.push({stage, turn, finish});
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const chunk of data) res.write('data: ' + JSON.stringify({
      id: 'mock-' + turn, object: 'chat.completion.chunk', created: 1, model: 'smoke', ...chunk,
    }) + '\n\n');
    res.end('data: [DONE]\n\n');
  } catch (err) {
    console.error(String(err));
    res.writeHead(400).end();
  }
});
await new Promise((res, rej) => { server.once('error', rej); server.listen(0, '127.0.0.1', res); });
const port = server.address().port;
console.log('Evidence directory ' + runDir);
try {
  const profile = {
    model, small_model: model, enabled_providers: ['local-fixture'], autoupdate: false, share: 'disabled',
    permission: { '*': 'deny', read: 'allow', edit: 'allow' },
    provider: { 'local-fixture': { npm: '@ai-sdk/openai-compatible',
      options: { baseURL: 'http://127.0.0.1:' + port + '/v1', apiKey: 'local-fixture' },
      models: { smoke: { name: 'Smoke fixture', limit: { context: 131072, output: 4096 } } },
    } },
  };
  await writeFile(join(configDir, 'opencode.json'), JSON.stringify(profile));
  await executeBaseline({
    repo, runDir, configDir, assetsRoot: join(root, 'assets'), feature, requirement: brief, model,
    async invoke(req) {
      stage = req.stage;
      changesWritten = 0;
      readCalls = 0;
      let record;
      try {
        record = { ...await exec(join(bin, 'opencode'), req.args, opts), code: 0 };
      } catch (error) {
        record = { stdout: error.stdout ?? '', stderr: error.stderr ?? '', code: Number(error.code) || 1 };
      }
      const prefix = join(runDir, stage + (req.reviewIter ? '-' + req.reviewIter : ''));
      await writeFile(prefix + '.jsonl', record.stdout);
      await writeFile(prefix + '.stderr', record.stderr);
      return record;
    },
  });
  assert((await readFile(join(repo, 'greeting.js'), 'utf8')).includes('hello'));
  assert.deepEqual([...new Set(requests.map(r => r.stage))], ['spec','apply','review','verify']);
  console.log('B0 stock command dispatch, tool writes, review and verify passed on a local scripted provider.');
} finally {
  await writeFile(join(runDir, 'fixture-requests.json'), JSON.stringify(requests, null, 2));
  server.close();
}
