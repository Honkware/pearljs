// Script-path spends for P2TR and P2MR outputs.
//
// Both output types use the BIP342 tapscript sighash, which commits to the
// leaf hash, so signing is shared; pearlTapscriptSighash computes it the way
// Pearl's node does. The two output types differ in how the spend travels:
//
// - P2TR script paths go through a BIP371 PSBT. Pearl's Go PSBT code reads
//   and finalizes these the same way.
// - P2MR spends set the witness on the transaction directly, as Pearl's
//   wallet does in txauthor.spendMerkleRoot. Pearl's PSBT parser checks every
//   tap-leaf control block as a Taproot one, which needs a 33-byte header, so
//   a PSBT carrying a P2MR control block would not load in Pearl's own tools.

import { sha256 } from '@noble/hashes/sha2';
import { Transaction } from 'bitcoinjs-lib';
import type { Psbt, Signer } from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { MAX_GRAIN } from './amount.js';
import { p2tr } from './payments.js';
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
  const signature = signer.signSchnorr(hash);
  if (!ecc.verifySchnorr(hash, xOnly(signer.publicKey), signature)) {
    throw new Error(`invalid tapscript signature for input ${inputIndex}`);
  }
  return sighashType === Transaction.SIGHASH_DEFAULT
    ? Uint8Array.from(signature)
    : Uint8Array.from([...signature, sighashType]);
}

/** Script-path witness: the leaf's arguments, then the script and control block. */
export function scriptPathWitness(
  stack: readonly Uint8Array[],
  script: Uint8Array,
  controlBlock: Uint8Array,
): Uint8Array[] {
  return [...stack, script, controlBlock];
}

export interface P2mrSignOptions {
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
 * For other leaf scripts, sign with signTapscript and set the witness from
 * scriptPathWitness and p2mrControlBlock.
 */
export function signP2mrInput(
  tx: Transaction,
  inputIndex: number,
  signer: TapscriptSigner,
  options: P2mrSignOptions,
): void {
  const sighashType = options.sighashType ?? Transaction.SIGHASH_DEFAULT;
  const { leaf, controlBlock } = prepareP2mrSpend(tx, inputIndex, options);
  if (!scriptPushesKey(leaf.script, xOnly(signer.publicKey))) {
    throw new Error('the leaf script does not contain the signer key');
  }
  checkInputValues(tx, options, sighashType);
  const signature = signTapscript(
    tx,
    inputIndex,
    options.prevouts,
    leaf.script,
    signer,
    sighashType,
  );
  tx.setWitness(inputIndex, scriptPathWitness([signature], leaf.script, controlBlock));
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

/**
 * Checks the input values of an all-P2MR spend against the previous
 * transactions, or refuses unless trustPrevouts is set.
 */
function checkInputValues(tx: Transaction, options: P2mrSignOptions, sighashType: number): void {
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
 * previous-transaction check applies to every all-P2MR spend. The signer
 * reserves a fresh index before it signs.
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
        script: leaf.script,
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
 */
export function signTaprootScriptPathInput(
  psbt: Psbt,
  inputIndex: number,
  signer: TapscriptSigner,
  leafHash: Uint8Array,
): void {
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
    throw new Error('P2MR inputs are signed on the transaction with signP2mrInput, not in a PSBT');
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
  if (!scriptPushesKey(leaf.script, xOnly(signer.publicKey))) {
    throw new Error('the leaf script does not contain the signer key');
  }
  const sighashType = input.sighashType ?? Transaction.SIGHASH_DEFAULT;
  assertTaprootSighashType(sighashType);
  const bitcoinjsSigner: Signer = {
    publicKey: signer.publicKey,
    sign(): Uint8Array {
      throw new Error('tapscript signers only produce Schnorr signatures');
    },
    signSchnorr: (hash) => signer.signSchnorr(hash),
  };
  psbt.signTaprootInput(inputIndex, bitcoinjsSigner, leafHash, [sighashType]);
  const valid = psbt.validateSignaturesOfInput(inputIndex, (pubkey, hash, signature) =>
    ecc.verifySchnorr(hash, pubkey, signature),
  );
  if (!valid) {
    throw new Error(`invalid tapscript signature for PSBT input ${inputIndex}`);
  }
}
