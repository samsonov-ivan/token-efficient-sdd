// An independent public-feature pilot. frugal run and its admission rules are unchanged.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { executeBaseline } from '../packages/cli/dist/baseline.js';
import { markdownLines } from '../packages/cli/dist/capsule.js';
import { digest, git, readJson, writeJson } from '../packages/cli/dist/harness/io.js';
import { executeLiveOptimized } from '../packages/cli/dist/harness/live-opt.js';
import { invocationStem } from '../packages/cli/dist/harness/replay.js';
import { createSettings, platformBin } from '../packages/cli/dist/harness/runner.js';
import { brief, prepare } from './fixtures/local-context-pilot/fixture.mjs';
import {
  account,
  loopbackEndpoint,
  openTransport,
  pilotEnvironment,
  pilotSandbox,
  publicChecks,
} from './fixtures/local-pilot-transport.mjs';

const { values: opt } = parseArgs({
  options: {
    help: { type: 'boolean' },
    simulation: { type: 'boolean' },
    ...Object.fromEntries(
      ['arm', 'endpoint', 'model', 'out', 'steps', 'context', 'max-output', 'timeout-ms'].map(
        (k) => [k, { type: 'string' }],
      ),
    ),
  },
});
if (opt.help) {
  console.log(
    'node scripts/pilot-full-sdd.mjs --arm baseline|optimized --endpoint http://127.0.0.1:PORT/v1 --model ID --out NEW_DIR [--simulation] [--steps 10] [--context 32768] [--max-output 2048] [--timeout-ms 1500000]',
  );
  process.exit(0);
}
const arm = opt.arm;
assert(['baseline', 'optimized'].includes(arm), 'Choose baseline or optimized');
const endpoint = loopbackEndpoint(opt.endpoint);
const model = opt.model;
assert(typeof model === 'string' && /^[\w.][\w./:-]*$/.test(model), 'Invalid model ID');
const limits = { context: Number(opt.context ?? 32768), output: Number(opt['max-output'] ?? 2048) };
const steps = Number(opt.steps ?? 10),
  timeout = Number(opt['timeout-ms'] ?? 1_500_000);
assert(Number.isInteger(steps) && steps >= 8 && steps <= 12, 'Choose 8–12 native steps per stage');
assert(
  Number.isSafeInteger(timeout) && timeout > 0 && timeout <= 1_500_000,
  'One arm has at most 25 minutes',
);
assert(
  Number.isSafeInteger(limits.context) &&
    Number.isSafeInteger(limits.output) &&
    limits.context > limits.output &&
    limits.output > 0,
);
const feature = 'queue-conditional-drain';
const files = { '1.1': 'test/dequeue-if.test.mjs', '1.2': 'test/drain-while.test.mjs' };
const requirement = [
  brief,
  'Create exactly two initially unchecked numbered tasks in tasks.md, with IDs 1.1 and 1.2 in this order.',
  'Task 1.1 implements dequeueIf and adds substantive public node:test coverage in test/dequeue-if.test.mjs. Task 1.2 implements drainWhile using dequeueIf and adds substantive coverage in test/drain-while.test.mjs.',
  'Keep the existing API and MIT license. Run the public tests using node --test; there are no external dependencies.',
].join('\n\n');
const project = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const fixtureFile = join(project, 'scripts/fixtures/local-context-pilot/fixture.mjs');
const host = realpathSync(platformBin(project, 'opencode')),
  openspec = realpathSync(platformBin(project, 'openspec'));
const requestedOut = resolve(opt.out);
const parent = realpathSync(tmpdir());
assert(parent !== project && !parent.startsWith(project + '/'), 'Use an isolated TMPDIR');
mkdirSync(dirname(requestedOut), { recursive: true });
mkdirSync(requestedOut, { mode: 0o700 });
const out = realpathSync(requestedOut);
const runtime = mkdtempSync(join(parent, 'frugal-full-pilot-')),
  repo = join(runtime, 'repo');
