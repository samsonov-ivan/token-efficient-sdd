import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { type FixPacket, type ReviewPacket, runOptimizedReview } from '../src/review.js';

const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const blocking = {
  id: 'F-1',
  status: 'open',
  severity: 'blocking',
  req_ids: ['REQ-API-01'],
  file: 'api.txt',
  line: 1,
  message: 'Missing validation',
};
const requirement = {
  id: 'REQ-API-01',
  path: 'spec.md',
  scenarios: ['SCN-API-01.1'],
  statement: 'Reject invalid input.',
};
function response(p: ReviewPacket, findings: unknown[] = [], verdict = 'approved') {
  return JSON.stringify({
    change_id: p.change_id,
    iteration: p.iteration,
    scope: p.scope,
    findings,
    verdict,
  });
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'frugal-review-'));
  roots.push(root);
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  const writeAPI = (head: string, tail: string) =>
    writeFileSync(
      join(repo, 'api.txt'),
      [head, ...Array.from({ length: 25 }, (_, i) => String(i)), tail, ''].join('\n'),
    );
  writeAPI('initial', 'old tail');
  const snapshot = async () => {
    git('add', '-A');
    return git('write-tree');
  };
  git('add', '-A');
  const baseTree = git('write-tree');
  writeAPI('needs fix', 'unrelated tail');
  writeFileSync(join(repo, 'another.txt'), 'untouched by fix\n');
  const gates = join(root, 'gates.json');
  const options = {
    mode: 'optimized' as const,
    flags: { incremental_review: true, checklist_review: true, targeted_fix: true },
    repo,
    baseTree,
    archive: join(root, 'review'),
    changeId: 'fixture',
  };
  let fixes = 0;
  const driver = {
    snapshot,
    context: async (tree: string) => {
      writeFileSync(gates, JSON.stringify({ tree, ok: true }));
      return {
        requirements: [requirement],
        conventions: 'Use explicit errors.',
        gates: { summary: 'Passed all public tests', fullPath: gates, ok: true, tree },
      };
    },
    review: vi.fn(async (p: ReviewPacket) => response(p)),
    fix: vi.fn(async (_p: FixPacket) => {
      fixes++;
      writeAPI(fixes === 1 ? 'fixed' : `fixed revision ${fixes}`, 'unrelated tail');
    }),
    verify: vi.fn(async (_tree: string) => true),
  };
  return { options, driver, writeAPI };
}

it('passes a full checklist, carries a blocker over an omitted update, sends targeted hunks, then verifies the full snapshot', async () => {
  const { options, driver } = fixture();
  driver.review.mockImplementation(async (p) => {
    if (p.iteration === 1) return response(p, [blocking], 'changes_requested');
    if (p.iteration === 2) return response(p, [], 'changes_requested');
    if (p.iteration === 3) return response(p, [{ ...blocking, status: 'resolved' }]);
    return response(p);
  });
  const result = await runOptimizedReview(options, driver);
  const packets = driver.review.mock.calls.map(([p]) => p);
  expect(packets.map((p) => [p.scope, p.final])).toEqual([
    ['full', false],
    ['delta', false],
    ['delta', false],
    ['full', true],
  ]);
  expect(packets[0].checklist?.[0].requirement).toEqual(requirement);
  expect(packets[0].outputSchema).toHaveProperty('properties.findings');
  expect(packets[1].diff).toContain('+fixed');
  expect(packets[1].diff).not.toContain('another.txt');
  expect(readFileSync(packets[1].fullPatch, 'utf8')).toContain('another.txt');
  expect(packets[2].openFindings).toEqual([blocking]);
  expect(packets[3].closedFindingIds).toEqual(['F-1']);
  expect(packets[3].diff).toContain('another.txt');
  const fix = driver.fix.mock.calls[0][0];
  expect(fix.scope).toBe('hunks');
  expect(fix.diff).toContain('+needs fix');
  expect(fix.diff).not.toContain('unrelated tail');
  expect(fix.diff).not.toContain('another.txt');
  expect(fix.gates.summary).toContain('Passed');
  expect(driver.verify).toHaveBeenCalledWith(result?.tree);
  const retained = JSON.parse(readFileSync(join(options.archive, 'round-2/findings.json'), 'utf8'));
  expect(retained.findings).toEqual([blocking]);
});

