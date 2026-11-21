import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { stageReply } from '../baseline.js';
import { runOptimizedReview } from '../review.js';
import { runTaskSessions } from '../task-sessions.js';
import { checked, writeJson } from './io.js';
import type { Flag } from './plan.js';
import { type Invocation, invocationStem, type ReplayResult } from './replay.js';

const tasks = [
  { id: '1.1', req: 'REQ-REPLAY-01', scenario: 'SCN-REPLAY-01.1', file: 'replay-marker.txt' },
  { id: '1.2', req: 'REQ-REPLAY-02', scenario: 'SCN-REPLAY-02.1', file: 'replay-sidecar.txt' },
];
const expected = 'synthetic lifecycle fixture\n';
const needsFix = 'synthetic marker needs a review fix\n';
const reviewFlags = ['incremental_review', 'checklist_review', 'targeted_fix'];

export function usesOptimizedReplay(flags: Record<string, Flag>) {
  // Keep the same two-task input for all four H-01/H-02 combinations, including both off.
  return (
    Object.hasOwn(flags, 'session_per_task') ||
    ['capsule', ...reviewFlags].some((flag) => flags[flag] === true)
  );
}

interface Options {
  repo: string;
  runDir: string;
  feature: string;
  model: string;
  flags: Record<string, Flag>;
  baseTree: string;
  invoke: (request: Invocation) => Promise<ReplayResult>;
  snapshot: () => Promise<string>;
}

