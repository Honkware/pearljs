// Sync against backends that answer oddly or only in part: one that calls
// every address used, one that knows an output is spent but not by what,
// notifications that arrive before the block that explains them, and one
// that answers for everything since a block at once, which knows nothing of
// the history of a key or account added since the last sync.

import { describe, expect, it } from 'vitest';
import { DEFAULT_SCAN_LIMIT, PearlWallet, createMemoryStore, deriveAccountFromSeed, encodeWif, generateXmssSeeds, keyPathAddress, mnemonicToSeed, networks, parsePearl } from '../src/index.js';
import type { BlockEvent, PearlWsEvents, WalletNotifier } from '../src/index.js';
import { FAST_KDF, FakeChain, PASSPHRASE, STRANGER, newWallet, withActivityScanner } from './wallet-chain.js';

const prl = (text: string): bigint => parsePearl(text);

describe('wallet: sync against a backend that answers oddly', () => {
  it('gives up a scan that never reaches a gap, and scans further when told the account is that large', async () => {
    expect(DEFAULT_SCAN_LIMIT).toBe(10_000);
    const chain = new FakeChain();
    const wallet = await newWallet(chain);
    const one = chain.pay(await wallet.receiveAddress(), prl('1'));
    chain.mine();
    let queries = 0;
    const real = chain.getHistory.bind(chain);
    // Every address has history, as a backend that matches by prefix, or one that lies, would say.
    chain.getHistory = async (watched) => {
      queries += 1;
      const history = await real(watched);
      return history.length > 0 ? history : [{ txid: one.getId(), block: null, received: 1n, spent: 0n }];
    };
    await expect(wallet.sync({ scanLimit: 200 })).rejects.toMatchObject({ code: 'BACKEND_RESPONSE', message: expect.stringContaining('with no gap of 10') });
    expect(queries).toBeLessThan(2 * 2 * 250);
    // Nothing of the runaway scan was kept.
    expect(wallet.accounts()[0]).toMatchObject({ nextReceiveIndex: 1, nextChangeIndex: 0 });
    expect(wallet.tip).toBeNull();
    chain.getHistory = real;
    await wallet.sync({ scanLimit: 200 });
    expect(wallet.balance().confirmed).toBe(prl('1'));
    await expect(wallet.sync({ scanLimit: 0 })).rejects.toThrow(RangeError);
  });

  it('scans an account with many used addresses up to the limit it is given', async () => {
    const chain = new FakeChain();
    const wallet = await newWallet(chain);
    const { deriveAccountFromSeed, mnemonicToSeed, networks } = await import('../src/index.js');
    const { MNEMONIC } = await import('./wallet-chain.js');
    const account = deriveAccountFromSeed(mnemonicToSeed(MNEMONIC), networks.regtest);
    for (let i = 0; i < 60; i += 5) chain.pay(account.deriveAddress(i), prl('1'));
    chain.mine();
    await expect(wallet.sync({ scanLimit: 30 })).rejects.toMatchObject({ code: 'BACKEND_RESPONSE' });
    await wallet.sync({ scanLimit: 100 });
    expect(wallet.balance().confirmed).toBe(prl('12'));
    expect(wallet.accounts()[0]!.nextReceiveIndex).toBe(56);
  });

  it('keeps a pending send whose coin the backend calls spent without the transaction that spent it', async () => {
    const chain = new FakeChain();
    const wallet = await newWallet(chain);
    chain.pay(await wallet.receiveAddress(), prl('3'));
    chain.mine();
    await wallet.sync();
    const sent = await wallet.send({ recipients: [{ address: STRANGER, amount: prl('1') }], feeRate: 2000n });
    const conflicts: unknown[] = [];
    wallet.on('conflict', (event) => conflicts.push(event));
    const rival = chain.doubleSpend(sent.txid, { mine: false });
    const real = chain.getSpendStatus.bind(chain);
    // What a backend that has lost the send can say of its coin: spent by nothing named, by something it cannot
    // show, by a transaction that spends something else, or by one still in its mempool.
    const unrelated = chain.blocks[chain.height]!.txs[0]!.getId();
    await wallet.refresh();
    expect(wallet.transaction(sent.txid)).toMatchObject({ status: 'pending', missing: true });
    for (const said of [{ status: 'spent' as const, confirmed: true }, { status: 'spent' as const, spender: '22'.repeat(32), confirmed: true }, { status: 'spent' as const, spender: unrelated, confirmed: true }]) {
      chain.getSpendStatus = async () => said;
      await wallet.refresh();
      expect(wallet.transaction(sent.txid)).toMatchObject({ status: 'pending', missing: true });
    }
    chain.getSpendStatus = real;
    expect(conflicts).toEqual([]);
    expect(wallet.balance().confirmed).toBe(0n);
    await expect(wallet.send({ recipients: [{ address: STRANGER, amount: prl('1') }], feeRate: 2000n })).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
    // The rival in a block, in hand, is proof.
    chain.mine();
    await wallet.refresh();
    expect(wallet.transaction(sent.txid)).toMatchObject({ status: 'conflicted', by: rival.getId() });
    expect(conflicts).toEqual([{ txid: sent.txid, status: 'conflicted', by: rival.getId() }]);
    expect(wallet.balance().total).toBe(0n);
  });

  it('frees the coin of a send the backend lost only when it is abandoned', async () => {
    const chain = new FakeChain();
    const wallet = await newWallet(chain);
    chain.pay(await wallet.receiveAddress(), prl('3'));
    chain.mine();
    await wallet.sync();
    const sent = await wallet.send({ recipients: [{ address: STRANGER, amount: prl('1') }], feeRate: 2000n });
    chain.drop(sent.txid);
    const real = chain.getSpendStatus.bind(chain);
    chain.getSpendStatus = async () => ({ status: 'spent', confirmed: false });
    await wallet.refresh();
    expect(wallet.transaction(sent.txid)).toMatchObject({ status: 'pending', missing: true });
    expect(wallet.balance().confirmed).toBe(0n);
    chain.getSpendStatus = real;
    await wallet.sync();
    expect(wallet.balance().confirmed).toBe(0n);
    await wallet.abandon(sent.txid);
    await wallet.sync();
    expect(wallet.balance().confirmed).toBe(prl('3'));
  });

  it('counts a payment as confirmed when its confirmation is announced, before the block is', async () => {
    const chain = new FakeChain();
    const wallet = await newWallet(chain);
    await wallet.sync();
    const listeners = new Map<string, (value: never) => void>();
    let onBlock: ((event: BlockEvent) => void) | undefined;
    const notifier = {
      on: (event: string, listener: (value: never) => void) => (listeners.set(event, listener), () => undefined),
      watchBlocks: (options: { onBlock: (event: BlockEvent) => void }) => ((onBlock = options.onBlock), () => undefined),
      notifyReceived: async () => undefined,
    } as unknown as WalletNotifier;
    const stop = wallet.watch({ notifier, pollInterval: 3_600_000 });
    const payment = chain.pay(await wallet.receiveAddress(), prl('7'));
    const tip = wallet.tip;
    const [mined] = chain.mine();
    // pearld sends recvtx for a mined transaction before blockconnected.
    const seen: { confirmed: bigint; confirmations: number }[] = [];
    wallet.on('confirmation', () => seen.push({ confirmed: wallet.balance().confirmed, confirmations: wallet.transaction(payment.getId())!.confirmations }));
    (listeners.get('recvtx') as (value: PearlWsEvents['recvtx']) => void)({ transaction: payment.toHex(), block: { hash: mined!.hash, height: mined!.height, index: 1, time: 0 } });
    await wallet.exportState();
    expect(seen).toEqual([{ confirmed: prl('7'), confirmations: 1 }]);
    // The synced tip itself moves only when the block is announced and checked.
    expect(wallet.tip).toEqual(tip);
    onBlock!({ type: 'connected', hash: mined!.hash, height: mined!.height, time: 0 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await wallet.exportState();
    expect(wallet.tip).toEqual(mined);
    expect(wallet.balance().confirmed).toBe(prl('7'));
    stop();
  });

  it('asks for the whole history of a key or account added since the last sync, from a backend that answers since a block', async () => {
    const chain = withActivityScanner(new FakeChain());
    const wallet = await newWallet(chain);
    await wallet.unlock(PASSPHRASE);
    chain.pay(await wallet.receiveAddress(), prl('1'));
    chain.mine();
    await wallet.sync();
    // Paid before the wallet knows them: an imported key and another account of the seed.
    const key = new Uint8Array(32).fill(5);
    chain.pay(keyPathAddress(key, networks.regtest), prl('2'));
    chain.pay(deriveAccountFromSeed(mnemonicToSeed(`${'abandon '.repeat(11)}about`), networks.regtest, 1).deriveAddress(0), prl('4'));
    chain.mine();
    await wallet.sync();
    expect(chain.calls.get('getActivitySince')).toBeGreaterThan(0);

    await wallet.importKey(encodeWif(key, networks.regtest));
    await wallet.addAccount(1);
    await wallet.sync();
    expect(wallet.coins().filter((coin) => coin.owner.type === 'imported').map((coin) => coin.value)).toEqual([prl('2')]);
    expect(wallet.coins().filter((coin) => coin.owner.type === 'account' && coin.owner.account === '1').map((coin) => coin.value)).toEqual([prl('4')]);
  });

  it('sees the signatures of an XMSS key added later, whether the spend was recorded already or not', async () => {
    for (const shared of [true, false]) {
      const chain = withActivityScanner(new FakeChain());
      const wallet = await newWallet(chain);
      await wallet.unlock(PASSPHRASE);
      await wallet.sync();
      // The key's other holder: with the same seed its change pays this wallet, so the spend is recorded before the key is added.
      const holder = shared
        ? await newWallet(chain, { store: createMemoryStore() })
        : await PearlWallet.create({ store: createMemoryStore(), backend: chain, passphrase: PASSPHRASE, mnemonic: `${'zoo '.repeat(11)}wrong`, kdf: FAST_KDF });
      await holder.unlock(PASSPHRASE);
      const seeds = generateXmssSeeds();
      const xmss = await holder.addXmssKey({ ...seeds, nextIndex: 0 });
      chain.pay(xmss.address, prl('5'));
      chain.mine();
      await holder.sync();
      await holder.send({ recipients: [{ address: STRANGER, amount: prl('1') }], feeRate: 2000n, from: { xmss: xmss.id } });
      chain.mine();
      await wallet.sync();
      await wallet.addXmssKey({ ...seeds, nextIndex: 0 });
      await wallet.sync();
      // The signature at index 0 is seen, so the key is held back instead of signing at 0 again.
      expect(wallet.xmssKeys()[0]).toMatchObject({ highestOnChain: 0, frozen: 'behind' });
    }
  });

  // Found on a live pearld: filterBackend reports a block's time with its
  // history and pearldBackend does not, so the same wallet showed different
  // entries on the two, and a time that was gone once the store was read again.
  it("records a transaction's block as height and hash whatever else the backend reports with it", async () => {
    const chain = new FakeChain();
    const store = createMemoryStore();
    const wallet = await newWallet(chain, { store });
    const paid = chain.pay(await wallet.receiveAddress(), prl('2')).getId();
    const [block] = chain.mine();
    const real = chain.getHistory.bind(chain);
    chain.getHistory = async (watched) => (await real(watched)).map((entry) => (entry.block === null ? entry : { ...entry, block: { ...entry.block, time: 1_700_000_000 } }));
    await wallet.sync();
    expect(wallet.transaction(paid)!.block).toEqual({ height: block!.height, hash: block!.hash });
    const reopened = await PearlWallet.open({ store, backend: chain });
    expect(reopened.history()).toEqual(wallet.history());
  });
});
