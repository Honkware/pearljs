// Pearl currently shares Bitcoin's transaction and BIP174 wire formats.
// These helpers keep address encoding and amount validation in Pearl's
// modules instead of relying on bitcoinjs's Bitcoin-mainnet defaults.

import { Psbt, Transaction } from 'bitcoinjs-lib';
import { MAX_GRAIN } from './amount.js';
import { toOutputScript } from './address.js';
import { multiAStack, parseMultiA } from './multia.js';
import { classifyOutputScript, tapLeafHash } from './script.js';
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

/**
 * Finalizes every input and extracts the transaction. Script-path inputs
 * spending a multi_a leaf, and all P2MR script-path inputs, are finalized
 * like Pearl's psbt.Finalize, since bitcoinjs leaves no empty item for keys
 * that did not sign and Pearl rejects that witness; other inputs use
 * bitcoinjs's finalizers.
 */
export function finalizePsbt(psbt: Psbt): Transaction {
  psbt.data.inputs.forEach((input, index) => {
    if (input.finalScriptSig !== undefined || input.finalScriptWitness !== undefined) return;
    const witness = pearlScriptPathWitness(input);
    if (witness === null) {
      psbt.finalizeInput(index);
    } else {
      psbt.finalizeTaprootInput(index, undefined, () => ({ finalScriptWitness: serializeWitness(witness) }));
    }
  });
  return psbt.extractTransaction();
}

/**
 * The full witness for a script-path input whose signatures are for a
 * multi_a leaf or that spends a P2MR output, or null when the input is
 * anything else. As in Pearl, all signatures must be for the same leaf, and
 * a P2MR leaf that is not multi_a takes them in PSBT order.
 */
function pearlScriptPathWitness(input: PsbtInput): Uint8Array[] | null {
  const signatures = input.tapScriptSig ?? [];
  if (input.tapKeySig !== undefined || signatures.length === 0) return null;
  const target = toHex(signatures[0]!.leafHash);
  if (signatures.some((sig) => toHex(sig.leafHash) !== target)) {
    throw new Error('script-path signatures reference different leaves; only one script path is supported');
  }
  const leaf = (input.tapLeafScript ?? []).find((item) => toHex(tapLeafHash(item.script, item.leafVersion)) === target);
  if (leaf === undefined) {
    throw new Error('no tap leaf script matches the script-path signatures');
  }
  const multiA = parseMultiA(leaf.script);
  if (multiA === null) {
    const prevScript = input.witnessUtxo?.script;
    if (prevScript === undefined || classifyOutputScript(prevScript) !== 'p2mr') return null;
    return [...signatures.map((sig) => sig.signature), leaf.script, leaf.controlBlock];
  }
  const byKey = new Map(signatures.map((sig) => [toHex(sig.pubkey), sig.signature]));
  return [...multiAStack(multiA, byKey), leaf.script, leaf.controlBlock];
}

type PsbtInput = Psbt['data']['inputs'][number];

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function varInt(value: number): number[] {
  if (value < 0xfd) return [value];
  if (value <= 0xffff) return [0xfd, value & 0xff, value >> 8];
  return [0xfe, value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, value >>> 24];
}

/** A witness stack as it is serialized: item count, then each item with its length. */
export function serializeWitness(witness: readonly Uint8Array[]): Uint8Array {
  return Uint8Array.from([
    ...varInt(witness.length),
    ...witness.flatMap((item) => [...varInt(item.length), ...item]),
  ]);
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
