// PearlWallet on a regtest pearld, in a file store over pearldBackend and
// pearldTransactionSource: a payment received pending and confirmed, sends
// with change, two sends at once, a fee bump, a send the node refuses, a
// send made while a sync is held up, a process killed mid-sync, restores
// from the keystore with and without a state backup, an XMSS key through a
// restore, and watch() over a websocket. Every balance, fee and counterparty
// is compared with what the node itself reports.

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildSync } from 'esbuild';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  createMemoryStore,
  deriveSigningAccountFromSeed,
  InsufficientFundsError,
  KeystoreError,
  mnemonicToSeed,
  payFromAccount,
  pearldBackend,
  pearldTransactionSource,
  PearlRpcError,
  PearlWallet,
  RPC_ERROR_CODES,
  StoreError,
  toOutputScript,
  WalletError,
  XmssError,
} from '../src/index.js';
import type { HistoryEntry, JsonValue, SendResult, WalletCoin } from '../src/index.js';
import { createFileStore } from '../src/store-file.js';
import { describeLive, FEE_RATE, fund, live, mine, network, nowhere, pearld } from './chain.js';
import { connection, expectSendMatchesNode, holdable, nodeBackend, nodeBalance, nodeSocket, nodeView, outpoint, outsider, PASSPHRASE, QUICK_KDF, recordEvents } from './wallets.js';

const { payPending, elsewhere, lastPayer } = outsider(9);
let confirmedWhenAnnounced: bigint | undefined;
let ownSpendsSeen: number | undefined;

