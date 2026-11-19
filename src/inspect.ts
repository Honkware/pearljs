// Reading a transaction the way an explorer or a wallet history view needs
// it: fee, fee rate, size, replace-by-fee signalling, the address behind
// each output, and how each input was spent, worked out from its witness
// and the output it spends (verifyWitnessProgram in txscript/engine.go).

/**
 * Reads a transaction against the outputs it spends: fee, sizes, addresses,
 * and how each input was spent.
 *
 * @module
 */

import type { Transaction } from 'bitcoinjs-lib';
import { fromOutputScript } from './address.js';
import { blockSubsidy } from './consensus.js';
import { hash256 } from './crypto.js';
import { PearlError } from './errors.js';
import { parseMultiA } from './multia.js';
import type { PearlNetwork } from './networks.js';
import { classifyOutputScript, encodeScriptNumber, scriptPush, TAPROOT_ANNEX_TAG, tapLeafHash } from './script.js';
import type { ScriptClass } from './script.js';
import type { TxOutput } from './transaction.js';
import {
  parseP2mrControlBlock,
  parseTaprootControlBlock,
  verifyP2mrLeafCommitment,
  verifyTaprootLeafCommitment,
} from './scripttree.js';
import { concat, equalBytes, toHex } from './internal/bytes.js';
import type { FeeRate } from './amount.js';

// xmss.ts has the same number; importing it would bring the XMSS code in with every inspect.
const XMSS_SIGNATURE_LENGTH = 2340;
// mempool.MaxRBFSequence.
const MAX_RBF_SEQUENCE = 0xfffffffd;

/** `checksig` is `<key> OP_CHECKSIG`, `multiA` a k-of-n OP_CHECKSIGADD leaf, `xmss` `<key> OP_CHECKXMSSSIG`. */
export type LeafKind = 'checksig' | 'multiA' | 'xmss' | 'other';

/** How an input was spent, read from its witness. */
export type InputSpend =
  | { type: 'keyPath'; sighashType: number }
  | {
      type: 'scriptPath';
      /** Whether the spent output is P2MR; otherwise P2TR. */
      p2mr: boolean;
      leaf: LeafKind;
      script: Uint8Array;
      leafVersion: number;
      leafHash: Uint8Array;
      controlBlock: Uint8Array;
      /** The internal key a P2TR control block reveals. */
      internalPubkey?: Uint8Array;
      /** The keys the leaf names: one for checksig and XMSS, all of them for multi_a. */
      keys: Uint8Array[];
      /** Signatures a multi_a leaf needs. */
      threshold?: number;
      /**
       * The one-time index an XMSS signature was made with, 0 to 30: the first
       * four bytes of the signature. Two spends of one key with the same index
       * expose the key. Left out when the stack is not a whole XMSS signature.
       */
      xmssIndex?: number;
      /** Witness items the script runs on, signatures included. */
      stack: Uint8Array[];
      /** Whether the control block and script open the spent output. */
      commits: boolean;
    }
  /** The input of a coinbase transaction, which spends nothing. */
  | { type: 'coinbase' }
  /** No witness yet. */
  | { type: 'unsigned' }
  /** The spent output is not P2TR or P2MR, or the witness cannot spend it. */
  | { type: 'unknown' };

/** One input of an inspected transaction, with the output it spends. */
export interface InspectedInput {
  txid: string;
  vout: number;
  sequence: number;
  /** Value of the spent output, in grain. */
  value: bigint;
  script: Uint8Array;
  /** Address of the spent output, or null when it has none. */
  address: string | null;
  spend: InputSpend;
  /** The BIP 341 annex, when the witness carries one. */
  annex?: Uint8Array;
}

/** One output of an inspected transaction. */
export interface InspectedOutput {
  /** In grain. */
  value: bigint;
  script: Uint8Array;
  type: ScriptClass;
  /** Null for OP_RETURN and non-standard outputs. */
  address: string | null;
  /** What an OP_RETURN output carries when it is one push, as `embed` writes it. */
  data?: Uint8Array;
}

/** What inspectTransaction reports about a coinbase transaction. Amounts are in grain. */
export interface InspectedCoinbase {
  /**
   * The block height the coinbase script starts with (BIP 34), or null when
   * the script does not start with one, as in the genesis blocks.
   */
  height: number | null;
  /** The coinbase script: the height, then whatever the miner added. */
  script: Uint8Array;
  /** What the miner wrote in the script, as coinbaseText reads it: "/P2SH/pearld/" for pearld's own miner. */
  text: string;
  /** Everything the outputs pay. */
  reward: bigint;
  /** blockSubsidy at the height given in the options or read from the script; left out when neither is known. */
  subsidy?: bigint;
  /** The block's fees, as given in the options. */
  fees?: bigint;
  /**
   * Subsidy plus fees minus the reward, when both are known: 0n for a miner
   * that claimed everything, negative for a coinbase no node accepts.
   */
  unclaimed?: bigint;
  /** Index of the output that carries the witness commitment, or -1. */
  witnessCommitmentIndex: number;
  /** The 32-byte witness commitment, or null when the coinbase has none. */
  witnessCommitment: Uint8Array | null;
}

