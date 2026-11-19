// Mainnet blocks whose proofs pearld accepted. Each is the smallest block
// (coinbase only) that shows one way verifyBlockProof failed on the chain:
// the module's stack overflowing, in V8 or in the module's own memory, comes
// out as a thrown RangeError, a rejection or a panic depending on what the
// overflow overwrites.

import { describe, expect, it } from 'vitest';
import { verifyBlockProof } from '../src/verify-proof.js';
import { mainnetBlock } from './helpers.js';

describe('verifyBlockProof on mainnet', () => {
  it.each([
    [98976, 'a V2 proof that overflowed the native stack'],
    [91600, 'a V2 proof the verifier called invalid'],
    [98800, 'a V2 proof that panicked as unreachable code'],
    [145267, 'a V3 proof the verifier called invalid'],
    [144600, 'a V3 proof that panicked with an index out of bounds'],
  ])('accepts the proof of block %i, %s', async (height) => {
    const verdict = await verifyBlockProof(mainnetBlock(height));
    expect(verdict).toEqual({ valid: true, outcome: 'accepted', message: 'Proof verified successfully' });
  });

  it('accepts the V1 proof of block 200, which pearld verifies with its V1 verifier', async () => {
    const verdict = await verifyBlockProof(mainnetBlock(200));
    expect(verdict.outcome).toBe('accepted');
  });

  it('keeps accepting after many proofs in one process', async () => {
    // The module's memory grew by some 16 to 25 MB a proof until it reached
    // 4 GB and trapped, about every 250 proofs. Block 139000 verifies within
    // the module's stack, so only the growth is measured.
    const block = mainnetBlock(139000);
    expect((await verifyBlockProof(block)).outcome).toBe('accepted');
    const before = process.memoryUsage().external;
    for (let i = 0; i < 20; i += 1) await verifyBlockProof(block);
    expect(process.memoryUsage().external - before).toBeLessThan(64 * 1024 * 1024);
  });
});
