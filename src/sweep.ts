// Sweeping a single key: every unspent output of its key-path P2TR address
// into one output, with no change, as Oyster's sweepaccount tool does for an
// imported key (wallet/cmd/sweepaccount/main.go).
//
// sweepaccount tells the transaction author its destination script is 43
// bytes, the size of a whole P2TR output (main.go:223), so it pays for 9
// vbytes that are not there. The fee here is for the real 34-byte script.

import * as ecc from 'tiny-secp256k1';
import { toOutputScript } from './address.js';
import { buildPayment, finalizePayment } from './builder.js';
import type { SignedPayment } from './builder.js';
import type { SpendableOptions, Utxo } from './coinselect.js';
import type { PearlNetwork } from './networks.js';
import { taggedHash } from './script.js';
import { Transaction } from './transaction.js';
import { decodeWif, keyPathAddress } from './wif.js';

export interface SweepOptions extends SpendableOptions {
  network: PearlNetwork;
  /** Unspent outputs of the key's address. Each one is spent. */
  utxos: readonly Utxo[];
  /** Address that receives everything the fee leaves. */
  destination: string;
  /** Grain per 1000 vbytes. */
  feeRate: bigint;
  rbf?: boolean;
  minRelayFee?: bigint;
}

/** Spends every output of a private key's key-path P2TR address (keyPathAddress) to one destination. */
export function sweepKey(privateKey: Uint8Array, options: SweepOptions): SignedPayment {
  const { network } = options;
  const address = keyPathAddress(privateKey, network);
  const script = toOutputScript(address, network);
  for (const utxo of options.utxos) {
    if (utxo.script.length !== script.length || !utxo.script.every((byte, i) => byte === script[i])) {
      throw new Error(`unspent output ${utxo.txid}:${utxo.vout} does not pay ${address}`);
    }
  }
  const { destination, ...rest } = options;
  const payment = buildPayment({ ...rest, recipients: [{ address: destination, amount: 'max' }] });

  // The key-path signer is the BIP86 tweak of the key, negated first when
  // its public key has an odd Y.
  const publicKey = ecc.pointFromScalar(privateKey, true)!;
  const even = publicKey[0] === 0x03 ? ecc.privateNegate(privateKey) : privateKey;
  const tweaked = ecc.privateAdd(even, taggedHash('TapTweak', publicKey.slice(1)));
  if (tweaked === null) throw new Error('taproot tweak produced an invalid key');
  const signed = payment.transaction.clone();
  const scripts = payment.prevouts.map((prevout) => prevout.script);
  const values = payment.prevouts.map((prevout) => prevout.value);
  signed.ins.forEach((_, i) => {
    const hash = signed.hashForWitnessV1(i, scripts, values, Transaction.SIGHASH_DEFAULT);
    // Fresh BIP340 auxiliary randomness, as the signing accounts use.
    const signature = ecc.signSchnorr(hash, tweaked, crypto.getRandomValues(new Uint8Array(32)));
    if (!ecc.verifySchnorr(hash, script.subarray(2), signature)) {
      throw new Error(`invalid Taproot signature for input ${i}`);
    }
    signed.setWitness(i, [signature]);
  });
  return finalizePayment(payment, { signed, ...(options.minRelayFee === undefined ? {} : { minRelayFee: options.minRelayFee }) });
}

/** sweepKey for a key in wallet import format, as dumpprivkey writes it. */
export function sweepWif(wif: string, options: SweepOptions): SignedPayment {
  return sweepKey(decodeWif(wif, options.network).privateKey, options);
}
