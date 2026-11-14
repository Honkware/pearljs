import { describe, expect, it } from 'vitest';

import type { AddressPayment, BlockRef, ChainClient, ChainTransaction } from '../src/client.js';
import type { CreateInvoiceConfig, Invoice } from '../src/invoice.js';
import { InvoiceMonitor, createInvoice, refreshInvoice } from '../src/invoice.js';

/** Controllable in-memory chain view for tests. */
class FakeChain implements ChainClient {
  tip: BlockRef = { height: 100, hash: 'hash-100' };
  activity: AddressPayment[] = [];
  transactions = new Map<string, ChainTransaction>();

  getTip(): Promise<BlockRef> {
    return Promise.resolve(this.tip);
  }

  getAddressActivity(): Promise<readonly AddressPayment[]> {
    return Promise.resolve(this.activity);
  }

  getTransaction(txid: string): Promise<ChainTransaction | null> {
    return Promise.resolve(this.transactions.get(txid) ?? null);
  }

  pay(txid: string, amount: bigint, height: number | null): void {
    const block = height === null ? null : { height, hash: `hash-${height}` };
    this.activity.push({ txid, amount, block });
    this.transactions.set(txid, { txid, block });
  }

  moveToBlock(txid: string, height: number | null): void {
    const block = height === null ? null : { height, hash: `hash-${height}` };
    this.activity = this.activity.map((p) => (p.txid === txid ? { ...p, block } : p));
    this.transactions.set(txid, { txid, block });
  }

  drop(txid: string): void {
    this.activity = this.activity.filter((p) => p.txid !== txid);
    this.transactions.delete(txid);
  }
}

const ADDRESS = 'bc1p-invoice-address';

function config(overrides: Partial<CreateInvoiceConfig> = {}): CreateInvoiceConfig {
  return {
    id: 'inv-1',
    address: ADDRESS,
    amount: 100_000n,
    createdAt: 1_000,
    expiresAt: 2_000,
    requiredConfirmations: 3,
    ...overrides,
  };
}

describe('createInvoice', () => {
  it('creates an awaiting invoice with no payments', () => {
    const invoice = createInvoice(config());
    expect(invoice.state).toBe('awaiting');
    expect(invoice.paidAmount).toBe(0n);
    expect(invoice.confirmations).toBe(0);
    expect(invoice.observedPayments).toEqual([]);
  });

  it('rejects invalid config', () => {
    expect(() => createInvoice(config({ id: '' }))).toThrow(/id/);
    expect(() => createInvoice(config({ address: '' }))).toThrow(/address/);
    expect(() => createInvoice(config({ amount: 0n }))).toThrow(/amount/);
    expect(() => createInvoice(config({ amount: -1n }))).toThrow(/amount/);
    expect(() =>
      createInvoice(config({ amount: 100 as unknown as bigint })),
    ).toThrow(/amount/);
    expect(() => createInvoice(config({ createdAt: 1.5 }))).toThrow(/createdAt/);
    expect(() => createInvoice(config({ expiresAt: 1_000 }))).toThrow(/expiresAt/);
    expect(() => createInvoice(config({ requiredConfirmations: 0 }))).toThrow(
      /requiredConfirmations/,
    );
    expect(() => createInvoice(config({ requiredConfirmations: 2.5 }))).toThrow(
      /requiredConfirmations/,
    );
  });
});

