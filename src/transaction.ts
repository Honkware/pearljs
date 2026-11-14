// Pearl currently shares Bitcoin's transaction and BIP174 wire formats.
// These helpers keep address encoding and amount validation in Pearl's
// modules instead of relying on bitcoinjs's Bitcoin-mainnet defaults.

/**
 * Transactions and PSBTs: parse, create, and finalize the way Pearl accepts.
 *
 * @module
 */

import { Psbt, Transaction } from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { MAX_GRAIN } from './amount.js';
import { toOutputScript } from './address.js';
import { multiAStack, parseMultiA } from './multia.js';
import { classifyOutputScript, tapLeafHash } from './script.js';
import { tapscriptSighash } from './scriptpath.js';
import { decompileScript } from './scripttools.js';
import { verifyP2mrLeafCommitment, verifyTaprootLeafCommitment } from './scripttree.js';
import type { PearlNetwork } from './networks.js';
import { fromBase64, toHex, varInt } from './internal/bytes.js';
import { PearlError, SigningError } from './errors.js';

export { Psbt, Transaction };

/**
 * An output: its script and its value in grain. The same shape serves for an
 * output to create and for a spent one; `prevouts` everywhere is a list of
 * these, one per input. A Utxo is one with its outpoint added.
 */
export interface TxOutput {
  script: Uint8Array;
  value: bigint;
}

function checkHex(hex: string, what: string): void {
  if (typeof hex !== 'string') {
    throw new TypeError(`${what} must be a hexadecimal string`);
  }
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
    throw new PearlError('TX_MALFORMED', `${what} must be non-empty, even-length hexadecimal`);
  }
}

/** Parses a serialized transaction from hex. Throws on malformed input. */
export function parseTransaction(hex: string): Transaction {
  checkHex(hex, 'transaction');
  return Transaction.fromHex(hex);
}

/** Serializes a transaction to hex, with witnesses unless includeWitness is false. */
export function serializeTransaction(
  tx: Transaction,
  includeWitness = true,
): string {
  if (includeWitness) return tx.toHex();
  const copy = tx.clone();
  copy.stripWitnesses();
  return copy.toHex();
}

/** An empty transaction. Version 1 unless given, as Oyster uses; CSV leaves need version 2. */
export function createTransaction(version = 1): Transaction {
  if (!Number.isInteger(version) || version < -0x80000000 || version > 0x7fffffff) {
    throw new RangeError('transaction version must be a signed 32-bit integer');
  }
  const tx = new Transaction();
  tx.version = version;
  return tx;
}

/** The txid as explorers and RPC show it: the hash of the transaction without witnesses, reversed, in hex. */
export function transactionId(tx: Transaction): string {
  return tx.getId();
}

/** The wtxid in display hex: the hash of the transaction with its witnesses. */
export function witnessTransactionId(tx: Transaction): string {
  return toHex(Uint8Array.from(tx.getHash(true)).reverse());
}

/**
 * Parses a base64 PSBT. Like Pearl's psbt.NewFromRawBytes, and unlike
 * bitcoinjs alone, it refuses bytes after the last map, lengths written as
 * non-canonical varints, and an input sighash type that is not 4 bytes.
 * Every failure is an Error with a message, also where the underlying parser
 * would throw a RangeError.
 */
export function parsePsbt(base64: string): Psbt {
  if (typeof base64 !== 'string') {
    throw new TypeError('PSBT must be a base64 string');
  }
  if (
    base64.length === 0 ||
    base64.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/][AEIMQUYcgkosw048]==|[A-Za-z0-9+/]{2}[AQgw]=)?$/.test(base64)
  ) {
    throw new PearlError('PSBT_MALFORMED', 'PSBT must be canonical padded base64');
  }
  let psbt: Psbt;
  try {
    psbt = Psbt.fromBase64(base64);
  } catch (error) {
    // A RangeError or TypeError here is the engine's, from bip174 trusting a
    // length it read; its message says nothing about the PSBT.
    const reason =
      error instanceof RangeError || error instanceof TypeError || !(error instanceof Error)
        ? 'a field is malformed'
        : error.message;
    throw new PearlError('PSBT_MALFORMED', `invalid PSBT: ${reason}`);
  }
  const bytes = fromBase64(base64);
  const end = psbtEnd(bytes, psbt.inputCount, psbt.txOutputs.length);
  if (end !== bytes.length) {
    throw new PearlError('PSBT_MALFORMED', `invalid PSBT: ${bytes.length - end} bytes follow the last map`);
  }
  return psbt;
}

