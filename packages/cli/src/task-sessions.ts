import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { buildCapsule, markdownLines } from './capsule.js';

interface TaskSessionOptions {
  repo: string;
  changeId: string;
  sessionPerTask: boolean;
  capsule: boolean;
  maxRetries: number;
}

export interface TaskApplyInput {
  taskId: string;
  attempt: number;
  prompt: string;
  sessionId?: string;
}

interface TaskCallbacks {
  apply(input: TaskApplyInput): Promise<{ sessionId: string; handoff: string }>;
  checkTask(taskId: string): Promise<{ passed: boolean; summary: string }>;
}

function inventory(source: string) {
  const ids = new Set<string>();
  const tasks = markdownLines(source).flatMap((line) => {
    const match = !line.literal && /^(\s*[-*+]\s+\[)([ xX])\]\s+(.*)$/.exec(line.text);
    if (!match) return [];
    const id = /^(\d+(?:\.\d+)+)\b/.exec(match[3])?.[1];
    if (!id) throw new Error(`Missing task ID in tasks.md: ${line.text}`);
    if (ids.has(id)) throw new Error(`Duplicate task ${id} in tasks.md`);
    ids.add(id);
    return [{ id, mark: match[2], offset: line.start + match[1].length, text: line.text }];
  });
  if (!tasks.length) throw new Error('No numbered tasks in tasks.md');
  return tasks;
}

function replaceMark(text: string, offset: number, mark: string) {
  return text.slice(0, offset) + mark + text.slice(offset + 1);
}

// The model runs in this working directory between reads. Recheck the directory
// and file type each time before trusting or publishing an artifact.
function fileStat(path: string) {
  if (realpathSync(dirname(path)) !== dirname(path))
    throw new Error(`Symlink in task artifact path: ${path}`);
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat && !stat.isFile()) throw new Error(`Expected regular task artifact: ${path}`);
  return stat;
}
function readArtifact(path: string) {
  return fileStat(path) ? readFileSync(path, 'utf8') : undefined;
}
function storeArtifact(path: string, text: string | undefined) {
  const stat = fileStat(path);
  if (text === undefined) {
    if (stat) rmSync(path);
    return;
  }
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, text, { flag: 'wx', mode: stat?.mode ?? 0o600 });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

