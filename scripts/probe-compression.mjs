#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { archivePath as logName, createHistory, fixtureDates, fixtureName } from './lib/h03-fixture.mjs';

const run = promisify(execFile);
const project = dirname(dirname(fileURLToPath(import.meta.url)));
const output = process.argv[2];
assert(
  output && process.argv.length === 3,
  'Usage: node scripts/probe-compression.mjs OUTPUT.json',
);
const tmp = await realpath(process.platform === 'darwin' ? '/tmp' : tmpdir());
const fromProject = relative(await realpath(project), tmp);
assert(
  fromProject === '..' || fromProject.startsWith(`..${sep}`),
  'TMPDIR must be outside this project',
);
const plugin = join(project, 'packages/opencode-plugin');
await access(join(plugin, 'dist/index.js'));
const fixtureRoot = await mkdtemp(join(tmp, 'frugal-h03-'));
const model = 'frugal-fixture/smoke';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function config(v1, baseURL) {
  const limit = { context: 32768, output: 2048 };
  const settings = { baseURL, apiKey: 'local-fixture' };
  const smoke = { name: 'Frugal fixture', limit };
  if (v1)
    return {
      model,
      small_model: model,
      enabled_providers: ['frugal-fixture'],
      autoupdate: false,
      share: 'disabled',
      agent: { title: { disable: true } },
      permission: { '*': 'deny', bash: 'allow', read: 'allow' },
      provider: {
        'frugal-fixture': {
          npm: '@ai-sdk/openai-compatible',
          options: settings,
          models: { smoke },
        },
      },
    };
  return {
    model,
    plugins: ['./frugal-plugin'],
    permissions: [
      { permission: 'execute', pattern: '*', action: 'deny' },
      { permission: 'shell', pattern: '*', action: 'allow' },
      { permission: 'read', pattern: '*', action: 'allow' },
    ],
    providers: {
      'frugal-fixture': {
        package: '@opencode/ai/providers/openai-compatible',
        settings,
        models: {
          smoke: { ...smoke, capabilities: { tools: true, input: ['text'], output: ['text'] } },
        },
      },
    },
  };
}

