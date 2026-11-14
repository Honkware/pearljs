// Fee bumping under pearld's mempool rules (node/mempool/mempool.go and
// package_limits.go): replace-by-fee and child-pays-for-parent.
//
// pearld keeps btcd's opt-in RBF, not Bitcoin Core's full RBF: a conflict is
// only replaceable when it or one of its unconfirmed ancestors signals, and
// --rejectreplacement turns replacement off. The replacement's fee rate must
// beat every transaction it evicts, descendants included, and its fee must
// cover theirs plus its own relay fee. Rates are grain per 1000 vbytes,
// truncated the way pearld computes them.
//
// pearld builds block templates by each transaction's own fee rate and only
// considers a child once its parents are in (mining/mining.go), so a child
// does not raise its parent's priority in pearld's own templates. CPFP here
// is package arithmetic for miners that do ancestor scoring.

/**
 * Fee bumping under pearld's rules: replace-by-fee, child pays for parent, and
 * the package limits.
 *
 * @module
 */

import type { Transaction } from 'bitcoinjs-lib';
import { DEFAULT_MIN_RELAY_FEE, feeForVsize, minRelayFee } from './policy.js';
import { toHex } from './internal/bytes.js';

/** mempool.MaxRBFSequence: an input with a sequence at or below this signals replacement. */
export const MAX_RBF_SEQUENCE = 0xfffffffd;
/** mempool.MaxReplacementEvictions: conflicts and their descendants a replacement may evict. */
export const MAX_REPLACEMENT_EVICTIONS = 100;
/** mempool.DefaultAncestorCountLimit, counting the transaction itself. */
export const DEFAULT_ANCESTOR_COUNT_LIMIT = 25;
/** mempool.DefaultAncestorSizeLimit in vbytes, counting the transaction itself. */
export const DEFAULT_ANCESTOR_SIZE_LIMIT = 101_000;
/** mempool.DefaultDescendantCountLimit, counting the ancestor itself. */
export const DEFAULT_DESCENDANT_COUNT_LIMIT = 25;

/** A transaction in the mempool and the fee it pays, in grain. */
export interface MempoolTx {
  tx: Transaction;
  fee: bigint;
}

/** Unconfirmed transactions keyed by txid, in the order they were accepted. */
export type Mempool = ReadonlyMap<string, MempoolTx>;

/** A transaction's fee in grain and its size in vbytes. */
export interface FeeAndVsize {
  fee: bigint;
  vsize: number;
}

/** Options for checkReplacement. */
export interface ReplacementOptions {
  /** pearld's --minrelaytxfee, in grain per 1000 vbytes. */
  minRelayFee?: bigint;
  /** pearld's --rejectreplacement. */
  rejectReplacement?: boolean;
  /** The replacement's vsize, for a transaction not yet signed. */
  vsize?: number;
}

/** pearld's limits on chains of unconfirmed transactions. */
export interface PackageLimits {
  /** Most transactions in a transaction's unconfirmed ancestry, itself included. */
  ancestorCount: number;
  /** Most vbytes across a transaction and its unconfirmed ancestors. */
  ancestorSize: number;
  /** Most transactions among an ancestor and its descendants. */
  descendantCount: number;
}

/** Options for checkPackageLimits. */
export interface PackageLimitOptions {
  /** Txids the transaction replaces, as checkReplacement returns them. They do not count. */
  replaced?: Iterable<string>;
  /** Limits to use instead of the defaults. A limit of 0 is not enforced. */
  limits?: Partial<PackageLimits>;
  /** The transaction's vsize, for a transaction not yet signed. */
  vsize?: number;
}

const prevTxid = (input: Transaction['ins'][number]): string => toHex(Uint8Array.from(input.hash).reverse());

/** FeePerKB as pearld stores it: fee * 1000 / vsize, truncated. */
function feePerKb(fee: bigint, vsize: number): bigint {
  return (fee * 1000n) / BigInt(vsize);
}

interface MempoolIndex {
  /** "txid:vout" to the txid of the pool transaction spending it. */
  spentBy: Map<string, string>;
  /** Txid to the pool transactions spending its outputs, in acceptance order. */
  spenders: Map<string, string[]>;
}

function indexMempool(mempool: Mempool): MempoolIndex {
  const spentBy = new Map<string, string>();
  const spenders = new Map<string, string[]>();
  for (const [txid, { tx }] of mempool) {
    for (const input of tx.ins) {
      const parent = prevTxid(input);
      spentBy.set(`${parent}:${input.index}`, txid);
      if (!mempool.has(parent)) continue;
      const list = spenders.get(parent) ?? [];
      if (!list.includes(txid)) list.push(txid);
      spenders.set(parent, list);
    }
  }
  return { spentBy, spenders };
}

/**
 * Whether pearld treats the transaction as replaceable: an input with a
 * sequence at or below MAX_RBF_SEQUENCE, or, given the mempool, an
 * unconfirmed ancestor that signals.
 */
export function signalsReplacement(tx: Transaction, mempool?: Mempool): boolean {
  return signals(tx, mempool, new Map());
}

