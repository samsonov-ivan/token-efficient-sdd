import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// macOS can have an older system python3 alongside the project's interpreter.
export function analysisPython(project: string): string {
  const venv = join(
    project,
    'analysis',
    '.venv',
    process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
  );
  const candidates = process.env.FRUGAL_PYTHON
    ? [process.env.FRUGAL_PYTHON]
    : [
        ...(existsSync(venv) ? [venv] : []),
        'python3',
        'python3.14',
        'python3.13',
        'python3.12',
        'python3.11',
      ];
  for (const python of candidates) {
    const probe = spawnSync(python, ['-c', 'import sys; sys.exit(sys.version_info < (3, 11))'], {
      stdio: 'ignore',
    });
    if (probe.status === 0) return python;
  }
  throw new Error(
    'Python 3.11+ is required for offline analysis. Set FRUGAL_PYTHON to its executable.',
  );
}

export function report(args: string[]): number {
  const project = fileURLToPath(new URL('../../../', import.meta.url));
  const child = spawnSync(analysisPython(project), [join(project, 'analysis/report.py'), ...args], {
    stdio: 'inherit',
  });
  if (child.error) throw child.error;
  return child.status ?? 1;
}
