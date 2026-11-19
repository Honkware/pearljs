// The test wallet over pearldBackend on testnet2: it has found the faucet's
// payment, sends to its second account, sees that confirm in a block someone
// else mined, and its history, coins and balance are what the node's own
// address index and UTXO set say. Account 1 then sends everything back to
// the first address.

import { afterAll, beforeAll, expect, it } from 'vitest';
import { PearlRpcError, type PearlWallet } from '../src/index.js';
import { confirmed, describeTestnet, feeRate, fundsOrSkip, home, node, openWallet, record } from './env.js';

const AMOUNT = 1_000_000n;
let wallet: PearlWallet;
let skip: string | null = null;

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
  expect(coins).toEqual(unspent);
  const sum = [...unspent.values()].reduce((total, value) => total + value, 0n);
  expect(subject.balance().total).toBe(sum);
}

describeTestnet('the test wallet over pearldBackend', () => {
  beforeAll(async () => {
    wallet = await openWallet();
    if (!wallet.accounts().some((entry) => entry.id === '1')) await wallet.addAccount(1, { label: 'second' });
    skip = await fundsOrSkip(wallet, 2n * AMOUNT);
  });
  afterAll(async () => {
    await wallet?.close();
  });

  it('found the faucet payment to the first address, confirmed', (context) => {
    if (skip !== null) context.skip(skip);
    const incoming = wallet.history({ address: home() }).filter((entry) => entry.direction === 'incoming');
    expect(incoming.length).toBeGreaterThan(0);
    expect(incoming.some((entry) => entry.status === 'confirmed' && entry.confirmations > 0)).toBe(true);
  });

  it('sends to the second account and sees the payment confirm in a block the network mined', async (context) => {
    if (skip !== null) context.skip(skip);
    const to = await wallet.receiveAddress({ account: '1', label: 'from account 0' });
    const sent = await wallet.send({ recipients: [{ address: to, amount: AMOUNT }], feeRate: await feeRate(), label: 'wallet: to account 1' });
    record('a wallet', 'account 0 to account 1', sent.txid, { fee: String(sent.fee), vsize: sent.vsize });
    expect(wallet.transaction(sent.txid)!.status).toBe('pending');

    const blockHash = await confirmed(sent.txid);
    await wallet.sync();
    const entry = wallet.transaction(sent.txid)!;
    expect(entry.status).toBe('confirmed');
    expect(entry.block!.hash).toBe(blockHash);
    expect(entry.direction).toBe('self');
    expect(entry.fee).toBe(sent.fee);
    expect(wallet.balance({ account: '1' }).confirmed).toBeGreaterThanOrEqual(AMOUNT);
    // The block came from someone else's miner: this node mines nothing.
    const block = await node.getBlock(blockHash);
    record('a wallet', 'confirming block', sent.txid, { block: blockHash, height: block.height });
  });

  it('holds the history and coins the node reports through searchrawtransactions and gettxout', async (context) => {
    if (skip !== null) context.skip(skip);
    await wallet.sync();
    await expectWalletMatchesNode(wallet);
  });

  it('sends everything in the second account back to the first address', async (context) => {
    if (skip !== null) context.skip(skip);
    const back = await wallet.send({ recipients: [{ address: home(), amount: 'max' }], from: { account: '1' }, feeRate: await feeRate(), label: 'wallet: return' });
    record('a wallet', 'account 1 send-max home', back.txid, { fee: String(back.fee) });
    expect(back.change).toBe(0n);
    await confirmed(back.txid);
    await wallet.sync();
    expect(wallet.balance({ account: '1' }).total).toBe(0n);
    await expectWalletMatchesNode(wallet);
  });
});
