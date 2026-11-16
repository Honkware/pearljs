/**
 * Watch-only invoices on top of a {@link ChainClient} view.
 *
 * An invoice requests an exact bigint amount at a unique address before
 * an expiry time. Each refresh derives a new record from the stored one and
 * the chain as it is now; callers persist the record themselves.
 *
 * Semantics:
 * - Every transaction paying the address is kept in `payments` with its
 *   amount, block and whether it counted, late ones included. Entries
 *   sharing a txid are one payment.
 * - A payment is on time when there is evidence it existed before
 *   expiresAt: a block it was confirmed in has a header time before
 *   expiresAt, or it was first seen (by this invoice, or by the backend when
 *   it reports seenAt) before expiresAt. The evidence is kept, so a reorg
 *   that moves an on-time payment into a later block, or back to the
 *   mempool, does not make it late.
 * - An on-time payment counts toward `paidAmount` while the chain view
 *   lists it. Late payments add to `uncountedAmount` instead.
 * - Confirmations are those of the least confirmed counted payment,
 *   recomputed from the current tip on every refresh, so a reorg below
 *   requiredConfirmations regresses a confirmed invoice.
 * - The state follows from the counted amount, those confirmations, the
 *   clock and any conflict; see InvoiceState.
 * - An on-time payment that the chain view no longer knows at all marks
 *   the invoice "conflicted", which wins over every other state.
 *
 * @module
 */

import { decodeAddress } from './address.js';
import { MAX_GRAIN } from './amount.js';
import type { AddressPayment, BlockRef, ChainClient } from './client.js';
import type { PearlNetwork } from './networks.js';
import { PearlError } from './errors.js';

/**
 * Lifecycle states of a watch-only invoice. Before expiry: "awaiting"
 * (nothing counted) and "underpaid" (some). Paid in full: "pending" (a
 * counted payment unconfirmed), "confirming", then "confirmed" for the
 * exact amount or "overpaid" for more. Not paid in full by expiry:
 * "expired" (nothing counted) or "expired-underpaid". "conflicted" wins
 * over all of them.
 */
export type InvoiceState =
  | 'awaiting'
  | 'underpaid'
  | 'pending'
  | 'confirming'
  | 'confirmed'
  | 'overpaid'
  | 'expired'
  | 'expired-underpaid'
  | 'conflicted';

/**
 * Where a payment stands in the chain view: in the mempool, in a block, no
 * longer listed for the address although the transaction is still known,
 * or unknown to the chain view altogether.
 */
export type InvoicePaymentStatus = 'unconfirmed' | 'confirmed' | 'unlisted' | 'vanished';

/** A transaction that paid the invoice address, counted or not. */
export interface InvoicePayment {
  readonly txid: string;
  /** Total paid to the invoice address by this transaction, in grain. */
  readonly amount: bigint;
  readonly status: InvoicePaymentStatus;
  /** The block it is in now; null unless status is "confirmed". */
  readonly block: BlockRef | null;
  /** Confirmations now; 0 unless status is "confirmed". */
  readonly confirmations: number;
  /** Epoch seconds when it was first seen, by this invoice or by the backend. */
  readonly firstSeenAt: number;
  /** The earliest header time of a block it has been seen in, or null. */
  readonly firstBlockTime: number | null;
  /** Whether there is evidence it existed before expiresAt. Never turns back to false. */
  readonly onTime: boolean;
  /** Whether it counts toward paidAmount: on time, and listed for the address now. */
  readonly counted: boolean;
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
  /** Every payment seen at the address, in the order first seen. */
  readonly payments: readonly InvoicePayment[];
  /** Sum of the payments that count. */
  readonly paidAmount: bigint;
  /** Sum of the late payments the chain view still lists. */
  readonly uncountedAmount: bigint;
  /** Confirmations of the least-confirmed counted payment; 0 if none. */
  readonly confirmations: number;
  readonly state: InvoiceState;
}