function signals(tx: Transaction, mempool: Mempool | undefined, cache: Map<string, boolean>): boolean {
  const txid = tx.getId();
  const cached = cache.get(txid);
  if (cached !== undefined) return cached;
  let result = false;
  for (const input of tx.ins) {
    if (input.sequence <= MAX_RBF_SEQUENCE) {
      result = true;
      break;
    }
    const parent = mempool?.get(prevTxid(input));
    if (parent !== undefined && signals(parent.tx, mempool, cache)) {
      result = true;
      break;
    }
  }
  cache.set(txid, result);
  return result;
}

/**
 * The smallest fee a replacement of this vsize can pay: above the fee rate of
 * every transaction it evicts, and at least their fees plus its own relay fee.
 * Pass every evicted transaction, the conflicts' descendants included.
 *
 * Returns grain. vsize is the replacement's size in vbytes and relayFee the
 * relay fee rate in grain per 1000 vbytes, DEFAULT_MIN_RELAY_FEE unless given.
 */
export function replacementFee(
  evicted: readonly FeeAndVsize[],
  vsize: number,
  relayFee: bigint = DEFAULT_MIN_RELAY_FEE,
): bigint {
  let fee = evicted.reduce((sum, entry) => sum + entry.fee, 0n) + minRelayFee(vsize, relayFee);
  for (const entry of evicted) {
    // The smallest fee whose truncated rate exceeds the evicted one.
    const rate = feePerKb(entry.fee, entry.vsize) + 1n;
    const needed = (rate * BigInt(vsize) + 999n) / 1000n;
    if (needed > fee) fee = needed;
  }
  return fee;
}

/**
 * Applies pearld's replacement rules (checkPoolDoubleSpend, then
 * validateReplacement) to a transaction paying fee against the mempool.
 * Returns the txids it would evict, empty when it spends nothing the
 * mempool spends, and throws with pearld's message when pearld would refuse
 * it. pearld runs the standardness and relay fee checks between the two
 * steps; checkStandard covers those.
 */
export function checkReplacement(
  tx: Transaction,
  fee: bigint,
  mempool: Mempool,
  options: ReplacementOptions = {},
): string[] {
  const txid = tx.getId();
  const { spentBy, spenders } = indexMempool(mempool);
  const checked = new Set<string>();
  const cache = new Map<string, boolean>();
  for (const input of tx.ins) {
    const outpoint = `${prevTxid(input)}:${input.index}`;
    const conflict = spentBy.get(outpoint);
    if (conflict === undefined || checked.has(conflict)) continue;
    checked.add(conflict);
    if (checked.size > MAX_REPLACEMENT_EVICTIONS) {
      throw new Error(
        `${txid}: replacement transaction evicts more transactions than permitted: max is ${MAX_REPLACEMENT_EVICTIONS}`,
      );
    }
    if (options.rejectReplacement === true || !signals(mempool.get(conflict)!.tx, mempool, cache)) {
      throw new Error(`output already spent in mempool: output=${outpoint}, tx=${conflict}`);
    }
  }
  if (checked.size === 0) return [];

  // txConflicts and txDescendants, which stop collecting past the limit.
  const conflicts = new Set<string>();
  const addDescendants = (parent: string): void => {
    for (const child of spenders.get(parent) ?? []) {
      if (conflicts.size > MAX_REPLACEMENT_EVICTIONS) break;
      if (conflicts.has(child)) continue;
      conflicts.add(child);
      addDescendants(child);
    }
  };
  for (const input of tx.ins) {
    if (conflicts.size > MAX_REPLACEMENT_EVICTIONS) break;
    const conflict = spentBy.get(`${prevTxid(input)}:${input.index}`);
    if (conflict === undefined || conflicts.has(conflict)) continue;
    conflicts.add(conflict);
    addDescendants(conflict);
  }
  if (conflicts.size > MAX_REPLACEMENT_EVICTIONS) {
    throw new Error(
      `${txid}: replacement transaction evicts more transactions than permitted: max is ${MAX_REPLACEMENT_EVICTIONS}, evicts ${conflicts.size}`,
    );
  }
  for (const input of tx.ins) {
    const parent = prevTxid(input);
    if (conflicts.has(parent)) throw new Error(`${txid}: replacement transaction spends parent transaction ${parent}`);
  }

  const vsize = options.vsize ?? tx.virtualSize();
  const rate = feePerKb(fee, vsize);
  let conflictsFee = 0n;
  const conflictsParents = new Set<string>();
  for (const conflict of conflicts) {
    const entry = mempool.get(conflict)!;
    const conflictRate = feePerKb(entry.fee, entry.tx.virtualSize());
    if (rate <= conflictRate) {
      throw new Error(
        `${txid}: replacement transaction has an insufficient fee rate: needs more than ${conflictRate}, has ${rate}`,
      );
    }
    conflictsFee += entry.fee;
    for (const input of entry.tx.ins) conflictsParents.add(prevTxid(input));
  }
  const needed = conflictsFee + minRelayFee(vsize, options.minRelayFee ?? DEFAULT_MIN_RELAY_FEE);
  if (fee < needed) {
    throw new Error(`${txid}: replacement transaction has an insufficient absolute fee: needs ${needed}, has ${fee}`);
  }
  for (const input of tx.ins) {
    const parent = prevTxid(input);
    if (conflictsParents.has(parent) || !mempool.has(parent)) continue;
    throw new Error(
      `replacement transaction spends new unconfirmed input ${parent}:${input.index} not found in conflicting transactions`,
    );
  }
  return [...conflicts];
}

