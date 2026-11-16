// XMSS keys as wallet members: the index is reserved in the wallet store
// before the signature exists, the wallet supplies the previous
// transactions an all-P2MR spend needs, and a state older than the key's
// real index (a restored backup, a copied file) refuses to sign until the
// index is burned forward past everything it may have used.

import { describe, expect, it } from 'vitest';
import { PearlWallet, XMSS_MAX_SIGNATURES, addInputByTxid, createMemoryStore, createTransaction, networks, parsePearl, parseTransaction, toOutputScript } from '../src/index.js';
import type { JsonValue, Transaction, WalletEvents, WalletStore } from '../src/index.js';
import { FakeChain, PASSPHRASE, STRANGER, newWallet } from './wallet-chain.js';

const prl = (text: string): bigint => parsePearl(text);

// A fresh key each time: signers in one process refuse a second message at
// an index another signer of the same key used, which is the point of them.
async function xmssWallet(store: WalletStore = createMemoryStore()) {
  const chain = new FakeChain();
  const wallet = await newWallet(chain, { store });
  const key = await wallet.addXmssKey({ label: 'cold' });
  chain.pay(key.address, prl('5'));
  chain.pay(key.address, prl('5'));
  chain.mine();
  await wallet.sync();
  return { chain, wallet, key, store };
}

const xmssIndexOf = (hex: string, input = 0): number => {
  const witness = parseTransaction(hex).ins[input]!.witness[0]!;
  return new DataView(witness.buffer, witness.byteOffset, 4).getUint32(0);
};

