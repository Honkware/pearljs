// Pearl's relay policy (node/mempool/policy.go and the standardness checks in
// mempool.go) for wallets that want to catch a transaction pearld would refuse
// before broadcasting it, plus vsize estimates for unsigned transactions.
//
// Pearl's mempool is stricter than Bitcoin Core's in a few places: every
// transaction needs witness data, only P2TR, P2MR and OP_RETURN outputs are
// standard, and the default relay fee is 1000 grain per 1000 vbytes. Errors
// carry pearld's own messages.

/**
 * pearld's relay policy: standardness, dust, the relay fee, and size estimates
 * for unsigned transactions.
 *
 * @module
 */

import { Transaction } from 'bitcoinjs-lib';
import { MAX_GRAIN } from './amount.js';
import { classifyOutputScript, extractWitnessProgram } from './script.js';
import { decompileScript, isPushOnlyScript } from './scripttools.js';
import { parseMultiA } from './multia.js';
import { XMSS_SIGNATURE_LENGTH } from './xmss.js';
import type { TxOutput } from './transaction.js';
import type { ScriptTree } from './scripttree.js';
import { varIntSize } from './internal/bytes.js';
import { PolicyError } from './errors.js';
import type { FeeRate } from './amount.js';

/** pearld's default relay fee rate (mempool.DefaultMinRelayTxFee), in grain per 1000 vbytes. */
export const DEFAULT_RELAY_FEE_RATE: FeeRate = 1000n;
/** The largest transaction pearld relays, in vbytes. */
export const MAX_STANDARD_TX_VSIZE = 100_000;
/** pearld's default maximum transaction version (server.go). */
export const MAX_STANDARD_TX_VERSION = 2;
/** mempool.MinStandardTxNonWitnessSize, against CVE-2017-12842. */
export const MIN_STANDARD_TX_NON_WITNESS_SIZE = 65;
const MAX_STANDARD_SIG_SCRIPT_SIZE = 1650;
const MAX_SCRIPT_SIZE = 10_000;
/** blockchain.MaxBlockVsize. */
const MAX_BLOCK_VSIZE = 1_000_000;
const MIN_COINBASE_SCRIPT_LEN = 2;
const MAX_COINBASE_SCRIPT_LEN = 100;
const LOCK_TIME_THRESHOLD = 500_000_000;
const MAX_INT64 = (1n << 63n) - 1n;

/**
 * mempool.GetDustThreshold: three times the size of the output plus a typical input spending it.
 *
 * In grain, at the default relay fee of 1000 grain per 1000 vbytes: 333 for a
 * P2TR or P2MR output.
 */
export function dustThreshold(script: Uint8Array): bigint {
  const outputSize = 8 + varIntSize(script.length) + script.length;
  // 107 witness bytes count as CalcVsize(0, 107) = 27 vbytes.
  const inputSize = extractWitnessProgram(script) !== null ? 27 : 107;
  return 3n * BigInt(outputSize + 41 + inputSize);
}

/** mempool.IsDust, with relayFeeRate in grain per 1000 vbytes. */
export function isDust(output: { script: Uint8Array; value: bigint }, relayFeeRate: FeeRate = DEFAULT_RELAY_FEE_RATE): boolean {
  if (isUnspendable(output.script)) return true;
  if (output.value > MAX_GRAIN) return true;
  if (output.value > MAX_INT64 / 1000n) return false;
  return output.value * 1000n < dustThreshold(output.script) * relayFeeRate;
}

/**
 * calcMinRequiredTxRelayFee: the smallest fee pearld relays for a transaction of this vsize.
 *
 * Returns grain. relayFeeRate is in grain per 1000 vbytes,
 * DEFAULT_RELAY_FEE_RATE unless given.
 */
export function minRelayFee(vsize: number, relayFeeRate: FeeRate = DEFAULT_RELAY_FEE_RATE): bigint {
  const feeRate = relayFeeRate;
  const size = BigInt(vsize);
  if (feeRate > 0n && size > MAX_INT64 / feeRate) return MAX_GRAIN;
  let fee = (size * feeRate) / 1000n;
  if (fee === 0n && feeRate > 0n) fee = feeRate;
  if (fee < 0n || fee > MAX_GRAIN) fee = MAX_GRAIN;
  return fee;
}