/** What inspectTransaction can be told about the block a transaction is in. */
export interface InspectOptions {
  /** Fees of every other transaction in the block, in grain, to hold a coinbase's reward against. */
  blockFees?: bigint;
  /** Height of the block, for a coinbase whose script does not carry it. */
  height?: number;
}

/** What inspectTransaction reports. Amounts are in grain. */
export interface InspectedTransaction {
  txid: string;
  wtxid: string;
  version: number;
  locktime: number;
  /** Serialized size with witnesses, in bytes. */
  size: number;
  weight: number;
  vsize: number;
  /** Inputs minus outputs, in grain. 0n for a coinbase. */
  fee: bigint;
  /** Grain per 1000 vbytes, rounded down. */
  feeRate: FeeRate;
  /** Whether any input signals replace-by-fee (sequence of 0xfffffffd or less). Never for a coinbase. */
  rbf: boolean;
  inputs: InspectedInput[];
  outputs: InspectedOutput[];
  /** Present on a coinbase transaction only. */
  coinbase?: InspectedCoinbase;
}

/**
 * Describes a transaction given the outputs it spends, in input order, and
 * the network its addresses are on. A coinbase spends nothing and takes an
 * empty list; `options` says what is known of its block.
 *
 * Throws INSPECT_PREVOUTS when the prevouts do not match the inputs or are
 * worth less than the outputs.
 */
export function inspectTransaction(
  tx: Transaction,
  prevouts: readonly TxOutput[],
  network: PearlNetwork,
  options: InspectOptions = {},
): InspectedTransaction {
  const coinbase = tx.isCoinbase();
  if (prevouts.length !== (coinbase ? 0 : tx.ins.length)) {
    throw new PearlError(
      'INSPECT_PREVOUTS',
      coinbase ? 'a coinbase transaction spends nothing: pass no prevouts' : 'prevouts must match the transaction inputs',
    );
  }
  const inputValue = prevouts.reduce((sum, prevout) => sum + prevout.value, 0n);
  const outputValue = tx.outs.reduce((sum, output) => sum + output.value, 0n);
  if (!coinbase && inputValue < outputValue) {
    throw new PearlError('INSPECT_PREVOUTS', 'the prevouts are worth less than the transaction spends');
  }
  const fee = coinbase ? 0n : inputValue - outputValue;
  const vsize = tx.virtualSize();
  return {
    txid: tx.getId(),
    // Not getHash(true), which answers zeros for a coinbase: that is its place in the witness merkle tree, not its id.
    wtxid: toHex(hash256(tx.toBuffer()).reverse()),
    version: tx.version,
    locktime: tx.locktime,
    size: tx.byteLength(),
    weight: tx.weight(),
    vsize,
    fee,
    feeRate: (fee * 1000n) / BigInt(vsize),
    rbf: !coinbase && tx.ins.some((input) => input.sequence <= MAX_RBF_SEQUENCE),
    inputs: tx.ins.map((input, i) => {
      const outpoint = { txid: toHex(Uint8Array.from(input.hash).reverse()), vout: input.index, sequence: input.sequence };
      if (coinbase) return { ...outpoint, value: 0n, script: new Uint8Array(0), address: null, spend: { type: 'coinbase' as const } };
      const prevout = prevouts[i]!;
      const annexed = input.witness.length >= 2 && input.witness[input.witness.length - 1]![0] === TAPROOT_ANNEX_TAG;
      const stack = annexed ? input.witness.slice(0, -1) : input.witness;
      return {
        ...outpoint,
        value: prevout.value,
        script: prevout.script,
        address: addressOf(prevout.script, network),
        spend: inputSpend(stack, prevout.script),
        ...(annexed ? { annex: input.witness[input.witness.length - 1]! } : {}),
      };
    }),
    outputs: tx.outs.map((output) => {
      const type = classifyOutputScript(output.script);
      const data = type === 'nulldata' ? embeddedData(output.script) : null;
      return {
        value: output.value,
        script: output.script,
        type,
        address: addressOf(output.script, network),
        ...(data === null ? {} : { data }),
      };
    }),
    ...(coinbase ? { coinbase: inspectCoinbase(tx, outputValue, network, options) } : {}),
  };
}

