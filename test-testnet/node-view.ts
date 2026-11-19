// The node's own view of a set of addresses, through its address index and
// UTXO set, and a comparison of a wallet against it.

import { expect } from 'vitest';
import { PearlRpcError, type PearlWallet } from '../src/index.js';
import { node } from './env.js';

/** What the node's address index and UTXO set say about the addresses: txids per address and the unspent outputs paying them. */
export async function nodeView(addresses: readonly string[]): Promise<{ txids: Map<string, string[]>; unspent: Map<string, bigint> }> {
  const txids = new Map<string, string[]>();
  const unspent = new Map<string, bigint>();
  for (const address of addresses) {
    const found = await node.searchRawTransactions(address, { count: 10_000 }).catch((error: unknown) => {
      if (error instanceof PearlRpcError && /No information available about address/.test(error.message)) return [];
      throw error;
    });
    txids.set(address, found.map((tx) => tx.txid).sort());
    for (const tx of found) {
      for (const out of tx.vout) {
        if (out.scriptPubKey.address !== address) continue;
        const left = await node.getTxOut(tx.txid, out.n, true);
        if (left !== null) unspent.set(`${tx.txid}:${out.n}`, left.value);
      }
    }
  }
  return { txids, unspent };
}

/** Compares the wallet with the node, address by address and coin by coin. */
export async function expectWalletMatchesNode(subject: PearlWallet): Promise<void> {
  const used = subject.addresses().filter((entry) => entry.used).map((entry) => entry.address);
  const { txids, unspent } = await nodeView(used);
  const live = new Set(['pending', 'confirmed']);
  for (const address of used) {
    const mine = subject.history({ address, limit: 10_000 }).filter((entry) => live.has(entry.status)).map((entry) => entry.txid).sort();
    expect(mine, address).toEqual(txids.get(address));
  }
  const coins = new Map(subject.coins().map((coin) => [`${coin.txid}:${coin.vout}`, coin.value]));
  // XMSS keys and imported keys are not account addresses, and the address index holds no P2MR address: ask the UTXO set.
  for (const coin of subject.coins().filter((entry) => !used.includes(entry.address))) {
    const left = await node.getTxOut(coin.txid, coin.vout, true);
    if (left !== null) unspent.set(`${coin.txid}:${coin.vout}`, left.value);
  }
  expect(coins).toEqual(unspent);
  const sum = [...unspent.values()].reduce((total, value) => total + value, 0n);
  expect(subject.balance().total).toBe(sum);
}
