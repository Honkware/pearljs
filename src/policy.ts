// Pearl's relay policy (node/mempool/policy.go and the standardness checks in
// mempool.go) for wallets that want to catch a transaction pearld would refuse
// before broadcasting it, plus vsize estimates for unsigned transactions.
//
// Pearl's mempool is stricter than Bitcoin Core's in a few places: every
// transaction needs witness data, only P2TR, P2MR and OP_RETURN outputs are
// standard, and the default relay fee is 1000 grain per 1000 vbytes. Errors
// carry pearld's own messages.

import { Transaction } from 'bitcoinjs-lib';
import { MAX_GRAIN } from './amount.js';
import { classifyOutputScript, extractWitnessProgram } from './script.js';
import { decompileScript, isPushOnlyScript } from './scripttools.js';
import { parseMultiA } from './multia.js';
import { XMSS_SIGNATURE_LENGTH } from './xmss.js';
import type { Prevout } from './scriptpath.js';
import type { ScriptTree } from './scripttree.js';

/** mempool.DefaultMinRelayTxFee, in grain per 1000 vbytes. */
export const DEFAULT_MIN_RELAY_FEE = 1000n;
export const MAX_STANDARD_TX_VSIZE = 100_000;
/** pearld's default maximum transaction version (server.go). */
export const MAX_STANDARD_TX_VERSION = 2;
/** mempool.MinStandardTxNonWitnessSize, against CVE-2017-12842. */
export const MIN_STANDARD_TX_NON_WITNESS_SIZE = 65;
const MAX_STANDARD_SIG_SCRIPT_SIZE = 1650;
const MAX_SCRIPT_SIZE = 10_000;
const LOCK_TIME_THRESHOLD = 500_000_000;
const MAX_INT64 = (1n << 63n) - 1n;

/** mempool.GetDustThreshold: three times the size of the output plus a typical input spending it. */
export function dustThreshold(script: Uint8Array): bigint {
  const outputSize = 8 + varIntSize(script.length) + script.length;
  // 107 witness bytes count as CalcVsize(0, 107) = 27 vbytes.
  const inputSize = extractWitnessProgram(script) !== null ? 27 : 107;
  return 3n * BigInt(outputSize + 41 + inputSize);
}

/** mempool.IsDust, with minRelayFee in grain per 1000 vbytes. */
export function isDust(output: { script: Uint8Array; value: bigint }, minRelayFee = DEFAULT_MIN_RELAY_FEE): boolean {
  if (isUnspendable(output.script)) return true;
  if (output.value > MAX_GRAIN) return true;
  if (output.value > MAX_INT64 / 1000n) return false;
  return output.value * 1000n < dustThreshold(output.script) * minRelayFee;
}

/** calcMinRequiredTxRelayFee: the smallest fee pearld relays for a transaction of this vsize. */
export function minRelayFee(vsize: number, feeRate = DEFAULT_MIN_RELAY_FEE): bigint {
  const size = BigInt(vsize);
  if (feeRate > 0n && size > MAX_INT64 / feeRate) return MAX_GRAIN;
  let fee = (size * feeRate) / 1000n;
  if (fee === 0n && feeRate > 0n) fee = feeRate;
  if (fee < 0n || fee > MAX_GRAIN) fee = MAX_GRAIN;
  return fee;
}

/** The fee for a vsize at a rate in grain per 1000 vbytes, rounded up so it never falls under the rate. */
export function feeForVsize(vsize: number, feeRate: bigint): bigint {
  return (BigInt(vsize) * feeRate + 999n) / 1000n;
}

export interface StandardOptions {
  /** The input values and scripts, in input order. Enables the input and relay fee checks. */
  prevouts?: readonly Prevout[];
  /** Height of the next block. With medianTimePast, enables the finality check. */
  height?: number;
  /** Median time past of the chain tip, in Unix seconds. */
  medianTimePast?: number;
  /** pearld's --minrelaytxfee, in grain per 1000 vbytes. */
  minRelayFee?: bigint;
  maxTxVersion?: number;
}

/**
 * Throws with pearld's reason if its mempool would refuse the transaction as
 * non-standard, dust or under the relay fee. Consensus rules, signatures,
 * sequence locks and mempool conflicts are not checked.
 */
