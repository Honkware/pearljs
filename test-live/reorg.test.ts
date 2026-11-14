// A reorganization between two regtest pearld nodes on loopback: the suite's
// node confirms an invoice payment in a block that a second node's longer
// chain then replaces. pearld puts the payment back in its mempool, the
// invoice monitor takes the confirmation back, and the next block confirms
// it again. Runs last; the second node only ever peers with the first.

import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import {
  createPsbt,
  createTransaction,
  deriveSigningAccountFromSeed,
  finalizePsbt,
  InvoiceMonitor,
  mnemonicToSeed,
  pearldChainClient,
  RPC_ERROR_CODES,
  toOutputScript,
  transactionId,
} from '../src/index.js';
import type { PearldClient } from '../src/index.js';
import { mineBlocks } from './context.js';
import { addChange, broadcast, describeLive, fund, live, mine, miner, network, pearld } from './chain.js';
import { startPearld, type RunningPearld } from './processes.js';

const account = deriveSigningAccountFromSeed(mnemonicToSeed('zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong'), network);
const VALUE = 100_000_000n;

async function until(what: string, done: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (!(await done())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

const sameTip = async (a: PearldClient, b: PearldClient): Promise<boolean> =>
  (await a.getBestBlockHash()) === (await b.getBestBlockHash());

describeLive('reorganization', () => {
  let second: RunningPearld | undefined;
  afterAll(async () => {
    await second?.stop();
  });

  it('takes an invoice confirmation back when a longer chain replaces its block', { timeout: 600_000 }, async () => {
    second = await startPearld({
      exe: process.env.PEARLD!,
      dir: join(live!.dir, 'pearld-second'),
      miningAddress: miner.deriveAddress(1),
    });
    const other = second.client;
    // A node at genesis has no estimate at all.
    await expect(other.estimateFee(1)).rejects.toMatchObject({
      kind: 'rpc',
      rpcCode: RPC_ERROR_CODES.MISC,
      message: 'estimatefee: not enough blocks have been observed (code -1)',
    });

    const funding = await fund([{ script: toOutputScript(account.deriveAddress(190), network), value: VALUE }]);
    await other.call('node', ['connect', live!.p2p, 'temp']);
    await until('the second node to sync', () => sameTip(pearld, other));
    const forkHeight = await pearld.getBlockCount();

    await other.call('node', ['disconnect', live!.p2p]);
    await until('the nodes to part', async () => (await pearld.call<unknown[]>('getpeerinfo')).length === 0);

    const monitor = new InvoiceMonitor(pearldChainClient(pearld), network);
    const invoiceAddress = account.deriveAddress(191);
    let invoice = monitor.createInvoice({
      id: 'reorg',
      address: invoiceAddress,
      amount: 40_000_000n,
      createdAt: 1000,
      expiresAt: 2000,
      requiredConfirmations: 1,
    });
    const payment = createTransaction(2);
    payment.addInput(funding.getHash(), 0);
    payment.addOutput(toOutputScript(invoiceAddress, network), 40_000_000n);
    addChange(payment, VALUE, [{ type: 'keyPath' }]);
    const psbt = createPsbt(payment);
    account.prepareInput(psbt, 0, { index: 190, value: VALUE });
    account.signInput(psbt, 0, { index: 190 });
    const signed = finalizePsbt(psbt);
    const txid = transactionId(signed);
    await broadcast(signed);
    const [replaced] = await mine(1);
    invoice = await monitor.refreshInvoice(invoice, 1500);
    expect(invoice).toMatchObject({ state: 'confirmed', confirmations: 1, paidAmount: 40_000_000n });

    // The second node never saw the payment and mines a longer chain without it.
    const longer = await mineBlocks(other, 2);
    // A pearld that is caught up only syncs from peers it dialed itself, so
    // the first node has to be the one that connects.
    await pearld.call('node', ['connect', second.p2p, 'temp']);
    await until('the first node to reorganize', () => sameTip(pearld, other));
    expect(await pearld.getBlockCount()).toBe(forkHeight + 2);
    expect(await pearld.getBlockHash(forkHeight + 1)).toBe(longer[0]);
    expect(await pearld.getBlockHash(forkHeight + 1)).not.toBe(replaced);

    await until('the payment to return to the mempool', async () => (await pearld.getRawMempool()).includes(txid));
    expect(await pearld.getRawTransaction(txid)).not.toHaveProperty('blockhash');
    invoice = await monitor.refreshInvoice(invoice, 1500);
    expect(invoice).toMatchObject({ state: 'pending', confirmations: 0, paidAmount: 40_000_000n });
    expect(invoice.observedPayments).toEqual([{ txid, firstSeenAt: 1500 }]);

    const [again] = await mine(1);
    expect(again).not.toBe(replaced);
    invoice = await monitor.refreshInvoice(invoice, 3000);
    expect(invoice).toMatchObject({ state: 'confirmed', confirmations: 1, paidAmount: 40_000_000n });
    expect(await pearld.getRawTransaction(txid)).toMatchObject({ blockhash: again, confirmations: 1 });
    await until('the second node to follow', () => sameTip(pearld, other));
  });
});
