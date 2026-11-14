// Script-path spends for P2TR and P2MR outputs.
//
// Both output types use the BIP342 tapscript sighash, which commits to the
// leaf hash, so signing is shared; pearlTapscriptSighash computes it the way
// Pearl's node does. The two output types differ in how the spend travels:
//
// - P2TR script paths go through a BIP371 PSBT. Pearl's Go PSBT code reads
//   and finalizes these the same way.
// - P2MR spends either set the witness on the transaction directly, as
//   Pearl's wallet does in txauthor.spendMerkleRoot, or go through a PSBT
//   with the fields Pearl's psbt package already has: the witness UTXO, a tap
//   leaf script keyed by the P2MR control block, and tap script signatures,
//   with no internal key or Merkle root. Pearl has no P2MR PSBT code of its
//   own. Its parser checks every tap-leaf control block as a Taproot one,
//   which needs a 33-byte header, so it rejects a single-leaf P2MR control
//   block and loads a longer one only when the first proof hash happens to be
//   a valid x-only key; its finalizer accepts P2TR inputs only.

/**
 * Script-path signing for P2TR and P2MR outputs, on the transaction and
 * through PSBT, and the tapscript signature message as Pearl computes it.
 *
 * @module
 */

import { sha256 } from '@noble/hashes/sha2';
import { Transaction } from 'bitcoinjs-lib';
import type { Psbt } from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { MAX_GRAIN } from './amount.js';
import { p2mr, p2tr } from './payments.js';
import { classifyOutputScript, taggedHash, TAPROOT_ANNEX_TAG, tapLeafHash, xmssLeafScript } from './script.js';
import {
  p2mrControlBlock,
  taprootControlBlock,
  verifyP2mrLeafCommitment,
  verifyTaprootLeafCommitment,
} from './scripttree.js';
import type { ScriptTree, ScriptTreeLeaf } from './scripttree.js';
import { XMSS_SIGNATURE_LENGTH } from './xmss.js';
import type { XmssSigner } from './xmss.js';
import { concat, equalBytes, toHex, uint32le, varInt } from './internal/bytes.js';
import { PearlError, SigningError } from './errors.js';
import type { FeeRate } from './amount.js';
import type { TxOutput } from './transaction.js';
import { assertTaprootSighashType, psbtSighashType } from './internal/sighash.js';

/**
 * Anything that can make a BIP340 Schnorr signature for a tapscript key,
 * such as a bip32 node. publicKey may be 33-byte compressed or 32-byte
 * x-only. Script paths sign with the untweaked key named in the leaf.
 */
export interface TapscriptSigner {
  publicKey: Uint8Array;
  /** Returns a 64-byte BIP340 signature over a 32-byte hash, made with the untweaked key. */
  signSchnorr(hash: Uint8Array): Uint8Array;
}

/** A signer that answers asynchronously, such as a hardware wallet. */
export interface TapscriptSignerAsync {
  publicKey: Uint8Array;
  /** Resolves to a 64-byte BIP340 signature over a 32-byte hash, made with the untweaked key. */
  signSchnorr(hash: Uint8Array): Promise<Uint8Array>;
}

/**
 * A TapscriptSigner for a raw private key, for the script-path signers.
 * Signatures are made with the key as it is, untweaked, and with fresh
 * auxiliary randomness unless auxRand fixes it. The signer reads the caller's
 * array each time it signs and keeps no copy, so overwriting the key ends it.
 *
 * Throws KEY_INVALID for bytes that are not a secp256k1 private key.
 */
export function signerFromPrivateKey(privateKey: Uint8Array, options: { auxRand?: Uint8Array } = {}): TapscriptSigner {
  const publicKey = ecc.isPrivate(privateKey) ? ecc.xOnlyPointFromScalar(privateKey) : null;
  if (publicKey === null) throw new PearlError('KEY_INVALID', 'invalid private key');
  const { auxRand } = options;
  if (auxRand !== undefined && (!(auxRand instanceof Uint8Array) || auxRand.length !== 32)) {
    throw new Error('auxRand must be 32 bytes');
  }
  return {
    publicKey: Uint8Array.from(publicKey),
    signSchnorr: (hash: Uint8Array) => ecc.signSchnorr(hash, privateKey, auxRand ?? crypto.getRandomValues(new Uint8Array(32))),
  };
}

/** Which sighash types a PSBT signer accepts from the PSBT it is handed. */
export interface PsbtSighashOptions {
  /**
   * Sighash types the caller agrees to sign with. The type is read from the
   * PSBT input, which anyone who handled the PSBT can set, so an input asking
   * for a type that is not listed is refused. Defaults to SIGHASH_DEFAULT
   * only.
   */
  allowedSighashTypes?: readonly number[];
}

function assertValue(value: bigint, what: string): void {
  if (typeof value !== 'bigint') {
    throw new TypeError(`${what} must be a bigint of grains`);
  }
  if (value < 0n || value > MAX_GRAIN) {
    throw new PearlError('AMOUNT_OUT_OF_RANGE', `${what} is outside Pearl amount bounds`);
  }
}

function xOnly(publicKey: Uint8Array): Uint8Array {
  if (publicKey.length === 32) return publicKey;
  if (publicKey.length === 33) return publicKey.slice(1);
  throw new Error(`signer public key must be 32 or 33 bytes, got ${publicKey.length}`);
}

/** True when the script pushes this x-only key as a 32-byte direct push. */
function scriptPushesKey(script: Uint8Array, key: Uint8Array): boolean {
  outer: for (let i = 0; i + 33 <= script.length; i += 1) {
    if (script[i] !== 32) continue;
    for (let j = 0; j < 32; j += 1) {
      if (script[i + 1 + j] !== key[j]) continue outer;
    }
    return true;
  }
  return false;
}

