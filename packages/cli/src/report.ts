import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function report(args: string[]): number {
  const script = fileURLToPath(new URL('../../../analysis/report.py', import.meta.url));
  const child = spawnSync('python3', [script, ...args], {stdio: 'inherit'});
  if (child.error) throw child.error;
  return child.status ?? 1;
}
