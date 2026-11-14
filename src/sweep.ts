// Sweeping a single key: every unspent output of its key-path P2TR address
// into one output, with no change, as Oyster's sweepaccount tool does for an
// imported key (wallet/cmd/sweepaccount/main.go).
//
// sweepaccount tells the transaction author its destination script is 43
// bytes, the size of a whole P2TR output (main.go:223), so it pays for 9
// vbytes that are not there. The fee here is for the real 34-byte script.

/**
 * Sweeps every output of a single key into one output.
 *
 * @module
 */

import * as ecc from 'tiny-secp256k1';
import { toOutputScript } from './address.js';
import { buildPayment, finalizePayment } from './builder.js';
import type { SignedPayment } from './builder.js';
import type { SpendableOptions, Utxo } from './coinselect.js';
import type { PearlNetwork } from './networks.js';
import { taggedHash } from './script.js';
import { Transaction } from './transaction.js';
import { decodeWif, keyPathAddress } from './wif.js';
import { PearlError, SigningError } from './errors.js';
import type { FeeRate } from './amount.js';

/** Options for sweepKey and sweepWif. */
export interface SweepOptions extends SpendableOptions {
  network: PearlNetwork;
  /** Unspent outputs of the key's address. Each one is spent. */
  utxos: readonly Utxo[];
  /** Address that receives everything the fee leaves. */
  destination: string;
  /** Grain per 1000 vbytes. */
  feeRate: FeeRate;
  /** Signal replace-by-fee. Off unless given. */
  rbf?: boolean;
  /** pearld's --minrelaytxfee if it is not the default, in grain per 1000 vbytes. */
  relayFeeRate?: FeeRate;
  /**
   * The 32 bytes of auxiliary randomness BIP340 mixes into each nonce. Fresh
   * random bytes unless given; fix it only for reproducible signatures in tests.
   */
  auxRand?: Uint8Array;
}

/**
 * Spends every output of a private key's key-path P2TR address (keyPathAddress) to one destination.
 *
 * Throws when an unspent output does not pay the key's address, and what
 * buildPayment throws otherwise. feeRate is in grain per 1000 vbytes. The
 * keys derived for signing are overwritten before returning; privateKey is
 * the caller's and is left as it is.
 */
export function sweepKey(privateKey: Uint8Array, options: SweepOptions): SignedPayment {
  const { network } = options;
  const address = keyPathAddress(privateKey, network);
  const script = toOutputScript(address, network);
  for (const utxo of options.utxos) {
    if (utxo.script.length !== script.length || !utxo.script.every((byte, i) => byte === script[i])) {
      throw new PearlError('UTXO_INVALID', `unspent output ${utxo.txid}:${utxo.vout} does not pay ${address}`);
    }
  }
  const { destination, auxRand, ...rest } = options;
  if (auxRand !== undefined && (!(auxRand instanceof Uint8Array) || auxRand.length !== 32)) {
    throw new Error('auxRand must be 32 bytes');
  }
  const payment = buildPayment({ ...rest, recipients: [{ address: destination, amount: 'max' }] });

  // The key-path signer is the BIP86 tweak of the key, negated first when
  // its public key has an odd Y.
  const publicKey = ecc.pointFromScalar(privateKey, true)!;
  const even = publicKey[0] === 0x03 ? ecc.privateNegate(privateKey) : privateKey;
  const tweaked = ecc.privateAdd(even, taggedHash('TapTweak', publicKey.slice(1)));
  if (tweaked === null) throw new PearlError('KEY_INVALID', 'taproot tweak produced an invalid key');
  const signed = payment.transaction.clone();
  const scripts = payment.prevouts.map((prevout) => prevout.script);
  const values = payment.prevouts.map((prevout) => prevout.value);
  try {
    signed.ins.forEach((_, i) => {
      const hash = signed.hashForWitnessV1(i, scripts, values, Transaction.SIGHASH_DEFAULT);
      const signature = ecc.signSchnorr(hash, tweaked, auxRand ?? crypto.getRandomValues(new Uint8Array(32)));
      if (!ecc.verifySchnorr(hash, script.subarray(2), signature)) {
        throw new SigningError('SIGNATURE_INVALID', `invalid Taproot signature for input ${i}`);
      }
      signed.setWitness(i, [signature]);
    });
  } finally {
    tweaked.fill(0);
    if (even !== privateKey) even.fill(0);
  }
  return finalizePayment(payment, { signed, ...(options.relayFeeRate === undefined ? {} : { relayFeeRate: options.relayFeeRate }) });
}

/**
 * sweepKey for a key in wallet import format, as dumpprivkey writes it. The
 * decoded key is overwritten before returning; the WIF string cannot be.
 */
export function sweepWif(wif: string, options: SweepOptions): SignedPayment {
  const { privateKey } = decodeWif(wif, options.network);
  try {
    return sweepKey(privateKey, options);
  } finally {
    privateKey.fill(0);
  }
}
