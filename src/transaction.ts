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
import { fromOutputScript, toOutputScript } from './address.js';
import { ScriptRejectedError, verifyInput } from './interpreter.js';
import { multiAStack, parseMultiA } from './multia.js';
import { OP_CODES } from './opcodes.js';
import { hash256 } from './crypto.js';
import { classifyOutputScript, tapLeafHash } from './script.js';
import { tapscriptSighash } from './scriptpath.js';
import { decompileScript } from './scripttools.js';
import { verifyP2mrLeafCommitment, verifyTaprootLeafCommitment } from './scripttree.js';
import type { AccountChild, PearlAccount } from './keys.js';
import type { PearlNetwork } from './networks.js';
import { p2tr } from './payments.js';
import { equalBytes, fromBase64, toHex, varInt } from './internal/bytes.js';
import { ensureEcc } from './internal/ecc.js';
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

/**
 * Parses a serialized transaction from hex. Throws TX_MALFORMED for input
 * that is not a transaction, and for an output that is negative or above
 * MAX_GRAIN, which no Pearl transaction can carry and Transaction.fromHex
 * alone lets through.
 */
export function parseTransaction(hex: string): Transaction {
  checkHex(hex, 'transaction');
  let tx: Transaction;
  try {
    tx = Transaction.fromHex(hex);
  } catch (err) {
    throw new PearlError('TX_MALFORMED', err instanceof Error ? err.message : 'transaction could not be decoded', { cause: err });
  }
  tx.outs.forEach((output, i) => {
    // The wire value is a signed 64-bit integer.
    if (output.value < 0n) throw new PearlError('TX_MALFORMED', `transaction output ${i} has a negative value`);
    if (output.value > MAX_GRAIN) {
      throw new PearlError('TX_MALFORMED', `transaction output ${i} holds ${output.value} grain, more than the largest Pearl amount`);
    }
  });
  return tx;
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

/**
 * The wtxid in display hex: the hash of the transaction with its witnesses.
 * For a coinbase this is its own hash, as pearld shows it, not the zeros that
 * stand for it in the witness merkle tree.
 */
export function witnessTransactionId(tx: Transaction): string {
  // Not getHash(true), which answers zeros for a coinbase.
  return toHex(hash256(tx.toBuffer()).reverse());
}

/**
 * Parses a base64 PSBT with the checks of Pearl's psbt.NewFromRawBytes: it
 * refuses bytes after the last map, lengths written as non-canonical varints,
 * and an input sighash type that is not 4 bytes. Every failure is a
 * PearlError with code PSBT_MALFORMED.
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
  ensureEcc();
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
  // Also for a caller who signs this PSBT with bitcoinjs's own methods.
  ensureEcc();
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
 * Finalizes every input and extracts the transaction. Script-path inputs get
 * the witness Pearl's psbt.Finalize builds: for a multi_a leaf an empty item
 * for each key that did not sign, which Pearl requires, and for any other
 * leaf the signatures of the keys it pushes, the first key's last.
 *
 * Every witness built here is run through Pearl's script rules before it is
 * kept, so a PSBT that cannot make a valid spend fails here and not at the
 * node. A leaf that needs more than signatures (a preimage, a number, items
 * for OP_CAT) cannot be satisfied from the PSBT alone: give its items to
 * finalizeScriptPathInput first, and this function leaves that input as it
 * is.
 *
 * Throws a SigningError: WITNESS_ITEMS_NEEDED for a leaf its signatures do
 * not satisfy, SIGNATURES_MISSING, SIGNATURE_INVALID, and
 * INPUT_NOT_FINALIZED for an input with nothing to finalize it. Throws a
 * ScriptRejectedError with the engine's code when a witness fails, and when
 * the result pays more than 5000 grain per vbyte.
 */
export function finalizePsbt(psbt: Psbt): Transaction {
  ensureEcc();
  psbt.data.inputs.forEach((input, index) => {
    if (input.finalScriptSig !== undefined || input.finalScriptWitness !== undefined) return;
    if (isScriptPath(input)) {
      finalizeScriptPath(psbt, index);
      return;
    }
    try {
      psbt.finalizeInput(index);
    } catch (err) {
      throw new SigningError(
        'INPUT_NOT_FINALIZED',
        `PSBT input ${index} cannot be finalized: it has no key-path signature and no tap leaf to spend through`,
        { cause: err },
      );
    }
    checkFinalWitness(psbt, index);
  });
  return psbt.extractTransaction();
}

/**
 * The leaf's witness items for finalizeScriptPathInput: the items
 * themselves, or a function that builds them from the input's signatures.
 * `signatureFor` returns the signature the PSBT holds for a key the leaf
 * pushes, verified, and throws SIGNATURES_MISSING when there is none.
 */
export type ScriptPathStack =
  | readonly Uint8Array[]
  | ((signatureFor: (publicKey: Uint8Array) => Uint8Array) => readonly Uint8Array[]);

/** What finalizeScriptPathInput needs besides the PSBT and the input. */
export interface ScriptPathFinalizeOptions {
  /**
   * The items the leaf starts with, in witness order: the last one is on top
   * of the stack when the leaf runs. The script and the control block are
   * added after them.
   */
  stack: ScriptPathStack;
  /**
   * Hash of the leaf to spend through. Needed only when the input lists
   * several leaves and holds no signature that names one.
   */
  leafHash?: Uint8Array;
}

/**
 * Finalizes one P2TR or P2MR script-path input with witness items the
 * caller supplies, for a leaf that takes more than signatures: a hash lock's
 * preimage, the argument of a timelock branch, the pieces an OP_CAT leaf
 * joins. finalizePsbt then finalizes the other inputs and extracts.
 *
 * The leaf must open the spent output, every signature taken through
 * `signatureFor` must verify, and the finished witness must pass Pearl's
 * script rules for this input; otherwise nothing is written.
 *
 * Throws a ScriptRejectedError carrying the engine's code when the witness
 * fails, and a SigningError: INPUT_MISMATCH for an input that is not a
 * script path or a leaf the input does not list, INPUT_UNPREPARED when an
 * input of the PSBT has no UTXO, SIGNATURES_MISSING and SIGNATURE_INVALID
 * for the signatures.
 */
export function finalizeScriptPathInput(psbt: Psbt, inputIndex: number, options: ScriptPathFinalizeOptions): void {
  ensureEcc();
  const input = psbt.data.inputs[inputIndex];
  if (!Number.isInteger(inputIndex) || input === undefined) {
    throw new RangeError(`PSBT input index ${inputIndex} is out of range`);
  }
  if (input.finalScriptSig !== undefined || input.finalScriptWitness !== undefined) {
    throw new SigningError('INPUT_MISMATCH', `PSBT input ${inputIndex} is already finalized`);
  }
  if (!isScriptPath(input)) {
    throw new SigningError('INPUT_MISMATCH', `PSBT input ${inputIndex} is not a script-path input: it has ${input.tapKeySig === undefined ? 'no tap leaf script' : 'a key-path signature'}`);
  }
  if (typeof options.stack !== 'function' && !(Array.isArray(options.stack) && options.stack.every((item) => item instanceof Uint8Array))) {
    throw new TypeError('stack must be an array of byte arrays or a function that returns one');
  }
  finalizeScriptPath(psbt, inputIndex, options);
}

type PsbtInput = Psbt['data']['inputs'][number];

// A key-path signature wins, as in Pearl's finalizer: it makes the smaller witness.
function isScriptPath(input: PsbtInput): boolean {
  return input.tapKeySig === undefined && ((input.tapLeafScript ?? []).length > 0 || (input.tapScriptSig ?? []).length > 0);
}

/** The unsigned transaction and every spent output, which script-path signatures and the script check cover. */
function psbtSpend(psbt: Psbt, what: string): { tx: Transaction; prevouts: TxOutput[] } {
  const tx = Transaction.fromBuffer(psbt.data.globalMap.unsignedTx.toBuffer());
  const prevouts = tx.ins.map((txInput, index): TxOutput => {
    const other = psbt.data.inputs[index]!;
    const utxo =
      other.witnessUtxo ??
      (other.nonWitnessUtxo === undefined
        ? undefined
        : Transaction.fromBuffer(other.nonWitnessUtxo).outs[txInput.index]);
    if (utxo === undefined) {
      throw new SigningError('INPUT_UNPREPARED', `PSBT input ${index} has no UTXO to ${what}`);
    }
    return { script: utxo.script, value: utxo.value };
  });
  return { tx, prevouts };
}

const CHECKSIG_OPCODES: readonly number[] = [OP_CODES.OP_CHECKSIG, OP_CODES.OP_CHECKSIGVERIFY, OP_CODES.OP_CHECKSIGADD];

/**
 * Builds the witness of a script-path input, runs it through the script
 * engine and stores it. As in Pearl, all signatures must be for the same
 * leaf. Without `supplied` the leaf's arguments are its signatures alone.
 */
function finalizeScriptPath(
  psbt: Psbt,
  inputIndex: number,
  supplied?: { stack: ScriptPathStack; leafHash?: Uint8Array },
): void {
  const input = psbt.data.inputs[inputIndex]!;
  const leaves = input.tapLeafScript ?? [];
  let signatures = input.tapScriptSig ?? [];
  let target: string;
  if (supplied?.leafHash !== undefined) {
    target = toHex(supplied.leafHash);
    signatures = signatures.filter((sig) => toHex(sig.leafHash) === target);
  } else if (signatures.length > 0) {
    target = toHex(signatures[0]!.leafHash);
    if (signatures.some((sig) => toHex(sig.leafHash) !== target)) {
      throw new SigningError('INPUT_MISMATCH', 'script-path signatures reference different leaves; only one script path is supported');
    }
  } else if (leaves.length === 1) {
    target = toHex(tapLeafHash(leaves[0]!.script, leaves[0]!.leafVersion));
  } else {
    throw new SigningError('INPUT_MISMATCH', `PSBT input ${inputIndex} lists ${leaves.length} tap leaves and no signature names one; pass leafHash`);
  }
  const leaf = leaves.find((item) => toHex(tapLeafHash(item.script, item.leafVersion)) === target);
  if (leaf === undefined) {
    throw new SigningError(
      'INPUT_MISMATCH',
      supplied?.leafHash === undefined ? 'no tap leaf script matches the script-path signatures' : `PSBT input ${inputIndex} has no tap leaf with that hash`,
    );
  }
  const { tx, prevouts } = psbtSpend(psbt, 'check script-path signatures against');
  const prevScript = prevouts[inputIndex]!.script;
  const kind = classifyOutputScript(prevScript);
  if (kind === 'p2mr') verifyP2mrLeafCommitment(leaf.controlBlock, prevScript.slice(2), leaf.script);
  else if (kind === 'p2tr') verifyTaprootLeafCommitment(leaf.controlBlock, prevScript.slice(2), leaf.script);
  else throw new SigningError('INPUT_MISMATCH', `PSBT input ${inputIndex} does not spend a P2TR or P2MR output`);

  const chunks = decompileScript(leaf.script);
  const leafKeys = chunks.filter((chunk): chunk is Uint8Array => chunk instanceof Uint8Array && chunk.length === 32).map(toHex);
  const forLeaf = signatures.filter((sig) => {
    const key = toHex(sig.pubkey);
    if (!leafKeys.includes(key)) return false;
    const { signature } = sig;
    const sighashType = signature.length === 65 ? signature[64]! : Transaction.SIGHASH_DEFAULT;
    const wellFormed =
      (signature.length === 64 || (signature.length === 65 && sighashType !== Transaction.SIGHASH_DEFAULT)) &&
      ecc.isXOnlyPoint(sig.pubkey);
    const verifies =
      wellFormed &&
      ecc.verifySchnorr(tapscriptSighash(tx, inputIndex, { prevouts, leafHash: sig.leafHash, sighashType }), sig.pubkey, signature.subarray(0, 64));
    if (verifies) return true;
    throw new SigningError('SIGNATURE_INVALID', `PSBT input ${inputIndex} has an invalid script-path signature for key ${key}`);
  });

  const multiA = parseMultiA(leaf.script);
  const checksig = chunks.length === 2 && leafKeys.length === 1 && chunks[1] === OP_CODES.OP_CHECKSIG;
  let stack: readonly Uint8Array[];
  if (supplied !== undefined) {
    const signatureFor = (publicKey: Uint8Array): Uint8Array => {
      const key = toHex(publicKey.length === 33 ? publicKey.subarray(1) : publicKey);
      const found = forLeaf.find((sig) => toHex(sig.pubkey) === key);
      if (found === undefined) {
        throw new SigningError('SIGNATURES_MISSING', `PSBT input ${inputIndex} has no signature for key ${key} on this leaf`);
      }
      return found.signature;
    };
    stack = typeof supplied.stack === 'function' ? supplied.stack(signatureFor) : supplied.stack;
  } else if (multiA !== null) {
    // multiAStack refuses a signature for a key outside the leaf, as Pearl does.
    stack = multiAStack(multiA, new Map(signatures.map((sig) => [toHex(sig.pubkey), sig.signature])));
  } else {
    if (forLeaf.length === 0 && chunks.some((chunk) => typeof chunk === 'number' && CHECKSIG_OPCODES.includes(chunk))) {
      throw new SigningError('SIGNATURES_MISSING', `PSBT input ${inputIndex} has no signature for a key its leaf pushes`);
    }
    // The first key the leaf checks is the last one it pushes a signature for.
    stack = forLeaf
      .map((sig) => ({ signature: sig.signature, position: leafKeys.indexOf(toHex(sig.pubkey)) }))
      .sort((a, b) => b.position - a.position)
      .map((sig) => sig.signature);
  }

  const witness = [...stack, leaf.script, leaf.controlBlock].map((item) => Uint8Array.from(item));
  tx.setWitness(inputIndex, witness);
  const result = verifyInput(tx, inputIndex, prevouts);
  if (!result.ok) {
    const rejected = new ScriptRejectedError(result.code, result.message, {
      inputIndex,
      ...(result.at === undefined ? {} : { at: result.at }),
    });
    if (supplied !== undefined || multiA !== null || checksig) throw rejected;
    throw new SigningError(
      'WITNESS_ITEMS_NEEDED',
      `PSBT input ${inputIndex}: the leaf is not satisfied by its signatures alone (${result.code}). ` +
        `Pass the items it takes besides them with finalizeScriptPathInput(psbt, ${inputIndex}, { stack })`,
      { cause: rejected },
    );
  }
  psbt.finalizeTaprootInput(inputIndex, undefined, () => ({ finalScriptWitness: serializeWitness(witness) }));
}

/** Runs the script engine over a key-path input finalized here, when every spent output is known. */
function checkFinalWitness(psbt: Psbt, inputIndex: number): void {
  if (psbt.data.inputs.some((input) => input.witnessUtxo === undefined && input.nonWitnessUtxo === undefined)) return;
  const { tx, prevouts } = psbtSpend(psbt, 'verify against');
  // A key-path witness is one signature of 64 or 65 bytes: a count, a length, the bytes.
  tx.setWitness(inputIndex, [psbt.data.inputs[inputIndex]!.finalScriptWitness!.subarray(2)]);
  const result = verifyInput(tx, inputIndex, prevouts);
  if (!result.ok) {
    throw new ScriptRejectedError(result.code, result.message, { inputIndex, ...(result.at === undefined ? {} : { at: result.at }) });
  }
}

/** A witness stack as it is serialized: item count, then each item with its length. */
export function serializeWitness(witness: readonly Uint8Array[]): Uint8Array {
  return Uint8Array.from([
    ...varInt(witness.length),
    ...witness.flatMap((item) => [...varInt(item.length), ...item]),
  ]);
}

/** One output of a PSBT as psbtOutputs reports it. */
export interface PsbtOutput extends TxOutput {
  /** The Pearl address the script pays, or null for an OP_RETURN or any other script. */
  address: string | null;
  /**
   * With an account: whether the output pays one of its children. True only
   * when a derivation record on the output names a child and the key derived
   * for that child makes this output's script.
   */
  mine?: boolean;
  /** The child that holds the output, when `mine` is true. */
  child?: AccountChild;
}

/**
 * The outputs of a PSBT with their Pearl addresses. `psbt.txOutputs` reports
 * addresses for Bitcoin mainnet (`bc1p...`), since the Psbt class knows no
 * other network; read them here.
 *
 * Pass an account to learn which outputs are its own. The derivation records
 * on an output only say where to look: the key is derived again from the
 * account and the script compared, so a record copied onto another output,
 * or edited, proves nothing. An output of the account without a record (see
 * prepareOutput) is reported as not `mine`.
 */
export function psbtOutputs(psbt: Psbt, network: PearlNetwork, account?: PearlAccount): PsbtOutput[] {
  return psbt.txOutputs.map((output, index) => {
    const script = Uint8Array.from(output.script);
    const kind = classifyOutputScript(script);
    const address = kind === 'p2tr' || kind === 'p2mr' ? fromOutputScript(script, network) : null;
    if (account === undefined) return { script, value: output.value, address };
    const fields = psbt.data.outputs[index]!;
    const child = account.findChild([...(fields.tapBip32Derivation ?? []), ...(fields.bip32Derivation ?? [])]);
    const mine = child !== null && equalBytes(script, p2tr({ internalPubkey: account.derivePublicKey(child.index, child.change) }).output);
    return { script, value: output.value, address, mine, ...(mine ? { child } : {}) };
  });
}

/** What a PSBT is meant to do, for checkPsbtPayment. */
export interface PsbtPaymentExpectations {
  network: PearlNetwork;
  /** Every payment the PSBT is meant to make, each matched to one output of exactly that amount. */
  recipients: readonly { address: string; amount: bigint }[];
  /** The highest fee to accept, in grain. No limit unless given. */
  maxFee?: bigint;
}

/** What checkPsbtPayment found. Amounts are in grain. */
export interface PsbtPaymentSummary {
  /** Total paid to the expected recipients. */
  sent: bigint;
  /** Total returning to the account in outputs proven to be its own. */
  change: bigint;
  /** Inputs minus outputs. */
  fee: bigint;
  /** Every output, as psbtOutputs reports it for the account. */
  outputs: PsbtOutput[];
}

/**
 * The check an offline signer makes before it signs: the PSBT pays the
 * expected recipients, and every other output is proven to return to the
 * account (see psbtOutputs), so nothing leaves but the payments and the fee.
 * Returns the totals to show the person approving.
 *
 * The input values are read from the PSBT. A key-path signature commits to
 * all of them, so a PSBT that understates or overstates one yields a
 * transaction no node accepts, not a larger fee.
 *
 * Throws a SigningError: PSBT_RECIPIENT_MISSING when no output pays a
 * recipient its amount, PSBT_OUTPUT_UNEXPECTED for an output that is neither
 * a recipient nor the account's own, INPUT_UNPREPARED and PREVOUT_MISMATCH
 * for the inputs, OUTPUTS_EXCEED_INPUTS, and FEE_TOO_HIGH above maxFee.
 */
export function checkPsbtPayment(psbt: Psbt, account: PearlAccount, expectations: PsbtPaymentExpectations): PsbtPaymentSummary {
  const { network, maxFee } = expectations;
  if (maxFee !== undefined && (typeof maxFee !== 'bigint' || maxFee < 0n)) {
    throw new TypeError('maxFee must be a non-negative bigint of grain');
  }
  const outputs = psbtOutputs(psbt, network, account);
  const unmatched = new Set(outputs.keys());
  let sent = 0n;
  for (const recipient of expectations.recipients) {
    const script = toOutputScript(recipient.address, network);
    const found = [...unmatched].find((i) => outputs[i]!.value === recipient.amount && equalBytes(outputs[i]!.script, script));
    if (found === undefined) {
      throw new SigningError('PSBT_RECIPIENT_MISSING', `no output of the PSBT pays ${recipient.amount} grain to ${recipient.address}`);
    }
    unmatched.delete(found);
    sent += recipient.amount;
  }
  let change = 0n;
  for (const i of unmatched) {
    const output = outputs[i]!;
    if (output.mine !== true) {
      throw new SigningError(
        'PSBT_OUTPUT_UNEXPECTED',
        `PSBT output ${i} pays ${output.value} grain to ${output.address ?? 'a script without an address'}, ` +
          'which is not an expected recipient and is not proven to belong to the account',
      );
    }
    change += output.value;
  }

  let inputTotal = 0n;
  psbt.txInputs.forEach((txInput, index) => {
    const input = psbt.data.inputs[index]!;
    const previous = input.nonWitnessUtxo === undefined ? undefined : Transaction.fromBuffer(input.nonWitnessUtxo);
    const spent = previous?.outs[txInput.index];
    const utxo = input.witnessUtxo ?? spent;
    if (utxo === undefined) throw new SigningError('INPUT_UNPREPARED', `PSBT input ${index} has no UTXO to read its value from`);
    if (
      previous !== undefined &&
      (!equalBytes(previous.getHash(), txInput.hash) || spent === undefined || spent.value !== utxo.value || !equalBytes(spent.script, utxo.script))
    ) {
      throw new SigningError('PREVOUT_MISMATCH', `PSBT input ${index} does not match the previous transaction it carries`);
    }
    inputTotal += utxo.value;
  });
  const outputTotal = outputs.reduce((sum, output) => sum + output.value, 0n);
  if (outputTotal > inputTotal) {
    throw new SigningError('OUTPUTS_EXCEED_INPUTS', `PSBT outputs (${outputTotal} grain) exceed its inputs (${inputTotal} grain)`);
  }
  const fee = inputTotal - outputTotal;
  if (maxFee !== undefined && fee > maxFee) {
    throw new SigningError('FEE_TOO_HIGH', `the PSBT pays a fee of ${fee} grain, above the ${maxFee} grain allowed`);
  }
  return { sent, change, fee, outputs };
}

/**
 * Adds an output paying a Pearl address to a transaction or a PSBT. value is
 * in grain. Throws when the address is not valid on the network or the value
 * is outside Pearl's bounds; Transaction.addOutput and Psbt.addOutput check
 * neither, so prefer this to calling them.
 */
export function addPearlOutput(
  target: Transaction | Psbt,
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
  const script = toOutputScript(address, network);
  if (target instanceof Transaction) target.addOutput(script, value);
  else target.addOutput({ script, value });
}
