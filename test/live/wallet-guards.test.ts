// PearlWallet's guards and its sends signed elsewhere, on a regtest pearld:
// the fee ceiling against the caller's rate and the backend's estimate,
// pearld's own replies to a duplicate, a confirmed duplicate, an orphan and a
// rule refusal against the wallet's refused-versus-uncertain reading of them
// (straight to pearld and through Oyster's RPC), prepareSend, estimateSend,
// submitSigned and send with an external signer, bumpFee on sends without
// change, incremental syncs and a websocket notifier finding a payment to an
// old address, history pages against the node's address index, and a backup
// whose account record was changed.

import { expect, it } from 'vitest';
import {
  createMemoryStore,
  DEFAULT_MAX_FEE_RATE,
  deriveSigningAccountFromSeed,
  feeForVsize,
  finalizePsbt,
  generateMnemonic,
  KeystoreError,
  mnemonicToSeed,
  oysterBackend,
  parsePsbt,
  parseTransaction,
  payFromAccount,
  PearlWallet,
  RPC_ERROR_CODES,
  serializeTransaction,
  SigningError,
  toOutputScript,
  WalletError,
} from '../../src/index.js';
import type { FeeRate, JsonValue, PearlRpcError, PearlSigningAccount, WalletBackend } from '../../src/index.js';
import { describeLive, FEE_RATE, fund, live, mine, network, oyster, pearld } from './chain.js';
import { connection, expectSendMatchesNode, nodeBackend, nodeSocket, nodeView, outpoint, outsider, PASSPHRASE, QUICK_KDF, recordEvents } from './wallets.js';

const { payPending, elsewhere } = outsider(11);

/** A backend whose fee estimate and broadcast a test can replace; everything else is pearldBackend's. */
function adjustable(base: WalletBackend = nodeBackend) {
  const backend = {
    ...base,
    estimate: null as (() => Promise<FeeRate>) | null,
    send: null as ((hex: string) => Promise<string>) | null,
    async estimateFeeRate() {
      return backend.estimate === null ? base.estimateFeeRate() : backend.estimate();
    },
    async broadcast(hex: string) {
      return backend.send === null ? base.broadcast(hex) : backend.send(hex);
    },
  };
  return backend;
}

/** A new wallet with its own phrase, funded with one coin of each value and synced. */
async function funded(values: readonly bigint[], backend: WalletBackend = nodeBackend): Promise<{ wallet: PearlWallet; signer: PearlSigningAccount; mnemonic: string }> {
  // A new phrase each time: every file of the run shares one chain, and a fixed phrase another file uses would bring its coins in.
  const mnemonic = generateMnemonic();
  const wallet = await PearlWallet.create({ ...connection(createMemoryStore(), backend), mnemonic, passphrase: PASSPHRASE, unlockTimeout: null, kdf: QUICK_KDF });
  const outputs = [];
  for (const value of values) outputs.push({ script: toOutputScript(await wallet.receiveAddress(), network), value });
  if (outputs.length > 0) await fund(outputs);
  await wallet.sync();
  return { wallet, signer: deriveSigningAccountFromSeed(mnemonicToSeed(mnemonic), network), mnemonic };
}

const failure = (promise: Promise<unknown>): Promise<unknown> => promise.then(() => null, (err: unknown) => err);

