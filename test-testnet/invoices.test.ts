// Invoices on testnet2, watched through the node's websocket: one paid from
// the wallet's second account, which the watcher sees go from awaiting to
// pending when the payment reaches the mempool and to confirmed when a block
// takes it; and one nobody pays, which the watcher reports expired.

import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  createInvoice,
  pearldChainClient,
  watchInvoices,
  type Invoice,
  type InvoiceState,
  type PearlWallet,
  type PearlWsClient,
} from '../src/index.js';
import { BLOCK_WAIT, confirmed, describeTestnet, feeRate, fundsOrSkip, home, network, openWallet, record, wsClient } from './env.js';

const AMOUNT = 250_000n;
let wallet: PearlWallet;
let ws: PearlWsClient;
let skip: string | null = null;

const now = (): number => Math.floor(Date.now() / 1000);

/** Watches the invoices and records every state each passes through, until `done` says so. */
function watch(invoices: Invoice[], done: (states: Map<string, InvoiceState[]>) => boolean, timeout: number): Promise<Map<string, InvoiceState[]>> {
  const states = new Map(invoices.map((invoice) => [invoice.id, [invoice.state]]));
  return new Promise((resolve, reject) => {
    let finished = false;
    const watcher = watchInvoices({
      client: pearldChainClient(ws),
      network,
      ws,
      invoices,
      pollInterval: 60_000,
      onChange: (invoice) => {
        const seen = states.get(invoice.id)!;
        if (seen.at(-1) !== invoice.state) seen.push(invoice.state);
        if (!finished && done(states)) {
          finished = true;
          clearTimeout(timer);
          void watcher.stop().then(() => resolve(states));
        }
      },
      onError: (error) => console.warn('invoice watch:', error.message),
    });
    const timer = setTimeout(() => {
      finished = true;
      void watcher.stop().then(() => reject(new Error(`invoices did not settle: ${JSON.stringify([...states])}`)));
    }, timeout);
  });
}

describeTestnet('invoices watched over the websocket', () => {
  beforeAll(async () => {
    wallet = await openWallet();
    if (!wallet.accounts().some((entry) => entry.id === '1')) await wallet.addAccount(1, { label: 'second' });
    skip = await fundsOrSkip(wallet, 3n * AMOUNT);
    ws = wsClient();
  });
  afterAll(async () => {
    await wallet?.close();
    await ws?.close();
  });

  it('reports an unpaid invoice expired', async () => {
    const invoice = createInvoice(
      { id: 'expiring', address: await wallet.receiveAddress({ label: 'invoice: expiring' }), amount: AMOUNT, createdAt: now(), expiresAt: now() + 20, requiredConfirmations: 1 },
      network,
    );
    const states = await watch([invoice], (seen) => seen.get('expiring')!.includes('expired'), 120_000);
    expect(states.get('expiring')).toEqual(['awaiting', 'expired']);
  });

  it('follows a paid invoice from awaiting through pending to confirmed', async (context) => {
    if (skip !== null) context.skip(skip);
    // Account 1 pays, so it needs coins of its own first.
    const fundSecond = await wallet.send({ recipients: [{ address: await wallet.receiveAddress({ account: '1' }), amount: 2n * AMOUNT }], feeRate: await feeRate(), label: 'invoice: fund account 1' });
    record('g invoices', 'fund account 1', fundSecond.txid);
    await confirmed(fundSecond.txid);
    await wallet.sync();

    const invoice = createInvoice(
      { id: 'paid', address: await wallet.receiveAddress({ label: 'invoice: paid' }), amount: AMOUNT, createdAt: now(), expiresAt: now() + 4 * 3600, requiredConfirmations: 1 },
      network,
    );
    const settled = watch([invoice], (seen) => seen.get('paid')!.includes('confirmed'), 2 * BLOCK_WAIT);
    const paid = await wallet.send({ recipients: [{ address: invoice.address, amount: AMOUNT }], from: { account: '1' }, feeRate: await feeRate(), label: 'invoice: pay' });
    record('g invoices', 'pay the invoice from account 1', paid.txid);
    const states = (await settled).get('paid')!;
    expect(states[0]).toBe('awaiting');
    expect(states.at(-1)).toBe('confirmed');
    // A block can take the payment before the watcher's refresh sees the mempool; record whether pending was seen.
    record('g invoices', 'states seen', paid.txid, { states });
    expect(states.filter((state) => !['awaiting', 'pending', 'confirming', 'confirmed'].includes(state))).toEqual([]);

    await wallet.sync();
    const back = await wallet.send({ recipients: [{ address: home(), amount: 'max' }], from: { account: '1' }, feeRate: await feeRate(), label: 'invoice: account 1 home' });
    record('g invoices', 'account 1 send-max home', back.txid);
    await confirmed(back.txid);
  });
});
