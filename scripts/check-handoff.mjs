import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTaskSessions } from '../packages/cli/dist/task-sessions.js';
import { startHandoffProvider } from './fixtures/handoff-provider.mjs';
import { openTaskHost } from './fixtures/native-task-host.mjs';

const changeId = 'confirm-delivery';
const tasks = [
  '- [ ] 1.1 PUBLIC-H01-PRODUCER Publish a new fixture reference in the handoff.',
  '- [ ] 1.2 PUBLIC-H01-CONSUMER Confirm the reference received in the handoff.',
  '',
].join('\n');
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n');

function reference(text) {
  const match = /^Reference: (h01-[0-9a-f]{32})$/m.exec(text);
  assert.ok(match, 'Missing fixture reference in the assistant reply');
  return match[1];
}

// V2 session export represents completion as a third, idle record. The CLI
// step_finish message ID links the assistant turn to storage on both hosts.
function verifyExport(record, turn, deliveredText) {
  assert.equal(record.info.id, turn.sessionId);
  const messages = record.messages.filter((m) => m.type !== 'idle');
  assert.deepEqual(
    messages.map((m) => m.info?.role ?? m.type),
    ['user', 'assistant'],
  );
  const [user, assistant] = messages;
  const joinText = (parts) =>
    parts
      .filter((p) => p.type === 'text')
      .map((p) => p.text)
      .join('\n');
  assert.equal(user.text ?? joinText(user.parts), deliveredText);
  assert.equal(joinText(assistant.parts ?? assistant.content), turn.answer);
  assert.equal(assistant.info?.providerID ?? assistant.model.providerID, 'frugal-fixture');
  assert.equal(assistant.info?.modelID ?? assistant.model.id, 'smoke');
  const events = turn.stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.ok(!events.some((e) => e.type === 'tool_use'), 'Fixture tasks must complete without tools');
  const finishes = events.filter((e) => e.type === 'step_finish');
  assert.equal(finishes.length, 1);
  assert.equal(finishes[0].part.reason, 'stop');
  assert.equal(finishes[0].part.messageID, assistant.info?.id ?? assistant.id);
}

