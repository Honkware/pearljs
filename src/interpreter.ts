// A port of Pearl's script engine (node/txscript), so a spend can be checked
// without a node. It follows the Go code function by function: engine.go for
// the outer loop and the witness program dispatch, opcode.go for the opcodes,
// stack.go and scriptnum.go for the stack, taproot.go for control blocks,
// sigvalidate.go and sighash.go for signatures. Failures carry the engine's
// ErrorCode name and its message text.
//
// Where Pearl departs from BIP 341 and BIP 342 the code says so with the Go
// file it follows. The differential vectors in vectors/interpreter pin every
// one of them against txscript.NewEngine(...).Execute().

/**
 * A script interpreter that agrees with Pearl's script engine: verify the
 * inputs of a transaction offline, or step through a leaf one opcode at a
 * time.
 *
 * @module
 */

import { ripemd160, sha1 } from '@noble/hashes/legacy';
import { sha256 } from '@noble/hashes/sha2';
import { Transaction } from 'bitcoinjs-lib';
import type { Psbt } from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { OP_CODES, OPCODE_NAMES } from './opcodes.js';
import {
  BASE_LEAF_VERSION,
  LOCKTIME_THRESHOLD,
  MAX_SCRIPT_ELEMENT_SIZE,
  SEQUENCE_LOCKTIME_DISABLED,
  SEQUENCE_LOCKTIME_IS_SECONDS,
  SEQUENCE_LOCKTIME_MASK,
  encodeScriptNumber,
  taggedHash,
  tapBranchHash,
  tapLeafHash,
} from './script.js';
import type { Prevout } from './scriptpath.js';
import { XMSS_PUBLIC_KEY_LENGTH, XMSS_SIGNATURE_LENGTH, xmssVerify } from './xmss.js';

/**
 * Every code a failure can carry. All but the last four are the names of
 * txscript's ErrorCode values, in its order. The last four are the error
 * kinds of the signature library, which the engine passes through unchanged
 * when a public key or a Schnorr signature does not parse.
 */
export const SCRIPT_ERROR_CODES = [
  'ErrInternal',
  'ErrInvalidFlags',
  'ErrInvalidIndex',
  'ErrUnsupportedAddress',
  'ErrTooMuchNullData',
  'ErrUnsupportedScriptVersion',
  'ErrEarlyReturn',
  'ErrEmptyStack',
  'ErrEvalFalse',
  'ErrScriptUnfinished',
  'ErrInvalidProgramCounter',
  'ErrScriptTooBig',
  'ErrElementTooBig',
  'ErrTooManyOperations',
  'ErrStackOverflow',
  'ErrNumberTooBig',
  'ErrVerify',
  'ErrEqualVerify',
  'ErrNumEqualVerify',
  'ErrCheckSigVerify',
  'ErrCheckMultiSigVerify',
  'ErrDisabledOpcode',
  'ErrReservedOpcode',
  'ErrMalformedPush',
  'ErrInvalidStackOperation',
  'ErrUnbalancedConditional',
  'ErrMinimalData',
  'ErrInvalidSigHashType',
  'ErrSigTooShort',
  'ErrSigTooLong',
  'ErrSigInvalidSeqID',
  'ErrSigInvalidDataLen',
  'ErrSigMissingSTypeID',
  'ErrSigMissingSLen',
  'ErrSigInvalidSLen',
  'ErrSigInvalidRIntID',
  'ErrSigZeroRLen',
  'ErrSigNegativeR',
  'ErrSigTooMuchRPadding',
  'ErrSigInvalidSIntID',
  'ErrSigZeroSLen',
  'ErrSigNegativeS',
  'ErrSigTooMuchSPadding',
  'ErrSigHighS',
  'ErrNotPushOnly',
  'ErrSigNullDummy',
  'ErrPubKeyType',
  'ErrCleanStack',
  'ErrNullFail',
  'ErrWitnessMalleated',
  'ErrWitnessMalleatedP2SH',
  'ErrDiscourageUpgradableNOPs',
  'ErrNegativeLockTime',
  'ErrUnsatisfiedLockTime',
  'ErrMinimalIf',
  'ErrDiscourageUpgradableWitnessProgram',
  'ErrWitnessProgramEmpty',
  'ErrWitnessProgramMismatch',
  'ErrWitnessProgramWrongLength',
  'ErrWitnessUnexpected',
  'ErrWitnessPubKeyType',
  'ErrDiscourageOpSuccess',
  'ErrDiscourageUpgradeableTaprootVersion',
  'ErrTapscriptCheckMultisig',
  'ErrDiscourageUpgradeablePubKeyType',
  'ErrTaprootSigInvalid',
  'ErrTaprootMerkleProofInvalid',
  'ErrTaprootOutputKeyParityMismatch',
  'ErrControlBlockTooSmall',
  'ErrControlBlockTooLarge',
  'ErrControlBlockInvalidLength',
  'ErrWitnessHasNoAnnex',
  'ErrInvalidTaprootSigLen',
  'ErrTaprootPubkeyIsEmpty',
  'ErrTaprootMaxSigOps',
  'ErrNonConstScriptCode',
  'ErrCodeSeparator',
  'ErrMerkleRootNoKeyPathSpend',
  'ErrMerkleRootMerkleProofInvalid',
  'ErrMerkleRootControlBlockInvalidParity',
  'ErrPubKeyXTooBig',
  'ErrPubKeyNotOnCurve',
  'ErrSigRTooBig',
  'ErrSigSTooBig',
] as const;

/** The code of a script failure: the name Pearl's engine gives the error. */
export type ScriptErrorCode = (typeof SCRIPT_ERROR_CODES)[number];

/** An opcode's place in the scripts of one input. */
export interface ScriptPosition {
  /** 0 for the signature script, 1 for the output script, 2 for the leaf, as the engine numbers them. */
  scriptIndex: number;
  /** Position of the opcode among the opcodes of its script, from 0. */
  opcodeIndex: number;
  /** Byte offset of the opcode in its script. */
  offset: number;
  /** The opcode byte. */
  opcode: number;
  /** The opcode's name in Pearl's table, such as OP_CHECKSIG or OP_DATA_32. */
  name: string;
}

/** Why an input was refused, in the engine's own terms. */
export interface ScriptFailure {
  ok: false;
  /** The engine's ErrorCode name. */
  code: ScriptErrorCode;
  /** The engine's error text. Some errors have none. */
  message: string;
  /** The opcode that failed. Absent when the failure is not an opcode's, such as a bad control block. */
  at?: ScriptPosition;
}

/** The verdict on one input. */
export type ScriptResult = { ok: true } | ScriptFailure;

/** The verdict on a transaction: the first input that fails, if any. */
export type TransactionResult = { ok: true } | (ScriptFailure & { inputIndex: number });

/** The state of the engine after one opcode. */
export interface ScriptStep extends ScriptPosition {
  /** Data the opcode pushes, or null when it is not a push. */
  data: Uint8Array | null;
  /** False when the opcode sat in a branch that is not executing and was passed over. */
  executed: boolean;
  /** The stack after the opcode, top last. The items are copies. */
  stack: Uint8Array[];
  /** The alt stack after the opcode, top last. */
  altStack: Uint8Array[];
  /** What is left of the leaf's signature operation budget, or null outside a leaf. */
  sigOpsBudget: number | null;
}

/** What executeScript runs a leaf against. */
export interface ExecuteScriptOptions {
  /** The stack the leaf starts with, top last: the witness items before the leaf script. Empty unless given. */
  stack?: readonly Uint8Array[];
  /**
   * The spending transaction, for signature and timelock opcodes. Unless
   * given, the leaf runs against a version 2 transaction with lock time 0,
   * one input with sequence 0 and no outputs.
   */
  tx?: Transaction;
  /** The input that spends the leaf. 0 unless given. */
  inputIndex?: number;
  /**
   * The outputs tx spends, one per input. Unless given, the input spends a
   * P2MR output of value 0 whose only leaf is the script.
   */
  prevouts?: readonly Prevout[];
  /** An annex to commit signatures to; it must start with 0x50. */
  annex?: Uint8Array;
}

