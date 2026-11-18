// The invoice index allocator: fresh indices stay within the gap limit of
// the last paid one, expired unpaid indices come back after a quiet period,
// anything paid is never reused, the state survives JSON, and a wallet
// restore with Oyster's window finds every paid invoice of a busy shop.

import { describe, expect, it } from 'vitest';
import { encodeAddress } from '../src/address.js';
import type { AddressPayment } from '../src/client.js';
import { discoverAccount } from '../src/discovery.js';
import { InvoiceGapError, InvoiceIndexAllocator, InvoiceMonitor, createInvoice, refreshInvoice } from '../src/invoice.js';
import { importWatchOnlyAccount } from '../src/keys.js';
import { createMemoryStore } from '../src/store.js';
import { SimulatedChain } from '../src/testing.js';
import { PearlWallet } from '../src/wallet.js';
import type { Invoice, InvoiceIndexAllocatorOptions } from '../src/invoice.js';
import { networks } from '../src/networks.js';
import { ScriptedChain, random } from './invoice-helpers.js';

const NETWORK = networks.regtest;
const deriveAddress = (index: number, change = false): string => {
  const program = new Uint8Array(32);
  new DataView(program.buffer).setUint32(0, index);
  program[31] = change ? 1 : 0;
  return encodeAddress({ version: 1, program }, NETWORK);
};

function allocator(chain: ScriptedChain, options: Partial<InvoiceIndexAllocatorOptions> = {}): InvoiceIndexAllocator {
  return new InvoiceIndexAllocator({ deriveAddress, client: chain, ...options });
}

const invoiceAt = (index: number, expiresAt = 2_000): Invoice =>
  createInvoice({ id: `order-${index}`, address: deriveAddress(index), amount: 1_000n, createdAt: 1_000, expiresAt, requiredConfirmations: 1 }, NETWORK);

