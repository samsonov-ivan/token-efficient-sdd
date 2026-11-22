#!/usr/bin/env node
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { goCatalog, goURL, validSubscriptionLedger } from '../packages/cli/dist/harness/go.js';
import { checked, command, digest, now, readJson, writeJson } from '../packages/cli/dist/harness/io.js';
import { startUsageRelay } from '../packages/cli/dist/harness/relay.js';
import {
  Container,
  createSettings,
  runnerEnvironment,
  safeFile,
  withGoVariant,
} from '../packages/cli/dist/harness/runner.js';
import { meterRun } from '../packages/cli/dist/meter.js';
import { fields } from '../packages/cli/dist/meter/usage.js';
import {
  archivePath,
  createHistory,
  fixtureCommand,
  fixtureDates,
  fixtureName,
  newestSubject,
  targetSubject,
} from './lib/h03-fixture.mjs';

const [mode, output, tag, ...scenarioArgs] = process.argv.slice(2);
const latest = scenarioArgs.at(-1) === '--latest';
const [rehearsal, ...extra] = latest ? scenarioArgs.slice(0, -1) : scenarioArgs;
const dry = mode === '--dry-run';
assert(
  output && tag && extra.length === 0 &&
    ((dry && !rehearsal) || (mode === '--live-extra-usage-off' && rehearsal)),
  'Usage: node scripts/probe-compression-go.mjs --dry-run OUTPUT_DIR IMAGE [--latest]\n' +
    'Live ($0 balance only): node scripts/probe-compression-go.mjs ' +
    '--live-extra-usage-off OUTPUT_DIR IMAGE DRY_RUN_DIR [--latest]',
);
const project = dirname(dirname(fileURLToPath(import.meta.url)));
const plugin = join(project, 'packages/opencode-plugin/dist/index.js');
const dest = resolve(output);
const version = '1.19.6';
const provider = 'opencode-go';
const modelId = 'deepseek-v4.1-flash';
const model = `${provider}/${modelId}`;
const variant = 'max';
const scenario = latest ? 'newest-visible' : 'archive-recovery';
const subject = latest ? newestSubject : targetSubject;
const prompt = latest ? [
  `Run \`${fixtureCommand}\` exactly once in the current repository.`,
  'From the tool result, find the newest commit, which is on the first line of the history.',
  'Do not use any other tools. In your final answer output just its seven-character commit hash.',
].join(' ') : [
  `Run \`${fixtureCommand}\` exactly once in the current repository.`,
  `Find the commit whose exact subject is "${targetSubject}".`,
  'If the result lists a full-output archive and the commit is omitted, use the read tool once',
  'on the indicated archive to find it. Do not run another shell command.',
  'In your final answer output just the seven-character commit hash.',
].join(' ');
const image = await Container.imageID(tag);
const inputs = {
  fixture: fixtureName,
  scenario,
  prompt_sha256: digest(prompt),
  runner_sha256: digest(await readFile(fileURLToPath(import.meta.url))),
  fixture_code_sha256: digest(await readFile(join(project, 'scripts/lib/h03-fixture.mjs'))),
  plugin_sha256: digest(await readFile(plugin)),
  opencode: version,
  image,
  model,
  variant,
};
const tmp = await realpath(process.platform === 'darwin' ? '/tmp' : tmpdir());
const fromProject = relative(await realpath(project), tmp);
assert(fromProject === '..' || fromProject.startsWith(`..${sep}`), 'TMPDIR must be outside the project');
if (!dry) {
  const receipt = readJson(join(resolve(rehearsal), 'summary.json'));
  assert.equal(receipt.mode, 'synthetic-rehearsal');
  assert.equal(receipt.complete, true);
  assert.deepEqual(receipt.inputs, inputs, 'Repeat the offline rehearsal with these exact inputs');
}
await mkdir(dest, { mode: 0o700 });
const catalog = dry ? { limits: { context: 131072, output: 8192 } } : await goCatalog(model);
const root = await mkdtemp(join(tmp, 'f-h03-'));
// Recreate the complete mount between arms while keeping model-visible paths identical.
const arm = join(root, 'arm');