class ScriptError extends Error {
  constructor(
    readonly code: ScriptErrorCode,
    message: string,
  ) {
    super(message);
  }
}

function fail(code: ScriptErrorCode, message: string): never {
  throw new ScriptError(code, message);
}

const MAX_STACK_SIZE = 1000;
const MAX_SCRIPT_SIZE = 10000;
const MAX_OPS_PER_SCRIPT = 201;
const SIG_OPS_DELTA = 50;
const XMSS_OPS_COST = 1000;
const XMSS_SIGNATURE_CHUNKS = 5;
const ANNEX_TAG = 0x50;
const LEAF_VERSION_MASK = 0xfe;
const NODE_SIZE = 32;
const MAX_PROOF_SIZE = 128 * NODE_SIZE;
const NO_CODESEPARATOR = 0xffffffff;
const FINAL_SEQUENCE = 0xffffffff;
const SIGHASH_ANYONECANPAY = 0x80;
const SIGHASH_NONE = 2;
const SIGHASH_SINGLE = 3;
const SIGHASH_TYPES = new Set([0x00, 0x01, 0x02, 0x03, 0x81, 0x82, 0x83]);
const EMPTY = new Uint8Array(0);
const TRUE = Uint8Array.of(1);
const ZERO_HASH = new Uint8Array(32);

const FIELD_PRIME = hexToBytes('fffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f');
const GROUP_ORDER = hexToBytes('fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');

const OP = OP_CODES;

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/** Big-endian a >= b for two 32-byte values. */
function notBelow(a: Uint8Array, b: Uint8Array): boolean {
  for (let i = 0; i < 32; i += 1) {
    if (a[i] !== b[i]) return a[i]! > b[i]!;
  }
  return true;
}

function uint32le(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0, true);
  return out;
}

function int64le(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt.asUintN(64, value), true);
  return out;
}

function varIntSize(n: number): number {
  return n < 0xfd ? 1 : n <= 0xffff ? 3 : 5;
}

function varBytes(bytes: Uint8Array): Uint8Array {
  const n = bytes.length;
  const prefix =
    n < 0xfd
      ? Uint8Array.of(n)
      : n <= 0xffff
        ? Uint8Array.of(0xfd, n & 0xff, n >> 8)
        : Uint8Array.of(0xfe, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, n >>> 24);
  return concat([prefix, bytes]);
}

function serializeOutput(output: { value: bigint; script: Uint8Array }): Uint8Array {
  return concat([int64le(output.value), varBytes(output.script)]);
}

/** wire.TxWitness.SerializeSize: the item count, then each item with its length. */
function witnessSerializeSize(witness: readonly Uint8Array[]): number {
  let size = varIntSize(witness.length);
  for (const item of witness) size += varIntSize(item.length) + item.length;
  return size;
}

/** stack.go asBool: any non-zero byte, except a lone sign bit in the last one. */
function asBool(item: Uint8Array): boolean {
  for (let i = 0; i < item.length; i += 1) {
    if (item[i] !== 0) return !(i === item.length - 1 && item[i] === 0x80);
  }
  return false;
}

/** scriptnum.go MakeScriptNum with requireMinimal, which the engine always sets. */
function scriptNumber(item: Uint8Array, maxLength: number): bigint {
  if (item.length > maxLength) {
    fail(
      'ErrNumberTooBig',
      `numeric value encoded as ${toHex(item)} is ${item.length} bytes which exceeds the max allowed of ${maxLength}`,
    );
  }
  if (item.length === 0) return 0n;
  const last = item[item.length - 1]!;
  if ((last & 0x7f) === 0 && (item.length === 1 || (item[item.length - 2]! & 0x80) === 0)) {
    fail('ErrMinimalData', `numeric value encoded as ${toHex(item)} is not minimally encoded`);
  }
  let value = BigInt(last & 0x7f);
  for (let i = item.length - 2; i >= 0; i -= 1) value = (value << 8n) | BigInt(item[i]!);
  return (last & 0x80) !== 0 ? -value : value;
}

/** scriptNum.Int32: clamped, as OP_PICK and OP_ROLL read their index. */
function clampInt32(value: bigint): number {
  if (value > 2147483647n) return 2147483647;
  if (value < -2147483648n) return -2147483648;
  return Number(value);
}

/** stack.go, with its error text. Items are never modified in place. */
class Stack {
  items: Uint8Array[] = [];

  get depth(): number {
    return this.items.length;
  }

  push(item: Uint8Array): void {
    this.items.push(item);
  }

  pushInt(value: bigint): void {
    this.items.push(encodeScriptNumber(value));
  }

  pushBool(value: boolean): void {
    this.items.push(value ? TRUE : EMPTY);
  }

  peek(index: number): Uint8Array {
    const size = this.items.length;
    if (index < 0 || index >= size) {
      fail('ErrInvalidStackOperation', `index ${index} is invalid for stack size ${size}`);
    }
    return this.items[size - index - 1]!;
  }

  nip(index: number): Uint8Array {
    const item = this.peek(index);
    this.items.splice(this.items.length - index - 1, 1);
    return item;
  }

  pop(): Uint8Array {
    return this.nip(0);
  }

  popInt(): bigint {
    return scriptNumber(this.pop(), 4);
  }

  popBool(): boolean {
    return asBool(this.pop());
  }

  drop(count: number): void {
    for (let i = 0; i < count; i += 1) this.pop();
  }

  dup(count: number): void {
    for (let i = 0; i < count; i += 1) this.push(this.peek(count - 1));
  }

  rot(count: number): void {
    for (let i = 0; i < count; i += 1) this.push(this.nip(3 * count - 1));
  }

  swap(count: number): void {
    for (let i = 0; i < count; i += 1) this.push(this.nip(2 * count - 1));
  }

  over(count: number): void {
    for (let i = 0; i < count; i += 1) this.push(this.peek(2 * count - 1));
  }

  tuck(): void {
    const top = this.pop();
    const second = this.pop();
    this.items.push(top, second, top);
  }
}

/** tokenizer.go ScriptTokenizer. next throws where the Go tokenizer records its error. */
class Tokenizer {
  offset = 0;
  /** Index of the opcode next last returned, which is what OP_CODESEPARATOR commits to. */
  position = -1;
  start = 0;
  opcode = 0;
  data: Uint8Array | null = null;

  constructor(readonly script: Uint8Array) {}

  done(): boolean {
    return this.offset >= this.script.length;
  }

  next(): void {
    const { script } = this;
    const opcode = script[this.offset]!;
    const name = OPCODE_NAMES[opcode]!;
    this.position += 1;
    this.start = this.offset;
    this.opcode = opcode;
    if (opcode === OP.OP_0 || opcode > OP.OP_PUSHDATA4) {
      this.offset += 1;
      this.data = null;
      return;
    }
    if (opcode < OP.OP_PUSHDATA1) {
      const remaining = script.length - this.offset;
      if (remaining < opcode + 1) {
        fail(
          'ErrMalformedPush',
          `opcode ${name} requires ${opcode + 1} bytes, but script only has ${remaining} remaining`,
        );
      }
      this.data = script.subarray(this.offset + 1, this.offset + 1 + opcode);
      this.offset += opcode + 1;
      return;
    }
    const lengthBytes = opcode === OP.OP_PUSHDATA1 ? 1 : opcode === OP.OP_PUSHDATA2 ? 2 : 4;
    let remaining = script.length - this.offset - 1;
    if (remaining < lengthBytes) {
      fail(
        'ErrMalformedPush',
        `opcode ${name} requires ${lengthBytes} bytes, but script only has ${remaining} remaining`,
      );
    }
    let length = 0;
    for (let i = lengthBytes - 1; i >= 0; i -= 1) length = length * 256 + script[this.offset + 1 + i]!;
    // The Go tokenizer holds the length in an int32, so 2^31 and above are negative there.
    length |= 0;
    remaining -= lengthBytes;
    if (length > remaining || length < 0) {
      fail(
        'ErrMalformedPush',
        `opcode ${name} pushes ${length} bytes, but script only has ${remaining} remaining`,
      );
    }
    const dataStart = this.offset + 1 + lengthBytes;
    this.data = script.subarray(dataStart, dataStart + length);
    this.offset = dataStart + length;
  }
}