async function probe(binary, version, enabled) {
  const v1 = version.startsWith('1.');
  const shell = v1 ? 'bash' : 'shell';
  const arm = await mkdtemp(join(fixtureRoot, 'arm-'));
  const cwd = join(arm, 'repo');
  const env = {
    PATH: process.env.PATH,
    SHELL: '/bin/bash',
    CI: '1',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    ...fixtureDates,
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_SHARE: '1',
    npm_config_offline: 'true',
    npm_config_fetch_retries: '0',
    FRUGAL_TOOL_OUTPUT_COMPRESSION: enabled ? '1' : '0',
    ...(v1 && { FRUGAL_USAGE_CORRELATION: '1' }),
  };
  for (const key of [
    'HOME',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_CACHE_HOME',
    'XDG_STATE_HOME',
    'TMPDIR',
    'OPENCODE_CONFIG_DIR',
  ]) {
    env[key] = join(arm, key);
    await mkdir(env[key], { mode: 0o700 });
  }
  await mkdir(cwd);
  const opts = { cwd, env, timeout: 30000, killSignal: 'SIGKILL' };
  assert.equal(
    (await run(binary, ['--version'], opts)).stdout.trim().replace(/^opencode v/, ''),
    version,
  );
  const git = (...args) => run('git', args, opts).then(({ stdout }) => stdout);
  await createHistory(git);
  const original = await git('log', '--oneline');
  const digest = sha256(original);
  const log = join(cwd, '.frugal/logs', `${digest}.log`);
  if (v1) {
    const plugins = join(env.OPENCODE_CONFIG_DIR, 'plugins');
    await mkdir(plugins);
    await cp(join(plugin, 'dist/index.js'), join(plugins, 'frugal.js'));
  } else {
    await mkdir(join(cwd, 'frugal-plugin'));
    await cp(join(plugin, 'dist'), join(cwd, 'frugal-plugin/dist'), { recursive: true });
    await cp(join(plugin, 'package.json'), join(cwd, 'frugal-plugin/package.json'));
  }
  await writeFile(join(cwd, 'frugal.yaml'), 'version: 1\nflags: {tool_output_compression: true}\n');

  let requestId = 0;
  let shellSeen;
  let readSeen;
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions')
      return res.writeHead(404).end();
    try {
      const chunks = [];
      for await (const part of req) chunks.push(part);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const tools = body.tools?.map((tool) => tool.function?.name) ?? [];
      const results = body.messages.filter((message) => message.role === 'tool');
      if (results.length > 0) shellSeen = results[0].content;
      if (results.length > 1) readSeen = results[1].content;
      let tool;
      if (!results.length && tools.includes(shell))
        tool = {
          name: shell,
          args: { command: 'git log --oneline', description: 'Read the public fixture log' },
        };
      if (results.length === 1 && logName.test(String(shellSeen)) && tools.includes('read'))
        tool = { name: 'read', args: v1 ? { filePath: log } : { path: log } };
      requestId++;
      const delta = tool
        ? {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: `call_${requestId}`,
                type: 'function',
                function: { name: tool.name, arguments: JSON.stringify(tool.args) },
              },
            ],
          }
        : { role: 'assistant', content: 'Fixture complete.' };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const choice of [
        { index: 0, delta, finish_reason: null },
        { index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' },
      ]) {
        res.write(
          `data: ${JSON.stringify({
            id: `fixture-${requestId}`,
            object: 'chat.completion.chunk',
            created: 1,
            model: 'smoke',
            choices: [choice],
          })}\n\n`,
        );
      }
      res.end('data: [DONE]\n\n');
    } catch {
      res.writeHead(400).end();
    }
  });
  await new Promise((resolve, reject) =>
    server.once('error', reject).listen(0, '127.0.0.1', resolve),
  );
  try {
    const baseURL = `http://127.0.0.1:${server.address().port}/v1`;
    await writeFile(join(cwd, 'opencode.json'), JSON.stringify(config(v1, baseURL)));
    const args = [
      'run',
      '--model',
      model,
      '--format',
      'json',
      ...(v1 ? ['--title', 'Frugal H03 fixture'] : ['--standalone']),
      'Read the public fixture history and recover the archived original when present.',
    ];
    const execution = run(binary, args, opts);
    // OpenCode reads piped stdin before running the prompt.
    execution.child.stdin.end();
    const { stdout } = await execution.catch((error) => {
      throw new Error(
        `OpenCode ${version} received ${requestId} fixture requests. ${error.message}`,
        {
          cause: error,
        },
      );
    });
    const events = stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const bash = events.find((event) => event.type === 'tool_use' && event.part.tool === shell);
    const state = bash?.part.state;
    assert.equal(state?.status, 'completed', 'OpenCode must execute the shell fixture');
    assert.equal(
      typeof shellSeen,
      'string',
      'The fixture must see a shell result on the next request',
    );

    if (enabled) {
      const archive = logName.exec(state.output);
      assert.equal(archive?.[2], digest);
      assert.equal(logName.exec(shellSeen)?.[2], digest);
      assert(shellSeen.length < original.length);
      if (v1) assert.equal(state.metadata.frugalToolOutputSha256, digest);
      const bytes = await readFile(log);
      assert.deepEqual(bytes, Buffer.from(original));
      const read = events.find((event) => event.type === 'tool_use' && event.part.tool === 'read');
      assert.equal(read?.part.state.status, 'completed');
      assert(String(readSeen).includes('Public fixture example no. 12'));
      assert(!shellSeen.includes('Public fixture example no. 12'));
      return {
        chars: shellSeen.length,
        sourceSha256: digest,
        archiveSha256: sha256(bytes),
        recovered: true,
      };
    }
    assert.equal(state.output, original);
    assert.equal(shellSeen, original);
    assert.equal(state.metadata?.frugalToolOutputSha256, undefined);
    await assert.rejects(access(join(cwd, '.frugal')), { code: 'ENOENT' });
    return { chars: shellSeen.length, sourceSha256: digest };
  } finally {
    server.close();
  }
}

try {
  const checks = {};
  for (const [version, path] of [
    ['1.19.6', 'node_modules/.bin/opencode'],
    ['2.3.2', 'tools/opencode-v2/node_modules/.bin/opencode'],
  ]) {
    const binary = join(project, path);
    const baseline = await probe(binary, version, false);
    const compressed = await probe(binary, version, true);
    assert.equal(baseline.sourceSha256, compressed.sourceSha256);
    checks[version] = { baseline, compressed };
  }
  const report = {
    fixture: fixtureName,
    endpoint: 'loopback',
    node: process.version,
    pluginSha256: sha256(await readFile(join(plugin, 'dist/index.js'))),
    checks,
  };
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  console.log(output);
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}
