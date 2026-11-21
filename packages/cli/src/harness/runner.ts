import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { GoVariant } from './go.js';
import { checked, command, writeJson } from './io.js';
import type { Result } from './io.js';

export type ProcessOptions = {
  network?: boolean;
  credentials?: string[];
  secretEnv?: Record<string, string>;
  onLine?: (line: string, stderr: boolean) => void;
};
export function withGoVariant(args: string[], variant?: GoVariant) {
  if (!variant) return args;
  const [subcommand, ...options] = args;
  if (subcommand !== 'run') throw new Error('OpenCode model variants apply only to run');
  return ['run', '--variant', variant, ...options];
}
export function runnerEnvironment(root: string): Record<string, string> {
  const names = {
    HOME: 'home',
    XDG_CONFIG_HOME: 'config',
    XDG_DATA_HOME: 'data',
    XDG_CACHE_HOME: 'cache',
    XDG_STATE_HOME: 'state',
    OPENCODE_CONFIG_DIR: 'opencode-config',
    TMPDIR: 'tmp',
  };
  const env: Record<string, string> = {
    CI: '1',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_SHARE: '1',
    OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENSPEC_TELEMETRY: '0',
    DO_NOT_TRACK: '1',
  };
  for (const [k, v] of Object.entries(names)) {
    env[k] = join(root, v);
    mkdirSync(env[k], { recursive: true, mode: 0o700 });
  }
  return env;
}
export function createSettings(
  env: Record<string, string>,
  model: string,
  endpoint: string | null = null,
  limits: { context: number; output: number } | null = null,
  relay = false,
) {
  writeJson(join(env.XDG_CONFIG_HOME, 'openspec', 'config.json'), {
    profile: 'custom',
    workflows: ['propose', 'explore', 'apply', 'update', 'sync', 'archive', 'verify'],
    delivery: 'skills',
    skillsScope: 'project',
  });
  const providerId = model.split('/')[0];
  const modelId = model.slice(providerId.length + 1);
  const provider = endpoint
    ? {
        [providerId]: {
          npm: '@ai-sdk/openai-compatible',
          name: providerId,
          options: {
            baseURL: endpoint,
            apiKey: relay
              ? '{env:FRUGAL_RELAY_TOKEN}'
              : process.env.FRUGAL_PROVIDER_API_KEY
                ? '{env:FRUGAL_PROVIDER_API_KEY}'
                : 'local',
          },
          models: limits ? { [modelId]: { name: modelId, limit: limits } } : undefined,
        },
      }
    : undefined;
  writeJson(join(env.OPENCODE_CONFIG_DIR, 'opencode.json'), {
    provider,
    model,
    small_model: model,
    enabled_providers: [model.split('/')[0]],
    autoupdate: false,
    share: 'disabled',
    agent: { title: { disable: true } },
  });
}
export function safeFile(root: string, path: string) {
  const canonical = realpathSync(path);
  if (
    canonical !== path ||
    !canonical.startsWith(`${realpathSync(root)}/`) ||
    !lstatSync(path).isFile() ||
    statSync(path).nlink !== 1
  )
    throw new Error(`Unsafe run artifact: ${path}`);
  return readFileSync(path);
}
export class Container {
  constructor(
    readonly root: string,
    readonly repo: string,
    readonly env: Record<string, string>,
    readonly image: string,
    readonly prefix: string,
  ) {}
  static async imageID(name: string) {
    const id = await checked(command('docker', ['image', 'inspect', '--format', '{{.Id}}', name]));
    if (!/^sha256:[0-9a-f]{64}$/.test(id)) throw new Error(`Docker image is unavailable: ${name}`);
    return id;
  }
  exec(argv: string[], opts: ProcessOptions = {}): Promise<Result> {
    const args = [
      'run',
      '--rm',
      '--init',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--pids-limit',
      '384',
      '--network',
      opts.network ? 'bridge' : 'none',
      '--label',
      `frugal.run=${this.prefix}`,
      '--user',
      `${String(process.getuid?.() ?? 1000)}:${String(process.getgid?.() ?? 1000)}`,
      '--tmpfs',
      '/tmp:rw,nosuid,nodev',
      '--mount',
      `type=bind,src=${this.root},dst=${this.root},readonly`,
      '--workdir',
      this.repo,
    ];
    // A process cannot replace the root of the checkout, XDG dirs or its parent with a symlink.
    for (const name of [
      'repo',
      'home',
      'config',
      'data',
      'cache',
      'state',
      'opencode-config',
      'tmp',
    ]) {
      const path = join(this.root, name);
      args.push('--mount', `type=bind,src=${path},dst=${path}`);
    }
    for (const [key, value] of Object.entries(this.env)) args.push('--env', `${key}=${value}`);
    for (const key of opts.credentials ?? []) if (process.env[key]) args.push('--env', key);
    if (opts.network && process.platform === 'linux')
      args.push('--add-host', 'host.docker.internal:host-gateway');
    for (const key of Object.keys(opts.secretEnv ?? {})) args.push('--env', key);
    return command('docker', [...args, this.image, ...argv], {
      env: { ...process.env, ...opts.secretEnv },
      onLine: opts.onLine,
      secrets: [
        ...(opts.credentials ?? []).map((key) => process.env[key] ?? ''),
        ...Object.values(opts.secretEnv ?? {}),
      ],
    });
  }
  async stop() {
    const containers = await checked(
      command('docker', ['ps', '-q', '--filter', `label=frugal.run=${this.prefix}`]),
    );
    if (containers) await checked(command('docker', ['kill', ...containers.split(/\s+/)]));
  }
  async verifyIsolation(...forbidden: string[]) {
    // In Linux the host project, all other arms and the Docker socket are outside the only bind mount.
    await checked(
      this.exec([
        'node',
        '-e',
        "const fs=require('node:fs'); const denied=process.argv.slice(1); if(denied.some(p=>fs.existsSync(p)))process.exit(1); fs.accessSync(process.cwd(),fs.constants.W_OK)",
        ...forbidden,
        '/var/run/docker.sock',
      ]),
    );
  }
}
export function credentialKeys(provider: string) {
  const names: Record<string, string[]> = {
    openai: ['OPENAI_API_KEY'],
    anthropic: ['ANTHROPIC_API_KEY'],
    openrouter: ['OPENROUTER_API_KEY'],
    opencode: ['OPENCODE_API_KEY'],
    google: ['GOOGLE_GENERATIVE_AI_API_KEY'],
    mistral: ['MISTRAL_API_KEY'],
    groq: ['GROQ_API_KEY'],
  };
  return names[provider] ?? [];
}
export function platformBin(project: string, name: string) {
  const path = join(project, 'node_modules', '.bin', name);
  if (!existsSync(path)) throw new Error(`Missing local tool: ${path}`);
  return path;
}