/** script.go checkScriptParses. */
function checkScriptParses(script: Uint8Array): void {
  const tokenizer = new Tokenizer(script);
  while (!tokenizer.done()) tokenizer.next();
}

/** script.go IsPushOnlyScript: false for a script that does not parse, too. */
function isPushOnly(script: Uint8Array): boolean {
  const tokenizer = new Tokenizer(script);
  try {
    while (!tokenizer.done()) {
      tokenizer.next();
      if (tokenizer.opcode > OP.OP_16) return false;
    }
  } catch {
    return false;
  }
  return true;
}

/**
 * standard.go extractWitnessProgramInfo: a version opcode, OP_0 or OP_1 to
 * OP_16, and one direct push of 2 to 40 bytes, with nothing after it.
 */
function witnessProgram(script: Uint8Array): { version: number; program: Uint8Array } | null {
  if (script.length < 4 || script.length > 42) return null;
  const first = script[0]!;
  if (first !== OP.OP_0 && (first < OP.OP_1 || first > OP.OP_16)) return null;
  if (script[1] !== script.length - 2) return null;
  return { version: first === OP.OP_0 ? 0 : first - OP.OP_1 + 1, program: script.subarray(2) };
}

function isP2tr(script: Uint8Array): boolean {
  return script.length === 34 && script[0] === OP.OP_1 && script[1] === 32;
}

function isNullOutpoint(input: { hash: Uint8Array; index: number }): boolean {
  return input.index === 0xffffffff && input.hash.every((byte) => byte === 0);
}

/** The transaction being verified, its spent outputs and the hashes its signature messages share. */
class TxContext {
  private prevoutsHash?: Uint8Array;
  private amountsHash?: Uint8Array;
  private scriptsHash?: Uint8Array;
  private sequencesHash?: Uint8Array;
  private outputsHash?: Uint8Array;

  constructor(
    readonly tx: Transaction,
    readonly prevouts: readonly Prevout[],
  ) {}

  /**
   * calcTaprootSignatureHashRaw (sighash.go:296) over the midstate of
   * NewTxSigHashes (hashcache.go:210). extension is the tapscript part of
   * the message, null for a key path. Returns null where the Go function
   * returns an error, which callers treat as a signature that does not
   * verify.
   */
  signatureHash(
    inputIndex: number,
    sighashType: number,
    annexHash: Uint8Array | null,
    extension: { leafHash: Uint8Array; codeSeparatorPosition: number } | null,
  ): Uint8Array | null {
    const { tx, prevouts } = this;
    if (!SIGHASH_TYPES.has(sighashType)) return null;
    const anyoneCanPay = (sighashType & SIGHASH_ANYONECANPAY) !== 0;
    const outputMode = sighashType & 0x03;
    const parts: Uint8Array[] = [Uint8Array.of(0x00, sighashType), uint32le(tx.version), uint32le(tx.locktime)];
    if (!anyoneCanPay) {
      this.prevoutsHash ??= sha256(concat(tx.ins.map((input) => concat([input.hash, uint32le(input.index)]))));
      this.sequencesHash ??= sha256(concat(tx.ins.map((input) => uint32le(input.sequence))));
      if (this.amountsHash === undefined || this.scriptsHash === undefined) {
        const covered =
          prevouts.some((prevout, index) => !isNullOutpoint(tx.ins[index]!) && isP2tr(prevout.script));
        this.amountsHash = covered ? sha256(concat(prevouts.map((prevout) => int64le(prevout.value)))) : ZERO_HASH;
        this.scriptsHash = covered ? sha256(concat(prevouts.map((prevout) => varBytes(prevout.script)))) : ZERO_HASH;
      }
      parts.push(this.prevoutsHash, this.amountsHash, this.scriptsHash, this.sequencesHash);
    }
    if (outputMode !== SIGHASH_SINGLE && outputMode !== SIGHASH_NONE) {
      this.outputsHash ??= sha256(concat(tx.outs.map(serializeOutput)));
      parts.push(this.outputsHash);
    }
    parts.push(Uint8Array.of((extension === null ? 0 : 2) + (annexHash === null ? 0 : 1)));
    const input = tx.ins[inputIndex]!;
    if (anyoneCanPay) {
      parts.push(input.hash, uint32le(input.index), serializeOutput(prevouts[inputIndex]!), uint32le(input.sequence));
    } else {
      parts.push(uint32le(inputIndex));
    }
    if (annexHash !== null) parts.push(annexHash);
    if (outputMode === SIGHASH_SINGLE) {
      const output = tx.outs[inputIndex];
      if (output === undefined) return null;
      parts.push(sha256(serializeOutput(output)));
    }
    if (extension !== null) {
      parts.push(extension.leafHash, Uint8Array.of(0x00), uint32le(extension.codeSeparatorPosition));
    }
    return taggedHash('TapSighash', concat(parts));
  }
}

/** engine.go tapscriptExecutionCtx. */
interface TapscriptContext {
  annexHash: Uint8Array | null;
  codeSeparatorPosition: number;
  leafHash: Uint8Array;
  opsBudget: number;
}

/** schnorr.ParsePubKey for a 32-byte key; the errors are the signature library's, not txscript's. */
function parseXOnlyKey(key: Uint8Array): void {
  if (notBelow(key, FIELD_PRIME)) fail('ErrPubKeyXTooBig', 'invalid public key: x >= field prime');
  if (!ecc.isXOnlyPoint(key)) {
    fail('ErrPubKeyNotOnCurve', `invalid public key: x coordinate ${toHex(key)} is not on the secp256k1 curve`);
  }
}

/**
 * sigvalidate.go parseTaprootSigAndPubKey: the key is parsed first, then a
 * 64-byte signature or a 65-byte one whose last byte is a non-zero sighash
 * type.
 */
function parseSignature(key: Uint8Array, rawSignature: Uint8Array): { signature: Uint8Array; sighashType: number } {
  parseXOnlyKey(key);
  let sighashType = 0;
  if (rawSignature.length === 65 && rawSignature[64] !== 0) {
    sighashType = rawSignature[64]!;
  } else if (rawSignature.length !== 64) {
    fail('ErrInvalidTaprootSigLen', `invalid sig len: ${rawSignature.length}`);
  }
  const signature = rawSignature.subarray(0, 64);
  if (notBelow(signature.subarray(0, 32), FIELD_PRIME)) fail('ErrSigRTooBig', 'invalid signature: r >= field prime');
  if (notBelow(signature.subarray(32), GROUP_ORDER)) fail('ErrSigSTooBig', 'invalid signature: s >= group order');
  return { signature, sighashType };
}

function verifySchnorr(hash: Uint8Array | null, key: Uint8Array, signature: Uint8Array): boolean {
  if (hash === null) return false;
  // tiny-secp256k1 refuses an r between the group order and the field prime
  // instead of verifying it. Such an r is the x coordinate of a valid
  // signature for about one hash in 2^128, so it is reported as invalid.
  if (notBelow(signature.subarray(0, 32), GROUP_ORDER)) return false;
  return ecc.verifySchnorr(hash, key, signature);
}

function hashAnnex(annex: Uint8Array): Uint8Array {
  return sha256(varBytes(annex));
}

/** taproot.go computeMerkleRootFromProof. */
function rootFromProof(leafVersion: number, proof: Uint8Array, script: Uint8Array): Uint8Array {
  let node = tapLeafHash(script, leafVersion);
  for (let offset = 0; offset < proof.length; offset += NODE_SIZE) {
    node = tapBranchHash(node, proof.subarray(offset, offset + NODE_SIZE));
  }
  return node;
}

