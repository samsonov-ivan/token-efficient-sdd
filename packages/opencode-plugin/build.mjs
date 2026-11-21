import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { build } from 'esbuild';

// The measurement harness installs just this entry file in a clean project.
const require = createRequire(import.meta.url);
const license = readFileSync(
  join(dirname(require.resolve('yaml/package.json')), 'LICENSE'),
  'utf8',
);
await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'neutral',
  external: ['node:*'],
  format: 'esm',
  target: 'node20',
  banner: { js: `/* yaml (https://github.com/eemeli/yaml)\n${license}*/` },
});