describeLive('wallet fee ceiling', () => {
  it('refuses an absurd rate from the caller or the backend before signing, and pays one on purpose with maxFeeRate raised', async () => {
    const backend = adjustable();
    const { wallet } = await funded([50_000_000n, 40_000_000n], backend);
    const recipients = [{ address: elsewhere(0), amount: 5_000_000n }];
    const mempool = await pearld.getRawMempool();
    const before = { history: wallet.history(), balance: wallet.balance() };

    const tooHigh = await failure(wallet.send({ recipients, feeRate: DEFAULT_MAX_FEE_RATE + 1n }));
    expect(tooHigh).toBeInstanceOf(SigningError);
    expect(tooHigh).toMatchObject({ code: 'FEE_TOO_HIGH', message: expect.stringContaining('above maxFeeRate') as string });

    backend.estimate = async () => 100_000_000n;
    expect(await failure(wallet.send({ recipients }))).toMatchObject({ name: 'SigningError', code: 'FEE_TOO_HIGH', message: expect.stringContaining('the backend estimates') as string });
    expect(await failure(wallet.prepareSend({ recipients }))).toMatchObject({ code: 'FEE_TOO_HIGH' });
    backend.estimate = async () => 0n;
    expect(await failure(wallet.send({ recipients }))).toMatchObject({ code: 'BACKEND_RESPONSE' });
    backend.estimate = null;

    // Nothing was signed, recorded or sent.
    expect(await pearld.getRawMempool()).toEqual(mempool);
    expect(wallet.history()).toEqual(before.history);
    expect(wallet.balance()).toEqual(before.balance);

    const high = 8_000_000n;
    const estimates = wallet.estimateSend({ recipients }, [FEE_RATE, high]);
    expect(estimates[0]).toMatchObject({ feeRate: FEE_RATE, error: null, inputs: 1 });
    expect(estimates[1]).toMatchObject({ feeRate: high, fee: null, error: expect.objectContaining({ code: 'FEE_TOO_HIGH' }) as Error });
    const [raised] = wallet.estimateSend({ recipients, maxFeeRate: 10_000_000n }, [high]);
    expect(raised).toMatchObject({ error: null });
    expect(raised!.fee).toBeGreaterThanOrEqual(feeForVsize(raised!.vsize!, high));

    const sent = await wallet.send({ recipients, feeRate: high, maxFeeRate: 10_000_000n });
    expect(sent).toMatchObject({ fee: raised!.fee, vsize: raised!.vsize });
    expect((await pearld.getRawMempoolVerbose())[sent.txid]).toMatchObject({ fee: sent.fee, vsize: sent.vsize });
    await expectSendMatchesNode(wallet, sent, recipients);
    const [block] = await mine(1);
    expect(await pearld.getRawTransaction(sent.txid)).toMatchObject({ blockhash: block });
    await wallet.close();
  });
});