function checkControlBlockSize(length: number, baseSize: number, p2mr: boolean): void {
  const maxSize = baseSize + MAX_PROOF_SIZE;
  const what = p2mr ? 'P2MR control block' : 'control block';
  if (length < baseSize) {
    fail('ErrControlBlockTooSmall', `min size is ${baseSize} bytes, ${what} is ${length} bytes`);
  }
  if (length > maxSize) {
    fail('ErrControlBlockTooLarge', `max size is ${maxSize}, ${what} is ${length} bytes`);
  }
  if ((length - baseSize) % NODE_SIZE !== 0) {
    fail('ErrControlBlockInvalidLength', `${what} proof is not a multiple of 32: ${length - baseSize}`);
  }
}

/**
 * taproot.go ParseControlBlock and VerifyTaprootLeafCommitment. Returns the
 * leaf version. ComputeTaprootOutputKey reduces the tweak modulo the group
 * order where BIP 341 fails the spend (taproot.go:297).
 */
function verifyTaprootCommitment(controlBlock: Uint8Array, program: Uint8Array, script: Uint8Array): number {
  checkControlBlockSize(controlBlock.length, 33, false);
  const leafVersion = controlBlock[0]! & LEAF_VERSION_MASK;
  const internalKey = controlBlock.subarray(1, 33);
  parseXOnlyKey(internalKey);
  const root = rootFromProof(leafVersion, controlBlock.subarray(33), script);
  let tweak = taggedHash('TapTweak', concat([internalKey, root]));
  if (notBelow(tweak, GROUP_ORDER)) {
    const reduced = BigInt(`0x${toHex(tweak)}`) - BigInt(`0x${toHex(GROUP_ORDER)}`);
    tweak = hexToBytes(reduced.toString(16).padStart(64, '0'));
  }
  const tweaked = ecc.xOnlyPointAddTweak(internalKey, tweak);
  const outputKey = tweaked === null ? ZERO_HASH : tweaked.xOnlyPubkey;
  if (!equalBytes(outputKey, program)) {
    fail(
      'ErrTaprootMerkleProofInvalid',
      `derived witness program: ${toHex(outputKey)}, expected: ${toHex(program)}, using tapscript_root: ${toHex(root)}`,
    );
  }
  const controlIsOdd = (controlBlock[0]! & 1) === 1;
  const derivedIsOdd = tweaked !== null && tweaked.parity === 1;
  if (controlIsOdd !== derivedIsOdd) {
    fail(
      'ErrTaprootOutputKeyParityMismatch',
      `control block y is odd: ${controlIsOdd}, derived parity is odd: ${derivedIsOdd}`,
    );
  }
  return leafVersion;
}

/** taproot.go ParseMerkleRootControlBlock and VerifyMerkleRootLeafCommitment. Returns the leaf version. */
function verifyP2mrCommitment(controlBlock: Uint8Array, program: Uint8Array, script: Uint8Array): number {
  checkControlBlockSize(controlBlock.length, 1, true);
  if ((controlBlock[0]! & 1) !== 1) {
    fail('ErrMerkleRootControlBlockInvalidParity', 'P2MR control block parity bit must be 1');
  }
  const leafVersion = controlBlock[0]! & LEAF_VERSION_MASK;
  const root = rootFromProof(leafVersion, controlBlock.subarray(1), script);
  if (!equalBytes(root, program)) {
    fail(
      'ErrMerkleRootMerkleProofInvalid',
      `P2MR Merkle proof invalid: computed root ${toHex(root)}, witness program ${toHex(program)}`,
    );
  }
  return leafVersion;
}

const COND_FALSE = 0;
const COND_TRUE = 1;
const COND_SKIP = 2;

/** engine.go isOpcodeDisabled: these fail when the program counter reaches them, executing branch or not. */
function isAlwaysDisabled(opcode: number): boolean {
  switch (opcode) {
    case OP.OP_SUBSTR:
    case OP.OP_LEFT:
    case OP.OP_RIGHT:
    case OP.OP_INVERT:
    case OP.OP_AND:
    case OP.OP_OR:
    case OP.OP_XOR:
    case OP.OP_2MUL:
    case OP.OP_2DIV:
    case OP.OP_MUL:
    case OP.OP_DIV:
    case OP.OP_MOD:
    case OP.OP_LSHIFT:
    case OP.OP_RSHIFT:
      return true;
    default:
      return false;
  }
}

function isConditional(opcode: number): boolean {
  return opcode === OP.OP_IF || opcode === OP.OP_NOTIF || opcode === OP.OP_ELSE || opcode === OP.OP_ENDIF;
}

/** engine.go checkMinimalDataPush. */
function checkMinimalPush(opcode: number, data: Uint8Array): void {
  const name = OPCODE_NAMES[opcode]!;
  const length = data.length;
  const first = data[0]!;
  if (length === 0) {
    if (opcode !== OP.OP_0) {
      fail('ErrMinimalData', `zero length data push is encoded with opcode ${name} instead of OP_0`);
    }
  } else if (length === 1 && first >= 1 && first <= 16) {
    if (opcode !== OP.OP_1 + first - 1) {
      fail('ErrMinimalData', `data push of the value ${first} encoded with opcode ${name} instead of OP_${first}`);
    }
  } else if (length === 1 && first === 0x81) {
    if (opcode !== OP.OP_1NEGATE) {
      fail('ErrMinimalData', `data push of the value -1 encoded with opcode ${name} instead of OP_1NEGATE`);
    }
  } else if (length <= 75) {
    if (opcode !== length) {
      fail('ErrMinimalData', `data push of ${length} bytes encoded with opcode ${name} instead of OP_DATA_${length}`);
    }
  } else if (length <= 255) {
    if (opcode !== OP.OP_PUSHDATA1) {
      fail('ErrMinimalData', `data push of ${length} bytes encoded with opcode ${name} instead of OP_PUSHDATA1`);
    }
  } else if (length <= 65535) {
    if (opcode !== OP.OP_PUSHDATA2) {
      fail('ErrMinimalData', `data push of ${length} bytes encoded with opcode ${name} instead of OP_PUSHDATA2`);
    }
  }
}

/** opcode.go verifyLockTime. */
function verifyLockTime(txLockTime: bigint, threshold: bigint, lockTime: bigint): void {
  if (txLockTime < threshold !== lockTime < threshold) {
    fail(
      'ErrUnsatisfiedLockTime',
      `mismatched locktime types -- tx locktime ${txLockTime}, stack locktime ${lockTime}`,
    );
  }
  if (lockTime > txLockTime) {
    fail(
      'ErrUnsatisfiedLockTime',
      `locktime requirement not satisfied -- locktime is greater than the transaction locktime: ${lockTime} > ${txLockTime}`,
    );
  }
}

/** engine.go Engine, for one input. */
class Engine {
  private readonly scripts: Uint8Array[];
  private scriptIndex = 0;
  private opcodeIndex = 0;
  private tokenizer: Tokenizer;
  private readonly stack = new Stack();
  private readonly altStack = new Stack();
  private conditions: number[] = [];
  private operations = 0;
  private readonly program: { version: number; program: Uint8Array } | null = null;
  private tapscript: TapscriptContext | null = null;
  /** The opcode being executed, for the position of a failure. */
  current: ScriptPosition | null = null;
  /** The opcode the last step executed. */
  last: (ScriptPosition & { data: Uint8Array | null; executed: boolean }) | null = null;

