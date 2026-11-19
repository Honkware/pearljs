// Mining against Pearl's own code: the coinbase, witness commitment and merkle
// root pearld builds (vectors/mining/node.json, from pearld's mining package),
// the commitment chain, public data, structure rules, targets and jackpot
// bounds of zk-pow on master (vectors/mining/zkpow.json) and fp8-scheme
// (vectors/mining/fp8.json), the rank-penalty rule as pearld runs it, and
// luck intervals from SciPy (vectors/mining/stats.json).

import { describe, expect, it } from 'vitest';
import { Transaction } from 'bitcoinjs-lib';
import {
  blockSkeleton,
  blockSubsidy,
  calculateMerkleRoot,
  certificateStatement,
  checkBlockWork,
  checkJackpot,
  checkPublicData,
  checkRankPenalty,
  coinbaseScript,
  coinbaseText,
  coinbaseTransaction,
  dotProductLength,
  effort,
  gammaQuantile,
  hashActivations,
  incompleteHeader,
  jackpotBound,
  jackpotHash,
  jackpotProbability,
  jackpotTarget,
  jackpotValue,
  jobKey,
  luck,
  matrixCommitment,
  noiseSeeds,
  parseBlock,
  parseMiningConfiguration,
  parsePublicData,
  PEARLD_COINBASE_TEXT,
  rankPenalizedBound,
  saltedRootA,
  saltedRootB,
  scriptPush,
  sealBlock,
  serializeBlock,
  serializeMiningConfiguration,
  shareValue,
  toOutputScript,
  v4JackpotBound,
  witnessCommitmentFor,
} from '../src/index.js';
import type { BlockTemplate, MiningConfiguration, PearlBlock ,
  PearlError} from '../src/index.js';
import node from '../vectors/mining/node.json' with { type: 'json' };
import zk from '../vectors/mining/zkpow.json' with { type: 'json' };
import fp8 from '../vectors/mining/fp8.json' with { type: 'json' };
import stats from '../vectors/mining/stats.json' with { type: 'json' };
import fp8Blocks from '../vectors/fp8.json' with { type: 'json' };
import goVectors from '../vectors/pearl-go.json' with { type: 'json' };
import fixtures from './fixtures/rpc-responses.json' with { type: 'json' };
import { bytesToHex, hexToBytes, masterNetworkNamed, networkNamed } from './vector-helpers.js';

const display = (bytes: Uint8Array): string => bytesToHex(Uint8Array.from(bytes).reverse());
const big = (hex: string): bigint => BigInt(`0x${hex}`);
const config = (hex: string): MiningConfiguration => parseMiningConfiguration(hexToBytes(hex));

function errorOf(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

// The byte stream the Rust generator writes: xorshift32 from seed * 2654435761 + 1.
function stream(seed: number, length: number): Uint8Array {
  let state = (Math.imul(seed, 2654435761) + 1) >>> 0;
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) {
    state = (state ^ (state << 13)) >>> 0;
    state = (state ^ (state >>> 17)) >>> 0;
    state = (state ^ (state << 5)) >>> 0;
    out[i] = state >>> 24;
  }
  return out;
}

// Public data holding just a configuration and a jackpot, enough for checkRankPenalty.
function blob(configHex: string, jackpotHex: string): Uint8Array {
  const out = new Uint8Array(164);
  out.set(hexToBytes(configHex));
  out.set(hexToBytes(jackpotHex), 116);
  return out;
}