function inspectCoinbase(tx: Transaction, reward: bigint, network: PearlNetwork, options: InspectOptions): InspectedCoinbase {
  const script = tx.ins[0]!.script;
  const height = coinbaseHeight(script);
  const at = options.height ?? height;
  const subsidy = at === null ? undefined : blockSubsidy(network, at);
  let witnessCommitmentIndex = -1;
  // ValidateWitnessCommitment takes the last output that carries one.
  for (let i = tx.outs.length - 1; i >= 0 && witnessCommitmentIndex < 0; i -= 1) {
    const out = tx.outs[i]!.script;
    if (out.length >= WITNESS_COMMITMENT_LENGTH && equalBytes(out.subarray(0, WITNESS_MAGIC.length), WITNESS_MAGIC)) witnessCommitmentIndex = i;
  }
  return {
    height,
    script,
    text: coinbaseText(script),
    reward,
    ...(subsidy === undefined ? {} : { subsidy }),
    ...(options.blockFees === undefined ? {} : { fees: options.blockFees }),
    ...(subsidy === undefined || options.blockFees === undefined ? {} : { unclaimed: subsidy + options.blockFees - reward }),
    witnessCommitmentIndex,
    witnessCommitment:
      witnessCommitmentIndex < 0 ? null : tx.outs[witnessCommitmentIndex]!.script.slice(WITNESS_MAGIC.length, WITNESS_COMMITMENT_LENGTH),
  };
}

// A push this short that is not all printable is taken for an extra nonce or a number, not text.
const NONCE_LENGTH = 8;
const isPrintableAscii = (data: Uint8Array): boolean => data.every((byte) => byte >= 0x20 && byte <= 0x7e);

/**
 * The text a miner wrote in a coinbase input script. The BIP 34 height that
 * starts it is skipped, as are opcodes and pushes of up to 8 bytes that are
 * not all printable ASCII, which is how extra nonces and numbers look
 * (pearld's own miner writes the height, an extra nonce and "/P2SH/pearld/").
 * Each remaining push is read as UTF-8; control characters, format characters
 * (bidirectional overrides and isolates, zero-width characters), line and
 * paragraph separators and bytes that are not UTF-8 become one space per run,
 * and the pushes are joined with a space. A push that runs past the end of
 * the script is read up to the end. An empty string when there is no text.
 *
 * The result is safe to print on one line, in a terminal or a page, without
 * reordering what is around it. It is still text the miner chose: a pool
 * name in it is a claim, not an identity.
 */
export function coinbaseText(script: Uint8Array): string {
  const parts: string[] = [];
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let at = 0;
  let skipFirst = coinbaseHeight(script) !== null;
  while (at < script.length) {
    const opcode = script[at]!;
    let start = at + 1;
    let length = 0;
    if (opcode >= 0x01 && opcode <= 0x4b) length = opcode;
    else if (opcode === 0x4c) [start, length] = [at + 2, script[at + 1] ?? 0];
    else if (opcode === 0x4d) [start, length] = [at + 3, (script[at + 1] ?? 0) | ((script[at + 2] ?? 0) << 8)];
    else if (opcode === 0x4e) {
      start = at + 5;
      length = start <= script.length ? new DataView(script.buffer, script.byteOffset + at + 1, 4).getUint32(0, true) : 0;
    }
    const data = script.subarray(Math.min(start, script.length), Math.min(start + length, script.length));
    at = start + length;
    if (skipFirst) {
      skipFirst = false;
      continue;
    }
    if (data.length === 0 || (data.length <= NONCE_LENGTH && !isPrintableAscii(data))) continue;
    const text = decoder.decode(data).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\uFFFD]+/gu, ' ').trim();
    if (text !== '') parts.push(text);
  }
  return parts.join(' ');
}

// OP_RETURN, a push of 36 bytes, then the tag aa21a9ed (blockchain.WitnessMagicBytes).
const WITNESS_MAGIC = Uint8Array.from([0x6a, 0x24, 0xaa, 0x21, 0xa9, 0xed]);
const WITNESS_COMMITMENT_LENGTH = WITNESS_MAGIC.length + 32;

const GENESIS_PREFIX = Uint8Array.from([0x04, 0xff, 0xff, 0x00, 0x1d]);

/**
 * blockchain.ExtractCoinbaseHeight with the check checkSerializedHeight adds:
 * the script must start with the height as a script builder pushes it.
 */
