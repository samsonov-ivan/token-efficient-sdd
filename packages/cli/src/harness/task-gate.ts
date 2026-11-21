import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseReport } from '../quality/suites.js';
import type { Result } from './io.js';
import { safeFile } from './runner.js';

type Target = {
  language?: string;
  test?: { command?: string; report?: string; per_task_selector?: string };
  paths?: { src?: string[]; tests?: string[] };
};

function paths(values: string[]) {
  if (
    !Array.isArray(values) ||
    !values.length ||
    values.some(
      (p) =>
        typeof p !== 'string' ||
        !p.length ||
        p.startsWith('/') ||
        p.startsWith('-') ||
        p.includes(':') ||
        p.split('/').includes('..'),
    )
  )
    throw new Error('Invalid frozen pytest paths');
  return values;
}

// The controller supplies this file on the read-only arm mount. Only the
// public checkout and its original test configuration are visible to pytest.
const driver = `import os
import sys

import pytest


class TaskSelection:
    def pytest_collection_modifyitems(self, config, items):
        task = os.environ["FRUGAL_TASK_ID"]
        chosen, others = [], []
        for item in items:
            matches = any(mark.args == (task,) for mark in item.iter_markers("task"))
            (chosen if matches else others).append(item)
        config.hook.pytest_deselected(items=others)
        items[:] = chosen


sys.path.insert(0, os.getcwd())
sys.exit(pytest.main(sys.argv[1:], plugins=[TaskSelection()]))
`;

export function publicTaskConfig(config: Target) {
  const command = config.test?.command ?? '';
  if (
    config.language !== 'python' ||
    config.test?.report !== 'junit' ||
    !/^python(?:3)? -m pytest(?: -q)?$/.test(command) ||
    config.test?.per_task_selector
  )
    throw new Error(
      'Live task gates require a frozen Python pytest JUnit target using task markers',
    );
  return {
    src: paths(config.paths?.src ?? ['.']),
    tests: paths(config.paths?.tests ?? ['tests']),
    python: command.split(' ')[0],
    quiet: command.endsWith(' -q'),
  };
}

export function createTaskGate(
  root: string,
  repo: string,
  runDir: string,
  config: ReturnType<typeof publicTaskConfig>,
  timeout: number,
  execute: (args: string[]) => Promise<Result>,
) {
  const script = join(root, 'frugal_task_gate.py');
  writeFileSync(script, driver, { flag: 'wx', mode: 0o444 });
  const evidence = join(runDir, 'opt', 'public-tests');
  return async (id: string, attempt: number) => {
    if (!/^\d+(?:\.\d+)*$/.test(id) || !Number.isSafeInteger(attempt) || attempt < 1)
      throw new Error('Invalid public task test identity');
    mkdirSync(evidence, { recursive: true });
    const stem = `${id}-attempt-${attempt}`;
    const temp = join(root, 'tmp', `public-tests-${randomUUID()}`);
    const xml = `${temp}.xml`;
    const args = [
      'timeout',
      '--kill-after=5',
      String(timeout),
      'env',
      `FRUGAL_TASK_ID=${id}`,
      'PYTHONDONTWRITEBYTECODE=1',
      `PYTHONPATH=${config.src.map((p) => join(repo, p)).join(':')}`,
      config.python,
      script,
      ...(config.quiet ? ['-q'] : []),
      `--junitxml=${xml}`,
      '--',
      ...config.tests,
    ];
    const result = await execute(args);
    const output = result.stdout + result.stderr;
    writeFileSync(join(evidence, `${stem}.log`), output, { flag: 'wx' });
    const log = `${temp}.log`;
    writeFileSync(log, output, { flag: 'wx', mode: 0o600 });
    let summary: string;
    let passed = false;
    try {
      const raw = safeFile(root, xml);
      writeFileSync(join(evidence, `${stem}.xml`), raw, { flag: 'wx' });
      const cases = parseReport('junit', raw.toString('utf8'));
      const failures = [...cases].filter(([, status]) => status !== 'passed');
      passed = result.code === 0 && !failures.length;
      summary = `${cases.size - failures.length}/${cases.size} passed. ${failures
        .slice(0, 5)
        .map(([name, status]) => `${name}: ${status}`)
        .join(', ')}`;
    } catch (error) {
      summary = `Unusable JUnit report: ${error instanceof Error ? error.message : String(error)}`;
    }
    return {
      passed,
      summary: `Public task ${id}, pytest exit ${result.code}. ${summary} Full output: ${log}`,
    };
  };
}