const PSBT_MAGIC_LENGTH = 5;

const PSBT_IN_SIGHASH_TYPE = 0x03;

/**
 * Walks the key-value maps of a PSBT that already parsed and returns the
 * offset after the last one. bitcoinjs stops reading there without looking
 * at what follows. On the way it checks what bitcoinjs does not: lengths are
 * canonical varints, and an input's sighash type is exactly 4 bytes, where
 * bip174 reads the first 4 of any longer value and drops the rest.
 */
function psbtEnd(bytes: Uint8Array, inputs: number, outputs: number): number {
  let offset = PSBT_MAGIC_LENGTH;
  const malformed = (): Error => new PearlError('PSBT_MALFORMED', 'invalid PSBT: a key or value runs past the end');
  const readLength = (): number => {
    const first = bytes[offset];
    if (first === undefined) throw malformed();
    offset += 1;
    if (first < 0xfd) return first;
    const width = first === 0xfd ? 2 : first === 0xfe ? 4 : 8;
    if (offset + width > bytes.length) throw malformed();
    let value = 0;
    for (let i = width - 1; i >= 0; i -= 1) value = value * 256 + bytes[offset + i]!;
    offset += width;
    if (value < (width === 2 ? 0xfd : width === 4 ? 0x10000 : 0x100000000)) {
      throw new PearlError('PSBT_MALFORMED', 'invalid PSBT: a length is a non-canonical varint');
    }
    return value;
  };
  for (let map = 0; map < 1 + inputs + outputs; map += 1) {
    const isInput = map >= 1 && map <= inputs;
    for (let keyLength = readLength(); keyLength !== 0; keyLength = readLength()) {
      const sighashType = isInput && keyLength === 1 && bytes[offset] === PSBT_IN_SIGHASH_TYPE;
      offset += keyLength;
      // Read into a constant first: `offset += readLength()` would add to the offset from before the read.
      const valueLength = readLength();
      offset += valueLength;
      if (offset > bytes.length) throw malformed();
      if (sighashType && valueLength !== 4) {
        throw new PearlError('PSBT_MALFORMED', `invalid PSBT: input ${map - 1} has a sighash type of ${valueLength} bytes, not 4`);
      }
    }
  }
  return offset;
}

/**
 * Starts a PSBT from an unsigned transaction. Throws when the transaction
 * already carries signatures or witnesses. The inputs are bare; prepareInput and
 * the script-path prepare functions fill them in.
 */
