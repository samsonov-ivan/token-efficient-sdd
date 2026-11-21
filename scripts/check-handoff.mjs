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
function verifyExport(record, turns) {
  const messages = record.messages.filter((m) => m.type !== 'idle');
  assert.deepEqual(
    messages.map((m) => m.info?.role ?? m.type),
    turns.flatMap(() => ['user', 'assistant']),
  );
  const joinText = (parts) =>
    parts
      .filter((p) => p.type === 'text')
      .map((p) => p.text)
      .join('\n');
  const messageIds = new Set();
  for (const [index, turn] of turns.entries()) {
    assert.equal(record.info.id, turn.sessionId);
    const [user, assistant] = messages.slice(2 * index, 2 * index + 2);
    assert.equal(user.text ?? joinText(user.parts), turn.packet.latestUserText);
    assert.equal(joinText(assistant.parts ?? assistant.content), turn.answer);
    assert.equal(assistant.info?.providerID ?? assistant.model.providerID, 'frugal-fixture');
    assert.equal(assistant.info?.modelID ?? assistant.model.id, 'smoke');
    const events = turn.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.ok(
      !events.some((e) => e.type === 'tool_use'),
      'Fixture tasks must complete without tools',
    );
    const finishes = events.filter((e) => e.type === 'step_finish');
    assert.equal(finishes.length, 1);
    const finish = finishes[0];
    assert.equal(finish.sessionID, turn.sessionId);
    assert.equal(finish.part.reason, 'stop');
    assert.equal(finish.part.messageID, assistant.info?.id ?? assistant.id);
    assert.ok(finish.part.messageID && !messageIds.has(finish.part.messageID));
    messageIds.add(finish.part.messageID);
  }
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
    const retrySummary = 'PUBLIC-H01-HISTORY-CONTROL Confirm the value issued in the prior turn.';
    const handoffFile = join(change, 'handoff.md');
    await runTaskSessions(
      {
        repo: host.repo,
        changeId,
        sessionPerTask: true,
        capsule: false,
        maxRetries: 1,
      },
      {
        async apply({ taskId, attempt, sessionId, prompt }) {
          const stem = attempt === 1 ? taskId : `${taskId}-attempt-${attempt}`;
          await writeFile(join(dir, `input-${stem}.txt`), prompt);
          if (attempt === 2) {
            assert.equal(sessionId, turns[0].sessionId);
            assert.equal(await readFile(join(change, 'tasks.md'), 'utf8'), tasks);
            await assert.rejects(readFile(handoffFile), { code: 'ENOENT' });
            assert.ok(prompt.includes(retrySummary));
            assert.ok(!prompt.includes(reference(turns[0].answer)));
          } else {
            assert.equal(sessionId, undefined);
          }
          const result = await host.invoke(prompt, sessionId, `H01 task ${taskId}`);
          await writeFile(join(dir, `events-${stem}.jsonl`), result.stdout);
          turns.push({ ...result, taskId, attempt, prompt, packet: provider.requests.at(-1) });
          return { sessionId: result.sessionId, handoff: result.answer };
        },
        async checkTask(taskId) {
          const turn = turns.at(-1);
          const { attempt, packet } = turn;
          assert.equal(provider.requests.length, turns.length, 'Unexpected provider request');
          assert.equal(turn.taskId, taskId);
          assert.equal(packet.status, 200);
          assert.equal(packet.model, 'smoke');
          assert.equal(packet.responseContent, turn.answer);
          assert.ok(packet.latestUserText.includes(turn.prompt));
          assert.equal(packet.roles.filter((role) => role === 'user').length, attempt);
          assert.deepEqual(packet.assistantContents, attempt === 2 ? [turns[0].answer] : []);
          if (attempt === 1) assert.ok(!packet.roles.includes('assistant'));
          if (taskId === '1.1' && attempt === 1) {
            assert.equal(packet.kind, 'producer');
            assert.match(turn.answer, /^Published /);
            assert.ok(!packet.latestUserText.includes(reference(turn.answer)));
            return { passed: false, summary: retrySummary };
          }
          assert.equal(reference(turn.answer), reference(turns[0].answer));
          if (taskId === '1.1') {
            assert.equal(packet.kind, 'history');
            assert.match(turn.answer, /^Received /);
            assert.ok(!packet.latestUserText.includes(reference(turn.answer)));
          } else {
            assert.equal(packet.kind, 'consumer');
            const note = await readFile(handoffFile, 'utf8');
            assert.equal(note, `## TASK-1.1\n\n${turns[1].answer}\n`);
            assert.equal(
              await readFile(join(change, 'tasks.md'), 'utf8'),
              tasks.replace('[ ]', '[x]'),
            );
            assert.ok(packet.latestUserText.includes(note.trimEnd()));
            assert.ok(!packet.latestUserText.includes(turns[0].answer.split('\n')[0]));
          }
          return { passed: true, summary: 'Native handoff and provider request matched.' };
        },
      },
    );
    assert.deepEqual(
      turns.map((t) => [t.taskId, t.attempt]),
      [
        ['1.1', 1],
        ['1.1', 2],
        ['1.2', 1],
      ],
    );
    const [producer, retry, consumer] = turns;
    assert.equal(retry.sessionId, producer.sessionId);
    assert.notEqual(producer.sessionId, consumer.sessionId);
    assert.equal(await readFile(join(change, 'tasks.md'), 'utf8'), tasks.replaceAll('[ ]', '[x]'));
    assert.equal(
      await readFile(handoffFile, 'utf8'),
      `## TASK-1.1\n\n${retry.answer}\n\n## TASK-1.2\n\n${consumer.answer}\n`,
    );
    const sessions = [[producer, retry], [consumer]];
    for (const group of sessions) {
      const exported = await host.exportSession(group[0].sessionId);
      await save(join(dir, `export-${group[0].taskId}.json`), exported);
      verifyExport(exported, group);
    }

    const withoutNote = consumer.prompt.replace(
      `## TASK-1.1\n\n${retry.answer}\n`,
      'No handoff has been recorded.',
    );
    assert.ok(!withoutNote.includes(reference(producer.answer)));
    await writeFile(join(dir, 'input-missing.txt'), withoutNote);
    let failure;
    await assert.rejects(host.invoke(withoutNote, undefined, 'H01 missing handoff'), (error) => {
      failure = error;
      return typeof error.stdout === 'string' && error.stdout.trim().length > 0;
    });
    await writeFile(join(dir, 'events-missing.jsonl'), failure.stdout);
    await writeFile(join(dir, 'events-missing.stderr'), failure.stderr ?? '');
    const errors = failure.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .filter((event) => event.type === 'error');
    assert.equal(errors.length, 1);
    const negativeSession = errors[0].sessionID;
    assert.ok(negativeSession && !turns.some((turn) => turn.sessionId === negativeSession));
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
    assert.equal(rejected.roles.filter((role) => role === 'user').length, 1);
    assert.equal(
      provider.requests.length,
      4,
      'Expected three task attempts and a fresh negative control',
    );
    return {
      version,
      model: 'frugal-fixture/smoke',
      producer: producer.sessionId,
      consumer: consumer.sessionId,
      reference: reference(producer.answer),
      distinct_sessions: true,
      handoff_verified: true,
      exports_verified: sessions.length,
      gate_retry: true,
      task_attempts: Object.fromEntries(sessions.map((group) => [group[0].taskId, group.length])),
      provider_requests_sha256: createHash('sha256')
        .update(JSON.stringify(provider.requests, null, 2) + '\n')
        .digest('hex'),
      continuation_verified: true,
      missing_handoff_session: negativeSession,
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
    `PASS · гейт отклонил первую попытку; повтор получил историю; новая сессия получила принятый handoff; без него провайдер вернул HTTP ${check.missing_handoff_http_status}.`,
  );
}
await save(join(root, 'summary.json'), {
  fixture: 'public-reference',
  endpoint: 'loopback',
  node: process.version,
  checks,
});
