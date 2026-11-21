import { createHash, randomUUID } from 'node:crypto';
import {
  constants,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  fstatSync,
  closeSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';

type Format = 'pytest' | 'vitest' | 'test' | 'diff' | 'status' | 'log';

function format(command: string): Format | undefined {
  // A compound command can interleave unrelated output with a valid runner summary.
  if (!/^[\w./:@%+,= -]+$/.test(command)) return;
  const words = command.trim().split(/ +/);
  const executable = words[0].split('/').at(-1);
  if (
    executable === 'pytest' ||
    (/^python(?:3(?:\.\d+)?)?$/.test(executable ?? '') &&
      words[1] === '-m' &&
      words[2] === 'pytest')
  )
    return 'pytest';
  if (executable === 'uv' && words[1] === 'run' && words[2] === 'pytest') return 'pytest';
  if (
    executable === 'vitest' ||
    (['npx', 'pnpm', 'yarn', 'bunx'].includes(executable ?? '') &&
      words.slice(1).find((word) => !word.startsWith('-')) === 'vitest')
  )
    return 'vitest';
  if (executable === 'npm' && (words[1] === 'test' || (words[1] === 'run' && words[2] === 'test')))
    return 'test';
  if (executable === 'git' && ['diff', 'status', 'log'].includes(words[1]))
    return words[1] as Format;
}

const diagnostic =
  /assert|warn|error|fail|exception|traceback|fatal|panic|conflict|stack trace|stderr/i;
const pytestSummary =
  /^=*(?:\s*)(?:\d+ (?:passed|failed|skipped|errors?|warnings?|deselected|xfailed|xpassed)(?:, )?)+ in \d+(?:\.\d+)?s(?: \([^)]*\))?\s*=*$/;
const pytestProgress =
  /^(?:[\w./-]+\.py\s+)?[.s]+\s+\[\s*\d+%\]$|^[\w./-]+\.py::\S+\s+PASSED\s+\[\s*\d+%\]$/;
const vitestProgress =
  /^\s*✓\s+.+\s+\(\d+ tests?\)\s+\d+(?:\.\d+)?m?s\s*$|^\s*✓\s+.+\s+\d+(?:\.\d+)?m?s\s*$/;
const pytestHeader =
  /^=+ test session starts =+$|^(?:platform |rootdir:|configfile:|cachedir:|plugins:|testpaths:|collecting |collected \d+ items?)/;
const vitestHeader = /^\s*RUN\s+v[\d.]+(?:\s|$)|^> /;

function testSummary(lines: string[], kind: 'pytest' | 'vitest' | 'test') {
  const clean = lines.map((line) => stripVTControlCharacters(line).trimEnd());
  const pytest = pytestSummary.test(clean.filter(Boolean).at(-1) ?? '');
  const vitest =
    clean.some((line) => /^\s*Test Files\s+\d+ (passed|failed|skipped)/.test(line)) &&
    clean.some((line) => /^\s*Tests\s+\d+ (passed|failed|skipped)/.test(line));
  if (pytest === vitest || (kind !== 'test' && kind !== (pytest ? 'pytest' : 'vitest'))) return;

  const progress = pytest ? pytestProgress : vitestProgress;
  const header = pytest ? pytestHeader : vitestHeader;
  let inPreamble = true;
  let omitted = false;
  const kept: string[] = [];
  for (const [i, line] of clean.entries()) {
    // The first diagnostic or unrecognised producer owns the rest of the stream.
    // Its multiline payload can itself look exactly like passing-test progress.
    if (inPreamble && !diagnostic.test(line)) {
      if (progress.test(line)) {
        omitted = true;
        continue;
      }
      if (!line.trim() || header.test(line)) {
        kept.push(lines[i]);
        continue;
      }
    }
    inPreamble = false;
    kept.push(lines[i]);
  }
  if (omitted) return kept.join('\n');
}