// pearld answers sendrawtransaction with -26 and "already have transaction"
// for one in its mempool, -27 and "transaction already exists" for one in a
// block, -25 for an orphan and -26 for a rule it breaks
// (handleSendRawTransaction, node/rpcserver.go:3577). The wallet must call
// the first two held, and the last two refused.
for (const via of ['pearld', 'Oyster'] as const) {
  describeLive(`wallet broadcast outcomes through ${via}`, () => {
    const skip = via === 'Oyster' && (live?.oyster === null || live?.oyster === undefined);
    const raw = (hex: string): Promise<string> => (via === 'pearld' ? pearld.sendRawTransaction(hex) : oysterBackend(oyster, { network }).broadcast(hex));

    it.skipIf(skip)('counts a duplicate in the mempool or in a block as sent, and an orphan or a broken rule as refused', async () => {
      const backend = adjustable({ ...nodeBackend, broadcast: raw });
      const { wallet, signer } = await funded([30_000_000n, 20_000_000n, 10_000_000n], backend);

      // Sent twice: the wallet reads pearld's second answer as the transaction being held.
      backend.send = async (hex) => {
        await raw(hex);
        const again = (await failure(raw(hex))) as PearlRpcError;
        expect(again).toMatchObject({ code: 'RPC_ERROR', rpcCode: RPC_ERROR_CODES.TX_REJECTED, message: expect.stringContaining('already have transaction') as string });
        throw again;
      };
      const twice = await wallet.send({ recipients: [{ address: elsewhere(10), amount: 1_000_000n }], feeRate: FEE_RATE });
      expect(await pearld.getRawMempool()).toContain(twice.txid);
      expect(wallet.transaction(twice.txid)).toMatchObject({ status: 'pending', broadcast: true });

      // Sent, mined and sent again: pearld says it is in the chain, which counts as held too.
      backend.send = async (hex) => {
        await raw(hex);
        await mine(1);
        const again = (await failure(raw(hex))) as PearlRpcError;
        expect(again).toMatchObject({ code: 'RPC_ERROR', rpcCode: RPC_ERROR_CODES.TX_ALREADY_IN_CHAIN, message: expect.stringContaining('transaction already exists') as string });
        throw again;
      };
      const mined = await wallet.send({ recipients: [{ address: elsewhere(11), amount: 1_000_000n }], feeRate: FEE_RATE });
      expect(wallet.transaction(mined.txid)).toMatchObject({ broadcast: true });
      expect((await pearld.getRawTransaction(mined.txid)).confirmations).toBe(1);
      await wallet.sync();
      expect(wallet.transaction(mined.txid)).toMatchObject({ status: 'confirmed' });

      // A send pearld never received, then one spending its change: pearld calls that an orphan.
      backend.send = async (hex) => parseTransaction(hex).getId();
      const lost = await wallet.send({ recipients: [{ address: elsewhere(12), amount: 1_000_000n }], feeRate: FEE_RATE, from: { account: '0' } });
      backend.send = null;
      const coins = wallet.coins().filter((coin) => coin.txid !== lost.txid);
      for (const coin of coins) await wallet.lockOutpoint(coin);
      const orphan = (await failure(wallet.send({ recipients: [{ address: elsewhere(13), amount: 500_000n }], feeRate: FEE_RATE, minConfirmations: 0 }))) as WalletError;
      expect(orphan).toBeInstanceOf(WalletError);
      expect(orphan.code).toBe('WALLET_BROADCAST_REFUSED');
      expect(orphan.cause).toMatchObject({ code: 'RPC_ERROR', rpcCode: RPC_ERROR_CODES.VERIFY, message: expect.stringContaining('orphan transaction') as string });
      for (const coin of coins) await wallet.unlockOutpoint(coin);
      expect(wallet.history().map((entry) => entry.txid)).not.toContain(/refused transaction ([0-9a-f]{64})/.exec(orphan.message)![1]);
      // A sync finds the lost send missing, and rebroadcast gets it to pearld.
      await wallet.sync();
      expect(wallet.transaction(lost.txid)).toMatchObject({ missing: true });
      expect(await wallet.rebroadcast()).toEqual({ accepted: [lost.txid], refused: [], failed: [] });
      expect(await pearld.getRawMempool()).toContain(lost.txid);

      // The same seed spends a coin elsewhere first: pearld refuses the wallet's spend of it.
      await mine(1);
      await wallet.sync();
      const coin = wallet.coins().reduce((largest, next) => (next.value > largest.value ? next : largest));
      const owner = coin.owner as { type: 'account'; account: string; change: boolean; index: number };
      const spend = payFromAccount(signer, { network, utxos: [{ ...coin, index: owner.index, change: owner.change }], recipients: [{ address: elsewhere(14), amount: 'max' }], feeRate: FEE_RATE });
      await pearld.sendRawTransaction(spend.hex);
      const refused = (await failure(wallet.send({ recipients: [{ address: elsewhere(15), amount: coin.value - 1_000_000n }], feeRate: FEE_RATE }))) as WalletError;
      expect(refused).toMatchObject({ name: 'WalletError', code: 'WALLET_BROADCAST_REFUSED' });
      expect(refused.cause).toMatchObject({ code: 'RPC_ERROR', rpcCode: RPC_ERROR_CODES.TX_REJECTED });
      await mine(1);
      await wallet.close();
    });
  });
}