describe('coinbase', () => {
  it('builds the coinbase, witness commitment and merkle root pearld builds', () => {
    for (const vector of node.coinbases) {
      const network = networkNamed(vector.network);
      const others = (vector.transactions ?? []).map((hex) => Transaction.fromHex(hex));
      const commitment = witnessCommitmentFor(others);
      expect(bytesToHex(commitment)).toBe(vector.witnessCommitment);
      const script = vector.payTo === '' ? Uint8Array.of(0x6a) : toOutputScript(vector.payTo, network);
      const coinbase = coinbaseTransaction({
        height: vector.height,
        extraNonce: BigInt(vector.extraNonce),
        text: PEARLD_COINBASE_TEXT,
        outputs: [{ script, value: BigInt(vector.value) }],
        witnessCommitment: commitment,
      });
      expect(bytesToHex(coinbaseScript(vector.height, BigInt(vector.extraNonce), PEARLD_COINBASE_TEXT))).toBe(vector.script);
      expect(coinbase.toHex()).toBe(vector.coinbase);
      expect(coinbase.getId()).toBe(vector.coinbaseTxid);
      expect(display(calculateMerkleRoot([coinbase, ...others]))).toBe(vector.merkleRoot);
      expect(BigInt(vector.value)).toBe(blockSubsidy(network, vector.height) + BigInt(vector.fees));
      expect(coinbaseText(coinbase.ins[0]!.script)).toBe(PEARLD_COINBASE_TEXT);
    }
  });

  it('writes the coinbaseaux flags as the push of the text pearld writes', () => {
    expect(node.coinbaseFlags).toBe(PEARLD_COINBASE_TEXT);
    expect(bytesToHex(scriptPush(new TextEncoder().encode(PEARLD_COINBASE_TEXT)))).toBe(node.coinbaseAuxFlags);
    expect(coinbaseScript(5, 9n, hexToBytes(node.coinbaseAuxFlags))).toEqual(coinbaseScript(5, 9n, PEARLD_COINBASE_TEXT));
  });

  it('refuses a coinbase script longer than pearld allows', () => {
    const run = (): unknown => coinbaseTransaction({ height: 1, text: 'x'.repeat(97), outputs: [], witnessCommitment: new Uint8Array(32) });
    expect(errorOf(run)).toBe('coinbase transaction script length of 101 is out of range (min: 2, max: 100)');
    expect(() => coinbaseTransaction({ height: 1, text: 'x'.repeat(96), outputs: [], witnessCommitment: new Uint8Array(32) })).not.toThrow();
  });
});

describe('blockSkeleton', () => {
  const template = JSON.parse(fixtures.getblocktemplate.body).result as BlockTemplate & { coinbasevalue: number };
  const fromFixture = { ...template, coinbasevalue: BigInt(template.coinbasevalue) } as BlockTemplate;
  // The fixture is a master pearld's, which has no FP8 fork.
  const regtest = masterNetworkNamed('regtest');
  const vector = node.coinbases[0]!;

  it('turns pearld\'s template into the block pearld would mine for it', () => {
    expect(vector.height).toBe(fromFixture.height);
    const skeleton = blockSkeleton(fromFixture, { network: regtest, payTo: vector.payTo });
    expect(skeleton.transactions[0]!.toHex()).toBe(vector.coinbase);
    expect(display(skeleton.header.merkleRoot)).toBe(vector.merkleRoot);
    expect(display(skeleton.header.prevBlock)).toBe(fromFixture.previousblockhash);
    expect(skeleton.header.bits).toBe(0x1e010000);
    expect(skeleton.header.timestamp).toBe(fromFixture.curtime);
    expect(skeleton.certVersion).toBe(fromFixture.requiredcertversion);
    expect(bytesToHex(incompleteHeader(skeleton.header))).toHaveLength(152);
  });

  it('refuses a template whose parts disagree', () => {
    const code = (t: BlockTemplate): string | undefined => {
      try {
        blockSkeleton(t, { network: regtest, payTo: vector.payTo });
      } catch (error) {
        return (error as PearlError).code;
      }
      return undefined;
    };
    expect(code({ ...fromFixture, default_witness_commitment: '00'.repeat(32) })).toBe('MINING_TEMPLATE_INVALID');
    expect(code({ ...fromFixture, target: '00'.repeat(32) })).toBe('MINING_TEMPLATE_INVALID');
    expect(code({ ...fromFixture, requiredcertversion: 2 })).toBe('MINING_TEMPLATE_INVALID');
    expect(code({ ...fromFixture, coinbasevalue: undefined } as unknown as BlockTemplate)).toBe('MINING_TEMPLATE_INVALID');
    expect(code({ ...fromFixture, ancestorheaders: ['00'.repeat(108)] })).toBe('MINING_TEMPLATE_INVALID');
    // pearld's template pays exactly the subsidy plus fees; one grain more is a block CheckConnectBlock refuses.
    expect(code({ ...fromFixture, coinbasevalue: fromFixture.coinbasevalue! + 1n })).toBe('MINING_TEMPLATE_INVALID');
    const tx = goVectors.transactions[0]!;
    const withTx = { ...fromFixture, transactions: [{ data: tx.hex, txid: '00'.repeat(32), hash: '00'.repeat(32), depends: [], fee: 0n, vsize: 1 }] };
    expect(code(withTx)).toBe('MINING_TEMPLATE_INVALID');
    const outputs = [{ script: toOutputScript(vector.payTo, regtest), value: 11n }];
    expect(() => blockSkeleton({ ...fromFixture, coinbasevalue: 10n }, { network: regtest, outputs })).toThrow('the coinbase outputs pay 11 grain, the template allows 10');
  });

  it('seals a block to the bytes Pearl mined around the same certificate', () => {
    for (const vector of goVectors.blocks.filter((b) => b.certificateVersion >= 2 && b.commitmentMatches && b.certificateHashMatches)) {
      const block = parseBlock(hexToBytes(vector.hex));
      const certificate = block.certificate!;
      const skeleton = {
        height: 1,
        certVersion: certificate.version,
        header: { ...block.header, proofCommitment: new Uint8Array(32) },
        transactions: block.transactions,
        witnessCommitment: new Uint8Array(32),
        ancestorHeaders: [],
      };
      const sealed = sealBlock(skeleton, { publicData: certificate.publicData, proof: certificate.proof });
      expect(bytesToHex(serializeBlock(sealed)), vector.name).toBe(vector.hex);
    }
  });
});

