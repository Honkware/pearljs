// The invoice watcher over a real PearlWsClient talking to a fake socket
// that answers every request, and over polling alone: which notifications
// refresh which invoices, reconnects, expiry wake-ups, failing onChange
// handlers, and a stop that leaves nothing running.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeAddress, toOutputScript } from '../src/address.js';
import { createInvoice } from '../src/invoice.js';
import type { CreateInvoiceConfig, Invoice } from '../src/invoice.js';
import { watchInvoices } from '../src/invoice-watch.js';
import { networks } from '../src/networks.js';
import { createTransaction } from '../src/transaction.js';
import { PearlWsClient } from '../src/ws.js';
import { ScriptedChain } from './invoice-helpers.js';

const NETWORK = networks.regtest;
const addressOf = (n: number): string => encodeAddress({ version: 1, program: new Uint8Array(32).fill(n) }, NETWORK);
const A = addressOf(10);
const B = addressOf(11);

const invoiceFor = (id: string, address: string, overrides: Partial<CreateInvoiceConfig> = {}): Invoice =>
  createInvoice({ id, address, amount: 100_000n, createdAt: 1_000, expiresAt: 2_000, requiredConfirmations: 2, ...overrides }, NETWORK);

interface Sent {
  id: number;
  method: string;
  params: unknown[];
}

class FakeSocket {
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: Sent[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: { code?: number }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.all.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.({});
    });
  }

  send(data: string): void {
    const request = JSON.parse(data) as Sent;
    this.sent.push(request);
    queueMicrotask(() => this.push(`{"jsonrpc":"1.0","result":null,"error":null,"id":${request.id}}`));
  }

  close(code = 1000): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    queueMicrotask(() => this.onclose?.({ code }));
  }

  push(text: string): void {
    if (this.readyState === 1) this.onmessage?.({ data: text });
  }

  notify(method: string, params: unknown[]): void {
    this.push(JSON.stringify({ jsonrpc: '1.0', method, params, id: null }));
  }

  drop(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1006 });
  }

  methods(): string[] {
    return this.sent.map((s) => s.method);
  }
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
};

function socketClient(): PearlWsClient {
  return new PearlWsClient({ url: 'ws://127.0.0.1:18334', username: 'u', password: 'p', WebSocket: FakeSocket, reconnect: { initialDelay: 1 } });
}

// A serialized transaction paying the address, as relevanttxaccepted carries it.
function txPaying(address: string): string {
  const tx = createTransaction(2);
  tx.addInput(new Uint8Array(32).fill(3), 0);
  tx.addOutput(toOutputScript(address, NETWORK), 1_000n);
  return tx.toHex();
}

afterEach(() => {
  FakeSocket.all = [];
  vi.useRealTimers();
});

describe('watchInvoices over the websocket', () => {
  async function setup(invoices: Invoice[] = [invoiceFor('a', A), invoiceFor('b', B)]) {
    const chain = new ScriptedChain();
    const ws = socketClient();
    const changes: Invoice[] = [];
    const errors: Error[] = [];
    let clock = 1_500;
    const watcher = watchInvoices({
      client: chain,
      network: NETWORK,
      ws,
      invoices,
      now: () => clock,
      onChange: (invoice) => void changes.push(invoice),
      onError: (error) => void errors.push(error),
    });
    await settle();
    return { chain, ws, watcher, changes, errors, tick: (to: number) => (clock = to) };
  }

  it('loads the invoice addresses into the transaction filter and subscribes to blocks', async () => {
    const { ws, watcher } = await setup();
    const socket = FakeSocket.all[0]!;
    expect(socket.methods()).toEqual(expect.arrayContaining(['authenticate', 'notifyblocks', 'loadtxfilter']));
    expect(socket.sent.find((s) => s.method === 'loadtxfilter')!.params).toEqual([false, [A, B], []]);
    await watcher.stop();
    await ws.close();
  });

  it('refreshes only the invoice a relevant transaction pays', async () => {
    const { chain, ws, watcher, changes } = await setup();
    const before = chain.calls.getAddressActivity;
    chain.broadcast('tx-a', { [A]: 100_000n }, 1_500);
    FakeSocket.all[0]!.notify('relevanttxaccepted', [txPaying(A)]);
    await settle();
    expect(chain.calls.getAddressActivity - before).toBe(1);
    expect(changes.map((invoice) => [invoice.id, invoice.state])).toEqual([['a', 'pending']]);
    expect(watcher.invoices().find((invoice) => invoice.id === 'a')!.state).toBe('pending');
    await watcher.stop();
    await ws.close();
  });

  it('refreshes every invoice on a block, once for a burst', async () => {
    const { chain, ws, watcher, changes } = await setup();
    chain.broadcast('tx-a', { [A]: 100_000n }, 1_500);
    chain.broadcast('tx-b', { [B]: 30_000n }, 1_500);
    const block = chain.mine(1_510);
    const passes = chain.calls.getTip;
    for (let i = 0; i < 10; i++) FakeSocket.all[0]!.notify('blockconnected', [block.hash, block.height, 1_510]);
    await settle();
    expect(chain.calls.getTip - passes).toBeLessThanOrEqual(2);
    expect(changes.map((invoice) => [invoice.id, invoice.state])).toEqual([
      ['a', 'confirming'],
      ['b', 'underpaid'],
    ]);
    await watcher.stop();
    await ws.close();
  });

  it('catches up after a reconnect with what happened while the socket was down', async () => {
    const { chain, ws, watcher, changes } = await setup();
    FakeSocket.all[0]!.drop();
    chain.broadcast('tx-a', { [A]: 100_000n }, 1_500);
    chain.mine(1_520);
    chain.mine(1_530);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await settle();
    expect(FakeSocket.all).toHaveLength(2);
    expect(FakeSocket.all[1]!.sent.find((s) => s.method === 'loadtxfilter')!.params).toEqual([true, [A, B], []]);
    expect(changes.map((invoice) => [invoice.id, invoice.state])).toEqual([['a', 'confirmed']]);
    await watcher.stop();
    await ws.close();
  });

  it('adds and removes invoices, and reloads the filter without a removed address', async () => {
    const { chain, ws, watcher, changes } = await setup([invoiceFor('a', A)]);
    const C = addressOf(12);
    chain.broadcast('tx-c', { [C]: 5n }, 1_500);
    watcher.add(invoiceFor('c', C));
    await settle();
    expect(changes.map((invoice) => [invoice.id, invoice.state])).toEqual([['c', 'underpaid']]);
    watcher.remove('a');
    await settle();
    const filters = FakeSocket.all[0]!.sent.filter((s) => s.method === 'loadtxfilter').map((s) => s.params);
    expect(filters).toEqual([
      [false, [A], []],
      [false, [C], []],
      [true, [C], []],
    ]);
    expect(watcher.invoices().map((invoice) => invoice.id)).toEqual(['c']);
    await watcher.stop();
    await ws.close();
  });

  it('stops listening, so a later notification changes nothing', async () => {
    const { chain, ws, watcher, changes } = await setup();
    await watcher.stop();
    const calls = { ...chain.calls };
    chain.broadcast('tx-a', { [A]: 100_000n }, 1_500);
    FakeSocket.all[0]!.notify('relevanttxaccepted', [txPaying(A)]);
    FakeSocket.all[0]!.notify('blockconnected', ['00'.repeat(32), 101, 1_600]);
    await settle();
    expect(chain.calls).toEqual(calls);
    expect(changes).toEqual([]);
    await ws.close();
  });
});

