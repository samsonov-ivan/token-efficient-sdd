import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Hooks, PluginInput } from '@opencode-ai/plugin';
import { parse } from 'yaml';
import { compress } from './compression.js';

// An opt-in marker lets the host prove the correct entry point ran, even offline.
function recordLoad(entry: 'server' | 'setup'): void {
  const target = process.env.FRUGAL_PLUGIN_LOAD_LOG;
  if (target) {
    appendFileSync(target, `${JSON.stringify({ plugin: 'frugal', entry })}\n`, { mode: 0o600 });
  }
}

function enabled(directory: string) {
  const override = process.env.FRUGAL_TOOL_OUTPUT_COMPRESSION;
  if (override !== undefined) return override === '1';
  // The baseline harness installs this same entry solely for usage correlation.
  if (process.env.FRUGAL_USAGE_CORRELATION === '1') return false;
  try {
    const config = parse(readFileSync(join(directory, 'frugal.yaml'), 'utf8'));
    return config?.version === 1 && config.flags?.tool_output_compression === true;
  } catch {
    return false;
  }
}

interface ShellResult {
  content?: string | readonly { type: string; text?: string }[];
  output?: unknown;
  metadata?: Record<string, unknown>;
}

// Structural subset of @opencode/plugin@2.3.2 ToolDomain. The V2 SDK stays out
// of the V1 executable, which also loads this file without project dependencies.
interface V2Context {
  location: { directory: string; project: { directory: string } };
  tool: {
    hook(
      name: 'execute.after',
      callback: (
        event: {
          tool: string;
          input: unknown;
        } & ({ status: 'completed'; result: ShellResult } | { status: 'error' }),
      ) => void,
    ): Promise<{ dispose: () => Promise<void> }>;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export default {
  id: 'frugal',
  async server(ctx?: Pick<PluginInput, 'directory' | 'worktree'>): Promise<Hooks> {
    recordLoad('server');
    const hooks: Hooks = {};
    if (process.env.FRUGAL_USAGE_CORRELATION === '1') {
      hooks['chat.headers'] = async (input, output) => {
        output.headers['x-frugal-session-id'] = input.sessionID;
        output.headers['x-frugal-message-id'] = input.message.id;
      };
    }
    const directory = ctx?.worktree === '/' ? ctx.directory : (ctx?.worktree ?? ctx?.directory);
    if (directory && enabled(directory)) {
      hooks['tool.execute.after'] = async (input, result) => {
        if (
          input.tool !== 'bash' ||
          result.metadata?.truncated ||
          typeof result.output !== 'string'
        )
          return;
        result.output = compress(
          directory,
          input.args?.command,
          result.output,
          result.metadata?.exit,
        );
      };
    }
    return hooks;
  },
  setup(ctx?: V2Context) {
    recordLoad('setup');
    if (!ctx) return;
    const directory =
      ctx.location.project.directory === '/'
        ? ctx.location.directory
        : ctx.location.project.directory;
    if (!enabled(directory)) return;
    return ctx.tool
      .hook('execute.after', (event) => {
        if (event.tool !== 'shell' || event.status !== 'completed' || !isRecord(event.input))
          return;
        const { result } = event;
        const shell = result.output;
        if (
          !isRecord(shell) ||
          typeof shell.output !== 'string' ||
          typeof shell.exitCode !== 'number' ||
          shell.shellID ||
          shell.outputPath ||
          result.metadata?.truncated ||
          result.metadata?.status === 'running'
        )
          return;
        const raw = shell.output;
        const short = compress(directory, event.input.command, raw, shell.exitCode);
        if (short === raw) return;
        // V2 sends content to the model and exposes structured output in code mode.
        // Replace only the corresponding body; keep notices, exit codes and files.
        const content = Array.isArray(result.content)
          ? result.content.map((part) =>
              part.type === 'text' && part.text === raw ? { ...part, text: short } : part,
            )
          : result.content === raw
            ? short
            : result.content;
        event.result = { ...result, content, output: { ...shell, output: short } };
      })
      .then((registration) => () => registration.dispose());
  },
};
