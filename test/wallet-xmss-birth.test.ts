// An XMSS key's address is P2MR, which pearld's address index does not hold,
// so pearldBackend finds its payments by matching the compact filter of each
// block. A key the wallet generates cannot be paid in any block it had
// already synced, so the wallet records the block after its synced tip as the
// key's birth and the backend starts there. These tests count the heights
// whose filters a sync asks the node for.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PearlWallet, createMemoryStore, generateXmssSeeds, parsePearl, pearldBackend } from '../src/index.js';
import type { JsonValue, Rpc, WalletChain, WalletStore } from '../src/index.js';
import { FakeNode } from './filter-node.js';
import { FAST_KDF, FakeChain, MNEMONIC, PASSPHRASE } from './wallet-chain.js';

const prl = (text: string): bigint => parsePearl(text);

// pearld over the chain, keeping the height of every block whose filter is asked for.
function recording(chain: FakeChain) {
  const node = new FakeNode(chain);
  const heights: number[] = [];
  const rpc: Rpc = {
    call: <T>(method: string, params: readonly unknown[] = []): Promise<T> => {
      if (method === 'getcfilter') heights.push(chain.blocks.findIndex((block) => block.hash === params[0]));
      return node.call<T>(method, params);
    },
  };
  return { rpc, heights, lowest: () => Math.min(...heights), take: () => heights.splice(0) };
}

const create = (store: WalletStore, backend: WalletChain) =>
  PearlWallet.create({ store, backend, passphrase: PASSPHRASE, mnemonic: MNEMONIC, kdf: FAST_KDF, gapLimit: 10, unlockTimeout: null });

async function reopen(store: WalletStore, backend: WalletChain): Promise<PearlWallet> {
  const wallet = await PearlWallet.open({ store, backend });
  await wallet.unlock(PASSPHRASE);
  return wallet;
}

// A store that outlives the wallet closing it, as a file store does.
function lasting(): WalletStore {
  const store = createMemoryStore();
  return { ...store, close: async () => undefined };
}

async function bornAfterSync() {
  const chain = new FakeChain();
  const node = recording(chain);
  const store = lasting();
  const wallet = await create(store, pearldBackend(node.rpc, { network: chain.network }));
  await wallet.sync();
  const synced = chain.height;
  const key = await wallet.addXmssKey();
  chain.mine(2);
  chain.pay(key.address, prl('3'));
  chain.mine();
  return { chain, node, store, wallet, key, synced };
}

