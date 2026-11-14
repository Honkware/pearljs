// What a wallet holds, worked out from scratch from the transactions it has
// recorded: which outputs are its own, which of those are spent, and what
// each transaction did to the balance. Nothing here is stored; the stored
// state is the transactions, and every balance and coin list is derived
// from them, so the two cannot drift apart.
//
// A transaction is active unless it was conflicted, replaced, abandoned or
// orphaned by a reorg; a transaction spending an output of one that is not
// active is not active either, as wtxmgr's removeConflict removes whole
// spend chains (wallet/wtxmgr/unconfirmed.go:117).

/**
 * The derived view of a wallet: its coins, balance and history, from its
 * recorded transactions.
 *
 * @module
 */

import type { WalletBalance } from './backend.js';
import type { BlockRef } from './client.js';
import { confirmationsFromHeight } from './coinselect.js';
import type { Utxo } from './coinselect.js';
import { toHex } from './internal/bytes.js';
import type { Transaction } from './transaction.js';

/** Who in the wallet an output belongs to. */
export type CoinOwner =
  | { type: 'account'; account: string; change: boolean; index: number }
  | { type: 'imported'; id: string }
  | { type: 'xmss'; id: string };

/** Where a recorded transaction stands. `pending` and `confirmed` are active; the rest no longer count. */
export type TransactionStatus = 'pending' | 'confirmed' | 'conflicted' | 'replaced' | 'abandoned' | 'orphaned';

/** A transaction as the wallet records it. */
export interface LedgerTransaction {
  txid: string;
  tx: Transaction;
  block: BlockRef | null;
  /** The recorded status; `active` means pending or confirmed by its block. */
  status: 'active' | 'conflicted' | 'replaced' | 'abandoned' | 'orphaned';
  /** Script and value of each spent output, or null where the wallet could not learn it. */
  prevouts: ({ script: Uint8Array; value: bigint } | null)[];
  seenAt: number;
  /** The transaction that replaced or conflicted this one. */
  by?: string;
  label?: string;
}

/** An unspent output of the wallet. */
export interface WalletCoin extends Utxo {
  address: string;
  owner: CoinOwner;
  confirmations: number;
  coinbase: boolean;
  /** Height of its block, or null while unconfirmed. */
  height: number | null;
  locked: boolean;
}

/** The wallet's balance in grain. The four parts do not overlap and add up to every unspent output. */
export interface WalletStateBalance extends WalletBalance {
  /** Outputs locked with lockOutpoint, whatever their confirmations. */
  locked: bigint;
  /** confirmed + unconfirmed + immature + locked. */
  total: bigint;
}

/** One transaction as history shows it. Amounts in grain. */
export interface HistoryEntry {
  txid: string;
  status: TransactionStatus;
  block: BlockRef | null;
  confirmations: number;
  /** incoming when nothing of the wallet's was spent, self when every output is the wallet's own. */
  direction: 'incoming' | 'outgoing' | 'self';
  /** What the transaction paid the wallet. */
  received: bigint;
  /** What it spent of the wallet's outputs. */
  sent: bigint;
  /** received - sent: negative for a payment out. */
  amount: bigint;
  /** Inputs minus outputs, or null when an input's value is unknown (some incoming payments). */
  fee: bigint | null;
  /** The other side: addresses paid for an outgoing transaction, addresses paying for an incoming one, where known. */
  counterparties: string[];
  coinbase: boolean;
  /** Milliseconds since the epoch when the wallet first saw it. */
  seenAt: number;
  label?: string;
  /** The transaction that replaced or conflicted this one. */
  by?: string;
}

/** What the ledger needs to know about the wallet's addresses. */
export interface LedgerOwnership {
  owner(script: Uint8Array): { owner: CoinOwner; address: string } | undefined;
  /** An address for any output script, or null for one with no address (OP_RETURN). */
  address(script: Uint8Array): string | null;
}

/** The derived state. */
export interface Ledger {
  /** Each transaction's status after spend chains of inactive transactions are followed. */
  status: Map<string, TransactionStatus>;
  /** Unspent outputs, locked ones included. */
  coins: WalletCoin[];
  balance: WalletStateBalance;
  /** "txid:vout" of every output of the wallet an active transaction spends, to the spending txid. */
  spentBy: Map<string, string>;
}

export const outpointKey = (txid: string, vout: number): string => `${txid}:${vout}`;

export function prevTxid(input: Transaction['ins'][number]): string {
  return toHex(Uint8Array.from(input.hash).reverse());
}

/** Statuses with inactive spend chains followed to a fixed point. */
export function effectiveStatus(txs: ReadonlyMap<string, LedgerTransaction>): Map<string, TransactionStatus> {
  const status = new Map<string, TransactionStatus>();
  for (const [txid, entry] of txs) {
    status.set(txid, entry.status === 'active' ? (entry.block === null ? 'pending' : 'confirmed') : entry.status);
  }
  for (let changed = true; changed; ) {
    changed = false;
    for (const [txid, entry] of txs) {
      if (status.get(txid) !== 'pending') continue;
      const dead = entry.tx.ins.some((input) => {
        const parent = status.get(prevTxid(input));
        return parent !== undefined && parent !== 'pending' && parent !== 'confirmed';
      });
      if (dead) {
        status.set(txid, 'conflicted');
        changed = true;
      }
    }
  }
  return status;
}