describe('mining configuration and patterns', () => {
  it('reads and writes configurations as zk-pow does, refusals in its words', () => {
    for (const vector of zk.configs) {
      const error = errorOf(() => parseMiningConfiguration(hexToBytes(vector.hex)));
      expect(error, vector.name).toBe(vector.error ?? null);
      if (vector.error !== undefined) continue;
      const parsed = config(vector.hex);
      expect(parsed.commonDim).toBe(vector.commonDim);
      expect(parsed.rank).toBe(vector.rank);
      expect(parsed.rows).toEqual(vector.rows);
      expect(parsed.cols).toEqual(vector.cols);
      expect(parsed.moe?.experts ?? null).toBe(vector.experts);
      expect(parsed.moe?.topK ?? null).toBe(vector.topK);
      expect(dotProductLength(parsed)).toBe(vector.dotProductLength);
      expect(bytesToHex(serializeMiningConfiguration(parsed))).toBe(vector.hex);
    }
  });

  it('builds patterns from index lists as PeriodicPattern::from_list does', () => {
    const base = config(zk.configs[0]!.hex);
    for (const vector of zk.patterns) {
      const error = errorOf(() => serializeMiningConfiguration({ ...base, rows: vector.list }));
      expect(error, JSON.stringify(vector.list)).toBe(vector.error ?? null);
      if (vector.bytes === undefined) continue;
      expect(bytesToHex(serializeMiningConfiguration({ ...base, rows: vector.list }).subarray(8, 14))).toBe(vector.bytes);
      // The tile's first row must be an offset the pattern repeats from.
      const configBytes = serializeMiningConfiguration({ ...base, rows: vector.list });
      for (let offset = 0; offset < vector.period * 2; offset += 1) {
        const data = new Uint8Array(164);
        data.set(configBytes);
        new DataView(data.buffer).setUint32(148, 1 << 20, true);
        new DataView(data.buffer).setUint32(152, 1 << 20, true);
        new DataView(data.buffer).setUint32(156, offset, true);
        const valid = vector.validOffsets!.includes(offset);
        expect(errorOf(() => parsePublicData(data))).toBe(valid ? null : 't_rows must be a valid offset for rows_pattern');
      }
    }
  });
});