const ZERO_HASH = new Uint8Array(32);
const SIGHASH_ANYONECANPAY = 0x80;
const SIGHASH_OUTPUT_MASK = 0x03;
const TAPSCRIPT_SPEND_TYPE = 0x02; // ext_flag 1, no annex
const TAPSCRIPT_KEY_VERSION = 0x00;
const NO_CODESEPARATOR = 0xffffffff;

function uint64le(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
}

function varBytes(bytes: Uint8Array): Uint8Array {
  return concat([varInt(bytes.length), bytes]);
}

function serializeOutput(value: bigint, script: Uint8Array): Uint8Array {
  return concat([uint64le(value), varBytes(script)]);
}

/**
 * The two parts of the signature message a leaf or a witness can change.
 * Both are covered by every signature of the input, so the witness has to
 * end with the same annex and the script has to reach the signature check
 * with the same separator behind it.
 */
export interface TapscriptContextOptions {
  /**
   * The annex the witness will end with: bytes starting with 0x50
   * (TAPROOT_ANNEX_TAG). Pearl gives an annex no meaning and commits every
   * signature to it. None unless given.
   */
  annex?: Uint8Array;
  /**
   * Opcode position of the last OP_CODESEPARATOR executed before the
   * signature check, from codeSeparatorPositions. Left out when no separator
   * has run by then.
   */
  codeSeparatorPosition?: number;
}

function checkAnnex(annex: Uint8Array | undefined): void {
  if (annex !== undefined && (!(annex instanceof Uint8Array) || annex[0] !== TAPROOT_ANNEX_TAG)) {
    throw new PearlError('SCRIPT_INVALID', 'an annex must be bytes that start with 0x50');
  }
}

/**
 * Whether NewTxSigHashes computes the amount and script hashes for this
 * spend. With tx, an input whose outpoint is null does not count as P2TR;
 * no transaction on chain but a coinbase has one.
 */
function coversInputValues(
  prevouts: readonly TxOutput[],
  sighashType: number,
  tx?: Transaction,
): boolean {
  if ((sighashType & SIGHASH_ANYONECANPAY) !== 0) return true;
  return prevouts.some((prevout, index) => {
    const input = tx?.ins[index];
    const nullOutpoint = input !== undefined && input.index === 0xffffffff && input.hash.every((byte) => byte === 0);
    return !nullOutpoint && classifyOutputScript(prevout.script) === 'p2tr';
  });
}

/**
 * Pearl's Taproot signature message with the tapscript extension, mirroring
 * calcTaprootSignatureHashRaw and the midstate from NewTxSigHashes. It
 * follows Pearl's consensus code, not bitcoinjs, so P2MR signatures validate
 * on Pearl nodes; the Go vectors pin every case.
 */
function pearlTapscriptSighash(
  tx: Transaction,
  inputIndex: number,
  prevouts: readonly TxOutput[],
  leafHash: Uint8Array,
  sighashType: number,
  options: TapscriptContextOptions,
): Uint8Array {
  const anyoneCanPay = (sighashType & SIGHASH_ANYONECANPAY) !== 0;
  const outputMode = sighashType & SIGHASH_OUTPUT_MASK;
  const parts: Uint8Array[] = [
    Uint8Array.of(0x00, sighashType),
    uint32le(tx.version),
    uint32le(tx.locktime),
  ];
  if (!anyoneCanPay) {
    const coversValues = coversInputValues(prevouts, sighashType, tx);
    parts.push(sha256(concat(tx.ins.map((input) => concat([input.hash, uint32le(input.index)])))));
    parts.push(
      coversValues ? sha256(concat(prevouts.map((prevout) => uint64le(prevout.value)))) : ZERO_HASH,
    );
    parts.push(
      coversValues ? sha256(concat(prevouts.map((prevout) => varBytes(prevout.script)))) : ZERO_HASH,
    );
    parts.push(sha256(concat(tx.ins.map((input) => uint32le(input.sequence)))));
  }
  if (outputMode !== Transaction.SIGHASH_SINGLE && outputMode !== Transaction.SIGHASH_NONE) {
    parts.push(sha256(concat(tx.outs.map((output) => serializeOutput(output.value, output.script)))));
  }
  // spend_type is ext_flag * 2 + annex_present.
  parts.push(Uint8Array.of(TAPSCRIPT_SPEND_TYPE | (options.annex === undefined ? 0 : 1)));
  if (anyoneCanPay) {
    const input = tx.ins[inputIndex]!;
    const prevout = prevouts[inputIndex]!;
    parts.push(
      input.hash,
      uint32le(input.index),
      serializeOutput(prevout.value, prevout.script),
      uint32le(input.sequence),
    );
  } else {
    parts.push(uint32le(inputIndex));
  }
  // Not a tagged hash: sha256 of the annex with its length in front.
  if (options.annex !== undefined) parts.push(sha256(varBytes(options.annex)));
  if (outputMode === Transaction.SIGHASH_SINGLE) {
    const output = tx.outs[inputIndex]!;
    parts.push(sha256(serializeOutput(output.value, output.script)));
  }
  parts.push(leafHash, Uint8Array.of(TAPSCRIPT_KEY_VERSION), uint32le(options.codeSeparatorPosition ?? NO_CODESEPARATOR));
  return taggedHash('TapSighash', concat(parts));
}

