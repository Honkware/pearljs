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

import { sha256 } from '@noble/hashes/sha2';
import { Transaction } from 'bitcoinjs-lib';
import type { Psbt } from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { MAX_GRAIN } from './amount.js';
import { p2mr, p2tr } from './payments.js';
import { classifyOutputScript, taggedHash, tapLeafHash, xmssLeafScript } from './script.js';
import {
  p2mrControlBlock,
  taprootControlBlock,
  verifyP2mrLeafCommitment,
  verifyTaprootLeafCommitment,
} from './scripttree.js';
import type { ScriptTree, ScriptTreeLeaf } from './scripttree.js';
import { XMSS_SIGNATURE_LENGTH } from './xmss.js';
import type { XmssSigner } from './xmss.js';

/**
 * Anything that can make a BIP340 Schnorr signature for a tapscript key,
 * such as a bip32 node. publicKey may be 33-byte compressed or 32-byte
 * x-only. Script paths sign with the untweaked key named in the leaf.
 */
export interface TapscriptSigner {
  publicKey: Uint8Array;
  signSchnorr(hash: Uint8Array): Uint8Array;
}

/** A signer that answers asynchronously, such as a hardware wallet. */
export interface TapscriptSignerAsync {
  publicKey: Uint8Array;
  signSchnorr(hash: Uint8Array): Promise<Uint8Array>;
}

/** A spent output: its script and value in grains. */
export interface Prevout {
  script: Uint8Array;
  value: bigint;
}

const SIGHASH_TYPES = new Set([
  Transaction.SIGHASH_DEFAULT,
  Transaction.SIGHASH_ALL,
  Transaction.SIGHASH_NONE,
  Transaction.SIGHASH_SINGLE,
  Transaction.SIGHASH_ALL | Transaction.SIGHASH_ANYONECANPAY,
  Transaction.SIGHASH_NONE | Transaction.SIGHASH_ANYONECANPAY,
  Transaction.SIGHASH_SINGLE | Transaction.SIGHASH_ANYONECANPAY,
]);

export function assertTaprootSighashType(value: number): void {
  if (!SIGHASH_TYPES.has(value)) {
    throw new Error(`unsupported Taproot sighash type ${value}`);
  }
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
    throw new Error(
      `PSBT input ${inputIndex} asks for sighash type 0x${sighashType.toString(16).padStart(2, '0')}, ` +
        'which is not in allowedSighashTypes',
    );
  }
  return sighashType;
}

function assertValue(value: bigint, what: string): void {
  if (typeof value !== 'bigint') {
    throw new TypeError(`${what} must be a bigint of grains`);
  }
  if (value < 0n || value > MAX_GRAIN) {
    throw new Error(`${what} is outside Pearl amount bounds`);
  }
}

function xOnly(publicKey: Uint8Array): Uint8Array {
  if (publicKey.length === 32) return publicKey;
  if (publicKey.length === 33) return publicKey.slice(1);
  throw new Error(`signer public key must be 32 or 33 bytes, got ${publicKey.length}`);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
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

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function uint32le(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0, true);
  return out;
}

function uint64le(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
}

function varBytes(bytes: Uint8Array): Uint8Array {
  const length = bytes.length;
  let prefix: Uint8Array;
  if (length < 0xfd) prefix = Uint8Array.of(length);
  else if (length <= 0xffff) prefix = Uint8Array.of(0xfd, length & 0xff, length >> 8);
  else prefix = concat([Uint8Array.of(0xfe), uint32le(length)]);
  return concat([prefix, bytes]);
}

function serializeOutput(value: bigint, script: Uint8Array): Uint8Array {
  return concat([uint64le(value), varBytes(script)]);
}