function acceptedHandoff(original: string | undefined, taskId: string, handoff: string) {
  const lines = handoff.trim().split(/\r?\n/);
  if (
    lines.length < 3 ||
    lines.length > 7 ||
    lines.some((line) => !line.trim() || /^## TASK-\d/.test(line))
  )
    throw new Error(`Task ${taskId} requires 3–7 nonempty handoff lines`);
  const title = `## TASK-${taskId}`;
  const section = `${title}\n\n${lines.join('\n')}\n`;
  const previous = original ?? '';
  const headings = markdownLines(previous).filter(
    (line) => !line.literal && /^## TASK-\d+(?:\.\d+)+$/.test(line.text),
  );
  const index = headings.findIndex((line) => line.text === title);
  // A stopped run can already have published this handoff before it checked
  // the task. Replacing its section makes the second publication idempotent.
  if (index !== -1)
    return (
      previous.slice(0, headings[index].start) +
      section +
      (headings[index + 1] ? `\n${previous.slice(headings[index + 1].start)}` : '')
    );
  return (previous ? previous + (previous.endsWith('\n') ? '\n' : '\n\n') : '') + section;
}

export async function runTaskSessions(
  opts: TaskSessionOptions,
  callbacks: TaskCallbacks,
): Promise<boolean> {
  if (!opts.sessionPerTask && !opts.capsule) return false;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(opts.changeId))
    throw new Error(`Invalid change ID: ${opts.changeId}`);
  if (!Number.isSafeInteger(opts.maxRetries) || opts.maxRetries < 0)
    throw new Error('Invalid maxRetries');
  const dir = `openspec/changes/${opts.changeId}`;
  const root = realpathSync(opts.repo);
  const tasksPath = join(root, dir, 'tasks.md');
  const handoffPath = join(root, dir, 'handoff.md');
  const initial = readArtifact(tasksPath);
  if (initial === undefined) throw new Error(`Missing ${dir}/tasks.md`);
  let accepted = initial;
  const tasks = inventory(accepted);
  let handoff = opts.sessionPerTask ? readArtifact(handoffPath) : undefined;
  let sharedSession: string | undefined;
  const sessions = new Set<string>();

  // opencode may check boxes itself. Its edits cannot confirm this or any later
  // task. Restore the accepted checkboxes before the independent gate runs.
  const restore = () => {
    if (opts.sessionPerTask && readArtifact(handoffPath) !== handoff)
      storeArtifact(handoffPath, handoff);
    const current = readArtifact(tasksPath);
    if (current === accepted) return;
    // Stage S4 owns the task definitions. An interrupted or invalid model
    // edit must not become the input inventory of the next invocation.
    storeArtifact(tasksPath, accepted);
    if (current === undefined) throw new Error(`Task inventory disappeared: ${dir}/tasks.md`);
    let corrected = current;
    for (const { offset } of tasks) {
      if (/[ xX]/.test(current.charAt(offset)))
        corrected = replaceMark(corrected, offset, accepted.charAt(offset));
    }
    if (corrected !== accepted)
      throw new Error(`Task inventory changed during apply: ${dir}/tasks.md`);
  };

  for (const task of tasks) {
    if (task.mark !== ' ') continue;
    let sessionId = opts.sessionPerTask ? undefined : sharedSession;
    let prompt = opts.capsule
      ? buildCapsule(root, opts.changeId, task.id, { enabled: true })
      : [
          `Implement only task ${task.id}: ${task.text}`,
          `Read the full change in ${dir}/, including proposal, specs, design and tasks.md.`,
          `Previous handoff (${dir}/handoff.md):\n${handoff ?? 'No handoff has been recorded.'}`,
        ].join('\n\n');
    for (let attempt = 1; ; attempt++) {
      let result: Awaited<ReturnType<TaskCallbacks['apply']>>;
      try {
        const instruction = opts.sessionPerTask
          ? `${prompt}\n\nImplement only task ${task.id}. Return a 3–7 line handoff describing the implementation, public interfaces and tests. The orchestrator records task completion.`
          : prompt;
        result = await callbacks.apply({
          taskId: task.id,
          prompt: instruction,
          sessionId,
          attempt,
        });
      } finally {
        restore();
      }
      if (
        typeof result.sessionId !== 'string' ||
        !result.sessionId ||
        /[\s\p{Cc}]/u.test(result.sessionId) ||
        (sessionId ? result.sessionId !== sessionId : sessions.has(result.sessionId))
      )
        throw new Error(`Unexpected session ID for task ${task.id}, attempt ${attempt}`);
      sessionId = result.sessionId;
      sessions.add(sessionId);
      if (!opts.sessionPerTask) sharedSession = sessionId;
      let gate: Awaited<ReturnType<TaskCallbacks['checkTask']>>;
      try {
        gate = await callbacks.checkTask(task.id);
      } finally {
        restore();
      }
      if (gate.passed === true) {
        if (opts.sessionPerTask) {
          const next = acceptedHandoff(handoff, task.id, result.handoff);
          storeArtifact(handoffPath, next);
          handoff = next;
        }
        accepted = replaceMark(accepted, task.offset, 'x');
        storeArtifact(tasksPath, accepted);
        break;
      }
      if (attempt > opts.maxRetries)
        throw new Error(
          `Task ${task.id} failed its gate after ${attempt} attempt(s): ${gate.summary}`,
        );
      prompt = `Fix task ${task.id} in ${dir}/. Its gate failed:\n\n${gate.summary}`;
    }
  }
  return true;
}
