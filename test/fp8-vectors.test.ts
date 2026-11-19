// FP8 against vectors from Pearl's fp8-scheme branch (vectors/fp8.json, from
// vectors/fp8/generate.go): V4 blocks and the certificates Pearl's own
// verifier accepts or refuses, encodings its decoder and encoder refuse,
// certificate rules at every fork boundary, and RPC bodies from its handlers.
// Last, three blocks from the public testnet2 chain on either side of its
// fork, as its Blockbook served them.

import { describe, expect, it } from 'vitest';
import {
  blockHashHex,
  blockSize,
  blockStrippedSize,
  blockVsize,
  calculateMerkleRoot,
  certificateAncestorHeader,
  certificateProofCommitment,
  certificateStatement,
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
  V4_DEVICE_NAMES,
} from '../src/index.js';
import type { CertificateVersion, PearlCertificate } from '../src/index.js';
import vectors from '../vectors/fp8.json' with { type: 'json' };
import fp8Fixtures from './fixtures/rpc-responses-fp8.json' with { type: 'json' };
import testnet2 from './fixtures/testnet2-fp8-blocks.json' with { type: 'json' };
import statements from '../vectors/fp8-statements.json' with { type: 'json' };
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

describe('testnet2 blocks around its FP8 fork', () => {
  for (const expected of testnet2.blocks) {
    it(`parse, bind and meet the rules at height ${expected.height}`, () => {
      const network = networkNamed('testnet2');
      const raw = hexToBytes(expected.hex);
      const block = parseBlock(raw);
      expect(blockHashHex(block.header)).toBe(expected.hash);
      expect(displayHex(block.header.prevBlock)).toBe(expected.previousBlockHash);
      expect(bytesToHex(serializeBlock(block))).toBe(expected.hex);
      expect(blockSize(block)).toBe(expected.size);
      expect(block.transactions).toHaveLength(expected.txCount);
      expect(block.certificate!.version).toBe(requiredCertVersion(network, expected.height));
      checkCertificateBinding(block);
      checkCertificateRules(block.certificate, network, expected.height);
      checkMerkleRoot(block);
      checkWitnessCommitment(block);
    });
  }

  it('key the V4 proofs at the fork by the last V3 block, through the headers in between', () => {
    const [last, first, third] = testnet2.blocks.map((item) => parseBlock(hexToBytes(item.hex)));
    expect(last!.certificate!.version).toBe(3);
    expect(first!.certificate!.ancestorHeaders).toEqual([]);
    expect(third!.certificate!.ancestorHeaders).toHaveLength(2);
    for (const block of [first!, third!]) {
      expect(blockHashHex(certificateAncestorHeader(block.certificate!)!)).toBe(blockHashHex(last!.header));
    }
    expect(blockHashHex(third!.certificate!.ancestorHeaders![1]!)).toBe(blockHashHex(first!.header));
    // A decoder without the fork refuses the chain from here on.
    expect(() => parseBlock(hexToBytes(testnet2.blocks[1]!.hex), { fp8: false })).toThrow('unsupported certificate version: 4');
  });
});

describe('V4 statements', () => {
  // What PublicParams::from_bytes refuses for the encoding's shape; the rest of what it refuses is bounds and layout.
  const STRUCTURAL = /^(truncated fp8 public_data|trailing bytes in fp8 public_data|unknown (HashId|Quant) discriminant: \d+|unsupported Device discriminant: \d+)$/;
  const HASH_IDS = ['Blake3Chunk128', 'Blake3Chunk256', 'Blake3Chunk512', 'Blake3Chunk1024'];
  const v4 = (hex: string): PearlCertificate => ({ version: 4, hash: new Uint8Array(32), publicData: hexToBytes(hex), proof: Uint8Array.of(1), ancestorHeaders: [] });
  const list = (bytes: Uint8Array): string => `[${Array.from(bytes).join(', ')}]`;

  it('come from the pinned commit', () => {
    expect(statements.commit).toBe(vectors.commit);
  });

  for (const expected of statements.statements) {
    it(`read ${expected.name} as zk-pow does`, () => {
      const read = () => certificateStatement(v4(expected.hex))!;
      if (STRUCTURAL.test(expected.error)) {
        expect(read).toThrow(expected.error);
        return;
      }
      const statement = read();
      if (expected.debug === '') return; // Refused for its bounds or layout, which pearljs leaves to the node.
      const operand = (side: 'a' | 'b') => {
        const { numRows, hashId, tileSize } = statement[side];
        return `${side}: OperandParams { num_rows: ${numRows}, hash_id: ${HASH_IDS[hashId]}, tile_size: ${tileSize} }`;
      };
      for (const part of [
        `common: CommonParams { k: ${statement.k}, r: ${statement.r}, quant: Fp8E4M3Prequant, device: ${V4_DEVICE_NAMES[statement.device]} }`,
        `operands: Sides { ${operand('a')}, ${operand('b')} }`,
        statement.moe === null ? 'moe: None' : `experts: ${statement.experts}`,
        `tile_bases: Sides { a: ${statement.tileBases.a}, b: ${statement.tileBases.b} }`,
        `hash_jackpot: ${list(statement.hashJackpot)}, hash_a: ${list(statement.hashA)}, hash_b: ${list(statement.hashB)}`,
        `proof_commitment: ${list(statement.ancestorHeader.proofCommitment)} }`,
        `timestamp: ${statement.ancestorHeader.timestamp}, nbits: ${statement.ancestorHeader.bits} }`,
      ]) {
        expect(expected.debug).toContain(part);
      }
    });
  }

  it('keep the values zk-pow refuses for their bounds, as written', () => {
    const named = (name: string) => certificateStatement(v4(statements.statements.find((item) => item.name === name)!.hex))!;
    expect(named('k-zero').k).toBe(0);
    expect(named('rank-16').r).toBe(16);
    expect(named('tile-bases-moved').tileBases.a).toBe(32);
    const moe = named('moe-tail-whole');
    expect(moe.experts).toBe(2);
    expect(moe.moe!.iA).toHaveLength(moe.a.tileSize);
  });

  it('name the device of Pearl\'s two mined fixtures', () => {
    for (const device of ['h100', 'b200']) {
      const block = parseBlock(hexToBytes(vectors.blocks.find((item) => item.name === `fixture-${device}-mined`)!.hex));
      expect(V4_DEVICE_NAMES[certificateStatement(block.certificate!)!.device]).toBe(device.toUpperCase());
    }
    expect(certificateStatement({ version: 3, hash: new Uint8Array(32), publicData: new Uint8Array(164), proof: Uint8Array.of(1) })).toBeNull();
  });

  it('read the statements of real testnet2 blocks, keyed by the header their ancestry names', () => {
    for (const expected of testnet2.blocks.filter((item) => item.height >= 150283)) {
      const certificate = parseBlock(hexToBytes(expected.hex)).certificate!;
      const statement = certificateStatement(certificate)!;
      expect(statement.ancestorHeader).toEqual(certificateAncestorHeader(certificate));
      // Both fixture blocks were proved on the H100 datapath; testnet2 also carries B200 blocks, such as 150300.
      expect(V4_DEVICE_NAMES[statement.device]).toBe('H100');
      expect(statement.moe).toBeNull();
    }
  });
});
