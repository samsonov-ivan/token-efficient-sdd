// With locked dependencies installed: npm run build && node scripts/probe-live-opt.mjs
// Recheck the printed evidence directory offline with node scripts/replay.mjs DIRECTORY.
// The deterministic HTTP fixture checks native execution and accounting, not model quality or savings.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { stageReply } from '../packages/cli/dist/baseline.js';
import { git, readJson, writeJson } from '../packages/cli/dist/harness/io.js';
import { executeLiveOptimized } from '../packages/cli/dist/harness/live-opt.js';
import { invocationStem } from '../packages/cli/dist/harness/replay.js';
import {
  createSettings,
  platformBin,
  runnerEnvironment,
} from '../packages/cli/dist/harness/runner.js';
import { meterRun } from '../packages/cli/dist/meter.js';
import { yoctoFixture } from './fixtures/yocto-queue.mjs';
import { compareApplyContext, verifyApplyContext } from './fixtures/apply-context.mjs';

const [mode, destination] = process.argv.slice(2);
assert(
  process.argv.length === 2 ||
    (['--compare-apply-context', '--verify-apply-context', '--yocto-queue'].includes(mode) &&
      destination &&
      process.argv.length === 4),
  'Usage: node scripts/probe-live-opt.mjs [--compare-apply-context NEW_DIRECTORY | --verify-apply-context DIRECTORY | --yocto-queue NEW_DIRECTORY]',
);
if (mode === '--verify-apply-context') {
  console.log(
    'Verified apply request byte differences:',
    verifyApplyContext(resolve(destination)).continued_minus_fresh,
  );
  process.exit(0);
}

const project = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const tmp = realpathSync(tmpdir());
assert(relative(project, tmp) === '..' || relative(project, tmp).startsWith('..' + sep));
const root = mkdtempSync(join(tmp, 'frugal-native-opt-'));
const repo = join(root, 'repo');
const runDir = join(root, mode === '--yocto-queue' ? basename(resolve(destination)) : 'native-h01');
const raw = join(runDir, 'raw');
mkdirSync(repo);
mkdirSync(join(raw, 'stages'), { recursive: true });
const env = {
  ...runnerEnvironment(root),
  PATH: process.env.PATH,
  FRUGAL_RELAY_TOKEN: 'loopback-fixture',
  npm_config_offline: 'true',
  npm_config_registry: 'http://127.0.0.1:1/',
  HTTP_PROXY: 'http://127.0.0.1:1/',
  HTTPS_PROXY: 'http://127.0.0.1:1/',
  NO_PROXY: '127.0.0.1,localhost,::1',
};
const runFile = promisify(execFile);
const execute = (binary, args, runtimeEnv = env, cwd = repo) => {
  const run = runFile(binary, args, {
    cwd,
    env: runtimeEnv,
    timeout: 45000,
    killSignal: 'SIGKILL',
    maxBuffer: 16 * 1024 * 1024,
  });
  run.child.stdin.end();
  return run;
};
const reference = randomUUID();
const write = (path, content) => ({ name: 'write', args: { filePath: join(repo, path), content } });
const read = (path) => ({ name: 'read', args: { filePath: join(repo, path) } });
const portability =
  mode === '--yocto-queue'
    ? yoctoFixture({ project, repo, runDir, execute, env, reference, read, write })
    : undefined;
if (portability) assert(!existsSync(resolve(destination)), 'Choose a new evidence directory');
const feature = portability?.feature ?? 'issue-receipt';
const change = `openspec/changes/${feature}`;
const brief = portability?.brief ?? 'Issue a fresh public identifier and store a matching receipt.';
const model = 'frugal-fixture/smoke';
const firstNote =
  portability?.firstNote ??
  `Issued the public identifier.\nReference: ${reference}\nNext: store a matching receipt.`;