describe('the commitment chain', () => {
  it('derives the job key from the incomplete header and configuration', () => {
    for (const vector of zk.jobKeys) {
      expect(bytesToHex(jobKey(hexToBytes(vector.header), hexToBytes(vector.config)))).toBe(vector.jobKey);
      expect(bytesToHex(jobKey(hexToBytes(vector.header), config(vector.config)))).toBe(vector.jobKey);
    }
  });

  it('computes hash A and hash B as pearl-blake3\'s keyed Merkle root over the padded matrix', () => {
    for (const vector of zk.matrixRoots) {
      expect(bytesToHex(matrixCommitment(stream(vector.seed, vector.length), hexToBytes(vector.key))), `${vector.length}`).toBe(vector.root);
    }
  });

  it('salts V3 roots with the matrix dimension', () => {
    for (const vector of zk.bindRoots) {
      expect(bytesToHex(saltedRootA(hexToBytes(vector.root), vector.dim))).toBe(vector.a);
      expect(bytesToHex(saltedRootB(hexToBytes(vector.root), vector.dim))).toBe(vector.b);
    }
  });

  it('folds MoE routing into A\'s side', () => {
    for (const vector of zk.hashActivations) {
      const out = hashActivations(hexToBytes(vector.hashA), hexToBytes(vector.hashRouting), vector.offsets, hexToBytes(vector.jobKey));
      expect(bytesToHex(out)).toBe(vector.activations);
    }
  });

  it('reads public data and derives the noise seeds under both derivations', () => {
    for (const vector of zk.publicData) {
      const error = errorOf(() => parsePublicData(hexToBytes(vector.hex)));
      expect(error, vector.name).toBe(vector.error ?? null);
      if (vector.error !== undefined) continue;
      const data = parsePublicData(hexToBytes(vector.hex));
      expect(bytesToHex(data.configBytes)).toBe(vector.config);
      expect([bytesToHex(data.hashA), bytesToHex(data.hashB), bytesToHex(data.hashJackpot)]).toEqual([vector.hashA, vector.hashB, vector.hashJackpot]);
      expect([data.m, data.n, data.tRows, data.tCols]).toEqual([vector.m, vector.n, vector.tRows, vector.tCols]);
      expect(data.moe === null ? null : { ...data.moe, hashRouting: bytesToHex(data.moe.hashRouting) }).toEqual(vector.moe);
      const key = jobKey(hexToBytes(vector.header), data.configBytes);
      expect(bytesToHex(key)).toBe(vector.jobKey);
      const seeds = noiseSeeds({
        jobKey: key, hashA: data.hashA, hashB: data.hashB, m: data.m, n: data.n, salted: vector.salted,
        moe: data.moe && { hashRouting: data.moe.hashRouting, routingOffsets: data.moe.routingOffsets },
      });
      expect([bytesToHex(seeds.a), bytesToHex(seeds.b)]).toEqual([vector.seedA, vector.seedB]);
    }
  });

  it('applies the verifier\'s structure rules in its order and words', () => {
    for (const vector of zk.sanity) {
      expect(vector.parse).toBeNull();
      expect(errorOf(() => checkPublicData(parsePublicData(hexToBytes(vector.hex)))), vector.name).toBe(vector.error);
    }
  });

  it('hashes the jackpot words under seed A', () => {
    for (const vector of zk.jackpotHashes) {
      expect(bytesToHex(jackpotHash(vector.words, hexToBytes(vector.seedA)))).toBe(vector.hash);
    }
  });
});

describe('targets and bounds', () => {
  it('reads compact bits as zk-pow does, wrapping and zeroing where it does', () => {
    for (const vector of zk.targets) expect(jackpotTarget(vector.bits).toString(16), vector.bits.toString(16)).toBe(vector.target);
  });

  it('scales the target by the tile\'s work, with and without the rank penalty', () => {
    for (const vector of zk.bounds) {
      const c = config(vector.config);
      if (vector.bound === null) expect(() => jackpotBound(vector.bits, c)).toThrow(RangeError);
      else expect(jackpotBound(vector.bits, c)).toBe(big(vector.bound));
      const penalized = rankPenalizedBound(jackpotTarget(vector.bits), c);
      expect(penalized === null ? null : penalized.toString(16)).toBe(vector.penalized);
    }
  });

  it('accepts a jackpot at its bound and refuses one above it', () => {
    for (const vector of zk.jackpotChecks) {
      const over = jackpotValue(hexToBytes(vector.jackpot)) > jackpotBound(vector.bits, config(vector.config));
      expect(over ? 'Jackpot condition not satisfied: hash does not meet difficulty target' : null).toBe(vector.error);
    }
    for (const vector of zk.rankPenalty) {
      const error = errorOf(() => checkRankPenalty(vector.bits, blob(vector.config, vector.jackpot)));
      expect(error).toBe(vector.error === null ? null : `rank penalty rule violated: ${vector.error}`);
    }
  });

  it('applies the V4 bound of the fp8-scheme branch', () => {
    for (const vector of fp8.jackpotChecks) {
      const statement = { a: { tileSize: vector.h }, b: { tileSize: vector.w }, k: vector.k } as Parameters<typeof v4JackpotBound>[1];
      const over = jackpotValue(hexToBytes(vector.jackpot)) > v4JackpotBound(vector.bits, statement);
      expect(over ? 'Jackpot condition not satisfied: hash does not meet difficulty target' : null).toBe(vector.error);
    }
  });
});

