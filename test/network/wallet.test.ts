// The test wallet over pearldBackend on testnet2: it has found the faucet's
// payment, sends to its second account, sees that confirm in a block someone
// else mined, and its history, coins and balance are what the node's own
// address index and UTXO set say. Account 1 then sends everything back to
// the first address.

import { afterAll, beforeAll, expect, it } from 'vitest';
import type { PearlWallet } from '../../src/index.js';
import { confirmed, describeTestnet, feeRate, fundsOrSkip, home, node, openWallet, record } from './env.js';
import { expectWalletMatchesNode } from './node-view.js';

const AMOUNT = 1_000_000n;
let wallet: PearlWallet;
let skip: string | null = null;

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
