// Clean build: stale files from renamed modules must not end up in the package.
import { spawnSync } from 'node:child_process';
import { cpSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';

const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
rmSync(new URL('../dist', import.meta.url), { recursive: true, force: true });
const { status } = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.build.json'], {
  cwd: new URL('..', import.meta.url),
  stdio: 'inherit',
});
if (status !== 0) process.exit(status ?? 1);
// pearljs/verify-proof reads these beside itself at run time; wasm/build.sh makes them.
cpSync(new URL('../src/verify-proof', import.meta.url), new URL('../dist/verify-proof', import.meta.url), { recursive: true });
