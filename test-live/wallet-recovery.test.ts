// What a wallet does when it cannot be sure what the node has, on a regtest
// pearld: a send whose reply is lost after pearld took it cannot be
// abandoned, so its coins are never paid out twice; a send abandoned while
// pearld never had it counts again once it is mined; a prepared send the
// signer broadcast cannot be cancelled. Also: payments signed elsewhere
// spend account coins only, keys and accounts added after a sync have their
// whole history found through filterBackend, and a wallet paid by every
// coinbase of the run keeps them all.

import { expect, it } from 'vitest';
import {
  createMemoryStore,
  deriveSigningAccountFromSeed,
  encodeWif,
  filterBackend,
  finalizePsbt,
  generateMnemonic,
  generateXmssSeeds,
  keyPathAddress,
  mnemonicToSeed,
  parsePsbt,
  PearldClient,
  pearldBackend,
  PearlWallet,
  sha256,
  parseTransaction,
  toOutputScript,
} from '../src/index.js';
import type { WalletBackend, WalletError } from '../src/index.js';
import { trustingFetch } from '../src/testing-regtest.js';
import { describeLive, FEE_RATE, fund, limited, live, mine, miner, network, nowhere, pearld } from './chain.js';
import { connection, nodeBackend, nodeBalance, outsider, PASSPHRASE, QUICK_KDF } from './wallets.js';

const { elsewhere } = outsider(16);
const failure = (promise: Promise<unknown>): Promise<unknown> => promise.then(() => null, (err: unknown) => err);

async function funded(values: readonly bigint[], backend: WalletBackend = nodeBackend): Promise<{ wallet: PearlWallet; mnemonic: string }> {
  const mnemonic = generateMnemonic();
  const wallet = await PearlWallet.create({ ...connection(createMemoryStore(), backend), mnemonic, passphrase: PASSPHRASE, unlockTimeout: null, kdf: QUICK_KDF });
  const outputs = [];
  for (const value of values) outputs.push({ script: toOutputScript(await wallet.receiveAddress(), network), value });
  if (outputs.length > 0) await fund(outputs);
  await wallet.sync();
  return { wallet, mnemonic };
}

describeLive('sends the wallet cannot be sure of', () => {
  it('will not abandon a send pearld took though its reply was lost, so its coins are not paid out again', async () => {
    // Every request reaches pearld; the reply never comes back, as when a connection drops after the request went out.
    const endpoint = live?.pearld ?? nowhere;
    const real = trustingFetch(endpoint.ca);
    const lossy = new PearldClient({ url: endpoint.url, username: endpoint.username, password: endpoint.password, fetch: async (input, init) => {
      await real(input, init);
      throw new TypeError('fetch failed');
    } });
    const { wallet } = await funded([10_000_000n, 8_000_000n], pearldBackend(pearld, { network, broadcast: lossy }));
    const recipients = [{ address: elsewhere(0), amount: 6_000_000n }];
    const uncertain = (await failure(wallet.send({ recipients, feeRate: FEE_RATE }))) as WalletError;
    expect(uncertain).toMatchObject({ name: 'WalletError', code: 'WALLET_BROADCAST_UNCERTAIN', cause: { code: 'RPC_NETWORK' } });
    const pending = wallet.history().find((entry) => entry.status === 'pending')!;
    expect(await pearld.getRawMempool()).toContain(pending.txid);
    expect(wallet.transaction(pending.txid)).toMatchObject({ broadcast: false });

    const refused = await failure(wallet.abandon(pending.txid));
    expect(refused).toMatchObject({ name: 'WalletError', code: 'WALLET_TRANSACTION_KNOWN', message: expect.stringContaining("in the backend's mempool") as string });
    // The coin it spent stays spent: only the other is left to pay with.
    expect(wallet.coins().map((coin) => coin.value).sort()).toEqual([8_000_000n, wallet.transaction(pending.txid)!.received].sort());
    const tooMuch = await failure(wallet.send({ recipients: [{ address: elsewhere(0), amount: 9_000_000n }], feeRate: FEE_RATE, minConfirmations: 1 }));
    expect(tooMuch).toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
    await mine(1);
    await wallet.sync();
    expect(wallet.transaction(pending.txid)).toMatchObject({ status: 'confirmed' });
    await wallet.close();
  });

  it('counts a send again once it is mined after the wallet abandoned it while pearld did not have it', async () => {
    const backend = { ...nodeBackend, held: [] as string[], async broadcast(hex: string) {
      backend.held.push(hex);
      return parseTransaction(hex).getId();
    } };
    const { wallet } = await funded([7_000_000n], backend);
    const sent = await wallet.send({ recipients: [{ address: elsewhere(1), amount: 2_000_000n }], feeRate: FEE_RATE });
    expect(await pearld.getRawMempool()).not.toContain(sent.txid);
    await wallet.abandon(sent.txid);
    expect(wallet.transaction(sent.txid)).toMatchObject({ status: 'abandoned' });
    expect(wallet.balance()).toMatchObject({ confirmed: 7_000_000n, unconfirmed: 0n });

    // It reaches pearld some other way and is mined.
    await pearld.sendRawTransaction(backend.held[0]!);
    await mine(1);
    await wallet.sync();
    expect(wallet.transaction(sent.txid)).toMatchObject({ status: 'confirmed', confirmations: 1 });
    expect(wallet.balance()).toMatchObject({ confirmed: sent.change, unconfirmed: 0n });
    await wallet.close();
  });

  it('will not cancel a prepared send its signer broadcast, and records it at the next sync', async () => {
    const { wallet, mnemonic } = await funded([5_000_000n]);
    const prepared = await wallet.prepareSend({ recipients: [{ address: elsewhere(2), amount: 1_000_000n }], feeRate: FEE_RATE });
    const signer = deriveSigningAccountFromSeed(mnemonicToSeed(mnemonic), network);
    const psbt = parsePsbt(prepared.psbt);
    for (let i = 0; i < psbt.inputCount; i += 1) signer.signInput(psbt, i);
    await pearld.sendRawTransaction(finalizePsbt(psbt).toHex());
    const refused = await failure(wallet.cancelPrepared(prepared.id!));
    expect(refused).toMatchObject({ name: 'WalletError', code: 'WALLET_TRANSACTION_KNOWN' });
    expect(wallet.preparedSends()).toMatchObject([{ id: prepared.id }]);
    await mine(1);
    await wallet.sync();
    expect(wallet.transaction(prepared.txid)).toMatchObject({ status: 'confirmed', direction: 'outgoing' });
    expect(wallet.balance().confirmed).toBe(prepared.change);
    await wallet.close();
  });

  it('prepares and signs elsewhere account coins only', async () => {
    const { wallet, mnemonic } = await funded([4_000_000n]);
    const key = await wallet.addXmssKey();
    const wif = encodeWif(sha256(new TextEncoder().encode(`pearljs live imported ${mnemonic}`)), network);
    const imported = await wallet.importKey(wif);
    await fund([
      { script: toOutputScript(key.address, network), value: 3_000_000n },
      { script: toOutputScript(imported, network), value: 3_000_000n },
    ]);
    await wallet.sync();
    const signer = deriveSigningAccountFromSeed(mnemonicToSeed(mnemonic), network).keyPathSigner();
    const recipients = [{ address: elsewhere(3), amount: 1_000_000n }];
    for (const from of [{ xmss: key.id }, { imported }] as const) {
      expect(await failure(wallet.prepareSend({ recipients, feeRate: FEE_RATE, from }))).toMatchObject({ code: 'WALLET_WATCH_ONLY' });
      expect(await failure(wallet.send({ recipients, feeRate: FEE_RATE, from, signer }))).toMatchObject({ code: 'WALLET_WATCH_ONLY' });
    }
    // From everything, a payment signed elsewhere takes the account's coins and leaves the keystore's own.
    const all = await wallet.prepareSend({ recipients: [{ address: elsewhere(3), amount: 'max' }], feeRate: FEE_RATE, from: 'all', hold: 0 });
    expect(all.inputs).toMatchObject([{ value: 4_000_000n }]);
    expect(wallet.balance().confirmed).toBe(10_000_000n);
    await wallet.close();
  });
});

