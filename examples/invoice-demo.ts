/**
 * Simulated invoice-monitoring demonstration.
 *
 * Drives the invoice monitor against a clearly named in-memory fake chain
 * and prints each step: an underpayment, an overpaying top-up, a
 * reorganization, a monitor that is down across expiry, a late payment, a
 * restart through the JSON codec and a double spend. It is a simulation
 * only and talks to no network, wallet or RPC endpoint.
 */

import { encodeAddress, invoiceFromJson, invoiceToJson, InvoiceMonitor, networks } from 'pearljs';
import type { AddressPayment, BlockRef, ChainClient, ChainTransaction, Invoice } from 'pearljs';

/** In-memory fake chain for simulation only; not a node integration. */
class SimulatedInMemoryChain implements ChainClient {
  tip: BlockRef = { height: 0, hash: 'sim-genesis', time: 0 };
  readonly #payments = new Map<string, AddressPayment>();

  mineBlock(time: number): BlockRef {
    const height = this.tip.height + 1;
    this.tip = { height, hash: `sim-block-${height}`, time };
    for (const [txid, payment] of this.#payments) {
      if (payment.block === null) this.#payments.set(txid, { ...payment, block: this.tip });
    }
    return this.tip;
  }

  broadcast(txid: string, amount: bigint): void {
    this.#payments.set(txid, { txid, amount, block: null });
  }

  reorgPaymentToMempool(txid: string): void {
    const payment = this.#payments.get(txid);
    if (payment !== undefined) this.#payments.set(txid, { ...payment, block: null });
  }

  dropPayment(txid: string): void {
    this.#payments.delete(txid);
  }

  getTip(): Promise<BlockRef> {
    return Promise.resolve(this.tip);
  }

  getAddressActivity(): Promise<readonly AddressPayment[]> {
    return Promise.resolve([...this.#payments.values()]);
  }

  getTransaction(txid: string): Promise<ChainTransaction | null> {
    const payment = this.#payments.get(txid);
    return Promise.resolve(payment === undefined ? null : { txid: payment.txid, block: payment.block });
  }
}

function printTransition(step: string, invoice: Invoice): void {
  console.log(
    `${step.padEnd(48)} state=${invoice.state} paid=${invoice.paidAmount} late=${invoice.uncountedAmount} ` +
      `confirmations=${invoice.confirmations}`,
  );
}

async function main(): Promise<void> {
  console.log('Simulated invoice demo (in-memory fake chain, not a node integration)');
  const start = 1_700_000_000;
  const chain = new SimulatedInMemoryChain();
  const monitor = new InvoiceMonitor(chain, networks.regtest);
  chain.mineBlock(start - 600);

  let now = start;
  let invoice = monitor.createInvoice({
    id: 'demo-invoice-1',
    address: encodeAddress({ version: 1, program: new Uint8Array(32).fill(1) }, networks.regtest),
    amount: 250_000n,
    createdAt: now,
    expiresAt: now + 3_600,
    requiredConfirmations: 2,
  });
  printTransition('invoice created', invoice);

  chain.broadcast('sim-tx-partial', 100_000n);
  now += 60;
  invoice = await monitor.refreshInvoice(invoice, now);
  printTransition('partial payment in mempool', invoice);

  chain.broadcast('sim-tx-rest', 200_000n);
  now += 60;
  invoice = await monitor.refreshInvoice(invoice, now);
  printTransition('overpaying top-up in mempool', invoice);

  now += 60;
  chain.mineBlock(now);
  invoice = await monitor.refreshInvoice(invoice, now);
  printTransition('payments mined (1 confirmation)', invoice);

  chain.reorgPaymentToMempool('sim-tx-rest');
  now += 60;
  invoice = await monitor.refreshInvoice(invoice, now);
  printTransition('reorg sends the top-up back to the mempool', invoice);

  // The monitor goes down; the top-up is mined again before expiry and the
  // invoice is next refreshed well after it.
  chain.mineBlock(now + 600);
  chain.mineBlock(now + 1_200);
  now = start + 7_200;
  invoice = await monitor.refreshInvoice(invoice, now);
  printTransition('first refresh after expiry, all mined in time', invoice);

  chain.broadcast('sim-tx-late', 30_000n);
  now += 60;
  invoice = await monitor.refreshInvoice(invoice, now);
  printTransition('a payment after expiry is kept, not counted', invoice);

  // A restart: the stored JSON is all the state there is.
  invoice = invoiceFromJson(JSON.parse(JSON.stringify(invoiceToJson(invoice))), networks.regtest);
  chain.dropPayment('sim-tx-partial');
  now += 60;
  invoice = await monitor.refreshInvoice(invoice, now);
  printTransition('restart, then a counted payment is double spent', invoice);

  for (const payment of invoice.payments) {
    console.log(`  ${payment.txid.padEnd(16)} ${String(payment.amount).padStart(7)} ${payment.status.padEnd(11)} ${payment.counted ? 'counted' : 'not counted'}`);
  }
}

await main();