describeLive('wallet sends signed elsewhere', () => {
  it('estimates at several rates, prepares a PSBT that is signed apart from the wallet and submitted, and pearld mines it at the estimate', async () => {
    const { wallet, signer } = await funded([40_000_000n, 25_000_000n, 15_000_000n]);
    const recipients = [{ address: elsewhere(20), amount: 30_000_000n }];
    const rates = [1000n, FEE_RATE, 25_000n, 400_000n];
    const estimates = wallet.estimateSend({ recipients }, rates);
    // The fee is the rate times Oyster's size estimate, which allows a little more than the signed size for each input.
    for (const estimate of estimates) {
      expect(estimate.error).toBeNull();
      expect(estimate.fee).toBeGreaterThanOrEqual(feeForVsize(estimate.vsize!, estimate.feeRate));
      expect(estimate.fee).toBeLessThanOrEqual(feeForVsize(estimate.vsize! + estimate.inputs, estimate.feeRate));
    }
    // A bigger fee never shrinks the transaction.
    expect(estimates.map((estimate) => estimate.vsize!)).toEqual([...estimates.map((estimate) => estimate.vsize!)].sort((a, b) => a - b));
    expect(wallet.estimateSend({ recipients: [{ address: elsewhere(21), amount: 100_000_000n }] }, [FEE_RATE])[0]).toMatchObject({ fee: null, error: expect.objectContaining({ code: 'INSUFFICIENT_FUNDS' }) as Error });

    const change = wallet.peekChangeAddress();
    const prepared = await wallet.prepareSend({ recipients, feeRate: 25_000n, label: 'signed elsewhere' });
    expect(prepared).toMatchObject({ fee: estimates[2]!.fee, vsize: estimates[2]!.vsize, feeRate: 25_000n, changeAddress: change });
    // The hold takes the change address, so the next send would use another.
    expect(wallet.peekChangeAddress()).not.toBe(change);
    expect(wallet.preparedSends()).toMatchObject([{ id: prepared.id, txid: prepared.txid }]);
    // The held coins are out of reach of another send.
    const other = await wallet.prepareSend({ recipients: [{ address: elsewhere(22), amount: 1_000_000n }], feeRate: FEE_RATE, hold: 0 });
    expect(other.inputs.map(outpoint)).not.toEqual(expect.arrayContaining(prepared.inputs.map(outpoint)));
    expect(other.changeAddress).not.toBe(prepared.changeAddress);

    const psbt = parsePsbt(prepared.psbt);
    for (let i = 0; i < psbt.inputCount; i += 1) signer.signInput(psbt, i);
    const signed = finalizePsbt(psbt);
    const tampered = signed.clone();
    tampered.outs[0]!.value -= 1n;
    expect(await failure(wallet.submitSigned(tampered))).toMatchObject({ code: 'WALLET_NOT_PREPARED' });

    const sent = await wallet.submitSigned(serializeTransaction(signed));
    expect(sent).toMatchObject({ txid: prepared.txid, fee: prepared.fee, vsize: prepared.vsize, change: prepared.change, changeAddress: prepared.changeAddress });
    expect(wallet.preparedSends()).toEqual([]);
    await expectSendMatchesNode(wallet, sent, recipients);
    expect(wallet.transaction(sent.txid)).toMatchObject({ label: 'signed elsewhere' });
    const view = await nodeView(sent.txid);
    expect(view.feeRate).toBeGreaterThanOrEqual(25_000n);
    expect(await failure(wallet.submitSigned(signed))).toMatchObject({ code: 'WALLET_NOT_PREPARED' });
    await mine(1);
    await wallet.sync();
    expect(wallet.transaction(sent.txid)).toMatchObject({ status: 'confirmed' });
    await wallet.close();
  });

  it('sends from a watch-only wallet with the account as an external key-path signer', async () => {
    const { wallet: keys, signer } = await funded([]);
    const watching = await PearlWallet.create({
      ...connection(createMemoryStore()),
      watchOnly: signer.watchOnlyAccount().extendedPublicKey(),
      watchOnlyOrigin: { masterFingerprint: signer.watchOnlyAccount().masterFingerprint!, path: signer.path! },
    });
    await keys.close();
    const outputs = [];
    for (const value of [12_000_000n, 9_000_000n]) outputs.push({ script: toOutputScript(await watching.receiveAddress(), network), value });
    await fund(outputs);
    await watching.sync();
    expect(watching.balance().confirmed).toBe(21_000_000n);

    const recipients = [{ address: elsewhere(30), amount: 15_000_000n }];
    expect(await failure(watching.send({ recipients, feeRate: FEE_RATE }))).toMatchObject({ code: 'WALLET_WATCH_ONLY' });
    const sent = await watching.send({ recipients, feeRate: FEE_RATE, signer: signer.keyPathSigner() });
    expect(sent.inputs).toHaveLength(2);
    await expectSendMatchesNode(watching, sent, recipients);
    await mine(1);
    await watching.sync();
    expect(watching.transaction(sent.txid)).toMatchObject({ status: 'confirmed' });
    expect(watching.balance()).toMatchObject({ confirmed: sent.change, unconfirmed: 0n });
    await watching.close();
  });
});

