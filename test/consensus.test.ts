// Consensus data against Pearl's own functions run in generate.go: the
// chaincfg params of each network, CheckCertificateRules around every fork
// height, CalcBlockSubsidy and its running total, CompactToBig, BigToCompact
// and CalcWork, and getdifficulty's ratio. The difficulty rule is checked
// against calcNextRequiredDifficulty run by vectors/difficulty_test.go.

import { describe, expect, it } from 'vitest';
import {
  bitsToTarget,
  blockSubsidy,
  checkCertificateRules,
  COINBASE_MATURITY,
  difficultyForBits,
  EMISSION_LIMIT,
  MAX_GRAIN,
  networks,
  nextBlockBits,
  requiredCertVersion,
  targetToBits,
  totalSupply,
  workForBits,
} from '../src/index.js';
import type { CertificateVersion, PearlCertificate } from '../src/index.js';
import vectors from '../vectors/pearl-go.json' with { type: 'json' };
import difficulty from '../vectors/difficulty.json' with { type: 'json' };
import { masterNetworkNamed, networkNamed } from './vector-helpers.js';

const certificate = (version: number, size: number): PearlCertificate => ({
  version: version as CertificateVersion,
  hash: new Uint8Array(32),
  publicData: new Uint8Array(size),
  proof: Uint8Array.of(1),
});

describe('network consensus params', () => {
  it('covers every network the generator knows', () => {
    expect(vectors.consensus.networks.map((item) => item.name).sort()).toEqual(Object.keys(networks).sort());
  });

  for (const expected of vectors.consensus.networks) {
    it(`match chaincfg for ${expected.name}`, () => {
      const network = networkNamed(expected.name);
      // The FP8 fork height is checked against vectors/fp8.json; master has none.
      expect(masterNetworkNamed(expected.name).forkHeights).toEqual({
        moe: expected.moeForkHeight,
        denseOnly: expected.denseOnlyForkHeight,
        rankPenalty: expected.rankPenaltyForkHeight,
        saltedSeed: expected.saltedSeedForkHeight,
        fp8: 0,
      });
      expect(network.checkpoints).toEqual(expected.checkpoints);
      expect(network.dnsSeeds).toEqual(expected.dnsSeeds);
      expect(network.targetSpacing).toBe(expected.targetTimePerBlock);
      expect(network.wtemaHalfLife).toBe(expected.wtemaHalfLife);
      expect(network.powLimit).toBe(BigInt(expected.powLimit));
      expect(network.powLimitBits).toBe(expected.powLimitBits);
      expect(network.coinbaseMaturity).toBe(expected.coinbaseMaturity);
      expect(COINBASE_MATURITY).toBe(expected.coinbaseMaturity);
    });
  }
});

describe('certificate rules', () => {
  for (const expected of vectors.consensus.networks) {
    it(`require the certificate CheckCertificateRules does on ${expected.name}`, () => {
      const network = masterNetworkNamed(expected.name);
      for (const rule of expected.certRules) {
        expect(requiredCertVersion(network, rule.height)).toBe(rule.required);
        let error = '';
        try {
          checkCertificateRules(certificate(rule.version, rule.publicDataLen), network, rule.height);
        } catch (err) {
          error = (err as Error).message;
        }
        expect(error, `v${rule.version}/${rule.publicDataLen} at ${rule.height}`).toBe(rule.error);
      }
    });
  }

  it('refuses a block without a certificate', () => {
    expect(() => checkCertificateRules(null, networks.mainnet, 1)).toThrow('block has no certificate');
  });

  it('refuses a height outside int32', () => {
    expect(() => requiredCertVersion(networks.mainnet, -1)).toThrow(RangeError);
    expect(() => requiredCertVersion(networks.mainnet, 2 ** 31)).toThrow(RangeError);
  });
});