async function removeMount(path) {
  // Docker Desktop can briefly retain a directory after the container exits.
  for (let remaining = 10; ; remaining--) {
    try {
      await rm(path, { recursive: true, force: true, maxRetries: 3 });
      return;
    } catch (error) {
      if (remaining === 0 || error.code !== 'EACCES') throw error;
      await pause(250);
    }
  }
}

function callTool(name, args, step) {
  return {
    role: 'assistant',
    tool_calls: [
      {
        index: 0,
        id: `h03-tool-${step}`,
        type: 'function',
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  };
}

// Rehearse the production relay and meter with a synthetic provider response.
async function fixtureProvider(repo, original, expectedCommit) {
  let step = 0;
  const errors = [];
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.method, 'POST');
      assert.equal(req.url, '/v1/chat/completions');
      const chunks = [];
      for await (const part of req) chunks.push(part);
      const body = JSON.parse(Buffer.concat(chunks));
      assert.equal(body.model, modelId);
      assert.equal(body.reasoning_effort, variant);
      assert.equal(body.stream_options?.include_usage, true);
      const results = body.messages.filter((message) => message.role === 'tool');
      const tools = body.tools?.map((tool) => tool.function.name);
      step++;
      let tool;
      if (step === 1) {
        assert(tools.includes('bash'));
        assert.equal(results.length, 0);
        tool = callTool('bash', { command: fixtureCommand, description: 'Read fixture history' }, step);
      } else if (step === 2) {
        assert.equal(results.length, 1);
        const result = results[0].content;
        assert.equal(typeof result, 'string');
        const archive = archivePath.exec(result);
        if (archive) {
          assert.equal(archive[2], digest(original));
          if (latest) assert(result.includes(expectedCommit));
          else {
            assert(tools.includes('read'));
            assert(!result.includes(expectedCommit));
            tool = callTool('read', { filePath: join(repo, archive[1]) }, step);
          }
        } else assert.equal(result, original);
      } else {
        assert(!latest);
        assert.equal(step, 3);
        assert.equal(results.length, 2);
        assert(results[1].content.includes(`${expectedCommit} ${subject}`));
      }
      const payload = {
        id: `fixture-${step}`,
        object: 'chat.completion.chunk',
        created: 1,
        model: modelId,
      };
      const usage = {
        prompt_tokens: 950,
        prompt_tokens_details: { cached_tokens: 576 },
        completion_tokens: 92,
        completion_tokens_details: { reasoning_tokens: 42 },
        total_tokens: 1042,
        cost: 0,
        opencode: {
          billing_source: 'go',
          allowance: 0.001,
          tokens: {
            input: 350,
            output: 92,
            reasoning: 42,
            cache_read: 576,
            cache_write_5m: 24,
            cache_write_1h: 0,
          },
        },
      };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const chunk of [
        { choices: [{ index: 0, delta: tool ?? { role: 'assistant', content: expectedCommit }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }] },
        { choices: [], usage },
      ]) {
        res.write(`data: ${JSON.stringify({ ...payload, ...chunk })}\n\n`);
      }
      res.end('data: [DONE]\n\n');
    } catch (error) {
      errors.push(error.message);
      res.writeHead(400).end();
    }
  });
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  return { server, errors };
}

