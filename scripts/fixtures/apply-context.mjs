import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { stageReply } from '../../packages/cli/dist/baseline.js';
import { digest, git, writeJson } from '../../packages/cli/dist/harness/io.js';
import { runnerEnvironment, safeFile } from '../../packages/cli/dist/harness/runner.js';

const bytes = (value) => Buffer.byteLength(JSON.stringify(value));
function summarize(records) {
  return Object.fromEntries(
    ['requests', 'body_bytes', 'messages_bytes', 'tools_bytes', 'other_body_bytes'].map((key) => [
      key,
      key === 'requests' ? records.length : records.reduce((sum, r) => sum + r[key], 0),
    ]),
  );
}

function wireMetrics(raw) {
  const body = JSON.parse(raw);
  // When the SDK uses compact UTF-8 JSON, serializing each field gives its
  // exact wire length, including quotes, escapes and array separators.
  assert(Buffer.from(JSON.stringify(body)).equals(raw), 'Unexpected request serialization');
  assert(Array.isArray(body.messages) && Array.isArray(body.tools));
  const messages_bytes = bytes(body.messages);
  const tools_bytes = bytes(body.tools);
  return {
    sha256: digest(raw),
    body_bytes: raw.length,
    messages_bytes,
    tools_bytes,
    other_body_bytes: raw.length - messages_bytes - tools_bytes,
    roles: body.messages.map((m) => m.role),
    tools_sha256: digest(JSON.stringify(body.tools)),
  };
}