function assertValidConfig(config: CreateInvoiceConfig, network: PearlNetwork): void {
  if (typeof config.id !== 'string' || config.id.length === 0) {
    throw new PearlError('INVOICE_INVALID', 'invoice id must be a non-empty string');
  }
  if (typeof config.address !== 'string' || config.address.length === 0) {
    throw new PearlError('INVOICE_INVALID', 'invoice address must be a non-empty string');
  }
  if (network === null || typeof network !== 'object' || typeof network.bech32Hrp !== 'string') {
    throw new TypeError('createInvoice needs the PearlNetwork the invoice address belongs to');
  }
  try {
    decodeAddress(config.address, network);
  } catch (error) {
    throw new PearlError('INVOICE_INVALID', `invoice address is not valid on ${network.name}: ${(error as Error).message}`);
  }
  if (typeof config.amount !== 'bigint' || config.amount <= 0n) {
    throw new PearlError('INVOICE_INVALID', 'invoice amount must be a positive bigint');
  }
  if (config.amount > MAX_GRAIN) {
    throw new PearlError('INVOICE_INVALID', 'invoice amount is above the largest Pearl amount');
  }
  if (!Number.isSafeInteger(config.createdAt) || config.createdAt < 0) {
    throw new PearlError('INVOICE_INVALID', 'invoice createdAt must be a non-negative integer of epoch seconds');
  }
  if (!Number.isSafeInteger(config.expiresAt) || config.expiresAt <= config.createdAt) {
    throw new PearlError('INVOICE_INVALID', 'invoice expiresAt must be an integer of epoch seconds after createdAt');
  }
  if (!Number.isSafeInteger(config.requiredConfirmations) || config.requiredConfirmations < 1) {
    throw new PearlError('INVOICE_INVALID', 'invoice requiredConfirmations must be a positive integer');
  }
}

/**
 * Create a new invoice in the "awaiting" state. Throws on invalid config,
 * which includes an address that is not a Pearl address on network and an
 * amount above MAX_GRAIN.
 */
export function createInvoice(config: CreateInvoiceConfig, network: PearlNetwork): Invoice {
  assertValidConfig(config, network);
  return { ...config, payments: [], paidAmount: 0n, uncountedAmount: 0n, confirmations: 0, state: 'awaiting' };
}

// A height that is missing or not a number must never count as confirmed:
// every comparison with NaN is false, so it has to be refused outright.
function blockHeight(block: BlockRef, what: string): number {
  const height = (block as BlockRef | null | undefined)?.height;
  if (!Number.isSafeInteger(height) || height! < 0) {
    throw new PearlError('BACKEND_RESPONSE', `chain backend returned ${what} without a valid height`);
  }
  return height!;
}

function optionalTime(value: unknown, what: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new PearlError('BACKEND_RESPONSE', `chain backend returned ${what} that is not epoch seconds`);
  }
  return value as number;
}

function assertNow(now: number): void {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new Error('now must be a non-negative integer of epoch seconds');
  }
}

interface Listed {
  amount: bigint;
  block: BlockRef | null;
  seenAt: number | undefined;
}

// Checks what the backend returned and folds duplicate reports of a txid.
function listedPayments(activity: readonly AddressPayment[]): Map<string, Listed> {
  const listed = new Map<string, Listed>();
  for (const payment of activity) {
    if (typeof payment.txid !== 'string' || payment.txid.length === 0) {
      throw new PearlError('BACKEND_RESPONSE', 'chain backend returned a payment without a txid');
    }
    if (typeof payment.amount !== 'bigint' || payment.amount < 0n || payment.amount > MAX_GRAIN) {
      throw new PearlError('BACKEND_RESPONSE', `chain backend returned an invalid amount for ${payment.txid}`);
    }
    if (payment.block === undefined) {
      throw new PearlError('BACKEND_RESPONSE', `chain backend returned no block field for ${payment.txid}; unconfirmed is null`);
    }
    let block: BlockRef | null = null;
    if (payment.block !== null) {
      const height = blockHeight(payment.block, `a block for ${payment.txid}`);
      const time = optionalTime(payment.block.time, `a block time for ${payment.txid}`);
      block = time === undefined ? { height, hash: payment.block.hash } : { height, hash: payment.block.hash, time };
    }
    const seenAt = optionalTime(payment.seenAt, `a seenAt for ${payment.txid}`);
    const previous = listed.get(payment.txid);
    if (previous !== undefined) {
      if (
        previous.amount !== payment.amount ||
        previous.block?.height !== block?.height ||
        previous.block?.hash !== block?.hash ||
        previous.block?.time !== block?.time
      ) {
        throw new PearlError('BACKEND_RESPONSE', `chain backend returned conflicting entries for ${payment.txid}`);
      }
      continue;
    }
    listed.set(payment.txid, { amount: payment.amount, block, seenAt });
  }
  return listed;
}

