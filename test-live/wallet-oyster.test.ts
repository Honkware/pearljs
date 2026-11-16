// PearlWallet beside a running Oyster that holds the same mnemonic: a wallet
// restored from its keystore, with and without a state backup, comes to
// Oyster's balance and coins; a send of Oyster's conflicts a pearljs send
// that never reached the node; and a wallet over oysterBackend and
// oysterTransactionSource receives, sends, sends twice at once and bumps a
// fee, with Oyster agreeing at every step.

import { beforeAll, expect, it } from 'vitest';
import {
  createMemoryStore,
  deriveAccountFromSeed,
  mnemonicToSeed,
  oysterBackend,
  oysterTransactionSource,
  PearldClient,
  pearldBackend,
  PearlRpcError,
  PearlWallet,
  toOutputScript,
  WalletError,
} from '../src/index.js';
import { clientOptions, OYSTER_MNEMONIC, OYSTER_PASSPHRASE } from './context.js';
import { describeOyster, eventually, FEE_RATE, fund, live, mine, network, nowhere, oyster, pearld } from './chain.js';
import { connection, expectSendMatchesNode, nodeBackend, nodeView, outpoint, outsider, PASSPHRASE, QUICK_KDF, recordEvents } from './wallets.js';

const { payPending, elsewhere } = outsider(10);
const watching = deriveAccountFromSeed(mnemonicToSeed(OYSTER_MNEMONIC), network);

/** Waits until Oyster has processed pearld's tip. */
async function synced(): Promise<void> {
  const tip = await pearld.getBlockCount();
  expect((await eventually(() => oyster.getBestBlock(), (best) => best.height === tip)).height).toBe(tip);
}

/** Oyster's unspent outputs of its seed account, unconfirmed ones included. */
async function oysterCoins(): Promise<string[]> {
  return (await oyster.listUnspent(0)).filter((entry) => entry.account === 'default').map(outpoint).sort();
}

const create = (backend = nodeBackend): Promise<PearlWallet> =>
  PearlWallet.create({ ...connection(createMemoryStore(), backend), mnemonic: OYSTER_MNEMONIC, passphrase: PASSPHRASE, kdf: QUICK_KDF });

