// Compiles examples/ and runs the ones that need no node, so an example that
// stops working fails `npm run check`. They import `pearljs` by name, which
// Node resolves to dist/ through the package's own exports: build first.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
const run = (args) => spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' }).status ?? 1;

if (!existsSync(join(root, 'dist/index.js'))) {
  console.error('examples: dist/ is missing; run `npm run build` first');
  process.exit(1);
}
if (run([tsc, '-p', 'tsconfig.examples.json']) !== 0) process.exit(1);

// An example that talks to a node says so in its header and is only compiled.
const names = readdirSync(join(root, 'examples')).filter((name) => name.endsWith('.ts')).sort();
const offline = names.filter((name) => !/^ \* Needs a running /m.test(readFileSync(join(root, 'examples', name), 'utf8')));
for (const name of offline) {
  console.log(`\n== examples/${name}`);
  if (run([join('dist-examples', 'examples', name.replace(/\.ts$/, '.js'))]) !== 0) {
    console.error(`examples: ${name} failed`);
    process.exit(1);
  }
}
console.log(`\nexamples: ran ${offline.length}, compiled ${names.length - offline.length} that need a node`);
