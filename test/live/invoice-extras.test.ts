// Invoices against a regtest pearld beyond the monitor test: a payment mined
// before expiry that the first refresh only sees after it, and one mined at
// expiry that does not count; a payment moved to another block by a reorg;
// watchInvoices over a real websocket to a second pearld that is restarted;
// fetchPayerInputs; InvoiceIndexAllocator on an account Oyster then restores;
// and an invoice on a P2MR address whose block time comes from the filter scan.

import { join } from 'node:path';
import { WebSocket } from 'undici';
import { expect, it } from 'vitest';
import {
  assembleScriptTree,
  checksigScript,
  createInvoice,
  deriveSigningAccountFromSeed,
  fetchPayerInputs,
  generateMnemonic,
  InvoiceGapError,
  InvoiceIndexAllocator,
  mnemonicToSeed,
  p2mrAddress,
  payFromAccount,
  pearldBackend,
  pearldChainClient,
  pearldTransactionSource,
  PearlWsClient,
  refreshInvoice,
  toOutputScript,
  watchInvoices,
} from '../../src/index.js';
import type { Invoice } from '../../src/index.js';
import { OYSTER_PASSPHRASE, trustingAgent } from './context.js';
import { describeLive, eventually, FEE_RATE, fund, live, mine, network, pearld } from './chain.js';
import { nodeView, outsider } from './wallets.js';
import { freePort, startOyster, startPearld } from './processes.js';
import type { RunningPearld } from './processes.js';

// A new phrase each run: every file shares one chain.
const shop = deriveSigningAccountFromSeed(mnemonicToSeed(generateMnemonic()), network);
const { payPending, lastPayer } = outsider(14);
const chain = pearldChainClient(pearld);
let invoiceCount = 0;

function invoice(address: string, amount: bigint, window: { createdAt: number; expiresAt: number }, requiredConfirmations = 1): Invoice {
  return createInvoice({ id: `live-${invoiceCount++}`, address, amount, requiredConfirmations, ...window }, network);
}

describeLive('invoice expiry against block time', () => {
  it('counts a payment mined before expiry that the first refresh only sees after it, and not one mined at expiry', async () => {
    const early = shop.deriveAddress(0);
    const late = shop.deriveAddress(1);
    const first = await payPending(early, 4_000_000n);
    const [hash] = await mine(1);
    const time = (await pearld.getBlockHeader(hash!)).time;
    const second = await payPending(late, 4_000_000n);
    const [lateHash] = await mine(1);
    const lateTime = (await pearld.getBlockHeader(lateHash!)).time;

    // Expiry one second after the block: the record is first refreshed long after it.
    const onTime = await refreshInvoice(invoice(early, 4_000_000n, { createdAt: time - 600, expiresAt: time + 1 }), chain, time + 86_400);
    expect(onTime).toMatchObject({ state: 'confirmed', paidAmount: 4_000_000n, uncountedAmount: 0n });
    expect(onTime.payments).toMatchObject([{ txid: first, status: 'confirmed', firstBlockTime: time, onTime: true, counted: true, block: { hash, time } }]);
    expect(onTime.payments[0]!.firstSeenAt).toBe(time + 86_400);

    // Expiry at the block's own time: not before it, so it does not count.
    const atExpiry = await refreshInvoice(invoice(late, 4_000_000n, { createdAt: lateTime - 600, expiresAt: lateTime }), chain, lateTime + 86_400);
    expect(atExpiry).toMatchObject({ state: 'expired', paidAmount: 0n, uncountedAmount: 4_000_000n });
    expect(atExpiry.payments).toMatchObject([{ txid: second, firstBlockTime: lateTime, onTime: false, counted: false }]);
  });
});

describeLive('invoice payers', () => {
  it('names the inputs of a payment with the address and value each spent, as the node has them', async () => {
    const txid = await payPending(shop.deriveAddress(2), 3_000_000n);
    const inputs = await fetchPayerInputs(txid, pearldTransactionSource(pearld), network);
    const view = await nodeView(txid);
    expect(inputs).toEqual(view.inputs.map(({ txid: from, vout, value, address }) => ({ txid: from, vout, amount: value, address })));
    expect(inputs.map((input) => input.address)).toEqual([lastPayer()]);
    await expect(fetchPayerInputs('00'.repeat(32), pearldTransactionSource(pearld), network)).rejects.toMatchObject({ code: 'INVOICE_PAYER_UNKNOWN' });
    await mine(1);
  });
});

