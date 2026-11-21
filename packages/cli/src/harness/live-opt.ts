import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { type BaselineOptions, executeNativePipeline } from '../baseline.js';
import { markdownLines } from '../capsule.js';
import { runTaskSessions } from '../task-sessions.js';
import { writeJson } from './io.js';

interface LiveOptOptions extends BaselineOptions {
  flags: Record<string, unknown>;
  maxRetries: number;
  checkTask: (id: string, attempt: number) => Promise<{ passed: boolean; summary: string }>;
  taskInstructions?: (id: string) => string;
}

export function validateLiveOptFlags(flags: Record<string, unknown>) {
  for (const [name, value] of Object.entries(flags)) {
    if (value === false) continue;
    if (!['session_per_task', 'capsule'].includes(name) || value !== true)
      throw new Error(`Unsupported live optimization: ${name}=${String(value)}`);
  }
  if (flags.session_per_task !== true && flags.capsule !== true)
    throw new Error('Live optimized apply requires session_per_task or capsule');
}

export async function executeLiveOptimized(
  opts: LiveOptOptions,
): ReturnType<typeof executeNativePipeline> {
  validateLiveOptFlags(opts.flags);
  if (typeof opts.snapshot !== 'function' || typeof opts.checkTask !== 'function')
    throw new Error('Live optimized apply requires Git snapshots and a public per-task test gate');
  if (!Number.isSafeInteger(opts.maxRetries) || opts.maxRetries < 0)
    throw new Error('Invalid live task retry limit');
  const flags = {
    session_per_task: opts.flags.session_per_task === true,
    capsule: opts.flags.capsule === true,
  };
  return executeNativePipeline(opts, {
    flags,
    async run(apply) {
      // In a fresh live arm every task must pass its own gate. A proposal that
      // already marks work complete cannot be used to skip apply or public tests.
      const inventory = join(realpathSync(opts.repo), 'openspec/changes', opts.feature, 'tasks.md');
      if (realpathSync(inventory) !== inventory) throw new Error('Symlink in live task inventory');
      if (
        markdownLines(readFileSync(inventory, 'utf8')).some(
          (line) => !line.literal && /^\s*[-*+]\s+\[[xX]\]\s+/.test(line.text),
        )
      )
        throw new Error('Live task inventory already contains completed work');

      let attempt = 0;
      await runTaskSessions(
        {
          repo: opts.repo,
          changeId: opts.feature,
          sessionPerTask: flags.session_per_task,
          capsule: flags.capsule,
          maxRetries: opts.maxRetries,
        },
        {
          apply(input) {
            attempt = input.attempt;
            const instructions = opts.taskInstructions?.(input.taskId);
            return apply(
              instructions ? { ...input, prompt: `${input.prompt}\n\n${instructions}` } : input,
            );
          },
          async checkTask(id) {
            const gate = await opts.checkTask(id, attempt);
            if (
              typeof gate.passed !== 'boolean' ||
              typeof gate.summary !== 'string' ||
              !gate.summary.trim()
            )
              throw new Error(`Missing task gate result: ${id} attempt ${attempt}`);
            writeJson(join(opts.runDir, 'opt', 'task-gates', `${id}-attempt-${attempt}.json`), {
              task: id,
              attempt,
              passed: gate.passed,
              summary: gate.summary,
            });
            return gate;
          },
        },
      );
    },
  });
}