/** What tapscriptSighash needs besides the transaction and the input. */
export interface TapscriptSighashInput extends TapscriptContextOptions {
  /** Script and value (in grain) of every input's spent output, in input order. */
  prevouts: readonly TxOutput[];
  /** Hash of the leaf being spent, from tapLeafHash or a ScriptTreeLeaf. */
  leafHash: Uint8Array;
  /** A Taproot sighash type. SIGHASH_DEFAULT unless given. */
  sighashType?: number;
}

/**
 * Tapscript sighash for one input, as Pearl computes it.
 *
 * Returns the 32-byte hash to sign. Throws when prevouts does not have one entry
 * per input, for an input index out of range, and for a sighash type that is not
 * a Taproot one.
 */
export function tapscriptSighash(tx: Transaction, inputIndex: number, options: TapscriptSighashInput): Uint8Array {
  const { prevouts, leafHash } = options;
  const sighashType = options.sighashType ?? Transaction.SIGHASH_DEFAULT;
  if (!Number.isInteger(inputIndex) || inputIndex < 0 || inputIndex >= tx.ins.length) {
    throw new RangeError(`input index ${inputIndex} is out of range`);
  }
  if (prevouts.length !== tx.ins.length) {
    throw new Error(`expected ${tx.ins.length} prevouts, got ${prevouts.length}`);
  }
  prevouts.forEach((prevout, index) => assertValue(prevout.value, `prevout ${index} value`));
  if (leafHash.length !== 32) {
    throw new Error(`leaf hash must be 32 bytes, got ${leafHash.length}`);
  }
  assertTaprootSighashType(sighashType);
  checkAnnex(options.annex);
  const position = options.codeSeparatorPosition;
  if (position !== undefined && (!Number.isInteger(position) || position < 0 || position >= NO_CODESEPARATOR)) {
    throw new RangeError('codeSeparatorPosition must be an opcode position from codeSeparatorPositions');
  }
  if ((sighashType & 0x03) === Transaction.SIGHASH_SINGLE && inputIndex >= tx.outs.length) {
    throw new SigningError('SIGHASH_UNSUPPORTED', 'SIGHASH_SINGLE needs an output at the same index as the input');
  }
  return pearlTapscriptSighash(tx, inputIndex, prevouts, leafHash, sighashType, options);
}

/** What signTapscriptUnchecked needs besides the transaction and the signer. */
export interface TapscriptSignOptions extends TapscriptContextOptions {
  /** Script and value (in grain) of every input's spent output, in input order. */
  prevouts: readonly TxOutput[];
  /** The leaf script being spent. */
  script: Uint8Array;
  /** A Taproot sighash type. SIGHASH_DEFAULT unless given. */
  sighashType?: number;
}

/**
 * Signs one input for a tapscript leaf and returns the witness signature:
 * 64 bytes for SIGHASH_DEFAULT, otherwise 65 with the sighash byte appended.
 *
 * Unchecked means it signs whatever it is handed: it does not compare the
 * prevouts with the previous transactions, has no fee limit, does not look
 * at whether the leaf pushes the signer's key or opens the spent output, and
 * cannot tell whether the script will succeed. signP2mrInput and the PSBT
 * signers make those checks; use this for leaves they do not cover, with
 * prevouts you have verified yourself. The signature is checked against the
 * signer's key before it is returned.
 */
export function signTapscriptUnchecked(
  tx: Transaction,
  inputIndex: number,
  signer: TapscriptSigner,
  options: TapscriptSignOptions,
): Uint8Array {
  const { hash, sighashType } = tapscriptSignHash(tx, inputIndex, options);
  return finishTapscriptSignature(hash, signer.publicKey, signer.signSchnorr(hash), sighashType, inputIndex);
}

/** signTapscriptUnchecked for a signer that answers asynchronously. */
export async function signTapscriptUncheckedAsync(
  tx: Transaction,
  inputIndex: number,
  signer: TapscriptSignerAsync,
  options: TapscriptSignOptions,
): Promise<Uint8Array> {
  const { hash, sighashType } = tapscriptSignHash(tx, inputIndex, options);
  return finishTapscriptSignature(hash, signer.publicKey, await signer.signSchnorr(hash), sighashType, inputIndex);
}

function tapscriptSignHash(
  tx: Transaction,
  inputIndex: number,
  options: TapscriptSignOptions,
): { hash: Uint8Array; sighashType: number } {
  const sighashType = options.sighashType ?? Transaction.SIGHASH_DEFAULT;
  const { script, ...rest } = options;
  return { hash: tapscriptSighash(tx, inputIndex, { ...rest, leafHash: tapLeafHash(script), sighashType }), sighashType };
}

function finishTapscriptSignature(
  hash: Uint8Array,
  publicKey: Uint8Array,
  signature: Uint8Array,
  sighashType: number,
  inputIndex: number,
): Uint8Array {
  if (!ecc.verifySchnorr(hash, xOnly(publicKey), signature)) {
    throw new SigningError('SIGNATURE_INVALID', `invalid tapscript signature for input ${inputIndex}`);
  }
  return sighashType === Transaction.SIGHASH_DEFAULT
    ? Uint8Array.from(signature)
    : Uint8Array.from([...signature, sighashType]);
}

/**
 * Script-path witness: the leaf's arguments, then the script and control
 * block, then the annex when there is one. Every item is a copy, so a
 * witness set on a transaction shares no memory with the script tree or the
 * caller's buffers. Signatures in the stack must have been made for the
 * same annex.
 */
export function scriptPathWitness(
  stack: readonly Uint8Array[],
  script: Uint8Array,
  controlBlock: Uint8Array,
  annex?: Uint8Array,
): Uint8Array[] {
  checkAnnex(annex);
  return [...stack, script, controlBlock, ...(annex === undefined ? [] : [annex])].map((item) => Uint8Array.from(item));
}