async function checkArchive(events, repo, raw, original, compressed, expectedCommit) {
  assert(!events.some((event) => event.type === 'error'), 'OpenCode reported an error');
  const tools = events.filter((event) => event.type === 'tool_use').map((event) => event.part);
  const recovered = compressed && !latest;
  assert.deepEqual(tools.map((tool) => tool.tool), recovered ? ['bash', 'read'] : ['bash']);
  const [shell, read] = tools.map((tool) => tool.state);
  assert.equal(shell.input.command, fixtureCommand);
  assert.equal(shell.status, 'completed');
  assert.equal(shell.metadata?.exit, 0);
  const actualCommit = events.filter((event) => event.type === 'text')
    .map((event) => event.part.text).join('').trim();
  assert.equal(actualCommit, expectedCommit);
  const source_sha256 = digest(original);
  const shell_output_bytes = Buffer.byteLength(shell.output);
  if (!compressed) {
    assert.equal(shell.output, original);
    assert.equal(shell.metadata?.frugalToolOutputSha256, undefined);
    return { source_sha256, shell_output_bytes, commit: actualCommit };
  }
  const archive = archivePath.exec(shell.output);
  assert.equal(archive?.[2], source_sha256, 'Archive path must encode the source hash');
  assert.equal(shell.metadata?.frugalToolOutputSha256, source_sha256);
  assert(shell_output_bytes < Buffer.byteLength(original));
  assert.equal(shell.output.includes(expectedCommit), latest);
  const file = join(repo, archive[1]);
  const stored = safeFile(repo, file);
  assert.deepEqual(stored, Buffer.from(original));
  if (recovered) {
    assert.equal(read.status, 'completed');
    assert.equal(resolve(repo, read.input.filePath), file);
    assert(read.output.includes(`${expectedCommit} ${subject}`));
  }
  const archive_file = join('raw', 'full-git-log.txt');
  await writeFile(join(dirname(raw), archive_file), stored, { flag: 'wx', mode: 0o600 });
  return {
    source_sha256,
    shell_output_bytes,
    commit: actualCommit,
    archive_sha256: digest(stored),
    archive: archive_file,
    archive_recovered_in_session: recovered,
  };
}