describe('subsidy and supply', () => {
  for (const expected of vectors.consensus.networks) {
    it(`match CalcBlockSubsidy on ${expected.name}`, () => {
      const network = networkNamed(expected.name);
      for (const { height, amount } of expected.subsidies) {
        expect(blockSubsidy(network, height), `height ${height}`).toBe(BigInt(amount));
      }
    });

    it(`sum to Pearl's running total on ${expected.name}`, () => {
      const network = networkNamed(expected.name);
      for (const { height, amount } of expected.supplies) {
        expect(totalSupply(network, height), `height ${height}`).toBe(BigInt(amount));
      }
    });
  }

  it('pays half the emission limit in the first four years, far under MaxGrain', () => {
    const supply = totalSupply(networks.mainnet, 650_226);
    expect(supply).toBeLessThan(EMISSION_LIMIT / 2n);
    expect(EMISSION_LIMIT / 2n - supply).toBeLessThan(1_000_000n);
    expect(EMISSION_LIMIT * 10n).toBe(MAX_GRAIN);
  });
});

describe('compact bits', () => {
  it('decode to CompactToBig and CalcWork', () => {
    for (const expected of vectors.consensus.compact) {
      expect(bitsToTarget(expected.bits), expected.bits.toString(16)).toBe(BigInt(expected.target));
      expect(workForBits(expected.bits), expected.bits.toString(16)).toBe(BigInt(expected.work));
      expect(targetToBits(BigInt(expected.target)), expected.bits.toString(16)).toBe(expected.recompact);
    }
  });

  it('encode like BigToCompact', () => {
    for (const expected of vectors.consensus.targets) {
      expect(targetToBits(BigInt(expected.target)), expected.target).toBe(expected.bits);
    }
  });

  it('keep each PowLimitBits target within PowLimit', () => {
    for (const network of Object.values(networks)) {
      expect(bitsToTarget(network.powLimitBits) <= network.powLimit).toBe(true);
    }
    // Regtest's bits are not the compact form of its limit, 2^233 - 1.
    expect(targetToBits(networks.mainnet.powLimit)).toBe(networks.mainnet.powLimitBits);
    expect(targetToBits(networks.regtest.powLimit)).not.toBe(networks.regtest.powLimitBits);
  });

  it('refuses bits outside uint32', () => {
    expect(() => bitsToTarget(-1)).toThrow(RangeError);
    expect(() => bitsToTarget(2 ** 32)).toThrow(RangeError);
  });
});

describe('nextBlockBits', () => {
  it('covers every network', () => {
    expect(difficulty.networks.map((item) => item.name).sort()).toEqual(Object.keys(networks).sort());
  });

  for (const expected of difficulty.networks) {
    const network = networkNamed(expected.name);

    it(`reads the retargeting params of chaincfg for ${expected.name}`, () => {
      expect(network.powNoRetargeting).toBe(expected.powNoRetargeting);
      expect(network.reduceMinDifficulty).toBe(expected.reduceMinDifficulty);
      expect(network.minDiffReductionTime).toBe(expected.minDiffReductionTime);
    });

    it.each(expected.cases.map((item) => [item.name, item] as const))(`gives Pearl's bits on ${expected.name} for %s`, (_name, item) => {
      expect(nextBlockBits(network, item.last, item.time)).toBe(item.bits);
    });
  }

  it('refuses times that are not whole seconds and a half-life of 0', () => {
    const last = { bits: networks.mainnet.powLimitBits, timestamp: 100, parentTimestamp: 0 };
    expect(() => nextBlockBits(networks.mainnet, last, 1.5)).toThrow(RangeError);
    expect(() => nextBlockBits(networks.mainnet, { ...last, parentTimestamp: Number.NaN }, 200)).toThrow(RangeError);
    expect(() => nextBlockBits({ ...networks.mainnet, wtemaHalfLife: 0 }, last, 200)).toThrow(RangeError);
  });
});

describe('difficultyForBits', () => {
  for (const expected of vectors.consensus.networks) {
    it(`matches getdifficulty on ${expected.name}`, () => {
      const network = networkNamed(expected.name);
      for (const { bits, difficulty } of expected.difficulties) {
        expect(difficultyForBits(bits, network), bits.toString(16)).toBe(difficulty);
      }
    });
  }

  it('refuses bits that encode zero', () => {
    expect(() => difficultyForBits(0, networks.mainnet)).toThrow(RangeError);
  });
});