  /**
   * NewEngine (engine.go:1028). Pearl has no script flags: every rule that
   * Bitcoin gates behind a flag is unconditional (engine.go:16).
   */
  constructor(
    private readonly context: TxContext,
    private readonly inputIndex: number,
    leaf?: { script: Uint8Array; stack: readonly Uint8Array[]; annex: Uint8Array | null },
  ) {
    const { tx, prevouts } = context;
    const input = tx.ins[inputIndex]!;
    const signatureScript = input.script;
    const outputScript = prevouts[inputIndex]!.script;
    this.scripts = [signatureScript, outputScript];
    this.tokenizer = new Tokenizer(outputScript);
    if (leaf !== undefined) {
      this.scriptIndex = 2;
      const witness = [...leaf.stack, leaf.script, Uint8Array.of(BASE_LEAF_VERSION | 1)];
      if (leaf.annex !== null) witness.push(leaf.annex);
      this.setupScriptPath(leaf.stack, witnessSerializeSize(witness), leaf.annex, leaf.script, BASE_LEAF_VERSION);
      this.enterScript();
      return;
    }
    if (signatureScript.length === 0 && outputScript.length === 0) {
      fail('ErrEvalFalse', 'false stack entry at end of script execution');
    }
    if (!isPushOnly(signatureScript)) fail('ErrNotPushOnly', 'signature script is not push only');
    for (const script of this.scripts) {
      if (script.length > MAX_SCRIPT_SIZE) {
        fail('ErrScriptTooBig', `script size ${script.length} is larger than max allowed size ${MAX_SCRIPT_SIZE}`);
      }
      checkScriptParses(script);
    }
    if (signatureScript.length === 0) this.scriptIndex = 1;
    this.program = witnessProgram(outputScript);
    if (this.program !== null) {
      if (signatureScript.length !== 0) {
        fail('ErrWitnessMalleated', 'native witness program cannot also have a signature script');
      }
    } else if (input.witness.length > 0) {
      fail('ErrWitnessUnexpected', 'non-witness inputs cannot have a witness');
    }
    this.tokenizer = new Tokenizer(this.scripts[this.scriptIndex]!);
  }

  /** True once every script has run. */
  get finished(): boolean {
    return this.scriptIndex >= this.scripts.length;
  }

  private get executing(): boolean {
    return this.conditions.length === 0 || this.conditions[this.conditions.length - 1] === COND_TRUE;
  }

  /** Engine.Step (engine.go:758). Returns true when all scripts have run. */
  step(): boolean {
    const { tokenizer } = this;
    tokenizer.next();
    const { opcode, data } = tokenizer;
    this.current = {
      scriptIndex: this.scriptIndex,
      opcodeIndex: this.opcodeIndex,
      offset: tokenizer.start,
      opcode,
      name: OPCODE_NAMES[opcode]!,
    };
    const executed = this.executeOpcode(opcode, data);
    this.last = { ...this.current, data, executed };
    const combined = this.stack.depth + this.altStack.depth;
    if (combined > MAX_STACK_SIZE) {
      fail('ErrStackOverflow', `combined stack size ${combined} > max allowed ${MAX_STACK_SIZE}`);
    }
    this.opcodeIndex += 1;
    if (!tokenizer.done()) return false;

    this.current = null;
    if (this.conditions.length !== 0) {
      fail('ErrUnbalancedConditional', 'end of script reached in conditional execution');
    }
    this.altStack.items = [];
    this.operations = 0;
    this.opcodeIndex = 0;
    this.scriptIndex += 1;
    if (this.scriptIndex === 2 && this.program !== null) this.verifyWitnessProgram();
    return this.enterScript();
  }

  /** The end of Step: pass over an empty script and start the tokenizer of the next one. */
  private enterScript(): boolean {
    if (this.scriptIndex < this.scripts.length && this.scripts[this.scriptIndex]!.length === 0) this.scriptIndex += 1;
    if (this.scriptIndex >= this.scripts.length) return true;
    this.tokenizer = new Tokenizer(this.scripts[this.scriptIndex]!);
    return false;
  }

  /**
   * CheckErrorCondition(true) (engine.go:702). A leaf must leave exactly one
   * item; the output script of a key path leaves the single true the engine
   * puts there.
   */
  checkFinalStack(): void {
    this.current = null;
    if (this.tapscript !== null && this.stack.depth !== 1) {
      fail('ErrCleanStack', `stack must contain exactly one item (contains ${this.stack.depth})`);
    } else if (this.stack.depth < 1) {
      fail('ErrEmptyStack', 'stack empty at end of script execution');
    }
    if (!this.stack.popBool()) fail('ErrEvalFalse', 'false stack entry at end of script execution');
  }

  snapshot(): ScriptStep {
    const last = this.last!;
    return {
      ...last,
      data: last.data === null ? null : Uint8Array.from(last.data),
      stack: this.stack.items.map((item) => Uint8Array.from(item)),
      altStack: this.altStack.items.map((item) => Uint8Array.from(item)),
      sigOpsBudget: this.tapscript === null ? null : this.tapscript.opsBudget,
    };
  }

  /** executeOpcode (engine.go:373). Returns whether the opcode ran or was passed over. */
  private executeOpcode(opcode: number, data: Uint8Array | null): boolean {
    const name = OPCODE_NAMES[opcode]!;
    if (isAlwaysDisabled(opcode)) fail('ErrDisabledOpcode', `attempt to execute disabled opcode ${name}`);
    if (opcode === OP.OP_VERIF || opcode === OP.OP_VERNOTIF) {
      fail('ErrReservedOpcode', `attempt to execute reserved opcode ${name}`);
    }
    // Outside a leaf, the operation limit and the element size limit are the
    // two arms of one branch, so the size limit only reaches pushes there
    // (engine.go:387).
    if (this.tapscript === null && opcode > OP.OP_16) {
      this.operations += 1;
      if (this.operations > MAX_OPS_PER_SCRIPT) {
        fail('ErrTooManyOperations', `exceeded max operation limit of ${MAX_OPS_PER_SCRIPT}`);
      }
    } else if (data !== null && data.length > MAX_SCRIPT_ELEMENT_SIZE) {
      fail('ErrElementTooBig', `element size ${data.length} exceeds max allowed size ${MAX_SCRIPT_ELEMENT_SIZE}`);
    }
    const { executing } = this;
    if (!executing && !isConditional(opcode)) return false;
    if (executing && opcode <= OP.OP_PUSHDATA4) checkMinimalPush(opcode, data ?? EMPTY);
    this.run(opcode, name, data);
    return true;
  }

  /** popIfBool (opcode.go:829): minimal-if is consensus, for any script. */
  private popCondition(): boolean {
    const item = this.stack.pop();
    if (item.length > 1) {
      fail(
        'ErrMinimalIf',
        `minimal if is active, top element MUST have a length of at least, instead length is ${item.length}`,
      );
    }
    if (item.length === 1 && item[0] !== 1) {
      fail(
        'ErrMinimalIf',
        `minimal if is active, top stack item MUST be an empty byte array or 0x01, is instead: ${item[0]}`,
      );
    }
    return asBool(item);
  }

  private verify(name: string, code: ScriptErrorCode): void {
    if (!this.stack.popBool()) fail(code, `${name} failed`);
  }

  private tally(cost: number): void {
    const tapscript = this.tapscript!;
    tapscript.opsBudget -= cost;
    if (tapscript.opsBudget < 0) fail('ErrTaprootMaxSigOps', '');
  }

  private binary(apply: (second: bigint, top: bigint) => bigint | boolean): void {
    const top = this.stack.popInt();
    const second = this.stack.popInt();
    const result = apply(second, top);
    this.stack.pushInt(typeof result === 'boolean' ? (result ? 1n : 0n) : result);
  }

  private unary(apply: (value: bigint) => bigint): void {
    this.stack.pushInt(apply(this.stack.popInt()));
  }

