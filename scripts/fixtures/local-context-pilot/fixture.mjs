import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Source and MIT license copied verbatim from sindresorhus/yocto-queue,
// commit 72a8fa96a9d389765cdf2bb9c6daba8302fc375d (index.js → queue.mjs).
export async function prepare(repo) {
  await mkdir(repo, { recursive: true });
  for (const name of ['queue.mjs', 'LICENSE']) {
    await copyFile(
      new URL(`./repo/${name}`, import.meta.url),
      join(repo, name),
      constants.COPYFILE_EXCL,
    );
  }
}

export const brief = [
  'Extend the default Queue class in queue.mjs. Preserve its public FIFO API, size, iteration, clear() and drain().',
  '1. dequeueIf(predicate) returns false without calling the predicate on an empty queue. Otherwise call predicate once on the head value, even when it is undefined. On a truthy result, remove that head and return true. On a falsy result leave the queue unchanged and return false. A thrown error propagates without removing the head.',
  '2. drainWhile(predicate) removes the longest matching prefix and returns the count removed (zero for an empty queue). Repeatedly call this.dequeueIf(predicate) until it returns false; keep the first rejected item and everything after it. A thrown error propagates; earlier removals stand.',
].join('\n');

export const handoff =
  'Task 2 uses the public Queue.prototype.dequeueIf(predicate) contract from task 1. Read queue.mjs to see the implementation currently in this checkout.';

export function promptForTask(_repo, taskNumber) {
  if (taskNumber !== 1 && taskNumber !== 2) throw new RangeError('Expected task 1 or 2');
  const task =
    taskNumber === 1
      ? 'Implement only task 1. Add dequeueIf to Queue. Leave task 2 for the next turn.'
      : 'Implement only task 2. Add drainWhile to Queue using its existing dequeueIf method.';
  return [
    brief,
    ...(taskNumber === 2 ? [handoff] : []),
    task,
    'Read queue.mjs, then edit only queue.mjs. No shell or extra files. Briefly report what changed.',
  ].join('\n\n');
}

function queueOf(Queue, ...values) {
  const q = new Queue();
  for (const value of values) q.enqueue(value);
  return q;
}

const checks = [
  [
    'api',
    'fifo',
    (Q) => {
      const ref = {};
      const q = queueOf(Q, undefined, ref, 0);
      assert.equal(q.size, 3);
      assert.equal(q.peek(), undefined);
      assert.equal(q.dequeue(), undefined);
      assert.equal(q.peek(), ref);
      assert.deepEqual([...q], [ref, 0]);
      assert.equal(q.size, 2);
    },
  ],
  [
    'api',
    'clear-and-drain',
    (Q) => {
      const q = queueOf(Q, 9);
      q.clear();
      assert.equal(q.size, 0);
      assert.equal(q.dequeue(), undefined);
      q.enqueue(false);
      q.enqueue(1);
      assert.deepEqual([...q.drain()], [false, 1]);
      assert.equal(q.size, 0);
    },
  ],
  [
    'task1',
    'empty',
    (Q) => {
      const q = queueOf(Q);
      assert.equal(
        q.dequeueIf(() => assert.fail('predicate called on empty queue')),
        false,
      );
      assert.equal(q.size, 0);
    },
  ],
  [
    'task1',
    'reject-head',
    (Q) => {
      const q = queueOf(Q, 3, 8);
      const visited = [];
      assert.equal(
        q.dequeueIf((x) => {
          visited.push(x);
          return 0;
        }),
        false,
      );
      assert.deepEqual(visited, [3]);
      assert.deepEqual([...q], [3, 8]);
      assert.equal(q.size, 2);
    },
  ],
  [
    'task1',
    'consume-undefined',
    (Q) => {
      const q = queueOf(Q, undefined, 7);
      const visited = [];
      assert.equal(
        q.dequeueIf((x) => {
          visited.push(x);
          return 'yes';
        }),
        true,
      );
      assert.deepEqual(visited, [undefined]);
      assert.deepEqual([...q], [7]);
      assert.equal(q.size, 1);
    },
  ],
  [
    'task1',
    'predicate-error',
    (Q) => {
      const q = queueOf(Q, 12, 13);
      const error = new Error('predicate');
      assert.throws(
        () =>
          q.dequeueIf(() => {
            throw error;
          }),
        (e) => e === error,
      );
      assert.deepEqual([...q], [12, 13]);
      assert.equal(q.size, 2);
    },
  ],
  [
    'task2',
    'matching-prefix',
    (Q) => {
      const q = queueOf(Q, 2, 4, 7, 8);
      const visited = [];
      assert.equal(
        q.drainWhile((x) => {
          visited.push(x);
          return x % 2 === 0;
        }),
        2,
      );
      assert.deepEqual(visited, [2, 4, 7]);
      assert.deepEqual([...q], [7, 8]);
      assert.equal(q.size, 2);
    },
  ],
  [
    'task2',
    'all-then-empty',
    (Q) => {
      const q = queueOf(Q, undefined, false, 0);
      assert.equal(
        q.drainWhile(() => true),
        3,
      );
      assert.equal(
        q.drainWhile(() => assert.fail('predicate called on empty queue')),
        0,
      );
      assert.equal(q.size, 0);
    },
  ],
  [
    'task2',
    'delegate-to-public-method',
    (Q) => {
      const q = queueOf(Q, 4, 7);
      const dequeueIf = q.dequeueIf;
      const predicate = (x) => x < 5;
      let calls = 0;
      q.dequeueIf = (p) => {
        assert.equal(p, predicate);
        calls++;
        return dequeueIf.call(q, p);
      };
      assert.equal(q.drainWhile(predicate), 1);
      assert.equal(calls, 2);
      assert.deepEqual([...q], [7]);
    },
  ],
  [
    'task2',
    'error-after-one-removal',
    (Q) => {
      const q = queueOf(Q, 2, 3, 5);
      const error = new Error('predicate');
      assert.throws(
        () =>
          q.drainWhile((x) => {
            if (x === 3) throw error;
            return true;
          }),
        (e) => e === error,
      );
      assert.deepEqual([...q], [3, 5]);
      assert.equal(q.size, 2);
    },
  ],
];

// The caller runs this evaluator in its isolated, time-limited subprocess.
export async function evaluate(repo) {
  const result = {
    api: { passed: 0, total: 0 },
    task1: { passed: 0, total: 0 },
    task2: { passed: 0, total: 0 },
    cases: [],
  };
  let Queue;
  try {
    const source = join(repo, 'queue.mjs');
    assert((await lstat(source)).isFile());
    const url = pathToFileURL(source);
    url.searchParams.set(
      'sha256',
      createHash('sha256')
        .update(await readFile(source))
        .digest('hex'),
    );
    Queue = (await import(url.href)).default;
  } catch {
    // A broken or missing module fails all cases, preserving denominators.
  }
  for (const [group, id, check] of checks) {
    let passed = false;
    try {
      check(Queue);
      passed = true;
    } catch {
      // Keep evaluating the other independent examples after a failure.
    }
    result[group].total++;
    if (passed) result[group].passed++;
    result.cases.push({ id, group, passed });
  }
  return result;
}