/** The fee for a vsize at a rate in grain per 1000 vbytes, rounded up so it never falls under the rate. */
export function feeForVsize(vsize: number, feeRate: FeeRate): bigint {
  return (BigInt(vsize) * feeRate + 999n) / 1000n;
}

/** Context for checkStandard. Each field that is left out skips the checks that need it. */
export interface StandardOptions {
  /** The input values and scripts, in input order. Enables the input and relay fee checks. */
  prevouts?: readonly TxOutput[];
  /** Height of the next block. With medianTimePast, enables the finality check. */
  height?: number;
  /** Median time past of the chain tip, in Unix seconds. */
  medianTimePast?: number;
  /** pearld's --minrelaytxfee, in grain per 1000 vbytes. */
  relayFeeRate?: FeeRate;
  /**
   * Highest fee rate to accept, in grain per 1000 vbytes, as the maxfeerate of
   * testmempoolaccept. Needs prevouts. Not checked unless given.
   */
  maxFeeRate?: FeeRate;
  /** Highest transaction version to accept. MAX_STANDARD_TX_VERSION (2) unless given. */
  maxTxVersion?: number;
}

/**
 * Throws with pearld's reason if its mempool would refuse the transaction as
 * insane, non-standard, dust or under the relay fee, checking in pearld's
 * order. Signatures, sequence locks, coinbase maturity and mempool conflicts
 * are not checked.
 */
export function checkStandard(tx: Transaction, options: StandardOptions = {}): void {
  const feeRate = options.relayFeeRate ?? DEFAULT_RELAY_FEE_RATE;
  const maxVersion = options.maxTxVersion ?? MAX_STANDARD_TX_VERSION;

  if (!tx.hasWitnesses()) throw new PolicyError('POLICY_NO_WITNESS', 'transaction has no witness data');
  if (tx.byteLength(false) < MIN_STANDARD_TX_NON_WITNESS_SIZE) throw new PolicyError('POLICY_TX_TOO_SMALL', `tx ${tx.getId()} is too small`);

  checkSanity(tx);

  // CheckTransactionInputs runs before the standardness checks.
  const prevouts = options.prevouts;
  if (prevouts !== undefined) {
    if (prevouts.length !== tx.ins.length) throw new Error('prevouts must match the transaction inputs');
    checkInputValues(tx, prevouts);
  }

  // CheckTransactionStandard, in its order.
  if (tx.version > maxVersion || tx.version < 1) {
    throw new PolicyError('POLICY_VERSION', `transaction version ${tx.version} is not in the valid range of 1-${maxVersion}`);
  }
  if (options.height !== undefined && !isFinal(tx, options.height, options.medianTimePast ?? 0)) {
    throw new PolicyError('POLICY_NOT_FINAL', 'transaction is not finalized');
  }
  const vsize = tx.virtualSize();
  if (vsize > MAX_STANDARD_TX_VSIZE) {
    throw new PolicyError('POLICY_TX_TOO_LARGE', `vsize of transaction is larger than max allowed: ${vsize} > ${MAX_STANDARD_TX_VSIZE}`);
  }
  tx.ins.forEach((input, i) => {
    if (input.script.length > MAX_STANDARD_SIG_SCRIPT_SIZE) {
      throw new PolicyError('POLICY_SIGSCRIPT_SIZE',
        `transaction input ${i}: signature script size is larger than max allowed: ${input.script.length} > ${MAX_STANDARD_SIG_SCRIPT_SIZE} bytes`,
      );
    }
    if (!isPushOnlyScript(input.script)) throw new PolicyError('POLICY_SIGSCRIPT_NOT_PUSH_ONLY', `transaction input ${i}: signature script is not push only`);
  });
  let nullData = 0;
  tx.outs.forEach((output, i) => {
    if (classifyOutputScript(output.script) === 'nulldata') nullData += 1;
    else if (isDust(output, feeRate)) throw new PolicyError('POLICY_DUST', `transaction output ${i}: payment is dust: ${output.value}`);
  });
  if (nullData > 1) throw new PolicyError('POLICY_MULTIPLE_NULLDATA', 'more than one transaction output in a nulldata script');

  if (prevouts === undefined) return;
  // Unreachable on a real chain: sanity keeps every other script class out of the UTXO set.
  prevouts.forEach((prevout, i) => {
    if (classifyOutputScript(prevout.script) === 'nonstandard') {
      throw new PolicyError('POLICY_NONSTANDARD_INPUT', `transaction input #${i} has a non-standard script form`);
    }
  });
  const inputValue = prevouts.reduce((sum, prevout) => sum + prevout.value, 0n);
  const outputValue = tx.outs.reduce((sum, output) => sum + output.value, 0n);
  const fee = inputValue - outputValue;
  const required = minRelayFee(vsize, feeRate);
  if (fee < required) {
    throw new PolicyError('POLICY_FEE_TOO_LOW', `transaction ${tx.getId()} has ${fee} fees which is under the required amount of ${required}`);
  }
  // validateFeeRate in rpcserver.go: the rate is truncated, and equal passes.
  const rate = (fee * 1000n) / BigInt(vsize);
  if (options.maxFeeRate !== undefined && rate > options.maxFeeRate) {
    throw new PolicyError(
      'POLICY_FEE_TOO_HIGH',
      `max-fee-exceeded: the fee rate of ${rate} grain per 1000 vbytes is above the ${options.maxFeeRate} allowed`,
    );
  }
}

