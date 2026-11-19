// pearljs/mining on a regtest pearld: the block skeleton built from
// getblocktemplate is the block pearld's own miner makes from the same
// template, byte for byte once its certificate is sealed in; the work rules
// pass on the blocks it mines; and, when PEARL_PROVER names the prover built
// from vectors/mining/prove (zkpow.Mine, pearld's own), pearld accepts a block
// pearljs assembled with its own payout and text around a proof of its header.

import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';
import {
  blockHashHex,
  blockSkeleton,
  certificateSeeds,
  checkBlockWork,
  checkCertificateBinding,
  checkCertificateRules,
  checkJackpot,
  checkMerkleRoot,
  checkWitnessCommitment,
  coinbaseText,
  createPsbt,
  createTransaction,
  finalizePsbt,
  miningJob,
  parseBlock,
  sealBlock,
  serializeBlock,
  serializeBlockHeader,
  toOutputScript,
} from '../src/index.js';
import type { BlockSkeleton, PearlBlock } from '../src/index.js';
import { addChange, broadcast, describeLive, fund, live, miner, network, pearld } from './chain.js';

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
const prover = process.env.PEARL_PROVER;

async function tipBlock(): Promise<{ block: PearlBlock; height: number }> {
  const height = await pearld.getBlockCount();
  return { block: parseBlock(await pearld.getRawBlock(await pearld.getBlockHash(height))), height };
}

describeLive('mining', () => {
  it('builds from a template the block pearld mines from it', async () => {
    // A spend in the mempool, so the template carries a transaction with a witness.
    const minerScript = toOutputScript(miner.deriveAddress(0), network);
    const funding = await fund([{ script: minerScript, value: 200_000n }]);
    const spend = createTransaction(2);
    spend.addInput(funding.getHash(), 0);
    addChange(spend, 200_000n, [{ type: 'keyPath' }]);
    const psbt = createPsbt(spend);
    miner.prepareInput(psbt, 0, { index: 0, value: 200_000n });
    miner.signInput(psbt, 0, { index: 0 });
    const signed = finalizePsbt(psbt);
    await broadcast(signed);

    const template = await pearld.getBlockTemplate({ capabilities: ['coinbasevalue'] });
    expect(template.transactions.map((tx) => tx.txid)).toContain(signed.getId());
    const skeleton = blockSkeleton(template, { network, payTo: miner.deriveAddress(0) });
    const job = miningJob(skeleton);
    expect(hex(job.incompleteHeader)).toBe(hex(serializeBlockHeader(skeleton.header).subarray(0, 76)));

    const [hash] = await pearld.generate(1);
    const mined = parseBlock(await pearld.getRawBlock(hash!));
    expect(mined.transactions.map((tx) => tx.getId())).toEqual(skeleton.transactions.map((tx) => tx.getId()));
    expect(hex(mined.transactions[0]!.toBuffer())).toBe(hex(skeleton.transactions[0]!.toBuffer()));
    expect(hex(mined.header.merkleRoot)).toBe(hex(skeleton.header.merkleRoot));
    expect([mined.header.version, hex(mined.header.prevBlock), mined.header.bits]).toEqual([skeleton.header.version, hex(skeleton.header.prevBlock), skeleton.header.bits]);
    expect(coinbaseText(mined.transactions[0]!.ins[0]!.script)).toBe('/P2SH/pearld/');

    // pearld picks its own time when it mines; with it, the sealed skeleton is pearld's block.
    const timed: BlockSkeleton = { ...skeleton, header: { ...skeleton.header, timestamp: mined.header.timestamp } };
    const sealed = sealBlock(timed, { publicData: mined.certificate!.publicData, proof: mined.certificate!.proof });
    expect(hex(serializeBlock(sealed))).toBe(hex(serializeBlock(mined)));
    expect(blockHashHex(sealed.header)).toBe(hash);
  });

  it('passes the work rules on the blocks pearld mined, and fails them at a harder target', async () => {
    const { block, height } = await tipBlock();
    checkCertificateBinding(block);
    checkCertificateRules(block.certificate, network, height);
    checkBlockWork(block, network, height);
    const certificate = block.certificate!;
    if (certificate.version !== 4) {
      const seeds = certificateSeeds(certificate, block.header);
      expect(seeds.a).toHaveLength(32);
    }
    expect(() => checkJackpot(certificate, 0x03000001)).toThrow(expect.objectContaining({ code: 'JACKPOT_ABOVE_TARGET' }));
  });

  it.skipIf(prover === undefined || live?.fp8 !== false)('has pearld accept a block pearljs assembled around a proof from pearld\'s prover', async () => {
    const template = await pearld.getBlockTemplate({ capabilities: ['coinbasevalue'] });
    const payTo = miner.deriveAddress(5);
    const skeleton = blockSkeleton(template, { network, payTo, text: 'pearljs mining test', extraNonce: 7n });
    const [publicData, proof] = execFileSync(prover!, [hex(serializeBlockHeader(skeleton.header)), String(skeleton.certVersion)], { encoding: 'utf8' })
      .trim().split('\n').map((line) => Uint8Array.from(Buffer.from(line, 'hex')));
    const block = sealBlock(skeleton, { publicData: publicData!, proof: proof! });
    checkMerkleRoot(block);
    checkWitnessCommitment(block);
    checkBlockWork(block, network, skeleton.height);

    await pearld.submitBlock(serializeBlock(block));
    expect(await pearld.getBestBlockHash()).toBe(blockHashHex(block.header));
    const stored = parseBlock(await pearld.getRawBlock(blockHashHex(block.header)));
    expect(coinbaseText(stored.transactions[0]!.ins[0]!.script)).toBe('pearljs mining test');
    expect(hex(stored.transactions[0]!.outs[0]!.script)).toBe(hex(toOutputScript(payTo, network)));
  });
});