/** What one refresh read from the chain for one invoice. */
interface ChainView {
  tipHeight: number;
  listed: Map<string, Listed>;
  /** Recorded txids that are not listed, mapped to whether the chain view still knows them. */
  known: Map<string, boolean>;
}

function minTime(a: number | null, b: number | undefined): number | null {
  if (b === undefined) return a;
  return a === null || b < a ? b : a;
}

// The pure half of a refresh: the stored record, what the chain shows and
// the clock in, the new record out.
function applyView(invoice: Invoice, view: ChainView, now: number): Invoice {
  const record = (txid: string, previous: InvoicePayment | undefined): InvoicePayment => {
    const listed = view.listed.get(txid);
    const firstSeenAt = Math.min(previous?.firstSeenAt ?? now, listed?.seenAt ?? now);
    if (listed === undefined) {
      const status: InvoicePaymentStatus = view.known.get(txid) === true ? 'unlisted' : 'vanished';
      return { ...previous!, status, block: null, confirmations: 0, firstSeenAt, counted: false };
    }
    const firstBlockTime = minTime(previous?.firstBlockTime ?? null, listed.block?.time);
    const onTime =
      previous?.onTime === true ||
      firstSeenAt < invoice.expiresAt ||
      (firstBlockTime !== null && firstBlockTime < invoice.expiresAt);
    return {
      txid,
      amount: listed.amount,
      status: listed.block === null ? 'unconfirmed' : 'confirmed',
      block: listed.block,
      confirmations: listed.block === null ? 0 : Math.max(0, view.tipHeight - listed.block.height + 1),
      firstSeenAt,
      firstBlockTime,
      onTime,
      counted: onTime,
    };
  };
  const payments = invoice.payments.map((previous) => record(previous.txid, previous));
  const recorded = new Set(invoice.payments.map((payment) => payment.txid));
  for (const txid of view.listed.keys()) {
    if (!recorded.has(txid)) payments.push(record(txid, undefined));
  }

  const { paidAmount, uncountedAmount, confirmations, conflicted } = summarize(payments);
  return { ...invoice, payments, paidAmount, uncountedAmount, confirmations, state: stateOf(invoice, paidAmount, confirmations, conflicted, now) };
}

function summarize(payments: readonly InvoicePayment[]): { paidAmount: bigint; uncountedAmount: bigint; confirmations: number; conflicted: boolean } {
  let paidAmount = 0n;
  let uncountedAmount = 0n;
  let confirmations = Number.MAX_SAFE_INTEGER;
  let conflicted = false;
  for (const payment of payments) {
    if (payment.counted) {
      paidAmount += payment.amount;
      confirmations = Math.min(confirmations, payment.confirmations);
    } else if (payment.status === 'unconfirmed' || payment.status === 'confirmed') {
      uncountedAmount += payment.amount;
    }
    if (payment.onTime && payment.status === 'vanished') conflicted = true;
  }
  return { paidAmount, uncountedAmount, confirmations: confirmations === Number.MAX_SAFE_INTEGER ? 0 : confirmations, conflicted };
}

function stateOf(invoice: Invoice, paid: bigint, confirmations: number, conflicted: boolean, now: number): InvoiceState {
  if (conflicted) return 'conflicted';
  if (paid >= invoice.amount) {
    if (confirmations >= invoice.requiredConfirmations) return paid > invoice.amount ? 'overpaid' : 'confirmed';
    return confirmations === 0 ? 'pending' : 'confirming';
  }
  if (now >= invoice.expiresAt) return paid > 0n ? 'expired-underpaid' : 'expired';
  return paid > 0n ? 'underpaid' : 'awaiting';
}


async function readView(invoice: Invoice, client: ChainClient, tipHeight: number, activity: readonly AddressPayment[]): Promise<ChainView> {
  const listed = listedPayments(activity);
  const missing = invoice.payments.filter((payment) => !listed.has(payment.txid)).map((payment) => payment.txid);
  const answers = await Promise.all(missing.map(async (txid) => (await client.getTransaction(txid)) !== null));
  return { tipHeight, listed, known: new Map(missing.map((txid, i) => [txid, answers[i]!])) };
}

