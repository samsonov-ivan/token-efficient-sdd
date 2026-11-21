import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJson } from './io.js';

export type Stage = 'spec' | 'apply' | 'review' | 'fix' | 'verify';
export type Invocation = { stage: Stage; args: string[]; reviewIter?: number };
export function replay(
  repo: string,
  feature: string,
  runDir: string,
  runId: string,
  request: Invocation,
) {
  const { stage } = request;
  const change = join(repo, 'openspec/changes', feature);
  const session = `ses_${runId}_${stage}_${request.reviewIter ?? 0}`;
  const message = `msg_${session}`;
  const timestamp = Date.now();
  const base = { messageID: message, sessionID: session };
  // This fixture exercises the executor and telemetry only. It implements no benchmark behavior.
  if (stage === 'spec') {
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
  }
  if (stage === 'apply') {
    writeFileSync(
      join(change, 'tasks.md'),
      '## 1. Replay\n- [x] 1.1 Write the fixture marker (REQ-REPLAY-01).\n',
    );
    writeFileSync(join(repo, 'replay-marker.txt'), 'synthetic lifecycle fixture\n');
  }
  const content =
    stage === 'review'
      ? 'Reviewed the replay marker and checked the synthetic task.\nVERDICT: ACCEPT'
      : stage === 'verify'
        ? 'Checked the marker in the lifecycle fixture.\nVERIFY: PASS'
        : `Completed the synthetic ${stage} fixture.`;
  const tokens = { input: 11, output: 5, reasoning: 0, cache: { read: 0, write: 0 } };
  const parts = [
    { ...base, id: `start_${session}`, type: 'step-start' },
    { ...base, id: `text_${session}`, type: 'text', text: content },
    { ...base, id: `end_${session}`, type: 'step-finish', reason: 'stop', tokens, cost: 0 },
  ];
  writeJson(join(runDir, 'raw/exports', `${session}.json`), {
    info: { id: session, tokens },
    messages: [
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
            output: 'synthetic lifecycle fixture',
          },
        },
      }),
    );
  }
  return { code: 0, stderr: '', stdout: `${events.join('\n')}\n` };
}
