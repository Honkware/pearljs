/**
 * Watch-only invoice monitoring on top of a {@link ChainClient} view.
 *
 * An invoice requests an exact bigint amount at a unique address before
 * an expiry time. State is recomputed synchronously from the persisted
 * Invoice record plus the current chain view on every refresh: there are
 * no subscriptions, no event handlers, and no database abstractions.
 * Callers persist the returned Invoice themselves.
 *
 * Semantics:
 * - Payments to the invoice address are summed; entries sharing a txid
 *   are the same payment and count once. Overpayment is accepted.
 * - A payment counts toward the amount iff it was first seen strictly
 *   before expiresAt. A mempool payment first seen at or after expiry
 *   does not count, but a payment first seen before expiry stays valid
 *   even when it confirms after expiry.
 * - Underpaid invoices stay "awaiting" before expiry and become
 *   "expired" at or after expiry.
 * - "pending" means fully paid with zero confirmations, "confirming"
 *   means 1..requiredConfirmations-1, "confirmed" means at least
 *   requiredConfirmations. Confirmations are recomputed from the current
 *   tip on every refresh, so a reorg below requiredConfirmations
 *   regresses a confirmed invoice, and a payment that moves blocks gets
 *   its confirmations recalculated.
 * - A payment observed before expiry that later vanishes from the chain
 *   view marks the invoice "conflicted". Conflicted wins over every other
 *   state: a conflicted invoice never stays confirmed. Late payments that
 *   never counted toward the invoice do not cause a conflict.
 */

import { decodeAddress } from './address.js';
import { MAX_GRAIN } from './amount.js';
import type { BlockRef, ChainClient } from './client.js';
import type { PearlNetwork } from './networks.js';

/** Lifecycle states of a watch-only invoice. */
export type InvoiceState =
  | 'awaiting'
  | 'pending'
  | 'confirming'
  | 'confirmed'
  | 'expired'
  | 'conflicted';

/** A payment txid the invoice has observed, with when it was first seen. */
export interface ObservedPayment {
  readonly txid: string;
  /** Epoch seconds at which this payment was first observed. */
  readonly firstSeenAt: number;
}

/** Configuration required to create an invoice. */
export interface CreateInvoiceConfig {
  readonly id: string;
  readonly address: string;
  /** Requested amount in the smallest indivisible unit. */
  readonly amount: bigint;
  /** Creation time, epoch seconds. */
  readonly createdAt: number;
  /** Expiry time, epoch seconds; must be after createdAt. */
  readonly expiresAt: number;
  /** Confirmations required for "confirmed"; a positive integer. */
  readonly requiredConfirmations: number;
}

/**
 * The persistable invoice record. Callers store this between refreshes;
 * refreshInvoice derives a new record rather than mutating it.
 */
export interface Invoice extends CreateInvoiceConfig {
  /** Payment txids observed so far, with first-seen timestamps. */
  readonly observedPayments: readonly ObservedPayment[];
  /** Sum of payments that count toward the invoice. */
  readonly paidAmount: bigint;
  /** Confirmations of the least-confirmed counted payment; 0 if none. */
  readonly confirmations: number;
  readonly state: InvoiceState;
}

function assertValidConfig(config: CreateInvoiceConfig, network: PearlNetwork): void {
  if (typeof config.id !== 'string' || config.id.length === 0) {
    throw new Error('invoice id must be a non-empty string');
  }
  if (typeof config.address !== 'string' || config.address.length === 0) {
    throw new Error('invoice address must be a non-empty string');
  }
  if (network === null || typeof network !== 'object' || typeof network.bech32Hrp !== 'string') {
    throw new TypeError('createInvoice needs the PearlNetwork the invoice address belongs to');
  }
  try {
    decodeAddress(config.address, network);
  } catch (error) {
    throw new Error(`invoice address is not valid on ${network.name}: ${(error as Error).message}`);
  }
  if (typeof config.amount !== 'bigint' || config.amount <= 0n) {
    throw new Error('invoice amount must be a positive bigint');
  }
  if (config.amount > MAX_GRAIN) {
    throw new Error('invoice amount is above the largest Pearl amount');
  }
  if (!Number.isSafeInteger(config.createdAt) || config.createdAt < 0) {
    throw new Error('invoice createdAt must be a non-negative integer of epoch seconds');
  }
  if (!Number.isSafeInteger(config.expiresAt) || config.expiresAt <= config.createdAt) {
    throw new Error('invoice expiresAt must be an integer of epoch seconds after createdAt');
  }
  if (!Number.isSafeInteger(config.requiredConfirmations) || config.requiredConfirmations < 1) {
    throw new Error('invoice requiredConfirmations must be a positive integer');
  }
}

/**
 * Create a new invoice in the "awaiting" state. Throws on invalid config,
 * which includes an address that is not a Pearl address on network and an
 * amount above MAX_GRAIN.
 */
export function createInvoice(config: CreateInvoiceConfig, network: PearlNetwork): Invoice {
  assertValidConfig(config, network);
  return { ...config, observedPayments: [], paidAmount: 0n, confirmations: 0, state: 'awaiting' };
}

