// wasm/build.sh compiles whatever Pearl source PEARL_FP8 points at. Audit 5,
// finding 6: nothing named or checked the commit the committed verifier came
// from. pearl-source.txt names it, and the build refuses other source.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import proofs from '../vectors/mining/proofs.json';

const build = fileURLToPath(new URL('../wasm/build.sh', import.meta.url));
const source = readFileSync(new URL('../wasm/pearl-source.txt', import.meta.url), 'utf8');

describe('the Pearl source of the verifier build', () => {
  it('is named by commit and tree, the commit the proof vectors were made at', () => {
    expect(source).toMatch(/^commit [0-9a-f]{40}$/m);
    expect(source).toMatch(/^tree [0-9a-f]{64}$/m);
    expect(/^commit (\S+)$/m.exec(source)![1]).toBe(proofs.commit);
  });

  it('refuses a source tree other than the one named unless PEARL_COMMIT is given', () => {
    const pearl = mkdtempSync(join(tmpdir(), 'pearljs-source-'));
    try {
      for (const dir of ['zk-pow', 'plonky2', 'pearl-blake3']) {
        mkdirSync(join(pearl, dir));
        writeFileSync(join(pearl, dir, 'lib.rs'), `// ${dir}\n`);
      }
      writeFileSync(join(pearl, 'LICENSE'), 'licence\n');
      let refusal = '';
      try {
        execFileSync('sh', [build, '--check-source'], { env: { ...process.env, PEARL_FP8: pearl, PEARL_COMMIT: '' }, stdio: 'pipe' });
      } catch (err) {
        refusal = String((err as { stderr: Buffer }).stderr);
      }
      expect(refusal).toContain('the Pearl source in wasm/pearl-source.txt');
      expect(() => execFileSync('sh', [build, '--check-source'], { env: { ...process.env, PEARL_FP8: pearl, PEARL_COMMIT: 'not-a-commit' }, stdio: 'pipe' })).toThrow();
    } finally {
      rmSync(pearl, { recursive: true, force: true });
    }
  });
});
