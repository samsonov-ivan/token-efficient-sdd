import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parse } from 'yaml';
import { readChange } from './change.js';
import { importAssessment, prepareRequest } from './reviewer.js';
import { Snapshot } from './snapshot.js';
import { type Evidence, type Expected, message } from './types.js';
import { consistencyErrors, evaluate, validateExpected } from './verify.js';

function write(out: string, file: string, data: string) {
  mkdirSync(out, { recursive: true });
  const tmp = join(out, `.${file}.${randomUUID()}`);
  writeFileSync(tmp, data);
  renameSync(tmp, join(out, file));
}
function json(out: string, file: string, data: unknown) {
  write(out, file, `${JSON.stringify(data, null, 2)}\n`);
}
function external(repo: string, input: string) {
  const f = realpathSync(input);
  const path = relative(repo, f);
  if (!isAbsolute(path) && !path.startsWith('..' + '/'))
    throw new Error(
      'Independent evidence and expectations must be outside the evaluated repository',
    );
  return f;
}
export function qualityCommand(command: 'trace' | 'consistency' | 'gates', argv: string[]) {
  let out: string | undefined;
  let commit: string | undefined;
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        repo: { type: 'string' },
        change: { type: 'string' },
        expected: { type: 'string' },
        out: { type: 'string' },
        evidence: { type: 'string' },
        openspec: { type: 'string' },
        capability: { type: 'string' },
        prepare: { type: 'boolean' },
        assessment: { type: 'string' },
        signature: { type: 'string' },
        'reviewer-key': { type: 'string' },
        infer: { type: 'boolean' },
        help: { type: 'boolean' },
      },
    });
    if (values.help) {
      console.log(
        `frugal ${command} [change] --repo DIR --expected FILE --out DIR [--evidence FILE] [--infer] [--prepare | --assessment FILE] [--signature FILE --reviewer-key FILE] [--openspec BIN] [--capability ID]`,
      );
      return 0;
    }
    const changeId = values.change ?? positionals[0];
    if (
      !changeId ||
      !values.expected ||
      !values.out ||
      positionals.length > (values.change ? 0 : 1)
    )
      throw new Error('Supply a change ID, --expected FILE and --out DIR');
    const repo = realpathSync(values.repo ?? '.');
    out = resolve(values.out);
    const snapshot = new Snapshot(repo);
    commit = snapshot.commit;
    const expected = parse(readFileSync(external(repo, values.expected), 'utf8')) as Expected;
    validateExpected(expected);
    const bundled = fileURLToPath(
      new URL('../../../../node_modules/.bin/openspec', import.meta.url),
    );
    const openspec = resolve(values.openspec ?? bundled);
    if (!existsSync(openspec)) throw new Error(`Missing pinned OpenSpec binary: ${openspec}`);
    const change = readChange(snapshot, changeId, openspec, values.capability);
    if (command === 'consistency' && !values.evidence) {
      const errors = consistencyErrors(change, expected);
      json(out, 'consistency.json', {
        version: 1,
        final_commit: commit,
        structural_ok: !errors.length,
        semantic: 'unverified',
        errors,
        warnings: change.warnings,
      });
      if (errors.length) console.error(errors.join('\n'));
      return errors.length ? 1 : 0;
    }
    if (!values.evidence) throw new Error('Supply independent --evidence FILE');
    const file = external(repo, values.evidence);
    let evidence = JSON.parse(readFileSync(file, 'utf8')) as Evidence;
    if (values.prepare || values.assessment) {
      if (values.prepare && values.assessment) throw new Error('Choose --prepare or --assessment');
      const request = prepareRequest(snapshot, change, expected, evidence, dirname(file));
      if (values.prepare) {
        json(out, 'evaluator-request.json', request);
        return 0;
      }
      if (!values.assessment) throw new Error('Missing --assessment FILE');
      evidence = importAssessment(
        request,
        evidence,
        external(repo, values.assessment),
        values.signature && external(repo, values.signature),
        values['reviewer-key'] && external(repo, values['reviewer-key']),
      );
    } else if (values.signature || values['reviewer-key'])
      throw new Error('Signed input requires --assessment');
    const result = evaluate(change, expected, evidence, snapshot, dirname(file), !!values.infer);
    const { gates, trace } = result;
    if (command !== 'consistency') json(out, 'trace.json', trace);
    let errors: string[];
    if (command === 'trace') errors = trace.errors;
    else if (command === 'consistency') {
      errors = [...gates.checks.consistency.errors, ...gates.checks.semantic.errors];
      json(out, 'consistency.json', {
        version: 1,
        final_commit: commit,
        ok: !errors.length,
        errors,
        warnings: change.warnings,
      });
    } else {
      json(out, 'gates.json', gates);
      errors = gates.errors;
    }
    write(out, `${command}.md`, [...errors, ...change.warnings].map((s) => `- ${s}\n`).join(''));
    if (errors.length) console.error(errors.join('\n'));
    return errors.length ? 1 : 0;
  } catch (e) {
    const reason = message(e);
    if (out) {
      json(out, `${command}.json`, {
        version: 1,
        final_commit: commit ?? null,
        ok: false,
        errors: [reason],
      });
      write(out, `${command}.md`, `- ${reason}\n`);
      if (command === 'gates')
        json(out, 'trace.json', {
          version: 1,
          final_commit: commit ?? null,
          rows: [],
          errors: [reason],
        });
    }
    console.error(reason);
    return 1;
  }
}