async function probe(branch) {
  const compressed = branch === 'opt';
  const repo = join(arm, 'repo');
  const runDir = join(dest, branch);
  const raw = join(runDir, 'raw');
  const series = basename(dest);
  const runId = basename(runDir);
  const started = now();
  const env = runnerEnvironment(arm);
  env.FRUGAL_USAGE_CORRELATION = '1';
  env.npm_config_offline = 'true';
  env.npm_config_fetch_retries = '0';
  env.FRUGAL_TOOL_OUTPUT_COMPRESSION = compressed ? '1' : '0';
  const context = new Container(arm, repo, env, image, `${series}-${runId}`);
  await mkdir(repo);
  await mkdir(raw, { recursive: true, mode: 0o700 });
  try {
    await createHistory((...args) => checked(command('git', args, {
      cwd: repo,
      env: { ...env, ...fixtureDates, PATH: process.env.PATH },
    })));
    await context.verifyIsolation(project, dest);
    assert.equal(await checked(context.exec(['opencode', '--version'])), version);
    const runnerNode = await checked(context.exec(['node', '--version']));
    const original = (await context.exec(['git', 'log', '--oneline'])).stdout;
    const target = original.split('\n').find((line) => line.endsWith(` ${subject}`));
    if (latest) assert.equal(target, original.split('\n', 1)[0]);
    const expectedCommit = target?.split(' ')[0];
    assert.match(expectedCommit ?? '', /^[a-f0-9]{7}$/);
    await writeFile(join(raw, 'fixture-git-log.txt'), original, { mode: 0o600 });
    const plugins = join(env.OPENCODE_CONFIG_DIR, 'plugins');
    await mkdir(plugins);
    await cp(plugin, join(plugins, 'frugal.js'));
    await writeFile(join(repo, 'frugal.yaml'), 'version: 1\nflags: {tool_output_compression: true}\n');
    writeJson(join(repo, 'opencode.json'), {
      agent: { build: { steps: 4 } },
      permission: {
        '*': 'deny',
        bash: { '*': 'deny', [fixtureCommand]: 'allow' },
        read: { '*': 'deny', '.frugal/logs/*': 'allow', '**/.frugal/logs/*': 'allow' },
      },
    });
    const fixture = dry ? await fixtureProvider(repo, original, expectedCommit) : undefined;
    let relay;
    let result;
    try {
      relay = await startUsageRelay({
        runDir, model, variant,
        ...(fixture ? {
          fixture: true, upstream: `http://127.0.0.1:${fixture.server.address().port}/v1`,
        } : { apiKey: process.env.OPENCODE_API_KEY ?? '' }),
      });
      createSettings(env, model, `http://host.docker.internal:${relay.port}/v1`, catalog.limits, true);
      result = await context.exec([
        'timeout', '--kill-after=5s', '90s', 'opencode',
        ...withGoVariant([
          'run', '--format', 'json', '--model', model, '--title', 'Frugal H03 fixture', '--', prompt,
        ], variant),
      ], { network: true, secretEnv: { FRUGAL_RELAY_TOKEN: relay.token } });
    } finally {
      try {
        if (relay) await relay.close();
      } finally {
        fixture?.server.close();
      }
    }
    await writeFile(join(raw, 'events.jsonl'), result.stdout, { mode: 0o600 });
    await writeFile(join(raw, 'stderr.txt'), result.stderr, { mode: 0o600 });
    const db = join(env.XDG_DATA_HOME, 'opencode/opencode.db');
    const backup = join(env.TMPDIR, 'usage.db');
    await checked(context.exec(['sqlite3', db, `.backup '${backup}'`]));
    await writeFile(join(raw, 'opencode.db'), safeFile(arm, backup), { mode: 0o600 });
    const events = result.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const sessions = [...new Set(events.map((event) => event.sessionID).filter(Boolean))];
    const manifest = {
      schema: 'frugal.meter-smoke.v1',
      kind: 'meter-smoke',
      purpose: 'h03-compression-technical-probe',
      run_id: runId,
      series,
      pair_id: null,
      branch,
      dry_run: dry,
      status: 'unverified',
      model,
      provider,
      endpoint: dry ? 'synthetic-loopback' : goURL,
      params: { variant, reasoning_effort: variant },
      flags: { tool_output_compression: compressed },
      metering: {
        title_disabled: true,
        relay_required: true,
        allowed_billing_sources: ['go', 'go-plus'],
        max_balance_charge: 0,
      },
      versions: { node: runnerNode, coordinator_node: process.version, opencode: version },
      inputs,
      stages: sessions.map((session_id) => ({ stage: 'other', session_id })),
      started_at: started,
      finished_at: now(),
    };
    writeJson(join(runDir, 'manifest.json'), manifest);
    const meter = await meterRun(runDir);
    assert.equal(result.code, 0, `OpenCode did not finish. See ${join(raw, 'stderr.txt')}`);
    assert.deepEqual(fixture?.errors ?? [], []);
    assert.equal(sessions.length, 1);
    assert(validSubscriptionLedger(join(raw, 'relay.jsonl'), variant));
    assert(meter.complete, meter.issues.join('\n'));
    assert.equal(meter.cost, 0);
    assert.equal(meter.relay.relative_discrepancy, 0);
    assert.equal(meter.call_count, compressed && !latest ? 3 : 2);
    const archive = await checkArchive(events, repo, raw, original, compressed, expectedCommit);
    manifest.status = 'complete';
    writeJson(join(runDir, 'manifest.json'), manifest);
    return {
      ...archive,
      meter: join(branch, 'meter.json'),
      usage: {
        call_count: meter.call_count,
        rpt: meter.rpt,
        ...Object.fromEntries(fields.map((field) => [field, meter[field]])),
        balance_charge: meter.cost,
        subscription_allowance: meter.opencode_billing?.allowance ?? null,
      },
    };
  } finally {
    await removeMount(arm);
  }
}

try {
  const baseline = await probe('base');
  const compressed = await probe('opt');
  assert.equal(baseline.source_sha256, compressed.source_sha256);
  assert.equal(baseline.commit, compressed.commit);
  writeJson(join(dest, 'summary.json'), {
    kind: 'h03-compression-technical-probe',
    mode: dry ? 'synthetic-rehearsal' : 'live-go',
    scored_feature_pair: false,
    complete: true,
    max_balance_charge: 0,
    inputs,
    baseline,
    compressed,
  });
  console.log(join(dest, 'summary.json'));
} finally {
  await removeMount(root);
}