const active = (status: TransactionStatus | undefined): boolean => status === 'pending' || status === 'confirmed';

/**
 * Works out the coins and balance. externalSpends are outputs the backend
 * reports spent by a transaction the wallet could not fetch; locks map an
 * outpoint to its expiry in milliseconds, or null for none.
 */
export function computeLedger(
  txs: ReadonlyMap<string, LedgerTransaction>,
  ownership: LedgerOwnership,
  context: {
    tipHeight: number;
    coinbaseMaturity: number;
    externalSpends: ReadonlySet<string>;
    locks: ReadonlyMap<string, number | null>;
    now: number;
  },
): Ledger {
  const status = effectiveStatus(txs);
  const spentBy = new Map<string, string>();
  for (const [txid, entry] of txs) {
    if (!active(status.get(txid))) continue;
    for (const input of entry.tx.ins) spentBy.set(outpointKey(prevTxid(input), input.index), txid);
  }
  const coins: WalletCoin[] = [];
  const balance: WalletStateBalance = { confirmed: 0n, unconfirmed: 0n, immature: 0n, locked: 0n, total: 0n };
  for (const [txid, entry] of txs) {
    if (!active(status.get(txid))) continue;
    const coinbase = entry.tx.isCoinbase();
    const confirmations = confirmationsFromHeight(entry.block?.height, context.tipHeight);
    entry.tx.outs.forEach((output, vout) => {
      const key = outpointKey(txid, vout);
      if (spentBy.has(key) || context.externalSpends.has(key)) return;
      const script = Uint8Array.from(output.script);
      const owned = ownership.owner(script);
      if (owned === undefined) return;
      const until = context.locks.get(key);
      const locked = until !== undefined && (until === null || until > context.now);
      const value = output.value;
      coins.push({
        txid,
        vout,
        value,
        script,
        address: owned.address,
        owner: owned.owner,
        confirmations,
        coinbase,
        height: entry.block?.height ?? null,
        locked,
      });
      if (locked) balance.locked += value;
      else if (coinbase && confirmations < context.coinbaseMaturity) balance.immature += value;
      else if (confirmations >= 1) balance.confirmed += value;
      else balance.unconfirmed += value;
      balance.total += value;
    });
  }
  coins.sort((a, b) => (a.txid === b.txid ? a.vout - b.vout : a.txid < b.txid ? -1 : 1));
  return { status, coins, balance, spentBy };
}

/** The history of every recorded transaction, newest first: pending ones, then by height. */
export function computeHistory(
  txs: ReadonlyMap<string, LedgerTransaction>,
  status: ReadonlyMap<string, TransactionStatus>,
  ownership: LedgerOwnership,
  tipHeight: number,
): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  for (const [txid, entry] of txs) {
    let received = 0n;
    let sent = 0n;
    let outputsOurs = true;
    const paid: string[] = [];
    let outTotal = 0n;
    for (const output of entry.tx.outs) {
      const script = Uint8Array.from(output.script);
      outTotal += output.value;
      if (ownership.owner(script) !== undefined) {
        received += output.value;
      } else {
        outputsOurs = false;
        const address = ownership.address(script);
        if (address !== null && !paid.includes(address)) paid.push(address);
      }
    }
    let inTotal = 0n;
    let known = !entry.tx.isCoinbase();
    const payers: string[] = [];
    for (const prevout of entry.prevouts) {
      if (prevout === null) {
        known = false;
        continue;
      }
      inTotal += prevout.value;
      if (ownership.owner(prevout.script) !== undefined) {
        sent += prevout.value;
      } else {
        const address = ownership.address(prevout.script);
        if (address !== null && !payers.includes(address)) payers.push(address);
      }
    }
    if (entry.prevouts.length !== entry.tx.ins.length) known = false;
    const direction = sent === 0n ? 'incoming' : outputsOurs ? 'self' : 'outgoing';
    const confirmations = confirmationsFromHeight(entry.block?.height, tipHeight);
    entries.push({
      txid,
      status: status.get(txid) ?? 'pending',
      block: entry.block,
      confirmations,
      direction,
      received,
      sent,
      amount: received - sent,
      fee: known ? inTotal - outTotal : null,
      counterparties: direction === 'incoming' ? payers : direction === 'outgoing' ? paid : [],
      coinbase: entry.tx.isCoinbase(),
      seenAt: entry.seenAt,
      ...(entry.label === undefined ? {} : { label: entry.label }),
      ...(entry.by === undefined ? {} : { by: entry.by }),
    });
  }
  const rank = (entry: HistoryEntry): number => (entry.block === null ? Number.MAX_SAFE_INTEGER : entry.block.height);
  return entries.sort((a, b) => rank(b) - rank(a) || b.seenAt - a.seenAt || (a.txid < b.txid ? -1 : 1));
}