describeLive('wallet fee bumps without change', () => {
  it('bumps a send-max by paying the recipient less, and an exact send without change by bringing in another coin', async () => {
    const { wallet } = await funded([20_000_000n, 7_000_000n, 3_000_000n]);
    const held = wallet.coins();
    const coin = (value: bigint) => held.find((item) => item.value === value)!;
    // A send of everything spends every coin it may, so the others are locked out of it.
    const only = async <T>(value: bigint, run: () => Promise<T>): Promise<T> => {
      const others = wallet.coins().filter((item) => item.value !== value && item.confirmations > 0);
      for (const item of others) await wallet.lockOutpoint(item);
      try {
        return await run();
      } finally {
        for (const item of others) await wallet.unlockOutpoint(item);
      }
    };
    const max = await only(3_000_000n, () => wallet.send({ recipients: [{ address: elsewhere(40), amount: 'max' }], feeRate: FEE_RATE, rbf: true }));
    expect(max).toMatchObject({ change: 0n, changeAddress: null, inputs: [{ value: 3_000_000n }] });
    const bumpedMax = await wallet.bumpFee(max.txid, { feeRate: 6000n });
    expect(bumpedMax).toMatchObject({ change: 0n, changeAddress: null, replaces: max.txid });
    expect(bumpedMax.inputs.map(outpoint)).toEqual(max.inputs.map(outpoint));
    const maxView = await nodeView(bumpedMax.txid);
    expect(maxView.outputs).toMatchObject([{ address: elsewhere(40), value: 3_000_000n - bumpedMax.fee }]);
    expect(bumpedMax.fee).toBeGreaterThan(max.fee);

    // An exact amount that leaves only dust, which goes to the fee: no change output.
    const seven = coin(7_000_000n);
    const [estimate] = await only(7_000_000n, async () => wallet.estimateSend({ recipients: [{ address: elsewhere(41), amount: 'max' }] }, [FEE_RATE]));
    const amount = 7_000_000n - estimate!.fee! - 100n;
    const exact = await only(7_000_000n, () => wallet.send({ recipients: [{ address: elsewhere(41), amount }], feeRate: FEE_RATE, rbf: true }));
    expect(exact).toMatchObject({ change: 0n, changeAddress: null, inputs: [{ txid: seven.txid, vout: seven.vout }] });
    const bumped = await wallet.bumpFee(exact.txid, { feeRate: 6000n });
    expect(bumped.inputs.map(outpoint)).toEqual([outpoint(seven), outpoint(coin(20_000_000n))]);
    expect(bumped.change).toBeGreaterThan(0n);
    await expectSendMatchesNode(wallet, bumped, [{ address: elsewhere(41), amount }]);
    const mempool = await pearld.getRawMempool();
    expect(mempool).toEqual(expect.arrayContaining([bumpedMax.txid, bumped.txid]));
    expect(mempool).not.toContain(exact.txid);
    expect(mempool).not.toContain(max.txid);
    await mine(1);
    await wallet.sync();
    expect(wallet.transaction(exact.txid)).toMatchObject({ status: 'replaced', by: bumped.txid });
    expect(wallet.transaction(bumped.txid)).toMatchObject({ status: 'confirmed' });
    expect(wallet.balance().confirmed).toBe(bumped.change);
    await wallet.close();
  });
});

describeLive('wallet syncs that find old addresses', () => {
  it('finds a payment to an emptied old address within quietSyncInterval incremental syncs, and at once with a notifier', async () => {
    const mnemonic = generateMnemonic();
    const store = createMemoryStore();
    const wallet = await PearlWallet.create({ ...connection(store), quietSyncInterval: 3, mnemonic, passphrase: PASSPHRASE, unlockTimeout: null, kdf: QUICK_KDF });
    const old = await wallet.receiveAddress();
    await fund([{ script: toOutputScript(old, network), value: 10_000_000n }]);
    await wallet.sync();
    // Emptied: the address is used, holds nothing and has nothing pending.
    await wallet.send({ recipients: [{ address: elsewhere(50), amount: 'max' }], feeRate: FEE_RATE });
    for (let i = 0; i < 25; i += 1) await wallet.receiveAddress();
    await mine(1);
    await wallet.sync();
    expect(wallet.balance().total).toBe(0n);

    const txid = await payPending(old, 4_000_000n);
    let syncs = 0;
    while (wallet.transaction(txid) === null) {
      await wallet.sync();
      syncs += 1;
      expect(syncs).toBeLessThanOrEqual(3);
    }
    expect(wallet.transaction(txid)).toMatchObject({ status: 'pending', amount: 4_000_000n });

    // With a websocket notifier the next payment to the same address arrives without any sync.
    const { ws, close } = nodeSocket();
    try {
      const transactions = recordEvents(wallet, 'transaction');
      const stop = wallet.watch({ notifier: ws, pollInterval: 3_600_000 });
      await ws.call('getblockcount');
      const second = await payPending(old, 3_000_000n);
      expect(await transactions.until((entry) => entry.txid === second)).toMatchObject({ amount: 3_000_000n, addresses: [old] });
      stop();
    } finally {
      await close();
    }
    await mine(1);
    await wallet.sync();
    expect(wallet.balance().confirmed).toBe(7_000_000n);
    await wallet.close();
  });
});

