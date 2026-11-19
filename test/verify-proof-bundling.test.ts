// Bundlers emit a file that a module names in `new URL('literal', import.meta.url)`.
// verify-proof builds the path from a template literal, which bundlers treat
// differently: Vite and webpack 5.112 emit every file in the directory
// (LICENSES.txt too), webpack 5.98, Next.js's webpack and Parcel 2.16 leave a
// file: URL that a page cannot read, and Turbopack in Next.js 16.4 resolves
// every asset to LICENSES.txt, so verifier.wasm fails to compile in the page
// and in a route handler. Measured with the packed tarball on 2026-11-19
// (docs/browsers-and-bundlers.md).

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../src/verify-proof.ts', import.meta.url), 'utf8');

describe('verify-proof asset URLs', () => {
  it('names each verifier asset in a literal URL that bundlers can emit', () => {
    for (const asset of ['verifier.wasm', 'v2-cache.bin', 'v4-cache.bin']) {
      expect(source).toContain(`new URL('./verify-proof/${asset}', import.meta.url)`);
    }
    // A template literal makes bundlers guess, and they sweep in LICENSES.txt or pick it.
    expect(source).not.toMatch(/new URL\(`/);
  });
});
