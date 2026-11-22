import { createHash, type KeyLike, verify as verifySignature } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { scenarioPattern } from './change.js';
import { isTestFile, type Snapshot } from './snapshot.js';
import { inspectSuites } from './suites.js';
import type { Change, Evidence, Expected, SourceRef } from './types.js';

const extensions = new Set([
  '.py',
  '.java',
  '.js',
  '.mjs',
  '.ts',
  '.tsx',
  '.jsx',
  '.go',
  '.kt',
  '.cjs',
]);
const assertLine =
  /^(?:assert\s|(?:await\s+)?(?:expect|assert\w*|self\.assert\w+)\s*\(|with\s+pytest\.raises\s*\(|(?:t\.(?:Errorf|Fatalf)|assert\.\w+)\s*\()/;
const words = (s: string) => new Set(s.match(/[A-Za-z_]\w*/g) ?? []);
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
interface Candidate {
  test: string;
  path: string;
  scenarios: string[];
  tasks: string[];
  assertions: SourceRef[];
  code_candidates: SourceRef[];
}
function publicTests(snapshot: Snapshot, ids: string[]) {
  const decls: { symbol: string; ref: SourceRef }[] = [];
  const tests: string[] = [];
  for (const path of snapshot.files.keys()) {
    if (!extensions.has(extname(path))) continue;
    if (isTestFile(path)) {
      tests.push(path);
      continue;
    }
    const lines = snapshot.read(path).split(/\r?\n/);
    for (const [i, line] of lines.entries()) {
      const symbol =
        /(?:\b(?:class|def|function|func|const)\s+|^\s*(?:public|private|protected|static)\s+(?:\w+\s+)+)([A-Za-z_]\w*)/.exec(
          line,
        )?.[1];
      if (symbol) decls.push({ symbol, ref: { path, line: i + 1, text: line.trim() } });
    }
  }
  const candidates: Candidate[] = [];
  for (const path of tests.sort()) {
    const lines = snapshot.read(path).split(/\r?\n/);
    for (const test of ids) {
      const name = test.split('::').at(-1)?.replace(/\[.*$/, '')?.replace(/\(\)$/, '') ?? test;
      const ext = extname(path);
      let start = -1,
        end = lines.length;
      if (ext === '.py') {
        if (!test.split('::')[0].split('.').includes(basename(path, '.py'))) continue;
        start = lines.findIndex((s) => /^\s*(?:async\s+)?def\s+(\w+)\s*\(/.exec(s)?.[1] === name);
        if (start < 0) continue;
        const indent = lines[start].search(/\S/);
        const next = lines.findIndex(
          (s, i) => i > start && s.trim() && s.search(/\S/) <= indent && !s.trim().startsWith('#'),
        );
        end = next < 0 ? lines.length : next;
        while (start > 0 && /^\s*@/.test(lines[start - 1])) start--;
      } else if (ext === '.go') {
        start = lines.findIndex(
          (s) => /^func\s+(Test\w+)\s*\(/.exec(s)?.[1] === name.split('/')[0],
        );
        const next = lines.findIndex((s, i) => i > start && /^func\s+/.test(s));
        if (next >= 0) end = next;
      } else if (ext === '.java') {
        start = lines.findIndex((s) => /\bvoid\s+(\w+)\s*\(/.exec(s)?.[1] === name);
        const next = lines.findIndex((s, i) => i > start && /\bvoid\s+\w+\s*\(/.test(s));
        if (next >= 0) end = next;
      } else {
        const testTitle = (line: string) =>
          /\b(?:it|test)(?:\.\w+)?\s*\(\s*["'\x60]([^"'\x60]+)["'\x60]/.exec(line)?.[1];
        start = lines.findIndex((s) => {
          const title = testTitle(s);
          return !!title && test.endsWith(title);
        });
        const next = lines.findIndex((s, i) => i > start && !!testTitle(s));
        if (next >= 0) end = next;
      }
      if (start < 0) continue;
      const body = lines.slice(start, end).join('\n');
      const syms = words(body);
      const assertions = lines
        .slice(start, end)
        .flatMap((line, i) =>
          assertLine.test(line.trim()) ? [{ path, line: start + i + 1, text: line.trim() }] : [],
        );
      const tags = `${body}\n${test}`;
      candidates.push({
        test,
        path,
        scenarios: [...new Set(tags.match(scenarioPattern) ?? [])].sort(),
        tasks: [
          ...new Set(
            Array.from(tags.matchAll(/(?:\bTASK-|\btask\(["'])(\d+(?:\.\d+)+)/g), (m) => m[1]),
          ),
        ].sort(),
        assertions,
        code_candidates: decls.filter((d) => syms.has(d.symbol)).map((d) => d.ref),
      });
    }
  }
  return candidates;
}
export function prepareRequest(
  snapshot: Snapshot,
  change: Change,
  expected: Expected,
  ev: Evidence,
  evidenceDir: string,
) {
  if (ev.final_commit !== snapshot.commit)
    throw new Error('Cannot prepare evaluation for a stale final_commit');
  const suites = inspectSuites(ev.suites, evidenceDir);
  const request = {
    version: 1,
    final_commit: snapshot.commit,
    final_tree: snapshot.tree,
    obligations: expected,
    change,
    public_suites: ev.suites.filter((s) => s.kind === 'public'),
    public_results: suites.public,
    ...(ev.review_protocol ? { review_protocol: ev.review_protocol } : {}),
    review: ev.review,
    candidates: publicTests(
      snapshot,
      Object.keys(suites.public.cases)
        .filter((id) => suites.public.cases[id] === 'passed')
        .sort(),
    ),
    source_files: [...snapshot.files.keys()].filter((path) => extensions.has(extname(path))).sort(),
    instructions: [
      'Review each required scenario against the actual design and implementation, including bounds, error behavior and cross-file constraints.',
      'Read the tracked file at the stated commit (git show COMMIT:PATH). Candidates are suggestions. Inspect the actual code, assertion, and passing test before accepting a link.',
      'Return version, request_sha256, final_commit, reviewer, semantic[{requirement,verdict,reason}] and links[{scenario,task,test,code:{path,line,text},assertion:{path,line,text}}].',
      'For missing artifact IDs return aliases[{kind,path,text,parent?,id,reason}] matching missingIds exactly. For implicit requirement references in design/tasks cite artifact_links[{path,line,text,task?,refs,reason}]. Preserve each independent justification.',
      'A confirmed link missing a marker requires inferred:true and reason. Cite a discrepancy using verdict:fail. No hidden test contents are needed.',
    ],
  };
  return { ...request, request_sha256: digest(JSON.stringify(request)) };
}
export function verifyAssessmentSignature(bytes: Buffer, signature: Buffer, key: KeyLike) {
  if (!verifySignature(null, bytes, key, signature))
    throw new Error('Invalid assessment signature');
}

export function importAssessment(
  request: ReturnType<typeof prepareRequest>,
  ev: Evidence,
  path: string,
  signature?: string,
  key?: string,
): Evidence {
  const bytes = readFileSync(path);
  if ((signature || key) && !(signature && key))
    throw new Error('Supply both a detached --signature and trusted --reviewer-key');
  if (signature && key)
    verifyAssessmentSignature(bytes, readFileSync(signature), readFileSync(key));
  const data = JSON.parse(bytes.toString('utf8'));
  if (
    data.version !== 1 ||
    data.request_sha256 !== request.request_sha256 ||
    data.final_commit !== ev.final_commit ||
    typeof data.reviewer !== 'string' ||
    !data.reviewer.trim()
  )
    throw new Error('Assessment not bound to this request, reviewer and final commit');
  if (!Array.isArray(data.semantic) || !Array.isArray(data.links))
    throw new Error('Assessment missing semantic judgments or source links');
  return {
    ...ev,
    semantic: data.semantic,
    links: data.links,
    aliases: data.aliases,
    artifact_links: data.artifact_links,
    exempt_tasks: data.exempt_tasks,
  };
}
