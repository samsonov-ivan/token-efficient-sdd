import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stageReply } from '../packages/cli/dist/baseline.js';
import { replay } from '../packages/cli/dist/harness/replay.js';
import { runTaskSessions } from '../packages/cli/dist/task-sessions.js';

// Each run owns a new public fixture and its mock exports, outside the project.
const root = mkdtempSync(join(tmpdir(), 'frugal-handoff-'));
const repo = join(root, 'repo');
const changeId = 'publish-status-catalog';
const change = join(repo, 'openspec/changes', changeId);
const evidence = join(root, 'evidence');
const read = (file) => readFileSync(file, 'utf8');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const statuses = ['queued', 'ready'];
const catalog = JSON.stringify({ statuses }) + '\n';
const tasks =
  [
    '- [ ] 1.1 Publish a status catalog and hand off its path and SHA-256.',
    '- [ ] 1.2 Read the published catalog using the handoff and write a receipt with its statuses.',
  ].join('\n') + '\n';

mkdirSync(join(change, 'specs/catalog'), { recursive: true });
mkdirSync(join(repo, 'output'));
mkdirSync(evidence);
writeFileSync(join(change, 'tasks.md'), tasks);
writeFileSync(
  join(change, 'proposal.md'),
  'Let a second session consume a verified public catalog.\n',
);
writeFileSync(
  join(change, 'design.md'),
  'The producer chooses a content-addressed path. The consumer receives the path and checksum in the handoff.\n',
);
writeFileSync(
  join(change, 'specs/catalog/spec.md'),
  'The catalog SHALL contain the queued and ready statuses. The receipt SHALL reproduce the statuses in order.\n',
);

function publishCatalog() {
  const sha = hash(catalog);
  const artifact = `output/status-catalog-${sha.slice(0, 12)}.json`;
  return {
    answer: `Published the public status catalog.\nArtifact: ${artifact}\nSHA-256: ${sha}`,
    mutate: () => writeFileSync(join(repo, artifact), catalog),
  };
}

// The consumer discovers both values from the prompt delivered to its session.
function writeReceipt(prompt) {
  const artifact = /^Artifact: (output\/status-catalog-[a-f0-9]{12}\.json)$/m.exec(prompt)?.[1];
  const sha = /^SHA-256: ([a-f0-9]{64})$/m.exec(prompt)?.[1];
  assert.ok(artifact && sha, 'Task 1.2 did not receive the catalog path and checksum');
  const bytes = readFileSync(join(repo, artifact));
  assert.equal(hash(bytes), sha, 'The handed-off checksum does not match the catalog');
  const receipt = { artifact, sha256: sha, statuses: JSON.parse(bytes).statuses };
  return {
    answer:
      'Created the consumer receipt.\nArtifact: output/receipt.json\nVerified the catalog checksum.',
    mutate: () =>
      writeFileSync(join(repo, 'output/receipt.json'), JSON.stringify(receipt, null, 2) + '\n'),
  };
}

async function checkTask(taskId) {
  if (taskId === '1.1') {
    const files = readdirSync(join(repo, 'output'));
    assert.equal(files.length, 1, 'Producer must publish exactly one artifact');
    assert.equal(read(join(repo, 'output', files[0])), catalog);
  } else {
    const receipt = JSON.parse(read(join(repo, 'output/receipt.json')));
    assert.deepEqual(receipt.statuses, statuses);
    assert.equal(receipt.sha256, hash(readFileSync(join(repo, receipt.artifact))));
  }
  return { passed: true, summary: 'Public fixture check passed.' };
}

const opts = { repo, changeId, sessionPerTask: true, capsule: false, maxRetries: 0 };
await runTaskSessions(opts, {
  async apply({ taskId, prompt, sessionId }) {
    assert.ok(['1.1', '1.2'].includes(taskId), 'Unexpected fixture task');
    writeFileSync(join(evidence, `input-${taskId}.txt`), prompt);
    const result = replay(repo, changeId, evidence, 'handoff-demo', {
      stage: 'apply',
      task: taskId,
      args: [...(sessionId ? ['--session', sessionId] : []), '--', prompt],
      fixture: taskId === '1.1' ? publishCatalog() : writeReceipt(prompt),
    });
    writeFileSync(join(evidence, `events-${taskId}.jsonl`), result.stdout);
    const { session, answer } = stageReply(result);
    return { sessionId: session, handoff: answer };
  },
  checkTask,
});

function turn(taskId) {
  const events = read(join(evidence, `events-${taskId}.jsonl`))
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line));
  const finish = events.find((event) => event.type === 'step_finish');
  assert.ok(finish, `Missing completion for task ${taskId}`);
  const exported = JSON.parse(read(join(evidence, 'raw/exports', `${finish.sessionID}.json`)));
  assert.equal(exported.info.id, finish.sessionID);
  assert.equal(exported.messages.length, 1, 'Expected a fresh mock session');
  const [message] = exported.messages;
  assert.equal(message.info.id, finish.part.messageID);
  return {
    session: finish.sessionID,
    answer: message.parts.find((part) => part.type === 'text').text,
  };
}
const first = turn('1.1');
const second = turn('1.2');
assert.notEqual(first.session, second.session, 'Both tasks ran in the same session');
const handoff = read(join(change, 'handoff.md'));
const firstSection = handoff.split('\n## TASK-1.2\n')[0].trimEnd();
assert.equal(firstSection, '## TASK-1.1\n\n' + first.answer);
assert.ok(
  handoff.endsWith(`## TASK-1.2\n\n${second.answer}\n`),
  'Missing accepted consumer handoff',
);
assert.ok(
  read(join(evidence, 'input-1.2.txt')).includes(firstSection),
  'Next prompt lost the accepted handoff',
);
assert.equal(read(join(change, 'tasks.md')), tasks.replaceAll('[ ]', '[x]'));
const receipt = JSON.parse(read(join(repo, 'output/receipt.json')));

console.log(
  [
    'WP-07 / H-01 · открытая фикстура · mock/replay · session_per_task=true, capsule=false',
    `Задача 1.1 · ${first.session} · каталог опубликован и проверен`,
    '',
    firstSection,
    '',
    `Задача 1.2 · ${second.session} · во входе input-1.2.txt дословно воспроизведена запись из handoff.md`,
    `Прочитан ${receipt.artifact}. SHA-256 совпал.`,
    `В output/receipt.json записаны статусы: ${receipt.statuses.join(', ')}.`,
    '',
    'PASS · две разные сессии, передача проверена по файлу, входу и ответу.',
    `Артефакты: ${root}`,
  ].join('\n'),
);