it('uses a full patch if the previous tree becomes unavailable and keeps the blocker', async () => {
  const { options, driver, writeAPI } = fixture();
  driver.review.mockImplementation(async (p) => {
    if (p.iteration === 1) return response(p, [blocking], 'changes_requested');
    expect(p.scope).toBe('full');
    if (p.iteration === 2) {
      expect(p.fallback).toMatch(/previous snapshot/i);
      expect(p.diff).toContain('another.txt');
      expect(p.openFindings).toEqual([blocking]);
      return response(p, [{ ...blocking, status: 'closed' }]);
    }
    return response(p);
  });
  driver.fix.mockImplementation(async (p) => {
    writeAPI('fixed', 'unrelated tail');
    rmSync(join(options.repo, '.git/objects', p.tree.slice(0, 2), p.tree.slice(2)));
  });
  await runOptimizedReview(options, driver);
  expect(driver.verify).toHaveBeenCalledOnce();
});

it.each([
  ['a non-JSON transcript', () => 'LGTM', /JSON|Unexpected/],
  ['a malformed finding', (p: ReviewPacket) => response(p, [{ id: 'broken' }]), /Invalid findings/],
  ['a stale round', (p: ReviewPacket) => response({ ...p, iteration: 4 }), /Stale/],
  ['a duplicate ID', (p: ReviewPacket) => response(p, [blocking, blocking]), /Duplicate/],
])('rejects %s and retains the raw response', async (_name, reply, message) => {
  const { options, driver } = fixture();
  driver.review.mockImplementation(async (p) => reply(p));
  await expect(runOptimizedReview(options, driver)).rejects.toThrow(message);
  expect(readFileSync(join(options.archive, 'round-1/review-output.txt'), 'utf8')).toBeTruthy();
  expect(driver.verify).not.toHaveBeenCalled();
});

it('rejects approval with an unresolved omitted blocker', async () => {
  const { options, driver } = fixture();
  driver.review.mockImplementation(async (p) =>
    p.iteration === 1 ? response(p, [blocking], 'changes_requested') : response(p),
  );
  await expect(runOptimizedReview(options, driver)).rejects.toThrow(/disagrees/);
  expect(driver.verify).not.toHaveBeenCalled();
});

it.each(['open', 'resolved'] as const)(
  'rejects a downgrade to minor when the blocker was %s',
  async (status) => {
    const { options, driver } = fixture();
    driver.review.mockImplementation(async (p) => {
      if (p.iteration === 1) return response(p, [blocking], 'changes_requested');
      if (p.iteration === 2 && status === 'resolved') return response(p, [{ ...blocking, status }]);
      return response(p, [{ ...blocking, severity: 'minor' }]);
    });
    await expect(runOptimizedReview(options, driver)).rejects.toThrow(/cannot downgrade/i);
    expect(driver.verify).not.toHaveBeenCalled();
  },
);

it('keeps the same blocker open when it recurs during full sanity, then verifies after its fix', async () => {
  const { options, driver } = fixture();
  driver.review.mockImplementation(async (p) => {
    if (p.iteration === 1 || p.iteration === 3) return response(p, [blocking], 'changes_requested');
    if (p.iteration === 2 || p.iteration === 4)
      return response(p, [{ ...blocking, status: 'resolved' }]);
    return response(p);
  });
  const result = await runOptimizedReview(options, driver);
  expect(driver.review.mock.calls.map(([p]) => [p.scope, p.final])).toEqual([
    ['full', false],
    ['delta', false],
    ['full', true],
    ['delta', false],
    ['full', true],
  ]);
  expect(driver.fix.mock.calls[1][0].openFindings).toEqual([blocking]);
  expect(driver.verify).toHaveBeenCalledExactlyOnceWith(result?.tree);
});

it('rejects a no-op fix before asking the reviewer to resolve a blocker', async () => {
  const { options, driver } = fixture();
  driver.review.mockImplementation(async (p) => response(p, [blocking], 'changes_requested'));
  driver.fix.mockResolvedValue(undefined);
  await expect(runOptimizedReview(options, driver)).rejects.toThrow(/fix did not change/i);
  expect(driver.review).toHaveBeenCalledOnce();
  expect(driver.verify).not.toHaveBeenCalled();
});

it('retains full context with independent flags disabled and falls back for an unlocated blocker', async () => {
  const { options, driver } = fixture();
  options.flags.checklist_review = false;
  options.flags.incremental_review = false;
  driver.review.mockImplementation(async (p) => {
    expect(p.outputSchema).toBeUndefined();
    expect(p.checklist).toBeUndefined();
    expect(p.scope).toBe('full');
    if (p.iteration === 1) return response(p, [{ ...blocking, line: 999 }], 'changes_requested');
    return response(p, [{ ...blocking, status: 'closed' }]);
  });
  await runOptimizedReview(options, driver);
  const packet = driver.fix.mock.calls[0][0];
  expect(packet.scope).toBe('full');
  expect(packet.diff).toContain('another.txt');
});