describe('XMSS key births', () => {
  it('scans a key the wallet generated from the block after its synced tip on the first sync', async () => {
    const { node, wallet, key, synced } = await bornAfterSync();
    expect(key.birthHeight).toBe(synced + 1);
    node.take();
    await wallet.sync();
    expect(node.heights.length).toBeGreaterThan(0);
    expect(node.lowest()).toBe(synced + 1);
    expect(wallet.balance().confirmed).toBe(prl('3'));
  });

  it('scans the key from its birth again in a reopened wallet over a new backend', async () => {
    const { chain, node, store, wallet, synced } = await bornAfterSync();
    await wallet.sync();
    await wallet.close();
    node.take();
    const reopened = await reopen(store, pearldBackend(node.rpc, { network: chain.network }));
    await reopened.sync();
    expect(node.lowest()).toBe(synced + 1);
    expect(reopened.balance().confirmed).toBe(prl('3'));
  });

  it('scans a key added with seeds from scanFrom unless given a birth height', async () => {
    const chain = new FakeChain();
    const node = recording(chain);
    const wallet = await create(lasting(), pearldBackend(node.rpc, { network: chain.network, scanFrom: 3 }));
    await wallet.sync();
    const seeds = generateXmssSeeds();
    const key = await wallet.addXmssKey({ ...seeds, nextIndex: 0 });
    expect(key.birthHeight).toBeNull();
    node.take();
    await wallet.sync();
    expect(node.lowest()).toBe(3);

    const other = recording(chain);
    const told = await create(lasting(), pearldBackend(other.rpc, { network: chain.network, scanFrom: 3 }));
    const given = await told.addXmssKey({ ...generateXmssSeeds(), nextIndex: 0, birthHeight: 40 });
    expect(given.birthHeight).toBe(40);
    await told.sync();
    expect(other.lowest()).toBe(40);
    await expect(told.addXmssKey({ ...generateXmssSeeds(), nextIndex: 0, birthHeight: -1 })).rejects.toThrow(RangeError);
  });

  it('opens and unlocks a store written before keys had births, and scans its key from scanFrom', async () => {
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/wallet-store-before-births.json', import.meta.url), 'utf8')) as { entries: Record<string, JsonValue> };
    const chain = new FakeChain({ premine: 6 });
    const node = recording(chain);
    const wallet = await reopen(createMemoryStore(Object.entries(fixture.entries)), pearldBackend(node.rpc, { network: chain.network }));
    const [key] = wallet.xmssKeys();
    expect(key).toMatchObject({ label: 'before births', birthHeight: null });
    await wallet.sync();
    expect(node.lowest()).toBe(0);
  });

  it('keeps the birth through a backup, but the first sync after the restore scans the key in full', async () => {
    const { chain, node, wallet, synced } = await bornAfterSync();
    await wallet.sync();
    const backup = await wallet.exportState();
    const keystore = wallet.exportKeystore();
    const store = lasting();
    node.take();
    const restored = await PearlWallet.restore({ store, backend: pearldBackend(node.rpc, { network: chain.network }), keystore, passphrase: PASSPHRASE, backup, unlockTimeout: null });
    expect(restored.xmssKeys()[0]!.birthHeight).toBe(synced + 1);
    await restored.sync();
    expect(node.lowest()).toBe(0);
    expect(restored.balance().confirmed).toBe(prl('3'));
    await restored.close();
    node.take();
    const later = await reopen(store, pearldBackend(node.rpc, { network: chain.network }));
    await later.sync();
    expect(node.lowest()).toBe(synced + 1);
  });

  it('refuses a backup whose birth was moved', async () => {
    const { chain, wallet, key } = await bornAfterSync();
    const backup = await wallet.exportState();
    const record = backup.entries[`xmss:${key.id}`] as { birth: { height: number } };
    record.birth.height += 1;
    await expect(
      PearlWallet.restore({ store: createMemoryStore(), backend: chain, transactions: chain, keystore: wallet.exportKeystore(), passphrase: PASSPHRASE, backup }),
    ).rejects.toMatchObject({ code: 'WALLET_BACKUP_INVALID' });
  });

  it('stops passing on a birth once the wallet holds a payment to the key below it', async () => {
    const chain = new FakeChain();
    const node = recording(chain);
    const wallet = await create(lasting(), pearldBackend(node.rpc, { network: chain.network }));
    // A birth stated too high: the payment sits below it.
    const key = await wallet.addXmssKey({ ...generateXmssSeeds(), nextIndex: 0, birthHeight: chain.height + 20 });
    chain.pay(key.address, prl('2'));
    chain.mine(25);
    const backup = await wallet.exportState();
    const store = lasting();
    const restored = await PearlWallet.restore({ store, backend: pearldBackend(node.rpc, { network: chain.network }), keystore: wallet.exportKeystore(), passphrase: PASSPHRASE, backup, unlockTimeout: null });
    await restored.sync();
    expect(restored.balance().confirmed).toBe(prl('2'));
    await restored.close();
    node.take();
    const later = await reopen(store, pearldBackend(node.rpc, { network: chain.network }));
    await later.sync();
    expect(node.lowest()).toBe(0);
  });

  it('works with a backend that cannot take births, which scans the key from its own start', async () => {
    const chain = new FakeChain();
    const node = recording(chain);
    const { setAddressBirths, ...plain } = pearldBackend(node.rpc, { network: chain.network });
    expect(setAddressBirths).toBeTypeOf('function');
    const wallet = await create(lasting(), plain);
    await wallet.sync();
    const key = await wallet.addXmssKey();
    expect(key.birthHeight).toBe(chain.height + 1);
    chain.pay(key.address, prl('1'));
    chain.mine();
    node.take();
    await wallet.sync();
    expect(node.lowest()).toBe(0);
    expect(wallet.balance().confirmed).toBe(prl('1'));
  });

  it('finds a payment below the birth after a reorganization takes out the block the key was born after', async () => {
    const { chain, node, wallet, key, synced } = await bornAfterSync();
    await wallet.sync();
    expect(wallet.balance().confirmed).toBe(prl('3'));
    // The new branch forks below the birth and holds a second payment there.
    const depth = chain.height - synced + 3;
    chain.pay(key.address, prl('4'));
    chain.reorg(depth);
    node.take();
    await wallet.sync();
    expect(node.lowest()).toBe(0);
    expect(wallet.balance().confirmed).toBe(prl('7'));
    const found = wallet.history().find((entry) => entry.received === prl('4'));
    expect(found?.block?.height).toBeLessThan(key.birthHeight!);
  });
});
