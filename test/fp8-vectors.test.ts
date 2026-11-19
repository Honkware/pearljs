// FP8 against vectors from Pearl's fp8-scheme branch (vectors/fp8.json, from
// vectors/fp8/generate.go): V4 blocks and the certificates Pearl's own
// verifier accepts or refuses, encodings its decoder and encoder refuse,
// certificate rules at every fork boundary, and RPC bodies from its handlers.

import { describe, expect, it } from 'vitest';
import {
  blockHashHex,
  blockSize,
  blockStrippedSize,
  blockVsize,
  calculateMerkleRoot,
  certificateAncestorHeader,
  certificateProofCommitment,
  CERTIFICATE_MAX_SIZE,
  checkCertificateBinding,
  checkCertificateRules,
  checkMerkleRoot,
  checkWitnessCommitment,
  isMoECertificate,
  LEGACY_MAX_ZK_PROOF_SIZE,
  MAX_CERTIFICATE_V4_ANCESTOR_HEADERS,
  MAX_ZK_PROOF_SIZE,
  parseBlock,
  parseBlockHeader,
  PearldClient,
  PUBLIC_DATA_MAX_SIZE_V2,
  PUBLIC_DATA_MAX_SIZE_V4,
  requiredCertVersion,
  serializeBlock,
  serializeBlockHeader,
  serializeCertificate,
} from '../src/index.js';
import type { CertificateVersion, PearlCertificate } from '../src/index.js';
import vectors from '../vectors/fp8.json' with { type: 'json' };
import fp8Fixtures from './fixtures/rpc-responses-fp8.json' with { type: 'json' };
import { fakeFetch, type Fixture } from './rpc-helpers.js';
import { bytesToHex, hexToBytes, networkNamed } from './vector-helpers.js';

const displayHex = (bytes: Uint8Array): string => bytesToHex(Uint8Array.from(bytes).reverse());

// What Pearl refuses before it decodes the statement or verifies the proof.
const BINDING_REFUSALS = [
  'legacy proof data too large',
  'block hash mismatch',
  'proof commitment mismatch',
  'empty public data',
  'empty proof data',
  'invalid public_data_len',
  'does not connect',
];

function bindingError(run: () => void): string {
  try {
    run();
    return '';
  } catch (err) {
    return (err as Error).message;
  }
}

