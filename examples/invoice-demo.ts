/**
 * Invoice monitoring against a simulated chain.
 *
 * Drives the invoice monitor against pearljs/testing's SimulatedChain and
 * prints each step: an underpayment, an overpaying top-up, a
 * reorganization, a monitor that is down across expiry, a late payment, a
 * restart through the JSON codec and a double spend. The chain is held in
 * memory and talks to no network.
 */

import { InvoiceMonitor, invoiceFromJson, invoiceToJson } from 'pearljs';
import type { Invoice } from 'pearljs';
import { SimulatedChain, testAccount } from 'pearljs/testing';

function printTransition(step: string, invoice: Invoice): void {
  console.log(
    `${step.padEnd(48)} state=${invoice.state} paid=${invoice.paidAmount} late=${invoice.uncountedAmount} ` +
      `confirmations=${invoice.confirmations}`,
  );
}

const chain = new SimulatedChain();
// The chain is the monitor's ChainClient; it reports each block's time, which decides what was paid in time.
const monitor = new InvoiceMonitor(chain, chain.network);
const start = chain.time;
let now = start;
let invoice = monitor.createInvoice({
  id: 'demo-invoice-1',
  address: testAccount(0, chain.network).deriveAddress(0),
  amount: 250_000n,
  createdAt: now,
  expiresAt: now + 3_600,
  requiredConfirmations: 2,
});
printTransition('invoice created', invoice);

const partial = chain.pay(invoice.address, 100_000n);
now += 60;
invoice = await monitor.refreshInvoice(invoice, now);
printTransition('partial payment in mempool', invoice);

chain.pay(invoice.address, 200_000n);
now += 60;
invoice = await monitor.refreshInvoice(invoice, now);
printTransition('overpaying top-up in mempool', invoice);

chain.setTime(now + 60);
chain.mine();
now += 120;
invoice = await monitor.refreshInvoice(invoice, now);
printTransition('payments mined (1 confirmation)', invoice);

// The block is replaced by two that leave both payments in the mempool.
chain.reorg(1, { keepInMempool: true });
now += 60;
invoice = await monitor.refreshInvoice(invoice, now);
printTransition('reorg sends the payments back to the mempool', invoice);

// The monitor goes down; the payments are mined again before expiry and the
// invoice is next refreshed well after it.
chain.mine(2);
now = start + 7_200;
chain.setTime(now);
invoice = await monitor.refreshInvoice(invoice, now);
printTransition('first refresh after expiry, all mined in time', invoice);

chain.pay(invoice.address, 30_000n);
now += 60;
invoice = await monitor.refreshInvoice(invoice, now);
printTransition('a payment after expiry is kept, not counted', invoice);

// A restart: the stored JSON is all the state there is.
invoice = invoiceFromJson(JSON.parse(JSON.stringify(invoiceToJson(invoice))), chain.network);
// The block holding the partial payment is replaced by one where its coins went elsewhere.
const height = (await chain.getTransaction(partial.getId()))!.block!.height;
chain.reorg(chain.height - height + 1, { replace: [partial.getId()] });
now += 60;
invoice = await monitor.refreshInvoice(invoice, now);
printTransition('restart, then a counted payment is double spent', invoice);

for (const payment of invoice.payments) {
  console.log(`  ${payment.txid.slice(0, 16)} ${String(payment.amount).padStart(7)} ${payment.status.padEnd(11)} ${payment.counted ? 'counted' : 'not counted'}`);
}