describe('the rank-penalty rule as pearld runs it', () => {
  it('refuses what zkpow.CheckRankPenalty refuses, in its words', () => {
    for (const vector of node.rankPenalty) {
      expect(errorOf(() => checkRankPenalty(vector.bits, hexToBytes(vector.publicData)))).toBe(vector.error);
    }
  });

  it('wraps a refusal in CheckCertificateRules\' words from the fork height on', () => {
    for (const vector of node.certificateRules) {
      const network = networkNamed(vector.network);
      const active = vector.height >= network.forkHeights.rankPenalty;
      const error = active ? errorOf(() => checkRankPenalty(vector.bits, hexToBytes(vector.publicData))) : null;
      const wrapped = error === null ? null
        : `certificate fails the rank penalty rule at height ${vector.height} (fork active from height ${network.forkHeights.rankPenalty}): ${error}`;
      expect(wrapped).toBe(vector.error);
    }
  });

  it('gives checkBlockWork the rank-penalty refusal for a jackpot only the penalty catches', () => {
    const rank256 = zk.configs[1]!.hex;
    const c = config(rank256);
    const bits = 0x1d00ffff;
    const plain = jackpotBound(bits, c);
    const penalized = rankPenalizedBound(jackpotTarget(bits), c)!;
    expect(penalized < plain).toBe(true);
    const base = hexToBytes(zk.publicData.find((p) => p.name === 'dense 1')!.hex);
    const publicData = base.slice();
    const jackpot = penalized + 1n;
    for (let i = 0; i < 32; i += 1) publicData[116 + i] = Number((jackpot >> BigInt(8 * i)) & 0xffn);
    const block: PearlBlock = { certificate: { version: 3, hash: new Uint8Array(32), publicData, proof: Uint8Array.of(1) }, header: { version: 1, prevBlock: new Uint8Array(32), merkleRoot: new Uint8Array(32), timestamp: 0, bits, proofCommitment: new Uint8Array(32) }, transactions: [] };
    const mainnet = networkNamed('mainnet');
    expect(() => checkBlockWork(block, mainnet, mainnet.forkHeights.rankPenalty - 1)).not.toThrow();
    let caught: PearlError | undefined;
    try {
      checkBlockWork(block, mainnet, 100000);
    } catch (error) {
      caught = error as PearlError;
    }
    expect(caught?.code).toBe('JACKPOT_ABOVE_TARGET');
    expect(caught?.message).toBe('certificate fails the rank penalty rule at height 100000 (fork active from height 96251): rank penalty rule violated: Jackpot condition not satisfied: hash does not meet the rank-penalized difficulty target');
  });
});

describe('checkJackpot on certificates Pearl made', () => {
  it('passes the V4 fixtures Pearl\'s verifier took and the edits it refuses only at the proof', () => {
    const proofOnly = (error: string): boolean => error === '' || error.includes('compact fp8 proof does not verify');
    for (const vector of fp8Blocks.blocks.filter((b) => b.name.startsWith('fixture-') && proofOnly(b.verifyError))) {
      const block = parseBlock(hexToBytes(vector.hex));
      expect(() => checkJackpot(block.certificate!, block.header.bits), vector.name).not.toThrow();
      const statement = certificateStatement(block.certificate!)!;
      expect(jackpotValue(statement.hashJackpot) <= v4JackpotBound(block.header.bits, statement)).toBe(true);
    }
  });
});

describe('pool statistics', () => {
  it('finds the gamma quantiles SciPy finds', () => {
    for (const vector of stats.gammaQuantiles) {
      expect(gammaQuantile(vector.p, vector.shape)).toBeCloseTo(vector.x, 8 - Math.max(0, Math.round(Math.log10(vector.x))));
    }
  });

  it('gives the exact Poisson interval for luck', () => {
    for (const vector of stats.luck) {
      const result = luck(vector.found, vector.expected, vector.confidence);
      expect(result.luck).toBe(vector.luck);
      expect(result.low).toBeCloseTo(vector.low, 8);
      expect(result.high).toBeCloseTo(vector.high, 8);
    }
  });

  it('counts a share as the block bound\'s chance over the share bound\'s', () => {
    const c = config(zk.configs[0]!.hex);
    const block = jackpotBound(0x1c0ffff0, c);
    const share = jackpotBound(0x1d00ffff, c);
    expect(shareValue(share, block)).toBeCloseTo(Number(jackpotTarget(0x1c0ffff0)) / Number(jackpotTarget(0x1d00ffff)), 12);
    expect(effort([{ shareBound: share, blockBound: block }, { shareBound: block, blockBound: block }])).toBeCloseTo(1 + shareValue(share, block), 12);
    expect(jackpotProbability((1n << 256n) - 1n)).toBe(1);
    expect(jackpotProbability((1n << 255n) - 1n)).toBe(0.5);
    expect(() => shareValue(block, share)).toThrow(RangeError);
  });
});