describeLive('history of what a wallet adds later', () => {
  it('finds the payments of an account, an imported key and an XMSS key added after a sync, through filterBackend', async () => {
    const mnemonic = generateMnemonic();
    const birthday = await pearld.getBlockCount();
    const backend = filterBackend(limited, { network, birthday, broadcast: pearld, maxAge: 0 });
    const wallet = await PearlWallet.create({ store: createMemoryStore(), backend, mnemonic, passphrase: PASSPHRASE, unlockTimeout: null, kdf: QUICK_KDF });
    await fund([{ script: toOutputScript(await wallet.receiveAddress(), network), value: 1_000_000n }]);
    await wallet.sync();
    expect(wallet.balance().confirmed).toBe(1_000_000n);

    // Paid before the wallet knows them.
    const seeds = generateXmssSeeds();
    const probe = await PearlWallet.create({ store: createMemoryStore(), backend, passphrase: PASSPHRASE, unlockTimeout: null, kdf: QUICK_KDF });
    const xmss = await probe.addXmssKey({ ...seeds, nextIndex: 0 });
    await probe.close();
    const key = sha256(new TextEncoder().encode(`pearljs live later ${mnemonic}`));
    const second = deriveSigningAccountFromSeed(mnemonicToSeed(mnemonic), network, 1).deriveAddress(0);
    await fund([
      { script: toOutputScript(second, network), value: 2_000_000n },
      { script: toOutputScript(keyPathAddress(key, network), network), value: 3_000_000n },
      { script: toOutputScript(xmss.address, network), value: 4_000_000n },
    ]);
    await wallet.sync();
    expect(wallet.balance().confirmed).toBe(1_000_000n);

    await wallet.addAccount(1);
    await wallet.importKey(encodeWif(key, network));
    await wallet.addXmssKey({ ...seeds, nextIndex: 0 });
    await wallet.sync();
    const owners = wallet.coins().map((coin) => [coin.owner.type, coin.value]).sort();
    expect(owners).toEqual([['account', 1_000_000n], ['account', 2_000_000n], ['imported', 3_000_000n], ['xmss', 4_000_000n]].sort());
    await wallet.close();
  });
});

describeLive('a wallet paid by every coinbase', () => {
  it('keeps every coinbase the miner was paid, none of them conflicted', async () => {
    const mining = await PearlWallet.create({ ...connection(createMemoryStore()), watchOnly: miner.watchOnlyAccount().extendedPublicKey(), gapLimit: 5 });
    await mining.sync();
    const coinbases = mining.history().filter((entry) => entry.coinbase);
    expect(coinbases.length).toBeGreaterThan(100);
    expect(coinbases.filter((entry) => entry.status !== 'confirmed')).toEqual([]);
    expect(mining.balance()).toMatchObject(await nodeBalance(mining));
    await mining.close();
  });
});