/**
 * Recompute an invoice from its persisted record and the current chain
 * view. Pure with respect to the invoice: the input is not mutated and a
 * new record is returned. `now` is epoch seconds and defaults to the
 * current time; inject it for deterministic evaluation.
 *
 * What the chain backend returns is checked, not trusted: a tip or block
 * without an integer height, a block time or seenAt that is not epoch
 * seconds, or a payment whose amount is not a bigint from 0 to MAX_GRAIN,
 * throws instead of producing a state.
 */
export async function refreshInvoice(
  invoice: Invoice,
  client: ChainClient,
  now: number = Math.floor(Date.now() / 1000),
): Promise<Invoice> {
  assertNow(now);
  const [tip, activity] = await Promise.all([client.getTip(), client.getAddressActivity(invoice.address)]);
  const tipHeight = blockHeight(tip, 'a tip');
  return applyView(invoice, await readView(invoice, client, tipHeight, activity), now);
}

/** The JSON form of an InvoicePayment: amounts as decimal strings of grain. */
export interface InvoicePaymentJson {
  txid: string;
  amount: string;
  status: InvoicePaymentStatus;
  block: { height: number; hash: string; time?: number } | null;
  confirmations: number;
  firstSeenAt: number;
  firstBlockTime: number | null;
  onTime: boolean;
  counted: boolean;
}

/** The JSON form of an Invoice, as invoiceToJson writes it and invoiceFromJson reads it. */
export interface InvoiceJson {
  format: 'pearljs-invoice';
  version: 1;
  id: string;
  address: string;
  amount: string;
  createdAt: number;
  expiresAt: number;
  requiredConfirmations: number;
  payments: InvoicePaymentJson[];
  paidAmount: string;
  uncountedAmount: string;
  confirmations: number;
  state: InvoiceState;
}

const STATES: readonly InvoiceState[] = ['awaiting', 'underpaid', 'pending', 'confirming', 'confirmed', 'overpaid', 'expired', 'expired-underpaid', 'conflicted'];
const STATUSES: readonly InvoicePaymentStatus[] = ['unconfirmed', 'confirmed', 'unlisted', 'vanished'];

/** An InvoicePayment as plain JSON. */
export function invoicePaymentToJson(payment: InvoicePayment): InvoicePaymentJson {
  const { block } = payment;
  return {
    txid: payment.txid,
    amount: payment.amount.toString(),
    status: payment.status,
    block: block === null ? null : block.time === undefined ? { height: block.height, hash: block.hash } : { height: block.height, hash: block.hash, time: block.time },
    confirmations: payment.confirmations,
    firstSeenAt: payment.firstSeenAt,
    firstBlockTime: payment.firstBlockTime,
    onTime: payment.onTime,
    counted: payment.counted,
  };
}

/** An Invoice as plain JSON that JSON.stringify can write; bigints become decimal strings. */
export function invoiceToJson(invoice: Invoice): InvoiceJson {
  return {
    format: 'pearljs-invoice',
    version: 1,
    id: invoice.id,
    address: invoice.address,
    amount: invoice.amount.toString(),
    createdAt: invoice.createdAt,
    expiresAt: invoice.expiresAt,
    requiredConfirmations: invoice.requiredConfirmations,
    payments: invoice.payments.map(invoicePaymentToJson),
    paidAmount: invoice.paidAmount.toString(),
    uncountedAmount: invoice.uncountedAmount.toString(),
    confirmations: invoice.confirmations,
    state: invoice.state,
  };
}

function bad(message: string, cause?: unknown): PearlError {
  return new PearlError('INVOICE_JSON_INVALID', message, cause === undefined ? undefined : { cause });
}

function objectOf(value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw bad(`${what} is not an object`);
  return value as Record<string, unknown>;
}

function grainOf(value: unknown, what: string): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value) || BigInt(value) > MAX_GRAIN) {
    throw bad(`${what} is not a decimal string of grain from 0 to MAX_GRAIN`);
  }
  return BigInt(value);
}

function secondsOf(value: unknown, what: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw bad(`${what} is not a non-negative integer`);
  return value as number;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], what: string): T {
  if (!allowed.includes(value as T)) throw bad(`${what} is not one of ${allowed.join(', ')}`);
  return value as T;
}

function booleanOf(value: unknown, what: string): boolean {
  if (typeof value !== 'boolean') throw bad(`${what} is not a boolean`);
  return value;
}