describe('refreshInvoice', () => {
  it('stays awaiting with no payment before expiry', async () => {
    const chain = new FakeChain();
    const invoice = await refreshInvoice(createInvoice(config()), chain, 1_500);
    expect(invoice.state).toBe('awaiting');
    expect(invoice.paidAmount).toBe(0n);
  });

  it('exact unconfirmed payment is pending', async () => {
    const chain = new FakeChain();
    chain.pay('tx-exact', 100_000n, null);
    const invoice = await refreshInvoice(createInvoice(config()), chain, 1_500);
    expect(invoice.state).toBe('pending');
    expect(invoice.paidAmount).toBe(100_000n);
    expect(invoice.confirmations).toBe(0);
    expect(invoice.observedPayments).toEqual([{ txid: 'tx-exact', firstSeenAt: 1_500 }]);
  });

  it('underpaid stays awaiting before expiry and expires after', async () => {
    const chain = new FakeChain();
    chain.pay('tx-under', 50_000n, 100);
    let invoice = await refreshInvoice(createInvoice(config()), chain, 1_500);
    expect(invoice.state).toBe('awaiting');
    expect(invoice.paidAmount).toBe(50_000n);
    invoice = await refreshInvoice(invoice, chain, 2_000);
    expect(invoice.state).toBe('expired');
  });

  it('expires with no payment at expiry', async () => {
    const chain = new FakeChain();
    const invoice = await refreshInvoice(createInvoice(config()), chain, 2_000);
    expect(invoice.state).toBe('expired');
  });

  it('overpaid is accepted and sums multiple payments', async () => {
    const chain = new FakeChain();
    chain.pay('tx-a', 70_000n, 100);
    chain.pay('tx-b', 80_000n, 100);
    const invoice = await refreshInvoice(createInvoice(config()), chain, 1_500);
    expect(invoice.state).toBe('confirming');
    expect(invoice.paidAmount).toBe(150_000n);
  });

  it('duplicate reports of the same txid count once', async () => {
    const chain = new FakeChain();
    chain.pay('tx-dup', 60_000n, 100);
    chain.pay('tx-dup', 60_000n, 100);
    const invoice = await refreshInvoice(createInvoice(config()), chain, 1_500);
    expect(invoice.paidAmount).toBe(60_000n);
    expect(invoice.state).toBe('awaiting');
    expect(invoice.observedPayments).toEqual([{ txid: 'tx-dup', firstSeenAt: 1_500 }]);
  });

  it('tracks confirmation depth until confirmed', async () => {
    const chain = new FakeChain();
    chain.pay('tx-conf', 100_000n, 100);
    const monitor = new InvoiceMonitor(chain);
    let invoice = monitor.createInvoice(config());

    chain.tip = { height: 100, hash: 'hash-100' };
    invoice = await monitor.refreshInvoice(invoice, 1_500);
    expect(invoice.state).toBe('confirming');
    expect(invoice.confirmations).toBe(1);

    chain.tip = { height: 101, hash: 'hash-101' };
    invoice = await monitor.refreshInvoice(invoice, 1_500);
    expect(invoice.state).toBe('confirming');
    expect(invoice.confirmations).toBe(2);

    chain.tip = { height: 102, hash: 'hash-102' };
    invoice = await monitor.refreshInvoice(invoice, 1_500);
    expect(invoice.state).toBe('confirmed');
    expect(invoice.confirmations).toBe(3);
  });

  it('a single confirmation confirms when requiredConfirmations is 1', async () => {
    const chain = new FakeChain();
    chain.pay('tx-one', 100_000n, 100);
    const invoice = await refreshInvoice(
      createInvoice(config({ requiredConfirmations: 1 })),
      chain,
      1_500,
    );
    expect(invoice.state).toBe('confirmed');
  });

  it('reorg below requiredConfirmations regresses confirmed to confirming', async () => {
    const chain = new FakeChain();
    chain.pay('tx-reorg', 100_000n, 100);
    chain.tip = { height: 102, hash: 'hash-102' };
    let invoice = await refreshInvoice(createInvoice(config()), chain, 1_500);
    expect(invoice.state).toBe('confirmed');

    // Reorg: the payment now sits in a deeper block relative to the tip.
    chain.moveToBlock('tx-reorg', 102);
    invoice = await refreshInvoice(invoice, chain, 1_500);
    expect(invoice.state).toBe('confirming');
    expect(invoice.confirmations).toBe(1);

    // Deeper reorg: the payment is back in the mempool.
    chain.moveToBlock('tx-reorg', null);
    invoice = await refreshInvoice(invoice, chain, 1_500);
    expect(invoice.state).toBe('pending');
    expect(invoice.confirmations).toBe(0);
  });

  it('payment moved blocks recalculates confirmations', async () => {
    const chain = new FakeChain();
    chain.pay('tx-move', 100_000n, 100);
    chain.tip = { height: 110, hash: 'hash-110' };
    let invoice = await refreshInvoice(createInvoice(config()), chain, 1_500);
    expect(invoice.state).toBe('confirmed');
    expect(invoice.confirmations).toBe(11);

    chain.moveToBlock('tx-move', 108);
    invoice = await refreshInvoice(invoice, chain, 1_500);
    expect(invoice.confirmations).toBe(3);
    expect(invoice.state).toBe('confirmed');
  });

  it('a vanished payment conflicts and never stays confirmed', async () => {
    const chain = new FakeChain();
    chain.pay('tx-gone', 100_000n, 100);
    chain.tip = { height: 110, hash: 'hash-110' };
    let invoice = await refreshInvoice(createInvoice(config()), chain, 1_500);
    expect(invoice.state).toBe('confirmed');

    chain.drop('tx-gone');
    invoice = await refreshInvoice(invoice, chain, 1_500);
    expect(invoice.state).toBe('conflicted');

    // It stays conflicted while the chain view does not know the txid.
    invoice = await refreshInvoice(invoice, chain, 1_500);
    expect(invoice.state).toBe('conflicted');
  });

  it('a reorged-out payment that still exists does not conflict', async () => {
    const chain = new FakeChain();
    chain.pay('tx-mempool', 100_000n, 100);
    chain.tip = { height: 102, hash: 'hash-102' };
    let invoice = await refreshInvoice(createInvoice(config()), chain, 1_500);
    expect(invoice.state).toBe('confirmed');

    // Reorged back into the mempool: no longer in address activity per a
    // lagging indexer, but the transaction itself is still known.
    chain.activity = [];
    invoice = await refreshInvoice(invoice, chain, 1_500);
    expect(invoice.state).toBe('awaiting');
    expect(invoice.paidAmount).toBe(0n);
  });

  it('mempool payment first seen at expiry does not count', async () => {
    const chain = new FakeChain();
    chain.pay('tx-late', 100_000n, null);
    const invoice = await refreshInvoice(createInvoice(config()), chain, 2_000);
    expect(invoice.paidAmount).toBe(0n);
    expect(invoice.state).toBe('expired');
    expect(invoice.observedPayments).toEqual([{ txid: 'tx-late', firstSeenAt: 2_000 }]);
  });

  it('payment first seen one second before expiry counts', async () => {
    const chain = new FakeChain();
    chain.pay('tx-boundary', 100_000n, null);
    const invoice = await refreshInvoice(createInvoice(config()), chain, 1_999);
    expect(invoice.paidAmount).toBe(100_000n);
    expect(invoice.state).toBe('pending');
  });

  it('payment first seen before expiry stays valid after confirming late', async () => {
    const chain = new FakeChain();
    chain.pay('tx-lateconf', 100_000n, null);
    let invoice = await refreshInvoice(createInvoice(config()), chain, 1_999);
    expect(invoice.state).toBe('pending');

    // Expiry passes while unconfirmed, then it confirms.
    chain.moveToBlock('tx-lateconf', 100);
    invoice = await refreshInvoice(invoice, chain, 2_500);
    expect(invoice.paidAmount).toBe(100_000n);
    expect(invoice.state).toBe('confirming');
  });

  it('conflicted wins over expired', async () => {
    const chain = new FakeChain();
    chain.pay('tx-partial', 50_000n, 100);
    let invoice = await refreshInvoice(createInvoice(config()), chain, 1_500);
    chain.drop('tx-partial');
    invoice = await refreshInvoice(invoice, chain, 2_500);
    expect(invoice.state).toBe('conflicted');
  });

  it('uses persisted firstSeenAt across refreshes', async () => {
    const chain = new FakeChain();
    chain.pay('tx-persist', 100_000n, null);
    let invoice = await refreshInvoice(createInvoice(config()), chain, 1_200);
    chain.pay('tx-second', 10_000n, null);
    invoice = await refreshInvoice(invoice, chain, 1_300);
    expect(invoice.observedPayments).toEqual([
      { txid: 'tx-persist', firstSeenAt: 1_200 },
      { txid: 'tx-second', firstSeenAt: 1_300 },
    ]);
  });

  it('rejects a non-integer now', async () => {
    const chain = new FakeChain();
    const invoice: Invoice = createInvoice(config());
    await expect(refreshInvoice(invoice, chain, 1.5)).rejects.toThrow(/now/);
  });
});


describe('chain view inconsistencies and late payments', () => {
  it('rejects conflicting duplicate reports instead of choosing one', async () => {
    const chain = new FakeChain();
    chain.pay('tx-dup', 60_000n, 100);
    chain.pay('tx-dup', 70_000n, 100);
    await expect(
      refreshInvoice(createInvoice(config()), chain, 1_500),
    ).rejects.toThrow('conflicting entries');
  });

  it('does not conflict an expired invoice when a late payment vanishes', async () => {
    const chain = new FakeChain();
    let invoice = await refreshInvoice(createInvoice(config()), chain, 2_000);
    expect(invoice.state).toBe('expired');

    chain.pay('tx-late', 100_000n, null);
    invoice = await refreshInvoice(invoice, chain, 2_001);
    expect(invoice.state).toBe('expired');
    expect(invoice.paidAmount).toBe(0n);

    chain.drop('tx-late');
    invoice = await refreshInvoice(invoice, chain, 2_002);
    expect(invoice.state).toBe('expired');
  });
});