// Replay the two native task turns at the identical original absolute paths.
// The only change to opencode argv is --session on the second continued task.
export async function compareApplyContext({
  directory,
  root,
  repo,
  runDir,
  seedEnv,
  stages,
  opencode,
  execute,
  prepare,
  change,
}) {
  const tasks = stages.filter((s) => s.stage === 'apply');
  assert.deepEqual(
    tasks.map((s) => s.task),
    ['1.1', '1.2'],
  );
  const transitions = git(repo, [
    'diff',
    '--name-only',
    tasks[0].output.tree,
    tasks[1].input.tree,
  ]).split('\n');
  assert.deepEqual(transitions, [`${change}/handoff.md`, `${change}/tasks.md`]);
  mkdirSync(directory, { mode: 0o700 });
  const seed = join(root, 'context-seed-repo');
  renameSync(repo, seed);
  const records = [];
  const arms = {};
  const outputFiles = [];
  try {
    for (const arm of ['fresh', 'continued']) {
      const target = join(directory, arm);
      mkdirSync(target);
      mkdirSync(repo);
      cpSync(join(seed, '.git'), join(repo, '.git'), { recursive: true });
      const runtime = join(root, 'context-runtime');
      const env = { ...seedEnv, ...runnerEnvironment(runtime) };
      cpSync(seedEnv.OPENCODE_CONFIG_DIR, env.OPENCODE_CONFIG_DIR, { recursive: true });
      const turns = [];
      const trees = [];
      for (const task of tasks) {
        // Between the real task writes only the seed controller's verified
        // checkmark and accepted handoff are restored from its captured tree.
        git(repo, ['read-tree', '--reset', '-u', task.input.tree]);
        const prompt = readFileSync(join(runDir, task.prompt), 'utf8');
        const expected = readFileSync(join(runDir, task.transcript), 'utf8').trimEnd();
        const args = [
          'run',
          '--format',
          'json',
          '--model',
          'frugal-fixture/smoke',
          '--agent',
          'build',
          '--title',
          `Context task ${task.task}`,
        ];
        const resumed = arm === 'continued' && turns.length > 0;
        if (resumed) args.push('--session', turns[0].session);
        args.push('--', prompt);
        const capture = (raw, index) => {
          const file = join(target, `apply-${task.task}-${index + 1}.json`);
          writeFileSync(file, raw, { flag: 'wx', mode: 0o600 });
          records.push({
            arm,
            task: task.task,
            step: index + 1,
            path: relative(directory, file),
            ...wireMetrics(raw),
          });
        };
        prepare({ stage: 'apply', task: task.task }, resumed, capture);
        const cmd = await execute(opencode, args, env);
        const reply = stageReply({ ...cmd, code: 0 });
        assert.equal(reply.answer, expected);
        if (turns.length) assert.equal(reply.session === turns[0].session, resumed);
        const file = join(target, `apply-${task.task}.jsonl`);
        writeFileSync(file, cmd.stdout);
        outputFiles.push(file);
        const events = cmd.stdout
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        const tools = events
          .filter((e) => e.type === 'tool_use')
          .map((e) => [e.part.tool, e.part.state.status]);
        assert.deepEqual(tools, [['write', 'completed']]);
        const test = task.task === '1.1' ? 'issue' : 'receipt';
        const gate = await execute(
          process.execPath,
          ['--test', '--test-reporter=tap', `--test-name-pattern=^${test}$`, 'public.test.mjs'],
          env,
        );
        assert.match(gate.stdout, /tests 1\b/);
        writeFileSync(join(target, `gate-${task.task}.tap`), gate.stdout);
        git(repo, ['add', '-A']);
        const tree = git(repo, ['write-tree']);
        assert.equal(tree, task.output.tree, 'The native implementation changed between arms');
        trees.push(tree);
        turns.push({
          session: reply.session,
          answer_sha256: digest(reply.answer),
          prompt_sha256: digest(prompt),
        });
      }
      const rows = records.filter((r) => r.arm === arm);
      const by_task = Object.fromEntries(
        tasks.map((t) => [t.task, summarize(rows.filter((r) => r.task === t.task))]),
      );
      assert.equal(by_task['1.1'].requests, 2);
      assert.equal(by_task['1.2'].requests, 2);
      arms[arm] = { by_task, apply_total: summarize(rows), turns, post_apply_trees: trees };
      renameSync(repo, join(root, `context-${arm}-repo`));
      renameSync(runtime, join(root, `context-${arm}-runtime`));
    }
  } finally {
    // Never overwrite a failed arm's working copy.
    try {
      renameSync(repo, join(root, 'context-failed-repo'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    renameSync(seed, repo);
  }
  const total = arms.continued.apply_total;
  const delta_bytes = Object.fromEntries(
    Object.keys(total)
      .filter((k) => k.endsWith('_bytes'))
      .map((k) => [k, total[k] - arms.fresh.apply_total[k]]),
  );
  const report = {
    version: 1,
    host: 'opencode-ai@1.19.6',
    node: process.version,
    transport: 'loopback chat/completions',
    capture_directory: basename(directory),
    scripts_sha256: {
      'probe-live-opt.mjs': digest(readFileSync(new URL('../probe-live-opt.mjs', import.meta.url))),
      'fixtures/apply-context.mjs': digest(readFileSync(new URL(import.meta.url))),
    },
    unit: 'serialized UTF-8 bytes; HTTP headers and responses excluded',
    control:
      'Identical task prompts including accepted handoff, tool calls, assistant replies, tests, paths and resulting trees. Only task 1.2 uses --session in continued.',
    arms,
    continued_minus_fresh: delta_bytes,
    requests: records,
    transcripts: outputFiles.map((f) => ({
      path: relative(directory, f),
      sha256: digest(readFileSync(f)),
    })),
  };
  writeJson(join(directory, 'context.json'), report);
  return verifyApplyContext(directory);
}

// Offline re-import of the captured public HTTP entity bodies and CLI evidence.
export function verifyApplyContext(directory) {
  directory = realpathSync(directory);
  const load = (name) => safeFile(directory, join(directory, name));
  const report = JSON.parse(load('context.json'));
  const { requests: records, arms } = report;
  assert.equal(report.version, 1);
  assert.deepEqual(Object.keys(arms), ['fresh', 'continued']);
  assert.equal(records.length, 8);
  const filenames = [];
  for (const [arm, summary] of Object.entries(arms)) {
    const rows = records.filter((r) => r.arm === arm);
    for (const row of rows) {
      const { path, arm: _arm, task, step, ...saved } = row;
      assert(['1.1', '1.2'].includes(task) && [1, 2].includes(step));
      assert.equal(path, `${arm}/apply-${task}-${step}.json`);
      assert.deepEqual(wireMetrics(load(path)), saved);
    }
    for (const task of ['1.1', '1.2']) {
      const selected = rows.filter((r) => r.task === task);
      assert.deepEqual(
        selected.map((r) => r.step),
        [1, 2],
      );
      assert.deepEqual(summarize(selected), summary.by_task[task]);
      const gate = load(`${arm}/gate-${task}.tap`).toString();
      assert.match(gate, /^(?:#|ℹ) pass 1$/m);
      assert.match(gate, /^(?:#|ℹ) fail 0$/m);
      const path = `${arm}/apply-${task}.jsonl`;
      filenames.push(path);
      const observed = stageReply({ code: 0, stdout: load(path).toString(), stderr: '' });
      const turn = summary.turns[task === '1.1' ? 0 : 1];
      assert.equal(observed.session, turn.session);
      assert.equal(digest(observed.answer), turn.answer_sha256);
    }
    assert.deepEqual(summarize(rows), summary.apply_total);
  }
  assert.deepEqual(arms.fresh.post_apply_trees, arms.continued.post_apply_trees);
  assert.deepEqual(
    report.transcripts.map((ref) => ref.path),
    filenames,
  );
  for (const ref of report.transcripts) assert.equal(digest(load(ref.path)), ref.sha256);
  assert.equal(arms.continued.turns[0].session, arms.continued.turns[1].session);
  assert.notEqual(arms.fresh.turns[0].session, arms.fresh.turns[1].session);
  for (const key of ['answer_sha256', 'prompt_sha256'])
    assert.deepEqual(
      arms.fresh.turns.map((t) => t[key]),
      arms.continued.turns.map((t) => t[key]),
    );
  for (const [k, v] of Object.entries(report.continued_minus_fresh))
    assert.equal(v, arms.continued.apply_total[k] - arms.fresh.apply_total[k]);
  const readBody = (r) => JSON.parse(load(r.path));
  for (const task of ['1.1', '1.2']) {
    for (const step of [1, 2]) {
      const [a, b] = records.filter((r) => r.task === task && r.step === step).map(readBody);
      const { messages: fresh, ...aSettings } = a;
      const { messages: continued, ...bSettings } = b;
      assert.deepEqual(aSettings, bSettings, 'Tools/model/request settings differ');
      const lastUser = (m) => m.findLastIndex((row) => row.role === 'user');
      assert.deepEqual(
        fresh.slice(lastUser(fresh)),
        continued.slice(lastUser(continued)),
        'Current turn changed',
      );
      if (task === '1.1') assert.deepEqual(fresh, continued, 'Task 1 input must be identical');
      else {
        assert.deepEqual(
          continued.slice(1, lastUser(continued)).map((m) => m.role),
          ['user', 'assistant', 'tool', 'assistant'],
        );
        assert.deepEqual(
          fresh.filter((m) => m.role === 'system'),
          continued.filter((m) => m.role === 'system'),
        );
        assert(
          continued.some(
            (m) =>
              m.role === 'assistant' &&
              JSON.stringify(m.content).includes('Issued the public identifier.'),
          ),
        );
      }
    }
  }
  return report;
}