const remarks = 'BLOCKING: Document the receipt format.\nVERDICT: CHANGES REQUESTED';
const files = {
  [change + '/proposal.md']: '## Why\n\nA caller needs an identifier and confirmation.\n',
  [change + '/design.md']: '## Decisions\n\nUse one text file per artifact.\n',
  [change + '/specs/receipts/spec.md']:
    '## ADDED Requirements\n\n### Requirement: REQ-ID-01 Receipt\nThe application SHALL issue and confirm an identifier.\n\n#### Scenario: SCN-ID-01.1 Receipt\n- **WHEN** issued\n- **THEN** the receipt matches\n',
  [change + '/tasks.md']:
    '- [ ] 1.1 Issue a public identifier. REQ-ID-01 SCN-ID-01.1\n- [ ] 1.2 Write its receipt. REQ-ID-01 SCN-ID-01.1\n',
};
function actions(request) {
  if (portability) return portability.actions(request);
  switch (request.stage) {
    case 'spec':
      return [
        ...Object.entries(files).map(([path, content]) => write(path, content)),
        'Created the proposal, specification, design and tasks.',
      ];
    case 'apply':
      return request.task === '1.1'
        ? [write('public-id.txt', reference), firstNote]
        : [
            write('receipt.txt', reference),
            `Stored the receipt.\nPublic file: receipt.txt.\nTest: the identifiers match.`,
          ];
    case 'review':
      return request.reviewIter === 1
        ? [read('receipt.txt'), remarks]
        : [read('format.md'), 'Checked the documented receipt format.\nVERDICT: ACCEPT'];
    case 'fix':
      return [
        write('format.md', 'The receipt contains the issued identifier.'),
        'Documented the public format.',
      ];
    case 'verify':
      return [read('receipt.txt'), 'Checked the receipt and completed tasks.\nVERIFY: PASS'];
    default:
      throw new Error('Unexpected native stage');
  }
}
const requests = [];
let turn;
const server = createServer(async (req, res) => {
  try {
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/v1/chat/completions');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const payload = Buffer.concat(chunks);
    turn.capture?.(payload, turn.position);
    const body = JSON.parse(payload);
    assert.equal(body.model, 'smoke');
    assert.equal(body.stream, true);
    const { stage, task } = turn.request;
    if (turn.position === 0) {
      assert.equal(
        body.messages.some((m) => m.role === 'assistant'),
        turn.resumed === true,
        'Unexpected native assistant history',
      );
      const user = JSON.stringify(body.messages.filter((m) => m.role === 'user'));
      if (stage === 'spec') assert(user.includes(brief) && user.includes('openspec-propose'));
      if (stage === 'apply' && task === '1.1') assert(!user.includes(reference));
      if (stage === 'apply' && task === '1.2')
        assert(
          user.includes(JSON.stringify(firstNote).slice(1, -1)),
          'Accepted handoff missing from second task',
        );
      if (stage === 'fix') assert(user.includes('Document the receipt format.'));
      if (stage === 'verify') assert(user.includes('openspec-verify-change'));
    }
    const step = turn.actions[turn.position++];
    assert(step, 'Unexpected provider call');
    const tool = typeof step !== 'string';
    const id = turn.capture ? `fixture-${task}-${turn.position}` : `fixture-${requests.length + 1}`;
    if (tool)
      assert(
        body.tools?.some((t) => t.function?.name === step.name),
        `Missing tool ${step.name}`,
      );
    const delta = tool
      ? {
          tool_calls: [
            {
              index: 0,
              id: 'call_' + id,
              type: 'function',
              function: { name: step.name, arguments: JSON.stringify(step.args) },
            },
          ],
        }
      : { content: step };
    const usage = { prompt_tokens: 80, completion_tokens: 10, total_tokens: 90 };
    if (!turn.capture)
      requests.push({
        id,
        stage,
        task,
        review_iter: turn.request.reviewIter,
        tool: tool ? step.name : null,
        usage,
      });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const part of [
      { choices: [{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }], usage },
    ])
      res.write(
        'data: ' +
          JSON.stringify({
            id,
            model: 'smoke',
            object: 'chat.completion.chunk',
            created: 1,
            ...part,
          }) +
          '\n\n',
      );
    res.end('data: [DONE]\n\n');
  } catch (error) {
    res
      .writeHead(400, { 'content-type': 'application/json' })
      .end(JSON.stringify({ error: { message: String(error) } }));
  }
});
const opencode = platformBin(project, 'opencode');
console.log('Evidence: ' + runDir);
await new Promise((ok, fail) => server.once('error', fail).listen(0, '127.0.0.1', ok));
try {
  createSettings(
    env,
    model,
    `http://127.0.0.1:${server.address().port}/v1`,
    { context: 131072, output: 4096 },
    true,
  );
  const configFile = join(env.OPENCODE_CONFIG_DIR, 'opencode.json');
  writeJson(configFile, {
    ...readJson(configFile),
    permission: { '*': 'deny', edit: 'allow', read: 'allow' },
  });
  assert.equal((await execute(opencode, ['--version'])).stdout.trim(), '1.19.6');
  if (portability) await portability.setup();
  else git(repo, ['init', '-q']);
  await execute(platformBin(project, 'openspec'), [
    'init',
    '--tools',
    'opencode',
    '--scope',
    'project',
    '--no-animation',
  ]);
  writeFileSync(
    join(repo, 'frugal.yaml'),
    `version: 1\nflags: {session_per_task: true}\ntest: {command: ${portability ? 'npm test' : 'node --test'}, report: ${portability ? 'text' : 'tap'}}\n`,
  );
  if (!portability)
    writeFileSync(
      join(repo, 'public.test.mjs'),
      `import {readFileSync} from 'node:fs'; import assert from 'node:assert/strict'; import test from 'node:test';
const text=path=>readFileSync(path,'utf8').trim();
test('issue',()=>assert.match(text('public-id.txt'),/^[0-9a-f-]{36}$/));
test('receipt',()=>assert.equal(text('receipt.txt'),text('public-id.txt')));
`,
    );
  const snapshot = async () => {
    const index = { GIT_INDEX_FILE: join(root, 'tmp', 'probe.index') };
    git(repo, ['add', '-A'], index);
    return git(repo, ['write-tree'], index);
  };
  const stages = [];
  const output = await executeLiveOptimized({
    repo,
    runDir,
    feature,
    requirement: brief,
    model,
    assetsRoot: join(project, 'assets'),
    configDir: env.OPENCODE_CONFIG_DIR,
    flags: { session_per_task: true },
    maxRetries: 0,
    snapshot,
    async checkTask(taskId) {
      if (portability) return portability.gate(taskId);
      const name = { 1.1: 'issue', 1.2: 'receipt' }[taskId];
      assert(name, 'Expected a public fixture task');
      const test = await execute(process.execPath, [
        '--test',
        '--test-reporter=tap',
        `--test-name-pattern=^${name}$`,
        'public.test.mjs',
      ]);
      writeFileSync(join(runDir, `gate-${taskId}.tap`), test.stdout);
      assert.match(test.stdout, /tests 1\b/);
      return { passed: true, summary: 'The selected public test passed: ' + name };
    },
    async invoke(request) {
      turn = { request, position: 0, actions: actions(request) };
      const started_at = new Date().toISOString();
      const stem = invocationStem(request);
      let response;
      try {
        response = { ...(await execute(opencode, request.args)), code: 0 };
      } catch (error) {
        response = {
          stdout: error.stdout ?? '',
          stderr: error.stderr ?? '',
          code: Number(error.code) || 1,
        };
      }
      writeFileSync(join(raw, 'stages', stem + '.stdout'), response.stdout);
      writeFileSync(join(raw, 'stages', stem + '.stderr'), response.stderr);
      appendFileSync(join(raw, 'events.jsonl'), response.stdout);
      const reply = stageReply(response);
      assert.equal(turn.position, turn.actions.length);
      if (portability) {
        const events = response.stdout
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line));
        const toolEvents = events.filter((event) => event.type === 'tool_use');
        assert.deepEqual(
          toolEvents.map((event) => event.part.tool),
          turn.actions.filter((step) => typeof step !== 'string').map((step) => step.name),
        );
        assert(
          toolEvents.every(
            (event) => event.sessionID === reply.session && event.part.state.status === 'completed',
          ),
        );
      }
      stages.push({
        stage: request.stage,
        task: request.task,
        review_iter: request.reviewIter,
        session_id: reply.session,
        started_at,
        finished_at: new Date().toISOString(),
      });
      return response;
    },
  });
  assert.deepEqual(
    stages.map((s) => s.stage),
    portability
      ? ['spec', 'apply', 'apply', 'review', 'verify']
      : ['spec', 'apply', 'apply', 'review', 'fix', 'review', 'verify'],
  );
  assert.equal(new Set(stages.map((s) => s.session_id)).size, stages.length);
  if (!portability) assert.equal(readFileSync(join(repo, 'receipt.txt'), 'utf8'), reference);
  const tree = await snapshot();
  assert.deepEqual(
    output.reviews.map((r) => r.verdict),
    portability ? ['pass'] : ['fix', 'pass'],
  );
  assert.equal(output.reviews.at(-1).tree, tree);
  assert.equal(output.stages.at(-1).output.tree, tree);
  assert.deepEqual(readJson(join(runDir, 'opt/quality-review.json')), output.reviews);
  const portabilityResult = portability
    ? await portability.finish(platformBin(project, 'openspec'), tree)
    : undefined;
  assert.equal(await snapshot(), tree);
  for (const { session_id } of stages) {
    const exported = JSON.parse((await execute(opencode, ['export', session_id])).stdout);
    assert.equal(exported.info.id, session_id);
    writeJson(join(raw, 'exports', session_id + '.json'), exported);
  }
  writeJson(join(runDir, 'manifest.json'), {
    kind: 'meter-smoke',
    run_id: basename(runDir),
    branch: 'opt',
    model,
    provider: 'frugal-fixture',
    dry_run: true,
    status: 'complete',
    stages,
  });
  const meter = await meterRun(runDir);
  assert.deepEqual(meter.issues, []);
  assert.equal(meter.call_count, requests.length);
  assert.equal(
    meter.known_rpt,
    requests.reduce((sum, request) => sum + request.usage.total_tokens, 0),
  );
  const apply = stages.filter((s) => s.stage === 'apply').map((s) => s.session_id);
  writeJson(join(runDir, 'probe.json'), {
    host: '1.19.6',
    model,
    fixture: true,
    ...(portabilityResult && {
      scope:
        'Public native H-01 portability with a loopback fixture; external model QA and token savings unmeasured.',
      ...portabilityResult,
      stages,
    }),
    tree,
    apply,
    review_rounds: output.reviews.length,
    verify: true,
    provider_requests: requests.length,
  });
  console.log(
    `PASS: ${stages.length} native invocations; two apply sessions, full review and verification on tree ${tree}; ${requests.length} loopback calls reconciled.`,
  );
  if (portability) {
    writeJson(join(runDir, 'fixture-requests.json'), requests);
    cpSync(runDir, resolve(destination), { recursive: true, force: false, errorOnExist: true });
    console.log('Portability evidence:', resolve(destination));
  }
  if (mode === '--compare-apply-context') {
    const context = await compareApplyContext({
      directory: resolve(destination),
      root,
      repo,
      runDir,
      seedEnv: env,
      stages: output.stages,
      opencode,
      execute,
      change,
      prepare(request, resumed, capture) {
        turn = { request, resumed, capture, position: 0, actions: actions(request) };
      },
    });
    console.log('Apply request bytes (continued minus fresh):', context.continued_minus_fresh);
    console.log('Paired raw HTTP evidence:', resolve(destination));
  }
} finally {
  writeJson(join(runDir, 'fixture-requests.json'), requests);
  server.close();
}
