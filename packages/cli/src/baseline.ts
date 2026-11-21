import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  writeFile,
} from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';
import { invocationStem } from './harness/replay.js';
import type { TaskApplyInput } from './task-sessions.js';

export type BaselineStage = 'spec' | 'apply' | 'review' | 'fix' | 'verify';

export interface BaselineRequest {
  stage: BaselineStage;
  args: string[];
  reviewIter?: number;
  task?: string;
  attempt?: number;
}

interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface BaselineOptions {
  repo: string;
  configDir: string;
  assetsRoot: string;
  runDir: string;
  feature: string;
  requirement: string;
  model: string;
  invoke: (request: BaselineRequest) => Promise<CommandResult>;
  /** Canonical Git tree using the same staging policy as the evaluator, in the sandbox. */
  snapshot?: () => Promise<string>;
}

interface Snapshot {
  content: string;
  tree?: string;
}

interface StageEvidence {
  stage: BaselineStage;
  review_iter?: number;
  task?: string;
  attempt?: number;
  prompt?: string;
  input: Snapshot;
  output?: Snapshot;
  transcript: string;
  session_id?: string;
}

interface Review {
  round: number;
  tree?: string;
  input_snapshot: string;
  scope: 'full';
  verdict: 'pass' | 'fix';
  summary: string;
  transcript: string;
  session_id: string;
  fix_transcript?: string;
  fix_snapshot?: string;
}

const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const generatedDirectories = new Set([
  '.git',
  '.venv',
  '__pycache__',
  '.pytest_cache',
  '.ruff_cache',
  'node_modules',
]);

async function atomicJson(path: string, data: unknown) {
  await writeFile(`${path}.tmp`, `${JSON.stringify(data, null, 2)}\n`);
  await rename(`${path}.tmp`, path);
}

async function filesIn(root: string, skipGenerated = false, prefix = ''): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of (await readdir(join(root, prefix), { withFileTypes: true })).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    const path = join(prefix, entry.name);
    if (skipGenerated && entry.isDirectory() && generatedDirectories.has(entry.name)) continue;
    if (entry.isDirectory()) paths.push(...(await filesIn(root, skipGenerated, path)));
    else if (entry.isFile() || entry.isSymbolicLink()) paths.push(path);
    else throw new Error(`Unsupported file type: ${path}`);
  }
  return paths;
}

async function rootFile(root: string, path: string): Promise<string> {
  const target = await realpath(join(root, path));
  const rel = relative(await realpath(root), target);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || !(await lstat(target)).isFile()) {
    throw new Error(`Expected a regular file in the checkout: ${path}`);
  }
  return target;
}