/**
 * Default for maxFeeRate, in grain per 1000 vbytes: the 5000 per vbyte at
 * which finalizePsbt refuses a PSBT, half of the 0.1 PRL per 1000 vbytes above which
 * pearld's testmempoolaccept reports a transaction as not allowed. Oyster's
 * txrules set no upper bound, and pearld's sendrawtransaction ignores its
 * fee limit, so nothing downstream stops an overpaying transaction.
 */
export const DEFAULT_MAX_FEE_RATE = 5_000_000n;

/** The fee limit of the raw-transaction P2MR and XMSS signers. */
export interface FeeGuardOptions {
  /**
   * Highest fee rate to sign for, in grain per 1000 vbytes. A transaction
   * that pays more is refused before anything is signed, which catches a
   * forgotten change output. Defaults to DEFAULT_MAX_FEE_RATE; pass a higher
   * rate to sign a transaction that is meant to pay more.
   */
  maxFeeRate?: FeeRate;
}

/**
 * Refuses a transaction whose outputs exceed its inputs or whose fee is above
 * maxFeeRate. witness is the one the input will get, so the size is that of
 * the transaction once this input is signed; inputs still unsigned make the
 * size smaller than the final one, which only makes the check stricter.
 */
function checkFee(
  tx: Transaction,
  inputIndex: number,
  prevouts: readonly TxOutput[],
  witness: Uint8Array[],
  sighashType: number,
  options: FeeGuardOptions,
): void {
  const maxFeeRate = options.maxFeeRate ?? DEFAULT_MAX_FEE_RATE;
  if (typeof maxFeeRate !== 'bigint' || maxFeeRate < 0n) {
    throw new TypeError('maxFeeRate must be a non-negative bigint of grain per 1000 vbytes');
  }
  if (prevouts.length !== tx.ins.length) {
    throw new Error(`expected ${tx.ins.length} prevouts, got ${prevouts.length}`);
  }
  let inputValue = 0n;
  prevouts.forEach((prevout, index) => {
    assertValue(prevout.value, `prevout ${index} value`);
    inputValue += prevout.value;
  });
  let outputValue = 0n;
  tx.outs.forEach((output, index) => {
    assertValue(output.value, `output ${index} value`);
    outputValue += output.value;
  });
  if (outputValue > inputValue) {
    // With ANYONECANPAY the inputs that cover the outputs may come later.
    if ((sighashType & SIGHASH_ANYONECANPAY) !== 0) return;
    throw new SigningError('OUTPUTS_EXCEED_INPUTS', `transaction outputs (${outputValue} grain) exceed its inputs (${inputValue} grain)`);
  }
  const sized = tx.clone();
  sized.setWitness(inputIndex, witness);
  const vsize = BigInt(sized.virtualSize());
  const fee = inputValue - outputValue;
  const limit = (vsize * maxFeeRate + 999n) / 1000n;
  if (fee > limit) {
    throw new SigningError('FEE_TOO_HIGH',
      `transaction pays a fee of ${fee} grain, above the ${limit} grain that maxFeeRate ` +
        `(${maxFeeRate} grain per 1000 vbytes) allows for ${vsize} vbytes; ` +
        'check for a missing change output, or raise maxFeeRate to sign it',
    );
  }
}

/** What signP2mrInput needs besides the transaction and the signer. */
export interface P2mrSignOptions extends FeeGuardOptions {
  /** Script and value (in grain) of every input's spent output, in input order. */
  prevouts: readonly TxOutput[];
  /** The script tree the spent output commits to. */
  tree: ScriptTree;
  /** Index in tree.leaves of the leaf to spend through. */
  leafIndex: number;
  /** A Taproot sighash type. SIGHASH_DEFAULT unless given. */
  sighashType?: number;
  /** An annex to sign for and end the witness with; see TapscriptContextOptions. None unless given. */
  annex?: Uint8Array;
  /**
   * Transactions that created the spent outputs. When every input is P2MR,
   * every prevout is checked against them before signing.
   */
  previousTransactions?: readonly Transaction[];
  /** Sign without that check, for callers that already trust the prevouts. */
  trustPrevouts?: boolean;
}

/**
 * Checks each prevout against the output it spends in previousTransactions,
 * so a wrong value or script fails here instead of after signing.
 */
function checkPrevouts(
  tx: Transaction,
  prevouts: readonly TxOutput[],
  previousTransactions: readonly Transaction[],
): void {
  const byHash = new Map(previousTransactions.map((prev) => [toHex(prev.getHash()), prev]));
  tx.ins.forEach((input, index) => {
    const previous = byHash.get(toHex(input.hash));
    if (previous === undefined) {
      throw new SigningError('PREVIOUS_TRANSACTIONS_MISSING', `input ${index} is missing the previous transaction it spends`);
    }
    const output = previous.outs[input.index];
    const prevout = prevouts[index];
    if (
      output === undefined ||
      prevout === undefined ||
      output.value !== prevout.value ||
      !equalBytes(output.script, prevout.script)
    ) {
      throw new SigningError('PREVOUT_MISMATCH', `prevout ${index} does not match its previous transaction`);
    }
  });
}

/**
 * Spends a P2MR input through a single-key leaf (<key> OP_CHECKSIG, see
 * checksigScript) and sets its witness to {signature, script, control
 * block}, the witness Pearl's wallet builds. The prevout must commit to the
 * tree's root and the leaf must push the signer's key.
 *
 * When every input is P2MR, the prevouts are checked against
 * previousTransactions first, and signing is refused without them unless
 * trustPrevouts is set.
 *
 * A transaction whose outputs exceed its inputs, or whose fee is above
 * maxFeeRate, is refused; see FeeGuardOptions.
 *
 * For other leaf scripts, sign with signTapscriptUnchecked and set the witness from
 * scriptPathWitness and p2mrControlBlock.
 */
