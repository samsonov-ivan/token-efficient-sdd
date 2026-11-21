import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compress } from '../src/compression.js';
import plugin from '../src/index.js';

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}.txt`, import.meta.url), 'utf8');
let root: string;
const pytest = fixture('pytest');
const vitest = fixture('vitest');
const diff = fixture('git-diff');
const flagOn = 'version: 1\nflags: {tool_output_compression: true}\n';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'frugal-compression-'));
  vi.stubEnv('FRUGAL_TOOL_OUTPUT_COMPRESSION', undefined);
  vi.stubEnv('FRUGAL_USAGE_CORRELATION', undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function checkArchive(short: string, raw: string) {
  const relative = short.split('Full output (project root): ').at(-1);
  const digest = createHash('sha256').update(raw).digest('hex');
  expect(relative).toBe(`.frugal/logs/${digest}.log`);
  expect(readFileSync(join(root, relative ?? ''))).toEqual(Buffer.from(raw));
  expect(statSync(join(root, '.frugal')).mode & 0o777).toBe(0o700);
  expect(statSync(join(root, '.frugal/logs')).mode & 0o777).toBe(0o700);
  expect(statSync(join(root, '.frugal/logs/.gitignore')).mode & 0o777).toBe(0o600);
  expect(statSync(join(root, relative ?? '')).mode & 0o777).toBe(0o600);
  expect(Buffer.byteLength(short)).toBeLessThan(Buffer.byteLength(raw));
}

describe('conservative compression of public runner output', () => {
  it('keeps both pytest failures, their complete tracebacks and the multiline warning', () => {
    const raw = pytest.replaceAll('\n', '\r\n');
    const short = compress(root, 'python -m pytest -v', raw, 1);
    checkArchive(short, raw);
    expect(short).toContain(raw.slice(raw.indexOf('test_contract.py::test_first FAILED')));
    expect(short).toContain('Exit code: 1');
    expect(compress(root, 'pytest -v', raw, 1)).toBe(short);
  });

  it('keeps all Vitest mismatch details including an interleaved multiline diagnostic', () => {
    const detail = 'warning: deprecated input\n ✓ diagnostic payload 3ms\ncontinuation π\n';
    const raw = vitest.replace(' × contract.test.js', `${detail} × contract.test.js`);
    const short = compress(root, 'npx --no-install vitest run', raw, 1);
    checkArchive(short, raw);
    expect(short).toContain(raw.slice(raw.indexOf(detail)));
  });

  it('summarizes successful pytest and Vitest results, retaining colored original bytes', () => {
    const raw = `${Array.from(
      { length: 24 },
      (_, i) => `suite/test_a.py::test_case[${i}] PASSED [100%]`,
    ).join('\n')}\n24 passed in 1.00s`.replaceAll('PASSED', '\x1b[32mPASSED\x1b[0m');
    const short = compress(root, 'pytest', raw, 0);
    checkArchive(short, raw);
    expect(short).toContain('24 passed in 1.00s');
    const successful =
      vitest.slice(0, vitest.indexOf(' × contract.test.js')) +
      ' Test Files  1 passed (1)\n      Tests  12 passed (12)\n';
    checkArchive(compress(root, 'npm test', successful, 0), successful);
  });

  it('preserves changed lines, surrounding context and diagnostic hunks in a git diff', () => {
    const diag =
      '@@ -90,4 +90,4 @@\n def verify():\n     assert (\n-      actual\n+      expected\n     )\n';
    const raw = diff + diag;
    const short = compress(root, 'git diff -U12', raw, 0);
    checkArchive(short, raw);
    expect(short).toContain(diag);
    expect(short).toContain(
      '-The retained context for input item 9.\n+The retained context for corrected item 9.',
    );
    expect(short).toContain('unchanged context lines omitted');
  });

  it.each(['status', 'log'])(
    'bounds long git %s lists without hiding conflicts or diagnostics',
    (kind) => {
      const row = (i: number) =>
        kind === 'status'
          ? ` M src/long-path-to-change-${i}.ts`
          : `abc1234 Describe the tracked change number ${i}`;
      const rows = Array.from({ length: 32 }, (_, i) => row(i));
      const raw = `${rows.join('\n')}\n`;
      checkArchive(compress(root, `git ${kind}`, raw, 0), raw);
      for (const special of [
        'warning: diagnostic',
        'UU conflicted.txt',
        'AA new.ts',
        'DD old.ts',
      ]) {
        const unsafe = [...rows.slice(0, 16), special, ...rows.slice(16)].join('\n');
        expect(compress(root, `git ${kind}`, unsafe, 1)).toBe(unsafe);
      }
    },
  );

  it('returns unknown formats, compound commands, truncated hunks and short output verbatim', () => {
    for (const [command, raw] of [
      ['pytest', `a custom reporter\n${'data\n'.repeat(100)}`],
      ['pytest', vitest],
      ['cat results', pytest],
      ['pytest && echo details', pytest],
      ['pytest', '1 passed in 1.00s\n'],
      ['git diff', diff.slice(0, diff.indexOf('+The retained context'))],
    ])
      expect(compress(root, command, raw, 0)).toBe(raw);
    expect(existsSync(join(root, '.frugal'))).toBe(false);
  });

  it('preserves the original on archive failure or a conflicting existing log', () => {
    const dir = join(root, '.frugal');
    writeFileSync(dir, 'already a file');
    expect(compress(root, 'pytest', pytest, 1)).toBe(pytest);
    rmSync(dir);
    mkdirSync(join(dir, 'logs'), { recursive: true, mode: 0o700 });
    const hash = createHash('sha256').update(pytest).digest('hex');
    writeFileSync(join(dir, 'logs', `${hash}.log`), 'other bytes', { mode: 0o600 });
    expect(compress(root, 'pytest', pytest, 1)).toBe(pytest);
    expect(readFileSync(join(dir, 'logs', `${hash}.log`), 'utf8')).toBe('other bytes');
    expect(readdirSync(join(dir, 'logs')).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('keeps full logs out of a clean Git snapshot and respects pre-existing ignore rules', () => {
    execFileSync('git', ['init', '-q', root]);
    const logs = join(root, '.frugal/logs');
    mkdirSync(logs, { recursive: true, mode: 0o700 });
    writeFileSync(join(logs, '.gitignore'), 'custom.rule\n', { mode: 0o600 });
    expect(compress(root, 'pytest', pytest, 1)).toBe(pytest);
    expect(readFileSync(join(logs, '.gitignore'), 'utf8')).toBe('custom.rule\n');
    rmSync(join(logs, '.gitignore'));
    checkArchive(compress(root, 'pytest', pytest, 1), pytest);
    expect(
      execFileSync('git', ['-C', root, 'status', '--porcelain', '--untracked-files=all'], {
        encoding: 'utf8',
      }),
    ).toBe('');
  });

  it('does not write through a symlinked archive directory', () => {
    const other = join(root, 'untouched');
    mkdirSync(other);
    symlinkSync(other, join(root, '.frugal'));
    expect(compress(root, 'pytest', pytest, 1)).toBe(pytest);
    expect(readdirSync(other)).toEqual([]);
  });

  it('leaves the output intact for existing archive directories or ignore files with public permissions', () => {
    const archiveRoot = join(root, '.frugal');
    const logs = join(archiveRoot, 'logs');
    mkdirSync(logs, { recursive: true, mode: 0o700 });
    chmodSync(archiveRoot, 0o755);
    expect(compress(root, 'pytest', pytest, 1)).toBe(pytest);
    chmodSync(archiveRoot, 0o700);
    chmodSync(logs, 0o755);
    expect(compress(root, 'pytest', pytest, 1)).toBe(pytest);
    expect(readdirSync(logs)).toEqual([]);

    chmodSync(logs, 0o700);
    const ignore = join(logs, '.gitignore');
    writeFileSync(ignore, '*\n', { mode: 0o644 });
    chmodSync(ignore, 0o644);
    expect(compress(root, 'pytest', pytest, 1)).toBe(pytest);
    expect(readdirSync(logs)).toEqual(['.gitignore']);
  });

  it('reuses only a private regular single-link file even when its bytes are correct', () => {
    const log = join(
      root,
      '.frugal/logs',
      `${createHash('sha256').update(pytest).digest('hex')}.log`,
    );
    const short = compress(root, 'pytest', pytest, 1);
    checkArchive(short, pytest);
    expect(compress(root, 'pytest', pytest, 1)).toBe(short);

    chmodSync(log, 0o644);
    expect(compress(root, 'pytest', pytest, 1)).toBe(pytest);
    chmodSync(log, 0o600);
    const other = join(root, 'elsewhere');
    linkSync(log, other);
    expect(compress(root, 'pytest', pytest, 1)).toBe(pytest);
    rmSync(log);
    symlinkSync(other, log);
    expect(compress(root, 'pytest', pytest, 1)).toBe(pytest);
  });

  it.each(['FRUGAL_RELAY_TOKEN', 'FRUGAL_PROVIDER_API_KEY', 'OPENAI_API_KEY'])(
    'leaves the tool result and filesystem unchanged if output contains the injected %s',
    (key) => {
      const dummy = 'h03-public-fixture-credential';
      const raw = pytest.replace('test_first FAILED', `test_first FAILED (${dummy})`);
      vi.stubEnv(key, dummy);
      expect(compress(root, 'pytest', raw, 1)).toBe(raw);
      expect(existsSync(join(root, '.frugal'))).toBe(false);
      vi.stubEnv(key, '');
      checkArchive(compress(root, 'pytest', raw, 1), raw);
    },
  );
});

describe('host integration', () => {
  const v1 = () => plugin.server({ worktree: root, directory: join(root, 'nested') });
  it('keeps disabled, missing and malformed flags passive, including correlation-only B0', async () => {
    for (const text of [
      '',
      'flags: [',
      'version: 1\nflags: {tool_output_compression: "true"}',
      'version: 1\nflags: {tool_output_compression: false}',
    ]) {
      writeFileSync(join(root, 'frugal.yaml'), text);
      expect(await v1()).toEqual({});
    }
    writeFileSync(join(root, 'frugal.yaml'), flagOn);
    vi.stubEnv('FRUGAL_USAGE_CORRELATION', '1');
    expect(Object.keys(await v1())).toEqual(['chat.headers']);
    vi.stubEnv('FRUGAL_TOOL_OUTPUT_COMPRESSION', '1');
    expect(Object.keys(await v1())).toEqual(['chat.headers', 'tool.execute.after']);
    vi.stubEnv('FRUGAL_TOOL_OUTPUT_COMPRESSION', '0');
    expect(Object.keys(await v1())).toEqual(['chat.headers']);
    expect(existsSync(join(root, '.frugal'))).toBe(false);
  });

  it('rewrites only complete bash output using the V1 execute.after hook', async () => {
    writeFileSync(join(root, 'frugal.yaml'), flagOn);
    const after = (await v1())['tool.execute.after'];
    if (!after) throw new Error('Missing V1 compression hook');
    const input = { tool: 'bash', args: { command: 'pytest' }, sessionID: 's', callID: 'a' };
    const result = { title: 'tests', output: pytest, metadata: { exit: 1, truncated: true } };
    await after(input, result);
    expect(result.output).toBe(pytest);
    result.metadata.truncated = false;
    await after({ ...input, tool: 'read' }, result);
    expect(result.output).toBe(pytest);
    await after(input, result);
    checkArchive(result.output, pytest);
    expect(result.metadata).toEqual({ exit: 1, truncated: false });
  });

  it('uses the V2 completed shell result in content and code mode, keeping host notices', async () => {
    type Context = NonNullable<Parameters<typeof plugin.setup>[0]>;
    type Callback = Parameters<Context['tool']['hook']>[1];
    let hook: Callback = () => {
      throw new Error('Missing V2 compression hook');
    };
    const dispose = vi.fn(async () => {});
    const register = vi.fn<Context['tool']['hook']>(async (_name, callback) => {
      hook = callback;
      return { dispose };
    });
    const ctx = {
      location: { directory: root, project: { directory: root } },
      tool: { hook: register },
    };
    expect(plugin.setup(ctx)).toBeUndefined();
    expect(register).not.toHaveBeenCalled();
    writeFileSync(join(root, 'frugal.yaml'), flagOn);
    const cleanup = await plugin.setup(ctx);
    expect(register).toHaveBeenCalledWith('execute.after', expect.any(Function));
    const notice = { type: 'text', text: 'Exit code: 1' };
    const attachment = { type: 'file', uri: 'file:///example', mime: 'text/plain' };
    const result = {
      output: { output: vitest, exitCode: 1, wallTimeSeconds: 1.25 },
      content: [{ type: 'text', text: vitest }, notice, attachment],
      metadata: { truncated: false, status: 'exited' },
    };
    const event = {
      tool: 'shell',
      status: 'completed' as const,
      input: { command: 'vitest' },
      result,
    };
    hook({ ...event, status: 'error' });
    hook({ ...event, tool: 'read' });
    const preview = {
      ...event,
      result: { ...result, metadata: { ...result.metadata, truncated: true } },
    };
    hook(preview);
    expect(preview.result.output.output).toBe(vitest);
    hook(event);
    const short = event.result.output.output;
    checkArchive(short, vitest);
    expect(event.result.output).toEqual({ ...result.output, output: short });
    expect(event.result.content).toEqual([{ type: 'text', text: short }, notice, attachment]);
    expect(event.result.metadata).toBe(result.metadata);
    await cleanup?.();
    expect(dispose).toHaveBeenCalledOnce();
  });
});
