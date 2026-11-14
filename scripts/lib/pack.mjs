// Shared by the pack and browser checks: pack the package and install the tarball
// into a fresh project, the way a consumer would.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../..', import.meta.url));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

export function run(cmd, args, options = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...options });
}

/** Pack into a new temp directory. Returns the tarball path and npm's file list. */
export function pack() {
  const dir = mkdtempSync(join(tmpdir(), 'pearljs-pack-'));
  const out = run(npm, ['pack', '--json', '--pack-destination', dir], { cwd: root });
  const [info] = JSON.parse(out);
  return { dir, tarball: join(dir, info.filename), files: info.files.map((f) => f.path), info };
}

/** Make a fresh ESM project that depends on the tarball. */
export function installTarball(tarball, name = 'consumer') {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `pearljs-${name}-`)));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, private: true, type: 'module' }));
  run(npm, ['install', '--no-audit', '--no-fund', tarball], { cwd: dir });
  mkdirSync(join(dir, 'src'), { recursive: true });
  return dir;
}
