// Native local-model apply pilot. The controller never supplies assistant responses.
import assert from 'node:assert/strict';
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
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { digest, git, readJson, writeJson } from '../packages/cli/dist/harness/io.js';
import { createSettings, platformBin } from '../packages/cli/dist/harness/runner.js';
import {
  account,
  loopbackEndpoint,
  openTransport,
  pilotEnvironment,
  pilotSandbox,
  publicChecks,
} from './fixtures/local-pilot-transport.mjs';

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
const endpoint = loopbackEndpoint(options.endpoint);
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
const { sandboxProfile, command } = pilotSandbox(repo);
const transport = await openTransport({
  endpoint,
  model,
  limits,
  timeout,
  tools: ['edit', 'read', 'write'],
});
const { port } = transport;
const run = {
  controller_commit: git(project, ['rev-parse', 'HEAD']),
  script_sha256: digest(readFileSync(fileURLToPath(import.meta.url))),
  transport_sha256: digest(
    readFileSync(new URL('./fixtures/local-pilot-transport.mjs', import.meta.url)),
  ),
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
const qualityAt = (dir, env) => publicChecks(dir, repo, fixtureFile, env);
const snapshot = () => {
  git(repo, ['add', '-A']);
  return git(repo, ['write-tree']);
};
try {
  for (const arm of armOrder) {
    const dir = join(out, arm);
    mkdirSync(dir);
    const env = pilotEnvironment(runtime);
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
      const { result, calls } = await transport.stage(arm, task, taskDir, async (token) =>
        continued && !previous
          ? { code: 1, stdout: '', stderr: 'No session available for continuation' }
          : await command(host, args, { ...env, FRUGAL_RELAY_TOKEN: token }, profile, timeout),
      );
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
      const usage = account(events, calls);
      const finish = events.filter((e) => e.type === 'step_finish');
      const sessionOK =
        source === 'native-event' &&
        calls[0]?.has_assistant_history === continued &&
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
        ...usage,
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
          complete: usage.complete_provider_usage,
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
  await transport.close();
}
