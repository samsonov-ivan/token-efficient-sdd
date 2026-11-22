// Capture only llama.cpp template/tokenize endpoints, or verify saved token IDs offline.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';

const [mode, directory, ...inputs] = process.argv.slice(2);
assert(
  ['--capture', '--verify'].includes(mode) && directory && inputs.length === 2,
  'Usage: node scripts/attribute-pilot-history.mjs --capture|--verify DIRECTORY PAIR_A PAIR_B',
);
const capture = mode === '--capture';
const out = resolve(directory);
const json = (f) => JSON.parse(readFileSync(f, 'utf8'));
const bytes = (x) => Buffer.byteLength(JSON.stringify(x));
const sha = (data) => createHash('sha256').update(data).digest('hex');
const sum = (xs, key) => xs.reduce((total, x) => total + x[key], 0);
const archives = inputs.map((dir) => ({ dir: resolve(dir), run: json(join(dir, 'run.json')) }));
for (const { dir, run } of archives) {
  assert.deepEqual(
    Object.keys(run.summary).sort(),
    ['fresh', 'shared'],
    'Both arms must be finished',
  );
  assert(existsSync(join(dir, 'fresh/final')) && existsSync(join(dir, 'shared/final')));
}
assert(new Set(archives.map((a) => basename(a.dir))).size === archives.length);
if (capture) mkdirSync(out, { mode: 0o700 });
async function local(endpoint, route, body) {
  assert(['/apply-template', '/tokenize'].includes(route));
  const url = new URL(endpoint);
  assert(
    url.protocol === 'http:' &&
      url.hostname === '127.0.0.1' &&
      url.port &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash,
  );
  const response = await fetch(new URL(route, url), {
    method: 'POST',
    redirect: 'error',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok)
    throw new Error(
      route + ' returned ' + response.status + ': ' + (await response.text()).slice(0, 400),
    );
  return response.json();
}
async function rendering(run, body) {
  const { prompt } = await local(run.endpoint, '/apply-template', body);
  assert(typeof prompt === 'string');
  const { tokens } = await local(run.endpoint, '/tokenize', {
    content: prompt,
    parse_special: true,
    add_special: true,
  });
  assert(Array.isArray(tokens) && tokens.every(Number.isSafeInteger));
  return { prompt, tokens };
}
const report = {
  kind: 'shared-apply-task-2-message-history',
  tokenization: { add_special: true, parse_special: true },
  archives: [],
};
for (const { dir, run } of archives) {
  const files = join(dir, 'shared/task-2/calls');
  const name = basename(dir);
  const rows = [];
  const prompts = [1, 2].map((i) => readFileSync(join(dir, `shared/task-${i}/prompt.txt`), 'utf8'));
  for (let t = 1; t <= 2; t++)
    assert.equal(prompts[t - 1], readFileSync(join(dir, `fresh/task-${t}/prompt.txt`), 'utf8'));
  const publicUser = (m, i) =>
    m.role === 'user' && [prompts[i], '"' + prompts[i] + '"'].includes(m.content);
  const firstCalls = readdirSync(join(dir, 'shared/task-1/calls'))
    .filter((f) => f.endsWith('.request.json'))
    .sort();
  const preceding = json(join(dir, 'shared/task-1/calls', firstCalls.at(-1))).messages;
  const freshDir = join(dir, 'fresh/task-2/calls');
  const firstFresh = json(join(freshDir, '0001.request.json')).messages;
  const lastText = readFileSync(join(dir, 'shared/task-1/native.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((x) => JSON.parse(x))
    .filter((e) => e.type === 'text')
    .at(-1)?.part.text;
  assert(
    firstFresh.some((m) => publicUser(m, 1)) &&
      firstFresh.every((m) => !publicUser(m, 0) && m.role !== 'assistant'),
  );
  for (const file of readdirSync(files)
    .filter((f) => f.endsWith('.request.json'))
    .sort()) {
    const attempt = file.split('.')[0];
    const wire = readFileSync(join(files, file));
    const actual = JSON.parse(wire);
    const meta = json(join(files, attempt + '.meta.json'));
    assert.equal(sha(wire), meta.request_sha256);
    const response = readFileSync(join(files, attempt + '.response'));
    assert.equal(sha(response), meta.response_sha256);
    const usageRecords = meta.content_type.includes('text/event-stream')
      ? response
          .toString()
          .split(/\r?\n/)
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
          .filter((l) => l && l !== '[DONE]')
          .map((s) => JSON.parse(s).usage)
          .filter(Boolean)
      : [JSON.parse(response).usage].filter(Boolean);
    assert.deepEqual(usageRecords.at(-1) ?? null, meta.usage);
    assert.equal(actual.model, run.model);
    const ms = actual.messages;
    const start = ms.findIndex((m) => publicUser(m, 0));
    const end = ms.findIndex((m) => publicUser(m, 1));
    assert(
      start >= 0 &&
        end > start &&
        ms.slice(0, start).every((m) => ['system', 'developer'].includes(m.role)),
    );
    assert.equal(ms.filter((m) => publicUser(m, 1)).length, 1);
    const removed = ms.slice(start, end);
    // Match the actual last task-1 request prefix. The remaining messages were produced at its end.
    assert.deepEqual(ms.slice(start, preceding.length), preceding.slice(start));
    assert(
      removed.some((m) => m.role === 'assistant') &&
        removed.slice(preceding.length - start).every((m) => m.role === 'assistant'),
    );
    if (lastText)
      assert.equal(
        removed.at(-1).content,
        lastText,
        'Repeated assistant text differs from native task 1',
      );
    const clipped = { ...actual, messages: [...ms.slice(0, start), ...ms.slice(end)] };
    const clippedWire = JSON.stringify(clipped);
    const freshFile = join(freshDir, file);
    let matchedFresh = null;
    if (existsSync(freshFile) && readFileSync(freshFile, 'utf8') === clippedWire) {
      const freshMeta = json(join(freshDir, attempt + '.meta.json'));
      assert.equal(freshMeta.request_sha256, sha(clippedWire));
      const freshResponse = readFileSync(join(freshDir, attempt + '.response'));
      assert.equal(freshMeta.response_sha256, sha(freshResponse));
      matchedFresh = {
        attempt,
        request_sha256: freshMeta.request_sha256,
        response_sha256: freshMeta.response_sha256,
        provider_prompt_tokens: freshMeta.usage?.prompt_tokens ?? null,
      };
    }
    const path = join(out, `${name}-${attempt}.json.gz`);
    let rendered;
    if (capture) {
      try {
        rendered = { full: await rendering(run, actual), clipped: await rendering(run, clipped) };
      } catch (error) {
        rendered = { error: String(error) };
      }
      writeFileSync(path, gzipSync(JSON.stringify(rendered)), { flag: 'wx' });
    } else rendered = JSON.parse(gunzipSync(readFileSync(path)));
    const counts = {};
    if (rendered.error) counts.render_error = rendered.error;
    else
      for (const key of ['full', 'clipped']) {
        const { prompt, tokens } = rendered[key];
        assert(
          typeof prompt === 'string' && Array.isArray(tokens) && tokens.every(Number.isSafeInteger),
        );
        counts[key] = {
          tokens: tokens.length,
          render_sha256: sha(prompt),
          token_ids_sha256: sha(JSON.stringify(tokens)),
        };
      }
    const promptTokens = meta.usage?.prompt_tokens;
    const agrees =
      meta.complete && Number.isSafeInteger(promptTokens) && counts.full?.tokens === promptTokens;
    if (matchedFresh && agrees)
      assert.equal(counts.clipped.tokens, matchedFresh.provider_prompt_tokens);
    rows.push({
      attempt,
      exact_fresh_request: matchedFresh,
      request_sha256: sha(wire),
      response_sha256: sha(response),
      clipped_request_sha256: sha(JSON.stringify(clipped)),
      tools_sha256: sha(JSON.stringify(actual.tools)),
      removed_range: [start, end],
      removed_roles: removed.map((m) => m.role),
      removed_sha256: sha(JSON.stringify(removed)),
      removed_message_count: removed.length,
      removed_wire_bytes: bytes(actual) - bytes(clipped),
      provider_prompt_tokens: promptTokens ?? null,
      ...counts,
      full_render_matches_provider: agrees,
      history_token_delta: agrees ? counts.full.tokens - counts.clipped.tokens : null,
    });
  }
  assert(rows.length > 0 && rows.length === json(join(dir, 'shared/task-2/result.json')).requests);
  const exact = rows.every((r) => r.full_render_matches_provider);
  report.archives.push({
    archive: name,
    model: run.model,
    controller_commit: run.controller_commit,
    requests: rows.length,
    repeated_message_occurrences: sum(rows, 'removed_message_count'),
    repeated_wire_bytes: sum(rows, 'removed_wire_bytes'),
    history_token_delta: exact ? sum(rows, 'history_token_delta') : null,
    rows,
  });
}
const reportFile = join(out, 'summary.json');
if (capture) writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
else assert.deepEqual(report, json(reportFile));
console.log(
  JSON.stringify(
    report.archives.map(({ rows, ...totals }) => totals),
    null,
    2,
  ),
);