/** Whether NewTxSigHashes computes the amount and script hashes for this spend. */
function coversInputValues(
  prevouts: readonly Prevout[],
  sighashType: number,
): boolean {
  if ((sighashType & SIGHASH_ANYONECANPAY) !== 0) return true;
  return prevouts.some((prevout) => classifyOutputScript(prevout.script) === 'p2tr');
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
  prevouts: readonly Prevout[],
  leafHash: Uint8Array,
  sighashType: number,
): Uint8Array {
  const anyoneCanPay = (sighashType & SIGHASH_ANYONECANPAY) !== 0;
  const outputMode = sighashType & SIGHASH_OUTPUT_MASK;
  const parts: Uint8Array[] = [
    Uint8Array.of(0x00, sighashType),
    uint32le(tx.version),
    uint32le(tx.locktime),
  ];
  if (!anyoneCanPay) {
    const coversValues = coversInputValues(prevouts, sighashType);
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
  parts.push(Uint8Array.of(TAPSCRIPT_SPEND_TYPE));
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
  if (outputMode === Transaction.SIGHASH_SINGLE) {
    const output = tx.outs[inputIndex]!;
    parts.push(sha256(serializeOutput(output.value, output.script)));
  }
  parts.push(leafHash, Uint8Array.of(TAPSCRIPT_KEY_VERSION), uint32le(NO_CODESEPARATOR));
  return taggedHash('TapSighash', concat(parts));
}

/**
 * Tapscript sighash for one input, as Pearl computes it. prevouts must list
 * every input's spent output in order.
 */
export function tapscriptSighash(
  tx: Transaction,
  inputIndex: number,
  prevouts: readonly Prevout[],
  leafHash: Uint8Array,
  sighashType: number = Transaction.SIGHASH_DEFAULT,
): Uint8Array {
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
  if ((sighashType & 0x03) === Transaction.SIGHASH_SINGLE && inputIndex >= tx.outs.length) {
    throw new Error('SIGHASH_SINGLE needs an output at the same index as the input');
  }
  return pearlTapscriptSighash(tx, inputIndex, prevouts, leafHash, sighashType);
}

/**
 * Signs one input for a tapscript leaf and returns the witness signature:
 * 64 bytes for SIGHASH_DEFAULT, otherwise 65 with the sighash byte appended.
 * The signature is checked against the signer's key before it is returned.
 */
export function signTapscript(
  tx: Transaction,
  inputIndex: number,
  prevouts: readonly Prevout[],
  script: Uint8Array,
  signer: TapscriptSigner,
  sighashType: number = Transaction.SIGHASH_DEFAULT,
): Uint8Array {
  const hash = tapscriptSighash(tx, inputIndex, prevouts, tapLeafHash(script), sighashType);
  return finishTapscriptSignature(hash, signer.publicKey, signer.signSchnorr(hash), sighashType, inputIndex);
}

/** signTapscript for a signer that answers asynchronously. */
export async function signTapscriptAsync(
  tx: Transaction,
  inputIndex: number,
  prevouts: readonly Prevout[],
  script: Uint8Array,
  signer: TapscriptSignerAsync,
  sighashType: number = Transaction.SIGHASH_DEFAULT,
): Promise<Uint8Array> {
  const hash = tapscriptSighash(tx, inputIndex, prevouts, tapLeafHash(script), sighashType);
  return finishTapscriptSignature(hash, signer.publicKey, await signer.signSchnorr(hash), sighashType, inputIndex);
}

function finishTapscriptSignature(
  hash: Uint8Array,
  publicKey: Uint8Array,
  signature: Uint8Array,
  sighashType: number,
  inputIndex: number,
): Uint8Array {
  if (!ecc.verifySchnorr(hash, xOnly(publicKey), signature)) {
    throw new Error(`invalid tapscript signature for input ${inputIndex}`);
  }
  return sighashType === Transaction.SIGHASH_DEFAULT
    ? Uint8Array.from(signature)
    : Uint8Array.from([...signature, sighashType]);
}

/**
 * Script-path witness: the leaf's arguments, then the script and control
 * block. Every item is a copy, so a witness set on a transaction shares no
 * memory with the script tree or the caller's buffers.
 */
export function scriptPathWitness(
  stack: readonly Uint8Array[],
  script: Uint8Array,
  controlBlock: Uint8Array,
): Uint8Array[] {
  return [...stack, script, controlBlock].map((item) => Uint8Array.from(item));
}

/**
 * Default for maxFeeRate, in grain per 1000 vbytes: the 5000 per vbyte of
 * bitcoinjs's PSBT guard, half of the 0.1 PRL per 1000 vbytes above which
 * pearld's testmempoolaccept reports a transaction as not allowed. Oyster's
 * txrules set no upper bound, and pearld's sendrawtransaction ignores its
 * fee limit, so nothing downstream stops an overpaying transaction.
 */
export const DEFAULT_MAX_FEE_RATE = 5_000_000n;

export interface FeeGuardOptions {
  /**
   * Highest fee rate to sign for, in grain per 1000 vbytes. A transaction
   * that pays more is refused before anything is signed, which catches a
   * forgotten change output. Defaults to DEFAULT_MAX_FEE_RATE; pass a higher
   * rate to sign a transaction that is meant to pay more.
   */
  maxFeeRate?: bigint;
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
  prevouts: readonly Prevout[],
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
    throw new Error(`transaction outputs (${outputValue} grain) exceed its inputs (${inputValue} grain)`);
  }
  const sized = tx.clone();
  sized.setWitness(inputIndex, witness);
  const vsize = BigInt(sized.virtualSize());
  const fee = inputValue - outputValue;
  const limit = (vsize * maxFeeRate + 999n) / 1000n;
  if (fee > limit) {
    throw new Error(
      `transaction pays a fee of ${fee} grain, above the ${limit} grain that maxFeeRate ` +
        `(${maxFeeRate} grain per 1000 vbytes) allows for ${vsize} vbytes; ` +
        'check for a missing change output, or raise maxFeeRate to sign it',
    );
  }
}