describeLive('invoice through a reorg', () => {
  it('follows a payment its block lost to a reorg back to the mempool and into the block that replaced it', async () => {
    const address = shop.deriveAddress(3);
    const now = Math.floor(Date.now() / 1000);
    let record = invoice(address, 5_000_000n, { createdAt: now - 60, expiresAt: now + 86_400 }, 2);
    const txid = await payPending(address, 5_000_000n);
    const [first] = await mine(1);
    record = await refreshInvoice(record, chain, now);
    expect(record).toMatchObject({ state: 'confirming', confirmations: 1 });
    expect(record.payments[0]!.block).toMatchObject({ hash: first });

    await pearld.invalidateBlock(first!);
    record = await refreshInvoice(record, chain, now);
    expect(record).toMatchObject({ state: 'pending', confirmations: 0 });
    expect(record.payments).toMatchObject([{ txid, status: 'unconfirmed', block: null, counted: true }]);

    const [replacement] = await mine(1);
    expect(replacement).not.toBe(first);
    await pearld.reconsiderBlock(first!);
    await mine(1);
    expect(await pearld.getRawTransaction(txid)).toMatchObject({ blockhash: replacement, confirmations: 2 });
    record = await refreshInvoice(record, chain, now);
    expect(record).toMatchObject({ state: 'confirmed', confirmations: 2 });
    expect(record.payments).toMatchObject([{ txid, block: { hash: replacement }, firstBlockTime: expect.any(Number) as number }]);
  });
});

describeLive('watchInvoices over a websocket', () => {
  it('follows an invoice from the mempool to confirmed across a restart of the pearld it watches', async () => {
    const options = { exe: process.env.PEARLD!, dir: join(live!.dir, 'pearld-invoices'), miningAddress: shop.deriveAddress(99), rpcPort: await freePort(), extraArgs: [`--connect=${live!.p2p}`] };
    let second: RunningPearld = await startPearld(options);
    const agent = trustingAgent(second.endpoint.ca);
    const ws = new PearlWsClient({ url: second.endpoint.url, username: second.endpoint.username, password: second.endpoint.password, WebSocket, webSocketInit: { dispatcher: agent }, reconnect: { initialDelay: 200, maxDelay: 1000 } });
    const changes: Invoice[] = [];
    const errors: Error[] = [];
    try {
      const tip = await pearld.getBestBlockHash();
      await eventually(() => second.client.getBestBlockHash(), (hash) => hash === tip);
      const address = shop.deriveAddress(4);
      const now = Math.floor(Date.now() / 1000);
      const watcher = watchInvoices({
        client: pearldChainClient(ws),
        network,
        ws,
        invoices: [invoice(address, 6_000_000n, { createdAt: now - 60, expiresAt: now + 86_400 })],
        onChange: (next) => void changes.push(next),
        onError: (error) => void errors.push(error),
        pollInterval: 3_600_000,
      });
      await watcher.refresh();
      expect(watcher.invoices()).toMatchObject([{ state: 'awaiting' }]);

      // The payment goes to the watched node; the suite's node mines it.
      const payer = deriveSigningAccountFromSeed(mnemonicToSeed(generateMnemonic()), network);
      const funding = await fund([{ script: toOutputScript(payer.deriveAddress(0), network), value: 10_000_000n }]);
      const height = await pearld.getBlockCount();
      await eventually(() => second.client.getBlockCount(), (count) => count === height);
      const payment = payFromAccount(payer, {
        network,
        utxos: [{ txid: funding.getId(), vout: 0, value: 10_000_000n, script: funding.outs[0]!.script, confirmations: 1, index: 0 }],
        recipients: [{ address, amount: 6_000_000n }],
        feeRate: FEE_RATE,
        changeAddress: payer.deriveAddress(0, true),
      });
      await second.client.sendRawTransaction(payment.hex);
      await eventually(async () => changes.at(-1)?.state, (state) => state === 'pending');
      expect(changes.at(-1)).toMatchObject({ state: 'pending', payments: [{ txid: payment.txid, status: 'unconfirmed' }] });
      await pearld.sendRawTransaction(payment.hex).catch(() => payment.txid);

      // Down while the block is mined, up again with an empty chain that syncs from the suite's node.
      await second.stop();
      await mine(1);
      second = await startPearld(options);
      const confirmed = await eventually(async () => changes.at(-1), (last) => last?.state === 'confirmed', 120_000);
      expect(confirmed).toMatchObject({ state: 'confirmed', confirmations: 1, payments: [{ txid: payment.txid, status: 'confirmed' }] });
      await watcher.stop();
      // Refreshes that met the node down are reported, never thrown.
      for (const error of errors) expect(error).toMatchObject({ name: 'PearlRpcError' });
    } finally {
      await ws.close();
      await agent.close();
      await second.stop();
    }
  });
});