describe('wallet XMSS keys', () => {
  it('spends an XMSS output with the next index and counts what is left', async () => {
    const { chain, wallet, key } = await xmssWallet();
    expect(wallet.balance().confirmed).toBe(prl('10'));
    const result = await wallet.send({ recipients: [{ address: STRANGER, amount: prl('3') }], feeRate: 2000n, from: { xmss: key.id } });
    expect(result.inputs).toHaveLength(1);
    expect(xmssIndexOf(result.hex)).toBe(0);
    expect(chain.mempool.has(result.txid)).toBe(true);
    // Change goes to the account, never back to the XMSS address.
    expect(result.changeAddress).toBe(wallet.addresses().find((address) => address.change)!.address);
    expect(wallet.xmssKeys()[0]).toMatchObject({ nextIndex: 1, remaining: XMSS_MAX_SIGNATURES - 1, frozen: null });
    const second = await wallet.send({ recipients: [{ address: STRANGER, amount: prl('3') }], feeRate: 2000n, from: { xmss: key.id } });
    expect(xmssIndexOf(second.hex)).toBe(1);
  });

  it('stores the advanced index before the signed transaction leaves the wallet', async () => {
    const order: string[] = [];
    const inner = createMemoryStore();
    const store: WalletStore = {
      ...inner,
      async compareAndSet(expected, operations) {
        const applied = await inner.compareAndSet(expected, operations);
        for (const op of operations) if (op.type === 'set' && op.key.startsWith('xmss:') && applied) order.push(`stored next ${(op.value as Record<string, JsonValue>).next}`);
        return applied;
      },
    };
    const { chain, wallet, key } = await xmssWallet(store);
    const broadcast = chain.broadcast.bind(chain);
    chain.broadcast = async (hex) => {
      order.push(`broadcast index ${xmssIndexOf(typeof hex === 'string' ? hex : '')}`);
      return broadcast(hex);
    };
    await wallet.send({ recipients: [{ address: STRANGER, amount: prl('1') }], feeRate: 2000n, from: { xmss: key.id } });
    expect(order.slice(-2)).toEqual(['stored next 1', 'broadcast index 0']);
  });

  it('signs with an index in only one of two wallets that share a store', async () => {
    // Two wallets on one store are what a lost lock, or a store without one, comes to.
    const { chain, wallet, key, store } = await xmssWallet();
    const twin = await PearlWallet.open({ store, backend: chain, transactions: chain });
    await twin.unlock(PASSPHRASE);
    const send = (from: PearlWallet) => from.send({ recipients: [{ address: STRANGER, amount: prl('1') }], feeRate: 2000n, from: { xmss: key.id } });
    const first = await send(wallet);
    expect(xmssIndexOf(first.hex)).toBe(0);
    // The twin still holds index 0 in memory; the store does not.
    await expect(send(twin)).rejects.toMatchObject({ code: 'XMSS_INDEX_REUSE', message: expect.stringContaining('another writer is using the store') });
    expect(((await store.get(`xmss:${key.id}`)) as { next: number }).next).toBe(1);
    expect(chain.mempool.size).toBe(1);
    // The refusal made the twin read the store again, so it cannot move the index back, and signs with the next one.
    await expect(twin.burnXmssIndices(key.id, { nextIndex: 0, nothingSigned: true })).rejects.toMatchObject({ code: 'XMSS_INDEX_REUSE', message: expect.stringContaining('never moves back') });
    expect(((await store.get(`xmss:${key.id}`)) as { next: number }).next).toBe(1);
    expect(xmssIndexOf((await send(twin)).hex)).toBe(1);
    // And now the first wallet is the one behind.
    await expect(send(wallet)).rejects.toMatchObject({ code: 'XMSS_INDEX_REUSE', message: expect.stringContaining('another writer is using the store') });
  });

  it('does not sign when the store declines the reservation', async () => {
    const inner = createMemoryStore();
    let decline = false;
    const store: WalletStore = { ...inner, compareAndSet: async (expected, operations) => !decline && inner.compareAndSet(expected, operations) };
    const { chain, wallet, key } = await xmssWallet(store);
    decline = true;
    await expect(wallet.send({ recipients: [{ address: STRANGER, amount: prl('1') }], feeRate: 2000n, from: { xmss: key.id } })).rejects.toMatchObject({ code: 'XMSS_INDEX_REUSE' });
    expect(chain.mempool.size).toBe(0);
    expect(wallet.xmssKeys()[0]!.nextIndex).toBe(0);
  });

  it('burns the index of a signature that never left', async () => {
    const { chain, wallet, key } = await xmssWallet();
    chain.broadcast = async () => {
      const { PearlRpcError } = await import('../src/index.js');
      throw new PearlRpcError('rpc', 'sendrawtransaction', 'rejected', { rpcCode: -26 });
    };
    await expect(wallet.send({ recipients: [{ address: STRANGER, amount: prl('1') }], feeRate: 2000n, from: { xmss: key.id } })).rejects.toThrow('refused');
    expect(wallet.xmssKeys()[0]!.nextIndex).toBe(1);
    expect(wallet.balance().confirmed).toBe(prl('10'));
  });

  it('comes back frozen from a backup until the index is burned forward', async () => {
    const { chain, wallet, key } = await xmssWallet();
    const backup = await wallet.exportState();
    await wallet.send({ recipients: [{ address: STRANGER, amount: prl('1') }], feeRate: 2000n, from: { xmss: key.id } });
    const restored = await PearlWallet.restore({ store: createMemoryStore(), backend: chain, transactions: chain, keystore: wallet.exportKeystore(), passphrase: PASSPHRASE, backup });
    expect(restored.xmssKeys()[0]).toMatchObject({ frozen: 'restored', nextIndex: 0 });
    await expect(restored.send({ recipients: [{ address: STRANGER, amount: prl('1') }], feeRate: 2000n, from: { xmss: key.id } })).rejects.toThrow('restored from a backup');
    await restored.sync();
    expect(restored.xmssKeys()[0]!.highestOnChain).toBe(0);
    await expect(restored.burnXmssIndices(key.id, { nextIndex: 0 })).rejects.toThrow('has signed with index 0 on chain');
    // Two more than the chain shows, for signatures that may never have been broadcast.
    expect(await restored.burnXmssIndices(key.id, { nextIndex: 3 })).toMatchObject({ frozen: null, nextIndex: 3, remaining: XMSS_MAX_SIGNATURES - 3 });
    const result = await restored.send({ recipients: [{ address: STRANGER, amount: prl('1') }], feeRate: 2000n, from: { xmss: key.id } });
    expect(xmssIndexOf(result.hex)).toBe(3);
    await expect(restored.burnXmssIndices(key.id, { nextIndex: 2 })).rejects.toThrow('never moves back');
  });

  it('freezes a key when the chain shows an index the store has not reached', async () => {
    const { chain, wallet, key, store } = await xmssWallet();
    // A copy of the store taken now, as a disk snapshot or a copied file would be.
    const snapshot = await store.list('');
    await wallet.send({ recipients: [{ address: STRANGER, amount: prl('1') }], feeRate: 2000n, from: { xmss: key.id } });
    chain.mine();
    await wallet.close();
    const stale = await PearlWallet.open({ store: createMemoryStore(snapshot), backend: chain, transactions: chain });
    const alerts: WalletEvents['xmss'][] = [];
    stale.on('xmss', (event) => alerts.push(event));
    await stale.sync();
    expect(alerts).toEqual([{ id: key.id, reason: 'behind', nextIndex: 0, highestOnChain: 0, remaining: XMSS_MAX_SIGNATURES }]);
    expect(stale.xmssKeys()[0]).toMatchObject({ frozen: 'behind', highestOnChain: 0 });
    await stale.unlock(PASSPHRASE);
    await expect(stale.send({ recipients: [{ address: STRANGER, amount: prl('1') }], feeRate: 2000n, from: { xmss: key.id } })).rejects.toThrow(
      'has signed on chain with index 0',
    );
  });

  it('shows the index of its own XMSS spends as the highest on chain once they are mined', async () => {
    const { chain, wallet, key } = await xmssWallet();
    const send = () => wallet.send({ recipients: [{ address: STRANGER, amount: prl('1') }], feeRate: 2000n, from: { xmss: key.id } });
    await send();
    expect(wallet.xmssKeys()[0]).toMatchObject({ nextIndex: 1, highestOnChain: -1 });
    chain.mine();
    await wallet.sync();
    expect(wallet.xmssKeys()[0]).toMatchObject({ nextIndex: 1, highestOnChain: 0, frozen: null });
    await send();
    chain.mine();
    await wallet.refresh();
    expect(wallet.xmssKeys()[0]).toMatchObject({ nextIndex: 2, highestOnChain: 1, frozen: null });
  });

  it('believes an index only from a signature that verifies under the key', async () => {
    const { chain, wallet, key } = await xmssWallet();
    const funding = wallet.coins().find((coin) => coin.owner.type === 'xmss')!;
    // A spend no node would accept, shown by the backend as in the mempool: the right shape, an index, and no signature.
    const forged = (index: number): Transaction => {
      const tx = createTransaction(2);
      addInputByTxid(tx, funding.txid, funding.vout);
      tx.addOutput(toOutputScript(STRANGER, networks.regtest), prl('4'));
      const chunk = new Uint8Array(468);
      new DataView(chunk.buffer).setUint32(0, index);
      tx.setWitness(0, [chunk, new Uint8Array(468), new Uint8Array(468), new Uint8Array(468), new Uint8Array(468), new Uint8Array(66), new Uint8Array(1)]);
      return tx;
    };
    const alerts: WalletEvents['xmss'][] = [];
    wallet.on('xmss', (event) => alerts.push(event));
    for (const index of [0xffffffff, 31, 30, 5, 0]) {
      const bogus = forged(index);
      chain.mempool.set(bogus.getId(), bogus);
      await wallet.sync();
      expect(wallet.xmssKeys()[0]).toMatchObject({ frozen: null, highestOnChain: -1, nextIndex: 0 });
      chain.mempool.delete(bogus.getId());
      await wallet.sync();
    }
    expect(alerts).toEqual([]);
    // The key still signs, with the index it was at.
    const sent = await wallet.send({ recipients: [{ address: STRANGER, amount: prl('1') }], feeRate: 2000n, from: { xmss: key.id } });
    expect(xmssIndexOf(sent.hex)).toBe(0);
    // A real signature with its index bytes changed does not verify either.
    const altered = parseTransaction(sent.hex);
    const witness = altered.ins[0]!.witness.map((item) => Uint8Array.from(item));
    new DataView(witness[0]!.buffer).setUint32(0, 9);
    altered.setWitness(0, witness);
    chain.mempool.delete(sent.txid);
    chain.mempool.set(altered.getId(), altered);
    // A wallet that knows the key and none of its history reads the altered spend from the backend.
    const fresh = await PearlWallet.open({ store: createMemoryStore(Object.entries((await wallet.exportState()).entries)), backend: chain, transactions: chain });
    await fresh.rescan();
    expect(fresh.transaction(altered.getId())).not.toBeNull();
    expect(fresh.xmssKeys()[0]).toMatchObject({ highestOnChain: -1, frozen: null });
  });

  it('keeps a restored key frozen until the wallet has synced, and refuses a burn that burns nothing', async () => {
    const { chain, wallet, key } = await xmssWallet();
    await wallet.send({ recipients: [{ address: STRANGER, amount: prl('1') }], feeRate: 2000n, from: { xmss: key.id } });
    chain.mine();
    // From the keys alone: the wallet knows nothing of index 0 until it has looked at the chain.
    const restored = await PearlWallet.restore({ store: createMemoryStore(), backend: chain, transactions: chain, keystore: wallet.exportKeystore(), passphrase: PASSPHRASE });
    expect(restored.xmssKeys()[0]).toMatchObject({ frozen: 'restored', nextIndex: 0, highestOnChain: -1 });
    for (const nextIndex of [0, 1, 5]) {
      await expect(restored.burnXmssIndices(key.id, { nextIndex, nothingSigned: true })).rejects.toMatchObject({ code: 'XMSS_KEY_RESTORED', message: expect.stringContaining('sync first') });
    }
    // refresh is not a sync: it does not look at the key's address.
    await restored.refresh();
    await expect(restored.burnXmssIndices(key.id, { nextIndex: 5 })).rejects.toMatchObject({ code: 'XMSS_KEY_RESTORED' });
    await restored.sync();
    expect(restored.xmssKeys()[0]).toMatchObject({ frozen: 'restored', highestOnChain: 0 });
    await expect(restored.burnXmssIndices(key.id, { nextIndex: 0, nothingSigned: true })).rejects.toMatchObject({ code: 'XMSS_INDEX_REUSE', message: expect.stringContaining('on chain') });
    expect(await restored.burnXmssIndices(key.id, { nextIndex: 2 })).toMatchObject({ frozen: null, nextIndex: 2 });
    // Standing still is a burn of nothing, whatever the key's state.
    await expect(restored.burnXmssIndices(key.id, { nextIndex: 2 })).rejects.toMatchObject({ code: 'XMSS_INDEX_REUSE', message: expect.stringContaining('burns nothing') });
    expect(await restored.burnXmssIndices(key.id, { nextIndex: 2, nothingSigned: true })).toMatchObject({ frozen: null, nextIndex: 2 });
  });

  it('unfreezes a restored key that has signed nothing since its backup only on the say-so of its owner', async () => {
    const { chain, wallet, key } = await xmssWallet();
    await wallet.send({ recipients: [{ address: STRANGER, amount: prl('1') }], feeRate: 2000n, from: { xmss: key.id } });
    chain.mine();
    await wallet.sync();
    const backup = await wallet.exportState();
    const restored = await PearlWallet.restore({ store: createMemoryStore(), backend: chain, transactions: chain, keystore: wallet.exportKeystore(), passphrase: PASSPHRASE, backup });
    await expect(restored.burnXmssIndices(key.id, { nextIndex: 1, nothingSigned: true })).rejects.toMatchObject({ code: 'XMSS_KEY_RESTORED' });
    await restored.sync();
    await expect(restored.burnXmssIndices(key.id, { nextIndex: 1 })).rejects.toMatchObject({ code: 'XMSS_INDEX_REUSE' });
    expect(restored.xmssKeys()[0]!.frozen).toBe('restored');
    expect(await restored.burnXmssIndices(key.id, { nextIndex: 1, nothingSigned: true })).toMatchObject({ frozen: null, nextIndex: 1 });
    const sent = await restored.send({ recipients: [{ address: STRANGER, amount: prl('1') }], feeRate: 2000n, from: { xmss: key.id } });
    expect(xmssIndexOf(sent.hex)).toBe(1);
  });

  it('counts a frozen key\'s coins as held back, not as missing, when a send falls short', async () => {
    const { chain, wallet, key } = await xmssWallet();
    const restored = await PearlWallet.restore({ store: createMemoryStore(), backend: chain, transactions: chain, keystore: wallet.exportKeystore(), passphrase: PASSPHRASE, backup: await wallet.exportState() });
    const [estimate] = restored.estimateSend({ recipients: [{ address: STRANGER, amount: prl('1') }], from: 'all' }, [2000n]);
    expect(estimate!.error).toMatchObject({ name: 'WalletInsufficientFundsError', available: 0n, frozen: prl('10'), locked: 0n });
    void key;
  });

  it('needs the next index of an XMSS key that comes with its seeds', async () => {
    const chain = new FakeChain();
    const wallet = await newWallet(chain);
    await expect(wallet.addXmssKey({ privateSeed: new Uint8Array(64), publicSeed: new Uint8Array(32) })).rejects.toThrow('needs nextIndex');
  });

  it('refuses a payment that needs more signatures than the key has left, before reserving any', async () => {
    const { wallet, key } = await xmssWallet();
    await wallet.burnXmssIndices(key.id, { nextIndex: XMSS_MAX_SIGNATURES - 1 });
    await expect(wallet.send({ recipients: [{ address: STRANGER, amount: prl('8') }], feeRate: 2000n, from: { xmss: key.id } })).rejects.toThrow(
      'has 1 signatures left, and this payment needs 2',
    );
    expect(wallet.xmssKeys()[0]!.nextIndex).toBe(XMSS_MAX_SIGNATURES - 1);
  });
});
