import { appendFileSync } from 'node:fs';
import type { Hooks } from '@opencode-ai/plugin';

// An opt-in marker lets the host prove the correct entry point ran, even offline.
function recordLoad(entry: 'server' | 'setup'): void {
  const target = process.env.FRUGAL_PLUGIN_LOAD_LOG;
  if (target) {
    appendFileSync(target, `${JSON.stringify({ plugin: 'frugal', entry })}\n`, { mode: 0o600 });
  }
}

export default {
  id: 'frugal',
  async server(): Promise<Hooks> {
    recordLoad('server');
    if (process.env.FRUGAL_USAGE_CORRELATION !== '1') return {};
    return {
      async 'chat.headers'(input, output) {
        output.headers['x-frugal-session-id'] = input.sessionID;
        output.headers['x-frugal-message-id'] = input.message.id;
      },
    };
  },
  setup() {
    recordLoad('setup');
  },
};
