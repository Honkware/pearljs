// Bundlers emit a file that a module names in `new URL('literal', import.meta.url)`.
// With a template literal they differed: Vite and webpack 5.112 emitted every
// file in the directory (LICENSES.txt too), webpack 5.98, Next.js's webpack and
// Parcel 2.16 left a file: URL that a page cannot read, and Turbopack in
// Next.js 16.4 resolved every asset to LICENSES.txt. Measured with the packed
// tarball on 2026-11-19. With one literal per asset, Vite 7.3.8, webpack 5.112.2
// and 5.98.0, Parcel 2.16.4 and Next.js 16.4.6 (Turbopack and webpack) each
// emitted all four files, v1-cache.bin included, and not LICENSES.txt
// (2026-11-20).

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../src/verify-proof.ts', import.meta.url), 'utf8');

describe('verify-proof asset URLs', () => {
  it('names each verifier asset in a literal URL that bundlers can emit', () => {
    for (const asset of ['verifier.wasm', 'v1-cache.bin', 'v2-cache.bin', 'v4-cache.bin']) {
      expect(source).toContain(`new URL('./verify-proof/${asset}', import.meta.url)`);
    }
    // A template literal makes bundlers guess, and they sweep in LICENSES.txt or pick it.
    expect(source).not.toMatch(/new URL\(`/);
  });
});