// Go prints btcutil.MaxGrain, an untyped float constant, this way.
const MAX_GRAIN_TEXT = '2.1e+18';

/**
 * blockchain.CheckTransactionSanity, the consensus checks pearld's mempool
 * runs before anything else, with its messages. checkStandard calls it.
 */
export function checkSanity(tx: Transaction): void {
  if (tx.ins.length === 0) throw new PolicyError('SANITY_NO_INPUTS', 'transaction has no inputs');
  if (tx.outs.length === 0) throw new PolicyError('SANITY_NO_OUTPUTS', 'transaction has no outputs');
  const vsize = tx.virtualSize();
  if (vsize > MAX_BLOCK_VSIZE) {
    throw new PolicyError('SANITY_TX_TOO_LARGE', `transaction vsize is too big - got ${vsize}, max ${MAX_BLOCK_VSIZE}`);
  }
  let total = 0n;
  tx.outs.forEach((output, i) => {
    // Pearl has no other output class; this is a consensus rule, not policy.
    if (classifyOutputScript(output.script) === 'nonstandard') {
      throw new PolicyError('SANITY_OUTPUT_SCRIPT', `transaction output ${i} has unsupported script type nonstandard`);
    }
    if (output.value < 0n) throw new PolicyError('SANITY_OUTPUT_NEGATIVE', `transaction output has negative value of ${output.value}`);
    if (output.value > MAX_GRAIN) {
      // The trailing space is pearld's.
      throw new PolicyError('SANITY_OUTPUT_TOO_LARGE',
        `transaction output value is higher than max allowed value: ${output.value} > ${MAX_GRAIN_TEXT} `,
      );
    }
    total += output.value;
    if (total > MAX_GRAIN) {
      throw new PolicyError('SANITY_TOTAL_TOO_LARGE',
        `total value of all transaction outputs is ${total} which is higher than max allowed value of ${MAX_GRAIN_TEXT}`,
      );
    }
  });
  const seen = new Set<string>();
  for (const input of tx.ins) {
    const outpoint = `${input.hash.join(',')}:${input.index}`;
    if (seen.has(outpoint)) throw new PolicyError('SANITY_DUPLICATE_INPUTS', 'transaction contains duplicate inputs');
    seen.add(outpoint);
  }
  const isNull = (input: { hash: Uint8Array; index: number }): boolean =>
    input.index === 0xffffffff && input.hash.every((byte) => byte === 0);
  if (tx.ins.length === 1 && isNull(tx.ins[0]!)) {
    const length = tx.ins[0]!.script.length;
    if (length < MIN_COINBASE_SCRIPT_LEN || length > MAX_COINBASE_SCRIPT_LEN) {
      throw new PolicyError('SANITY_COINBASE_SCRIPT',
        `coinbase transaction script length of ${length} is out of range (min: ${MIN_COINBASE_SCRIPT_LEN}, max: ${MAX_COINBASE_SCRIPT_LEN})`,
      );
    }
    throw new PolicyError('SANITY_COINBASE', `transaction is an individual coinbase ${tx.getId()}`);
  }
  if (tx.ins.some(isNull)) throw new PolicyError('SANITY_NULL_INPUT', 'transaction input refers to previous output that is null');
}

