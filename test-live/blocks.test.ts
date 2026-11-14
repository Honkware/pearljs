// parseBlock on raw blocks from a regtest pearld: hashes, merkle roots,
// witness commitments, the certificate binding and Pearl's block vsize
// against what getblock reports.

import { expect, it } from 'vitest';
import {
  blockHashHex,
  blockSize,
  blockStrippedSize,
  blockVsize,
  checkCertificateBinding,
  checkMerkleRoot,
  checkWitnessCommitment,
  networks,
  parseBlock,
  serializeBlock,
  toOutputScript,
  transactionId,
  witnessCommitment,
} from '../src/index.js';
import type { PearlBlock } from '../src/index.js';
import { describeLive, fund, miner, network, pearld } from './chain.js';

interface VerboseBlock {
  hash: string;
  height: number;
  size: number;
  strippedsize: number;
  vsize: number;
  merkleroot: string;
  proofcommitment: string;
  tx: string[];
}

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
const reversedHex = (bytes: Uint8Array): string => hex(Uint8Array.from(bytes).reverse());

async function fetchBlock(hash: string): Promise<{ raw: string; block: PearlBlock; info: VerboseBlock }> {
  const raw = await pearld.getBlockHex(hash);
  // Verbose getblock has no typed method; getBlockHeader covers the header fields.
  const info = await pearld.call<VerboseBlock>('getblock', [hash, 1]);
  return { raw, block: parseBlock(await pearld.getRawBlock(hash)), info };
}

function expectMatchesPearld(raw: string, block: PearlBlock, info: VerboseBlock): void {
  expect(hex(serializeBlock(block))).toBe(raw);
  expect(blockHashHex(block.header)).toBe(info.hash);
  expect(reversedHex(block.header.merkleRoot)).toBe(info.merkleroot);
  expect(checkMerkleRoot(block)).toBe(true);
  expect(block.transactions.map(transactionId)).toEqual(info.tx);
  expect(blockVsize(block)).toBe(info.vsize);
  expect(blockStrippedSize(block)).toBe(info.strippedsize);
  expect(blockSize(block)).toBe(info.size);
}

describeLive('blocks', () => {
  it('parses the regtest genesis block, whose hardcoded certificate does not bind', async () => {
    const { raw, block, info } = await fetchBlock(await pearld.getBlockHash(0));
    expect(info.hash).toBe(networks.regtest.genesisHash);
    expectMatchesPearld(raw, block, info);
    expect(() => checkCertificateBinding(block)).toThrow();
  });

  it('parses a coinbase-only block with a V3 certificate bound to its header', async () => {
    const { raw, block, info } = await fetchBlock(await pearld.getBlockHash(1));
    expectMatchesPearld(raw, block, info);
    expect(block.certificate?.version).toBe(3);
    checkCertificateBinding(block);
    expect(reversedHex(block.header.proofCommitment)).toBe(info.proofcommitment);
    checkWitnessCommitment(block);
    expect(block.transactions[0]!.outs[0]!.script).toEqual(toOutputScript(miner.deriveAddress(0), network));
  });

  it('parses a block with a witness transaction and checks its witness commitment', async () => {
    const funding = await fund([{ script: toOutputScript(miner.deriveAddress(2), network), value: 1_000_000n }]);
    const { raw, block, info } = await fetchBlock(await pearld.getBestBlockHash());
    expectMatchesPearld(raw, block, info);
    expect(info.tx).toContain(transactionId(funding));
    expect(witnessCommitment(block)).not.toBeNull();
    checkWitnessCommitment(block);
    checkCertificateBinding(block);
  });
});
