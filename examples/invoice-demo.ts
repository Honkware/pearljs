/**
 * Simulated invoice-monitoring demonstration.
 *
 * This script drives InvoiceMonitor against a clearly named in-memory
 * fake chain to print state transitions. It is a simulation only: it is
 * not a node integration and does not talk to any network, wallet, or
 * RPC endpoint.
 */

import { encodeAddress, InvoiceMonitor, networks } from 'pearljs';
import type { AddressPayment, BlockRef, ChainClient, ChainTransaction, Invoice } from 'pearljs';

/** In-memory fake chain for simulation only; not a node integration. */
class SimulatedInMemoryChain implements ChainClient {
  tip: BlockRef = { height: 0, hash: 'sim-genesis' };
  readonly #payments = new Map<string, AddressPayment>();

  mineBlock(): BlockRef {
    const height = this.tip.height + 1;
    this.tip = { height, hash: `sim-block-${height}` };
    for (const [txid, payment] of this.#payments) {
      if (payment.block === null) {
        this.#payments.set(txid, { ...payment, block: this.tip });
      }
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
    return Promise.resolve(
      payment === undefined ? null : { txid: payment.txid, block: payment.block },
    );
  }
}

function printTransition(step: string, invoice: Invoice): void {
  console.log(
    `${step.padEnd(44)} state=${invoice.state} paid=${invoice.paidAmount} ` +
      `confirmations=${invoice.confirmations}`,
  );
}

async function main(): Promise<void> {
  console.log('Simulated invoice demo (in-memory fake chain, not a node integration)');
  const chain = new SimulatedInMemoryChain();
  const monitor = new InvoiceMonitor(chain, networks.regtest);
  chain.mineBlock();
  chain.mineBlock();

  let now = 1_700_000_000;
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
  printTransition('overpaying remainder in mempool', invoice);

  chain.mineBlock();
  now += 60;
  invoice = await monitor.refreshInvoice(invoice, now);
  printTransition('payments mined (1 confirmation)', invoice);

  chain.mineBlock();
  now += 60;
  invoice = await monitor.refreshInvoice(invoice, now);
  printTransition('payments at required depth', invoice);

  chain.reorgPaymentToMempool('sim-tx-rest');
  now += 60;
  invoice = await monitor.refreshInvoice(invoice, now);
  printTransition('reorg sends one payment to mempool', invoice);

  chain.dropPayment('sim-tx-rest');
  now += 60;
  invoice = await monitor.refreshInvoice(invoice, now);
  printTransition('observed payment vanishes', invoice);
}

await main();