it('preserves full fix input when targeted_fix is disabled', async () => {
  const { options, driver } = fixture();
  options.flags.targeted_fix = false;
  driver.review.mockImplementation(async (p) =>
    p.iteration === 1
      ? response(p, [blocking], 'changes_requested')
      : response(p, [{ ...blocking, status: 'closed' }]),
  );
  await runOptimizedReview(options, driver);
  expect(driver.fix.mock.calls[0][0].scope).toBe('full');
});

it('verifies after the final full round at the limit and rejects remaining blockers', async () => {
  const { options, driver } = fixture();
  driver.review.mockImplementation(async (p) => response(p, [blocking], 'changes_requested'));
  await expect(runOptimizedReview(options, driver)).rejects.toThrow(/exhausted/);
  expect(driver.review.mock.calls.map(([p]) => p.scope)).toEqual([
    'full',
    'delta',
    'delta',
    'delta',
    'full',
  ]);
  expect(driver.verify).toHaveBeenCalledOnce();
});

it('reopens fixes after a final full check detects a cross-file regression', async () => {
  const { options, driver } = fixture();
  driver.review.mockImplementation(async (p) => {
    if (p.iteration === 2) return response(p, [blocking], 'changes_requested');
    if (p.iteration === 3) return response(p, [{ ...blocking, status: 'closed' }]);
    return response(p);
  });
  driver.verify.mockResolvedValue(false);
  await expect(runOptimizedReview(options, driver)).rejects.toThrow(/Verification failed/);
  expect(driver.review.mock.calls.map(([p]) => p.final)).toEqual([false, true, false, true]);
});

it('leaves baseline and a disabled optimized arm to their normal entry points', async () => {
  const { options, driver } = fixture();
  await expect(
    runOptimizedReview({ ...options, mode: 'baseline' }, driver),
  ).resolves.toBeUndefined();
  await expect(runOptimizedReview({ ...options, flags: {} }, driver)).resolves.toBeUndefined();
  expect(driver.review).not.toHaveBeenCalled();
});

it.each(['review', 'verify'] as const)(
  'rejects a mutation of the inspected tree during %s',
  async (stage) => {
    const { options, driver, writeAPI } = fixture();
    if (stage === 'review')
      driver.review.mockImplementation(async (p) => {
        writeAPI('modified', 'unexpected');
        return response(p);
      });
    else
      driver.verify.mockImplementation(async () => {
        writeAPI('modified', 'unexpected');
        return true;
      });
    await expect(runOptimizedReview(options, driver)).rejects.toThrow(/modified its snapshot/);
  },
);

it.each(['red', 'stale', 'missing'] as const)(
  'requires fresh green evidence before review when the gate is %s',
  async (invalid) => {
    const { options, driver } = fixture();
    const context = driver.context;
    driver.context = async (tree) => {
      const input = await context(tree);
      if (invalid === 'red') input.gates.ok = false;
      if (invalid === 'stale') input.gates.tree = options.baseTree;
      if (invalid === 'missing') input.gates.fullPath += '.missing';
      return input;
    };
    await expect(runOptimizedReview(options, driver)).rejects.toThrow(/gates|gate evidence/);
    expect(driver.review).not.toHaveBeenCalled();
    expect(driver.verify).not.toHaveBeenCalled();
  },
);

it('reruns gates after a fix and stops when they report the previous snapshot', async () => {
  const { options, driver } = fixture();
  const input = await driver.context(await driver.snapshot());
  const context = vi.fn(async (_tree: string) => input);
  driver.context = context;
  driver.review.mockImplementation(async (p) => response(p, [blocking], 'changes_requested'));
  await expect(runOptimizedReview(options, driver)).rejects.toThrow(/green gates/);
  expect(context).toHaveBeenCalledTimes(2);
  expect(context.mock.calls[1][0]).not.toBe(context.mock.calls[0][0]);
  expect(driver.review).toHaveBeenCalledOnce();
});

it('rejects a worktree mutation while preparing deterministic gates', async () => {
  const { options, driver, writeAPI } = fixture();
  const context = driver.context;
  driver.context = async (tree) => {
    const input = await context(tree);
    writeAPI('mutated by gates', 'unrelated tail');
    return input;
  };
  await expect(runOptimizedReview(options, driver)).rejects.toThrow(/context modified/);
  expect(driver.review).not.toHaveBeenCalled();
});

it('fails closed when the checklist has no source requirements', async () => {
  const { options, driver } = fixture();
  await expect(
    runOptimizedReview(options, {
      ...driver,
      context: async (tree) => ({
        ...(await driver.context(tree)),
        requirements: [],
      }),
    }),
  ).rejects.toThrow(/No specification requirements/);
  expect(driver.review).not.toHaveBeenCalled();
});