export async function executeOptimizedReplay(opts: Options) {
  const { repo, runDir, feature, flags, snapshot } = opts;
  const change = `openspec/changes/${feature}`;
  const specPath = `${change}/specs/replay/spec.md`;
  const archive = join(runDir, 'opt');
  const inputs = join(archive, 'inputs');
  mkdirSync(inputs, { recursive: true });
  const tasksPath = join(repo, change, 'tasks.md');
  const requirements = tasks.map(({ req, scenario, file }) => ({
    id: req,
    path: specPath,
    statement: `The replay fixture SHALL persist \`${file}\`.`,
    scenarios: [scenario],
    scenario_text: { [scenario]: `- **WHEN** replay runs\n- **THEN** \`${file}\` exists\n` },
  }));
  const taskList = (done: Set<string>) =>
    '## 1. Replay\n\n' +
    tasks
      .map(
        ({ id, req, scenario, file }) =>
          `- [${done.has(id) ? 'x' : ' '}] ${id} Write \`${file}\` [${req}, ${scenario}].\n`,
      )
      .join('');
  const [primary] = tasks;
  const primaryPath = join(repo, primary.file);
  const inspect = () => readFileSync(primaryPath, 'utf8');
  const invokeStep = async (
    input: Pick<Invocation, 'stage' | 'reviewIter' | 'task' | 'attempt'>,
    prompt: string,
    fixture: NonNullable<Invocation['fixture']>,
    sessionId?: string,
  ) => {
    const stem = invocationStem(input);
    writeFileSync(join(inputs, `${stem}.txt`), prompt, { flag: 'wx' });
    const result = await opts.invoke({
      ...input,
      args: [
        'run',
        '--format',
        'json',
        '--model',
        opts.model,
        '--title',
        `${basename(runDir)}/${stem}`,
        ...(sessionId ? ['--session', sessionId] : []),
        '--',
        prompt,
      ],
      fixture,
    });
    await checked(Promise.resolve(result));
    const { answer, session } = stageReply(result);
    if (answer !== fixture.answer) throw new Error(`Unexpected replay reply for ${stem}`);
    return { answer, sessionId: session };
  };
  const emit = async (
    input: Pick<Invocation, 'stage' | 'reviewIter'>,
    prompt: string,
    fixture: NonNullable<Invocation['fixture']>,
  ) => (await invokeStep(input, prompt, fixture)).answer;

  await emit({ stage: 'spec' }, 'Describe the synthetic replay markers.', {
    answer: 'Completed the synthetic spec fixture.',
    mutate() {
      mkdirSync(join(repo, change, 'specs/replay'), { recursive: true });
      writeFileSync(
        join(repo, change, 'proposal.md'),
        '## Why\n\nExercise the opt replay fixture.\n\n## What Changes\n\nAdd two synthetic markers.\n',
      );
      writeFileSync(
        join(repo, change, 'design.md'),
        '## Decisions\n\nPersist one marker per fixture task.\n',
      );
      writeFileSync(
        join(repo, specPath),
        '## ADDED Requirements\n\n' +
          requirements
            .map(
              ({ id, statement, scenarios: [scenario], scenario_text }) =>
                `### Requirement: ${id} Replay marker\n${statement}\n\n#### Scenario: ${scenario} Marker exists\n${scenario_text[scenario]}\n`,
            )
            .join(''),
      );
      writeFileSync(tasksPath, taskList(new Set()));
    },
  });

  const done = new Set<string>();
  const structuredReview = reviewFlags.some((flag) => flags[flag] === true);
  const writeMarker = (task: (typeof tasks)[number]) => {
    writeFileSync(
      join(repo, task.file),
      task === primary && structuredReview ? needsFix : expected,
    );
  };
  function fixtureTask(id: string) {
    const task = tasks.find((item) => item.id === id);
    if (!task) throw new Error(`Unknown replay task: ${id}`);
    return task;
  }
  const perTask = await runTaskSessions(
    {
      repo,
      changeId: feature,
      sessionPerTask: flags.session_per_task === true,
      capsule: flags.capsule === true,
      maxRetries: 1,
    },
    {
      async apply({ taskId, prompt, sessionId, attempt }) {
        const task = fixtureTask(taskId);
        const result = await invokeStep(
          { stage: 'apply', task: taskId, attempt },
          prompt,
          {
            answer: [
              `Task ${taskId}: wrote ${task.file}.`,
              `Public artifact: ${task.file} (${task.req}).`,
              `Task gate: check ${task.file} for a nonempty marker (${task.scenario}).`,
            ].join('\n'),
            mutate: () => writeMarker(task),
          },
          sessionId,
        );
        return { sessionId: result.sessionId, handoff: result.answer };
      },
      async checkTask(id) {
        const task = fixtureTask(id);
        const path = join(repo, task.file);
        const passed = existsSync(path) && readFileSync(path, 'utf8').trim().length > 0;
        if (passed) done.add(id);
        return { passed, summary: `${task.scenario}: expected a nonempty marker in ${task.file}` };
      },
    },
  );
  if (!perTask) {
    await emit({ stage: 'apply' }, `Implement the tasks in ${change}/.`, {
      answer: 'Completed the synthetic apply fixture.',
      mutate() {
        for (const task of tasks) {
          writeMarker(task);
          done.add(task.id);
        }
        writeFileSync(tasksPath, taskList(done));
      },
    });
  }

  const verify = async (tree: string) => {
    const passed = tasks.every(({ file }) => readFileSync(join(repo, file), 'utf8') === expected);
    await emit({ stage: 'verify' }, `Verify synthetic change ${feature} at tree ${tree}.`, {
      answer: `Checked both replay markers.\nVERIFY: ${passed ? 'PASS' : 'FAIL'}`,
      inspection: inspect(),
    });
    writeJson(join(archive, 'verify.json'), { tree, passed });
    return passed;
  };

  const reviewed = await runOptimizedReview(
    {
      mode: 'optimized',
      flags,
      repo,
      baseTree: opts.baseTree,
      archive: join(archive, 'review'),
      changeId: feature,
    },
    {
      snapshot,
      async context(tree) {
        const gatePath = join(archive, `gates-${tree}.json`);
        const ok = readFileSync(tasksPath, 'utf8') === taskList(done) && done.size === tasks.length;
        const summary = 'Checked the synthetic task inventory.';
        writeJson(gatePath, { tree, ok, summary });
        return {
          requirements,
          conventions: 'Replay fixtures only.',
          gates: { tree, ok, summary, fullPath: gatePath },
        };
      },
      async review(packet) {
        const blocker = {
          id: 'F-REPLAY-01',
          severity: 'blocking',
          req_ids: [primary.req],
          file: primary.file,
          line: 1,
          message: 'The primary marker is missing its expected text.',
        };
        const blocked = inspect() !== expected;
        const findings = blocked
          ? [{ ...blocker, status: 'open' }]
          : packet.openFindings.map((finding) => ({ ...finding, status: 'resolved' }));
        return emit({ stage: 'review', reviewIter: packet.iteration }, JSON.stringify(packet), {
          answer: JSON.stringify({
            change_id: feature,
            iteration: packet.iteration,
            scope: packet.scope,
            findings,
            verdict: blocked ? 'changes_requested' : 'approved',
          }),
          inspection: inspect(),
        });
      },
      async fix(packet) {
        await emit({ stage: 'fix', reviewIter: packet.iteration }, JSON.stringify(packet), {
          answer: 'Fixed the primary replay marker.',
          mutate: () => writeFileSync(primaryPath, expected),
        });
      },
      verify,
    },
  );
  if (!reviewed) {
    await emit({ stage: 'review', reviewIter: 1 }, `Review all of synthetic change ${feature}.`, {
      answer: 'Reviewed both replay markers.\nVERDICT: ACCEPT',
      inspection: inspect(),
    });
    if (!(await verify(await snapshot()))) throw new Error('Replay verification failed');
  }
}