  /** The handler of one opcode, from the table in opcode.go. */
  private run(opcode: number, name: string, data: Uint8Array | null): void {
    const { stack } = this;
    if (opcode <= OP.OP_PUSHDATA4) {
      stack.push(data ?? EMPTY);
      return;
    }
    if (opcode >= OP.OP_1 && opcode <= OP.OP_16) {
      stack.pushInt(BigInt(opcode - OP.OP_1 + 1));
      return;
    }
    switch (opcode) {
      case OP.OP_1NEGATE:
        stack.pushInt(-1n);
        return;
      // Pearl has no OP_SUCCESS: BIP 342 makes these end the leaf with
      // success, here they fail when executed (opcode.go:770, with
      // ScriptHasOpSuccess in script.go left unused by the engine).
      case OP.OP_RESERVED:
      case OP.OP_VER:
      case OP.OP_RESERVED1:
      case OP.OP_RESERVED2:
        return fail('ErrReservedOpcode', `attempt to execute reserved opcode ${name}`);
      case OP.OP_NOP:
        return;
      // In Bitcoin these are no-ops that only relay policy discourages. Pearl
      // fails them in consensus (opcode.go:815).
      case OP.OP_NOP1:
      case OP.OP_NOP4:
      case OP.OP_NOP5:
      case OP.OP_NOP6:
      case OP.OP_NOP7:
      case OP.OP_NOP8:
      case OP.OP_NOP9:
      case OP.OP_NOP10:
        return fail('ErrDiscourageUpgradableNOPs', `${name} reserved for soft-fork upgrades`);
      case OP.OP_IF:
      case OP.OP_NOTIF: {
        let condition = COND_SKIP;
        if (this.executing) {
          condition = this.popCondition() === (opcode === OP.OP_IF) ? COND_TRUE : COND_FALSE;
        }
        this.conditions.push(condition);
        return;
      }
      case OP.OP_ELSE: {
        const index = this.conditions.length - 1;
        if (index < 0) {
          fail(
            'ErrUnbalancedConditional',
            `encountered opcode ${name} with no matching opcode to begin conditional execution`,
          );
        }
        const condition = this.conditions[index]!;
        if (condition !== COND_SKIP) this.conditions[index] = condition === COND_TRUE ? COND_FALSE : COND_TRUE;
        return;
      }
      case OP.OP_ENDIF:
        if (this.conditions.length === 0) {
          fail(
            'ErrUnbalancedConditional',
            `encountered opcode ${name} with no matching opcode to begin conditional execution`,
          );
        }
        this.conditions.pop();
        return;
      case OP.OP_VERIFY:
        this.verify(name, 'ErrVerify');
        return;
      case OP.OP_RETURN:
        return fail('ErrEarlyReturn', 'script returned early');
      case OP.OP_CHECKLOCKTIMEVERIFY:
        this.checkLockTime();
        return;
      case OP.OP_CHECKSEQUENCEVERIFY:
        this.checkSequence();
        return;
      case OP.OP_TOALTSTACK:
        this.altStack.push(stack.pop());
        return;
      case OP.OP_FROMALTSTACK:
        stack.push(this.altStack.pop());
        return;
      case OP.OP_2DROP:
        stack.drop(2);
        return;
      case OP.OP_2DUP:
        stack.dup(2);
        return;
      case OP.OP_3DUP:
        stack.dup(3);
        return;
      case OP.OP_2OVER:
        stack.over(2);
        return;
      case OP.OP_2ROT:
        stack.rot(2);
        return;
      case OP.OP_2SWAP:
        stack.swap(2);
        return;
      case OP.OP_IFDUP: {
        const top = stack.peek(0);
        if (asBool(top)) stack.push(top);
        return;
      }
      case OP.OP_DEPTH:
        stack.pushInt(BigInt(stack.depth));
        return;
      case OP.OP_DROP:
        stack.drop(1);
        return;
      case OP.OP_DUP:
        stack.dup(1);
        return;
      case OP.OP_NIP:
        stack.nip(1);
        return;
      case OP.OP_OVER:
        stack.over(1);
        return;
      case OP.OP_PICK:
        stack.push(stack.peek(clampInt32(stack.popInt())));
        return;
      case OP.OP_ROLL:
        stack.push(stack.nip(clampInt32(stack.popInt())));
        return;
      case OP.OP_ROT:
        stack.rot(1);
        return;
      case OP.OP_SWAP:
        stack.swap(1);
        return;
      case OP.OP_TUCK:
        stack.tuck();
        return;
      case OP.OP_CAT:
        this.cat();
        return;
      case OP.OP_SIZE:
        stack.pushInt(BigInt(stack.peek(0).length));
        return;
      case OP.OP_EQUAL:
        stack.pushBool(equalBytes(stack.pop(), stack.pop()));
        return;
      case OP.OP_EQUALVERIFY:
        stack.pushBool(equalBytes(stack.pop(), stack.pop()));
        this.verify(name, 'ErrEqualVerify');
        return;
      case OP.OP_1ADD:
        this.unary((value) => value + 1n);
        return;
      case OP.OP_1SUB:
        this.unary((value) => value - 1n);
        return;
      case OP.OP_NEGATE:
        this.unary((value) => -value);
        return;
      case OP.OP_ABS:
        this.unary((value) => (value < 0n ? -value : value));
        return;
      case OP.OP_NOT:
        this.unary((value) => (value === 0n ? 1n : 0n));
        return;
      case OP.OP_0NOTEQUAL:
        this.unary((value) => (value !== 0n ? 1n : 0n));
        return;
      case OP.OP_ADD:
        this.binary((second, top) => second + top);
        return;
      case OP.OP_SUB:
        this.binary((second, top) => second - top);
        return;
      case OP.OP_BOOLAND:
        this.binary((second, top) => second !== 0n && top !== 0n);
        return;
      case OP.OP_BOOLOR:
        this.binary((second, top) => second !== 0n || top !== 0n);
        return;
      case OP.OP_NUMEQUAL:
        this.binary((second, top) => second === top);
        return;
      case OP.OP_NUMEQUALVERIFY:
        this.binary((second, top) => second === top);
        this.verify(name, 'ErrNumEqualVerify');
        return;
      case OP.OP_NUMNOTEQUAL:
        this.binary((second, top) => second !== top);
        return;
      case OP.OP_LESSTHAN:
        this.binary((second, top) => second < top);
        return;
      case OP.OP_GREATERTHAN:
        this.binary((second, top) => second > top);
        return;
      case OP.OP_LESSTHANOREQUAL:
        this.binary((second, top) => second <= top);
        return;
      case OP.OP_GREATERTHANOREQUAL:
        this.binary((second, top) => second >= top);
        return;
      case OP.OP_MIN:
        this.binary((second, top) => (second < top ? second : top));
        return;
      case OP.OP_MAX:
        this.binary((second, top) => (second > top ? second : top));
        return;
      case OP.OP_WITHIN: {
        const max = stack.popInt();
        const min = stack.popInt();
        const value = stack.popInt();
        stack.pushBool(value >= min && value < max);
        return;
      }
      case OP.OP_RIPEMD160:
        stack.push(ripemd160(stack.pop()));
        return;
      case OP.OP_SHA1:
        stack.push(sha1(stack.pop()));
        return;
      case OP.OP_SHA256:
        stack.push(sha256(stack.pop()));
        return;
      case OP.OP_HASH160:
        stack.push(ripemd160(sha256(stack.pop())));
        return;
      case OP.OP_HASH256:
        stack.push(sha256(sha256(stack.pop())));
        return;
      case OP.OP_CODESEPARATOR:
        if (this.tapscript !== null) this.tapscript.codeSeparatorPosition = this.tokenizer.position;
        return;
      case OP.OP_CHECKSIG:
        this.checkSig();
        return;
      case OP.OP_CHECKSIGVERIFY:
        this.checkSig();
        this.verify(name, 'ErrCheckSigVerify');
        return;
      case OP.OP_CHECKMULTISIG:
      case OP.OP_CHECKMULTISIGVERIFY:
        return fail('ErrTapscriptCheckMultisig', 'OP_CHECKMULTISIG and OP_CHECKMULTISIGVERIFY are disabled');
      case OP.OP_CHECKSIGADD:
        this.checkSigAdd(name);
        return;
      case OP.OP_CHECKXMSSSIG:
        this.checkXmssSig(name);
        return;
      default:
        return fail('ErrReservedOpcode', `attempt to execute invalid opcode ${name}`);
    }
  }

  /** opcodeCheckLockTimeVerify (opcode.go:1018). */
  private checkLockTime(): void {
    const { tx } = this.context;
    const lockTime = scriptNumber(this.stack.peek(0), 5);
    if (lockTime < 0n) fail('ErrNegativeLockTime', `negative lock time: ${lockTime}`);
    verifyLockTime(BigInt(tx.locktime), BigInt(LOCKTIME_THRESHOLD), lockTime);
    if (tx.ins[this.inputIndex]!.sequence === FINAL_SEQUENCE) {
      fail('ErrUnsatisfiedLockTime', 'transaction input is finalized');
    }
  }

