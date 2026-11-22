import { randomBytes, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { parse } from 'yaml';
import { executeBaseline, hashBaselineAssets } from './baseline.js';
import { meterRun } from './meter.js';
import { analysisPython } from './report.js';
import { parseArgs } from 'node:util';
import { gates } from './gates.js';
import { goCatalog, smokeReceipt, validSubscriptionLedger, verifySmoke } from './harness/go.js';
import { startUsageRelay } from './harness/relay.js';
import { captureToolOutput, collectToolOutputs } from './harness/tool-output.js';
import { evaluate, restoreFinal } from './harness/evaluate.js';
import {
  activeOwner,
  checked,
  command,
  digest,
  git,
  hashTree,
  now,
  readJson,
  writeJson,
} from './harness/io.js';
import { executeOptimizedReplay, usesOptimizedReplay } from './harness/optimized-replay.js';
import { executeLiveOptimized, validateLiveOptFlags } from './harness/live-opt.js';
import { createTaskGate, publicTaskConfig } from './harness/task-gate.js';
import { TOOL_OUTPUT_COMPRESSION, flagsFor, parsePlan, workflowMode } from './harness/plan.js';
import type { Flag, Plan, Slot } from './harness/plan.js';
import {
  invocationStem,
  type Invocation,
  replay,
  type ReplayResult,
  type Stage,
} from './harness/replay.js';
import {
  Container,
  createSettings,
  credentialKeys,
  platformBin,
  runnerEnvironment,
  safeFile,
  withGoVariant,
} from './harness/runner.js';

type StageRecord = {
  stage: Stage;
  session_id: string;
  message_ids?: string[];
  review_iter?: number;
  task?: string;
  started_at: string;
  finished_at: string | null;
};
type Status = 'running' | 'complete' | 'failed' | 'interrupted';
type Version = {
  opencode: string;
  openspec: string;
  frugal: string;
  node: string;
  python: string;
  test_runner: string;
};
const gitAuthor = {
  GIT_AUTHOR_NAME: 'Frugal Runner',
  GIT_AUTHOR_EMAIL: 'runner@localhost',
  GIT_COMMITTER_NAME: 'Frugal Runner',
  GIT_COMMITTER_EMAIL: 'runner@localhost',
};
const unknownVersions = (sha: string): Version => ({
  frugal: sha,
  opencode: 'unobserved',
  openspec: 'unobserved',
  node: process.version,
  python: 'unobserved',
  test_runner: 'unobserved',
});
function childOf(parent: string, child: string) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith(sep));
}
function createArmRoot(temp: string) {
  for (;;) {
    const root = join(temp, `frugal-arm-${randomBytes(5).toString('hex')}`);
    try {
      mkdirSync(root, { mode: 0o700 });
      return root;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
}
function atomicNew(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true });
  try {
    writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}
function initial(
  plan: Plan,
  slot: Slot,
  runId: string,
  baselineHash: string,
  image: string | null,
  prior: string | null,
  config: { profile?: string; flags?: Record<string, Flag> },
  configHash: string,
) {
  const provider = plan.model.split('/')[0];
  const params = {
    temperature: 'provider-default',
    variant: plan.variant,
    reasoning_effort: plan.variant ? null : 'provider-default',
    review_max: 5,
    endpoint: plan.endpoint,
    limits: plan.limits,
    stage_timeout_seconds: plan.timeout,
  };
  return {
    run_id: runId,
    pair_id: slot.pair,
    series_id: plan.id,
    experiment: plan.experiment,
    purpose: plan.h03Pilot
      ? 'h03-pilot'
      : plan.goSmoke
        ? 'go-smoke'
        : plan.dry
          ? 'replay'
          : 'feature',
    feature_id: plan.feature,
    change_id: plan.feature,
    dry_run: plan.dry,
    branch: slot.branch,
    mode: slot.mode,
    status: 'running' as Status,
    profile: String(config.profile ?? 'auto'),
    flags: flagsFor(slot.mode, config.flags ?? {}, plan.flags) as Record<string, Flag>,
    model: plan.model,
    provider,
    provider_id: provider,
    model_id: plan.model.slice(provider.length + 1),
    requested_model: plan.requested,
    params,
    versions: unknownVersions(plan.sha),
    repo: { url: `bench/repos/${plan.repo}.bundle`, commit: plan.pin },
    config_hash: configHash,
    baseline_hash: baselineHash,
    expected_hash: plan.expectedHash,
    requirements_hash: plan.requirementsHash,
    test_oracle_hash: plan.oracleHash,
    started_at: now(),
    finished_at: null as string | null,
    final_commit: null as string | null,
    stages: [] as StageRecord[],
    prices: null as Record<string, unknown> | null,
    gates: null as Record<string, unknown> | null,
    hidden: null as Record<string, unknown> | null,
    notes: [] as string[],
    prior_run_id: prior,
    isolation: { engine: image ? 'docker' : 'offline-replay', image, root: null as string | null },
    metering: {
      title_disabled: true,
      relay_required: plan.goRelay,
      allowed_billing_sources: plan.goRelay ? ['go', 'go-plus'] : undefined,
      max_balance_charge: plan.goRelay ? 0 : undefined,
      plugin_sha256: null as string | null,
    },
    accepted: false,
    pipeline_complete: false,
    assessment_sha256: null as string | null,
  };
}
export type RunManifest = ReturnType<typeof initial>;
type Manifest = RunManifest;
async function closeStorage(c: Container, path: string, runDir: string) {
  const db = join(c.env.XDG_DATA_HOME, 'opencode/opencode.db');
  if (!existsSync(db)) return;
  const backup = join(c.root, 'tmp', `usage-${randomUUID()}.db`);
  await checked(c.exec(['sqlite3', db, `.backup '${backup}'`]));
  writeFileSync(join(runDir, 'raw/opencode.db'), safeFile(path, backup));
}
async function previousAttempt(dir: string, m: Manifest) {
  if (m.status === 'running' && activeOwner(join(dir, 'owner.json')))
    throw new Error(`Run is active or reserved: ${m.run_id}`);
  if (m.status !== 'running') return;
  if (m.isolation.image && m.isolation.root) {
    const root = m.isolation.root;
    const ctx = new Container(
      root,
      join(root, 'repo'),
      runnerEnvironment(root),
      m.isolation.image,
      m.run_id,
    );
    await ctx.stop();
    if (!m.dry_run) await closeStorage(ctx, root, dir);
  }
  m.status = 'interrupted';
  m.finished_at = now();
  m.notes.push(
    'Previous owner exited. Unverified partial stage retained; retry uses a fresh checkout.',
  );
  writeJson(join(dir, 'manifest.json'), m);
  await meterRun(dir);
}
function bindInputs(file: string, signature: string) {
  if (
    !atomicNew(file, { signature }) &&
    readJson<{ signature: string }>(file).signature !== signature
  )
    throw new Error(`Frozen run inputs changed: ${file}`);
}
function provenance(
  plan: Plan,
  baselineHash: string,
  configHash: string,
  image: string | null,
  pluginHash: string | null,
) {
  return digest(
    JSON.stringify([
      plan.feature,
      plan.pin,
      plan.requirementsHash,
      plan.oracleHash,
      plan.expectedHash,
      plan.requested,
      plan.variant,
      plan.endpoint,
      plan.limits,
      plan.timeout,
      plan.flags,
      plan.sha,
      baselineHash,
      configHash,
      image,
      ...(pluginHash ? [pluginHash] : []),
      ...(plan.h03Pilot ? ['h03-pilot'] : []),
    ]),
  );
}
function stageWriter(m: Manifest, runDir: string, request: Invocation, start: string) {
  const path = join(runDir, 'manifest.json');
  const stageFiles = join(runDir, 'raw/stages');
  mkdirSync(stageFiles, { recursive: true });
  const stem = invocationStem(request);
  const records = new Map<string, StageRecord>();
  return {
    line: (line: string, stderr: boolean) => {
      appendFileSync(join(stageFiles, stem + (stderr ? '.stderr' : '.stdout')), `${line}\n`);
      if (stderr || !line.trim()) return;
      appendFileSync(join(runDir, 'raw/events.jsonl'), `${line}\n`);
      // Preserve malformed JSON in the stream. Meter and executor both reject it.
      let event: { type?: unknown; sessionID?: unknown; part?: { messageID?: unknown } } | null;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (typeof event?.sessionID !== 'string') return;
      let record = records.get(event.sessionID);
      let changed = false;
      if (!record) {
        record = {
          stage: request.stage,
          session_id: event.sessionID,
          review_iter: request.reviewIter,
          task: request.task,
          started_at: start,
          finished_at: null,
        };
        records.set(event.sessionID, record);
        m.stages.push(record);
        changed = true;
      }
      // One continued OpenCode session can contain turns for different tasks.
      const message = event.part?.messageID;
      if (
        request.task &&
        (event.type === 'step_start' || event.type === 'step_finish') &&
        typeof message === 'string' &&
        message.length > 0
      ) {
        record.message_ids ??= [];
        if (!record.message_ids.includes(message)) {
          record.message_ids.push(message);
          changed = true;
        }
      }
      if (changed) writeJson(path, m);
    },
    end: () => {
      const finished = now();
      for (const record of records.values()) {
        record.message_ids?.sort();
        record.finished_at = finished;
      }
      writeJson(path, m);
    },
  };
}

async function execute(
  plan: Plan,
  runDir: string,
  m: Manifest,
  repo: string,
  root: string,
  pluginHash: string | null,
) {
  const env = runnerEnvironment(root);
  const compressTools = m.mode !== 'baseline' && m.flags[TOOL_OUTPUT_COMPRESSION] === true;
  const workflow = workflowMode(m.mode, m.flags);
  if (compressTools) env.FRUGAL_TOOL_OUTPUT_COMPRESSION = '1';
  const installPlugin = (name: string) => {
    const plugin = join(plan.project, 'packages/opencode-plugin/dist/index.js');
    const plugins = join(env.OPENCODE_CONFIG_DIR, 'plugins');
    mkdirSync(plugins, { recursive: true });
    const installed = join(plugins, name);
    copyFileSync(plugin, installed);
    m.metering.plugin_sha256 = hashTree(installed);
    if (pluginHash && m.metering.plugin_sha256 !== pluginHash)
      throw new Error('Frozen H-03 plugin changed');
  };
  let relay: Awaited<ReturnType<typeof startUsageRelay>> | undefined;
  const closeRelay = async () => {
    if (relay) {
      const active = relay;
      relay = undefined;
      await active.close();
      if (plan.variant && validSubscriptionLedger(join(runDir, 'raw/relay.jsonl'), plan.variant))
        m.params.reasoning_effort = plan.variant;
    }
  };
  if (plan.goRelay) {
    const info = plan.fixture
      ? {
          model: m.model,
          prices: null,
          limits: null,
          endpoint: plan.fixture,
          catalog: 'synthetic-loopback',
        }
      : await goCatalog(m.model);
    m.prices = info.prices;
    installPlugin('frugal-correlation.js');
    env.FRUGAL_USAGE_CORRELATION = '1';
    writeJson(join(runDir, 'go-preflight.json'), {
      ...info,
      billing_setting_evidence: 'docs/OPENCODE_GO_HANDOFF.md',
      max_balance_charge: 0,
    });
    relay = plan.fixture
      ? await startUsageRelay({
          runDir,
          model: m.model,
          variant: plan.variant,
          fixture: true,
          upstream: plan.fixture,
        })
      : await startUsageRelay({
          runDir,
          model: m.model,
          variant: plan.variant,
          apiKey: process.env.OPENCODE_API_KEY ?? '',
        });
    try {
      createSettings(
        env,
        m.model,
        `http://host.docker.internal:${relay.port}/v1`,
        info.limits,
        true,
      );
    } catch (error) {
      await closeRelay();
      throw error;
    }
  } else {
    if (compressTools) installPlugin('frugal-compression.js');
    createSettings(env, m.model, plan.dry ? null : plan.endpoint, plan.limits);
  }
  const c = m.isolation.image ? new Container(root, repo, env, m.isolation.image, m.run_id) : null;
  const credentials = relay
    ? []
    : plan.endpoint
      ? ['FRUGAL_PROVIDER_API_KEY']
      : credentialKeys(m.provider);
  const archiveSecrets = compressTools
    ? [...credentials.map((name) => process.env[name] ?? ''), relay?.token ?? '']
    : [];
  const localEnv = { ...env, PATH: process.env.PATH, ...gitAuthor };
  const invokeTool = (name: string, args: string[]) =>
    c
      ? c.exec([name, ...args])
      : command(name === 'openspec' ? platformBin(plan.project, name) : name, args, {
          cwd: repo,
          env: localEnv,
        });
  let interrupted = false;
  const terminate = () => {
    interrupted = true;
    if (c) void c.stop().catch(() => {});
  };
  process.on('SIGTERM', terminate);
  process.on('SIGINT', terminate);
  try {
    if (c) {
      const others = plan.slots
        .map((s) => join(plan.out, `${s.pair}-${s.branch}-a1`, 'manifest.json'))
        .filter(existsSync)
        .map((path) => readJson<Manifest>(path).isolation.root)
        .filter((path): path is string => !!path && path !== root);
      await c.verifyIsolation(plan.project, plan.out, plan.oracle, ...new Set(others));
      const [opencode, openspec, node, python, test_runner] = await Promise.all(
        [
          ['opencode', '--version'],
          ['openspec', '--version'],
          ['node', '--version'],
          ['python', '--version'],
          ['pytest', '--version'],
        ].map((argv) => checked(c.exec(argv))),
      );
      m.versions = { frugal: plan.sha, opencode, openspec, node, python, test_runner };
    } else {
      m.versions.openspec = await checked(invokeTool('openspec', ['--version']));
      m.versions.opencode = 'replay-v1';
      m.versions.python = 'unused';
      m.versions.test_runner = 'unused';
    }
    const init = await invokeTool('openspec', [
      'init',
      '--tools',
      'opencode',
      '--scope',
      'project',
      '--no-animation',
    ]);
    writeFileSync(join(runDir, 'openspec-init.log'), init.stdout + init.stderr);
    await checked(Promise.resolve(init));
    const snapshot = async () => {
      const index = join(root, 'tmp', `snapshot-${randomUUID()}.idx`);
      // Use a separate index so a subsequent review sees the original working diff.
      if (c)
        return checked(
          c.exec([
            'sh',
            '-ec',
            'export GIT_INDEX_FILE="$1"; git read-tree HEAD; git add -A; git write-tree; rm -f "$1"',
            'snapshot',
            index,
          ]),
        );
      const gitEnv = { GIT_INDEX_FILE: index };
      git(repo, ['read-tree', 'HEAD'], gitEnv);
      git(repo, ['add', '-A'], gitEnv);
      return git(repo, ['write-tree'], gitEnv);
    };
    const invoke = async (request: Invocation): Promise<ReplayResult> => {
      if (interrupted) throw new Error('Interrupted before next stage');
      const writer = stageWriter(m, runDir, request, now());
      if (!request.args.includes('--title')) throw new Error('Missing fixed session title');
      let result: ReplayResult;
      let archiveError: unknown;
      if (plan.dry && !plan.fixture) {
        result = replay(repo, plan.feature, runDir, m.run_id, request);
        for (const line of result.stdout.trimEnd().split('\n')) writer.line(line, false);
      } else {
        if (!c) throw new Error('Live opencode requires container isolation');
        const secretEnv = relay ? { FRUGAL_RELAY_TOKEN: relay.token } : undefined;
        result = await c.exec(
          [
            'timeout',
            '--kill-after=10s',
            `${String(plan.timeout)}s`,
            'opencode',
            ...withGoVariant(request.args, plan.variant),
          ],
          {
            network: true,
            credentials,
            secretEnv,
            onLine: compressTools
              ? (line, stderr) => {
                  writer.line(line, stderr);
                  if (stderr || archiveError) return;
                  try {
                    captureToolOutput(repo, runDir, line, archiveSecrets);
                  } catch (error) {
                    archiveError = error;
                  }
                }
              : writer.line,
          },
        );
      }
      writer.end();
      if (!plan.dry && (result.code === 124 || result.code === 137)) {
        interrupted = true;
        throw new Error(
          `Stage ${request.stage} interrupted or timed out after at most ${plan.timeout} seconds (exit ${result.code})`,
        );
      }
      if (interrupted) throw new Error('Interrupted during stage');
      if (archiveError) throw archiveError;
      return result;
    };
    if (plan.goSmoke && plan.goRelay) {
      const r = await invoke({
        stage: 'verify',
        args: [
          'run',
          '--format',
          'json',
          '--model',
          m.model,
          '--title',
          'Frugal Go smoke',
          '--',
          'Reply with the single word ready. No tools.',
        ],
      });
      await checked(Promise.resolve(r));
      await closeRelay();
      if (!c) throw new Error('Go smoke needs an isolated Docker performer');
      await closeStorage(c, root, runDir);
      writeJson(join(runDir, 'manifest.json'), m);
      const usage = await meterRun(runDir);
      if (
        !usage.complete ||
        !usage.call_count ||
        usage.cost !== 0 ||
        !validSubscriptionLedger(join(runDir, 'raw/relay.jsonl'), plan.variant)
      )
        throw new Error('Go smoke billing or token reconciliation incomplete');
      m.final_commit = plan.pin;
      m.status = 'complete';
      m.notes.push('Subscription smoke; no feature implementation or quality acceptance.');
      return;
    }
    const native = {
      repo,
      configDir: env.OPENCODE_CONFIG_DIR,
      assetsRoot: join(plan.project, 'assets'),
      runDir,
      feature: plan.feature,
      requirement: plan.requirements,
      model: m.model,
      invoke,
      snapshot,
      omitToolLogsFromSnapshots: compressTools,
    };
    if (!plan.dry && workflow !== 'baseline') {
      if (!c) throw new Error('Live optimized tasks require an isolated performer');
      const config = publicTaskConfig(parse(git(repo, ['show', `${plan.pin}:frugal.yaml`])));
      await executeLiveOptimized({
        ...native,
        flags: m.flags,
        maxRetries: 1,
        taskInstructions: (id) =>
          `Add a substantive public pytest using @pytest.mark.task("${id}") and the applicable scenario marker. The controller runs the marked tests before advancing.`,
        checkTask: createTaskGate(root, repo, runDir, config, plan.timeout, (argv) => c.exec(argv)),
      });
    } else if (plan.dry && workflow !== 'baseline' && usesOptimizedReplay(m.flags)) {
      await executeOptimizedReplay({
        repo,
        runDir,
        feature: plan.feature,
        model: m.model,
        flags: m.flags,
        baseTree: plan.pin,
        invoke,
        snapshot,
      });
    } else {
      await executeBaseline(native);
    }
    await closeRelay();
    if (compressTools) {
      await c?.stop();
      collectToolOutputs(repo, runDir, archiveSecrets);
    }
    const bundle = join(root, 'tmp', `final-${randomUUID()}.bundle`);
    const finalGit = (args: string[]) =>
      c
        ? checked(
            c.exec([
              'env',
              ...Object.entries(gitAuthor).map(([k, v]) => `${k}=${v}`),
              'git',
              ...args,
            ]),
          )
        : Promise.resolve(git(repo, args, gitAuthor));
    const tree = await snapshot();
    if (compressTools && git(repo, ['ls-tree', '-r', '--name-only', tree, '--', '.frugal/logs']))
      throw new Error('Full tool logs cannot be tracked in the final snapshot');
    m.final_commit = await finalGit([
      'commit-tree',
      tree,
      '-p',
      plan.pin,
      '-m',
      'Frugal final snapshot',
    ]);
    await finalGit(['update-ref', 'refs/heads/frugal-result', m.final_commit]);
    await finalGit(['bundle', 'create', bundle, 'refs/heads/frugal-result']);
    writeFileSync(join(runDir, 'final.bundle'), safeFile(root, bundle));
    const diff = await invokeTool('git', [
      'diff',
      '--no-ext-diff',
      '--binary',
      plan.pin,
      m.final_commit,
    ]);
    await checked(Promise.resolve(diff));
    writeFileSync(join(runDir, 'final.diff'), diff.stdout);
    m.pipeline_complete = true;
    if (plan.dry) {
      m.gates = { evaluated: false, reason: 'synthetic replay' };
      m.hidden = { evaluated: false };
      m.notes.push(
        'Replay completed; synthetic fixture is ineligible for quality acceptance and token savings.',
      );
    } else {
      if (!c) throw new Error('Missing isolation for evaluation');
      if (!compressTools) await c.stop();
      await closeStorage(c, root, runDir);
      const quality = await evaluate(plan, runDir, m.final_commit, c.image, workflow);
      m.gates = quality.gates;
      m.hidden = quality.hidden;
      if (quality.code !== 0)
        throw new Error('Post-pipeline quality gates failed or require independent evidence');
    }
    writeJson(join(runDir, 'manifest.json'), m);
    const usage = await meterRun(runDir);
    if (!usage.complete) throw new Error('Meter reconciliation failed. See meter.json');
    m.status = 'complete';
    m.accepted = !plan.dry;
  } catch (error) {
    await closeRelay().catch((e) => m.notes.push(`Relay finalization failed: ${String(e)}`));
    m.status = interrupted ? 'interrupted' : 'failed';
    m.notes.push(error instanceof Error ? error.message : String(error));
    if (c) {
      try {
        await c.stop();
        if (compressTools) {
          try {
            collectToolOutputs(repo, runDir, archiveSecrets);
          } catch (archiveError) {
            m.notes.push(`Tool output archival failed: ${String(archiveError)}`);
          }
        }
        if (!plan.dry) await closeStorage(c, root, runDir);
      } catch (e) {
        m.notes.push(`Storage reconciliation failed: ${String(e)}`);
      }
    }
    writeJson(join(runDir, 'manifest.json'), m);
    await meterRun(runDir);
  } finally {
    process.off('SIGTERM', terminate);
    process.off('SIGINT', terminate);
    m.finished_at = now();
    writeJson(join(runDir, 'manifest.json'), m);
  }
}

export async function run(argv: string[]): Promise<number> {
  if (argv.includes('--evaluate-only')) return evaluateOnly(argv);
  const plan = parsePlan(argv);
  const project = realpathSync(plan.project);
  const temp = realpathSync(tmpdir());
  if (childOf(project, temp)) throw new Error('TMPDIR is inside project');
  // The bind mount exposes this path to the model. macOS TMPDIR is long and opaque.
  const armParent = plan.image && process.platform === 'darwin' ? realpathSync('/tmp') : temp;
  if (childOf(project, armParent))
    throw new Error('Performer temporary directory is inside project');
  if (plan.go && !plan.dry) {
    if (!process.env.OPENCODE_API_KEY)
      throw new Error(
        'OpenCode Go requires OPENCODE_API_KEY on the host. No provider request sent.',
      );
    if (!plan.goSmoke) verifySmoke(plan.out, plan.requested, plan.sha, plan.variant);
  }
  const image = plan.image ? await Container.imageID(plan.image) : null;
  const assetsHash = await hashBaselineAssets(join(plan.project, 'assets'));
  // The trusted pinned source alone supplies effective run settings. Build this clean copy before any model executes.
  const source = mkdtempSync(join(temp, 'frugal-input-'));
  git(source, ['clone', '--no-local', plan.bundle, 'repo']);
  const configText = git(join(source, 'repo'), ['show', `${plan.pin}:frugal.yaml`]);
  const config = parse(configText);
  const configHash = digest(configText);
  let admission: string | null = null;
  if (!plan.dry && plan.mode !== 'baseline' && !plan.h03Pilot) {
    if (!plan.h03Pair) {
      validateLiveOptFlags(flagsFor('optimized', config.flags ?? {}, plan.flags));
      publicTaskConfig(config);
    }
    if (!plan.cohorts)
      throw new Error('Live optimized execution requires verified F0/E0 archives via --e0-cohorts');
    const proof = await checked(
      command(analysisPython(plan.project), [
        join(plan.project, 'analysis/live_eligibility.py'),
        '--runs',
        plan.out,
        '--cohorts',
        plan.cohorts,
        '--baseline-hash',
        assetsHash,
      ]),
    );
    const verified = JSON.parse(proof);
    if (verified.eligible !== true || verified.baseline_hash !== assetsHash)
      throw new Error('F0/E0 admission did not confirm this baseline');
    admission = JSON.stringify(verified);
  }
  const pluginHash = plan.h03Pair
    ? hashTree(join(plan.project, 'packages/opencode-plugin/dist/index.js'))
    : null;
  const shared = provenance(plan, assetsHash, configHash, image, pluginHash);
  // Historical B0 receipts keep their filename. Each optimized protocol must
  // rehearse the same arms, even when its effective flags equal another mode's.
  const inputsKey = provenance(
    plan,
    assetsHash,
    configHash,
    plan.h03Pilot ? image : null,
    pluginHash,
  );
  const receiptKey = plan.mode === 'baseline' ? inputsKey : `${inputsKey}-${plan.mode}`;
  const receipt = join(plan.out, '.dry-runs', `${receiptKey}.json`);
  if (!plan.dry && !existsSync(receipt))
    throw new Error('First complete --dry-run for this mode, frozen inputs and requested model');
  if (!plan.dry) {
    const freeze = join(plan.out, '.baseline', 'B0.json');
    if (plan.calibration || existsSync(freeze)) bindInputs(freeze, assetsHash);
  }
  bindInputs(
    join(plan.out, '.series', `${plan.id}.json`),
    digest(
      JSON.stringify([
        shared,
        plan.dry,
        plan.slots,
        plan.experiment,
        plan.budget,
        plan.goSmoke,
        ...(admission ? [digest(admission)] : []),
        ...(plan.budgetPlan === plan.experiment ? [] : [plan.budgetPlan]),
      ]),
    ),
  );
  let successful = true;
  for (const slot of plan.slots) {
    let prior: string | null = null;
    let complete = false;
    for (let attempt = 1; !complete; attempt++) {
      const id = `${slot.pair}-${slot.branch}-a${attempt}`;
      const dir = join(plan.out, id);
      if (existsSync(dir)) {
        if (!plan.resume)
          throw new Error(
            `Reserved run already exists. Continue with --resume --series ${plan.id}`,
          );
        const path = join(dir, 'manifest.json');
        if (!existsSync(path)) throw new Error(`Incomplete run reservation: ${id}`);
        const previous = readJson<Manifest>(path);
        await previousAttempt(dir, previous);
        if (previous.status === 'complete') {
          if (
            plan.goSmoke &&
            !plan.dry &&
            validSubscriptionLedger(join(dir, 'raw/relay.jsonl'), plan.variant)
          )
            writeJson(smokeReceipt(plan.out, previous.model, plan.sha, plan.variant), {
              run_id: id,
              ledger_hash: hashTree(join(dir, 'raw/relay.jsonl')),
            });
          complete = true;
          continue;
        }
        // A finished model failure consumes its preregistered slot. Only interruption or a failure before any model invocation can retry.
        if (
          previous.status === 'failed' &&
          (previous.pipeline_complete || previous.stages.length > 0)
        ) {
          successful = false;
          complete = true;
          continue;
        }
        prior = id;
        continue;
      }
      const m = initial(plan, slot, id, assetsHash, image, prior, config, configHash);
      const root = createArmRoot(armParent);
      const repo = join(root, 'repo');
      m.isolation.root = root;
      const reservation = mkdtempSync(join(plan.out, '.reservation-'));
      writeJson(join(reservation, 'owner.json'), { pid: process.pid, host: hostname() });
      writeJson(join(reservation, 'manifest.json'), m);
      if (admission) writeJson(join(reservation, 'live-admission.json'), JSON.parse(admission));
      mkdirSync(join(reservation, 'raw'));
      renameSync(reservation, dir);
      try {
        git(root, ['clone', '--no-local', plan.bundle, repo]);
        git(repo, ['checkout', '--detach', plan.pin]);
        git(repo, ['remote', 'remove', 'origin']);
        if (
          git(repo, ['rev-parse', 'HEAD']) !== plan.pin ||
          git(repo, ['ls-files'])
            .split('\n')
            .some((p) => p.split('/').includes('hidden_tests'))
        )
          throw new Error('Invalid clean performer clone');
        await execute(plan, dir, m, repo, root, pluginHash);
      } catch (error) {
        m.status = 'failed';
        m.finished_at = now();
        m.notes.push(String(error));
        writeJson(join(dir, 'manifest.json'), m);
        await meterRun(dir);
      }
      console.log(
        JSON.stringify({ run_id: id, status: m.status, manifest: join(dir, 'manifest.json') }),
      );
      if (m.status !== 'complete') {
        successful = false;
        if (
          plan.go &&
          !plan.dry &&
          !validSubscriptionLedger(join(dir, 'raw/relay.jsonl'), plan.variant)
        ) {
          writeJson(smokeReceipt(plan.out, m.model, plan.sha, plan.variant), {
            blocked_run: id,
            reason:
              'Quota or subscription metering unconfirmed. Run a new live --go-smoke after repair or quota reset.',
          });
          return 1;
        }
        if (m.status === 'interrupted' || (!m.pipeline_complete && !m.stages.length)) return 1;
      }
      if (plan.goSmoke && !plan.dry && m.status === 'complete')
        writeJson(smokeReceipt(plan.out, m.model, plan.sha, plan.variant), {
          run_id: id,
          ledger_hash: hashTree(join(dir, 'raw/relay.jsonl')),
        });
      complete = true;
    }
  }
  if (plan.dry && successful)
    writeJson(receipt, {
      series: plan.id,
      finished_at: now(),
      feature: plan.feature,
      requested_model: plan.requested,
    });
  return successful ? 0 : 1;
}

async function evaluateOnly(argv: string[]): Promise<number> {
  const { values: v } = parseArgs({
    args: argv,
    options: {
      'evaluate-only': { type: 'string' },
      evidence: { type: 'string' },
      project: { type: 'string' },
      'oracle-root': { type: 'string' },
      signature: { type: 'string' },
      'reviewer-key': { type: 'string' },
    },
  });
  if (!v['evaluate-only']) throw new Error('Missing --evaluate-only run directory');
  const dir = realpathSync(v['evaluate-only']);
  const manifest = join(dir, 'manifest.json');
  const m = readJson<Manifest>(manifest);
  if (!m.pipeline_complete || !m.final_commit || m.dry_run || m.status === 'running')
    throw new Error(
      'Offline evaluation requires a finished real model pipeline and final snapshot',
    );
  const project = realpathSync(v.project ?? git(process.cwd(), ['rev-parse', '--show-toplevel']));
  const input = join(dir, 'evaluation');
  if (!existsSync(join(input, 'inputs.json'))) {
    const featureRoot = join(project, 'bench/features', m.feature_id);
    if (!m.isolation.image) throw new Error('Missing pinned evaluator image');
    await evaluate(
      {
        project,
        feature: m.feature_id,
        bundle: join(project, m.repo.url),
        pin: m.repo.commit,
        inputs: featureRoot,
        expectedHash: m.expected_hash,
        oracleHash: m.test_oracle_hash,
        oracle: join(
          v['oracle-root'] ?? join(project, 'bench/features'),
          m.feature_id,
          'hidden_tests',
        ),
      },
      dir,
      m.final_commit,
      m.isolation.image,
      workflowMode(m.mode, m.flags),
    );
  }
  const receipt = readJson<Record<string, string>>(join(input, 'inputs.json'));
  if (
    receipt.final_commit !== m.final_commit ||
    hashTree(join(dir, 'final.bundle')) !== receipt.bundle_hash ||
    hashTree(join(input, 'evidence.json')) !== receipt.evidence_hash ||
    hashTree(join(input, 'expected.yaml')) !== m.expected_hash ||
    receipt.oracle_hash !== m.test_oracle_hash
  )
    throw new Error('Offline evaluator inputs changed');
  const regression = readJson<{ ok: boolean; path: string; report_sha256: string }>(
    join(input, 'frozen-regression.json'),
  );
  if (hashTree(join(input, 'frozen-regression.json')) !== receipt.regression_hash || !regression.ok)
    throw new Error('Original regression suite failed or its frozen evidence changed');
  const repo = restoreFinal(dir, m.final_commit);
  const command = [
    '--repo',
    repo,
    '--change',
    m.feature_id,
    '--expected',
    join(input, 'expected.yaml'),
    '--evidence',
    join(input, 'evidence.json'),
    '--openspec',
    platformBin(project, 'openspec'),
  ];
  if (!v.evidence) return gates([...command, '--out', join(dir, 'quality'), '--prepare']);
  const assessment = readFileSync(v.evidence);
  const sha = digest(assessment);
  const decisionDir = join(input, 'assessments', sha);
  mkdirSync(decisionDir, { recursive: true });
  const saved = join(decisionDir, 'assessment.json');
  writeFileSync(saved, assessment);
  const args = [...command, '--assessment', saved, '--infer', '--out', decisionDir];
  if (Boolean(v.signature) !== Boolean(v['reviewer-key']))
    throw new Error('Supply both --signature and --reviewer-key');
  if (v.signature && v['reviewer-key'])
    args.push(
      '--signature',
      realpathSync(v.signature),
      '--reviewer-key',
      realpathSync(v['reviewer-key']),
    );
  const result = await gates(args);
  const usage = await meterRun(dir);
  if (result !== 0 || !usage.complete) return 1;
  bindInputs(join(input, 'accepted.json'), sha);
  m.gates = readJson(join(decisionDir, 'gates.json'));
  m.hidden = (m.gates?.suites as { hidden?: Record<string, unknown> } | undefined)?.hidden ?? null;
  m.assessment_sha256 = sha;
  m.accepted = true;
  m.status = 'complete';
  // finished_at still denotes the original pipeline attempt. QA has its own time and evidence.
  writeJson(join(decisionDir, 'decision.json'), {
    final_commit: m.final_commit,
    assessed_at: now(),
    assessment_sha256: sha,
    usage_scope: 'independent-post-pipeline',
  });
  for (const name of ['gates.json', 'trace.json', 'gates.md'])
    if (existsSync(join(decisionDir, name)))
      writeFileSync(join(dir, 'quality', name), readFileSync(join(decisionDir, name)));
  writeJson(manifest, m);
  return 0;
}