describe('watchInvoices by polling', () => {
  it('polls at the interval, wakes at expiry and leaves no timer after stop', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const chain = new ScriptedChain();
    let clock = 1_000;
    const changes: [string, string][] = [];
    const watcher = watchInvoices({
      client: chain,
      network: NETWORK,
      invoices: [invoiceFor('a', A, { expiresAt: 1_100 })],
      now: () => clock,
      pollInterval: 30_000,
      onChange: (invoice) => void changes.push([invoice.id, invoice.state]),
    });
    await vi.advanceTimersByTimeAsync(0);
    chain.broadcast('tx-a', { [A]: 40_000n }, 1_010);
    clock = 1_030;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(changes).toEqual([['a', 'underpaid']]);
    // The next poll would come at 1060; the expiry timer fires at 1100 after the one at 1090.
    clock = 1_060;
    await vi.advanceTimersByTimeAsync(30_000);
    clock = 1_100;
    await vi.advanceTimersByTimeAsync(40_000);
    expect(changes).toEqual([['a', 'underpaid'], ['a', 'expired-underpaid']]);
    await watcher.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('offers a change again when onChange fails, and drops an invoice once until says so', async () => {
    const chain = new ScriptedChain();
    const errors: string[] = [];
    let fail = true;
    const stored: string[] = [];
    const watcher = watchInvoices({
      client: chain,
      network: NETWORK,
      invoices: [invoiceFor('a', A, { requiredConfirmations: 1 })],
      now: () => 1_500,
      pollInterval: 1e9,
      onChange: (invoice) => {
        if (fail) throw new Error('database down');
        stored.push(invoice.state);
      },
      onError: (error) => void errors.push(error.message),
      until: (invoice) => invoice.state === 'confirmed',
    });
    chain.broadcast('tx-a', { [A]: 100_000n }, 1_500);
    chain.mine(1_510);
    await watcher.refresh();
    expect(errors.length).toBeGreaterThan(0);
    expect(new Set(errors)).toEqual(new Set(['database down']));
    expect(watcher.invoices()[0]!.state).toBe('awaiting');
    fail = false;
    await watcher.refresh();
    expect(stored).toEqual(['confirmed']);
    expect(watcher.invoices()).toEqual([]);
    await watcher.stop();
  });

  it('reports a failing backend and keeps going', async () => {
    const chain = new ScriptedChain();
    const errors: string[] = [];
    let down = true;
    const original = chain.getTip.bind(chain);
    chain.getTip = () => (down ? Promise.reject(new Error('backend down')) : original());
    const changes: string[] = [];
    const watcher = watchInvoices({
      client: chain,
      network: NETWORK,
      invoices: [invoiceFor('a', A)],
      now: () => 2_500,
      pollInterval: 1e9,
      onChange: (invoice) => void changes.push(invoice.state),
      onError: (error) => void errors.push(error.message),
    });
    await watcher.refresh();
    expect(errors).toContain('backend down');
    down = false;
    await watcher.refresh();
    expect(changes).toEqual(['expired']);
    await watcher.stop();
  });
});