export function signP2mrInput(
  tx: Transaction,
  inputIndex: number,
  signer: TapscriptSigner,
  options: P2mrSignOptions,
): void {
  const { leaf, controlBlock, sighashType } = checkP2mrSchnorrSpend(tx, inputIndex, signer.publicKey, options);
  const signature = signTapscriptUnchecked(tx, inputIndex, signer, {
    prevouts: options.prevouts,
    script: leaf.script,
    sighashType,
    ...(options.annex === undefined ? {} : { annex: options.annex }),
  });
  tx.setWitness(inputIndex, scriptPathWitness([signature], leaf.script, controlBlock, options.annex));
}

/** signP2mrInput for a signer that answers asynchronously. */
export async function signP2mrInputAsync(
  tx: Transaction,
  inputIndex: number,
  signer: TapscriptSignerAsync,
  options: P2mrSignOptions,
): Promise<void> {
  const { leaf, controlBlock, sighashType } = checkP2mrSchnorrSpend(tx, inputIndex, signer.publicKey, options);
  const signature = await signTapscriptUncheckedAsync(tx, inputIndex, signer, {
    prevouts: options.prevouts,
    script: leaf.script,
    sighashType,
    ...(options.annex === undefined ? {} : { annex: options.annex }),
  });
  tx.setWitness(inputIndex, scriptPathWitness([signature], leaf.script, controlBlock, options.annex));
}

function checkP2mrSchnorrSpend(
  tx: Transaction,
  inputIndex: number,
  publicKey: Uint8Array,
  options: P2mrSignOptions,
): { leaf: ScriptTreeLeaf; controlBlock: Uint8Array; sighashType: number } {
  const sighashType = options.sighashType ?? Transaction.SIGHASH_DEFAULT;
  const { leaf, controlBlock } = prepareP2mrSpend(tx, inputIndex, options);
  if (!scriptPushesKey(leaf.script, xOnly(publicKey))) {
    throw new SigningError('INPUT_MISMATCH', 'the leaf script does not contain the signer key');
  }
  checkInputValues(tx, options, sighashType);
  const signature = new Uint8Array(sighashType === Transaction.SIGHASH_DEFAULT ? 64 : 65);
  checkFee(tx, inputIndex, options.prevouts, scriptPathWitness([signature], leaf.script, controlBlock, options.annex), sighashType, options);
  return { leaf, controlBlock, sighashType };
}

/**
 * Structural checks shared by the P2MR signers: the input spends a P2MR
 * output that commits to the tree and has an empty scriptSig.
 */
function prepareP2mrSpend(
  tx: Transaction,
  inputIndex: number,
  options: P2mrSignOptions,
): { leaf: ScriptTreeLeaf; controlBlock: Uint8Array } {
  const prevout = options.prevouts[inputIndex];
  if (prevout === undefined) {
    throw new RangeError(`no prevout for input ${inputIndex}`);
  }
  if (classifyOutputScript(prevout.script) !== 'p2mr') {
    throw new SigningError('INPUT_MISMATCH', `input ${inputIndex} does not spend a P2MR output`);
  }
  const leaf = options.tree.leaves[options.leafIndex];
  if (leaf === undefined) {
    throw new RangeError(`script tree has no leaf ${options.leafIndex}`);
  }
  const controlBlock = p2mrControlBlock(options.tree, options.leafIndex);
  verifyP2mrLeafCommitment(controlBlock, prevout.script.slice(2), leaf.script);
  const input = tx.ins[inputIndex];
  if (input === undefined) {
    throw new RangeError(`input index ${inputIndex} is out of range`);
  }
  if (input.script.length !== 0) {
    throw new SigningError('INPUT_MISMATCH', 'P2MR inputs must have an empty scriptSig');
  }
  return { leaf, controlBlock };
}

type InputValueOptions = Pick<
  P2mrSignOptions,
  'prevouts' | 'previousTransactions' | 'trustPrevouts'
>;

/**
 * Checks the input values of an all-P2MR spend against the previous
 * transactions, or refuses unless trustPrevouts is set.
 */
function checkInputValues(tx: Transaction, options: InputValueOptions, sighashType: number): void {
  if (!coversInputValues(options.prevouts, sighashType) && options.trustPrevouts !== true) {
    if (options.previousTransactions === undefined) {
      throw new SigningError('PREVIOUS_TRANSACTIONS_MISSING',
        'this spend needs the previous transactions (previousTransactions) to check ' +
          'input values before signing; set trustPrevouts to skip the check',
      );
    }
    checkPrevouts(tx, options.prevouts, options.previousTransactions);
  }
}

// txscript.XMSSSigChunks: OP_CHECKXMSSSIG pops the signature as five
// 468-byte elements so each fits the 520-byte stack element limit.
const XMSS_SIGNATURE_CHUNKS = 5;

/** Witness for an XMSS leaf: the signature in five chunks, then script and control block, then the annex if any. */
export function xmssScriptPathWitness(
  signature: Uint8Array,
  script: Uint8Array,
  controlBlock: Uint8Array,
  annex?: Uint8Array,
): Uint8Array[] {
  if (signature.length !== XMSS_SIGNATURE_LENGTH) {
    throw new Error(`XMSS signature must be ${XMSS_SIGNATURE_LENGTH} bytes, got ${signature.length}`);
  }
  const size = XMSS_SIGNATURE_LENGTH / XMSS_SIGNATURE_CHUNKS;
  const chunks = Array.from({ length: XMSS_SIGNATURE_CHUNKS }, (_, i) =>
    signature.slice(i * size, (i + 1) * size),
  );
  return scriptPathWitness(chunks, script, controlBlock, annex);
}

