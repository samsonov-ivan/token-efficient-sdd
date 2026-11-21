import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize } from 'node:path';

export function safePath(path: string) {
  return (
    typeof path === 'string' &&
    path.length > 0 &&
    !isAbsolute(path) &&
    normalize(path) === path &&
    !path.includes('\\') &&
    path.split('/').every((part) => part !== '..' && part !== '.' && part !== '.git')
  );
}
export class Snapshot {
  readonly commit: string;
  readonly tree: string;
  readonly files = new Map<string, string>();
  private readonly cache = new Map<string, string>();
  constructor(readonly repo: string) {
    this.commit = this.git(['rev-parse', '--verify', 'HEAD^{commit}']).trim();
    this.tree = this.git(['rev-parse', '--verify', 'HEAD^{tree}']).trim();
    for (const entry of this.git(['ls-tree', '-rz', '--full-tree', this.commit])
      .split('\0')
      .filter(Boolean)) {
      const match = /^100(?:644|755) blob ([a-f0-9]+)\t([\s\S]+)$/.exec(entry);
      if (match && safePath(match[2])) this.files.set(match[2], match[1]);
      else if (entry.includes('\topenspec/'))
        throw new Error('OpenSpec contains a nonregular file');
    }
  }
  private git(args: string[]) {
    return execFileSync('git', ['-C', this.repo, ...args], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' },
    });
  }
  read(path: string) {
    const hash = this.files.get(path);
    if (!hash) throw new Error(`Missing tracked regular file: ${path}`);
    let content = this.cache.get(hash);
    if (content === undefined) {
      content = this.git(['cat-file', 'blob', hash]);
      this.cache.set(hash, content);
    }
    return content;
  }
  materializeOpenSpec(dir: string, change: string) {
    for (const path of this.files.keys()) {
      if (!path.startsWith('openspec/')) continue;
      if (path.startsWith('openspec/changes/') && !path.startsWith(`openspec/changes/${change}/`))
        continue;
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), this.read(path));
    }
  }
}
export function isTestFile(path: string) {
  return (
    /(?:^|\/)(?:__tests__|(?:hidden_)?tests?|src\/test)(?:\/|$)/i.test(path) ||
    /(?:^test_|_test\.|\.(?:test|spec)\.|Tests?\.(?:java|kt)$)/i.test(basename(path))
  );
}