export interface P2mrSignOptions extends FeeGuardOptions {
  prevouts: readonly Prevout[];
  tree: ScriptTree;
  leafIndex: number;
  sighashType?: number;
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
  prevouts: readonly Prevout[],
  previousTransactions: readonly Transaction[],
): void {
  const byHash = new Map(previousTransactions.map((prev) => [toHex(prev.getHash()), prev]));
  tx.ins.forEach((input, index) => {
    const previous = byHash.get(toHex(input.hash));
    if (previous === undefined) {
      throw new Error(`input ${index} is missing the previous transaction it spends`);
    }
    const output = previous.outs[input.index];
    const prevout = prevouts[index];
    if (
      output === undefined ||
      prevout === undefined ||
      output.value !== prevout.value ||
      !equalBytes(output.script, prevout.script)
    ) {
      throw new Error(`prevout ${index} does not match its previous transaction`);
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
 * For other leaf scripts, sign with signTapscript and set the witness from
 * scriptPathWitness and p2mrControlBlock.
 */
export function signP2mrInput(
  tx: Transaction,
  inputIndex: number,
  signer: TapscriptSigner,
  options: P2mrSignOptions,
): void {
  const { leaf, controlBlock, sighashType } = checkP2mrSchnorrSpend(tx, inputIndex, signer.publicKey, options);
  const signature = signTapscript(tx, inputIndex, options.prevouts, leaf.script, signer, sighashType);
  tx.setWitness(inputIndex, scriptPathWitness([signature], leaf.script, controlBlock));
}

/** signP2mrInput for a signer that answers asynchronously. */
export async function signP2mrInputAsync(
  tx: Transaction,
  inputIndex: number,
  signer: TapscriptSignerAsync,
  options: P2mrSignOptions,
): Promise<void> {
  const { leaf, controlBlock, sighashType } = checkP2mrSchnorrSpend(tx, inputIndex, signer.publicKey, options);
  const signature = await signTapscriptAsync(tx, inputIndex, options.prevouts, leaf.script, signer, sighashType);
  tx.setWitness(inputIndex, scriptPathWitness([signature], leaf.script, controlBlock));
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
    throw new Error('the leaf script does not contain the signer key');
  }
  checkInputValues(tx, options, sighashType);
  const signature = new Uint8Array(sighashType === Transaction.SIGHASH_DEFAULT ? 64 : 65);
  checkFee(tx, inputIndex, options.prevouts, scriptPathWitness([signature], leaf.script, controlBlock), sighashType, options);
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
    throw new Error(`input ${inputIndex} does not spend a P2MR output`);
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
    throw new Error('P2MR inputs must have an empty scriptSig');
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
      throw new Error(
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

/** Witness for an XMSS leaf: the signature in five chunks, then script and control block. */
export function xmssScriptPathWitness(
  signature: Uint8Array,
  script: Uint8Array,
  controlBlock: Uint8Array,
): Uint8Array[] {
  if (signature.length !== XMSS_SIGNATURE_LENGTH) {
    throw new Error(`XMSS signature must be ${XMSS_SIGNATURE_LENGTH} bytes, got ${signature.length}`);
  }
  const size = XMSS_SIGNATURE_LENGTH / XMSS_SIGNATURE_CHUNKS;
  const chunks = Array.from({ length: XMSS_SIGNATURE_CHUNKS }, (_, i) =>
    signature.slice(i * size, (i + 1) * size),
  );
  return scriptPathWitness(chunks, script, controlBlock);
}

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
    throw new Error('the leaf script is not the XMSS leaf of the signer key');
  }
  checkInputValues(tx, options, sighashType);
  const placeholder = xmssScriptPathWitness(new Uint8Array(XMSS_SIGNATURE_LENGTH), leaf.script, controlBlock);
  checkFee(tx, inputIndex, options.prevouts, placeholder, sighashType, options);
  const hash = tapscriptSighash(tx, inputIndex, options.prevouts, leaf.leafHash, sighashType);
  const signature = await signer.sign(hash);
  tx.setWitness(inputIndex, xmssScriptPathWitness(signature, leaf.script, controlBlock));
}

export interface TaprootScriptPathInputOptions {
  internalPubkey: Uint8Array;
  tree: ScriptTree;
  leafIndex: number;
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
  leafHash: Uint8Array,
  options: PsbtSighashOptions = {},
): void {
  const sighashType = checkTaprootScriptPathInput(psbt, inputIndex, signer.publicKey, leafHash, options);
  psbt.signTaprootInput(inputIndex, schnorrOnlySigner(signer), leafHash, [sighashType]);
  checkSignedInput(psbt, inputIndex);
}

/** signTaprootScriptPathInput for a signer that answers asynchronously. */
export async function signTaprootScriptPathInputAsync(
  psbt: Psbt,
  inputIndex: number,
  signer: TapscriptSignerAsync,
  leafHash: Uint8Array,
  options: PsbtSighashOptions = {},
): Promise<void> {
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
    throw new Error(`PSBT input ${inputIndex} has no witness UTXO`);
  }
  const kind = classifyOutputScript(prevScript);
  if (kind === 'p2mr') {
    throw new Error('P2MR PSBT inputs are signed with signP2mrScriptPathInput');
  }
  if (kind !== 'p2tr') {
    throw new Error(`PSBT input ${inputIndex} does not spend a P2TR output`);
  }
  const leaf = (input.tapLeafScript ?? []).find((item) =>
    equalBytes(tapLeafHash(item.script, item.leafVersion), leafHash),
  );
  if (leaf === undefined) {
    throw new Error(`PSBT input ${inputIndex} has no tap leaf with that hash`);
  }
  verifyTaprootLeafCommitment(leaf.controlBlock, prevScript.slice(2), leaf.script);
  if (!scriptPushesKey(leaf.script, xOnly(publicKey))) {
    throw new Error('the leaf script does not contain the signer key');
  }
  return psbtSighashType(input.sighashType, inputIndex, options);
}

function checkSignedInput(psbt: Psbt, inputIndex: number): void {
  const valid = psbt.validateSignaturesOfInput(inputIndex, (pubkey, hash, signature) =>
    ecc.verifySchnorr(hash, pubkey, signature),
  );
  if (!valid) {
    throw new Error(`invalid tapscript signature for PSBT input ${inputIndex}`);
  }
}

export interface P2mrScriptPathInputOptions {
  tree: ScriptTree;
  leafIndex: number;
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
      throw new Error(`the previous transaction is not the one PSBT input ${inputIndex} spends`);
    }
    if (spent === undefined || spent.value !== options.value || !equalBytes(spent.script, output)) {
      throw new Error(`the previous transaction does not pay this P2MR output and value`);
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

export interface P2mrPsbtSignOptions extends PsbtSighashOptions {
  /** Sign without checking input values against each input's nonWitnessUtxo. */
  trustPrevouts?: boolean;
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
  leafHash: Uint8Array,
  options: P2mrPsbtSignOptions = {},
): void {
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
  leafHash: Uint8Array,
  options: P2mrPsbtSignOptions = {},
): Promise<void> {
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
    throw new Error(`PSBT input ${inputIndex} has no witness UTXO`);
  }
  if (classifyOutputScript(prevScript) !== 'p2mr') {
    throw new Error(`PSBT input ${inputIndex} does not spend a P2MR output`);
  }
  const leaf = (input.tapLeafScript ?? []).find((item) =>
    equalBytes(tapLeafHash(item.script, item.leafVersion), leafHash),
  );
  if (leaf === undefined) {
    throw new Error(`PSBT input ${inputIndex} has no tap leaf with that hash`);
  }
  verifyP2mrLeafCommitment(leaf.controlBlock, prevScript.slice(2), leaf.script);
  if (!scriptPushesKey(leaf.script, xOnly(publicKey))) {
    throw new Error('the leaf script does not contain the signer key');
  }
  const sighashType = psbtSighashType(input.sighashType, inputIndex, options);

  const tx = Transaction.fromBuffer(psbt.data.globalMap.unsignedTx.toBuffer());
  const previous = psbt.data.inputs.map((item) =>
    item.nonWitnessUtxo === undefined ? undefined : Transaction.fromBuffer(item.nonWitnessUtxo),
  );
  const prevouts = tx.ins.map((txInput, index): Prevout => {
    const utxo = psbt.data.inputs[index]!.witnessUtxo ?? previous[index]?.outs[txInput.index];
    if (utxo === undefined) {
      throw new Error(`PSBT input ${index} has no UTXO to sign against`);
    }
    return { script: utxo.script, value: utxo.value };
  });
  const values: InputValueOptions = { ...options, prevouts };
  if (previous.every((item): item is Transaction => item !== undefined)) {
    values.previousTransactions = previous;
  } else if (!coversInputValues(prevouts, sighashType) && options.trustPrevouts !== true) {
    throw new Error(
      'this spend needs the previous transaction (nonWitnessUtxo) of every input to check ' +
        'input values before signing; set trustPrevouts to skip the check',
    );
  }
  checkInputValues(tx, values, sighashType);
  const hash = tapscriptSighash(tx, inputIndex, prevouts, leafHash, sighashType);
  return { hash, sighashType };
}
