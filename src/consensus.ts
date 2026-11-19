// Consensus data for explorers and miners: which certificate a height needs,
// compact difficulty bits, work, and Pearl's emission.
//
// Pearl's emission is a smooth curve, not Bitcoin's halvings: block h pays
// S*E / ((h+E)(h-1+E)) grain, where S is 2.1 billion PRL and E is four years
// of blocks, so half of S is paid out in the first four years and the rest
// ever more slowly (blockchain.CalcBlockSubsidy). Difficulty retargets every
// block (WTEMA) rather than every 2016, and getdifficulty divides by each
// network's own PowLimitBits.

/**
 * Consensus data: certificate rules by height, compact bits, difficulty, work,
 * and the emission curve.
 *
 * @module
 */

import { GRAIN_PER_PEARL } from './amount.js';
import { isMoECertificate } from './block.js';
import type { CertificateVersion, PearlCertificate } from './block.js';
import type { PearlNetwork } from './networks.js';
import { PearlError } from './errors.js';

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
  if (active(network.forkHeights.fp8, height)) return 4;
  if (active(network.forkHeights.saltedSeed, height)) return 3;
  if (active(network.forkHeights.moe, height)) return 2;
  return 1;
}

/**
 * Throws with Pearl's message when the certificate's version is wrong for
 * the height, or it carries a MoE proof after the dense-only fork. These are
 * the rules of blockchain.CheckCertificateRules that need no proof; the
 * rank-penalty rule reads the proof's public data and is not checked here.
 * Pearl does not apply that rule to V4 certificates.
 */
export function checkCertificateRules(certificate: PearlCertificate | null, network: PearlNetwork, height: number): void {
  if (certificate === null) throw new PearlError('BLOCK_CERTIFICATE_INVALID', 'block has no certificate');
  const want = requiredCertVersion(network, height);
  if (certificate.version !== want) {
    throw new PearlError('BLOCK_CERTIFICATE_INVALID',
      `certificate version ${certificate.version} is not allowed at height ${height} (require version ${want})`,
    );
  }
  if (isMoECertificate(certificate) && active(network.forkHeights.denseOnly, height)) {
    throw new PearlError('BLOCK_CERTIFICATE_INVALID',
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

/** The last block of a chain, as nextBlockBits reads it. Times are Unix seconds. */
export interface DifficultyParent {
  /** The block's compact bits. */
  readonly bits: number;
  /** The block's timestamp. */
  readonly timestamp: number;
  /** The timestamp of the block before it, or null when it is the genesis block. */
  readonly parentTimestamp: number | null;
}

/**
 * calcNextRequiredDifficulty: the bits a block with timestamp `time` must
 * carry on top of `last`, or on an empty chain when `last` is null. Pearl
 * retargets every block (WTEMA): the target moves by (t - targetSpacing) /
 * wtemaHalfLife of itself, where t is the time `last` took after its parent,
 * dividing as Go's big.Int does (rounding down), then stays within 1 and
 * powLimit. On a network with powNoRetargeting every block takes
 * powLimitBits, and with reduceMinDifficulty so does a block more than
 * minDiffReductionTime after `last`.
 */
export function nextBlockBits(network: PearlNetwork, last: DifficultyParent | null, time: number): number {
  for (const [name, value] of [['time', time], ['last.timestamp', last?.timestamp ?? 0], ['last.parentTimestamp', last?.parentTimestamp ?? 0]] as const) {
    if (!Number.isSafeInteger(value)) throw new RangeError(`${name} must be a whole number of seconds, got ${value}`);
  }
  if (!Number.isSafeInteger(network.wtemaHalfLife) || network.wtemaHalfLife <= 0) {
    throw new RangeError(`wtemaHalfLife must be a positive number of seconds, got ${network.wtemaHalfLife}`);
  }
  if (last === null || network.powNoRetargeting) return network.powLimitBits;
  const oldTarget = bitsToTarget(last.bits);
  if (network.reduceMinDifficulty && time > last.timestamp + network.minDiffReductionTime) return network.powLimitBits;
  if (last.parentTimestamp === null) return last.bits;
  const adjustment = BigInt(last.timestamp - last.parentTimestamp - network.targetSpacing) * oldTarget;
  const halfLife = BigInt(network.wtemaHalfLife);
  // big.Int.Div rounds toward negative infinity for a positive divisor; BigInt division truncates.
  const quotient = adjustment / halfLife - (adjustment % halfLife < 0n ? 1n : 0n);
  let target = oldTarget + quotient;
  if (target > network.powLimit) target = network.powLimit;
  if (target <= 0n) target = 1n;
  return targetToBits(target);
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

/**
 * blockchain.CalcBlockSubsidy: the grain a block at this height may create. Zero for genesis.
 *
 * In grain.
 */
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
 *
 * In grain. Takes time proportional to height.
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
