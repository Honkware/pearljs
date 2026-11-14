// Full blocks against vectors from Pearl's Go code: the five genesis blocks
// and synthetic blocks for every certificate version, plus encodings Pearl's
// decoder rejects.

import { describe, expect, it } from 'vitest';
import {
  blockHashHex,
  blockSize,
  blockStrippedSize,
  blockVsize,
  calculateMerkleRoot,
  certificateProofCommitment,
  checkCertificateBinding,
  checkMerkleRoot,
  checkWitnessCommitment,
  isMoECertificate,
  parseBlock,
  serializeBlock,
  serializeCertificate,
} from '../src/index.js';
import vectors from '../vectors/pearl-go.json' with { type: 'json' };
import { bytesToHex, hexToBytes } from './vector-helpers.js';

function displayHex(bytes: Uint8Array): string {
  return bytesToHex(Uint8Array.from(bytes).reverse());
}

describe('Pearl blocks', () => {
  for (const expected of vectors.blocks) {
    it(`matches Go for ${expected.name}`, () => {
      const block = parseBlock(hexToBytes(expected.hex));
      expect(bytesToHex(serializeBlock(block))).toBe(expected.hex);
      expect(blockHashHex(block.header)).toBe(expected.hash);
      expect(bytesToHex(serializeCertificate(block.certificate))).toBe(expected.certificateHex);
      expect(block.certificate?.version ?? 0).toBe(expected.certificateVersion);

      if (block.certificate !== null) {
        expect(bytesToHex(certificateProofCommitment(block.certificate))).toBe(expected.proofCommitment);
        expect(isMoECertificate(block.certificate)).toBe(expected.isMoE);
      }
      const bound = expected.certificateHashMatches && expected.commitmentMatches;
      if (bound) {
        expect(() => checkCertificateBinding(block)).not.toThrow();
      } else {
        expect(() => checkCertificateBinding(block)).toThrow();
      }

      expect(block.transactions.map((tx) => tx.getId())).toEqual(expected.txids);
      expect(displayHex(calculateMerkleRoot(block.transactions))).toBe(expected.merkleRoot);
      expect(displayHex(calculateMerkleRoot(block.transactions, true))).toBe(expected.witnessMerkleRoot);
      expect(checkMerkleRoot(block)).toBe(true);
      if (expected.witnessError === '') {
        expect(() => checkWitnessCommitment(block)).not.toThrow();
      } else {
        expect(() => checkWitnessCommitment(block)).toThrow();
      }

      expect(blockSize(block)).toBe(expected.size);
      expect(blockStrippedSize(block)).toBe(expected.strippedSize);
      expect(serializeCertificate(block.certificate).length + blockStrippedSize(block)).toBe(
        expected.noWitnessSize,
      );
      expect(blockVsize(block)).toBe(expected.vsize);
    });
  }

  for (const expected of vectors.badBlocks) {
    it(`rejects ${expected.name} like Pearl`, () => {
      expect(() => parseBlock(hexToBytes(expected.hex))).toThrow();
    });
  }

  it('uses the same error text as Pearl for certificate limits', () => {
    for (const name of ['unknown-certificate-version', 'public-data-over-limit', 'proof-over-limit']) {
      const expected = vectors.badBlocks.find((item) => item.name === name)!;
      expect(() => parseBlock(hexToBytes(expected.hex))).toThrow(expected.error);
    }
  });

  it('parses a block held in a Node Buffer', () => {
    // Buffer.from(hex) is what fetching a block over RPC usually produces.
    for (const expected of vectors.blocks) {
      const fromBuffer = parseBlock(Buffer.from(expected.hex, 'hex'));
      expect(bytesToHex(serializeBlock(fromBuffer))).toBe(expected.hex);
    }
  });

  it('rejects bytes after the last transaction', () => {
    const raw = hexToBytes(vectors.blocks.find((item) => item.name === 'v1-one-spend')!.hex);
    expect(() => parseBlock(Uint8Array.from([...raw, 0x00]))).toThrow('unexpected bytes');
  });

  it('notices a header whose merkle root does not match', () => {
    const block = parseBlock(hexToBytes(vectors.blocks.find((item) => item.name === 'v3-four-spends')!.hex));
    block.header.merkleRoot[0] = block.header.merkleRoot[0]! ^ 1;
    expect(checkMerkleRoot(block)).toBe(false);
  });

  it('notices a certificate bound to a different header', () => {
    const block = parseBlock(hexToBytes(vectors.blocks.find((item) => item.name === 'v2-dense-two-spends')!.hex));
    block.header.timestamp += 1;
    expect(() => checkCertificateBinding(block)).toThrow('block hash mismatch');
  });

  it('refuses to serialize a V1 certificate with the wrong public data size', () => {
    const block = parseBlock(hexToBytes(vectors.blocks.find((item) => item.name === 'v1-one-spend')!.hex));
    const certificate = { ...block.certificate!, publicData: new Uint8Array(100) };
    expect(() => serializeCertificate(certificate)).toThrow('V1 public data must be 164 bytes');
  });
});
