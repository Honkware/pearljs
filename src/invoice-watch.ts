/**
 * Keeps a set of invoices current: refreshes them when pearld's websocket
 * reports a relevant transaction or a block, after a reconnect, at each
 * expiry, and on a timer as the fallback, and reports every change.
 *
 * @module
 */

import { fromOutputScript } from './address.js';
import type { ChainClient } from './client.js';
import { invoiceToJson, refreshInvoices } from './invoice.js';
import type { Invoice } from './invoice.js';
import type { PearlNetwork } from './networks.js';
import { parseTransaction } from './transaction.js';
import type { PearlWsClient } from './ws.js';

/** The parts of PearlWsClient the watcher uses. */
export type InvoiceWatchSocket = Pick<PearlWsClient, 'on' | 'watchBlocks' | 'loadTxFilter'>;

/** Options for watchInvoices. */
export interface InvoiceWatchOptions {
  /** Where refreshes read the chain. */
  readonly client: ChainClient;
  /** The network the invoice addresses are on, to match relevanttxaccepted to invoices. */
  readonly network: PearlNetwork;
  /** Invoices to follow from the start. */
  readonly invoices?: Iterable<Invoice>;
  /** Push notifications; without one the watcher polls only. */
  readonly ws?: InvoiceWatchSocket;
  /**
   * Called with the new record whenever a refresh changes an invoice, one
   * call at a time, in order. Store the record here; a rejection is passed
   * to onError and the change is offered again on the next refresh.
   */
  readonly onChange: (invoice: Invoice, previous: Invoice) => void | Promise<void>;
  /** Errors from refreshes, the websocket and onChange. The watcher keeps going. */
  readonly onError?: (error: Error) => void;
  /** Longest wait between refreshes, ms. Default 60000. */
  readonly pollInterval?: number;
  /** Stop following an invoice once this returns true for its new record. Default never. */
  readonly until?: (invoice: Invoice) => boolean;
  /** Backend calls in flight at once. Default 8. */
  readonly concurrency?: number;
  /** The clock, epoch seconds. */
  readonly now?: () => number;
}

/** A running watch, from watchInvoices. */
export interface InvoiceWatcher {
  /** Starts following an invoice, or replaces the record held for its id. */
  add(invoice: Invoice): void;
  /** Stops following an invoice. */
  remove(id: string): void;
  /** The current record of each invoice followed. */
  invoices(): Invoice[];
  /** Refreshes every invoice now; resolves when that refresh and its onChange calls are done. */
  refresh(): Promise<void>;
  /** Unsubscribes, stops the timer and waits for a refresh in flight. No onChange follows. */
  stop(): Promise<void>;
}

const asError = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)));

/**
 * Follows invoices until stopped. Every refresh goes through
 * refreshInvoices, so a burst of notifications costs one pass, and a pass
 * that is asked for while one runs is run once after it.
 */
export function watchInvoices(options: InvoiceWatchOptions): InvoiceWatcher {
  const { client, network, ws, onChange, until, concurrency } = options;
  const pollInterval = options.pollInterval ?? 60_000;
  if (!Number.isFinite(pollInterval) || pollInterval <= 0) throw new RangeError('pollInterval must be a positive number of ms');
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const onError = (err: unknown): void => options.onError?.(asError(err));
  const held = new Map<string, Invoice>();
  const offs: (() => void)[] = [];
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | null = null;
  // Ids to refresh on the next pass; null means all of them.
  let wanted: Set<string> | null = new Set();
  let again = false;

  const filter = (addresses: string[], reload: boolean): void => {
    if (ws === undefined || (addresses.length === 0 && !reload)) return;
    ws.loadTxFilter({ addresses }, reload).catch(onError);
  };

  const forget = (id: string): void => {
    const invoice = held.get(id);
    if (invoice === undefined) return;
    held.delete(id);
    if (![...held.values()].some((other) => other.address === invoice.address)) {
      filter([...new Set([...held.values()].map((other) => other.address))], true);
    }
  };

  const schedule = (): void => {
    clearTimeout(timer);
    if (stopped) return;
    // Wake at the next expiry too, so expired states arrive on time.
    const t = now();
    let delay = pollInterval;
    for (const invoice of held.values()) {
      if (invoice.expiresAt > t) delay = Math.min(delay, (invoice.expiresAt - t) * 1000);
    }
    timer = setTimeout(() => void request(null), delay);
  };

  const pass = async (ids: Set<string> | null): Promise<void> => {
    const batch = [...held.values()].filter((invoice) => ids === null || ids.has(invoice.id));
    let fresh: Invoice[] = [];
    try {
      fresh = await refreshInvoices(batch, client, { now: now(), ...(concurrency === undefined ? {} : { concurrency }) });
    } catch (err) {
      onError(err);
    }
    for (const [i, next] of fresh.entries()) {
      const previous = batch[i]!;
      if (stopped) return;
      // Skip invoices removed or replaced while the pass ran.
      if (held.get(previous.id) !== previous) continue;
      if (JSON.stringify(invoiceToJson(next)) === JSON.stringify(invoiceToJson(previous))) continue;
      try {
        await onChange(next, previous);
      } catch (err) {
        onError(err);
        continue;
      }
      if (stopped || held.get(previous.id) !== previous) continue;
      held.set(next.id, next);
      if (until?.(next) === true) forget(next.id);
    }
  };

  const request = (ids: Set<string> | null): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (ids === null || wanted === null) wanted = null;
    else for (const id of ids) wanted.add(id);
    if (running !== null) {
      again = true;
      return running;
    }
    const loop = async (): Promise<void> => {
      do {
        again = false;
        const ids = wanted;
        wanted = new Set();
        await pass(ids);
      } while (again && !stopped);
      running = null;
      schedule();
    };
    running = loop();
    return running;
  };

  // A transaction names the invoices it pays; one that cannot be read refreshes all.
  const onTransaction = ({ transaction }: { transaction: string }): void => {
    let ids: Set<string> | null;
    try {
      const paid = new Set<string>();
      for (const output of parseTransaction(transaction).outs) {
        try {
          paid.add(fromOutputScript(Uint8Array.from(output.script), network));
        } catch {
          // An output with no address pays no invoice.
        }
      }
      ids = new Set([...held.values()].filter((invoice) => paid.has(invoice.address)).map((invoice) => invoice.id));
      if (ids.size === 0) return;
    } catch {
      ids = null;
    }
    void request(ids);
  };

  for (const invoice of options.invoices ?? []) held.set(invoice.id, invoice);
  if (ws !== undefined) {
    offs.push(ws.on('relevanttxaccepted', onTransaction));
    offs.push(ws.on('connect', ({ reconnect }) => void (reconnect ? request(null) : undefined)));
    offs.push(ws.watchBlocks({ onBlock: () => void request(null), onError }));
    filter([...held.values()].map((invoice) => invoice.address), false);
  }
  void request(null);

  return {
    add(invoice) {
      if (stopped) return;
      const known = [...held.values()].some((other) => other.address === invoice.address);
      held.set(invoice.id, invoice);
      if (!known) filter([invoice.address], false);
      void request(new Set([invoice.id]));
    },
    remove: forget,
    invoices: () => [...held.values()],
    refresh: () => request(null),
    async stop() {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      for (const off of offs) off();
      await running;
    },
  };
}
