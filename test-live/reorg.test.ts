// A reorganization between two regtest pearld nodes on loopback: the suite's
// node confirms an invoice payment in a block that a second node's longer
// chain then replaces. pearld puts the payment back in its mempool, the
// invoice monitor takes the confirmation back, and the next block confirms
// it again. A PearlWallet paid in a block that is then replaced takes the
// receive back to pending and confirms it in the new block, and a wallet
// watching the miner's account marks the replaced block's coinbase orphaned.
// Runs last; the second node only ever peers with the first.

import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import {
  createMemoryStore,
  createPsbt,
  createTransaction,
  deriveSigningAccountFromSeed,
  finalizePsbt,
  InvoiceMonitor,
  mnemonicToSeed,
  parseBlock,
  payFromAccount,
  pearldChainClient,
  PearlWallet,
  RPC_ERROR_CODES,
  toOutputScript,
  transactionId,
} from '../src/index.js';
import type { PearldClient } from '../src/index.js';
import { mineBlocks } from './context.js';
import { addChange, broadcast, describeLive, FEE_RATE, fund, live, mine, miner, network, pearld } from './chain.js';
import { startPearld, type RunningPearld } from './processes.js';
import { connection, nodeBackend, nodeBalance, nodeSocket, PASSPHRASE, QUICK_KDF, recordEvents } from './wallets.js';

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

  it('takes an invoice confirmation back when a longer chain replaces its block', async () => {
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
    expect(invoice.payments).toMatchObject([{ txid, firstSeenAt: 1500, status: 'unconfirmed', counted: true }]);

    const [again] = await mine(1);
    expect(again).not.toBe(replaced);
    invoice = await monitor.refreshInvoice(invoice, 3000);
    expect(invoice).toMatchObject({ state: 'confirmed', confirmations: 1, paidAmount: 40_000_000n });
    expect(await pearld.getRawTransaction(txid)).toMatchObject({ blockhash: again, confirmations: 1 });
    await until('the second node to follow', () => sameTip(pearld, other));
  });

  it('takes a wallet\'s confirmed receive back to pending and orphans the replaced coinbase, then confirms the receive again', async () => {
    const other = second!.client;
    const wallet = await PearlWallet.create({ ...connection(createMemoryStore()), passphrase: PASSPHRASE, unlockTimeout: null, kdf: QUICK_KDF });
    // Every coinbase of the suite's node pays the miner's first address.
    const mining = await PearlWallet.create({ ...connection(createMemoryStore()), watchOnly: miner.watchOnlyAccount().extendedPublicKey(), gapLimit: 5 });
    const address = await wallet.receiveAddress();

    // The payer's coin is on both chains; the payment itself only ever reaches the first node.
    const funding = await fund([{ script: toOutputScript(account.deriveAddress(192), network), value: VALUE }]);
    await until('the second node to sync', () => sameTip(pearld, other));
    const forkHeight = await pearld.getBlockCount();
    await pearld.call('node', ['disconnect', second!.p2p]);
    await until('the nodes to part', async () => (await pearld.call<unknown[]>('getpeerinfo')).length === 0 && (await other.call<unknown[]>('getpeerinfo')).length === 0);
    await mining.sync();
    await wallet.sync();

    const payment = payFromAccount(account, {
      network,
      utxos: [{ txid: funding.getId(), vout: 0, value: VALUE, script: funding.outs[0]!.script, confirmations: 1, index: 192 }],
      recipients: [{ address, amount: 20_000_000n }],
      feeRate: FEE_RATE,
      changeAddress: account.deriveAddress(193),
    });
    await pearld.sendRawTransaction(payment.hex);
    const [replaced] = await mine(1);
    const coinbase = parseBlock(await pearld.getRawBlock(replaced!)).transactions[0]!;
    await wallet.sync();
    await mining.sync();
    const confirmedIn = { height: forkHeight + 1, hash: replaced! };
    expect(wallet.transaction(payment.txid)).toMatchObject({ status: 'confirmed', block: confirmedIn, confirmations: 1 });
    expect(wallet.balance()).toMatchObject({ confirmed: 20_000_000n, unconfirmed: 0n });
    expect(mining.transaction(coinbase.getId())).toMatchObject({ status: 'confirmed', coinbase: true, block: confirmedIn, received: coinbase.outs[0]!.value });
    const immature = mining.balance().immature;
    expect(mining.balance()).toMatchObject(await nodeBalance(mining));

    // A websocket client hears the block leave and the two that replace it arrive, in that order.
    const { ws, close } = nodeSocket();
    const blocks: { type: string; hash: string; height: number }[] = [];
    ws.watchBlocks({ onBlock: ({ type, hash, height }) => blocks.push({ type, hash, height }) });
    await ws.call('getblockcount');

    const longer = await mineBlocks(other, 2);
    await pearld.call('node', ['connect', second!.p2p, 'temp']);
    await until('the first node to reorganize', () => sameTip(pearld, other));
    await until('the payment to return to the mempool', async () => (await pearld.getRawMempool()).includes(payment.txid));
    const tip = { height: forkHeight + 2, hash: longer[1]! };
    expect(await nodeBackend.getTip()).toEqual(tip);
    await until('the block notifications', async () => blocks.length >= 3);
    expect(blocks).toEqual([
      { type: 'disconnected', hash: replaced, height: forkHeight + 1 },
      { type: 'connected', hash: longer[0], height: forkHeight + 1 },
      { type: 'connected', hash: longer[1], height: forkHeight + 2 },
    ]);
    await close();

    const reorgs = recordEvents(wallet, 'reorg');
    await wallet.sync();
    expect(reorgs.seen).toEqual([{ forkHeight: forkHeight + 1, previousTip: confirmedIn, tip }]);
    expect(wallet.transaction(payment.txid)).toMatchObject({ status: 'pending', block: null, confirmations: 0, amount: 20_000_000n });
    expect(wallet.balance()).toMatchObject({ confirmed: 0n, unconfirmed: 20_000_000n });
    expect(wallet.tip).toEqual(tip);

    const conflicts = recordEvents(mining, 'conflict');
    await mining.sync();
    expect(conflicts.seen).toEqual([{ txid: coinbase.getId(), status: 'orphaned', by: null }]);
    expect(mining.transaction(coinbase.getId())).toMatchObject({ status: 'orphaned', block: null, coinbase: true });
    expect(mining.coins().some((coin) => coin.txid === coinbase.getId())).toBe(false);
    // The second node mines to the miner's second address, so both of its coinbases took the orphan's place.
    const gained = longer.length;
    expect(mining.history().filter((entry) => entry.coinbase && entry.block !== null && entry.block.height > forkHeight)).toHaveLength(gained);
    expect(mining.balance().immature).toBeGreaterThan(immature - coinbase.outs[0]!.value);
    expect(mining.balance()).toMatchObject(await nodeBalance(mining));

    const confirmations = recordEvents(wallet, 'confirmation');
    const [again] = await mine(1);
    await wallet.sync();
    const reconfirmed = { height: forkHeight + 3, hash: again! };
    expect(confirmations.seen).toEqual([{ txid: payment.txid, block: reconfirmed }]);
    expect(wallet.transaction(payment.txid)).toMatchObject({ status: 'confirmed', block: reconfirmed, confirmations: 1 });
    expect(wallet.balance()).toMatchObject({ confirmed: 20_000_000n, unconfirmed: 0n });
    await mining.sync();
    expect(mining.transaction(coinbase.getId())).toMatchObject({ status: 'orphaned' });
    expect(mining.balance()).toMatchObject(await nodeBalance(mining));
    await until('the second node to follow', () => sameTip(pearld, other));
    await wallet.close();
    await mining.close();
  });
});