async function probe(version, root) {
  const dir = join(root, version);
  await mkdir(dir);
  const provider = await startHandoffProvider();
  try {
    const host = await openTaskHost(version, dir, provider.url);
    const change = join(host.repo, 'openspec/changes', changeId);
    await mkdir(join(change, 'specs/reference'), { recursive: true });
    await writeFile(
      join(change, 'proposal.md'),
      'Confirm transfer of a freshly issued public reference.\n',
    );
    await writeFile(
      join(change, 'design.md'),
      'The producer returns a three-line handoff. The consumer echoes the supplied reference.\n',
    );
    await writeFile(
      join(change, 'specs/reference/spec.md'),
      'The confirmation SHALL contain the reference issued for this run.\n',
    );
    await writeFile(join(change, 'tasks.md'), tasks);
    const turns = [];
    const options = {
      repo: host.repo,
      changeId,
      sessionPerTask: true,
      capsule: false,
      maxRetries: 0,
    };
    await runTaskSessions(options, {
      async apply({ taskId, sessionId, prompt }) {
        const result = await host.invoke(prompt, sessionId, `H01 task ${taskId}`);
        turns.push(result);
        await writeFile(join(dir, `input-${taskId}.txt`), prompt);
        await writeFile(join(dir, `events-${taskId}.jsonl`), result.stdout);
        return { sessionId: result.sessionId, handoff: result.answer };
      },
      async checkTask(taskId) {
        const turn = turns.at(-1);
        const packet = provider.requests.at(-1);
        assert.equal(
          provider.requests.length,
          turns.length,
          'Unexpected background request or retry',
        );
        assert.equal(packet.kind, taskId === '1.1' ? 'producer' : 'consumer');
        assert.equal(packet.status, 200);
        assert.equal(packet.model, 'smoke');
        assert.equal(packet.responseContent, turn.answer);
        assert.equal(packet.roles.filter((role) => role === 'user').length, 1);
        assert.ok(
          !packet.roles.includes('assistant'),
          'New session received a previous assistant turn',
        );
        assert.ok(
          packet.latestUserText.includes(await readFile(join(dir, `input-${taskId}.txt`), 'utf8')),
        );
        const ref = reference(turn.answer);
        if (taskId === '1.1') assert.ok(!packet.latestUserText.includes(ref));
        else {
          const accepted = await readFile(join(change, 'handoff.md'), 'utf8');
          assert.equal(accepted, `## TASK-1.1\n\n${turns[0].answer}\n`);
          assert.ok(
            packet.latestUserText.includes(accepted.trimEnd()),
            'Handoff did not reach the model',
          );
          assert.equal(ref, reference(turns[0].answer));
        }
        return { passed: true, summary: 'Provider request and native assistant response matched.' };
      },
    });
    assert.equal(turns.length, 2);
    const [producer, consumer] = turns;
    assert.notEqual(producer.sessionId, consumer.sessionId);
    assert.equal(await readFile(join(change, 'tasks.md'), 'utf8'), tasks.replaceAll('[ ]', '[x]'));
    for (const [index, turn] of turns.entries()) {
      const exported = await host.exportSession(turn.sessionId);
      const taskId = `1.${index + 1}`;
      await save(join(dir, `export-${taskId}.json`), exported);
      verifyExport(exported, turn, provider.requests[index].latestUserText);
    }

    const continued = await host.invoke(
      'PUBLIC-H01-HISTORY-CONTROL Confirm the reference from our earlier exchange.',
      producer.sessionId,
      'H01 history control',
    );
    assert.equal(continued.sessionId, producer.sessionId);
    assert.equal(reference(continued.answer), reference(producer.answer));
    const history = provider.requests.at(-1);
    assert.equal(history.kind, 'history');
    assert.equal(history.status, 200);
    assert.ok(history.assistantContents.includes(producer.answer));
    assert.ok(!history.latestUserText.includes(reference(producer.answer)));
    await writeFile(join(dir, 'events-history.jsonl'), continued.stdout);

    const secondPrompt = await readFile(join(dir, 'input-1.2.txt'), 'utf8');
    const withoutNote = secondPrompt.replace(producer.answer, '');
    assert.ok(!withoutNote.includes(reference(producer.answer)));
    let errorEvents;
    await assert.rejects(host.invoke(withoutNote, undefined, 'H01 missing handoff'), (error) => {
      errorEvents = error.stdout;
      return typeof errorEvents === 'string' && errorEvents.trim().length > 0;
    });
    await writeFile(join(dir, 'input-missing.txt'), withoutNote);
    await writeFile(join(dir, 'events-missing.jsonl'), errorEvents);
    const rejected = provider.requests.at(-1);
    assert.equal(rejected.kind, 'consumer');
    assert.equal(
      rejected.status,
      400,
      'Missing handoff must reach and be rejected by the provider',
    );
    assert.match(rejected.responseContent, /reference in the latest user message/);
    assert.ok(rejected.latestUserText.includes(withoutNote));
    assert.ok(!rejected.roles.includes('assistant'));
    assert.equal(provider.requests.length, 4, 'Expected two task requests and two controls');
    return {
      version,
      model: 'frugal-fixture/smoke',
      producer: producer.sessionId,
      consumer: consumer.sessionId,
      reference: reference(producer.answer),
      distinct_sessions: true,
      handoff_verified: true,
      exports_verified: turns.length,
      provider_requests_sha256: createHash('sha256')
        .update(JSON.stringify(provider.requests, null, 2) + '\n')
        .digest('hex'),
      continuation_verified: true,
      missing_handoff_http_status: rejected.status,
      requests: provider.requests.length,
    };
  } finally {
    await save(join(dir, 'provider-requests.json'), provider.requests);
    await provider.close();
  }
}

const root = await mkdtemp(join(await realpath(tmpdir()), 'frugal-native-h01-'));
console.log(`Артефакты проверки: ${root}`);
const checks = [];
for (const version of ['1.19.6', '2.3.2']) {
  const check = await probe(version, root);
  checks.push(check);
  console.log(
    `OpenCode ${version} · ${check.producer} → ${check.consumer} · передан ${check.reference}`,
  );
  console.log(
    `PASS · новая сессия получила handoff; продолженная сессия получила историю; без handoff локальный провайдер вернул HTTP ${check.missing_handoff_http_status}.`,
  );
}
await save(join(root, 'summary.json'), {
  fixture: 'public-reference',
  endpoint: 'loopback',
  node: process.version,
  checks,
});
