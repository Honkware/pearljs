// consensus.ts against every block of the run, setup blocks included:
// difficulty and work from each header's bits, the certificate version each
// height requires, and each coinbase paying exactly the subsidy plus the
// fees of its block. Runs after the files that fill the chain with
// transactions.

import { expect, it } from 'vitest';
import {
  bitsToTarget,
  blockSubsidy,
  checkCertificateRules,
  difficultyForBits,
  parseBlock,
  requiredCertVersion,
  targetToBits,
  totalSupply,
  workForBits,
} from '../src/index.js';
import type { PearlBlock } from '../src/index.js';
import { describeLive, network, pearld, spentOutputs } from './chain.js';

describeLive('consensus data', () => {
  it('matches pearld on difficulty, work, certificate version and coinbase value for every block', { timeout: 600_000 }, async () => {
    const info = await pearld.getBlockchainInfo();
    let minted = 0n;
    let withFees = 0;
    const versions = new Set<number>();
    let tip: PearlBlock | undefined;
    for (let height = 0; height <= info.blocks; height++) {
      const hash = await pearld.getBlockHash(height);
      const header = await pearld.getBlockHeader(hash);
      const block = parseBlock(await pearld.getRawBlock(hash));
      tip = block;

      expect(block.header.bits.toString(16)).toBe(header.bits);
      expect(difficultyForBits(block.header.bits, network)).toBe(header.difficulty);
      expect(targetToBits(bitsToTarget(block.header.bits))).toBe(block.header.bits);
      // CalcWork: at regtest's limit a block adds two units of work.
      expect(workForBits(block.header.bits)).toBe((1n << 256n) / (bitsToTarget(block.header.bits) + 1n));

      const [coinbase, ...rest] = block.transactions;
      const paid = coinbase!.outs.reduce((sum, out) => sum + out.value, 0n);
      // The genesis block is hardcoded: its certificate proves nothing and its coinbase is not a subsidy.
      if (height === 0) continue;
      checkCertificateRules(block.certificate, network, height);
      expect(block.certificate!.version).toBe(requiredCertVersion(network, height));
      versions.add(block.certificate!.version);

      let fees = 0n;
      for (const tx of rest) {
        const spent = await spentOutputs(tx);
        fees += spent.reduce((sum, prevout) => sum + prevout.value, 0n) - tx.outs.reduce((sum, out) => sum + out.value, 0n);
      }
      if (fees > 0n) withFees += 1;
      expect(paid, `coinbase of block ${height}`).toBe(blockSubsidy(network, height) + fees);
      minted += paid - fees;
    }
    expect(withFees).toBeGreaterThan(10);
    expect(versions).toEqual(new Set([3]));
    expect(minted).toBe(totalSupply(network, info.blocks));
    expect(difficultyForBits(tip!.header.bits, network)).toBe(await pearld.getDifficulty());
    expect(info.difficulty).toBe(difficultyForBits(tip!.header.bits, network));

    // A certificate of another version is refused in Pearl's words.
    expect(() => checkCertificateRules({ ...tip!.certificate!, version: 2 }, network, info.blocks)).toThrow(
      `certificate version 2 is not allowed at height ${info.blocks} (require version 3)`,
    );
  });

  it('predicts the next block as getblocktemplate describes it', async () => {
    const tip = await pearld.getBlockCount();
    const template = await pearld.getBlockTemplate();
    expect(template.height).toBe(tip + 1);
    expect(template.requiredcertversion).toBe(requiredCertVersion(network, tip + 1));
    const fees = template.transactions.reduce((sum, tx) => sum + tx.fee, 0n);
    expect(template.coinbasevalue).toBe(blockSubsidy(network, tip + 1) + fees);
    expect(difficultyForBits(parseInt(template.bits, 16), network)).toBe(await pearld.getDifficulty());
  });
});
