import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { digest } from './io.js';
import { safeFile } from './runner.js';

type ToolEvent = {
  type?: string;
  part?: {
    tool?: string;
    state?: {
      status?: string;
      output?: unknown;
      metadata?: { frugalToolOutputSha256?: unknown };
    };
  };
};

const marker = /(?:^|\n)Full output \(project root\): \.frugal\/logs\/([a-f0-9]{64})\.log$/;

export function captureToolOutput(repo: string, runDir: string, line: string, secrets: string[]) {
  let event: ToolEvent | null;
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }
  const state = event?.part?.state;
  if (event?.type !== 'tool_use' || event.part?.tool !== 'bash' || state?.status !== 'completed')
    return;
  const hash = state.metadata?.frugalToolOutputSha256;
  if (hash === undefined) return;
  if (
    typeof hash !== 'string' ||
    typeof state.output !== 'string' ||
    marker.exec(state.output)?.[1] !== hash
  )
    throw new Error('Compressed tool output reference does not match its metadata');
  const name = `${hash}.log`;
  const bytes = safeFile(repo, join(repo, '.frugal', 'logs', name));
  if (digest(bytes) !== hash) throw new Error('Compressed tool output does not match its hash');
  if (secrets.some((secret) => secret && bytes.includes(secret)))
    throw new Error('Compressed tool output contains a credential and cannot be archived');

  const archive = join(runDir, 'raw', 'tool-output');
  mkdirSync(archive, { recursive: true, mode: 0o700 });
  const target = join(archive, name);
  if (!existsSync(target)) writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
  else if (!safeFile(runDir, target).equals(bytes))
    throw new Error('Archived tool output does not match its original');
}