function diffSummary(lines: string[]) {
  if (!lines[0]?.startsWith('diff --git ') || !lines.some((line) => line.startsWith('@@ '))) return;
  const kept: string[] = [];
  let omitted = 0;
  for (let i = 0; i < lines.length; ) {
    const line = lines[i++];
    kept.push(line);
    if (!line.startsWith('@@ ')) continue;
    const header = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    if (!header) return;
    let old = Number(header[1] ?? 1);
    let next = Number(header[2] ?? 1);
    const body: string[] = [];
    while (old > 0 || next > 0) {
      const row = lines[i++];
      if (!row) return;
      if (row.startsWith(' ')) {
        old--;
        next--;
      } else if (row.startsWith('-')) old--;
      else if (row.startsWith('+')) next--;
      else if (row.trimEnd() !== '\\ No newline at end of file') return;
      if (old < 0 || next < 0) return;
      body.push(row);
    }
    // Keep diagnostics and their entire local context, including multiline assertions.
    if (diagnostic.test(line) || body.some((row) => diagnostic.test(row))) {
      for (const row of body) kept.push(row);
      continue;
    }
    for (const [j, row] of body.entries()) {
      if (row.startsWith(' ') && body[j - 1]?.startsWith(' ') && body[j + 1]?.startsWith(' '))
        omitted++;
      else kept.push(row);
    }
  }
  if (omitted) return `[${omitted} unchanged context lines omitted]\n${kept.join('\n')}`;
}

function gitList(lines: string[], kind: 'status' | 'log') {
  const pattern = kind === 'status' ? /^(?:[ MADRCU?!][ MADRCU?!]) .+$/ : /^[a-f\d]{7,64} .+$/;
  const rows = lines.at(-1) === '' ? lines.slice(0, -1) : lines;
  if (rows.length <= 10 || !rows.every((row) => pattern.test(row) && !diagnostic.test(row))) return;
  if (kind === 'status' && rows.some((row) => /^(?:DD|AU|UD|UA|DU|AA|UU) /.test(row))) return;
  return [
    ...rows.slice(0, 6),
    `[${rows.length - 9} ${kind} entries omitted]`,
    ...rows.slice(-3),
  ].join('\n');
}

function archive(directory: string, filename: string, bytes: Buffer) {
  const root = join(directory, '.frugal');
  const logs = join(root, 'logs');
  for (const dir of [root, logs]) {
    try {
      mkdirSync(dir, { mode: 0o700 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    if (!lstatSync(dir).isDirectory()) return false;
  }
  // The harness snapshots with git add -A. Keep raw tool records local, including
  // this ignore file itself, without changing the target's tracked ignore rules.
  const ignore = join(logs, '.gitignore');
  try {
    writeFileSync(ignore, '*\n', { flag: 'wx', mode: 0o600 });
  } catch (e) {
    if (
      (e as NodeJS.ErrnoException).code !== 'EEXIST' ||
      !lstatSync(ignore).isFile() ||
      readFileSync(ignore, 'utf8').trim() !== '*'
    )
      return false;
  }
  // Publish complete immutable content. Concurrent identical calls can share a log.
  const file = join(logs, filename);
  const temp = join(logs, `.${randomUUID()}.tmp`);
  const fd = openSync(temp, 'wx', 0o600);
  try {
    try {
      writeFileSync(fd, bytes);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(temp, file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const existing = openSync(
        file,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        return fstatSync(existing).isFile() && readFileSync(existing).equals(bytes);
      } finally {
        closeSync(existing);
      }
    }
    return true;
  } finally {
    unlinkSync(temp);
  }
}

export function compress(directory: string, command: unknown, raw: string, exit: unknown): string {
  const kind = typeof command === 'string' ? format(command) : undefined;
  if (!kind || raw.includes('\0')) return raw;
  const lines = raw.split('\n');
  const summary =
    kind === 'diff'
      ? diffSummary(lines)
      : kind === 'status' || kind === 'log'
        ? gitList(lines, kind)
        : testSummary(lines, kind);
  if (summary === undefined) return raw;
  const bytes = Buffer.from(raw);
  if (bytes.toString() !== raw) return raw;
  const filename = `${createHash('sha256').update(bytes).digest('hex')}.log`;
  const output = `${summary}${summary.endsWith('\n') ? '' : '\n'}${typeof exit === 'number' ? `Exit code: ${exit}\n` : ''}Full output (project root): .frugal/logs/${filename}`;
  if (Buffer.byteLength(output) >= bytes.length) return raw;
  try {
    return archive(directory, filename, bytes) ? output : raw;
  } catch {
    return raw;
  }
}
