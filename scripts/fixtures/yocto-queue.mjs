// Public deterministic responses for the pinned yocto-queue checkout.
import assert from 'node:assert/strict';
import { copyFileSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { digest, git, readJson } from '../../packages/cli/dist/harness/io.js';

export const feature = 'add-peek-last';
export const brief =
  'Add peekLast() to yocto-queue. Return the last value without changing size or order. Empty and cleared queues return undefined. Test multiple items, removing the last item, and the public TypeScript return type.';
const firstSummary = 'Implemented peekLast() and its AVA runtime test.\nReference: ';
const spec =
  '## ADDED Requirements\n\n### Requirement: REQ-QUEUE-01 Inspect the last element\nThe queue SHALL return the tail value without changing size or iteration order, or undefined when empty. Its public type SHALL be ValueType | undefined.\n\n#### Scenario: SCN-QUEUE-01.1 Nonempty queue\n- **WHEN** called with several enqueued items\n- **THEN** the tail is returned with size and order preserved\n\n#### Scenario: SCN-QUEUE-01.2 Empty queue\n- **WHEN** the queue is new, cleared, or the final item is removed\n- **THEN** peekLast() returns undefined\n';
const runtimeTest = `
test('.peekLast()', t => {
	const queue = new Queue();
	t.is(queue.peekLast(), undefined);
	const last = {value: 2};
	queue.enqueue(1);
	queue.enqueue(last);
	t.is(queue.peekLast(), last);
	t.is(queue.peekLast(), last);
	t.is(queue.size, 2);
	t.deepEqual([...queue], [1, last]);
	t.is(queue.dequeue(), 1);
	t.is(queue.peekLast(), last);
	t.is(queue.dequeue(), last);
	t.is(queue.peekLast(), undefined);
	queue.enqueue(false);
	t.is(queue.peekLast(), false);
	queue.clear();
	t.is(queue.peekLast(), undefined);
	t.is(queue.size, 0);
});
`;
const typeTest =
  '\nexpectType<string | undefined>(queue.peekLast());\nexpectType<number | undefined>(new Queue<number>().peekLast());\n';

export function yoctoFixture({ project, repo, runDir, execute, env, reference, read, write }) {
  const pinned = readJson(join(project, 'bench/portability/repos.json'))['yocto-queue'];
  const cacheRoot = join(homedir(), '.cache/frugal-sdd/portability');
  const mirror = process.env.YOCTO_MIRROR || join(cacheRoot, 'yocto-queue-72a8fa9');
  const cache = process.env.YOCTO_NPM_CACHE || join(cacheRoot, 'npm-cache');
  const change = `openspec/changes/${feature}`;
  const sources = ['index.js', 'index.d.ts', 'test.js', 'index.test-d.ts', 'readme.md'];
  const input = {};
  const logs = {};
  const firstNote =
    firstSummary + reference + '\nNext: declare the generic return type and document the method.';
  const tracked = ['index.d.ts', 'index.js', 'index.test-d.ts', 'readme.md', 'test.js'];
  async function check(label, binary, args, cwd = repo, expectedCode = 0) {
    let stdout, stderr, code;
    try {
      ({ stdout, stderr } = await execute(binary, args, { ...env, npm_config_cache: cache }, cwd));
      code = 0;
    } catch (error) {
      ({ stdout = '', stderr = '', code } = error);
    }
    writeFileSync(join(runDir, label + '.log'), stdout + stderr);
    logs[label] = { command: [basename(binary), ...args], code, sha256: digest(stdout + stderr) };
    assert.equal(code, expectedCode, `${label}: ${stdout}\n${stderr}`);
    return stdout + stderr;
  }
  const tail = (file, addition) => [read(file), write(file, input[file] + addition)];
  function insert(file, before, content) {
    assert.equal(input[file].split(before).length, 2, `Ambiguous patch for ${file}`);
    return [
      read(file),
      {
        name: 'edit',
        args: { filePath: join(repo, file), oldString: before, newString: content + before },
      },
    ];
  }
  const specFiles = {
    'proposal.md':
      '## Why\n\nClients need to inspect the last queued item without consuming it.\n\n## What Changes\n\nAdd peekLast() with public declarations and documentation.\n\n## Impact\n\nAffects the Queue API, tests and the readme.\n',
    'design.md':
      '## Decisions\n\nRead the existing tail node in constant time. Match peek() on empty queues. Preserve the generic element type.\n',
    'specs/queue/spec.md': spec,
    'tasks.md':
      '## 1. Implementation\n\n- [ ] 1.1 Implement the runtime method and cover queue transitions with AVA. REQ-QUEUE-01 SCN-QUEUE-01.1 SCN-QUEUE-01.2\n- [ ] 1.2 Publish the generic type, tsd coverage and API documentation. REQ-QUEUE-01 SCN-QUEUE-01.1 SCN-QUEUE-01.2\n',
  };
  const observations = sources.concat(Object.keys(specFiles).map((name) => join(change, name)));
  return {
    feature,
    brief,
    firstNote,
    async setup() {
      git(repo, ['clone', '--quiet', '--local', '--no-hardlinks', mirror, '.']);
      git(repo, ['checkout', '--quiet', '--detach', pinned.commit]);
      assert.equal(git(repo, ['rev-parse', 'HEAD']), pinned.commit);
      for (const file of sources) input[file] = readFileSync(join(repo, file), 'utf8');
      assert(
        !input['index.js'].includes('peekLast(') && !input['index.d.ts'].includes('peekLast('),
      );
      copyFileSync(
        join(project, 'bench/portability/yocto-queue/package-lock.json'),
        join(repo, 'package-lock.json'),
      );
      await check('install', 'npm', [
        'ci',
        '--offline',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
      ]);
      unlinkSync(join(repo, 'package-lock.json'));
      assert.match(await check('upstream-before', 'npm', ['test']), /7 tests passed/);
      assert.equal(git(repo, ['status', '--porcelain']), '');
    },
    actions(request) {
      if (request.stage === 'spec')
        return [
          ...Object.entries(specFiles).map(([file, content]) => write(join(change, file), content)),
          'Created proposal, design, requirement scenarios and tasks.',
        ];
      if (request.stage === 'apply' && request.task === '1.1')
        return [
          ...insert(
            'index.js',
            '\tclear() {',
            '\tpeekLast() {\n\t\treturn this.#tail?.value;\n\t}\n\n',
          ),
          ...tail('test.js', runtimeTest),
          firstNote,
        ];
      if (request.stage === 'apply' && request.task === '1.2')
        return [
          ...insert(
            'index.d.ts',
            '\t/**\n\tClear the queue.',
            '\t/**\n\tGet the last value without removing it, or undefined if empty.\n\t*/\n\tpeekLast(): ValueType | undefined;\n\n',
          ),
          ...tail('index.test-d.ts', typeTest),
          ...insert(
            'readme.md',
            '#### `.drain()`',
            '#### `.peekLast()`\n\nGet the last value without removing it. An empty queue returns `undefined`.\n\n',
          ),
          'Published the generic return type and its tsd checks.\nDocumented empty queues and nondestructive access.\nTests: AVA and tsd.',
        ];
      if (request.stage === 'review' || request.stage === 'verify')
        return [
          ...observations.map(read),
          request.stage === 'review'
            ? 'Reviewed implementation, public types, tests, docs and the change specification.\nVERDICT: ACCEPT'
            : 'Inspected the completed change against both queue scenarios and the public API.\nVERIFY: PASS',
        ];
      throw new Error('Unexpected portability stage: ' + request.stage);
    },
    async gate(id) {
      if (id === '1.1') {
        assert.match(
          await check('gate-runtime', process.execPath, [
            'node_modules/ava/cli.js',
            '--match=.peekLast()',
            'test.js',
          ]),
          /1 test passed/,
        );
      } else {
        assert.equal(id, '1.2');
        assert(readFileSync(join(repo, 'index.test-d.ts'), 'utf8').endsWith(typeTest));
        await check('gate-types', process.execPath, ['node_modules/tsd/dist/cli.js']);
      }
      return {
        passed: true,
        summary:
          id === '1.1'
            ? 'AVA peekLast queue transitions passed.'
            : 'tsd public generic type checks passed.',
      };
    },
    async finish(openspec, tree) {
      const original = join(dirname(repo), 'negative-control');
      git(repo, ['clone', '--quiet', '--local', '--no-hardlinks', repo, original]);
      assert.equal(git(original, ['rev-parse', 'HEAD']), pinned.commit);
      symlinkSync(join(repo, 'node_modules'), join(original, 'node_modules'), 'dir');
      for (const file of ['test.js', 'index.test-d.ts'])
        copyFileSync(join(repo, file), join(original, file));
      assert.match(
        await check(
          'negative-runtime',
          process.execPath,
          ['node_modules/ava/cli.js', '--match=.peekLast()', 'test.js'],
          original,
          1,
        ),
        /peekLast is not a function/,
      );
      assert.match(
        await check(
          'negative-types',
          process.execPath,
          ['node_modules/tsd/dist/cli.js'],
          original,
          1,
        ),
        /peekLast does not exist|Property .peekLast. does not exist/,
      );
      assert.match(await check('upstream-after', 'npm', ['test']), /8 tests passed/);
      assert.equal(readFileSync(join(repo, 'test.js'), 'utf8'), input['test.js'] + runtimeTest);
      assert.equal(
        readFileSync(join(repo, 'index.test-d.ts'), 'utf8'),
        input['index.test-d.ts'] + typeTest,
      );
      await check('openspec-strict', openspec, ['validate', feature, '--strict']);
      assert.deepEqual(git(repo, ['diff', '--name-only', 'HEAD']).split('\n'), tracked);
      writeFileSync(
        join(runDir, 'upstream.patch'),
        git(repo, ['diff', '--binary', 'HEAD', tree, '--', ...tracked]) + '\n',
      );
      return {
        upstream: pinned.url,
        commit: pinned.commit,
        input_tree: git(repo, ['rev-parse', 'HEAD^{tree}']),
        deps_lock_sha256: digest(
          readFileSync(join(project, 'bench/portability/yocto-queue/package-lock.json')),
        ),
        node: process.version,
        openspec: (await execute(openspec, ['--version'])).stdout.trim(),
        public_tests_fail_on_unmodified_upstream: ['javascript', 'typescript'],
        changed_upstream_files: tracked,
        upstream_ava_before: 7,
        upstream_ava_after: 8,
        tsd_before_after: true,
        original_tests_preserved: true,
        openspec_strict: true,
        checks: logs,
      };
    },
  };
}