mkdirSync(repo);
const bin = join(runtime, 'bin');
mkdirSync(bin);
symlinkSync(openspec, join(bin, 'openspec'));
symlinkSync(process.execPath, join(bin, 'node'));
const env = {
  ...pilotEnvironment(runtime),
  PATH: bin + ':/usr/bin:/bin:/usr/sbin:/sbin',
  SHELL: '/bin/bash',
  NO_COLOR: '1',
};
const { command, sandboxProfile } = pilotSandbox(repo);
const nodeHome = dirname(dirname(process.execPath));
const toolsRead = [runtime, host, join(project, 'node_modules'), nodeHome];
const toolsWrite = [
  repo,
  env.HOME,
  env.XDG_DATA_HOME,
  env.XDG_CACHE_HOME,
  env.XDG_STATE_HOME,
  env.TMPDIR,
];
const offline = sandboxProfile(
  toolsRead,
  [...toolsWrite, env.XDG_CONFIG_HOME, env.OPENCODE_CONFIG_DIR],
  null,
);
const names = [
  'bash',
  'read',
  'glob',
  'grep',
  'edit',
  'write',
  'apply_patch',
  'skill',
  'ls',
  'list',
];
const clock = performance.now();
const deadline = clock + timeout;
function remaining(reserve = 0) {
  const ms = Math.floor(deadline - performance.now() - reserve);
  assert(ms > 0, 'Arm wall-time budget exhausted');
  return ms;
}
const run = {
  kind: opt.simulation ? 'public-full-sdd-contract-simulation' : 'public-local-full-sdd-pilot',
  arm,
  model,
  endpoint: endpoint.href,
  feature,
  requirement,
  controller_commit: git(project, ['rev-parse', 'HEAD']),
  script_sha256: digest(readFileSync(fileURLToPath(import.meta.url))),
  transport_sha256: digest(
    readFileSync(new URL('./fixtures/local-pilot-transport.mjs', import.meta.url)),
  ),
  fixture_sha256: digest(readFileSync(fixtureFile)),
  steps,
  limits,
  timeout_ms: timeout,
  task_retries: 0,
  max_review_fixes: 1,
  flags: { session_per_task: arm === 'optimized', capsule: false },
  quality_scope: 'public fixture only',
  status: 'running',
  stages: [],
  pipeline_complete: false,
  public_checks: null,
};
const persist = () => writeJson(join(out, 'run.json'), run);
persist();
let transport;
function snapshot(destination) {
  const idx = join(runtime, `git-index-${randomUUID()}`);
  const cfg = { GIT_INDEX_FILE: idx };
  try {
    git(repo, ['read-tree', 'HEAD'], cfg);
    git(repo, ['add', '-A'], cfg);
    const tree = git(repo, ['write-tree'], cfg);
    if (destination) {
      mkdirSync(destination);
      git(repo, ['checkout-index', '--all', '--prefix=' + destination + '/'], cfg);
    }
    return tree;
  } finally {
    rmSync(idx, { force: true });
  }
}
async function checked(binary, args, profile, label, cwd = repo) {
  const result = await pilotSandbox(cwd).command(
    binary,
    args,
    env,
    profile,
    Math.min(remaining(), 30000),
  );
  writeJson(join(out, 'checks', label + '.json'), result);
  assert.equal(result.code, 0, `${label}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}
async function publicTests(ids, label, cwd = repo) {
  let passed = false;
  try {
    const sources = ids.map((id) => files[id]);
    for (const name of sources) {
      const file = join(cwd, name);
      assert(
        realpathSync(file) === file && lstatSync(file).isFile(),
        'Missing ordinary public test ' + name,
      );
    }
    const text = await checked(
      process.execPath,
      ['--test', '--test-reporter=tap', ...sources],
      sandboxProfile([cwd, nodeHome], [], null),
      label,
      cwd,
    );
    passed =
      /^# tests [1-9]\d*$/m.test(text) &&
      ['fail', 'cancelled', 'skipped', 'todo'].every((key) =>
        new RegExp('^# ' + key + ' 0$', 'm').test(text),
      );
  } catch (error) {
    writeJson(join(out, 'checks', label + '-error.json'), { error: error.message });
  }
  return passed;
}
function groupOK(checks, key) {
  return checks?.[key]?.total > 0 && checks[key].passed === checks[key].total;
}
async function external(label, cwd = repo) {
  const dir = join(out, 'checks', label);
  mkdirSync(dir, { recursive: true });
  return publicChecks(dir, cwd, fixtureFile, env, Math.min(remaining(), 20000));
}
function checkInventory() {
  const path = join(repo, 'openspec', 'changes', feature, 'tasks.md');
  assert.equal(realpathSync(path), path);
  const rows = markdownLines(readFileSync(path, 'utf8'))
    .filter((x) => !x.literal)
    .map((x) => x.text.match(/^\s*[-*+]\s+\[([ xX])\]\s+(\S+)/))
    .filter(Boolean);
  assert.deepEqual(
    rows.map((r) => [r[1], r[2]]),
    [
      [' ', '1.1'],
      [' ', '1.2'],
    ],
    'Expected exactly two open tasks: 1.1, 1.2',
  );
}
try {
  await prepare(repo);
  git(repo, ['init', '-q']);
  git(repo, ['add', '-A']);
  git(repo, [
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    '-c',
    'core.hooksPath=/dev/null',
    'commit',
    '-qm',
    'Public queue fixture',
  ]);
  run.input_tree = snapshot();
  run.base_checks = await external('base');
  assert(
    groupOK(run.base_checks, 'api') &&
      run.base_checks.task1.passed === 0 &&
      run.base_checks.task2.passed === 0,
    'Invalid initial fixture',
  );
  transport = await openTransport({
    endpoint,
    model,
    limits,
    timeout,
    tools: names,
    signal: AbortSignal.timeout(remaining()),
  });
  createSettings(env, 'pilot/' + model, `http://127.0.0.1:${transport.port}/v1`, limits, true);
  const cfgPath = join(env.OPENCODE_CONFIG_DIR, 'opencode.json'),
    cfg = readJson(cfgPath);
  cfg.permission = {
    '*': 'deny',
    read: 'allow',
    glob: 'allow',
    grep: 'allow',
    edit: 'allow',
    skill: 'allow',
    bash: 'allow',
    external_directory: 'deny',
  };
  for (const name of ['build', 'base-reviewer', 'base-fixer'])
    cfg.agent[name] = { steps, temperature: 0 };
  cfg.provider.pilot.models[model].temperature = true;
  cfg.provider.pilot.models[model].options = { maxOutputTokens: limits.output };
  writeJson(cfgPath, cfg);
  run.opencode_version = await checked(host, ['--version'], offline, 'opencode-version');
  run.openspec_version = await checked(
    process.execPath,
    [openspec, '--version'],
    offline,
    'openspec-version',
  );
  assert.equal(run.opencode_version, '1.19.6');
  assert.equal(run.openspec_version, '2.1.1');
  await checked(
    process.execPath,
    [openspec, 'init', '--tools', 'opencode', '--scope', 'project', '--no-animation'],
    offline,
    'openspec-init',
  );
  // V1 initializes these files even for a read-only command. Both configuration
  // directories remain read-only throughout model execution.
  for (const dir of [env.OPENCODE_CONFIG_DIR, join(env.XDG_CONFIG_HOME, 'opencode')]) {
    const ignore = join(dir, '.gitignore');
    if (!existsSync(ignore))
      writeFileSync(ignore, 'node_modules\npackage.json\npackage-lock.json\nbun.lock\n.gitignore', {
        flag: 'wx',
      });
  }
  const active = sandboxProfile(
    toolsRead,
    toolsWrite,
    transport.port,
    ['.agents', '.opencode', 'opencode.json', 'opencode.jsonc'].map((name) => join(repo, name)),
  );
  let inventoryChecked = false;
  async function invoke(req) {
    if (req.stage === 'fix' && req.reviewIter > 1)
      throw new Error('One review/fix cycle exhausted');
    if (req.stage === 'apply' && !inventoryChecked) {
      checkInventory();
      inventoryChecked = true;
    }
    const label = invocationStem(req);
    const dir = join(out, 'native', label);
    mkdirSync(join(dir, 'calls'), { recursive: true });
    writeJson(join(dir, 'invocation.json'), req);
    const { result, calls } = await transport.stage(arm, label, dir, (token) =>
      command(
        host,
        req.args,
        { ...env, FRUGAL_RELAY_TOKEN: token },
        active,
        Math.min(remaining(30000), 420000),
      ),
    );
    writeFileSync(join(dir, 'native.jsonl'), result.stdout);
    writeFileSync(join(dir, 'native.stderr'), result.stderr);
    let events = [];
    let malformed = false;
    try {
      events = result.stdout
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    } catch {
      malformed = true;
    }
    const usage = account(events, calls);
    const row = {
      label,
      stage: req.stage,
      task: req.task,
      review_iter: req.reviewIter,
      code: result.code,
      signal: result.signal ?? null,
      sessions: [...new Set(events.map((e) => e.sessionID).filter(Boolean))],
      malformed,
      ...usage,
    };
    run.stages.push(row);
    writeJson(join(dir, 'result.json'), row);
    persist();
    return result;
  }
  const options = {
    repo,
    configDir: env.OPENCODE_CONFIG_DIR,
    assetsRoot: join(project, 'assets'),
    runDir: out,
    feature,
    requirement,
    model: 'pilot/' + model,
    invoke,
    snapshot,
  };
  if (arm === 'baseline') await executeBaseline(options);
  else
    await executeLiveOptimized({
      ...options,
      flags: run.flags,
      maxRetries: 0,
      async checkTask(id) {
        assert(Object.hasOwn(files, id), 'Unexpected task ID');
        const checks = await external('task-' + id);
        const suite = await publicTests([id], 'suite-' + id);
        const key = id === '1.1' ? 'task1' : 'task2';
        const passed = suite && groupOK(checks, 'api') && groupOK(checks, key);
        return {
          passed,
          summary: `Public ${id}: node:test ${suite ? 'passed' : 'failed'}, feature ${checks?.[key]?.passed ?? 0}/${checks?.[key]?.total ?? 'unknown'}, API ${checks?.api?.passed ?? 0}/${checks?.api?.total ?? 'unknown'}.`,
        };
      },
    });
  run.pipeline_complete = true;
} catch (error) {
  run.error = error.message;
} finally {
  const final = join(out, 'final');
  try {
    run.final_tree = snapshot(final);
    run.public_checks = await external('final', final);
    run.authored_tests_passed = await publicTests(['1.1', '1.2'], 'suite-final', final);
    if (run.pipeline_complete) {
      await checked(
        process.execPath,
        [openspec, 'validate', feature, '--strict'],
        sandboxProfile(
          [final, join(project, 'node_modules'), nodeHome, env.XDG_CONFIG_HOME],
          [],
          null,
        ),
        'openspec-validate',
        final,
      );
    }
    run.strict_validate = run.pipeline_complete;
  } catch (error) {
    run.final_check_error = error.message;
  }
  if (transport) await transport.close();
  run.elapsed_ms = Math.round(performance.now() - clock);
  run.reconciled =
    run.stages.length > 0 && run.stages.every((s) => !s.malformed && s.reconciliation);
  run.provider_rpt =
    run.stages.length && run.stages.every((s) => s.complete_provider_usage)
      ? run.stages.reduce((n, s) => n + s.provider_rpt, 0)
      : null;
  run.status =
    run.pipeline_complete &&
    run.strict_validate &&
    run.authored_tests_passed &&
    ['api', 'task1', 'task2'].every((k) => groupOK(run.public_checks, k)) &&
    run.reconciled &&
    !run.final_check_error
      ? 'complete'
      : 'failed';
  persist();
  console.log(
    JSON.stringify({
      arm,
      status: run.status,
      stages: run.stages.length,
      reason: run.error ?? run.final_check_error,
      out,
    }),
  );
  process.exitCode = run.status === 'complete' ? 0 : 1;
}