export function checkStandard(tx: Transaction, options: StandardOptions = {}): void {
  const feeRate = options.minRelayFee ?? DEFAULT_MIN_RELAY_FEE;
  const maxVersion = options.maxTxVersion ?? MAX_STANDARD_TX_VERSION;

  if (!tx.hasWitnesses()) throw new Error('transaction has no witness data');
  if (tx.byteLength(false) < MIN_STANDARD_TX_NON_WITNESS_SIZE) throw new Error(`tx ${tx.getId()} is too small`);

  // CheckTransactionSanity refuses other outputs as a consensus rule before
  // the mempool reaches CheckTransactionStandard; Pearl has no other class.
  tx.outs.forEach((output, i) => {
    if (classifyOutputScript(output.script) === 'nonstandard') {
      throw new Error(`transaction output ${i} has unsupported script type nonstandard`);
    }
  });

  // CheckTransactionStandard, in its order.
  if (tx.version > maxVersion || tx.version < 1) {
    throw new Error(`transaction version ${tx.version} is not in the valid range of 1-${maxVersion}`);
  }
  if (options.height !== undefined && !isFinal(tx, options.height, options.medianTimePast ?? 0)) {
    throw new Error('transaction is not finalized');
  }
  const vsize = tx.virtualSize();
  if (vsize > MAX_STANDARD_TX_VSIZE) {
    throw new Error(`vsize of transaction is larger than max allowed: ${vsize} > ${MAX_STANDARD_TX_VSIZE}`);
  }
  tx.ins.forEach((input, i) => {
    if (input.script.length > MAX_STANDARD_SIG_SCRIPT_SIZE) {
      throw new Error(
        `transaction input ${i}: signature script size is larger than max allowed: ${input.script.length} > ${MAX_STANDARD_SIG_SCRIPT_SIZE} bytes`,
      );
    }
    if (!isPushOnlyScript(input.script)) throw new Error(`transaction input ${i}: signature script is not push only`);
  });
  let nullData = 0;
  tx.outs.forEach((output, i) => {
    if (classifyOutputScript(output.script) === 'nulldata') nullData += 1;
    else if (isDust(output, feeRate)) throw new Error(`transaction output ${i}: payment is dust: ${output.value}`);
  });
  if (nullData > 1) throw new Error('more than one transaction output in a nulldata script');

  const prevouts = options.prevouts;
  if (prevouts === undefined) return;
  if (prevouts.length !== tx.ins.length) throw new Error('prevouts must match the transaction inputs');
  prevouts.forEach((prevout, i) => {
    if (classifyOutputScript(prevout.script) === 'nonstandard') {
      throw new Error(`transaction input #${i} has a non-standard script form`);
    }
  });
  const inputValue = prevouts.reduce((sum, prevout) => sum + prevout.value, 0n);
  const outputValue = tx.outs.reduce((sum, output) => sum + output.value, 0n);
  if (inputValue < outputValue) {
    throw new Error(
      `total value of all transaction inputs for transaction ${tx.getId()} is ${inputValue} which is less than the amount spent of ${outputValue}`,
    );
  }
  const fee = inputValue - outputValue;
  const required = minRelayFee(vsize, feeRate);
  if (fee < required) {
    throw new Error(`transaction ${tx.getId()} has ${fee} fees which is under the required amount of ${required}`);
  }
}

/** blockchain.IsFinalizedTransaction. */
function isFinal(tx: Transaction, height: number, medianTimePast: number): boolean {
  if (tx.locktime === 0) return true;
  const limit = tx.locktime < LOCK_TIME_THRESHOLD ? height : medianTimePast;
  if (tx.locktime < limit) return true;
  return tx.ins.every((input) => input.sequence === 0xffffffff);
}

/** txscript.IsUnspendable. */
function isUnspendable(script: Uint8Array): boolean {
  if (script.length > 0 && script[0] === 0x6a) return true;
  if (script.length > MAX_SCRIPT_SIZE) return true;
  try {
    decompileScript(script);
    return false;
  } catch {
    return true;
  }
}

/** How an input will be spent, for estimateVsize. */
export type SpendEstimate =
  | { type: 'keyPath'; sighashType?: number }
  | {
      type: 'scriptPath';
      tree: ScriptTree;
      leafIndex: number;
      p2mr: boolean;
      sighashType?: number;
      /** Witness item sizes before the leaf script. Needed for leaves other than checksig, multi_a and XMSS. */
      stack?: readonly number[];
    }
  | { type: 'witness'; items: readonly number[] };

/**
 * The vsize the transaction will have once each input carries the witness
 * described for it. Schnorr signatures have a fixed size, so the estimate is
 * exact for key paths, checksig, multi_a (with exactly the threshold signing)
 * and XMSS leaves.
 */
export function estimateVsize(tx: Transaction, spends: readonly SpendEstimate[]): number {
  if (spends.length !== tx.ins.length) throw new Error('spends must match the transaction inputs');
  const copy = tx.clone();
  spends.forEach((spend, i) => {
    copy.setWitness(i, witnessSizes(spend).map((size) => new Uint8Array(size)));
  });
  return copy.virtualSize();
}

function witnessSizes(spend: SpendEstimate): number[] {
  if (spend.type === 'witness') return [...spend.items];
  const signature = (spend.sighashType ?? Transaction.SIGHASH_DEFAULT) === Transaction.SIGHASH_DEFAULT ? 64 : 65;
  if (spend.type === 'keyPath') return [signature];
  const leaf = spend.tree.leaves[spend.leafIndex];
  if (leaf === undefined) throw new RangeError(`leaf index ${spend.leafIndex} is out of range`);
  const controlBlock = (spend.p2mr ? 1 : 33) + leaf.proof.length;
  return [...(spend.stack ?? leafStack(leaf.script, signature)), leaf.script.length, controlBlock];
}

function leafStack(script: Uint8Array, signature: number): number[] {
  // <64-byte key> OP_CHECKXMSSSIG takes the signature in five chunks.
  if (script.length === 66 && script[0] === 64 && script[65] === 0xde) {
    return Array<number>(5).fill(XMSS_SIGNATURE_LENGTH / 5);
  }
  // <32-byte key> OP_CHECKSIG
  if (script.length === 34 && script[0] === 32 && script[33] === 0xac) return [signature];
  const multiA = parseMultiA(script);
  if (multiA !== null) {
    // One item per key, empty for keys that do not sign.
    return multiA.keys.map((_, i) => (i < multiA.threshold ? signature : 0));
  }
  throw new Error('pass stack sizes for this leaf');
}

function varIntSize(n: number): number {
  return n < 0xfd ? 1 : n <= 0xffff ? 3 : n <= 0xffffffff ? 5 : 9;
}
