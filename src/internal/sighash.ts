// Sighash type checks shared by the signers. Not a subpath export.

import { Transaction } from 'bitcoinjs-lib';
import { SigningError } from '../errors.js';
import type { PsbtSighashOptions } from '../scriptpath.js';

const SIGHASH_TYPES = new Set([
  Transaction.SIGHASH_DEFAULT,
  Transaction.SIGHASH_ALL,
  Transaction.SIGHASH_NONE,
  Transaction.SIGHASH_SINGLE,
  Transaction.SIGHASH_ALL | Transaction.SIGHASH_ANYONECANPAY,
  Transaction.SIGHASH_NONE | Transaction.SIGHASH_ANYONECANPAY,
  Transaction.SIGHASH_SINGLE | Transaction.SIGHASH_ANYONECANPAY,
]);

/**
 * Throws unless value is a Taproot sighash type: DEFAULT, ALL, NONE or SINGLE,
 * the last three also with ANYONECANPAY.
 */
export function assertTaprootSighashType(value: number): void {
  if (!SIGHASH_TYPES.has(value)) {
    throw new SigningError('SIGHASH_UNSUPPORTED', `unsupported Taproot sighash type ${value}`);
  }
}

/** The sighash type a PSBT input asks for, refused unless the caller allows it. */
export function psbtSighashType(
  requested: number | undefined,
  inputIndex: number,
  options: PsbtSighashOptions = {},
): number {
  const sighashType = requested ?? Transaction.SIGHASH_DEFAULT;
  const allowed = options.allowedSighashTypes ?? [Transaction.SIGHASH_DEFAULT];
  if (!Array.isArray(allowed)) {
    throw new TypeError('allowedSighashTypes must be an array of sighash types');
  }
  allowed.forEach(assertTaprootSighashType);
  if (!allowed.includes(sighashType)) {
    throw new SigningError('SIGHASH_NOT_ALLOWED',
      `PSBT input ${inputIndex} asks for sighash type 0x${sighashType.toString(16).padStart(2, '0')}, ` +
        'which is not in allowedSighashTypes',
    );
  }
  return sighashType;
}
