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
import { parseMultiA } from './multia.js';
import type { PearlNetwork } from './networks.js';
import { classifyOutputScript, tapLeafHash } from './script.js';
import type { ScriptClass } from './script.js';
import type { Prevout } from './scriptpath.js';
import {
  parseP2mrControlBlock,
  parseTaprootControlBlock,
  verifyP2mrLeafCommitment,
  verifyTaprootLeafCommitment,
} from './scripttree.js';
import { toHex } from './internal/bytes.js';

// mempool.MaxRBFSequence.
const MAX_RBF_SEQUENCE = 0xfffffffd;
const ANNEX_TAG = 0x50;

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
      /** Witness items the script runs on, signatures included. */
      stack: Uint8Array[];
      /** Whether the control block and script open the spent output. */
      commits: boolean;
    }
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
  /** Inputs minus outputs, in grain. */
  fee: bigint;
  /** Grain per 1000 vbytes, rounded down. */
  feeRate: bigint;
  /** Whether any input signals replace-by-fee (sequence of 0xfffffffd or less). */
  rbf: boolean;
  inputs: InspectedInput[];
  outputs: InspectedOutput[];
}

/** Describes a transaction given the outputs it spends, in input order, and the network its addresses are on. */
export function inspectTransaction(
  tx: Transaction,
  prevouts: readonly Prevout[],
  network: PearlNetwork,
): InspectedTransaction {
  if (prevouts.length !== tx.ins.length) throw new Error('prevouts must match the transaction inputs');
  const inputValue = prevouts.reduce((sum, prevout) => sum + prevout.value, 0n);
  const outputValue = tx.outs.reduce((sum, output) => sum + output.value, 0n);
  if (inputValue < outputValue) throw new Error('the prevouts are worth less than the transaction spends');
  const fee = inputValue - outputValue;
  const vsize = tx.virtualSize();
  return {
    txid: tx.getId(),
    wtxid: toHex(Uint8Array.from(tx.getHash(true)).reverse()),
    version: tx.version,
    locktime: tx.locktime,
    size: tx.byteLength(),
    weight: tx.weight(),
    vsize,
    fee,
    feeRate: (fee * 1000n) / BigInt(vsize),
    rbf: tx.ins.some((input) => input.sequence <= MAX_RBF_SEQUENCE),
    inputs: tx.ins.map((input, i) => {
      const prevout = prevouts[i]!;
      const annexed = input.witness.length >= 2 && input.witness[input.witness.length - 1]![0] === ANNEX_TAG;
      const stack = annexed ? input.witness.slice(0, -1) : input.witness;
      return {
        txid: toHex(Uint8Array.from(input.hash).reverse()),
        vout: input.index,
        sequence: input.sequence,
        value: prevout.value,
        script: prevout.script,
        address: addressOf(prevout.script, network),
        spend: inputSpend(stack, prevout.script),
        ...(annexed ? { annex: input.witness[input.witness.length - 1]! } : {}),
      };
    }),
    outputs: tx.outs.map((output) => ({
      value: output.value,
      script: output.script,
      type: classifyOutputScript(output.script),
      address: addressOf(output.script, network),
    })),
  };
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
  return {
    type: 'scriptPath',
    p2mr,
    ...leafDetails(script),
    script,
    leafVersion,
    leafHash: tapLeafHash(script, leafVersion),
    controlBlock,
    ...(internalPubkey === undefined ? {} : { internalPubkey }),
    stack: stack.slice(0, -2),
    commits,
  };
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

