import { PearlError } from './errors.js';
// Pearl monetary amounts. All values are bigint grains; JS numbers are
// rejected at the boundary because they lose precision well below MAX_GRAIN.

/**
 * Amounts in grain and their PRL text form, and fee rate conversions. Every
 * fee rate in pearljs is grain per 1000 vbytes.
 *
 * @module
 */

/** Grain in one PRL. Every amount in pearljs is a bigint of grain. */
export const GRAIN_PER_PEARL = 100000000n;

// btcutil.MaxGrain, the maximum transaction amount (21e9 * GrainPerPearl).
// This is an amount validity bound, not the chain's total supply.
/**
 * The largest amount a transaction output may carry, in grain: 21 billion PRL
 * (btcutil.MaxGrain). A validity bound, not the supply; see EMISSION_LIMIT.
 */
export const MAX_GRAIN = 2100000000000000000n;

const DECIMALS = 8;
const PEARL_RE = /^\d+(\.\d{1,8})?$/;

/**
 * Parses a decimal pearl string like "1.5" into grains.
 *
 * Throws for anything but a non-negative decimal with at most 8 decimal places,
 * and for an amount above MAX_GRAIN.
 */
export function parsePearl(text: string): bigint {
  if (typeof text !== 'string') {
    throw new TypeError('amount must be a decimal string');
  }
  if (!PEARL_RE.test(text)) {
    throw new PearlError('AMOUNT_INVALID', `invalid pearl amount: ${JSON.stringify(text)}`);
  }
  const dot = text.indexOf('.');
  const whole = dot === -1 ? text : text.slice(0, dot);
  const frac = (dot === -1 ? '' : text.slice(dot + 1)).padEnd(DECIMALS, '0');
  const grain = BigInt(whole) * GRAIN_PER_PEARL + BigInt(frac || '0');
  if (grain > MAX_GRAIN) {
    throw new PearlError('AMOUNT_OUT_OF_RANGE', `pearl amount exceeds maximum: ${text}`);
  }
  return grain;
}

/**
 * Formats grains as a decimal pearl string without trailing zeros. Negative
 * amounts get a leading minus, as Oyster's listtransactions reports sends.
 *
 * Throws for a value that is not a bigint or is outside plus or minus MAX_GRAIN.
 */
export function formatPearl(grain: bigint): string {
  if (typeof grain !== 'bigint') {
    throw new TypeError('amount must be a bigint of grains');
  }
  if (grain < -MAX_GRAIN || grain > MAX_GRAIN) {
    throw new PearlError('AMOUNT_OUT_OF_RANGE', `grain amount out of range: ${grain}`);
  }
  const magnitude = grain < 0n ? -grain : grain;
  const whole = magnitude / GRAIN_PER_PEARL;
  const frac = (magnitude % GRAIN_PER_PEARL)
    .toString()
    .padStart(DECIMALS, '0')
    .replace(/0+$/, '');
  return `${grain < 0n ? '-' : ''}${frac === '' ? whole.toString() : `${whole}.${frac}`}`;
}

// Fee rates are bigint grain per 1000 vbytes throughout pearljs, the unit of
// pearld's relay fee and Oyster's fee arguments. Wallets show grain per
// vbyte, and the RPC and Pearl's desktop wallet show PRL per 1000 vbytes.

/**
 * A fee rate in grain per 1000 vbytes. Every fee rate in pearljs has this
 * unit, whatever it is called: `feeRate`, `relayFeeRate`, `maxFeeRate`.
 * 1000n is one grain per vbyte, pearld's relay minimum.
 */
export type FeeRate = bigint;

const VBYTE_RATE_RE = /^\d+(\.\d{1,3})?$/;

/**
 * A fee rate from grain per vbyte, as a bigint or a decimal string with up to three decimals like "1.5".
 *
 * Returns grain per 1000 vbytes, the unit every fee rate in pearljs uses. Throws
 * for a negative rate or more than three decimals.
 */
export function feeRateFromGrainPerVbyte(rate: bigint | string): FeeRate {
  if (typeof rate === 'bigint') {
    if (rate < 0n) throw new PearlError('FEE_RATE_INVALID', `invalid fee rate: ${rate}`);
    return rate * 1000n;
  }
  if (typeof rate !== 'string') {
    throw new TypeError('fee rate must be a bigint or a decimal string');
  }
  if (!VBYTE_RATE_RE.test(rate)) {
    throw new PearlError('FEE_RATE_INVALID', `invalid fee rate: ${JSON.stringify(rate)}`);
  }
  const [whole, frac = ''] = rate.split('.');
  return BigInt(whole!) * 1000n + BigInt(frac.padEnd(3, '0'));
}

/**
 * A fee rate in grain per vbyte, as a decimal string without trailing zeros.
 *
 * feeRate is in grain per 1000 vbytes.
 */
export function feeRateToGrainPerVbyte(feeRate: FeeRate): string {
  if (typeof feeRate !== 'bigint' || feeRate < 0n) {
    throw new PearlError('FEE_RATE_INVALID', 'fee rate must be a non-negative bigint of grain per 1000 vbytes');
  }
  const frac = (feeRate % 1000n).toString().padStart(3, '0').replace(/0+$/, '');
  return frac === '' ? (feeRate / 1000n).toString() : `${feeRate / 1000n}.${frac}`;
}

/**
 * A fee rate from PRL per 1000 vbytes, such as "0.00001".
 *
 * Returns grain per 1000 vbytes.
 */
export function feeRateFromPearlPerKvB(rate: string): FeeRate {
  return parsePearl(rate);
}

/**
 * A fee rate in PRL per 1000 vbytes.
 *
 * feeRate is in grain per 1000 vbytes.
 */
export function feeRateToPearlPerKvB(feeRate: FeeRate): string {
  if (typeof feeRate !== 'bigint' || feeRate < 0n) {
    throw new PearlError('FEE_RATE_INVALID', 'fee rate must be a non-negative bigint of grain per 1000 vbytes');
  }
  return formatPearl(feeRate);
}
