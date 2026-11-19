// Sighash type checks shared by the signers, and Pearl's Taproot signature
// message for the signers and the script interpreter. Not a subpath export.

import { sha256 } from '@noble/hashes/sha2';
import { Transaction } from 'bitcoinjs-lib';
import { SigningError } from '../errors.js';
import { classifyOutputScript, taggedHash } from '../script.js';
import type { PsbtSighashOptions, TapscriptContextOptions } from '../scriptpath.js';
import type { TxOutput } from '../transaction.js';
import { concat, uint32le, varInt } from './bytes.js';

const SIGHASH_TYPES = new Set([
  Transaction.SIGHASH_DEFAULT,
  Transaction.SIGHASH_ALL,
  Transaction.SIGHASH_NONE,
  Transaction.SIGHASH_SINGLE,
  Transaction.SIGHASH_ALL | Transaction.SIGHASH_ANYONECANPAY,
  Transaction.SIGHASH_NONE | Transaction.SIGHASH_ANYONECANPAY,
  Transaction.SIGHASH_SINGLE | Transaction.SIGHASH_ANYONECANPAY,
]);

/**
 * Throws unless value is a Taproot sighash type: DEFAULT, ALL, NONE or SINGLE,
 * the last three also with ANYONECANPAY.
 */
export function assertTaprootSighashType(value: number): void {
  if (!SIGHASH_TYPES.has(value)) {
    throw new SigningError('SIGHASH_UNSUPPORTED', `unsupported Taproot sighash type ${value}`);
  }
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
    throw new SigningError('SIGHASH_NOT_ALLOWED',
      `PSBT input ${inputIndex} asks for sighash type 0x${sighashType.toString(16).padStart(2, '0')}, ` +
        'which is not in allowedSighashTypes',
    );
  }
  return sighashType;
}

const ZERO_HASH = new Uint8Array(32);
export const SIGHASH_ANYONECANPAY = 0x80;
export const SIGHASH_OUTPUT_MASK = 0x03;
const TAPSCRIPT_SPEND_TYPE = 0x02; // ext_flag 1, no annex
const TAPSCRIPT_KEY_VERSION = 0x00;
export const NO_CODESEPARATOR = 0xffffffff;

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
 * Whether NewTxSigHashes computes the amount and script hashes for this
 * spend. With tx, an input whose outpoint is null does not count as P2TR;
 * no transaction on chain but a coinbase has one.
 */
export function coversInputValues(
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
 * The five hashes of NewTxSigHashes (hashcache.go:210) that every input's
 * signature message shares, each computed on first use and then kept, so a
 * transaction of n inputs costs O(n) to hash once rather than once per input.
 * Valid only while the transaction's inputs, outputs and prevouts stay as
 * they were when it was made.
 */
export class TaprootMidstate {
  #prevouts?: Uint8Array;
  #amounts?: Uint8Array;
  #scripts?: Uint8Array;
  #sequences?: Uint8Array;
  #outputs?: Uint8Array;
  #coversValues?: boolean;

  constructor(
    private readonly tx: Transaction,
    private readonly spent: readonly TxOutput[],
  ) {}

  get prevouts(): Uint8Array {
    return (this.#prevouts ??= sha256(concat(this.tx.ins.map((input) => concat([input.hash, uint32le(input.index)])))));
  }

  // As in NewTxSigHashes; ANYONECANPAY skips these hashes.
  private get coversValues(): boolean {
    return (this.#coversValues ??= coversInputValues(this.spent, Transaction.SIGHASH_DEFAULT, this.tx));
  }

  get amounts(): Uint8Array {
    return (this.#amounts ??= this.coversValues ? sha256(concat(this.spent.map((prevout) => uint64le(prevout.value)))) : ZERO_HASH);
  }

  get scripts(): Uint8Array {
    return (this.#scripts ??= this.coversValues ? sha256(concat(this.spent.map((prevout) => varBytes(prevout.script)))) : ZERO_HASH);
  }

  get sequences(): Uint8Array {
    return (this.#sequences ??= sha256(concat(this.tx.ins.map((input) => uint32le(input.sequence)))));
  }

  get outputs(): Uint8Array {
    return (this.#outputs ??= sha256(concat(this.tx.outs.map((output) => serializeOutput(output.value, output.script)))));
  }
}

/**
 * Pearl's Taproot signature message, mirroring calcTaprootSignatureHashRaw
 * and the midstate from NewTxSigHashes: for a key path when leafHash is null,
 * with the tapscript extension otherwise. It follows Pearl's consensus code,
 * so P2MR signatures validate on Pearl nodes; the Go vectors pin every case.
 * A caller hashing several inputs of one unchanged transaction passes one
 * midstate to all of them.
 */
export function pearlTaprootSighash(
  tx: Transaction,
  inputIndex: number,
  prevouts: readonly TxOutput[],
  leafHash: Uint8Array | null,
  sighashType: number,
  options: TapscriptContextOptions,
  midstate: TaprootMidstate = new TaprootMidstate(tx, prevouts),
): Uint8Array {
  const anyoneCanPay = (sighashType & SIGHASH_ANYONECANPAY) !== 0;
  const outputMode = sighashType & SIGHASH_OUTPUT_MASK;
  const parts: Uint8Array[] = [
    Uint8Array.of(0x00, sighashType),
    uint32le(tx.version),
    uint32le(tx.locktime),
  ];
  if (!anyoneCanPay) parts.push(midstate.prevouts, midstate.amounts, midstate.scripts, midstate.sequences);
  if (outputMode !== Transaction.SIGHASH_SINGLE && outputMode !== Transaction.SIGHASH_NONE) parts.push(midstate.outputs);
  // spend_type is ext_flag * 2 + annex_present; the extension is the tapscript one.
  parts.push(Uint8Array.of((leafHash === null ? 0 : TAPSCRIPT_SPEND_TYPE) | (options.annex === undefined ? 0 : 1)));
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
  if (leafHash !== null) {
    parts.push(leafHash, Uint8Array.of(TAPSCRIPT_KEY_VERSION), uint32le(options.codeSeparatorPosition ?? NO_CODESEPARATOR));
  }
  return taggedHash('TapSighash', concat(parts));
}