describe('FP8 vectors', () => {
  it('come from a pinned fp8-scheme commit', () => {
    expect(vectors.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(vectors.pearlVersion).toBe('1.6.0-fp8-testnet1');
  });

  it('share Pearl\'s certificate limits', () => {
    expect(CERTIFICATE_MAX_SIZE).toBe(vectors.limits.certificateMaxSize);
    expect(MAX_ZK_PROOF_SIZE).toBe(vectors.limits.maxZKProofSize);
    expect(LEGACY_MAX_ZK_PROOF_SIZE).toBe(60000);
    expect(PUBLIC_DATA_MAX_SIZE_V2).toBe(vectors.limits.publicDataMaxSizeV2);
    expect(PUBLIC_DATA_MAX_SIZE_V4).toBe(vectors.limits.publicDataMaxSizeV4);
    expect(MAX_CERTIFICATE_V4_ANCESTOR_HEADERS).toBe(vectors.limits.maxAncestorHeaders);
  });
});

describe('V4 blocks', () => {
  for (const expected of vectors.blocks) {
    it(`match Go for ${expected.name}`, () => {
      const block = parseBlock(hexToBytes(expected.hex));
      const certificate = block.certificate!;
      expect(bytesToHex(serializeBlock(block))).toBe(expected.hex);
      expect(blockHashHex(block.header)).toBe(expected.hash);
      expect(certificate.version).toBe(expected.certificateVersion);
      expect(bytesToHex(serializeCertificate(certificate))).toBe(expected.certificateHex);
      expect(serializeCertificate(certificate).length).toBe(expected.certificateSize);
      expect(bytesToHex(certificateProofCommitment(certificate))).toBe(expected.proofCommitment);
      expect(isMoECertificate(certificate)).toBe(expected.isMoE);
      expect(certificate.ancestorHeaders?.length ?? 0).toBe(expected.ancestorCount);
      const ancestor = certificateAncestorHeader(certificate);
      expect(ancestor === null ? '' : bytesToHex(serializeBlockHeader(ancestor))).toBe(expected.ancestorHeader);

      const refused = BINDING_REFUSALS.some((text) => expected.verifyError.includes(text));
      const message = bindingError(() => checkCertificateBinding(block));
      if (refused) {
        expect(message, expected.verifyError).not.toBe('');
        expect(expected.verifyError.endsWith(message), `${message} / ${expected.verifyError}`).toBe(true);
      } else {
        // The proof or the statement is what Pearl refuses, or nothing: pearljs checks neither.
        expect(message, expected.verifyError).toBe('');
      }

      expect(block.transactions.map((tx) => tx.getId())).toEqual(expected.txids);
      expect(displayHex(calculateMerkleRoot(block.transactions))).toBe(expected.merkleRoot);
      expect(displayHex(calculateMerkleRoot(block.transactions, true))).toBe(expected.witnessMerkleRoot);
      if (expected.merkleRootMatches) expect(() => checkMerkleRoot(block)).not.toThrow();
      else expect(() => checkMerkleRoot(block)).toThrow('block merkle root is invalid');
      if (expected.witnessError === '') expect(() => checkWitnessCommitment(block)).not.toThrow();
      else expect(() => checkWitnessCommitment(block)).toThrow();

      expect(blockSize(block)).toBe(expected.size);
      expect(blockStrippedSize(block)).toBe(expected.strippedSize);
      expect(serializeCertificate(certificate).length + blockStrippedSize(block)).toBe(expected.noWitnessSize);
      expect(blockVsize(block)).toBe(expected.vsize);
    });
  }

  it('include a certificate Pearl\'s verifier accepts, for each device', () => {
    const mined = vectors.blocks.filter((item) => item.name.endsWith('-mined'));
    expect(mined).toHaveLength(2);
    for (const expected of mined) {
      expect(expected.verifyError).toBe('');
      expect(() => checkCertificateBinding(parseBlock(hexToBytes(expected.hex)))).not.toThrow();
    }
  });

  it('carry the parent as the ancestor of the mined fixture, keyed by the grandparent', () => {
    const block = parseBlock(hexToBytes(vectors.blocks.find((item) => item.name === 'fixture-h100-mined')!.hex));
    const [parent] = block.certificate!.ancestorHeaders!;
    expect(displayHex(block.header.prevBlock)).toBe(blockHashHex(parent!));
    expect(displayHex(parent!.prevBlock)).toBe(blockHashHex(certificateAncestorHeader(block.certificate!)!));
  });

  it('are refused by a decoder without the FP8 fork, as Pearl 1.5 refuses them', () => {
    for (const expected of vectors.blocks) {
      const raw = hexToBytes(expected.hex);
      if (expected.certificateVersion === 4) {
        expect(() => parseBlock(raw, { fp8: false })).toThrow('unsupported certificate version: 4');
      } else {
        const proof = parseBlock(raw).certificate!.proof.length;
        expect(() => parseBlock(raw, { fp8: false })).toThrow(`proof data too large: ${proof} bytes (max 60000)`);
      }
    }
  });

  it('keep the ancestor headers out of the proof commitment', () => {
    const block = parseBlock(hexToBytes(vectors.blocks.find((item) => item.name === 'v4-keyed-at-depth-four')!.hex));
    const certificate = block.certificate!;
    expect(certificateProofCommitment({ ...certificate, ancestorHeaders: [] })).toEqual(certificateProofCommitment(certificate));
    expect(block.header.proofCommitment).toEqual(certificateProofCommitment(certificate));
  });
});

describe('encodings Pearl refuses', () => {
  for (const expected of vectors.badBlocks) {
    it(`rejects ${expected.name} like Pearl`, () => {
      const run = () => parseBlock(hexToBytes(expected.hex));
      if (expected.error.includes('EOF')) expect(run).toThrow();
      else if (expected.error.startsWith('ReadVarInt: ')) expect(run).toThrow(expected.error.slice('ReadVarInt: '.length));
      else expect(run).toThrow(expected.error);
    });
  }

  for (const expected of vectors.encodeErrors) {
    it(`refuses to encode ${expected.name} like Pearl`, () => {
      const header = parseBlockHeader(new Uint8Array(108));
      const certificate: PearlCertificate = {
        version: expected.version as CertificateVersion,
        hash: new Uint8Array(32),
        publicData: new Uint8Array(expected.publicDataLen),
        proof: new Uint8Array(expected.proofLen),
        ...(expected.version === 4 ? { ancestorHeaders: Array.from({ length: expected.ancestors }, () => header) } : {}),
      };
      expect(() => serializeCertificate(certificate)).toThrow(expected.error);
    });
  }

  it('encodes a V1 to V3 proof past 62000 bytes without the FP8 fork, as Pearl 1.5 does', () => {
    const certificate: PearlCertificate = { version: 2, hash: new Uint8Array(32), publicData: new Uint8Array(164), proof: new Uint8Array(62001) };
    expect(serializeCertificate(certificate, { fp8: false })).toHaveLength(4 + 32 + 4 + 164 + 4 + 62001);
    expect(() => serializeCertificate({ ...certificate, version: 4 }, { fp8: false })).toThrow('unsupported certificate version: 4');
  });

  it('refuses ancestor headers on a certificate older than V4', () => {
    const header = parseBlockHeader(new Uint8Array(108));
    const certificate: PearlCertificate = { version: 3, hash: new Uint8Array(32), publicData: new Uint8Array(164), proof: Uint8Array.of(1), ancestorHeaders: [header] };
    expect(() => serializeCertificate(certificate)).toThrow('a V3 certificate carries no ancestor headers');
  });
});

describe('FP8 certificate rules', () => {
  const certificate = (version: number, size: number): PearlCertificate => ({
    version: version as CertificateVersion,
    hash: new Uint8Array(32),
    publicData: new Uint8Array(size),
    proof: Uint8Array.of(1),
  });

  for (const expected of vectors.networks) {
    it(`match chaincfg and CheckCertificateRules on ${expected.name}`, () => {
      const network = networkNamed(expected.name);
      expect(network.forkHeights).toEqual({
        moe: expected.moeForkHeight,
        denseOnly: expected.denseOnlyForkHeight,
        rankPenalty: expected.rankPenaltyForkHeight,
        saltedSeed: expected.saltedSeedForkHeight,
        fp8: expected.fp8ForkHeight,
      });
      for (const rule of expected.certRules) {
        expect(requiredCertVersion(network, rule.height), `height ${rule.height}`).toBe(rule.required);
        const error = bindingError(() => checkCertificateRules(certificate(rule.version, rule.publicDataLen), network, rule.height));
        expect(error, `v${rule.version}/${rule.publicDataLen} at ${rule.height}`).toBe(rule.error);
      }
    });
  }

  it('fork testnet to V4 at 67415 and leave mainnet on V3', () => {
    const testnet = vectors.networks.find((item) => item.name === 'testnet')!;
    expect(testnet.certRules.find((rule) => rule.height === 67414)!.required).toBe(3);
    expect(testnet.certRules.find((rule) => rule.height === 67415)!.required).toBe(4);
    expect(requiredCertVersion(networkNamed('mainnet'), 2 ** 31 - 1)).toBe(3);
  });
});

describe('RPC on the fp8 branch', () => {
  const pearld = (routes: Record<string, string>) =>
    new PearldClient({ url: 'https://127.0.0.1:18334', username: 'alice', password: 'pw', fetch: fakeFetch(routes, fp8Fixtures as Record<string, Fixture>).fetch });

  it('reads a V4 template with the ancestor headers its proof may be keyed by', async () => {
    const template = await pearld({ getblocktemplate: 'getblocktemplate' }).getBlockTemplate();
    expect(template.requiredcertversion).toBe(4);
    expect(template.height).toBe(1);
    // Regtest at height 1: genesis is the only ancestor.
    expect(template.ancestorheaders).toHaveLength(1);
    const parent = parseBlockHeader(hexToBytes(template.ancestorheaders![0]!));
    expect(blockHashHex(parent)).toBe(template.previousblockhash);
    expect(template.coinbasevalue).toBe(BigInt(fp8Fixtures.getblocktemplate.expect.coinbaseValue));
  });

  it('reads the node and network info a 1.6 pearld reports', async () => {
    const client = pearld({ getinfo: 'getinfo', getnetworkinfo: 'getnetworkinfo', getmininginfo: 'getmininginfo' });
    const relayFee = BigInt(fp8Fixtures.getinfo.expect.relayFee);
    expect(await client.getInfo()).toMatchObject({ version: 1060000, protocolversion: 3, relayfee: relayFee });
    const network = await client.getNetworkInfo();
    expect(network).toMatchObject({ version: 1060000, protocolversion: 3, subversion: expect.stringContaining('pearld:1.6.0-fp8-testnet1') });
    expect(network.relayfee).toBe(relayFee);
    expect(await client.getMiningInfo()).toMatchObject({ blocks: 0, genproclimit: 1, generate: false });
  });
});
