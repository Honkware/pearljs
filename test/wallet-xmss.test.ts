// XMSS keys as wallet members: the index is reserved in the wallet store
// before the signature exists, the wallet supplies the previous
// transactions an all-P2MR spend needs, and a state older than the key's
// real index (a restored backup, a copied file) refuses to sign until the
// index is burned forward past everything it may have used.

import { describe, expect, it } from 'vitest';
import { PearlWallet, XMSS_MAX_SIGNATURES, createMemoryStore, parsePearl, parseTransaction } from '../src/index.js';
import type { JsonValue, WalletEvents, WalletStore } from '../src/index.js';
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
      async set(key, value) {
        if (key.startsWith('xmss:')) order.push(`stored next ${(value as Record<string, JsonValue>).next}`);
        await inner.set(key, value);
      },
    };
    const { chain, wallet, key } = await xmssWallet(store);
    const broadcast = chain.broadcast.bind(chain);
    chain.broadcast = async (hex) => {
      order.push(`broadcast index ${xmssIndexOf(typeof hex === 'string' ? hex : '')}`);
      return broadcast(hex);
    };
    await wallet.send({ recipients: [{ address: STRANGER, amount: prl('1') }], feeRate: 2000n, from: { xmss: key.id } });
    expect(order).toEqual(['stored next 1', 'broadcast index 0']);
  });

  it('burns the index of a signature that never left', async () => {
    const { chain, wallet, key } = await xmssWallet();
    chain.broadcast = async () => {
      const { PearlRpcError } = await import('../src/index.js');
      throw new PearlRpcError('rpc', 'sendrawtransaction', 'rejected', { code: -26 });
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
