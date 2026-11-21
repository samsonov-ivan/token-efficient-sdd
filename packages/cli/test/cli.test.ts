import { afterEach, expect, it, vi } from 'vitest';
import { main } from '../src/index.js';

afterEach(() => vi.restoreAllMocks());

it('lists the supported commands in a stable order', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await main(['--help'])).toBe(0);
  expect(
    log.mock.calls
      .flat()
      .filter((line) => line.startsWith('  '))
      .map((line) => line.trim().split(/\s+/)[0]),
  ).toEqual(['capsule', 'consistency', 'gates', 'init', 'map', 'meter', 'report', 'run', 'trace']);
});

it('prints command usage and rejects an unknown command', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await main(['run', '--help'])).toBe(0);
  expect(log).toHaveBeenCalledWith(expect.stringContaining('Usage: frugal run'));
  expect(await main(['constructor'])).toBe(2);
});