export function createPsbt(tx: Transaction): Psbt {
  const psbt = new Psbt();
  psbt.setVersion(tx.version);
  psbt.setLocktime(tx.locktime);
  for (const input of tx.ins) {
    if (input.script.length !== 0 || input.witness.length !== 0) {
      throw new PearlError('PSBT_MALFORMED', 'PSBT unsigned transactions cannot contain signatures or witnesses');
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
 *
 * For the inputs finalized here, the leaf must open the output and every
 * signature for a key in the leaf must verify, so a PSBT that cannot make a
 * valid spend fails here and not at the node.
 *
 * Throws when an input lacks the signatures its leaf needs, when a script-path
 * signature does not verify, and when bitcoinjs's fee-rate guard refuses the
 * result.
 */
export function finalizePsbt(psbt: Psbt): Transaction {
  psbt.data.inputs.forEach((input, index) => {
    if (input.finalScriptSig !== undefined || input.finalScriptWitness !== undefined) return;
    const witness = pearlScriptPathWitness(psbt, index);
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
 * anything else. As in Pearl, all signatures must be for the same leaf. A
 * P2MR leaf that is not multi_a takes the signatures of the keys it pushes,
 * in PSBT order; signatures for other keys are left out.
 */
function pearlScriptPathWitness(psbt: Psbt, inputIndex: number): Uint8Array[] | null {
  const input = psbt.data.inputs[inputIndex]!;
  const signatures = input.tapScriptSig ?? [];
  if (input.tapKeySig !== undefined || signatures.length === 0) return null;
  const target = toHex(signatures[0]!.leafHash);
  if (signatures.some((sig) => toHex(sig.leafHash) !== target)) {
    throw new SigningError('INPUT_MISMATCH', 'script-path signatures reference different leaves; only one script path is supported');
  }
  const leaf = (input.tapLeafScript ?? []).find((item) => toHex(tapLeafHash(item.script, item.leafVersion)) === target);
  if (leaf === undefined) {
    throw new SigningError('INPUT_MISMATCH', 'no tap leaf script matches the script-path signatures');
  }
  const multiA = parseMultiA(leaf.script);
  const prevScript = input.witnessUtxo?.script;
  const kind = prevScript === undefined ? undefined : classifyOutputScript(prevScript);
  if (multiA === null && kind !== 'p2mr') return null;
  if (prevScript !== undefined && kind === 'p2mr') {
    verifyP2mrLeafCommitment(leaf.controlBlock, prevScript.slice(2), leaf.script);
  } else if (prevScript !== undefined && kind === 'p2tr') {
    verifyTaprootLeafCommitment(leaf.controlBlock, prevScript.slice(2), leaf.script);
  }

  const leafKeys = new Set(
    decompileScript(leaf.script)
      .filter((chunk): chunk is Uint8Array => chunk instanceof Uint8Array && chunk.length === 32)
      .map(toHex),
  );
  const tx = Transaction.fromBuffer(psbt.data.globalMap.unsignedTx.toBuffer());
  const prevouts = tx.ins.map((txInput, index): TxOutput => {
    const other = psbt.data.inputs[index]!;
    const utxo =
      other.witnessUtxo ??
      (other.nonWitnessUtxo === undefined
        ? undefined
        : Transaction.fromBuffer(other.nonWitnessUtxo).outs[txInput.index]);
    if (utxo === undefined) {
      throw new SigningError('INPUT_UNPREPARED', `PSBT input ${index} has no UTXO to check script-path signatures against`);
    }
    return { script: utxo.script, value: utxo.value };
  });
  const forLeaf = signatures.filter((sig) => {
    const key = toHex(sig.pubkey);
    if (!leafKeys.has(key)) return false;
    const { signature } = sig;
    const sighashType = signature.length === 65 ? signature[64]! : Transaction.SIGHASH_DEFAULT;
    if (
      (signature.length !== 64 && signature.length !== 65) ||
      (signature.length === 65 && sighashType === Transaction.SIGHASH_DEFAULT) ||
      !ecc.isXOnlyPoint(sig.pubkey) ||
      !ecc.verifySchnorr(
        tapscriptSighash(tx, inputIndex, { prevouts, leafHash: sig.leafHash, sighashType }),
        sig.pubkey,
        signature.subarray(0, 64),
      )
    ) {
      throw new SigningError('SIGNATURE_INVALID', `PSBT input ${inputIndex} has an invalid script-path signature for key ${key}`);
    }
    return true;
  });

  if (multiA === null) {
    if (forLeaf.length === 0) {
      throw new SigningError('SIGNATURES_MISSING', `PSBT input ${inputIndex} has no signature for a key its leaf pushes`);
    }
    return [...forLeaf.map((sig) => sig.signature), leaf.script, leaf.controlBlock];
  }
  // multiAStack refuses a signature for a key outside the leaf, as Pearl does.
  const byKey = new Map(signatures.map((sig) => [toHex(sig.pubkey), sig.signature]));
  return [...multiAStack(multiA, byKey), leaf.script, leaf.controlBlock];
}

/** A witness stack as it is serialized: item count, then each item with its length. */
export function serializeWitness(witness: readonly Uint8Array[]): Uint8Array {
  return Uint8Array.from([
    ...varInt(witness.length),
    ...witness.flatMap((item) => [...varInt(item.length), ...item]),
  ]);
}

/**
 * Adds an output paying a Pearl address to a PSBT. value is in grain. Throws
 * when the address is not valid on the network or the value is outside Pearl's
 * bounds.
 */
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
    throw new PearlError('AMOUNT_OUT_OF_RANGE', 'output value is outside Pearl amount bounds');
  }
  psbt.addOutput({ script: toOutputScript(address, network), value });
}
