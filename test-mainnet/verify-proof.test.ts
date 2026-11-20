// Mainnet blocks whose proofs pearld accepted. Each is the smallest block
// (coinbase only) that shows one way a verifier built before zk-pow's matrix
// positions were computed in 64 bits failed on the chain: a thrown
// RangeError, a rejection or a panic.

import { describe, expect, it } from 'vitest';
import { verifyBlockProof } from '../src/verify-proof.js';
import { mainnetBlock } from './helpers.js';

describe('verifyBlockProof on mainnet', () => {
  it.each([
    [98976, 'a V2 proof that threw a RangeError'],
    [91600, 'a V2 proof the verifier called invalid'],
    [98800, 'a V2 proof that panicked as unreachable code'],
    [145267, 'a V3 proof the verifier called invalid'],
    [144600, 'a V3 proof that panicked with an index out of bounds'],
  ])('accepts the proof of block %i, %s', async (height) => {
    const verdict = await verifyBlockProof(mainnetBlock(height));
    expect(verdict).toEqual({ valid: true, outcome: 'accepted', message: 'Proof verified successfully' });
  });

  it('rejects the V1 proof of block 200 with the message of pearld\'s FFI on the fp8-scheme branch', async () => {
    const verdict = await verifyBlockProof(mainnetBlock(200));
    expect(verdict).toEqual({ valid: false, outcome: 'rejected', message: 'unsupported certificate version 1 for FFI verification' });
  });

  it('keeps its memory flat over many proofs in one process', async () => {
    // Before the patch freed each proof's circuit layout, the module kept some
    // 24 MB a proof and reached WebAssembly's 4 GB after about 250.
    const block = mainnetBlock(139000);
    expect((await verifyBlockProof(block)).outcome).toBe('accepted');
    const before = process.memoryUsage().external;
    let most = 0;
    for (let i = 0; i < 60; i += 1) {
      expect((await verifyBlockProof(block)).outcome).toBe('accepted');
      globalThis.gc?.();
      most = Math.max(most, process.memoryUsage().external - before);
    }
    expect(most).toBeLessThan(32 * 1024 * 1024);
  });
});