describe('InvoiceIndexAllocator', () => {
  it('hands out fresh indices until the next one would be past the gap limit', async () => {
    const chain = new ScriptedChain();
    const indices = allocator(chain, { gapLimit: 5 });
    const given = [];
    for (let i = 0; i < 5; i++) given.push(await indices.allocate(1_000));
    expect(given.map((a) => [a.index, a.gap, a.reused])).toEqual([
      [0, 1, false],
      [1, 2, false],
      [2, 3, false],
      [3, 4, false],
      [4, 5, false],
    ]);
    expect(given[2]!.address).toBe(deriveAddress(2));
    const err = await indices.allocate(1_000).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvoiceGapError);
    expect(err).toMatchObject({ code: 'INVOICE_GAP_LIMIT', index: 5, lastUsed: -1, gapLimit: 5 });
    expect(indices.gap).toBe(5);
  });

  it('moves the window on when an invoice is paid, late payments included', async () => {
    const chain = new ScriptedChain();
    const indices = allocator(chain, { gapLimit: 3 });
    for (let i = 0; i < 3; i++) await indices.allocate(1_000);
    chain.broadcast('tx-late', { [deriveAddress(1)]: 5n }, 2_500);
    indices.track(1, await refreshInvoice(invoiceAt(1), chain, 2_600));
    expect((await indices.allocate(2_600)).index).toBe(3);
    expect((await indices.allocate(2_600)).index).toBe(4);
    await expect(indices.allocate(2_600)).rejects.toThrow(InvoiceGapError);
  });

  it('reuses the lowest expired unpaid index once reuseAfter has passed, never a paid one', async () => {
    const chain = new ScriptedChain();
    const indices = allocator(chain, { gapLimit: 3, reuseAfter: 100 });
    for (let i = 0; i < 3; i++) await indices.allocate(1_000);
    for (const index of [2, 0]) indices.track(index, await refreshInvoice(invoiceAt(index), chain, 2_000));
    chain.broadcast('tx-1', { [deriveAddress(1)]: 1_000n }, 1_500);
    indices.track(1, await refreshInvoice(invoiceAt(1), chain, 1_600));
    await expect(indices.allocate(2_099)).resolves.toMatchObject({ index: 3, reused: false, gap: 2 });
    await expect(indices.allocate(2_100)).resolves.toMatchObject({ index: 0, reused: true });
    await expect(indices.allocate(2_100)).resolves.toMatchObject({ index: 2, reused: true });
    await expect(indices.allocate(2_100)).resolves.toMatchObject({ index: 4, reused: false });
  });

  it('checks the address again before reusing it, and treats a payment found then as use', async () => {
    const chain = new ScriptedChain();
    const indices = allocator(chain, { gapLimit: 2, reuseAfter: 0 });
    await indices.allocate(1_000);
    await indices.allocate(1_000);
    indices.track(0, await refreshInvoice(invoiceAt(0), chain, 2_000));
    indices.track(1, await refreshInvoice(invoiceAt(1), chain, 2_000));
    // Paid after the last refresh: the allocator only learns it now.
    chain.broadcast('tx-0', { [deriveAddress(0)]: 7n }, 2_050);
    await expect(indices.allocate(2_100)).resolves.toMatchObject({ index: 1, reused: true, gap: 1 });
    expect(indices.toJson()).toMatchObject({ lastUsed: 0, free: [] });
  });

  it('hands out an index beyond the gap only when allowed, and says so', async () => {
    const indices = allocator(new ScriptedChain(), { gapLimit: 1, allowBeyondGap: true });
    await indices.allocate(1_000);
    await expect(indices.allocate(1_000)).resolves.toMatchObject({ index: 1, gap: 2, beyondGap: true });
  });

  it('gives concurrent callers different indices', async () => {
    const indices = allocator(new ScriptedChain());
    const given = await Promise.all(Array.from({ length: 20 }, () => indices.allocate(1_000)));
    expect(new Set(given.map((a) => a.index)).size).toBe(20);
  });

  it('starts after what discovery found and keeps its state through JSON', async () => {
    const chain = new ScriptedChain();
    const first = allocator(chain, { startAt: 40, reuseAfter: 10 });
    await first.allocate(1_000);
    await first.allocate(1_000);
    first.track(40, await refreshInvoice(invoiceAt(40), chain, 2_000));
    const state = JSON.parse(JSON.stringify(first.toJson())) as ReturnType<InvoiceIndexAllocator['toJson']>;
    expect(state).toEqual({
      format: 'pearljs-invoice-indices',
      version: 1,
      next: 42,
      lastUsed: 39,
      free: [{ index: 40, reusableAt: 2_010 }],
      issued: [
        { index: 40, at: 1_000 },
        { index: 41, at: 1_000 },
      ],
    });
    const second = allocator(chain, { state });
    expect(second.toJson()).toEqual(state);
    await expect(second.allocate(2_010)).resolves.toMatchObject({ index: 40, reused: true });
    for (const broken of [{ ...state, version: 2 }, { ...state, next: -1 }, { ...state, lastUsed: 42 }, { ...state, free: [{ index: 50, reusableAt: 0 }] }, { ...state, issued: [{ index: 50, at: 0 }] }, { ...state, format: 'x' }]) {
      expect(() => allocator(chain, { state: broken as typeof state })).toThrow(expect.objectContaining({ code: 'INVOICE_JSON_INVALID' }));
    }
    expect(() => first.track(99, invoiceAt(99))).toThrow(RangeError);
  });

  it('ignores a record of the invoice an index had before it was handed out again', async () => {
    const chain = new ScriptedChain();
    const indices = allocator(chain, { gapLimit: 5, reuseAfter: 0 });
    await indices.allocate(1_000);
    const earlier = await refreshInvoice(invoiceAt(0), chain, 2_000);
    indices.track(0, earlier);
    await expect(indices.allocate(2_100)).resolves.toMatchObject({ index: 0, reused: true });
    // The earlier invoice's expired record comes in again, while the new invoice at index 0 is open.
    indices.track(0, earlier);
    await expect(indices.allocate(2_200)).resolves.toMatchObject({ index: 1, reused: false });
    // The new invoice's own record still frees the index once it expires.
    const later = createInvoice({ id: 'order-0b', address: deriveAddress(0), amount: 1_000n, createdAt: 2_100, expiresAt: 3_000, requiredConfirmations: 1 }, NETWORK);
    indices.track(0, await refreshInvoice(later, chain, 3_000));
    await expect(indices.allocate(3_000)).resolves.toMatchObject({ index: 0, reused: true });
    // Restored from state written without issue times, it behaves as before.
    const old = indices.toJson();
    delete old.issued;
    expect(() => allocator(chain, { state: old })).not.toThrow();
  });

  it("keeps every paid invoice of a busy shop within reach of a restore with Oyster's window", async () => {
    const chain = new ScriptedChain();
    const indices = allocator(chain, { reuseAfter: 3_600 });
    const next = random(7);
    const open = new Map<number, Invoice>();
    const paid = new Set<number>();
    let reused = 0;
    let clock = 1_000_000;
    // 3000 invoices over time, nine in ten abandoned.
    for (let n = 0; n < 3_000; n++) {
      clock += 60;
      const { index, reused: again } = await indices.allocate(clock);
      if (again) reused++;
      const invoice = createInvoice({ id: `order-${n}`, address: deriveAddress(index), amount: 1_000n, createdAt: clock, expiresAt: clock + 900, requiredConfirmations: 1 }, NETWORK);
      open.set(index, invoice);
      if (next() < 0.1) {
        chain.broadcast(`tx-${n}`, { [deriveAddress(index)]: 1_000n }, clock + 10);
        paid.add(index);
      }
      // Refresh what is open every ten minutes, as a watcher would.
      if (n % 10 === 0) {
        for (const [i, record] of open) {
          const fresh = await refreshInvoice(record, chain, clock);
          indices.track(i, fresh);
          if (fresh.payments.length > 0 || fresh.state === 'expired') open.delete(i);
          else open.set(i, fresh);
        }
      }
    }
    expect(reused).toBeGreaterThan(1_000);
    const backend = {
      network: NETWORK,
      getAddressActivity: (address: string) => chain.getAddressActivity(address) as Promise<AddressPayment[]>,
      getUtxos: () => Promise.resolve([]),
    };
    const found = await discoverAccount({ deriveAddress }, backend);
    expect(new Set(found.receive.used.map((child) => child.index))).toEqual(paid);
  });
});

