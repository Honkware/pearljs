// Loading pearljs/verify-proof's assets: a missing file and any file whose
// SHA-256 digest is not the one pinned refuse with
// PROOF_VERIFIER_UNAVAILABLE, wherever locate points. A file of its own, so
// the verifiers loaded here do not reach the other tests.

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadProofVerifier } from '../src/verify-proof.js';
import type { ProofVerifierAsset } from '../src/verify-proof.js';

const shipped = (asset: ProofVerifierAsset): URL => new URL(`../src/verify-proof/${asset}`, import.meta.url);

describe('loadProofVerifier', () => {
  it('refuses with PROOF_VERIFIER_UNAVAILABLE when the module cannot be read', async () => {
    await expect(loadProofVerifier([3], { locate: (asset) => new URL(`./missing/${asset}`, import.meta.url) })).rejects.toMatchObject({
      code: 'PROOF_VERIFIER_UNAVAILABLE',
      message: expect.stringContaining('cannot load verifier.wasm'),
    });
  });

  // A directory holding the shipped files with one of them replaced.
  const serving = (asset: ProofVerifierAsset, bytes: Uint8Array) => {
    const dir = mkdtempSync(join(tmpdir(), 'pearljs-verify-proof-'));
    for (const file of ['verifier.wasm', 'v2-cache.bin', 'v4-cache.bin'] as const) writeFileSync(join(dir, file), file === asset ? bytes : readFileSync(shipped(file)));
    return (file: ProofVerifierAsset) => pathToFileURL(join(dir, file));
  };

  it('refuses a module that is not the one pinned, before compiling it', async () => {
    // The smallest valid module, which exports nothing.
    const locate = serving('verifier.wasm', Uint8Array.of(0, 0x61, 0x73, 0x6d, 1, 0, 0, 0));
    await expect(loadProofVerifier([3], { locate })).rejects.toMatchObject({
      code: 'PROOF_VERIFIER_UNAVAILABLE',
      message: expect.stringMatching(/^verifier\.wasm from file:.* has SHA-256 [0-9a-f]{64}, not the [0-9a-f]{64} this pearljs pins$/),
    });
  });

  it('refuses a V2 cache with one byte changed', async () => {
    const bytes = Uint8Array.from(readFileSync(shipped('v2-cache.bin')));
    bytes[bytes.length >> 1]! ^= 1;
    await expect(loadProofVerifier([2], { locate: serving('v2-cache.bin', bytes) })).rejects.toMatchObject({
      code: 'PROOF_VERIFIER_UNAVAILABLE',
      message: expect.stringContaining('v2-cache.bin from file:'),
    });
  });

  it('refuses a V4 cache that is another file, even once a verifier is loaded from elsewhere', async () => {
    await loadProofVerifier([3], { locate: shipped });
    await expect(loadProofVerifier([4], { locate: (asset) => shipped(asset === 'v4-cache.bin' ? 'v2-cache.bin' : asset) })).rejects.toMatchObject({
      code: 'PROOF_VERIFIER_UNAVAILABLE',
      message: expect.stringContaining('v4-cache.bin from file:'),
    });
  });

  it('applies a locate only to the load it is passed to', async () => {
    // A verifier is loaded by now; its V4 cache is not.
    await expect(loadProofVerifier([4], { locate: (asset) => new URL(`./missing/${asset}`, import.meta.url) })).rejects.toMatchObject({ code: 'PROOF_VERIFIER_UNAVAILABLE' });
    await expect(loadProofVerifier([4])).resolves.toBeUndefined();
  });

  it('loads every version from the shipped files', async () => {
    await expect(loadProofVerifier([2, 3, 4], { locate: shipped })).resolves.toBeUndefined();
  });
});

describe('verifier.wasm', () => {
  it('names no directory of the machine that built it, so another machine can rebuild it byte for byte', () => {
    const text = new TextDecoder('latin1').decode(readFileSync(shipped('verifier.wasm')));
    expect(text).not.toMatch(/\/(private\/)?tmp\/|\/Users\/|\/home\//);
    expect(text).toContain('/build/zk-pow/src/');
  });
});

