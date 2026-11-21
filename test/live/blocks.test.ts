// parseBlock on raw blocks from a regtest pearld: hashes, merkle roots,
// witness commitments, the certificate binding and Pearl's block vsize
// against what getblock reports, and on a pearld from Pearl's fp8-scheme
// branch the V4 certificates its miner makes and the ancestor headers
// getblocktemplate offers.

import { describe, expect, it } from 'vitest';
import {
  blockHashHex,
  blockSize,
  blockStrippedSize,
  blockVsize,
  certificateAncestorHeader,
  checkCertificateBinding,
  checkCertificateRules,
  checkMerkleRoot,
  checkWitnessCommitment,
  MAX_ZK_PROOF_SIZE,
  networks,
  parseBlock,
  parseBlockHeader,
  PUBLIC_DATA_MIN_SIZE_V4,
  requiredCertVersion,
  serializeBlock,
  serializeBlockHeader,
  serializeCertificate,
  toOutputScript,
  transactionId,
  witnessCommitment,
} from '../../src/index.js';
import type { PearlBlock } from '../../src/index.js';
import { describeLive, fund, live, miner, network, pearld } from './chain.js';

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
  expect(() => checkMerkleRoot(block)).not.toThrow();
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

  it('parses a coinbase-only block with the certificate its height needs, bound to its header', async () => {
    const { raw, block, info } = await fetchBlock(await pearld.getBlockHash(1));
    expectMatchesPearld(raw, block, info);
    expect(block.certificate?.version).toBe(requiredCertVersion(network, 1));
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

describe.skipIf(live?.fp8 !== true)('V4 blocks', () => {
  const rawHeader = async (height: number): Promise<Uint8Array> => pearld.getRawBlockHeader(await pearld.getBlockHash(height));

  it('keys every mined V4 proof by the parent, with no ancestor headers in between', async () => {
    const tip = await pearld.getBlockCount();
    for (const height of [1, 2, tip - 1, tip]) {
      const { raw, block, info } = await fetchBlock(await pearld.getBlockHash(height));
      expectMatchesPearld(raw, block, info);
      const certificate = block.certificate!;
      expect(certificate.version).toBe(4);
      expect(certificate.ancestorHeaders).toEqual([]);
      expect(certificate.publicData.length).toBe(PUBLIC_DATA_MIN_SIZE_V4);
      expect(certificate.proof.length).toBeLessThanOrEqual(MAX_ZK_PROOF_SIZE);
      expect(serializeBlockHeader(certificateAncestorHeader(certificate)!)).toEqual(await rawHeader(height - 1));
      checkCertificateBinding(block);
      checkCertificateRules(certificate, network, height);
      // The certificate is outside vsize and inside size, as getblock counts them.
      expect(info.size - blockStrippedSize(block) - serializeCertificate(certificate).length).toBe(
        block.transactions.reduce((sum, tx) => sum + tx.byteLength(true) - tx.byteLength(false), 0),
      );
    }
  });

  it('refuses a mined V4 certificate whose ancestor chain no longer connects', async () => {
    const tip = await pearld.getBlockCount();
    const block = parseBlock(await pearld.getRawBlock(await pearld.getBlockHash(tip)));
    const grandparent = parseBlockHeader(await rawHeader(tip - 2));
    const extra = { ...block, certificate: { ...block.certificate!, ancestorHeaders: [grandparent] } };
    // Ancestor headers are outside the proof commitment, so only the chain check notices.
    expect(() => checkCertificateBinding(extra)).toThrow('v4 ancestor header at depth 1 does not connect');
    const parent = parseBlockHeader(await rawHeader(tip - 1));
    const keyedHigher = { ...block, certificate: { ...block.certificate!, ancestorHeaders: [parent] } };
    expect(() => checkCertificateBinding(keyedHigher)).toThrow('v4 ancestor header at depth 2 does not connect');
  });

  it('offers the four most recent headers in a V4 template, parent first', async () => {
    const tip = await pearld.getBlockCount();
    const template = await pearld.getBlockTemplate();
    expect(template.height).toBe(tip + 1);
    expect(template.requiredcertversion).toBe(requiredCertVersion(network, tip + 1));
    expect(template.requiredcertversion).toBe(4);
    expect(template.ancestorheaders).toHaveLength(4);
    for (const [i, header] of template.ancestorheaders!.entries()) {
      expect(header).toBe(hex(await rawHeader(tip - i)));
      expect(blockHashHex(parseBlockHeader(Buffer.from(header, 'hex')))).toBe(await pearld.getBlockHash(tip - i));
    }
  });
});
