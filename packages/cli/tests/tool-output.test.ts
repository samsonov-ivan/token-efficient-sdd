import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { digest } from '../src/harness/io.js';
import { captureToolOutput, collectToolOutputs } from '../src/harness/tool-output.js';

let root: string;
let repo: string;
let runDir: string;
let logs: string;
let archive: string;

beforeEach(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), 'frugal-tool-output-'));
  repo = join(root, 'repo');
  runDir = join(root, 'run');
  logs = join(repo, '.frugal', 'logs');
  archive = join(runDir, 'raw', 'tool-output');
  mkdirSync(logs, { recursive: true });
  mkdirSync(runDir);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const event = (hash: string, stamp: boolean, metadataHash = hash) =>
  JSON.stringify({
    type: 'tool_use',
    part: {
      tool: 'bash',
      state: {
        status: 'completed',
        output: `2 passed\nFull output (project root): .frugal/logs/${hash}.log`,
        metadata: stamp ? { frugalToolOutputSha256: metadataHash } : {},
      },
    },
  });

describe('compressed tool output capture', () => {
  it('archives the checked original outside the worktree and handles repeated references', () => {
    const original = Buffer.from('session\n..\n2 passed\n');
    const hash = digest(original);
    writeFileSync(join(logs, `${hash}.log`), original);

    captureToolOutput(repo, runDir, event(hash, false), []);
    expect(existsSync(archive)).toBe(false);
    captureToolOutput(repo, runDir, event(hash, true), []);
    captureToolOutput(repo, runDir, event(hash, true), []);
    rmSync(repo, { recursive: true });

    expect(readFileSync(join(archive, `${hash}.log`))).toEqual(original);
  });

  it('rejects a digest mismatch, a forbidden link or bytes containing a supplied credential', () => {
    const original = 'full output with dummy-credential-value';
    const hash = digest(original);
    const file = join(logs, `${hash}.log`);
    const outside = join(root, 'outside.log');
    writeFileSync(outside, original);
    symlinkSync(outside, file);

    expect(() => captureToolOutput(repo, runDir, event(hash, true), [])).toThrow(/Unsafe/);
    rmSync(file);
    writeFileSync(file, 'modified');
    expect(() => captureToolOutput(repo, runDir, event(hash, true), [])).toThrow(/hash/);
    writeFileSync(file, original);
    expect(() => captureToolOutput(repo, runDir, event(hash, true, '0'.repeat(64)), [])).toThrow(
      /metadata/,
    );
    expect(() =>
      captureToolOutput(repo, runDir, event(hash, true), ['dummy-credential-value']),
    ).toThrow(/credential/);
    expect(existsSync(archive)).toBe(false);
  });

  it('retains child-session originals whose markers never appeared in the CLI stream', () => {
    const bytes = Buffer.from('a child tool result');
    const name = `${digest(bytes)}.log`;
    writeFileSync(join(logs, name), bytes);
    writeFileSync(join(logs, '.gitignore'), '*\n');
    collectToolOutputs(repo, runDir, []);

    expect(readFileSync(join(archive, name))).toEqual(bytes);
    expect(existsSync(join(archive, '.gitignore'))).toBe(false);
  });
});