  /** opcodeCheckSequenceVerify (opcode.go:1080). */
  private checkSequence(): void {
    const { tx } = this.context;
    const sequence = scriptNumber(this.stack.peek(0), 5);
    if (sequence < 0n) fail('ErrNegativeLockTime', `negative sequence: ${sequence}`);
    if ((sequence & BigInt(SEQUENCE_LOCKTIME_DISABLED)) !== 0n) return;
    if (tx.version >>> 0 < 2) fail('ErrUnsatisfiedLockTime', `invalid transaction version: ${tx.version | 0}`);
    const txSequence = tx.ins[this.inputIndex]!.sequence;
    if ((txSequence & SEQUENCE_LOCKTIME_DISABLED) !== 0) {
      fail(
        'ErrUnsatisfiedLockTime',
        `transaction sequence has sequence locktime disabled bit set: 0x${txSequence.toString(16)}`,
      );
    }
    const mask = BigInt(SEQUENCE_LOCKTIME_IS_SECONDS | SEQUENCE_LOCKTIME_MASK);
    verifyLockTime(BigInt(txSequence) & mask, BigInt(SEQUENCE_LOCKTIME_IS_SECONDS), sequence & mask);
  }

  /**
   * opcodeCat (opcode.go:1327). Enabled in leaves, and charged to the
   * signature operation budget at one unit per 64 bytes of the result, which
   * BIP 347 does not do (opcode.go:1353).
   */
  private cat(): void {
    const { stack } = this;
    if (this.tapscript === null) {
      fail('ErrDisabledOpcode', 'attempt to execute disabled OP_CAT in non-tapscript context');
    }
    if (stack.depth < 2) fail('ErrInvalidStackOperation', 'opcode OP_CAT requires at least 2 items on stack');
    const second = stack.pop();
    const first = stack.pop();
    const length = first.length + second.length;
    if (length > MAX_SCRIPT_ELEMENT_SIZE) {
      fail('ErrElementTooBig', `concatenated element size ${length} exceeds max size`);
    }
    this.tally(Math.floor((length + 63) / 64));
    stack.push(concat([first, second]));
  }

  private tapscriptSignatureHash(sighashType: number): Uint8Array | null {
    const { annexHash, leafHash, codeSeparatorPosition } = this.tapscript!;
    return this.context.signatureHash(this.inputIndex, sighashType, annexHash, { leafHash, codeSeparatorPosition });
  }

  /**
   * newBaseTapscriptSigVerifier and its Verify (sigvalidate.go:186). A key
   * that is not 32 bytes fails the leaf; BIP 342 lets an unknown key type
   * pass (sigvalidate.go:211).
   */
  private verifyTapscriptSignature(key: Uint8Array, rawSignature: Uint8Array): boolean {
    if (key.length !== 32) {
      fail('ErrDiscourageUpgradeablePubKeyType', `unsupported public key length: ${key.length}`);
    }
    const { signature, sighashType } = parseSignature(key, rawSignature);
    return verifySchnorr(this.tapscriptSignatureHash(sighashType), key, signature);
  }

  /** opcodeCheckSig (opcode.go:1963). */
  private checkSig(): void {
    const { stack } = this;
    const key = stack.pop();
    const signature = stack.pop();
    if (this.tapscript === null) fail('ErrInternal', 'OP_CHECKSIG is only supported in tapscript context');
    if (signature.length > 0) this.tally(SIG_OPS_DELTA);
    if (key.length === 0) fail('ErrTaprootPubkeyIsEmpty', '');
    if (signature.length === 0) {
      stack.push(EMPTY);
      return;
    }
    if (!this.verifyTapscriptSignature(key, signature)) {
      fail('ErrNullFail', 'signature not empty on failed checksig');
    }
    stack.pushBool(true);
  }

  /** opcodeCheckSigAdd (opcode.go:2128). */
  private checkSigAdd(name: string): void {
    const { stack } = this;
    if (this.tapscript === null) fail('ErrReservedOpcode', `attempt to execute invalid opcode ${name}`);
    const key = stack.pop();
    const count = stack.popInt();
    const signature = stack.pop();
    if (signature.length !== 0) this.tally(SIG_OPS_DELTA);
    if (key.length === 0) fail('ErrTaprootPubkeyIsEmpty', '');
    if (signature.length === 0) {
      stack.pushInt(count);
      return;
    }
    if (!this.verifyTapscriptSignature(key, signature)) {
      fail('ErrNullFail', 'signature not empty on failed checksig');
    }
    stack.pushInt(count + 1n);
  }

  /**
   * opcodeCheckXmssSig (opcode.go:2024): a 64-byte key over five 468-byte
   * signature chunks, signing the SIGHASH_DEFAULT message of the leaf. There
   * is no empty-signature case: the opcode pushes true or fails.
   */
  private checkXmssSig(name: string): void {
    const { stack } = this;
    if (this.tapscript === null) fail('ErrReservedOpcode', `attempt to execute invalid opcode ${name}`);
    const key = stack.pop();
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < XMSS_SIGNATURE_CHUNKS; i += 1) chunks.unshift(stack.pop());
    const chunkSize = XMSS_SIGNATURE_LENGTH / XMSS_SIGNATURE_CHUNKS;
    if (key.length !== XMSS_PUBLIC_KEY_LENGTH || chunks.some((chunk) => chunk.length !== chunkSize)) {
      fail('ErrNullFail', 'invalid XMSS signature');
    }
    this.tally(XMSS_OPS_COST);
    const hash = this.tapscriptSignatureHash(0)!;
    if (!xmssVerify(key, hash, concat(chunks))) fail('ErrNullFail', 'invalid XMSS signature');
    stack.pushBool(true);
  }

  /** verifyWitnessProgram (engine.go:432). */
  private verifyWitnessProgram(): void {
    const { version, program } = this.program!;
    const { witness } = this.context.tx.ins[this.inputIndex]!;
    if (version === 0) {
      fail('ErrDiscourageUpgradableWitnessProgram', 'segwit v0 programs are not supported');
    }
    if (version !== 1 && version !== 2) {
      fail('ErrDiscourageUpgradableWitnessProgram', `unsupported witness version: ${version}`);
    }
    if (program.length !== 32) {
      fail(
        'ErrDiscourageUpgradableWitnessProgram',
        `unsupported ${version === 1 ? 'taproot' : 'P2MR'} program size: ${program.length}`,
      );
    }
    if (witness.length === 0) fail('ErrWitnessProgramEmpty', 'witness program passed empty witness');

    const witnessSize = witnessSerializeSize(witness);
    // stripWitnessAnnex (engine.go:475), for P2TR and P2MR alike.
    const last = witness[witness.length - 1]!;
    const annexed = witness.length >= 2 && last.length > 0 && last[0] === ANNEX_TAG;
    const items = annexed ? witness.slice(0, -1) : witness;
    const annex = annexed ? last : null;

    if (items.length === 1) {
      if (version === 2) fail('ErrMerkleRootNoKeyPathSpend', 'P2MR does not support key-path spends');
      this.verifyKeyPath(program, items[0]!, annex);
      return;
    }
    const controlBlock = items[items.length - 1]!;
    const script = items[items.length - 2]!;
    const leafVersion =
      version === 1
        ? verifyTaprootCommitment(controlBlock, program, script)
        : verifyP2mrCommitment(controlBlock, program, script);
    this.setupScriptPath(items.slice(0, -2), witnessSize, annex, script, leafVersion);
  }

  /** verifyTaprootKeyPath (engine.go:522) and verifyTaprootKeySpendWithAnnex (taproot.go:94). */
  private verifyKeyPath(program: Uint8Array, rawSignature: Uint8Array, annex: Uint8Array | null): void {
    const { signature, sighashType } = parseSignature(program, rawSignature);
    const hash = this.context.signatureHash(
      this.inputIndex,
      sighashType,
      annex === null ? null : hashAnnex(annex),
      null,
    );
    if (!verifySchnorr(hash, program, signature)) fail('ErrTaprootSigInvalid', '');
    this.stack.items = [TRUE];
  }

  /**
   * setupScriptPathSpend (engine.go:589). The budget for signature
   * operations starts at 50 plus the serialized size of the whole witness,
   * annex included. Leaf versions other than 0xc0 fail; BIP 342 leaves them
   * spendable (engine.go:593).
   */
  private setupScriptPath(
    stack: readonly Uint8Array[],
    witnessSize: number,
    annex: Uint8Array | null,
    script: Uint8Array,
    leafVersion: number,
  ): void {
    if (leafVersion !== BASE_LEAF_VERSION) {
      fail('ErrDiscourageUpgradeableTaprootVersion', `unsupported tapscript leaf version: ${leafVersion}`);
    }
    checkScriptParses(script);
    this.tapscript = {
      annexHash: annex === null ? null : hashAnnex(annex),
      codeSeparatorPosition: NO_CODESEPARATOR,
      leafHash: tapLeafHash(script),
      opsBudget: SIG_OPS_DELTA + witnessSize,
    };
    this.scripts.push(script);
    this.stack.items = [...stack];
    if (stack.length > MAX_STACK_SIZE) {
      fail('ErrStackOverflow', `tapscript stack size ${stack.length} > max allowed ${MAX_STACK_SIZE}`);
    }
    for (const item of stack) {
      if (item.length > MAX_SCRIPT_ELEMENT_SIZE) {
        fail('ErrElementTooBig', `element size ${item.length} exceeds max allowed size ${MAX_SCRIPT_ELEMENT_SIZE}`);
      }
    }
  }
}

