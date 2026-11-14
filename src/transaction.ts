// Pearl currently shares Bitcoin's transaction and BIP174 wire formats.
// These helpers keep address encoding and amount validation in Pearl's
// modules instead of relying on bitcoinjs's Bitcoin-mainnet defaults.

import { Psbt, Transaction } from 'bitcoinjs-lib';
import { MAX_GRAIN } from './amount.js';
import { toOutputScript } from './address.js';
import type { PearlNetwork } from './networks.js';

export { Psbt, Transaction };

function checkHex(hex: string, what: string): void {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error(`${what} must be non-empty, even-length hexadecimal`);
  }
}

export function parseTransaction(hex: string): Transaction {
  checkHex(hex, 'transaction');
  return Transaction.fromHex(hex);
}

export function serializeTransaction(
  tx: Transaction,
  includeWitness = true,
): string {
  if (includeWitness) return tx.toHex();
  const copy = tx.clone();
  copy.stripWitnesses();
  return copy.toHex();
}

export function createTransaction(version = 1): Transaction {
  if (!Number.isInteger(version) || version < -0x80000000 || version > 0x7fffffff) {
    throw new RangeError('transaction version must be a signed 32-bit integer');
  }
  const tx = new Transaction();
  tx.version = version;
  return tx;
}

export function transactionId(tx: Transaction): string {
  return tx.getId();
}

export function witnessTransactionId(tx: Transaction): string {
  return Array.from(tx.getHash(true))
    .reverse()
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function parsePsbt(base64: string): Psbt {
  if (
    base64.length === 0 ||
    base64.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/][AEIMQUYcgkosw048]==|[A-Za-z0-9+/]{2}[AQgw]=)?$/.test(base64)
  ) {
    throw new Error('PSBT must be canonical padded base64');
  }
  return Psbt.fromBase64(base64);
}

export function createPsbt(tx: Transaction): Psbt {
  const psbt = new Psbt();
  psbt.setVersion(tx.version);
  psbt.setLocktime(tx.locktime);
  for (const input of tx.ins) {
    if (input.script.length !== 0 || input.witness.length !== 0) {
      throw new Error('PSBT unsigned transactions cannot contain signatures or witnesses');
    }
    psbt.addInput({
      hash: input.hash,
      index: input.index,
      sequence: input.sequence,
    });
  }
  for (const output of tx.outs) {
    psbt.addOutput({ script: output.script, value: output.value });
  }
  return psbt;
}

export function finalizePsbt(psbt: Psbt): Transaction {
  psbt.data.inputs.forEach((input, index) => {
    if (input.finalScriptSig === undefined && input.finalScriptWitness === undefined) {
      psbt.finalizeInput(index);
    }
  });
  return psbt.extractTransaction();
}

export function addPearlOutput(
  psbt: Psbt,
  address: string,
  value: bigint,
  network: PearlNetwork,
): void {
  if (typeof value !== 'bigint') {
    throw new TypeError('output value must be a bigint of grains');
  }
  if (value < 0n || value > MAX_GRAIN) {
    throw new Error('output value is outside Pearl amount bounds');
  }
  psbt.addOutput({ script: toOutputScript(address, network), value });
}