function coinbaseHeight(script: Uint8Array): number | null {
  const first = script[0];
  if (first === undefined) return null;
  if (first === 0) return 0;
  if (first >= 0x51 && first <= 0x60) return first - 0x50;
  if (first > 4 || script.length < 1 + first) return null;
  // Every Pearl genesis coinbase starts with Bitcoin's push of 0x1d00ffff, which would read as a height.
  if (equalBytes(script.subarray(0, GENESIS_PREFIX.length), GENESIS_PREFIX)) return null;
  let height = 0;
  for (let i = first; i >= 1; i -= 1) height = height * 256 + script[i]!;
  if (height > 0x7fffffff) return null;
  const canonical = scriptPush(encodeScriptNumber(BigInt(height)));
  return equalBytes(script.subarray(0, canonical.length), canonical) ? height : null;
}

// The payload of `OP_RETURN <push>`, or null for any other shape.
function embeddedData(script: Uint8Array): Uint8Array | null {
  const opcode = script[1];
  if (opcode === undefined) return null;
  let start = 2;
  let length = opcode;
  if (opcode === 0x4c) [start, length] = [3, script[2] ?? -1];
  else if (opcode === 0x4d) [start, length] = [4, script.length >= 4 ? script[2]! | (script[3]! << 8) : -1];
  else if (opcode > 0x4b) return null;
  return length >= 0 && script.length === start + length ? script.slice(start) : null;
}

function addressOf(script: Uint8Array, network: PearlNetwork): string | null {
  const type = classifyOutputScript(script);
  return type === 'p2tr' || type === 'p2mr' ? fromOutputScript(script, network) : null;
}

/** How a witness, annex removed, spends an output. */
function inputSpend(stack: readonly Uint8Array[], prevScript: Uint8Array): InputSpend {
  const type = classifyOutputScript(prevScript);
  if (type !== 'p2tr' && type !== 'p2mr') return { type: 'unknown' };
  if (stack.length === 0) return { type: 'unsigned' };
  const p2mr = type === 'p2mr';
  if (stack.length === 1) {
    const signature = stack[0]!;
    // A P2MR output has no key path.
    if (p2mr || (signature.length !== 64 && signature.length !== 65)) return { type: 'unknown' };
    return { type: 'keyPath', sighashType: signature.length === 65 ? signature[64]! : 0 };
  }
  const controlBlock = stack[stack.length - 1]!;
  const script = stack[stack.length - 2]!;
  let leafVersion: number;
  let internalPubkey: Uint8Array | undefined;
  try {
    if (p2mr) ({ leafVersion } = parseP2mrControlBlock(controlBlock));
    else ({ leafVersion, internalPubkey } = parseTaprootControlBlock(controlBlock));
  } catch {
    return { type: 'unknown' };
  }
  let commits = true;
  try {
    if (p2mr) verifyP2mrLeafCommitment(controlBlock, prevScript.subarray(2), script);
    else verifyTaprootLeafCommitment(controlBlock, prevScript.subarray(2), script);
  } catch {
    commits = false;
  }
  const details = leafDetails(script);
  const items = stack.slice(0, -2);
  const xmssIndex = details.leaf === 'xmss' ? xmssSignatureIndex(items) : null;
  return {
    type: 'scriptPath',
    p2mr,
    ...details,
    ...(xmssIndex === null ? {} : { xmssIndex }),
    script,
    leafVersion,
    leafHash: tapLeafHash(script, leafVersion),
    controlBlock,
    ...(internalPubkey === undefined ? {} : { internalPubkey }),
    stack: items,
    commits,
  };
}

// An XMSS signature is spread over witness items of at most 520 bytes and starts with its index, big-endian.
function xmssSignatureIndex(items: readonly Uint8Array[]): number | null {
  const signature = concat(items);
  if (signature.length !== XMSS_SIGNATURE_LENGTH) return null;
  return ((signature[0]! << 24) | (signature[1]! << 16) | (signature[2]! << 8) | signature[3]!) >>> 0;
}

function leafDetails(script: Uint8Array): { leaf: LeafKind; keys: Uint8Array[]; threshold?: number } {
  if (script.length === 34 && script[0] === 32 && script[33] === 0xac) {
    return { leaf: 'checksig', keys: [script.slice(1, 33)] };
  }
  if (script.length === 66 && script[0] === 64 && script[65] === 0xde) {
    return { leaf: 'xmss', keys: [script.slice(1, 65)] };
  }
  try {
    const multiA = parseMultiA(script);
    if (multiA !== null) return { leaf: 'multiA', keys: multiA.keys, threshold: multiA.threshold };
  } catch {
    // An unparsable or irregular OP_CHECKSIGADD script is just another leaf here.
  }
  return { leaf: 'other', keys: [] };
}