/**
 * Throws with pearld's too-long-mempool-chain message when admitting the
 * transaction would exceed the package limits: its unconfirmed ancestors by
 * count and vsize, and each ancestor's descendants by count.
 */
export function checkPackageLimits(tx: Transaction, mempool: Mempool, options: PackageLimitOptions = {}): void {
  const ancestorCount = options.limits?.ancestorCount ?? DEFAULT_ANCESTOR_COUNT_LIMIT;
  const ancestorSize = options.limits?.ancestorSize ?? DEFAULT_ANCESTOR_SIZE_LIMIT;
  const descendantCount = options.limits?.descendantCount ?? DEFAULT_DESCENDANT_COUNT_LIMIT;
  if (ancestorCount <= 0 && ancestorSize <= 0 && descendantCount <= 0) return;
  const replaced = new Set(options.replaced ?? []);
  const { spenders } = indexMempool(mempool);
  const tooLong = (reason: string): Error => new Error(`too-long-mempool-chain: ${reason}`);

  const ancestors = new Set<string>();
  const enqueued = new Set<string>();
  const queue: string[] = [];
  for (const input of tx.ins) {
    const parent = prevTxid(input);
    if (!mempool.has(parent) || enqueued.has(parent)) continue;
    enqueued.add(parent);
    queue.push(parent);
  }
  if (ancestorCount > 0 && queue.length + 1 > ancestorCount) {
    throw tooLong(`too many unconfirmed parents, ${queue.length} [limit: ${ancestorCount}]`);
  }

  let packageSize = options.vsize ?? tx.virtualSize();
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (ancestors.has(current)) continue;
    ancestors.add(current);
    if (ancestorCount > 0 && ancestors.size + 1 > ancestorCount) {
      throw tooLong(`too many unconfirmed ancestors, ${ancestors.size} [limit: ${ancestorCount}]`);
    }
    const entry = mempool.get(current)!;
    if (ancestorSize > 0) {
      packageSize += entry.tx.virtualSize();
      if (packageSize > ancestorSize) {
        throw tooLong(`exceeds ancestor size limit, ${packageSize} vbytes [limit: ${ancestorSize}]`);
      }
    }
    checkDescendantCount(current, descendantCount, spenders, replaced, tooLong);
    for (const input of entry.tx.ins) {
      const parent = prevTxid(input);
      if (!mempool.has(parent) || ancestors.has(parent) || enqueued.has(parent)) continue;
      enqueued.add(parent);
      queue.push(parent);
      if (ancestorCount > 0 && ancestors.size + queue.length + 1 > ancestorCount) {
        throw tooLong(`too many unconfirmed ancestors, ${ancestors.size + queue.length} [limit: ${ancestorCount}]`);
      }
    }
  }
}

function checkDescendantCount(
  ancestor: string,
  limit: number,
  spenders: Map<string, string[]>,
  replaced: Set<string>,
  tooLong: (reason: string) => Error,
): void {
  if (limit <= 0) return;
  const error = (): Error => tooLong(`too many descendants for tx ${ancestor} [limit: ${limit}]`);
  if (limit < 2) throw error();
  const descendants = new Set<string>();
  const queue = [ancestor];
  while (queue.length > 0) {
    for (const child of spenders.get(queue.shift()!) ?? []) {
      if (replaced.has(child) || descendants.has(child)) continue;
      descendants.add(child);
      queue.push(child);
      // The ancestor, its descendants and the new transaction.
      if (1 + descendants.size + 1 > limit) throw error();
    }
  }
}

/** Fee rate of a set of transactions together, in grain per 1000 vbytes, truncated. */
export function packageFeeRate(entries: readonly FeeAndVsize[]): bigint {
  const vsize = entries.reduce((sum, entry) => sum + entry.vsize, 0);
  if (vsize <= 0) throw new RangeError('a package needs a positive vsize');
  return feePerKb(
    entries.reduce((sum, entry) => sum + entry.fee, 0n),
    vsize,
  );
}

/**
 * The fee a child of childVsize must pay so it and its unconfirmed parents
 * reach feeRate (grain per 1000 vbytes) together. Never less than the
 * child's own relay fee, since pearld admits each transaction on its own.
 */
export function cpfpChildFee(
  parents: readonly FeeAndVsize[],
  childVsize: number,
  feeRate: bigint,
  relayFee: bigint = DEFAULT_MIN_RELAY_FEE,
): bigint {
  const parentsFee = parents.reduce((sum, entry) => sum + entry.fee, 0n);
  const parentsVsize = parents.reduce((sum, entry) => sum + entry.vsize, 0);
  const needed = feeForVsize(parentsVsize + childVsize, feeRate) - parentsFee;
  const own = minRelayFee(childVsize, relayFee);
  return needed > own ? needed : own;
}
