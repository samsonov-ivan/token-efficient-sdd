import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';

export function writeJson(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, file);
}
export function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}
export function digest(data: string | Buffer) {
  return createHash('sha256').update(data).digest('hex');
}
export function hashTree(path: string): string {
  const stat = lstatSync(path);
  if (stat.isFile()) return digest(readFileSync(path));
  if (!stat.isDirectory())
    throw new Error(`Evidence must be ordinary files and directories: ${path}`);
  return digest(
    JSON.stringify(
      readdirSync(path)
        .sort()
        .map((name) => [name, hashTree(join(path, name))]),
    ),
  );
}
export function slug(value: string, label: string) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(value))
    throw new Error(`Invalid ${label}: ${value}`);
  return value;
}
export function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv) {
  const result = spawnSync('git', args, {
    cwd,
    env: {
      PATH: process.env.PATH,
      HOME: '/nonexistent',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      ...env,
    },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(result.stderr || result.error?.message || 'git failed');
  return result.stdout.trim();
}
export type Result = { stdout: string; stderr: string; code: number };
export function command(
  binary: string,
  args: string[],
  opts: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    onLine?: (line: string, stderr: boolean) => void;
    secrets?: string[];
  } = {},
): Promise<Result> {
  return new Promise((resolve, reject) => {
    const proc = spawn(binary, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output = ['', ''];
    let overLimit = false;
    for (const [index, stream] of [proc.stdout, proc.stderr].entries()) {
      let partial = '';
      const emit = (input: string) => {
        let line = input;
        for (const secret of opts.secrets ?? [])
          if (secret) line = line.replaceAll(secret, '[REDACTED]');
        opts.onLine?.(line, index === 1);
        if (output[index].length + line.length < 64 * 1024 * 1024) output[index] += `${line}\n`;
        else overLimit = true;
      };
      stream.setEncoding('utf8');
      stream.on('data', (data: string) => {
        const lines = (partial + data).split('\n');
        partial = lines.pop() ?? '';
        for (const line of lines) emit(line);
      });
      stream.on('end', () => {
        if (partial) emit(partial);
      });
    }
    proc.on('error', reject);
    proc.on('close', (code) =>
      overLimit
        ? reject(new Error('Command exceeded parser limit. Full streams retained on disk.'))
        : resolve({ stdout: output[0], stderr: output[1], code: code ?? 1 }),
    );
  });
}
export async function checked(task: Promise<Result>) {
  const result = await task;
  if (result.code !== 0)
    throw new Error(result.stderr.trim() || result.stdout.trim() || 'Command failed');
  return result.stdout.trim();
}
export const now = () => new Date().toISOString();
export function activeOwner(path: string) {
  if (!existsSync(path)) return true; // Another coordinator is initializing the reservation.
  const owner = readJson<{ host: string; pid: number }>(path);
  if (owner.host !== hostname()) return true;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
