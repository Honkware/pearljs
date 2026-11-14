// Consensus data for explorers and miners: which certificate a height needs,
// compact difficulty bits, work, and Pearl's emission.
//
// Pearl's emission is a smooth curve, not Bitcoin's halvings: block h pays
// S*E / ((h+E)(h-1+E)) grain, where S is 2.1 billion PRL and E is four years
// of blocks, so half of S is paid out in the first four years and the rest
// ever more slowly (blockchain.CalcBlockSubsidy). Difficulty retargets every
// block (WTEMA) rather than every 2016, and getdifficulty divides by each
// network's own PowLimitBits.

import { GRAIN_PER_PEARL } from './amount.js';
import { isMoECertificate } from './block.js';
import type { CertificateVersion, PearlCertificate } from './block.js';
import type { PearlNetwork } from './networks.js';

/** chaincfg CoinbaseMaturity, the same on every network: blocks before a coinbase output can be spent. */
export const COINBASE_MATURITY = 100;
/** The limit the emission curve approaches, in grain. Not btcutil.MaxGrain, which is ten times larger. */
export const EMISSION_LIMIT = 2_100_000_000n * GRAIN_PER_PEARL;

const FOUR_YEARS = 4 * 365 * 24 * 60 * 60;
// defaultEmissionConstant, for a network without a target spacing.
const DEFAULT_EMISSION_CONSTANT = 650_226n;

function assertHeight(height: number): void {
  if (!Number.isInteger(height) || height < 0 || height > 0x7fffffff) {
    throw new RangeError(`height must be 0 to ${0x7fffffff}, got ${height}`);
  }
}

const active = (forkHeight: number, height: number): boolean => forkHeight !== 0 && height >= forkHeight;

/** The certificate version a block at this height must carry (Params.RequiredCertVersion). */
export function requiredCertVersion(network: PearlNetwork, height: number): CertificateVersion {
  assertHeight(height);
  if (active(network.forkHeights.saltedSeed, height)) return 3;
  if (active(network.forkHeights.moe, height)) return 2;
  return 1;
}

/**
 * Throws with Pearl's message when the certificate's version is wrong for
 * the height, or it carries a MoE proof after the dense-only fork. These are
 * the rules of blockchain.CheckCertificateRules that need no proof; the
 * rank-penalty rule reads the proof's public data and is not checked here.
 */
export function checkCertificateRules(certificate: PearlCertificate | null, network: PearlNetwork, height: number): void {
  if (certificate === null) throw new Error('block has no certificate');
  const want = requiredCertVersion(network, height);
  if (certificate.version !== want) {
    throw new Error(
      `certificate version ${certificate.version} is not allowed at height ${height} (require version ${want})`,
    );
  }
  if (isMoECertificate(certificate) && active(network.forkHeights.denseOnly, height)) {
    throw new Error(
      `MoE certificate is not allowed at height ${height} (dense-only fork active from height ${network.forkHeights.denseOnly})`,
    );
  }
}

/** CompactToBig: the target compact bits encode. The sign bit gives a negative number, as in Pearl. */
export function bitsToTarget(bits: number): bigint {
  if (!Number.isInteger(bits) || bits < 0 || bits > 0xffffffff) {
    throw new RangeError(`bits must be an unsigned 32-bit integer, got ${bits}`);
  }
  let mantissa = BigInt(bits & 0x007fffff);
  const exponent = bits >>> 24;
  if (exponent <= 3) mantissa >>= BigInt(8 * (3 - exponent));
  else mantissa <<= BigInt(8 * (exponent - 3));
  return (bits & 0x00800000) !== 0 ? -mantissa : mantissa;
}

/** BigToCompact: the compact bits for a target, keeping its 23 most significant bits. */
export function targetToBits(target: bigint): number {
  if (target === 0n) return 0;
  const magnitude = target < 0n ? -target : target;
  let exponent = magnitude.toString(16).length;
  exponent = Math.ceil(exponent / 2);
  let mantissa =
    exponent <= 3
      ? Number(magnitude) * 256 ** (3 - exponent)
      : Number((magnitude >> BigInt(8 * (exponent - 3))) & 0xffffffffn);
  // A mantissa with the sign bit set would read as negative, so give up a byte.
  if ((mantissa & 0x00800000) !== 0) {
    mantissa >>>= 8;
    exponent += 1;
  }
  let bits = ((exponent << 24) | mantissa) >>> 0;
  if (target < 0n) bits = (bits | 0x00800000) >>> 0;
  return bits;
}

/** CalcWork: the work a block with these bits adds to its chain, 2^256 / (target + 1). */
export function workForBits(bits: number): bigint {
  const target = bitsToTarget(bits);
  if (target <= 0n) return 0n;
  return (1n << 256n) / (target + 1n);
}

/**
 * Difficulty as getdifficulty and getblock report it: the network's
 * PowLimitBits target over this one, rounded to 8 decimal places.
 */
export function difficultyForBits(bits: number, network: PearlNetwork): number {
  const max = bitsToTarget(network.powLimitBits);
  const target = bitsToTarget(bits);
  if (target === 0n) throw new RangeError('bits encode a zero target');
  // big.Rat.FloatString(8): round half away from zero.
  const negative = max < 0n !== target < 0n;
  const numerator = (max < 0n ? -max : max) * 100_000_000n;
  const denominator = target < 0n ? -target : target;
  let scaled = numerator / denominator;
  if (2n * (numerator % denominator) >= denominator) scaled += 1n;
  const text = `${negative ? '-' : ''}${scaled / 100_000_000n}.${(scaled % 100_000_000n).toString().padStart(8, '0')}`;
  return Number(text);
}

function emissionConstant(network: PearlNetwork): bigint {
  return network.targetSpacing > 0 ? BigInt(Math.floor(FOUR_YEARS / network.targetSpacing)) : DEFAULT_EMISSION_CONSTANT;
}

/** blockchain.CalcBlockSubsidy: the grain a block at this height may create. Zero for genesis. */
export function blockSubsidy(network: PearlNetwork, height: number): bigint {
  assertHeight(height);
  if (height === 0) return 0n;
  const e = emissionConstant(network);
  const h = BigInt(height);
  return (EMISSION_LIMIT * e) / ((h + e) * (h - 1n + e));
}

/**
 * Every subsidy from genesis to height inclusive: the most grain that can
 * exist once that block is mined. Fees do not add to it. Sums block by block,
 * as Pearl rounds each subsidy down.
 */
export function totalSupply(network: PearlNetwork, height: number): bigint {
  assertHeight(height);
  const e = emissionConstant(network);
  const numerator = EMISSION_LIMIT * e;
  let total = 0n;
  for (let h = 1n, end = BigInt(height); h <= end; h += 1n) {
    total += numerator / ((h + e) * (h - 1n + e));
  }
  return total;
}