// A height that is missing or not a number must never count as confirmed:
// every comparison with NaN is false, so it has to be refused outright.
function blockHeight(block: BlockRef, what: string): number {
  const height = (block as BlockRef | null | undefined)?.height;
  if (!Number.isSafeInteger(height) || height! < 0) {
    throw new Error(`chain backend returned ${what} without a valid height`);
  }
  return height!;
}

/**
 * Recompute an invoice from its persisted record and the current chain
 * view. Pure with respect to the invoice: the input is not mutated and a
 * new record is returned. `now` is epoch seconds and defaults to the
 * current time; inject it for deterministic evaluation.
 *
 * What the chain backend returns is checked, not trusted: a tip or block
 * without an integer height, or a payment whose amount is not a bigint from
 * 0 to MAX_GRAIN, throws instead of producing a state.
 */
export async function refreshInvoice(
  invoice: Invoice,
  client: ChainClient,
  now: number = Math.floor(Date.now() / 1000),
): Promise<Invoice> {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new Error('now must be a non-negative integer of epoch seconds');
  }
  const [tip, activity] = await Promise.all([
    client.getTip(),
    client.getAddressActivity(invoice.address),
  ]);

  const tipHeight = blockHeight(tip, 'a tip');

  // Entries sharing a txid are the same payment reported more than once.
  const current = new Map<
    string,
    { amount: bigint; blockHeight: number | null; blockHash: string | null }
  >();
  for (const payment of activity) {
    if (typeof payment.txid !== 'string' || payment.txid.length === 0) {
      throw new Error('chain backend returned a payment without a txid');
    }
    if (typeof payment.amount !== 'bigint' || payment.amount < 0n || payment.amount > MAX_GRAIN) {
      throw new Error(`chain backend returned an invalid amount for ${payment.txid}`);
    }
    if (payment.block === undefined) {
      throw new Error(`chain backend returned no block field for ${payment.txid}; unconfirmed is null`);
    }
    const height = payment.block === null ? null : blockHeight(payment.block, `a block for ${payment.txid}`);
    const blockHash = payment.block === null ? null : payment.block.hash;
    const previous = current.get(payment.txid);
    if (previous !== undefined) {
      if (
        previous.amount !== payment.amount ||
        previous.blockHeight !== height ||
        previous.blockHash !== blockHash
      ) {
        throw new Error(`chain backend returned conflicting entries for ${payment.txid}`);
      }
      continue;
    }
    current.set(payment.txid, { amount: payment.amount, blockHeight: height, blockHash });
  }

  // Merge with persisted observations, stamping new txids as first seen now.
  const firstSeen = new Map<string, number>(
    invoice.observedPayments.map((p) => [p.txid, p.firstSeenAt]),
  );
  for (const txid of current.keys()) {
    if (!firstSeen.has(txid)) firstSeen.set(txid, now);
  }
  const observedPayments: ObservedPayment[] = [...firstSeen.entries()].map(
    ([txid, at]) => ({ txid, firstSeenAt: at }),
  );

  // A previously observed payment the chain view no longer knows is a conflict.
  const vanished = await Promise.all(
    [...firstSeen.keys()]
      .filter(
        (txid) =>
          !current.has(txid) && (firstSeen.get(txid) ?? now) < invoice.expiresAt,
      )
      .map(async (txid) => (await client.getTransaction(txid)) === null),
  );
  const conflicted = vanished.some((gone) => gone);

  // Only payments first seen strictly before expiry count toward the amount.
  const counted = [...current.entries()].filter(
    ([txid]) => (firstSeen.get(txid) ?? now) < invoice.expiresAt,
  );
  let paidAmount = 0n;
  let confirmations = 0;
  if (counted.length > 0) {
    confirmations = Number.MAX_SAFE_INTEGER;
    for (const [, payment] of counted) {
      paidAmount += payment.amount;
      const c =
        payment.blockHeight === null ? 0 : Math.max(0, tipHeight - payment.blockHeight + 1);
      if (c < confirmations) confirmations = c;
    }
  }

  let state: InvoiceState;
  if (conflicted) {
    state = 'conflicted';
  } else if (paidAmount >= invoice.amount) {
    if (confirmations >= invoice.requiredConfirmations) state = 'confirmed';
    else if (confirmations === 0) state = 'pending';
    else state = 'confirming';
  } else {
    state = now >= invoice.expiresAt ? 'expired' : 'awaiting';
  }

  return { ...invoice, observedPayments, paidAmount, confirmations, state };
}

/**
 * Convenience wrapper binding a ChainClient so callers can create and
 * refresh invoices without threading the client through every call.
 * Holds no invoice state itself.
 */
export class InvoiceMonitor {
  readonly #client: ChainClient;
  readonly #network: PearlNetwork;

  /** network is the one invoice addresses must belong to. */
  constructor(client: ChainClient, network: PearlNetwork) {
    this.#client = client;
    this.#network = network;
  }

  createInvoice(config: CreateInvoiceConfig): Invoice {
    return createInvoice(config, this.#network);
  }

  refreshInvoice(invoice: Invoice, now?: number): Promise<Invoice> {
    return refreshInvoice(invoice, this.#client, now);
  }
}