/**
 * Options for signXmssP2mrInput: those of signP2mrInput without sighashType,
 * since OP_CHECKXMSSSIG only accepts SIGHASH_DEFAULT.
 */
export type XmssP2mrSignOptions = Omit<P2mrSignOptions, 'sighashType'>;

/**
 * Spends a P2MR input through an XMSS leaf (xmssLeafScript of the signer's
 * key). OP_CHECKXMSSSIG only accepts SIGHASH_DEFAULT, so the
 * previous-transaction check applies to every all-P2MR spend. The fee is
 * checked against maxFeeRate like signP2mrInput does, before the signer
 * reserves a fresh index and signs.
 */
export async function signXmssP2mrInput(
  tx: Transaction,
  inputIndex: number,
  signer: XmssSigner,
  options: XmssP2mrSignOptions,
): Promise<void> {
  const sighashType = Transaction.SIGHASH_DEFAULT;
  const { leaf, controlBlock } = prepareP2mrSpend(tx, inputIndex, options);
  if (!equalBytes(leaf.script, xmssLeafScript(signer.publicKey))) {
    throw new SigningError('INPUT_MISMATCH', 'the leaf script is not the XMSS leaf of the signer key');
  }
  checkInputValues(tx, options, sighashType);
  const placeholder = xmssScriptPathWitness(new Uint8Array(XMSS_SIGNATURE_LENGTH), leaf.script, controlBlock, options.annex);
  checkFee(tx, inputIndex, options.prevouts, placeholder, sighashType, options);
  const hash = tapscriptSighash(tx, inputIndex, {
    prevouts: options.prevouts,
    leafHash: leaf.leafHash,
    sighashType,
    ...(options.annex === undefined ? {} : { annex: options.annex }),
  });
  const signature = await signer.sign(hash);
  tx.setWitness(inputIndex, xmssScriptPathWitness(signature, leaf.script, controlBlock, options.annex));
}

/** What prepareTaprootScriptPathInput needs. */
export interface TaprootScriptPathInputOptions {
  /** The output's 32-byte x-only internal key. */
  internalPubkey: Uint8Array;
  tree: ScriptTree;
  leafIndex: number;
  /** Value of the spent output, in grain. */
  value: bigint;
  sighashType?: number;
}

/**
 * Adds BIP371 script-path metadata to a PSBT input spending a P2TR output:
 * witness UTXO, internal key, Merkle root and the chosen leaf with its
 * control block.
 */
export function prepareTaprootScriptPathInput(
  psbt: Psbt,
  inputIndex: number,
  options: TaprootScriptPathInputOptions,
): void {
  if (!Number.isInteger(inputIndex) || inputIndex < 0 || inputIndex >= psbt.inputCount) {
    throw new RangeError(`PSBT input index ${inputIndex} is out of range`);
  }
  assertValue(options.value, 'input value');
  const sighashType = options.sighashType ?? Transaction.SIGHASH_DEFAULT;
  assertTaprootSighashType(sighashType);
  const leaf = options.tree.leaves[options.leafIndex];
  if (leaf === undefined) {
    throw new RangeError(`script tree has no leaf ${options.leafIndex}`);
  }
  const { output } = p2tr({
    internalPubkey: options.internalPubkey,
    merkleRoot: options.tree.root,
  });
  psbt.updateInput(inputIndex, {
    witnessUtxo: { script: output, value: options.value },
    tapInternalKey: Uint8Array.from(options.internalPubkey),
    tapMerkleRoot: Uint8Array.from(options.tree.root),
    tapLeafScript: [
      {
        leafVersion: leaf.leafVersion,
        script: Uint8Array.from(leaf.script),
        controlBlock: taprootControlBlock(options.internalPubkey, options.tree, options.leafIndex),
      },
    ],
  });
  if (sighashType !== Transaction.SIGHASH_DEFAULT) {
    psbt.updateInput(inputIndex, { sighashType });
  }
}

/** Options for signTaprootScriptPathInput. */
export interface TaprootScriptPathSignOptions extends PsbtSighashOptions {
  /** Hash of the tap leaf to sign, from assembleScriptTree. */
  leafHash: Uint8Array;
}

/**
 * Signs a prepared P2TR script-path PSBT input for one leaf. The leaf must
 * be in the input's tapLeafScript, open the witness UTXO, and push the
 * signer's key. finalizePsbt then builds the witness.
 *
 * The input's sighash type must be in allowedSighashTypes, which holds only
 * SIGHASH_DEFAULT unless the caller lists more.
 */
export function signTaprootScriptPathInput(
  psbt: Psbt,
  inputIndex: number,
  signer: TapscriptSigner,
  options: TaprootScriptPathSignOptions,
): void {
  const { leafHash } = options;
  const sighashType = checkTaprootScriptPathInput(psbt, inputIndex, signer.publicKey, leafHash, options);
  psbt.signTaprootInput(inputIndex, schnorrOnlySigner(signer), leafHash, [sighashType]);
  checkSignedInput(psbt, inputIndex);
}

/** signTaprootScriptPathInput for a signer that answers asynchronously. */
export async function signTaprootScriptPathInputAsync(
  psbt: Psbt,
  inputIndex: number,
  signer: TapscriptSignerAsync,
  options: TaprootScriptPathSignOptions,
): Promise<void> {
  const { leafHash } = options;
  const sighashType = checkTaprootScriptPathInput(psbt, inputIndex, signer.publicKey, leafHash, options);
  await psbt.signTaprootInputAsync(inputIndex, schnorrOnlySigner(signer), leafHash, [sighashType]);
  checkSignedInput(psbt, inputIndex);
}