describe('invoices paid into a wallet account', () => {
  it('hands out the account\'s addresses, sees the payment and leaves the wallet holding it', async () => {
    const chain = new SimulatedChain();
    const wallet = await PearlWallet.create({ store: createMemoryStore(), backend: chain, passphrase: 'a long passphrase', kdf: { N: 2 ** 10 } });
    const invoicesAccount = await wallet.addAccount(1, { label: 'invoices' });
    wallet.lock();
    const keys = importWatchOnlyAccount(invoicesAccount.xpub, chain.network);
    const indices = new InvoiceIndexAllocator({ deriveAddress: (index) => keys.deriveAddress(index), client: chain });
    const monitor = new InvoiceMonitor(chain, chain.network);
    const now = chain.time;
    const first = await indices.allocate(now);
    const second = await indices.allocate(now);
    expect([first.index, second.index]).toEqual([0, 1]);
    let invoice = monitor.createInvoice({ id: 'order-7', address: second.address, amount: 400_000n, createdAt: now, expiresAt: now + 3600, requiredConfirmations: 1 });
    chain.pay(second.address, 400_000n);
    chain.mine();
    invoice = await monitor.refreshInvoice(invoice, now + 600);
    indices.track(second.index, invoice);
    await wallet.sync();
    expect(invoice.state).toBe('confirmed');
    expect(wallet.balance({ account: invoicesAccount.id }).confirmed).toBe(400_000n);
    expect(wallet.balance({ account: '0' }).total).toBe(0n);
    await wallet.close();
  });
});