describeOyster('wallet state beside Oyster', () => {
  beforeAll(async () => {
    await oyster.walletPassphrase(OYSTER_PASSPHRASE, 3600);
    const outputs = [];
    for (const value of [40_000_000n, 25_000_000n, 10_000_000n]) outputs.push({ script: toOutputScript(await oyster.getNewAddress(), network), value });
    await fund(outputs);
    await synced();
  });

  it('restores from a keystore alone, and with a state backup, to the balance and coins Oyster has for the same mnemonic', async () => {
    const original = await create();
    await original.sync();
    const balance = await oyster.getBalance('default');
    expect(balance).toBeGreaterThanOrEqual(75_000_000n);
    expect(original.balance()).toEqual({ confirmed: balance, unconfirmed: 0n, immature: 0n, locked: 0n, total: balance });
    expect(original.coins().map(outpoint).sort()).toEqual(await oysterCoins());
    // The change address Oyster would use next is the one the wallet would.
    const nextChange = original.accounts()[0]!.nextChangeIndex;
    expect(await oyster.getRawChangeAddress()).toBe(watching.deriveAddress(nextChange, true));

    const keystore = original.exportKeystore();
    const backup = await original.exportState();
    await original.close();

    const fromKeys = await PearlWallet.restore({ ...connection(createMemoryStore()), keystore, passphrase: PASSPHRASE });
    await fromKeys.sync();
    expect(fromKeys.balance().confirmed).toBe(balance);
    expect(fromKeys.coins().map(outpoint).sort()).toEqual(await oysterCoins());
    expect(fromKeys.accounts()[0]!.nextChangeIndex).toBe(nextChange);
    await fromKeys.close();

    const withState = await PearlWallet.restore({ ...connection(createMemoryStore()), keystore, backup, passphrase: PASSPHRASE });
    expect(withState.balance().confirmed).toBe(balance);
    await withState.sync();
    expect(withState.balance().confirmed).toBe(await oyster.getBalance('default'));
    expect(withState.coins().map(outpoint).sort()).toEqual(await oysterCoins());
    await withState.close();
  });

  it('marks a pending send conflicted when Oyster spends the same coins first', async () => {
    // The wallet reads from the node, and its broadcasts go to a port nothing listens on.
    const unreachable = pearldBackend(new PearldClient({ ...clientOptions(live?.pearld ?? nowhere), url: 'https://127.0.0.1:1', retry: false }), { network });
    const wallet = await create({ ...nodeBackend, broadcast: (tx) => unreachable.broadcast(tx) });
    await wallet.sync();
    const before = wallet.balance().confirmed;

    // Every coin of the account, so whatever Oyster picks is among them.
    const lost = (await wallet.send({ recipients: [{ address: elsewhere(0), amount: 'max' }], feeRate: FEE_RATE }).catch((err: unknown) => err)) as WalletError;
    expect(lost).toBeInstanceOf(WalletError);
    expect(lost.code).toBe('WALLET_BROADCAST_UNCERTAIN');
    expect(lost.cause).toBeInstanceOf(PearlRpcError);
    expect(lost.cause).toMatchObject({ code: 'RPC_NETWORK', kind: 'network', method: 'sendrawtransaction' });
    const [pending] = wallet.history().filter((entry) => entry.status === 'pending');
    expect(wallet.transaction(pending!.txid)).toMatchObject({ direction: 'outgoing', broadcast: false, sent: before });
    expect(wallet.balance().total).toBe(0n);
    expect(await pearld.getRawMempool()).not.toContain(pending!.txid);

    const conflicts = recordEvents(wallet, 'conflict');
    const rival = await oyster.sendToAddress(elsewhere(1), 3_000_000n, FEE_RATE);
    expect(await pearld.getRawMempool()).toContain(rival);
    await wallet.sync();
    expect(wallet.transaction(pending!.txid)).toMatchObject({ status: 'conflicted', by: rival });
    expect(conflicts.seen).toEqual([{ txid: pending!.txid, status: 'conflicted', by: rival }]);
    // Oyster's send is the wallet's own, since the keys are the same.
    const view = await nodeView(rival);
    expect(wallet.transaction(rival)).toMatchObject({ status: 'pending', direction: 'outgoing', fee: view.fee, counterparties: [elsewhere(1)] });
    expect(wallet.balance().total).toBe(before - 3_000_000n - view.fee);
    expect(await wallet.rebroadcast()).toEqual([]);

    await mine(1);
    await synced();
    await wallet.sync();
    expect(wallet.transaction(rival)).toMatchObject({ status: 'confirmed', confirmations: 1 });
    expect(wallet.transaction(pending!.txid)).toMatchObject({ status: 'conflicted', by: rival });
    expect(wallet.balance().confirmed).toBe(await oyster.getBalance('default'));
    expect(wallet.coins().map(outpoint).sort()).toEqual(await oysterCoins());
    await wallet.close();
  });

  it('receives, sends, sends twice at once and bumps a fee over oysterBackend, and Oyster agrees each time', async () => {
    const backend = oysterBackend(oyster, { network });
    const wallet = await PearlWallet.create({
      store: createMemoryStore(),
      backend,
      transactions: oysterTransactionSource(oyster),
      mnemonic: OYSTER_MNEMONIC,
      passphrase: PASSPHRASE,
      kdf: QUICK_KDF,
    });
    const agree = async (): Promise<void> => {
      await synced();
      await wallet.sync();
      expect(wallet.balance().confirmed).toBe(await oyster.getBalance('default'));
      expect(wallet.balance().unconfirmed).toBe(await oyster.getUnconfirmedBalance());
      expect(wallet.coins().map(outpoint).sort()).toEqual(await oysterCoins());
      expect(wallet.tip).toEqual(await nodeBackend.getTip());
    };
    await agree();

    // Receive at an address Oyster hands out: Oyster only watches addresses it has derived itself.
    const address = await oyster.getNewAddress();
    const received = await payPending(address, 6_000_000n);
    await eventually(() => oyster.getUnconfirmedBalance(), (unconfirmed) => unconfirmed === 6_000_000n);
    await wallet.sync();
    expect(wallet.transaction(received)).toMatchObject({ status: 'pending', direction: 'incoming', amount: 6_000_000n });
    await mine(1);
    await agree();
    expect(wallet.transaction(received)).toMatchObject({ status: 'confirmed', confirmations: 1 });

    // Send through Oyster's connection to its pearld.
    const recipients = [{ address: elsewhere(10), amount: 4_000_000n }];
    const sent = await wallet.send({ recipients, feeRate: FEE_RATE });
    await expectSendMatchesNode(wallet, sent, recipients);
    expect(await eventually(() => oyster.getTransaction(sent.txid).catch(() => null), (tx) => tx !== null)).toMatchObject({ txid: sent.txid, fee: sent.fee });
    await mine(1);
    await agree();
    expect(wallet.transaction(sent.txid)).toMatchObject({ status: 'confirmed', fee: sent.fee });

    const pair = await Promise.all([11, 12].map((n) => wallet.send({ recipients: [{ address: elsewhere(n), amount: 2_000_000n }], feeRate: FEE_RATE })));
    const spent = pair.flatMap((result) => result.inputs.map(outpoint));
    expect(new Set(spent).size).toBe(spent.length);
    expect(await pearld.getRawMempool()).toEqual(expect.arrayContaining(pair.map((result) => result.txid)));
    await mine(1);
    await agree();

    const original = await wallet.send({ recipients: [{ address: elsewhere(13), amount: 1_000_000n }], feeRate: FEE_RATE, rbf: true });
    const bumped = await wallet.bumpFee(original.txid, { feeRate: 6000n });
    expect(await pearld.getRawMempool()).toContain(bumped.txid);
    expect(await pearld.getRawMempool()).not.toContain(original.txid);
    expect(wallet.transaction(original.txid)).toMatchObject({ status: 'replaced', by: bumped.txid });
    await mine(1);
    await agree();
    expect(wallet.transaction(bumped.txid)).toMatchObject({ status: 'confirmed', fee: bumped.fee });
    expect(wallet.transaction(original.txid)).toMatchObject({ status: 'replaced', by: bumped.txid });
    await wallet.close();
  });
});