/**
 * The spend check of blockchain.CheckTransactionInputs. Its other checks
 * (existence, coinbase maturity, input value ranges) need the chain or cannot
 * fail for outputs that are in it.
 */
function checkInputValues(tx: Transaction, prevouts: readonly TxOutput[]): void {
  const inputValue = prevouts.reduce((sum, prevout) => sum + prevout.value, 0n);
  const outputValue = tx.outs.reduce((sum, output) => sum + output.value, 0n);
  if (inputValue < outputValue) {
    throw new PolicyError('SANITY_INPUTS_BELOW_OUTPUTS',
      `total value of all transaction inputs for transaction ${tx.getId()} is ${inputValue} which is less than the amount spent of ${outputValue}`,
    );
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
  | {
      type: 'keyPath';
      sighashType?: number;
      /** Length in bytes of the annex the witness will end with, its 0x50 tag included. None unless given. */
      annexLength?: number;
    }
  | {
      type: 'scriptPath';
      tree: ScriptTree;
      leafIndex: number;
      p2mr: boolean;
      sighashType?: number;
      /** Witness item sizes before the leaf script. Needed for leaves other than checksig, multi_a and XMSS. */
      stack?: readonly number[];
      /** Length in bytes of the annex the witness will end with, its 0x50 tag included. None unless given. */
      annexLength?: number;
    }
  | { type: 'witness'; items: readonly number[] };

/**
 * The vsize the transaction will have once each input carries the witness
 * described for it. Schnorr signatures have a fixed size, so the estimate is
 * exact for key paths, checksig, multi_a (with exactly the threshold signing)
 * and XMSS leaves.
 *
 * spends has one entry per input, in input order. Throws when the counts differ,
 * when a leaf index is out of range, for a leaf it cannot size without
 * `stack`, for an annexLength that is not a whole number of at least 1, and
 * with RangeError for an item size that is not a whole number of bytes.
 */
export function estimateVsize(tx: Transaction, spends: readonly SpendEstimate[]): number {
  if (spends.length !== tx.ins.length) throw new Error('spends must match the transaction inputs');
  const witnesses = spends.map(witnessSizes);
  for (const size of witnesses.flat()) {
    if (!Number.isSafeInteger(size) || size < 0) throw new RangeError(`a witness item size must be a whole number of bytes, not ${size}`);
  }
  // Weight is 4 per byte without witnesses, 1 per witness byte: the marker and flag, then each input's item count
  // and items with their lengths. No witness bytes at all when every input's witness is empty.
  const itemBytes = (items: readonly number[]): number => items.reduce((sum, size) => sum + varIntSize(size) + size, varIntSize(items.length));
  const witnessBytes = witnesses.some((items) => items.length > 0) ? witnesses.reduce((sum, items) => sum + itemBytes(items), 2) : 0;
  return Math.ceil((tx.byteLength(false) * 4 + witnessBytes) / 4);
}

function witnessSizes(spend: SpendEstimate): number[] {
  if (spend.type === 'witness') return [...spend.items];
  const annex = spend.annexLength;
  if (annex !== undefined && (!Number.isSafeInteger(annex) || annex < 1)) {
    throw new RangeError('annexLength must be a whole number of bytes, at least 1 for the 0x50 tag');
  }
  const last = annex === undefined ? [] : [annex];
  const signature = (spend.sighashType ?? Transaction.SIGHASH_DEFAULT) === Transaction.SIGHASH_DEFAULT ? 64 : 65;
  if (spend.type === 'keyPath') return [signature, ...last];
  const leaf = spend.tree.leaves[spend.leafIndex];
  if (leaf === undefined) throw new RangeError(`leaf index ${spend.leafIndex} is out of range`);
  const controlBlock = (spend.p2mr ? 1 : 33) + leaf.proof.length;
  return [...(spend.stack ?? leafStack(leaf.script, signature)), leaf.script.length, controlBlock, ...last];
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

