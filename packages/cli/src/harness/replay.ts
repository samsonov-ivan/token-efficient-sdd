import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, writeJson } from './io.js';

export type Stage = 'spec' | 'apply' | 'review' | 'fix' | 'verify';
export type Invocation = {
  stage: Stage;
  args: string[];
  reviewIter?: number;
  attempt?: number;
  task?: string;
  fixture?: { answer: string; mutate?: () => void; inspection?: string };
};
export type ReplayResult = {
  code: number;
  stderr: string;
  stdout: string;
  replayAnswer?: string;
  replaySessionId?: string;
};

export function invocationStem(
  request: Pick<Invocation, 'stage' | 'task' | 'reviewIter' | 'attempt'>,
) {
  const { stage, task, reviewIter, attempt = 1 } = request;
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error('Invalid invocation attempt');
  const stem = `${stage}-${task ?? reviewIter ?? 0}`;
  return attempt === 1 ? stem : `${stem}-attempt-${attempt}`;
}
const unitUsage = { input: 11, output: 5, reasoning: 0, cache: { read: 0, write: 0 } };
type SessionExport = { info: { id: string; tokens: typeof unitUsage }; messages: unknown[] };

function sessionFor(runDir: string, runId: string, request: Invocation) {
  const delimiter = request.args.indexOf('--');
  const options = delimiter === -1 ? request.args : request.args.slice(0, delimiter);
  const position = options.indexOf('--session');
  const fresh = `ses_${runId}_${request.stage}_${request.task ?? request.reviewIter ?? 0}`;
  const id = position === -1 ? fresh : options[position + 1];
  if (!id || !/^ses_[a-zA-Z0-9_.-]+$/.test(id) || options.lastIndexOf('--session') !== position)
    throw new Error('Invalid replay --session argument');
  const fileFor = (session: string) => join(runDir, 'raw/exports', `${session}.json`);
  if (position >= 0) {
    if (!existsSync(fileFor(id))) throw new Error(`Unknown replay session: ${id}`);
    const stored = readJson<SessionExport>(fileFor(id));
    if (stored.info.id !== id || !Array.isArray(stored.messages) || !stored.messages.length)
      throw new Error(`Invalid replay session export: ${id}`);
    return { session: id, file: fileFor(id), messages: stored.messages };
  }
  let session = fresh;
  for (let i = 2; existsSync(fileFor(session)); i++) session = `${fresh}_fresh_${i}`;
  return { session, file: fileFor(session), messages: [] };
}

export function replay(
  repo: string,
  feature: string,
  runDir: string,
  runId: string,
  request: Invocation,
) {
  const { stage, fixture } = request;
  const change = join(repo, 'openspec/changes', feature);
  const { session, file, messages } = sessionFor(runDir, runId, request);
  const turn = messages.length + 1;
  const suffix = turn === 1 ? session : `${session}:${turn}`;
  const message = `msg_${suffix}`;
  const timestamp = Date.now();
  const base = { messageID: message, sessionID: session };
  // This fixture exercises the executor and telemetry only. It implements no benchmark behavior.
  if (fixture) fixture.mutate?.();
  else if (stage === 'spec') {
    mkdirSync(join(change, 'specs', 'replay'), { recursive: true });
    writeFileSync(
      join(change, 'proposal.md'),
      '## Why\n\nExercise the replay fixture.\n\n## What Changes\n\nAdd a replay marker.\n',
    );
    writeFileSync(join(change, 'design.md'), '## Decisions\n\nPersist a replay marker.\n');
    writeFileSync(
      join(change, 'specs/replay/spec.md'),
      '## ADDED Requirements\n\n### Requirement: REQ-REPLAY-01 Replay marker\nThe fixture SHALL persist a marker.\n\n#### Scenario: SCN-REPLAY-01 marker\n- **WHEN** replay runs\n- **THEN** the marker exists\n',
    );
    writeFileSync(
      join(change, 'tasks.md'),
      '## 1. Replay\n- [ ] 1.1 Write the fixture marker (REQ-REPLAY-01).\n',
    );
  } else if (stage === 'apply') {
    writeFileSync(
      join(change, 'tasks.md'),
      '## 1. Replay\n- [x] 1.1 Write the fixture marker (REQ-REPLAY-01).\n',
    );
    writeFileSync(join(repo, 'replay-marker.txt'), 'synthetic lifecycle fixture\n');
  }
  const content =
    fixture?.answer ??
    (stage === 'review'
      ? 'Reviewed the replay marker and checked the synthetic task.\nVERDICT: ACCEPT'
      : stage === 'verify'
        ? 'Checked the marker in the lifecycle fixture.\nVERIFY: PASS'
        : `Completed the synthetic ${stage} fixture.`);
  const tokens = unitUsage;
  const parts = [
    { ...base, id: `start_${suffix}`, type: 'step-start' },
    { ...base, id: `text_${suffix}`, type: 'text', text: content },
    { ...base, id: `end_${suffix}`, type: 'step-finish', reason: 'stop', tokens, cost: 0 },
  ];
  writeJson(file, {
    info: {
      id: session,
      tokens: { ...tokens, input: turn * tokens.input, output: turn * tokens.output },
    },
    messages: [
      ...messages,
      {
        info: {
          id: message,
          role: 'assistant',
          providerID: 'mock',
          modelID: 'replay',
          time: { created: timestamp, completed: timestamp },
        },
        parts,
      },
    ],
  });
  const events = parts.map((part) =>
    JSON.stringify({ type: part.type.replace('-', '_'), timestamp, sessionID: session, part }),
  );
  if (stage === 'review' || stage === 'verify') {
    events.splice(
      1,
      0,
      JSON.stringify({
        type: 'tool_use',
        timestamp,
        sessionID: session,
        part: {
          ...base,
          type: 'tool',
          tool: 'read',
          state: {
            status: 'completed',
            input: { filePath: 'replay-marker.txt' },
            output: fixture?.inspection ?? 'synthetic lifecycle fixture',
          },
        },
      }),
    );
  }
  return {
    code: 0,
    stderr: '',
    stdout: `${events.join('\n')}\n`,
    replayAnswer: content,
    replaySessionId: session,
  };
}
