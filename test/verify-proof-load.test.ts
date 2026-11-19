// Loading pearljs/verify-proof's assets: a missing file and a cache other
// than the one Pearl's verifier pins both refuse with
// PROOF_VERIFIER_UNAVAILABLE. A file of its own, so the locate set here does
// not reach the other tests.

import { readFileSync } from 'node:fs';
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

  it('refuses a V4 cache whose digest is not the one zk-pow pins', async () => {
    await expect(loadProofVerifier([4], { locate: (asset) => shipped(asset === 'v4-cache.bin' ? 'v2-cache.bin' : asset) })).rejects.toMatchObject({
      code: 'PROOF_VERIFIER_UNAVAILABLE',
      message: 'V4 verifier cache digest mismatch',
    });
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

