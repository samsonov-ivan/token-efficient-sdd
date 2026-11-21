import { execFile } from 'node:child_process';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { stageReply } from '../../packages/cli/dist/baseline.js';
import { runnerEnvironment } from '../../packages/cli/dist/harness/runner.js';

const execute = promisify(execFile);
const project = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const model = 'frugal-fixture/smoke';
const binaries = new Map([
  ['1.19.6', 'node_modules/.bin/opencode'],
  ['2.3.2', 'tools/opencode-v2/node_modules/.bin/opencode'],
]);

function settings(v1, url) {
  const options = { baseURL: url, apiKey: 'local-fixture' };
  const smoke = { name: 'Frugal fixture', limit: { context: 32768, output: 2048 } };
  if (v1) {
    return {
      model,
      small_model: model,
      enabled_providers: ['frugal-fixture'],
      autoupdate: false,
      share: 'disabled',
      permission: { '*': 'deny' },
      agent: { title: { disable: true } },
      provider: {
        'frugal-fixture': {
          npm: '@ai-sdk/openai-compatible',
          options,
          models: { smoke: { ...smoke, tool_call: false } },
        },
      },
    };
  }
  return {
    model,
    update: 'disable',
    share: 'disabled',
    permissions: [{ action: '*', resource: '*', effect: 'deny' }],
    policies: [{ action: 'tool.use', resource: '*', effect: 'deny' }],
    agents: { title: { disabled: true } },
    providers: {
      'frugal-fixture': {
        package: '@opencode/ai/providers/openai-compatible',
        settings: options,
        // V2 can expose a built-in skill descriptor even with a wildcard tool denial.
        body: { tools: [], tool_choice: 'none' },
        models: {
          smoke: { ...smoke, capabilities: { tools: false, input: ['text'], output: ['text'] } },
        },
      },
    },
  };
}

export async function openTaskHost(version, root, endpoint) {
  const relativeBinary = binaries.get(version);
  if (!relativeBinary) throw new Error(`Unsupported OpenCode version: ${version}`);
  const url = new URL(endpoint);
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]'].includes(url.hostname) ||
    !url.port ||
    url.pathname !== '/v1' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('A loopback fixture URL ending in /v1 is required');

  const pathFromProject = relative(await realpath(project), root);
  if (pathFromProject !== '..' && !pathFromProject.startsWith(`..${sep}`))
    throw new Error('Native task fixtures must run outside the controller checkout');
  await mkdir(root, { recursive: true, mode: 0o700 });
  if ((await realpath(root)) !== root)
    throw new Error('Native task fixture root must be canonical');
  const repo = join(root, 'repo');
  await mkdir(repo, { mode: 0o700 });
  const v1 = version === '1.19.6';
  const binary = join(project, relativeBinary);
  const env = {
    ...runnerEnvironment(root),
    PATH: process.env.PATH,
    SHELL: '/bin/bash',
    npm_config_offline: 'true',
    npm_config_fetch_retries: '0',
    // Keep dependency resolution inside the offline fixture as well as model traffic.
    npm_config_registry: 'http://127.0.0.1:1/',
    HTTP_PROXY: 'http://127.0.0.1:1/',
    HTTPS_PROXY: 'http://127.0.0.1:1/',
    NO_PROXY: '127.0.0.1,localhost,::1',
  };
  const run = (executable, args) => {
    const pending = execute(executable, args, {
      cwd: repo,
      env,
      timeout: 45000,
      killSignal: 'SIGKILL',
      maxBuffer: 16 * 1024 * 1024,
    });
    pending.child.stdin.end();
    return pending;
  };
  const observed = (await run(binary, ['--version'])).stdout.trim().replace(/^opencode v/, '');
  if (observed !== version) throw new Error(`Expected OpenCode ${version}; found ${observed}`);
  await run('git', ['init', '-q']);
  await writeFile(join(repo, 'opencode.json'), JSON.stringify(settings(v1, url.href)), {
    flag: 'wx',
  });
  const standalone = v1 ? [] : ['--standalone'];
  return {
    repo,
    async invoke(prompt, sessionId, title = 'Frugal task handoff fixture') {
      const args = ['run', ...standalone, '--format', 'json', '--model', model, '--title', title];
      if (sessionId) args.push('--session', sessionId);
      args.push('--', prompt);
      const { stdout, stderr } = await run(binary, args);
      try {
        const { session, answer } = stageReply({ code: 0, stdout, stderr });
        if (sessionId && session !== sessionId) throw new Error('Continuation switched sessions');
        return { sessionId: session, answer, stdout };
      } catch (error) {
        // OpenCode may exit successfully after emitting an error event. The caller
        // can retain the unmodified transcript for negative-control evidence.
        throw Object.assign(error, { stdout, stderr });
      }
    },
    async exportSession(id) {
      const args = v1 ? ['export', id] : ['session', 'export', ...standalone, id];
      return JSON.parse((await run(binary, args)).stdout);
    },
  };
}
