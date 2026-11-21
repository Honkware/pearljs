// pearljs/verify-proof on blocks a regtest pearld mined: each proof pearld's
// miner made verifies, at the header's bits and as a share at regtest's own
// limit, and fails with a flipped proof byte or a harder target.

import { expect, it } from 'vitest';
import { parseBlock } from '../../src/index.js';
import { verifyBlockProof, verifyProof } from '../../src/verify-proof.js';
import { describeLive, mine, pearld } from './chain.js';

describeLive('verify-proof', () => {
  it('verifies the proofs of blocks pearld mined and refuses them tampered', async () => {
    for (const hash of await mine(3)) {
      const block = parseBlock(await pearld.getRawBlock(hash));
      const certificate = block.certificate!;
      expect(await verifyBlockProof(block)).toEqual({ valid: true, outcome: 'accepted', message: 'Proof verified successfully' });
      expect((await verifyBlockProof(block, { bits: 0x207fffff })).valid).toBe(true);

      const proof = Uint8Array.from(certificate.proof);
      proof[proof.length >> 1]! ^= 1;
      const flipped = await verifyProof(block.header, { ...certificate, proof });
      expect(flipped.outcome).toBe('rejected');
      expect(flipped.message).toBe(certificate.version === 4
        ? 'compact fp8 proof does not verify against the expected statement (mismatched header/statement or an invalid proof)'
        : 'Proof Invalid');
      expect(await verifyBlockProof(block, { bits: 0x1d00ffff })).toEqual({
        valid: false,
        outcome: 'rejected',
        message: 'Jackpot condition not satisfied: hash does not meet difficulty target',
      });
    }
  });
});
