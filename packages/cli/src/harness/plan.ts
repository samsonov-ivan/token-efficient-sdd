import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { parse } from 'yaml';
import { type GoVariant, isGoVariant } from './go.js';
import { digest, git, hashTree, readJson, slug } from './io.js';
export type Mode = 'baseline' | 'optimized' | 'ablation';
export type Flag = boolean | number | 'auto';
type Budget = {
  runs: number;
  mode: string;
  feature: string;
  model: string;
  variant?: GoVariant;
  maximum_cost: number;
  estimated_cost_per_arm: number;
  quota_available: number;
};
export function parsePlan(argv: string[]) {
  const { values: v } = parseArgs({
    args: argv,
    options: {
      mode: { type: 'string' },
      feature: { type: 'string' },
      model: { type: 'string' },
      variant: { type: 'string' },
      runs: { type: 'string' },
      series: { type: 'string' },
      resume: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      project: { type: 'string' },
      'oracle-root': { type: 'string' },
      out: { type: 'string' },
      flag: { type: 'string', multiple: true },
      image: { type: 'string' },
      experiment: { type: 'string' },
      'budget-plan': { type: 'string' },
      endpoint: { type: 'string' },
      'context-limit': { type: 'string' },
      'output-limit': { type: 'string' },
      calibration: { type: 'boolean' },
      timeout: { type: 'string' },
      'go-smoke': { type: 'boolean' },
      'usage-relay': { type: 'boolean' },
      'relay-fixture': { type: 'string' },
    },
  });
  const project = resolve(v.project ?? git(process.cwd(), ['rev-parse', '--show-toplevel']));
  const experiment = v.experiment ? slug(v.experiment, 'experiment') : null;
  const budgetPlan =
    v['budget-plan'] === undefined ? experiment : slug(v['budget-plan'], 'budget plan');
  if (budgetPlan && !experiment) throw new Error('--budget-plan requires --experiment');
  const budget = budgetPlan
    ? readJson<Budget>(join(project, 'bench/plans', `${budgetPlan}.json`))
    : null;
  let endpoint: string | null = null;
  let limits: { context: number; output: number } | null = null;
  if (v.endpoint) {
    const url = new URL(v.endpoint);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error(
        'Endpoint must be an HTTP(S) base URL without credentials, query or fragment',
      );
    if (
      url.protocol === 'http:' &&
      !['127.0.0.1', 'localhost', '[::1]', 'host.docker.internal'].includes(url.hostname)
    )
      throw new Error('Use HTTPS for a remote provider');
    endpoint = url.href.replace(/\/$/, '');
    const context = Number(v['context-limit']),
      output = Number(v['output-limit']);
    if (
      !Number.isSafeInteger(context) ||
      !Number.isSafeInteger(output) ||
      output < 1 ||
      context <= output
    )
      throw new Error('Set verified --context-limit and --output-limit for the custom model');
    limits = { context, output };
  } else if (v['context-limit'] || v['output-limit'])
    throw new Error('Model limits require --endpoint');
  const timeout = Number(v.timeout ?? 1800);
  if (!Number.isSafeInteger(timeout) || timeout <= 0)
    throw new Error('Stage timeout must be a positive integer in seconds');
  const mode = v.mode ?? budget?.mode ?? 'baseline';
  if (!['baseline', 'optimized', 'ablation', 'paired'].includes(mode))
    throw new Error(`Unknown mode: ${mode}`);
  const dry = !!v['dry-run'];
  const runs = Number(v.runs ?? budget?.runs ?? 1);
  if (!Number.isSafeInteger(runs) || runs < 1 || runs > 1000)
    throw new Error('runs must be an integer between 1 and 1000');
  const feature = slug(v.feature ?? budget?.feature ?? '', 'feature');
  const requested = v.model ?? budget?.model ?? (dry ? 'mock/replay' : '');
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_./:-]+$/.test(requested))
    throw new Error('Expected --model provider/model-id');
  const variant = v.variant ?? budget?.variant;
  if (
    variant !== undefined &&
    (requested !== 'opencode-go/deepseek-v4.1-flash' || !isGoVariant(variant))
  )
    throw new Error(
      '--variant currently supports low, high or max on opencode-go/deepseek-v4.1-flash',
    );
  if (
    !dry &&
    git(project, [
      'status',
      '--porcelain',
      '--',
      'packages',
      'assets',
      'bench/repos',
      'bench/features',
      'tools/runner',
      'schemas',
    ])
  )
    throw new Error('Live execution requires committed code, prompts and benchmark inputs');
  const fixture = v['relay-fixture'] ?? null;
  if (fixture) {
    const u = new URL(fixture);
    if (
      !dry ||
      !v['go-smoke'] ||
      !v.image ||
      u.protocol !== 'http:' ||
      u.hostname !== '127.0.0.1' ||
      !u.port ||
      u.username ||
      u.password ||
      u.hash ||
      u.search
    )
      throw new Error(
        'Relay fixture requires a loopback HTTP port, --dry-run --go-smoke and --image',
      );
  }
  const go = requested.startsWith('opencode-go/');
  if (v['go-smoke'] && (!go || runs !== 1 || mode !== 'baseline'))
    throw new Error('--go-smoke requires one baseline run on an opencode-go model');
  if (v['usage-relay'] && !go)
    throw new Error('The subscription usage relay requires an opencode-go model');
  if (go && endpoint)
    throw new Error('OpenCode Go uses its fixed official upstream, omit --endpoint');
  if (!dry && requested.startsWith('mock/')) throw new Error('Mock model requires --dry-run');
  if (!dry && runs * (mode === 'paired' ? 2 : 1) > 2) {
    const total =
      (budget?.estimated_cost_per_arm ?? NaN) * runs * (mode === 'paired' ? 2 : 1) * 1.3;
    if (
      !budget ||
      !Number.isFinite(total) ||
      total < 0 ||
      !Number.isFinite(budget.maximum_cost) ||
      budget.maximum_cost < 0 ||
      !Number.isFinite(budget.quota_available) ||
      budget.quota_available < 0 ||
      total > budget.maximum_cost ||
      total > budget.quota_available ||
      [budget.runs, budget.mode, budget.feature, budget.model].join('|') !==
        [runs, mode, feature, requested].join('|') ||
      budget.variant !== variant
    )
      throw new Error(
        'Live series requires a matching registered experiment, estimate +30%, budget and available quota',
      );
  }
  if (v.resume && !v.series) throw new Error('--resume requires --series');
  const id = slug(v.series ?? `run-${randomUUID()}`, 'series');
  const out = resolve(v.out ?? join(project, 'bench/runs'));
  const inputs = join(project, 'bench/features', feature);
  const expected = parse(readFileSync(join(inputs, 'expected.yaml'), 'utf8'));
  const repo = slug(expected.repo, 'repository in expected.yaml');
  const bundle = join(project, 'bench/repos', `${repo}.bundle`);
  const pin = readFileSync(join(project, 'bench/repos', `${repo}.sha`), 'utf8').trim();
  if (!/^[a-f0-9]{40,64}$/.test(pin)) throw new Error('Invalid repository pin');
  const requirements = readFileSync(join(inputs, 'requirement.md'), 'utf8');
  const oracle = join(
    v['oracle-root'] ? resolve(v['oracle-root'], feature) : inputs,
    'hidden_tests',
  );
  const oracleHash = existsSync(oracle) ? hashTree(oracle) : 'unavailable';
  if (!dry && !v['go-smoke'] && oracleHash === 'unavailable')
    throw new Error('Missing frozen hidden oracle');
  const flags = (v.flag ?? []).map((f) => slug(f, 'optimization flag')).sort();
  if (mode === 'ablation' && !flags.length) throw new Error('--mode ablation requires --flag');
  if (mode === 'baseline' && flags.length) throw new Error('B0 requires all flags off');
  const slotModes: Mode[] = mode === 'paired' ? ['baseline', 'optimized'] : [mode as Mode];
  const slots = Array.from({ length: runs }, (_, i) =>
    slotModes.map((m) => ({
      pair: `${id}-${i + 1}`,
      mode: m,
      branch: m === 'baseline' ? 'base' : m === 'optimized' ? 'opt' : `ablation-${flags.join('-')}`,
    })),
  ).flat();
  return {
    project,
    out,
    experiment,
    budgetPlan,
    endpoint,
    limits,
    timeout,
    go,
    goRelay: go && (!dry || Boolean(fixture)),
    fixture,
    goSmoke: !!v['go-smoke'],
    calibration: !!v.calibration || experiment === 'E0' || experiment === 'E0-s',
    budget,
    mode,
    dry,
    id,
    runs,
    flags,
    slots,
    image: v.image ?? (dry ? null : 'frugal-runner:local'),
    resume: !!v.resume,
    feature,
    repo,
    bundle,
    pin,
    requirements,
    inputs,
    oracle,
    oracleHash,
    requirementsHash: digest(requirements),
    expectedHash: hashTree(join(inputs, 'expected.yaml')),
    requested,
    variant,
    model: dry && !fixture ? 'mock/replay' : requested,
    sha: git(project, ['rev-parse', 'HEAD']),
  };
}
export type Plan = ReturnType<typeof parsePlan>;
export type Slot = Plan['slots'][number];
export function flagsFor(mode: Mode, defaults: Record<string, Flag>, selected: string[]) {
  for (const flag of selected)
    if (!Object.hasOwn(defaults, flag))
      throw new Error(`Unknown optimization flag in target config: ${flag}`);
  return Object.fromEntries(
    Object.keys(defaults)
      .sort()
      .map((k) => [
        k,
        mode === 'baseline'
          ? false
          : mode === 'ablation' || selected.length
            ? selected.includes(k)
            : defaults[k],
      ]),
  );
}