async function putOnce(path: string, data: Buffer | string) {
  try {
    await writeFile(path, data, { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}

async function capture(
  opts: BaselineOptions,
  archive: string,
  requireTree: boolean,
): Promise<Snapshot> {
  const entries = [];
  for (const path of await filesIn(opts.repo, true)) {
    const full = join(opts.repo, path);
    const stat = await lstat(full);
    const symlink = stat.isSymbolicLink();
    const bytes = symlink ? Buffer.from(await readlink(full)) : await readFile(full);
    const hash = sha256(bytes);
    await putOnce(join(archive, 'blobs', hash), bytes);
    entries.push({
      path,
      mode: symlink ? '120000' : stat.mode & 0o111 ? '100755' : '100644',
      sha256: hash,
    });
  }
  const json = `${JSON.stringify(entries)}\n`;
  const content = sha256(json);
  await putOnce(join(archive, 'snapshots', `${content}.json`), json);
  const tree = await opts.snapshot?.();
  if (
    (requireTree || tree !== undefined) &&
    (typeof tree !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(tree))
  )
    throw new Error('Invalid Git tree id');
  return tree ? { content, tree } : { content };
}

export async function hashBaselineAssets(assetsRoot: string): Promise<string> {
  const items = [];
  for (const group of ['agents/base', 'commands/base']) {
    const root = join(assetsRoot, group);
    for (const path of await filesIn(root)) {
      items.push([join(group, path), sha256(await readFile(await rootFile(root, path)))]);
    }
  }
  return sha256(JSON.stringify(items));
}

async function skillsIn(repo: string) {
  const skills = {
    spec: 'openspec-propose',
    apply: 'openspec-apply-change',
    verify: 'openspec-verify-change',
  } as const;
  const hashes: Record<string, string> = {};
  for (const name of Object.values(skills)) {
    const path = await rootFile(repo, join('.agents', 'skills', name, 'SKILL.md'));
    const bytes = await readFile(path);
    if (!bytes.toString().trim()) throw new Error(`Empty project skill: ${name}`);
    hashes[name] = sha256(bytes);
  }
  return { names: skills, hashes };
}

async function checkArtifacts(repo: string, feature: string, applied: boolean) {
  const change = join('openspec', 'changes', feature);
  for (const artifact of ['proposal.md', 'design.md', 'tasks.md']) {
    const value = await readFile(await rootFile(repo, join(change, artifact)), 'utf8');
    if (!value.trim()) throw new Error(`Empty change artifact: ${artifact}`);
    if (artifact === 'tasks.md') {
      const tasks = [...value.matchAll(/^\s*[-*]\s+\[([ xX])\]\s+\S/gm)];
      if (!tasks.length || (applied && tasks.some(([, mark]) => mark === ' '))) {
        throw new Error(`Missing or unfinished tasks in ${artifact}`);
      }
    }
  }
  const root = await realpath(repo);
  const specs = await realpath(join(repo, change, 'specs'));
  if (!specs.startsWith(root + sep)) throw new Error('Specs outside checkout');
  const delta = (await filesIn(specs)).filter((path) => basename(path) === 'spec.md');
  if (!delta.length) throw new Error('No OpenSpec delta specification');
  for (const path of delta) {
    if (!(await readFile(await rootFile(repo, join(change, 'specs', path)), 'utf8')).trim()) {
      throw new Error(`Empty OpenSpec delta specification: ${path}`);
    }
  }
}

export function stageReply(result: CommandResult) {
  if (result.code !== 0) throw new Error(`opencode exited with code ${result.code}`);
  if (/falling back to default agent/i.test(result.stderr))
    throw new Error('Requested agent unavailable');
  let session = '';
  let finish = '';
  let finalMessage: string | undefined;
  let inspected = false;
  const text: { message?: string; value: string }[] = [];
  for (const line of result.stdout.split(/\r?\n/).filter((s) => s.trim())) {
    const event = JSON.parse(line);
    if (event.type === 'error') throw new Error('opencode emitted an error');
    if (
      typeof event.sessionID !== 'string' ||
      !event.sessionID ||
      (session && session !== event.sessionID)
    ) {
      throw new Error('Mixed or missing root session ID');
    }
    session = event.sessionID;
    if (
      event.type === 'tool_use' &&
      event.part?.state?.status === 'completed' &&
      ['read', 'grep', 'bash', 'task'].includes(event.part.tool)
    )
      inspected = true;
    if (event.type === 'text' && typeof event.part?.text === 'string') {
      text.push({ message: event.part.messageID, value: event.part.text });
    }
    if (event.type === 'step_finish') {
      finish = event.part?.reason;
      finalMessage = event.part?.messageID;
    }
  }
  if (!session || finish !== 'stop')
    throw new Error(`No completed model response (finish=${finish})`);
  const answer = text
    .filter((part) => part.message === finalMessage)
    .map((part) => part.value)
    .join('\n')
    .trim();
  if (!answer) throw new Error('Missing final assistant reply');
  return { session, answer, inspected };
}

function verdict(answer: string, stage: 'review' | 'verify') {
  const lines = answer
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim());
  const terminal = lines.pop();
  const normalized = lines.map((line) => line.replace(/^(?:[-*]|\d+\.)\s+/, ''));
  const isReview = stage === 'review';
  const prefix = isReview ? 'VERDICT:' : 'VERIFY:';
  if (
    !normalized.some((line) => line.length > 0) ||
    normalized.some((line) => line.startsWith(prefix))
  ) {
    throw new Error(`Missing rationale or ambiguous ${stage} verdict`);
  }
  if (
    terminal !== prefix + (isReview ? ' ACCEPT' : ' PASS') &&
    terminal !== prefix + (isReview ? ' CHANGES REQUESTED' : ' FAIL')
  ) {
    throw new Error(`Invalid terminal ${stage} verdict`);
  }
  const pass = terminal === prefix + (isReview ? ' ACCEPT' : ' PASS');
  if (
    isReview &&
    normalized.some((line) => {
      if (!/^BLOCKING:/i.test(line)) return false;
      const finding = line.slice('BLOCKING:'.length).trim();
      return Boolean(finding) && !/^(?:none(?: found)?|no blocking findings)\.?$/i.test(finding);
    }) === pass
  ) {
    throw new Error('Review verdict disagrees with blocking findings');
  }
  return pass;
}

/** Raw streams and exports are recorded by invoke before a command returns. */
export function executeBaseline(opts: BaselineOptions) {
  return executeNativePipeline(opts);
}

interface NativeTaskPlan {
  flags: { session_per_task: boolean; capsule: boolean };
  run(
    apply: (input: TaskApplyInput) => Promise<{ sessionId: string; handoff: string }>,
  ): Promise<void>;
}

export async function executeNativePipeline(opts: BaselineOptions, taskPlan?: NativeTaskPlan) {
  if (
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(opts.feature) ||
    !opts.requirement.trim() ||
    !/^[^/\s]+\/[^\s]+$/.test(opts.model)
  )
    throw new Error('Invalid baseline inputs');
  const archiveName = taskPlan ? 'opt' : 'b0';
  const archive = join(opts.runDir, archiveName);
  // Refuse reusing stage evidence from another attempt.
  await mkdir(archive);
  for (const dir of ['stages', 'snapshots', 'blobs']) await mkdir(join(archive, dir));

  const assetsHash = await hashBaselineAssets(opts.assetsRoot);
  const skills = await skillsIn(opts.repo);
  const agents = join(opts.configDir, 'agents');
  await mkdir(agents, { recursive: true });
  for (const agent of ['base-reviewer', 'base-fixer']) {
    await copyFile(
      join(opts.assetsRoot, 'agents', 'base', `${agent}.md`),
      join(agents, `${agent}.md`),
      constants.COPYFILE_EXCL,
    );
  }
  const prompts: Record<string, string> = {};
  for (const name of ['propose', 'apply', 'review', 'fix', 'verify']) {
    prompts[name] = (
      await readFile(join(opts.assetsRoot, 'commands', 'base', `${name}.md`), 'utf8')
    ).trim();
  }
  const stages: StageEvidence[] = [];
  const reviews: Review[] = [];
  const sessions = new Set<string>();
  const applySessions = new Set<string>();
  const persist = async (status: 'running' | 'completed' | 'failed', error?: string) => {
    await atomicJson(join(opts.runDir, taskPlan ? 'optimized.json' : 'baseline.json'), {
      protocol: taskPlan ? 'task-apply' : 'B0',
      ...(taskPlan ? { flags: taskPlan.flags } : {}),
      assets_hash: assetsHash,
      skills: skills.hashes,
      status,
      stages,
      ...(error ? { error } : {}),
    });
    await atomicJson(join(archive, 'quality-review.json'), reviews);
  };

  const call = async (
    stage: BaselineStage,
    round?: number,
    feedback = '',
    task?: TaskApplyInput,
  ) => {
    const iteration = round ? `-${round}` : '';
    const taskInfo = task ? { task: task.taskId, attempt: task.attempt } : {};
    const stem = task ? invocationStem({ stage, ...taskInfo }) : stage + iteration;
    const log = `${archiveName}/stages/${stem}.md`;
    const input = await capture(opts, archive, taskPlan !== undefined);
    const entry: StageEvidence = { stage, review_iter: round, ...taskInfo, input, transcript: log };
    if (task) {
      entry.prompt = `${archiveName}/stages/${stem}.input.md`;
      await writeFile(join(opts.runDir, entry.prompt), task.prompt, { flag: 'wx' });
    }
    stages.push(entry);
    await persist('running');
    const values: Record<string, string> = {
      change: opts.feature,
      brief: opts.requirement,
      review: feedback,
    };
    const template = prompts[stage === 'spec' ? 'propose' : stage];
    const prompt =
      task?.prompt ??
      template.replace(/\{\{(change|brief|review)\}\}/g, (_, field: string) => values[field]);
    const args = [
      'run',
      '--format',
      'json',
      '--model',
      opts.model,
      '--title',
      `${basename(opts.runDir)}/${stem}`,
    ];
    if (task) {
      args.push('--agent', 'build');
      if (task.sessionId) args.push('--session', task.sessionId);
    } else if (stage === 'review' || stage === 'fix')
      args.push('--agent', stage === 'review' ? 'base-reviewer' : 'base-fixer');
    else args.push('--command', skills.names[stage]);
    args.push('--', prompt);
    const result = await opts.invoke({ stage, args, reviewIter: round, ...taskInfo });
    const reply = stageReply(result);
    await writeFile(join(opts.runDir, log), `${reply.answer}\n`, { flag: 'wx' });
    entry.session_id = reply.session;
    if (task?.sessionId) {
      if (task.sessionId !== reply.session || !applySessions.has(reply.session))
        throw new Error(`Unexpected apply continuation: ${reply.session}`);
    } else if (sessions.has(reply.session)) {
      throw new Error(
        `Root session reused across ${taskPlan ? 'native' : 'B0'} stages: ${reply.session}`,
      );
    }
    sessions.add(reply.session);
    if (task) applySessions.add(reply.session);
    const output = await capture(opts, archive, taskPlan !== undefined);
    entry.output = output;
    await persist('running');
    if (
      (stage === 'review' || stage === 'verify') &&
      (input.content !== output.content || input.tree !== output.tree)
    ) {
      throw new Error(`${stage} modified the reviewed snapshot`);
    }
    if ((stage === 'review' || stage === 'verify') && !reply.inspected) {
      throw new Error(`${stage} did not inspect the working tree`);
    }
    return { ...reply, log, input, output };
  };

  try {
    await call('spec');
    await checkArtifacts(opts.repo, opts.feature, false);
    if (taskPlan) {
      await taskPlan.run(async (task) => {
        const step = await call('apply', undefined, '', task);
        return { sessionId: step.session, handoff: step.answer };
      });
      await checkArtifacts(opts.repo, opts.feature, true);
    } else {
      await call('apply');
    }
    let accepted = false;
    for (let round = 1; round <= 5; round++) {
      const review = await call('review', round);
      accepted = verdict(review.answer, 'review');
      const record: Review = {
        round,
        tree: review.input.tree,
        scope: 'full',
        verdict: accepted ? 'pass' : 'fix',
        summary: review.answer,
        transcript: review.log,
        session_id: review.session,
        input_snapshot: review.input.content,
      };
      reviews.push(record);
      await persist('running');
      if (accepted) break;
      const fixed = await call('fix', round, review.answer);
      record.fix_transcript = fixed.log;
      record.fix_snapshot = fixed.output.content;
      await persist('running');
    }
    const verified = await call('verify');
    const verifyPassed = verdict(verified.answer, 'verify');
    if (!accepted || !verifyPassed)
      throw new Error(!accepted ? 'Five review rounds exhausted' : 'Verification failed');
    await checkArtifacts(opts.repo, opts.feature, true);
    await persist('completed');
    return { reviews, stages, assetsHash };
  } catch (error) {
    await persist('failed', error instanceof Error ? error.message : String(error));
    throw error;
  }
}