describeLive('wallet history against the node', () => {
  it('pages and filters history by account and address the way the node\'s address index lists the same transactions', async () => {
    const { wallet } = await funded([6_000_000n, 5_000_000n]);
    const account = await wallet.addAccount(1, { label: 'second' });
    const other = await wallet.receiveAddress({ account: account.id });
    await fund([{ script: toOutputScript(other, network), value: 8_000_000n }]);
    await wallet.sync();
    for (const amount of [1_000_000n, 2_000_000n]) await wallet.send({ recipients: [{ address: elsewhere(60), amount }], feeRate: FEE_RATE, from: { account: '0' } });
    await wallet.send({ recipients: [{ address: elsewhere(61), amount: 3_000_000n }], feeRate: FEE_RATE, from: { account: account.id } });
    await mine(1);
    await wallet.sync();

    const all = wallet.history();
    expect(wallet.historyCount()).toBe(all.length);
    expect(all.length).toBe(5);
    const pages = [wallet.history({ limit: 2 }), wallet.history({ offset: 2, limit: 2 }), wallet.history({ offset: 4, limit: 2 })];
    expect(pages.map((page) => page.length)).toEqual([2, 2, 1]);
    expect(pages.flat()).toEqual(all);
    expect(wallet.history({ offset: 5 })).toEqual([]);

    // Every address's entries are the transactions the address index lists for it.
    for (const entry of wallet.addresses()) {
      const fromNode = (await nodeBackend.getHistory(entry.address)).map((item) => item.txid).sort();
      const fromWallet = wallet.history({ address: entry.address }).map((item) => item.txid).sort();
      expect(fromWallet, entry.address).toEqual(fromNode);
      expect(wallet.historyCount({ address: entry.address })).toBe(fromNode.length);
    }
    const second = wallet.history({ account: account.id });
    expect(second).toHaveLength(2);
    expect(second.map((entry) => entry.amount).sort()).toEqual([8_000_000n, -(3_000_000n + second.find((entry) => entry.amount < 0n)!.fee!)].sort());
    // One funding transaction paid both of account 0's first coins.
    expect(wallet.history({ account: '0' })).toHaveLength(3);
    expect(wallet.historyCount({ account: '0' }) + wallet.historyCount({ account: account.id })).toBe(all.length);
    await wallet.close();
  });

  it('refuses to restore a backup whose account record was changed, and writes nothing', async () => {
    const { wallet, mnemonic } = await funded([2_000_000n]);
    const keystore = wallet.exportKeystore();
    const backup = await wallet.exportState();
    await wallet.close();
    const key = Object.keys(backup.entries).find((name) => /^account:/.test(name))!;
    const record = backup.entries[key] as { xpub: string };
    // Account 1 of the same seed, with its own origin: a key the keystore could sign for, but not the one it authenticated.
    const other = deriveSigningAccountFromSeed(mnemonicToSeed(mnemonic), network, 1);
    const xpub = other.watchOnlyAccount().extendedPublicKey();
    const origin = { masterFingerprint: other.watchOnlyAccount().masterFingerprint, path: other.path };
    const store = createMemoryStore();
    const restoreFrom = (entry: Record<string, unknown>) =>
      failure(PearlWallet.restore({ ...connection(store), keystore, backup: { ...backup, entries: { ...backup.entries, [key]: entry as unknown as JsonValue } }, passphrase: PASSPHRASE }));
    const refused = await restoreFrom({ ...record, xpub, origin });
    expect(refused).toBeInstanceOf(WalletError);
    expect(refused).toMatchObject({ code: 'WALLET_BACKUP_INVALID' });
    expect((refused as WalletError).cause).toBeInstanceOf(KeystoreError);
    expect((refused as WalletError).cause).toMatchObject({ code: 'KEYSTORE_TAMPERED' });
    // With the old origin left in, the record does not even read as an account.
    expect(await restoreFrom({ ...record, xpub })).toMatchObject({ code: 'WALLET_BACKUP_INVALID', cause: { code: 'STORE_INVALID' } });
    expect(await store.list('')).toEqual([]);
    // The untouched backup restores into the same store.
    const restored = await PearlWallet.restore({ ...connection(store), keystore, backup, passphrase: PASSPHRASE, unlockTimeout: null });
    await restored.sync();
    expect(restored.balance().confirmed).toBe(2_000_000n);
    await restored.close();
  });
});
