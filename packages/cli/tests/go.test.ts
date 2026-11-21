import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { smokeReceipt, validSubscriptionLedger } from '../src/harness/go.js';

it('requires matching completed requests, zero balance charges and a measured Go allowance', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'frugal-go-billing-')), 'ledger.jsonl');
  const begin = { event: 'begin', id: 'a' };
  const end = {
    event: 'end',
    id: 'a',
    status: 200,
    complete: true,
    usage: { cost: 0, opencode: { billing_source: 'go', allowance: 0.001 } },
  };
  const check = (...rows: unknown[]) => {
    writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n'));
    return validSubscriptionLedger(file);
  };
  expect(check(begin, end)).toBe(true);
  expect(check(begin, end, { ...begin, id: 'b' })).toBe(false);
  expect(check(begin, end, end)).toBe(false);
  expect(check(begin, { ...end, usage: { cost: 0.1, opencode: end.usage.opencode } })).toBe(false);
  expect(check(begin, { ...end, usage: { cost: 0, opencode: { billing_source: 'free' } } })).toBe(
    false,
  );
});

it('uses a separate smoke receipt for each variant and verifies all request efforts', () => {
  const out = mkdtempSync(join(tmpdir(), 'frugal-go-variant-'));
  const model = 'opencode-go/deepseek-v4.1-flash';
  expect(smokeReceipt(out, model, 'sha', 'max')).not.toBe(smokeReceipt(out, model, 'sha'));
  expect(smokeReceipt(out, model, 'sha', 'max')).not.toBe(smokeReceipt(out, model, 'sha', 'low'));
  const file = join(out, 'relay.jsonl');
  const begin = { id: 'one', event: 'begin', reasoning_effort: 'max' };
  const end = {
    id: 'one',
    event: 'end',
    complete: true,
    status: 200,
    usage: { cost: 0, opencode: { billing_source: 'go', allowance: 0.001 } },
  };
  writeFileSync(file, `${JSON.stringify(begin)}\n${JSON.stringify(end)}\n`);
  expect(validSubscriptionLedger(file, 'max')).toBe(true);
  expect(validSubscriptionLedger(file, 'low')).toBe(false);
});