describeLive('invoice index allocation', () => {
  it.skipIf(live?.oyster === null || live?.oyster === undefined)('hands out indices that an Oyster restored from the same mnemonic finds paid, and reuses an unpaid one', async () => {
    const mnemonic = generateMnemonic();
    const account = deriveSigningAccountFromSeed(mnemonicToSeed(mnemonic), network);
    const allocator = new InvoiceIndexAllocator({ deriveAddress: (index) => account.deriveAddress(index), client: chain, gapLimit: 6, reuseAfter: 0 });
    const now = Math.floor(Date.now() / 1000);
    const handed = [];
    // Handed out before the invoices made with them, as an allocator records it.
    for (let i = 0; i < 6; i += 1) handed.push(await allocator.allocate(now - 200));
    expect(handed.map((item) => item.index)).toEqual([0, 1, 2, 3, 4, 5]);
    await expect(allocator.allocate(now - 200)).rejects.toBeInstanceOf(InvoiceGapError);

    // Index 4 is paid, index 1 expires unpaid and is handed out again.
    const paid = await payPending(handed[4]!.address, 2_500_000n);
    await mine(1);
    const records = handed.map((item) => invoice(item.address, 2_500_000n, { createdAt: now - 120, expiresAt: now - 60 }));
    for (const [i, record] of records.entries()) allocator.track(i, await refreshInvoice(record, chain, now));
    expect(allocator.toJson()).toMatchObject({ lastUsed: 4, next: 6 });
    const reused = await allocator.allocate(now);
    expect(reused).toMatchObject({ index: 0, reused: true });
    const restored = new InvoiceIndexAllocator({ deriveAddress: (index) => account.deriveAddress(index), client: chain, state: allocator.toJson(), gapLimit: 6, reuseAfter: 0 });
    expect((await restored.allocate(now)).index).toBe(1);
    const third = await restored.allocate(now);
    expect(third).toMatchObject({ index: 2, reused: true });
    const later = await payPending(third.address, 1_500_000n);
    await mine(1);

    // A new Oyster created from the mnemonic finds both payments.
    const oyster = await startOyster({ exe: process.env.OYSTER!, dir: join(live!.dir, 'oyster-invoices'), pearld: live!.pearld, mnemonic, passphrase: OYSTER_PASSPHRASE });
    try {
      const balance = await eventually(() => oyster.client.getBalance(), (value) => value === 4_000_000n, 120_000);
      expect(balance).toBe(4_000_000n);
      const unspent = await oyster.client.listUnspent();
      expect(unspent.map((utxo) => utxo.txid).sort()).toEqual([paid, later].sort());
    } finally {
      await oyster.stop();
    }
  });
});

describeLive('invoice on a P2MR address', () => {
  it('gets the block time of a payment to a P2MR address through pearldBackend\'s filter scan', async () => {
    const birthday = await pearld.getBlockCount();
    const address = p2mrAddress({ merkleRoot: assembleScriptTree([checksigScript(shop.derivePublicKey(5))]).root }, network);
    const backend = pearldBackend(pearld, { network, scanFrom: birthday });
    const txid = await payPending(address, 7_000_000n);
    const [hash] = await mine(1);
    const time = (await pearld.getBlockHeader(hash!)).time;
    const height = await pearld.getBlockCount();
    expect(await backend.getAddressActivity(address)).toEqual([{ txid, amount: 7_000_000n, block: { height, hash, time } }]);
    const record = await refreshInvoice(invoice(address, 7_000_000n, { createdAt: time - 600, expiresAt: time + 1 }), backend, time + 3600);
    expect(record).toMatchObject({ state: 'confirmed', paidAmount: 7_000_000n, payments: [{ txid, firstBlockTime: time, onTime: true }] });
  });
});
