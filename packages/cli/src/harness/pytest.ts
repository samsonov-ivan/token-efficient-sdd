import { writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import { git } from './io.js';
import { safeFile } from './runner.js';

export const pytestConfigs = [
  'pytest.ini',
  '.pytest.ini',
  'pyproject.toml',
  'tox.ini',
  'setup.cfg',
  'conftest.py',
];

// Collect pytest node IDs before executing tests. JUnit names omit the test file and can
// flatten parts of parameterized node IDs, so they remain a separate evidence check.
const inventoryPlugin = `
import json
import os
from pathlib import Path

import pytest


@pytest.hookimpl(tryfirst=True)
def pytest_sessionstart(session):
    selection = os.environ.get('FRUGAL_PYTEST_SELECTION')
    if selection:
        session.frugal_original_nodes = set(json.loads(Path(selection).read_text(encoding='utf-8')))
        session.config.args[:] = sorted({
            node.split('::', 1)[0] for node in session.frugal_original_nodes
        })


@pytest.hookimpl(trylast=True)
def pytest_collection_modifyitems(session, config, items):
    original = getattr(session, 'frugal_original_nodes', None)
    if original is not None:
        other = [item for item in items if item.nodeid not in original]
        items[:] = [item for item in items if item.nodeid in original]
        if other:
            config.hook.pytest_deselected(items=other)


def pytest_collection_finish(session):
    output = Path(os.environ['FRUGAL_PYTEST_INVENTORY'])
    output.write_text(json.dumps(sorted(item.nodeid for item in session.items)), encoding='utf-8')
`;

export function pytestInventory(root: string, env: Record<string, string>, select?: string[]) {
  const module = 'frugal_pytest_inventory';
  const output = join(root, 'tmp', 'pytest-inventory.json');
  // Put the plugin and reference inventory on the immutable part of the evaluator mount.
  writeFileSync(join(root, `${module}.py`), inventoryPlugin);
  env.PYTHONPATH = `${root}:${env.PYTHONPATH}`;
  env.FRUGAL_PYTEST_INVENTORY = output;
  if (select) {
    env.FRUGAL_PYTEST_SELECTION = join(root, 'pytest-selection.json');
    writeFileSync(env.FRUGAL_PYTEST_SELECTION, JSON.stringify(select));
  }
  return {
    args: ['-p', module],
    read(): string[] {
      const nodes: unknown = JSON.parse(safeFile(root, output).toString('utf8'));
      if (!Array.isArray(nodes) || nodes.some((node) => typeof node !== 'string'))
        throw new Error('Invalid pytest node ID inventory');
      return nodes;
    },
  };
}

export function restorePytestInputs(
  repo: string,
  pin: string,
  finalCommit: string,
  paths: string[],
  originalNodes: string[],
) {
  const scopes = new Set([...paths.filter((path) => normalize(path) !== '.'), ...pytestConfigs]);
  for (const node of originalNodes) {
    const file = node.split('::', 1)[0];
    if (!file || isAbsolute(file) || file.startsWith('-') || file.split('/').includes('..'))
      throw new Error(`Unexpected path in original pytest node ID: ${node}`);
    scopes.add(file);
    for (let directory = dirname(file); directory !== '.'; directory = dirname(directory)) {
      for (const config of pytestConfigs) scopes.add(join(directory, config));
    }
  }
  const changed = git(repo, [
    '--literal-pathspecs',
    'diff',
    '--no-renames',
    '--name-status',
    '-z',
    pin,
    finalCommit,
    '--',
    ...scopes,
  ])
    .split('\0')
    .filter((value, index) => value && index % 2 === 1);
  if (changed.length) {
    git(repo, [
      '--literal-pathspecs',
      'restore',
      '--source',
      pin,
      '--staged',
      '--worktree',
      '--',
      ...changed,
    ]);
  }
  return changed;
}
