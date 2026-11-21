import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import plugin from '../src/index.js';
import type { Hooks } from '@opencode-ai/plugin';

afterEach(() => vi.unstubAllEnvs());

describe('passive plugin', () => {
  it('registers no hooks when instrumentation is disabled', async () => {
    vi.stubEnv('FRUGAL_PLUGIN_LOAD_LOG', '');
    expect(await plugin.server()).toEqual({});
    expect(plugin.setup()).toBeUndefined();
  });

  it('adds correlation metadata for a provider request only when enabled', async () => {
    vi.stubEnv('FRUGAL_USAGE_CORRELATION', '1');
    const headers: Record<string, string> = { existing: 'retained' };
    const hook = (await plugin.server())['chat.headers'];
    if (!hook) throw new Error('Missing correlation hook');
    const input = { sessionID: 'ses_child', message: { id: 'msg_user' } } as Parameters<
      NonNullable<Hooks['chat.headers']>
    >[0];
    await hook(input, { headers });
    expect(headers).toEqual({
      existing: 'retained',
      'x-frugal-session-id': 'ses_child',
      'x-frugal-message-id': 'msg_user',
    });
  });

  it('records the invoked host entry point when requested', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'frugal-plugin-test-'));
    try {
      const log = join(dir, 'loads.jsonl');
      vi.stubEnv('FRUGAL_PLUGIN_LOAD_LOG', log);
      await plugin.server();
      plugin.setup();
      const entries = readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(entries).toEqual([
        { plugin: 'frugal', entry: 'server' },
        { plugin: 'frugal', entry: 'setup' },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