describeLive('wallet state on pearld', () => {
  const dir = join(live?.dir ?? '.', 'wallets');
  const path = join(dir, 'wallet.json');
  const backend = holdable(nodeBackend);
  let wallet: PearlWallet;
  let firstAddress: string;

  const settle = async (): Promise<void> => {
    await mine(1);
    await wallet.sync();
    const node = await nodeBalance(wallet);
    expect(wallet.balance()).toEqual({ ...node, locked: 0n, total: node.confirmed + node.unconfirmed + node.immature });
    expect(wallet.tip).toEqual(await nodeBackend.getTip());
  };

  beforeAll(() => {
    if (live !== null) mkdirSync(dir, { recursive: true });
  });
  afterAll(async () => {
    await wallet?.close();
  });

  it('creates an encrypted wallet in a file and shows a payment pending and then confirmed, as the node has it', async () => {
    wallet = await PearlWallet.create({ ...connection(createFileStore(path, { create: true }), backend), passphrase: PASSPHRASE, unlockTimeoutMs: null });
    const phrase = (await wallet.mnemonic())!;
    expect(phrase.split(' ')).toHaveLength(24);
    const file = storeText(path);
    expect(file).toContain('"pearljs-keystore"');
    for (const word of new Set(phrase.split(' '))) expect(file).not.toContain(`${word} `);
    expect(wallet.accounts()).toMatchObject([{ id: '0', kind: 'seed', number: 0, nextReceiveIndex: 0, nextChangeIndex: 0 }]);
    const account = deriveSigningAccountFromSeed(mnemonicToSeed(phrase), network);
    expect(wallet.accounts()[0]!.xpub).toBe(account.watchOnlyAccount().extendedPublicKey());

    firstAddress = await wallet.receiveAddress({ label: 'first' });
    const second = await wallet.receiveAddress();
    expect([firstAddress, second]).toEqual([account.deriveAddress(0), account.deriveAddress(1)]);
    await wallet.sync();
    expect(wallet.balance()).toEqual({ confirmed: 0n, unconfirmed: 0n, immature: 0n, locked: 0n, total: 0n });
    expect(wallet.history()).toEqual([]);

    const confirmations = recordEvents(wallet, 'confirmation');
    const transactions = recordEvents(wallet, 'transaction');
    const txid = await payPending(firstAddress, 50_000_000n);
    await wallet.sync();
    const view = await nodeView(txid);
    const pending: Partial<HistoryEntry> = {
      txid,
      status: 'pending',
      block: null,
      confirmations: 0,
      direction: 'incoming',
      received: 50_000_000n,
      sent: 0n,
      amount: 50_000_000n,
      fee: view.fee,
      counterparties: [lastPayer()],
      coinbase: false,
    };
    expect(wallet.history()).toMatchObject([pending]);
    expect(transactions.seen).toMatchObject([pending]);
    expect(wallet.balance()).toMatchObject({ confirmed: 0n, unconfirmed: 50_000_000n, total: 50_000_000n });
    expect(wallet.balance()).toMatchObject(await nodeBalance(wallet));

    const [hash] = await mine(1);
    await wallet.sync();
    const block = { height: await pearld.getBlockCount(), hash: hash! };
    expect(wallet.history()).toMatchObject([{ ...pending, status: 'confirmed', block, confirmations: 1 }]);
    expect(confirmations.seen).toEqual([{ txid, block }]);
    expect(wallet.balance()).toMatchObject({ confirmed: 50_000_000n, unconfirmed: 0n });

    const funding = await fund([{ script: toOutputScript(second, network), value: 30_000_000n }]);
    await wallet.sync();
    expect(wallet.balance()).toEqual({ confirmed: 80_000_000n, unconfirmed: 0n, immature: 0n, locked: 0n, total: 80_000_000n });
    expect(wallet.balance()).toMatchObject(await nodeBalance(wallet));
    expect(wallet.tip).toEqual(await nodeBackend.getTip());
    const fundingView = await nodeView(funding.getId());
    expect(wallet.history()).toMatchObject([
      { txid: funding.getId(), status: 'confirmed', confirmations: 1, amount: 30_000_000n, fee: fundingView.fee, counterparties: [fundingView.inputs[0]!.address] },
      { txid, confirmations: 2 },
    ]);
    expect(wallet.addresses()).toMatchObject([
      { address: firstAddress, index: 0, change: false, label: 'first', used: true },
      { address: second, index: 1, change: false, label: null, used: true },
    ]);
    expect(await wallet.currentAddress()).toBe(account.deriveAddress(2));
    transactions.off();
    confirmations.off();
  });

  it('sends with change, and the fee, inputs, counterparties and change are the ones getrawtransaction shows', async () => {
    const recipients = [{ address: elsewhere(0), amount: 12_000_000n }];
    const sent = await wallet.send({ recipients, feeRate: FEE_RATE, label: 'first send' });
    expect((await pearld.getRawMempoolVerbose())[sent.txid]).toMatchObject({ fee: sent.fee, vsize: sent.vsize });
    await expectSendMatchesNode(wallet, sent, recipients);
    expect(wallet.transaction(sent.txid)).toMatchObject({ status: 'pending', label: 'first send' });

    // The change is the wallet's own, on its change chain, and waits unconfirmed.
    expect(sent.inputs).toMatchObject([{ value: 50_000_000n }]);
    expect(sent.change).toBe(38_000_000n - sent.fee);
    const change = wallet.coins().find((coin) => coin.txid === sent.txid)!;
    expect(change).toMatchObject({ address: sent.changeAddress, value: sent.change, confirmations: 0, owner: { type: 'account', account: '0', change: true, index: 0 } });
    expect(wallet.accounts()[0]).toMatchObject({ nextChangeIndex: 1 });
    expect(wallet.balance()).toMatchObject({ confirmed: 30_000_000n, unconfirmed: sent.change });
    expect(wallet.balance()).toMatchObject(await nodeBalance(wallet));

    await settle();
    expect(wallet.transaction(sent.txid)).toMatchObject({ status: 'confirmed', confirmations: 1 });
    expect(wallet.balance().confirmed).toBe(68_000_000n - sent.fee);
    await expectSendMatchesNode(wallet, sent, recipients);
  });

  it('never gives two sends fired at once the same coin, and refuses the third for lack of one', async () => {
    const before = wallet.coins();
    expect(before).toHaveLength(2);
    const recipients = [0, 1, 2].map((n) => [{ address: elsewhere(10 + n), amount: 5_000_000n }]);
    const results = await Promise.allSettled(recipients.map((to) => wallet.send({ recipients: to, feeRate: FEE_RATE })));
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled', 'rejected']);
    const [a, b] = results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
    // Both confirmed coins are taken, and the change of each send is not confirmed yet.
    const refused = (results[2] as PromiseRejectedResult).reason as InsufficientFundsError;
    expect(refused).toBeInstanceOf(InsufficientFundsError);
    expect(refused).toMatchObject({ code: 'INSUFFICIENT_FUNDS', available: 0n });

    const spent = [...a!.inputs, ...b!.inputs].map(outpoint);
    expect(new Set(spent).size).toBe(spent.length);
    expect(spent.sort()).toEqual(before.map(outpoint).sort());
    const mempool = await pearld.getRawMempool();
    expect(mempool).toEqual(expect.arrayContaining([a!.txid, b!.txid]));
    await expectSendMatchesNode(wallet, a!, recipients[0]!);
    await expectSendMatchesNode(wallet, b!, recipients[1]!);
    await settle();
    expect(wallet.history().filter((entry) => entry.status === 'confirmed')).toHaveLength(5);
  });

  it('replaces a signalling send with bumpFee and shows the original as replaced', async () => {
    const recipients = [{ address: elsewhere(20), amount: 4_000_000n }];
    const plain = await wallet.send({ recipients: [{ address: elsewhere(21), amount: 3_000_000n }], feeRate: FEE_RATE });
    const notReplaceable = await wallet.bumpFee(plain.txid, { feeRate: 6000n }).catch((err: unknown) => err);
    expect(notReplaceable).toBeInstanceOf(WalletError);
    expect(notReplaceable).toMatchObject({ code: 'WALLET_NOT_REPLACEABLE' });

    const conflicts = recordEvents(wallet, 'conflict');
    const original = await wallet.send({ recipients, feeRate: FEE_RATE, rbf: true, label: 'in a hurry' });
    expect((await nodeView(original.txid)).rbf).toBe(true);
    const bumped = await wallet.bumpFee(original.txid, { feeRate: 6000n });
    expect(bumped.replaces).toBe(original.txid);
    expect(bumped.inputs.map(outpoint)).toEqual(original.inputs.map(outpoint));
    expect(bumped.changeAddress).toBe(original.changeAddress);
    expect(bumped.fee).toBeGreaterThan(original.fee);

    // pearld took the replacement and dropped the original.
    const mempool = await pearld.getRawMempoolVerbose();
    expect(mempool[bumped.txid]).toMatchObject({ fee: bumped.fee, vsize: bumped.vsize });
    expect(mempool[original.txid]).toBeUndefined();
    await expect(pearld.getRawTransaction(original.txid)).rejects.toMatchObject({ code: 'RPC_ERROR', rpcCode: RPC_ERROR_CODES.INVALID_ADDRESS_OR_KEY });
    await expectSendMatchesNode(wallet, bumped, recipients);
    expect((await nodeView(bumped.txid)).feeRate).toBeGreaterThanOrEqual(6000n);

    expect(wallet.transaction(original.txid)).toMatchObject({ status: 'replaced', by: bumped.txid, label: 'in a hurry' });
    expect(wallet.transaction(bumped.txid)).toMatchObject({ status: 'pending', label: 'in a hurry' });
    expect(conflicts.seen).toEqual([{ txid: original.txid, status: 'replaced', by: bumped.txid }]);
    expect(wallet.balance().unconfirmed).toBe(plain.change + bumped.change);
    conflicts.off();

    await settle();
    expect(wallet.transaction(bumped.txid)).toMatchObject({ status: 'confirmed', confirmations: 1 });
    expect(wallet.transaction(original.txid)).toMatchObject({ status: 'replaced', by: bumped.txid, block: null });
    await wallet.sync({ full: true });
    expect(wallet.transaction(original.txid)).toMatchObject({ status: 'replaced' });
  });

  it('takes a send back out when the node refuses it, with the node\'s error as the cause', async () => {
    // The same seed spends the wallet's largest coin somewhere else, and the wallet has not synced since.
    const outside = deriveSigningAccountFromSeed(mnemonicToSeed((await wallet.mnemonic())!), network);
    const coin = wallet.coins().reduce((largest, next) => (next.value > largest.value ? next : largest));
    const owner = coin.owner as Extract<WalletCoin['owner'], { type: 'account' }>;
    const elsewhereSpend = payFromAccount(outside, {
      network,
      utxos: [{ ...coin, index: owner.index, change: owner.change }],
      recipients: [{ address: elsewhere(30), amount: 'max' }],
      feeRate: FEE_RATE,
    });
    await pearld.sendRawTransaction(elsewhereSpend.hex);
    const before = { balance: wallet.balance(), history: wallet.history() };

    const refused = (await wallet.send({ recipients: [{ address: elsewhere(31), amount: 1_000_000n }], feeRate: FEE_RATE }).catch((err: unknown) => err)) as WalletError;
    expect(refused).toBeInstanceOf(WalletError);
    expect(refused.code).toBe('WALLET_BROADCAST_REFUSED');
    expect(refused.cause).toBeInstanceOf(PearlRpcError);
    expect(refused.cause).toMatchObject({ code: 'RPC_ERROR', kind: 'rpc', method: 'sendrawtransaction', rpcCode: RPC_ERROR_CODES.TX_REJECTED });
    // Nothing of the refused send is left, in memory or in the file.
    expect(wallet.balance()).toEqual(before.balance);
    expect(wallet.history()).toEqual(before.history);

    await wallet.sync();
    expect(wallet.transaction(elsewhereSpend.txid)).toMatchObject({ status: 'pending', direction: 'outgoing', fee: elsewhereSpend.fee, counterparties: [elsewhere(30)] });
    expect(wallet.coins().map(outpoint)).not.toContain(outpoint(coin));
    await settle();
  });

  it('sends at once while a sync is held up, and the sync that finishes afterwards counts the send', async () => {
    let release = (): void => {};
    backend.hold = new Promise((resolve) => (release = resolve));
    let finished = false;
    const syncing = wallet.sync({ full: true }).then(() => (finished = true));
    while (backend.held === 0) await new Promise((resolve) => setTimeout(resolve, 20));

    const recipients = [{ address: elsewhere(40), amount: 2_000_000n }];
    const sent = await wallet.send({ recipients, feeRate: FEE_RATE });
    expect(finished).toBe(false);
    expect(await pearld.getRawMempool()).toContain(sent.txid);

    backend.hold = null;
    release();
    await syncing;
    expect(finished).toBe(true);
    await expectSendMatchesNode(wallet, sent, recipients);
    expect(wallet.transaction(sent.txid)).toMatchObject({ status: 'pending' });
    expect(wallet.balance().unconfirmed).toBe(sent.change);
    expect(wallet.balance()).toMatchObject(await nodeBalance(wallet));
    await settle();
    expect(wallet.transaction(sent.txid)).toMatchObject({ status: 'confirmed' });
  });

  it('opens with the same balance after its process is killed in the middle of a sync', async () => {
    // Something for the interrupted sync to find.
    await fund([{ script: toOutputScript(await wallet.receiveAddress({ label: 'while down' }), network), value: 9_000_000n }]);
    const before = { balance: wallet.balance(), history: wallet.history() };
    await wallet.close();

    // Bundled next to node_modules so the child resolves the same packages.
    const script = join(import.meta.dirname, '../node_modules/.cache/pearljs-live/wallet-child.mjs');
    buildSync({ entryPoints: [join(import.meta.dirname, 'wallet-child.ts')], bundle: true, packages: 'external', platform: 'node', format: 'esm', outfile: script, logLevel: 'silent' });
    const endpoint = live?.pearld ?? nowhere;
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, WALLET_PATH: path, NODE_URL: endpoint.url, NODE_USER: endpoint.username, NODE_PASS: endpoint.password, NODE_CA: endpoint.ca },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let output = '';
    await new Promise<void>((resolve, reject) => {
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString();
        // Killed once the scan is well under way: the wallet is open and has fetched some address histories.
        if (/^open \d+\n\.{5}/.test(output)) resolve();
      });
      child.once('exit', () => reject(new Error(`the child exited early: ${output}`)));
    });
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
    expect(output).toMatch(new RegExp(`^open ${before.balance.total}\n\\.+$`));

    // The dead process's lock is not broken unasked, nor called stale while it could still be touched.
    const locked = ((): unknown => {
      try {
        return createFileStore(path);
      } catch (err) {
        return err;
      }
    })();
    expect(locked).toBeInstanceOf(StoreError);
    expect(locked).toMatchObject({ code: 'STORE_LOCKED', message: expect.stringContaining('breakLock: true') as string });

    // The test killed the holder itself, so it can say so.
    wallet = await PearlWallet.open(connection(createFileStore(path, { breakLock: true }), backend));
    expect(wallet.locked).toBe(true);
    expect(wallet.balance()).toEqual(before.balance);
    expect(wallet.history()).toEqual(before.history);
    await wallet.sync();
    expect(wallet.balance().confirmed).toBe(before.balance.confirmed + 9_000_000n);
    expect(wallet.balance()).toMatchObject(await nodeBalance(wallet));
    const locker = await wallet.send({ recipients: [{ address: elsewhere(50), amount: 1_000_000n }] }).catch((err: unknown) => err);
    expect(locker).toMatchObject({ name: 'WalletError', code: 'WALLET_LOCKED' });
    await wallet.unlock(PASSPHRASE);
  });

  it('restores from the keystore alone and from the keystore with a state backup, to the same balance', async () => {
    const keystore = wallet.exportKeystore();
    const state = await wallet.exportState();
    // Transactions of one block are listed in the order the wallet first saw them, which a restore cannot know.
    const confirmed = (entries: HistoryEntry[]) =>
      entries
        .filter((entry) => entry.status === 'confirmed')
        .map(({ txid, block, direction, amount, fee, counterparties }) => ({ txid, block, direction, amount, fee, counterparties }))
        .sort((a, b) => a.txid.localeCompare(b.txid));

    const wrong = await PearlWallet.restore({ ...connection(createMemoryStore()), keystore, passphrase: 'not the passphrase' }).catch((err: unknown) => err);
    expect(wrong).toBeInstanceOf(KeystoreError);
    expect(wrong).toMatchObject({ code: 'KEYSTORE_BAD_PASSPHRASE' });

    // From the keys: the chain gives back every coin and confirmed transaction, and no label.
    const fromKeys = await PearlWallet.restore({ ...connection(createMemoryStore()), keystore, passphrase: PASSPHRASE, unlockTimeoutMs: null });
    expect(fromKeys.balance().total).toBe(0n);
    await fromKeys.sync();
    expect(fromKeys.balance()).toEqual(wallet.balance());
    expect(fromKeys.coins()).toEqual(wallet.coins());
    expect(confirmed(fromKeys.history())).toEqual(confirmed(wallet.history()));
    expect(fromKeys.accounts()[0]).toMatchObject({ nextChangeIndex: wallet.accounts()[0]!.nextChangeIndex });
    expect(fromKeys.addresses().find((entry) => entry.address === firstAddress)).toMatchObject({ label: null, used: true });
    expect(await fromKeys.mnemonic()).toBe(await wallet.mnemonic());
    // It signs: a send from the restored wallet is mined.
    const sent = await fromKeys.send({ recipients: [{ address: elsewhere(60), amount: 1_500_000n }], feeRate: FEE_RATE });
    await mine(1);
    await fromKeys.sync();
    expect(fromKeys.transaction(sent.txid)).toMatchObject({ status: 'confirmed' });
    await fromKeys.close();

    // With the backup: labels, the replaced transaction and every index are back before any sync.
    const restoredPath = join(dir, 'restored.json');
    const withState = await PearlWallet.restore({ ...connection(createFileStore(restoredPath, { create: true })), keystore, backup: state, passphrase: PASSPHRASE, unlockTimeoutMs: null });
    expect(withState.history()).toEqual(wallet.history());
    expect(withState.addresses()).toEqual(wallet.addresses());
    expect(withState.accounts()).toEqual(wallet.accounts());
    // The original wallet and this copy both learn of the other copy's send from the chain.
    await wallet.sync();
    await withState.sync();
    expect(withState.balance()).toEqual(wallet.balance());
    expect(withState.balance()).toMatchObject(await nodeBalance(wallet));
    expect(withState.history()).toMatchObject(wallet.history().map(({ txid, status, amount, fee, label }) => ({ txid, status, amount, fee, ...(label === undefined ? {} : { label }) })));
    expect(withState.transaction(sent.txid)).toMatchObject({ status: 'confirmed', direction: 'outgoing', fee: sent.fee });
    await withState.close();
    const occupied = await PearlWallet.restore({ ...connection(createFileStore(restoredPath)), keystore, passphrase: PASSPHRASE, unlockTimeoutMs: null }).catch((err: unknown) => err);
    expect(occupied).toMatchObject({ name: 'WalletError', code: 'WALLET_EXISTS' });
  });

  it('spends from an XMSS key, freezes it when an older backup is restored, sees its index on chain and spends again after burning past it', async () => {
    const xmssPath = join(dir, 'xmss.json');
    const vault = await PearlWallet.create({ ...connection(createFileStore(xmssPath, { create: true })), passphrase: PASSPHRASE, unlockTimeoutMs: null, kdf: QUICK_KDF });
    const key = await vault.addXmssKey({ label: 'vault' });
    expect(key).toMatchObject({ nextIndex: 0, remaining: 31, highestOnChain: -1, frozen: null });
    const script = toOutputScript(key.address, network);
    await fund([
      { script, value: 40_000_000n },
      { script, value: 20_000_000n },
    ]);
    await vault.sync();
    expect(vault.balance().confirmed).toBe(60_000_000n);
    const keystore = vault.exportKeystore();
    const backup = await vault.exportState();
    const rawCopy = fileEntries(xmssPath);

    // Two spends, one signature each: indices 0 and 1. Change goes to the account, never back to the key.
    const first = await vault.send({ recipients: [{ address: elsewhere(70), amount: 5_000_000n }], from: { xmss: key.id }, feeRate: FEE_RATE });
    expect(first.inputs).toMatchObject([{ value: 40_000_000n }]);
    expect(first.changeAddress).toBe(vault.addresses({ account: '0' }).find((entry) => entry.change)!.address);
    const firstView = await nodeView(first.txid);
    expect(firstView.inputs[0]!.spend).toMatchObject({ type: 'scriptPath', p2mr: true, leaf: 'xmss' });
    expect(first).toMatchObject({ fee: firstView.fee, vsize: firstView.vsize });
    await mine(1);
    await vault.sync();
    const second = await vault.send({ recipients: [{ address: elsewhere(71), amount: 'max' }], from: { xmss: key.id }, feeRate: FEE_RATE });
    expect(second.inputs).toMatchObject([{ value: 20_000_000n }]);
    await mine(1);
    await vault.sync();
    expect(vault.xmssKeys()).toMatchObject([{ id: key.id, nextIndex: 2, remaining: 29, frozen: null }]);
    ownSpendsSeen = vault.xmssKeys()[0]!.highestOnChain;
    expect(vault.transaction(second.txid)).toMatchObject({ status: 'confirmed', fee: second.fee });
    await fund([{ script, value: 15_000_000n }]);
    await vault.close();

    // The backup was taken at index 0. Restored, the key refuses to sign at all.
    const restored = await PearlWallet.restore({ ...connection(createMemoryStore()), keystore, backup, passphrase: PASSPHRASE, unlockTimeoutMs: null });
    expect(restored.xmssKeys()).toMatchObject([{ id: key.id, nextIndex: 0, highestOnChain: -1, frozen: 'restored' }]);
    const send = (wallet: PearlWallet): Promise<SendResult> =>
      wallet.send({ recipients: [{ address: elsewhere(72), amount: 3_000_000n }], from: { xmss: key.id }, feeRate: FEE_RATE });
    const frozen = await send(restored).catch((err: unknown) => err);
    expect(frozen).toBeInstanceOf(XmssError);
    expect(frozen).toMatchObject({ code: 'XMSS_KEY_RESTORED' });
    // A sync reads the indices the key has used out of the mined witnesses.
    await restored.sync();
    expect(restored.xmssKeys()).toMatchObject([{ nextIndex: 0, highestOnChain: 1, frozen: 'restored' }]);
    expect(restored.balance().confirmed).toBe(15_000_000n + first.change);
    expect(await send(restored).catch((err: unknown) => err)).toMatchObject({ code: 'XMSS_KEY_RESTORED' });
    // Burning to an index the chain already shows is refused; past it, the key signs again.
    for (const nextIndex of [0, 1]) {
      const reuse = await restored.burnXmssIndices(key.id, { nextIndex }).catch((err: unknown) => err);
      expect(reuse).toBeInstanceOf(XmssError);
      expect(reuse).toMatchObject({ code: 'XMSS_INDEX_REUSE' });
    }
    expect(await restored.burnXmssIndices(key.id, { nextIndex: 2 })).toMatchObject({ nextIndex: 2, remaining: 29, frozen: null });
    const third = await send(restored);
    expect(third.inputs).toMatchObject([{ value: 15_000_000n }]);
    expect(await pearld.getRawMempool()).toContain(third.txid);
    await mine(1);
    await restored.sync();
    expect(restored.transaction(third.txid)).toMatchObject({ status: 'confirmed' });
    expect(restored.xmssKeys()).toMatchObject([{ nextIndex: 3, frozen: null }]);
    await restored.close();

    // A copy of the store file, opened as if it were current, is caught by the same reading of the chain.
    const copied = await PearlWallet.open(connection(createMemoryStore(rawCopy)));
    await copied.unlock(PASSPHRASE);
    expect(copied.xmssKeys()).toMatchObject([{ nextIndex: 0, frozen: null }]);
    const events = recordEvents(copied, 'xmss');
    await copied.sync();
    expect(copied.xmssKeys()).toMatchObject([{ nextIndex: 0, highestOnChain: 2, frozen: 'behind' }]);
    expect(events.seen).toMatchObject([{ id: key.id, reason: 'behind', nextIndex: 0 }]);
    expect(await send(copied).catch((err: unknown) => err)).toMatchObject({ name: 'XmssError', code: 'XMSS_KEY_BEHIND' });
    await copied.close();
  });

  it('watch() over a PearlWsClient records a payment and its confirmation as pearld announces them, without polling', async () => {
    const { ws, close } = nodeSocket();
    const watcher = await PearlWallet.create({
      store: createMemoryStore(),
      backend: pearldBackend(ws, { network }),
      transactions: pearldTransactionSource(ws),
      passphrase: PASSPHRASE,
      unlockTimeoutMs: null,
      kdf: QUICK_KDF,
    });
    try {
      const address = await watcher.receiveAddress();
      await watcher.sync();
      const errors = recordEvents(watcher, 'error');
      const transactions = recordEvents(watcher, 'transaction');
      const confirmations = recordEvents(watcher, 'confirmation');
      const balances = recordEvents(watcher, 'balance');
      // An hour between syncs: whatever arrives during the test came by notification.
      const stop = watcher.watch({ notifier: ws, intervalMs: 3_600_000 });
      await ws.call('getblockcount');

      const txid = await payPending(address, 7_000_000n);
      expect(await transactions.until((entry) => entry.txid === txid)).toMatchObject({ status: 'pending', direction: 'incoming', amount: 7_000_000n });
      await balances.until((balance) => balance.unconfirmed === 7_000_000n);
      expect(watcher.balance()).toMatchObject({ confirmed: 0n, unconfirmed: 7_000_000n });

      watcher.on('confirmation', () => (confirmedWhenAnnounced ??= watcher.balance().confirmed));
      const [hash] = await mine(1);
      expect(await confirmations.until((event) => event.txid === txid)).toEqual({ txid, block: { height: await pearld.getBlockCount(), hash } });
      // The balance follows once the block itself is announced.
      await balances.until((balance) => balance.confirmed === 7_000_000n);
      expect(watcher.balance()).toMatchObject({ confirmed: 7_000_000n, unconfirmed: 0n });
      expect(watcher.tip).toEqual(await nodeBackend.getTip());

      // An address handed out while watching is watched too, and a spend of the wallet's coin is announced.
      const later = await watcher.receiveAddress();
      const laterTxid = await payPending(later, 2_000_000n);
      await transactions.until((entry) => entry.txid === laterTxid);
      stop();
      expect(errors.seen).toEqual([]);
      await mine(1);
    } finally {
      await watcher.close();
      await close();
    }
  });
});

// Two things the flows above first found wrong in the wallet, read from what they recorded.
describeLive('wallet state on pearld, what the flows above recorded', () => {
  // pearld sends recvtx for a mined transaction before blockconnected. The
  // wallet counts confirmations from the highest block it has been told of,
  // so a confirmation listener already finds the payment confirmed.
  it('counts a payment as confirmed by the time its confirmation event fires', () => {
    expect(confirmedWhenAnnounced).toBe(7_000_000n);
  });

  // The wallet's own sends are never taken in from the chain, so their
  // signatures are counted when they confirm.
  it('shows the index of its own mined XMSS spends as the highest on chain', () => {
    expect(ownSpendsSeen).toBe(1);
  });
});

/** The newest revision of a file store, as text, read without its lock. */
function storeText(path: string): string {
  const newest = readdirSync(path).filter((name) => /^\d{16}\.json$/.test(name)).sort().at(-1)!;
  return readFileSync(join(path, newest), 'utf8');
}

/** The entries of a file store as a memory store takes them, read without its lock. */
function fileEntries(path: string): [string, JsonValue][] {
  const file = JSON.parse(storeText(path)) as { entries: Record<string, JsonValue> };
  return Object.entries(file.entries);
}