function failure(error: unknown, at: ScriptPosition | null): ScriptFailure {
  if (!(error instanceof ScriptError)) throw error;
  return { ok: false, code: error.code, message: error.message, ...(at === null ? {} : { at }) };
}

function checkArguments(tx: Transaction, prevouts: readonly Prevout[]): void {
  if (prevouts.length !== tx.ins.length) {
    throw new Error(`expected ${tx.ins.length} prevouts, got ${prevouts.length}`);
  }
  prevouts.forEach((prevout, index) => {
    if (!(prevout.script instanceof Uint8Array) || typeof prevout.value !== 'bigint') {
      throw new TypeError(`prevout ${index} must have a script and a bigint value in grain`);
    }
  });
}

function* stepInput(
  context: TxContext,
  inputIndex: number,
  trace: boolean,
  leaf?: { script: Uint8Array; stack: readonly Uint8Array[]; annex: Uint8Array | null },
): Generator<ScriptStep, ScriptResult, void> {
  const count = context.tx.ins.length;
  if (!Number.isInteger(inputIndex) || inputIndex < 0 || inputIndex >= count) {
    return {
      ok: false,
      code: 'ErrInvalidIndex',
      message: `transaction input index ${inputIndex} is negative or >= ${count}`,
    };
  }
  let engine: Engine | undefined;
  try {
    engine = new Engine(context, inputIndex, leaf);
    while (!engine.finished) {
      const done = engine.step();
      if (trace) yield engine.snapshot();
      if (done) break;
    }
    engine.checkFinalStack();
    return { ok: true };
  } catch (error) {
    return failure(error, engine?.current ?? null);
  }
}

function runToEnd(steps: Generator<ScriptStep, ScriptResult, void>): ScriptResult {
  let next = steps.next();
  while (next.done !== true) next = steps.next();
  return next.value;
}

/**
 * Runs Pearl's script engine over one input: the result of
 * txscript.NewEngine(...).Execute() for it. prevouts lists the output every
 * input spends, in input order; signatures commit to all of them.
 *
 * Returns `{ ok: true }` or the engine's error code and text. Throws only for
 * arguments the engine has no verdict on: a prevouts list of the wrong length
 * or a value that is not a bigint.
 */
export function verifyInput(
  tx: Transaction,
  inputIndex: number,
  prevouts: readonly Prevout[],
): ScriptResult {
  checkArguments(tx, prevouts);
  return runToEnd(stepInput(new TxContext(tx, prevouts), inputIndex, false));
}

/**
 * Runs the engine over every input, as pearld's ValidateTransactionScripts
 * does, and reports the first input that fails. A coinbase has no scripts to
 * run and passes.
 *
 * This is script validation only. Amounts, fees, lock time finality, relative
 * lock maturity and relay policy are checked elsewhere: see checkSanity and
 * checkStandard.
 */
export function verifyTransaction(
  tx: Transaction,
  prevouts: readonly Prevout[],
): TransactionResult {
  checkArguments(tx, prevouts);
  if (tx.ins.length === 1 && isNullOutpoint(tx.ins[0]!)) return { ok: true };
  const context = new TxContext(tx, prevouts);
  for (let inputIndex = 0; inputIndex < tx.ins.length; inputIndex += 1) {
    const result = runToEnd(stepInput(context, inputIndex, false));
    if (!result.ok) return { ...result, inputIndex };
  }
  return { ok: true };
}

/**
 * verifyInput one opcode at a time. Yields the engine's state after each
 * opcode of the output script and then of the leaf, and returns the verdict.
 *
 * The step that ends the output script already shows the stack the leaf
 * starts with, or the single true of a key path, because the engine checks
 * the witness as part of that step. When an opcode fails nothing is yielded
 * for it: the returned failure names it in `at`.
 */
export function debugInput(
  tx: Transaction,
  inputIndex: number,
  prevouts: readonly Prevout[],
): Generator<ScriptStep, ScriptResult, void> {
  checkArguments(tx, prevouts);
  return stepInput(new TxContext(tx, prevouts), inputIndex, true);
}

/**
 * Runs one leaf script under Pearl's tapscript rules without building a
 * spend: no output, control block or witness is needed, only the stack the
 * leaf starts with. Yields the state after each opcode and returns the
 * verdict, so `for (const step of executeScript(leaf))` traces a leaf and
 * `.next()` steps it.
 *
 * Signature and timelock opcodes read options.tx. The budget for signature
 * operations is the one a single-leaf P2MR spend with this stack would have.
 * Use debugInput to step a real input with its real witness.
 */
export function executeScript(
  script: Uint8Array,
  options: ExecuteScriptOptions = {},
): Generator<ScriptStep, ScriptResult, void> {
  const stack = options.stack ?? [];
  const annex = options.annex ?? null;
  if (annex !== null && annex[0] !== ANNEX_TAG) throw new Error('an annex must start with 0x50');
  const inputIndex = options.inputIndex ?? 0;
  let tx = options.tx;
  let prevouts = options.prevouts;
  if (tx === undefined) {
    if (prevouts !== undefined) throw new Error('prevouts were given without the transaction that spends them');
    tx = new Transaction();
    tx.version = 2;
    tx.addInput(new Uint8Array(32), 0, 0);
  }
  prevouts ??= tx.ins.map(() => ({ script: concat([Uint8Array.of(OP.OP_2, 32), tapLeafHash(script)]), value: 0n }));
  checkArguments(tx, prevouts);
  const context = new TxContext(tx, prevouts);
  return stepInput(context, inputIndex, true, { script, stack, annex });
}

/**
 * Runs the engine over the transaction a finalized PSBT holds, taking each
 * spent output from the PSBT. A self-check after signing: it catches a
 * transaction pearld's script validation would refuse before it is broadcast.
 *
 * Throws when an input is not finalized or carries no UTXO.
 */
export function verifyFinalizedPsbt(psbt: Psbt): TransactionResult {
  const tx = psbt.extractTransaction(true);
  const prevouts = tx.ins.map((input, index): Prevout => {
    const data = psbt.data.inputs[index]!;
    const utxo =
      data.witnessUtxo ??
      (data.nonWitnessUtxo === undefined ? undefined : Transaction.fromBuffer(data.nonWitnessUtxo).outs[input.index]);
    if (utxo === undefined) throw new Error(`PSBT input ${index} has no UTXO to verify against`);
    return { script: utxo.script, value: utxo.value };
  });
  return verifyTransaction(tx, prevouts);
}