/** Reads what invoicePaymentToJson wrote, refusing anything else with INVOICE_JSON_INVALID. */
export function invoicePaymentFromJson(value: unknown): InvoicePayment {
  const json = objectOf(value, 'payment');
  if (typeof json.txid !== 'string' || json.txid.length === 0) throw bad('payment txid is not a non-empty string');
  const what = `payment ${json.txid}`;
  let block: BlockRef | null = null;
  if (json.block !== null) {
    const raw = objectOf(json.block, `${what} block`);
    if (typeof raw.hash !== 'string' || raw.hash.length === 0) throw bad(`${what} block hash is not a non-empty string`);
    const height = secondsOf(raw.height, `${what} block height`);
    block = raw.time === undefined ? { height, hash: raw.hash } : { height, hash: raw.hash, time: secondsOf(raw.time, `${what} block time`) };
  }
  const payment: InvoicePayment = {
    txid: json.txid,
    amount: grainOf(json.amount, `${what} amount`),
    status: oneOf(json.status, STATUSES, `${what} status`),
    block,
    confirmations: secondsOf(json.confirmations, `${what} confirmations`),
    firstSeenAt: secondsOf(json.firstSeenAt, `${what} firstSeenAt`),
    firstBlockTime: json.firstBlockTime === null ? null : secondsOf(json.firstBlockTime, `${what} firstBlockTime`),
    onTime: booleanOf(json.onTime, `${what} onTime`),
    counted: booleanOf(json.counted, `${what} counted`),
  };
  if ((payment.status === 'confirmed') !== (block !== null)) throw bad(`${what} has a block exactly when it is confirmed, and this one does not`);
  if (block === null && payment.confirmations !== 0) throw bad(`${what} has confirmations without a block`);
  if (payment.counted && (!payment.onTime || payment.status === 'unlisted' || payment.status === 'vanished')) {
    throw bad(`${what} is counted although it is late or not listed`);
  }
  return payment;
}

/**
 * Reads what invoiceToJson wrote, for the network the invoice address is
 * on. Everything is checked: the format and version, the config as
 * createInvoice checks it, each payment, and that the totals match the
 * payments. Anything else throws INVOICE_JSON_INVALID.
 */
export function invoiceFromJson(value: unknown, network: PearlNetwork): Invoice {
  const json = objectOf(value, 'invoice');
  if (json.format !== 'pearljs-invoice') throw bad('not a pearljs invoice');
  if (json.version !== 1) throw bad(`invoice version ${String(json.version)} is not one this pearljs reads (1)`);
  const config: CreateInvoiceConfig = {
    id: json.id as string,
    address: json.address as string,
    amount: grainOf(json.amount, 'invoice amount'),
    createdAt: json.createdAt as number,
    expiresAt: json.expiresAt as number,
    requiredConfirmations: json.requiredConfirmations as number,
  };
  try {
    assertValidConfig(config, network);
  } catch (error) {
    if (error instanceof PearlError) throw bad(error.message, error);
    throw error;
  }
  if (!Array.isArray(json.payments)) throw bad('invoice payments is not an array');
  const payments = json.payments.map(invoicePaymentFromJson);
  if (new Set(payments.map((payment) => payment.txid)).size !== payments.length) throw bad('invoice lists a payment twice');
  const invoice: Invoice = {
    ...config,
    payments,
    paidAmount: grainOf(json.paidAmount, 'invoice paidAmount'),
    uncountedAmount: grainOf(json.uncountedAmount, 'invoice uncountedAmount'),
    confirmations: secondsOf(json.confirmations, 'invoice confirmations'),
    state: oneOf(json.state, STATES, 'invoice state'),
  };
  const totals = summarize(payments);
  if (totals.paidAmount !== invoice.paidAmount || totals.uncountedAmount !== invoice.uncountedAmount || totals.confirmations !== invoice.confirmations) {
    throw bad('invoice totals do not match its payments');
  }
  return invoice;
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

  /** createInvoice for the monitor's network. */
  createInvoice(config: CreateInvoiceConfig): Invoice {
    return createInvoice(config, this.#network);
  }

  /** refreshInvoice against the monitor's chain client. */
  refreshInvoice(invoice: Invoice, now?: number): Promise<Invoice> {
    return refreshInvoice(invoice, this.#client, now);
  }
}
