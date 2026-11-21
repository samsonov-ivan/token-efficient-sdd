import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { digest, readJson } from './io.js';

export const goURL = 'https://opencode.ai/inference/go/openai/v1';
const catalog = 'https://opencode.ai/console/api/v1/models';
export const goVariants = ['low', 'high', 'max'] as const;
export type GoVariant = (typeof goVariants)[number];
export function isGoVariant(value: unknown): value is GoVariant {
  return goVariants.some((variant) => variant === value);
}
export async function goCatalog(model: string) {
  const apiKey = process.env.OPENCODE_API_KEY;
  if (!apiKey)
    throw new Error('OpenCode Go requires OPENCODE_API_KEY in the host coordinator environment');
  const response = await fetch(catalog, {
    headers: { Authorization: `Bearer ${apiKey}` },
    redirect: 'error',
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok)
    throw new Error(
      `OpenCode Go authenticated catalog rejected this key (HTTP ${response.status})`,
    );
  const entries = (await response.json()) as Record<
    string,
    {
      models?: Record<
        string,
        {
          id: string;
          cost?: Record<string, unknown>;
          limit?: { output: number; context: number };
          api?: Record<string, { base_url: string }>;
        }
      >;
    }
  >;
  const id = model.slice('opencode-go/'.length);
  const selected = entries['opencode-go']?.models?.[id];
  if (
    selected?.id !== id ||
    selected.api?.['chat-completions']?.base_url?.replace(/\/$/, '') !== goURL
  )
    throw new Error(
      'Authorized workspace does not list the requested Go model on the official Chat Completions endpoint',
    );
  return {
    model,
    prices: selected.cost ?? null,
    limits: selected.limit ?? null,
    endpoint: goURL,
    catalog,
  };
}
export function smokeReceipt(out: string, model: string, sha: string, variant?: GoVariant) {
  const inputs = variant ? [model, sha, variant] : [model, sha];
  return join(out, '.go-smoke', `${digest(JSON.stringify(inputs))}.json`);
}
export function verifySmoke(out: string, model: string, sha: string, variant?: GoVariant) {
  const file = smokeReceipt(out, model, sha, variant);
  if (!existsSync(file))
    throw new Error(
      'Complete an isolated --go-smoke with the same model, code and variant before running B0',
    );
  const { run_id, ledger_hash } = readJson<{ run_id: string; ledger_hash: string }>(file);
  if (typeof run_id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(run_id))
    throw new Error(
      'Go subscription needs a fresh live smoke after the quota reset or billing repair',
    );
  const m = readJson<{
    dry_run: boolean;
    model: string;
    purpose: string;
    status: string;
    params?: { variant?: GoVariant; reasoning_effort?: string };
  }>(join(out, run_id, 'manifest.json'));
  if (
    m.dry_run ||
    m.model !== model ||
    m.status !== 'complete' ||
    m.purpose !== 'go-smoke' ||
    m.params?.variant !== variant ||
    (variant && m.params?.reasoning_effort !== variant)
  )
    throw new Error('Missing completed live Go smoke');
  if (digest(readFileSync(join(out, run_id, 'raw/relay.jsonl'))) !== ledger_hash)
    throw new Error('Smoke ledger changed');
}

export function validSubscriptionLedger(file: string, variant?: GoVariant) {
  if (!existsSync(file)) return false;
  const rows = readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const begins = rows.filter((r) => r.event === 'begin');
  const ends = rows.filter((r) => r.event === 'end');
  const ended = new Map(ends.map((r) => [r.id, r]));
  const ids = new Set(begins.map((r) => r.id));
  return (
    ids.size > 0 &&
    ids.size === begins.length &&
    ended.size === ends.length &&
    ids.size === ended.size &&
    Array.from(ids).every((id) => typeof id === 'string' && ended.has(id)) &&
    (!variant || begins.every((row) => row.reasoning_effort === variant)) &&
    Array.from(ended.values()).every(
      (row) =>
        row.complete === true &&
        row.status === 200 &&
        row.usage?.cost === 0 &&
        ['go', 'go-plus'].includes(row.usage?.opencode?.billing_source) &&
        Number.isFinite(row.usage?.opencode?.allowance) &&
        row.usage.opencode.allowance >= 0,
    )
  );
}