// bitcoinjs signers must offer ECDSA too; tapscript never asks for it.
function schnorrOnlySigner<T extends TapscriptSigner | TapscriptSignerAsync>(
  signer: T,
): { publicKey: Uint8Array; sign(): never; signSchnorr: T['signSchnorr'] } {
  return {
    publicKey: signer.publicKey,
    sign(): never {
      throw new Error('tapscript signers only produce Schnorr signatures');
    },
    signSchnorr: (hash: Uint8Array) => signer.signSchnorr(hash),
  } as { publicKey: Uint8Array; sign(): never; signSchnorr: T['signSchnorr'] };
}

function checkTaprootScriptPathInput(
  psbt: Psbt,
  inputIndex: number,
  publicKey: Uint8Array,
  leafHash: Uint8Array,
  options: PsbtSighashOptions,
): number {
  const input = psbt.data.inputs[inputIndex];
  if (!Number.isInteger(inputIndex) || input === undefined) {
    throw new RangeError(`PSBT input index ${inputIndex} is out of range`);
  }
  const prevScript = input.witnessUtxo?.script;
  if (prevScript === undefined) {
    throw new SigningError('INPUT_UNPREPARED', `PSBT input ${inputIndex} has no witness UTXO`);
  }
  const kind = classifyOutputScript(prevScript);
  if (kind === 'p2mr') {
    throw new SigningError('INPUT_MISMATCH', 'P2MR PSBT inputs are signed with signP2mrScriptPathInput');
  }
  if (kind !== 'p2tr') {
    throw new SigningError('INPUT_MISMATCH', `PSBT input ${inputIndex} does not spend a P2TR output`);
  }
  const leaf = (input.tapLeafScript ?? []).find((item) =>
    equalBytes(tapLeafHash(item.script, item.leafVersion), leafHash),
  );
  if (leaf === undefined) {
    throw new SigningError('INPUT_MISMATCH', `PSBT input ${inputIndex} has no tap leaf with that hash`);
  }
  verifyTaprootLeafCommitment(leaf.controlBlock, prevScript.slice(2), leaf.script);
  if (!scriptPushesKey(leaf.script, xOnly(publicKey))) {
    throw new SigningError('INPUT_MISMATCH', 'the leaf script does not contain the signer key');
  }
  return psbtSighashType(input.sighashType, inputIndex, options);
}

function checkSignedInput(psbt: Psbt, inputIndex: number): void {
  const valid = psbt.validateSignaturesOfInput(inputIndex, (pubkey, hash, signature) =>
    ecc.verifySchnorr(hash, pubkey, signature),
  );
  if (!valid) {
    throw new SigningError('SIGNATURE_INVALID', `invalid tapscript signature for PSBT input ${inputIndex}`);
  }
}

/** What prepareP2mrScriptPathInput needs. */
export interface P2mrScriptPathInputOptions {
  tree: ScriptTree;
  leafIndex: number;
  /** Value of the spent output, in grain. */
  value: bigint;
  sighashType?: number;
  /**
   * The transaction that created the spent output, stored as the input's
   * nonWitnessUtxo. Signers need it for every input when every input is
   * P2MR.
   */
  previousTransaction?: Transaction;
}

/**
 * Adds P2MR script-path metadata to a PSBT input: witness UTXO, the chosen
 * leaf keyed by its P2MR control block, the sighash type when it is not
 * SIGHASH_DEFAULT, and the previous transaction when one is given. There is
 * no internal key or Merkle root, since the output commits to the root
 * directly.
 */
export function prepareP2mrScriptPathInput(
  psbt: Psbt,
  inputIndex: number,
  options: P2mrScriptPathInputOptions,
): void {
  const txInput = psbt.txInputs[inputIndex];
  if (!Number.isInteger(inputIndex) || txInput === undefined) {
    throw new RangeError(`PSBT input index ${inputIndex} is out of range`);
  }
  assertValue(options.value, 'input value');
  const sighashType = options.sighashType ?? Transaction.SIGHASH_DEFAULT;
  assertTaprootSighashType(sighashType);
  const leaf = options.tree.leaves[options.leafIndex];
  if (leaf === undefined) {
    throw new RangeError(`script tree has no leaf ${options.leafIndex}`);
  }
  const { output } = p2mr({ merkleRoot: options.tree.root });
  const previous = options.previousTransaction;
  if (previous !== undefined) {
    const spent = previous.outs[txInput.index];
    if (!equalBytes(previous.getHash(), txInput.hash)) {
      throw new SigningError('PREVOUT_MISMATCH', `the previous transaction is not the one PSBT input ${inputIndex} spends`);
    }
    if (spent === undefined || spent.value !== options.value || !equalBytes(spent.script, output)) {
      throw new SigningError('PREVOUT_MISMATCH', `the previous transaction does not pay this P2MR output and value`);
    }
    psbt.updateInput(inputIndex, { nonWitnessUtxo: previous.toBuffer() });
  }
  psbt.updateInput(inputIndex, {
    witnessUtxo: { script: output, value: options.value },
    tapLeafScript: [
      {
        leafVersion: leaf.leafVersion,
        script: Uint8Array.from(leaf.script),
        controlBlock: p2mrControlBlock(options.tree, options.leafIndex),
      },
    ],
  });
  if (sighashType !== Transaction.SIGHASH_DEFAULT) {
    psbt.updateInput(inputIndex, { sighashType });
  }
}

/** What the P2MR PSBT signers accept besides the leaf: the sighash types and the prevout check. */
export interface P2mrPsbtSignOptions extends PsbtSighashOptions {
  /** Sign without checking input values against each input's previous transaction. */
  trustPrevouts?: boolean;
}

/** Options for signP2mrScriptPathInput. */
export interface P2mrScriptPathSignOptions extends P2mrPsbtSignOptions {
  /** Hash of the tap leaf to sign, from assembleScriptTree. */
  leafHash: Uint8Array;
}

/**
 * Signs a prepared P2MR script-path PSBT input for one leaf and adds the
 * tap script signature. The leaf must be in the input's tapLeafScript, open
 * the witness UTXO, and push the signer's key. finalizePsbt then builds the
 * witness, multi_a leaves included.
 *
 * When every input is P2MR, every input must carry its previous transaction
 * (nonWitnessUtxo), and the values are checked against them before signing,
 * unless trustPrevouts is set. The
 * input's sighash type must be in allowedSighashTypes.
 */
export function signP2mrScriptPathInput(
  psbt: Psbt,
  inputIndex: number,
  signer: TapscriptSigner,
  options: P2mrScriptPathSignOptions,
): void {
  const { leafHash } = options;
  const { hash, sighashType } = checkP2mrScriptPathInput(psbt, inputIndex, signer.publicKey, leafHash, options);
  const signature = finishTapscriptSignature(
    hash, signer.publicKey, signer.signSchnorr(hash), sighashType, inputIndex,
  );
  addTapScriptSig(psbt, inputIndex, signer.publicKey, leafHash, signature);
}

/** signP2mrScriptPathInput for a signer that answers asynchronously. */
export async function signP2mrScriptPathInputAsync(
  psbt: Psbt,
  inputIndex: number,
  signer: TapscriptSignerAsync,
  options: P2mrScriptPathSignOptions,
): Promise<void> {
  const { leafHash } = options;
  const { hash, sighashType } = checkP2mrScriptPathInput(psbt, inputIndex, signer.publicKey, leafHash, options);
  const signature = finishTapscriptSignature(
    hash, signer.publicKey, await signer.signSchnorr(hash), sighashType, inputIndex,
  );
  addTapScriptSig(psbt, inputIndex, signer.publicKey, leafHash, signature);
}

// bitcoinjs computes BIP341's message and Pearl's is NewTxSigHashes', so the
// sighash is computed here and only the signature is handed to bitcoinjs.
function addTapScriptSig(
  psbt: Psbt,
  inputIndex: number,
  publicKey: Uint8Array,
  leafHash: Uint8Array,
  signature: Uint8Array,
): void {
  psbt.updateInput(inputIndex, {
    tapScriptSig: [{ pubkey: Uint8Array.from(xOnly(publicKey)), leafHash: Uint8Array.from(leafHash), signature }],
  });
}

function checkP2mrScriptPathInput(
  psbt: Psbt,
  inputIndex: number,
  publicKey: Uint8Array,
  leafHash: Uint8Array,
  options: P2mrPsbtSignOptions,
): { hash: Uint8Array; sighashType: number } {
  const input = psbt.data.inputs[inputIndex];
  if (!Number.isInteger(inputIndex) || input === undefined) {
    throw new RangeError(`PSBT input index ${inputIndex} is out of range`);
  }
  const prevScript = input.witnessUtxo?.script;
  if (prevScript === undefined) {
    throw new SigningError('INPUT_UNPREPARED', `PSBT input ${inputIndex} has no witness UTXO`);
  }
  if (classifyOutputScript(prevScript) !== 'p2mr') {
    throw new SigningError('INPUT_MISMATCH', `PSBT input ${inputIndex} does not spend a P2MR output`);
  }
  const leaf = (input.tapLeafScript ?? []).find((item) =>
    equalBytes(tapLeafHash(item.script, item.leafVersion), leafHash),
  );
  if (leaf === undefined) {
    throw new SigningError('INPUT_MISMATCH', `PSBT input ${inputIndex} has no tap leaf with that hash`);
  }
  verifyP2mrLeafCommitment(leaf.controlBlock, prevScript.slice(2), leaf.script);
  if (!scriptPushesKey(leaf.script, xOnly(publicKey))) {
    throw new SigningError('INPUT_MISMATCH', 'the leaf script does not contain the signer key');
  }
  const sighashType = psbtSighashType(input.sighashType, inputIndex, options);

  const tx = Transaction.fromBuffer(psbt.data.globalMap.unsignedTx.toBuffer());
  const previous = psbt.data.inputs.map((item) =>
    item.nonWitnessUtxo === undefined ? undefined : Transaction.fromBuffer(item.nonWitnessUtxo),
  );
  const prevouts = tx.ins.map((txInput, index): TxOutput => {
    const utxo = psbt.data.inputs[index]!.witnessUtxo ?? previous[index]?.outs[txInput.index];
    if (utxo === undefined) {
      throw new SigningError('INPUT_UNPREPARED', `PSBT input ${index} has no UTXO to sign against`);
    }
    return { script: utxo.script, value: utxo.value };
  });
  const values: InputValueOptions = { ...options, prevouts };
  if (previous.every((item): item is Transaction => item !== undefined)) {
    values.previousTransactions = previous;
  } else if (!coversInputValues(prevouts, sighashType) && options.trustPrevouts !== true) {
    throw new SigningError('PREVIOUS_TRANSACTIONS_MISSING',
      'this spend needs the previous transaction (nonWitnessUtxo) of every input to check ' +
        'input values before signing; set trustPrevouts to skip the check',
    );
  }
  checkInputValues(tx, values, sighashType);
  const hash = tapscriptSighash(tx, inputIndex, {
    prevouts,
    leafHash,
    sighashType,
  });
  return { hash, sighashType };
}
