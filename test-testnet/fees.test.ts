// Fees on a real network: the backend's estimate against the node's
// estimatefee and relay fee, a payment at exactly the relay floor that the
// node takes and a block confirms, a replace-by-fee bump of it while it is
// unconfirmed, and a send-max that leaves no change.

import { afterAll, beforeAll, expect, it } from 'vitest';
import { DEFAULT_MAX_FEE_RATE, feeForVsize, pearldBackend, type PearlWallet } from '../src/index.js';
import { confirmed, describeTestnet, fundsOrSkip, home, network, node, openWallet, record } from './env.js';

let wallet: PearlWallet;
let skip: string | null = null;
let relayFee = 0n;

describeTestnet('fees on testnet2', () => {
  beforeAll(async () => {
    wallet = await openWallet();
    if (!wallet.accounts().some((entry) => entry.id === '1')) await wallet.addAccount(1, { label: 'second' });
    skip = await fundsOrSkip(wallet, 1_000_000n);
    relayFee = (await node.getInfo()).relayfee;
  });
  afterAll(async () => {
    await wallet?.close();
  });

  it('estimates no less than the node relays and no more than the ceiling, and follows estimatefee above the floor', async () => {
    const estimate = await pearldBackend(node, { network }).estimateFeeRate(6);
    const nodeEstimate = await node.estimateFee(6).catch(() => null);
    record('c fees', 'estimate', '', { estimate: String(estimate), estimatefee: String(nodeEstimate), relayfee: String(relayFee) });
    expect(estimate).toBeGreaterThanOrEqual(relayFee);
    expect(estimate).toBeLessThanOrEqual(DEFAULT_MAX_FEE_RATE);
    if (nodeEstimate !== null && nodeEstimate > relayFee) expect(estimate).toBe(nodeEstimate);
  });

  it('pays at the relay floor, bumps it while unconfirmed, and the replacement confirms', async (context) => {
    if (skip !== null) context.skip(skip);
    const to = await wallet.receiveAddress({ account: '1', label: 'fees' });
    let bumped: Awaited<ReturnType<PearlWallet['bumpFee']>> | null = null;
    let original = '';
    // A block can confirm the payment before the bump reaches the node; then pay again.
    for (let attempt = 0; bumped === null && attempt < 3; attempt++) {
      const sent = await wallet.send({ recipients: [{ address: to, amount: 500_000n }], feeRate: relayFee, rbf: true, label: 'fees: at the floor' });
      record('c fees', 'payment at the relay floor', sent.txid, { fee: String(sent.fee), vsize: sent.vsize });
      expect(sent.fee).toBe(feeForVsize(sent.vsize, relayFee));
      const entry = (await node.getRawMempoolVerbose())[sent.txid];
      expect(entry?.fee).toBe(sent.fee);
      try {
        bumped = await wallet.bumpFee(sent.txid, { feeRate: relayFee * 3n });
        original = sent.txid;
      } catch (error) {
        if ((await node.getRawTransaction(sent.txid)).confirmations === undefined) throw error;
      }
    }
    expect(bumped).not.toBeNull();
    record('c fees', 'replace-by-fee bump', bumped!.txid, { replaces: original, fee: String(bumped!.fee) });
    expect(bumped!.fee).toBeGreaterThan(feeForVsize(bumped!.vsize, relayFee * 3n) - 1n);
    const mempool = await node.getRawMempool();
    expect(mempool).toContain(bumped!.txid);
    expect(mempool).not.toContain(original);
    expect(wallet.transaction(original)!.status).toBe('replaced');

    await confirmed(bumped!.txid);
    await wallet.sync();
    expect(wallet.transaction(bumped!.txid)!.status).toBe('confirmed');
    expect(wallet.transaction(original)!.status).toBe('replaced');
    await expect(node.getRawTransaction(original)).rejects.toThrow();
  });

  it('sends the whole of the second account home with no change', async (context) => {
    if (skip !== null) context.skip(skip);
    const before = wallet.balance({ account: '1' }).confirmed;
    expect(before).toBeGreaterThan(0n);
    const back = await wallet.send({ recipients: [{ address: home(), amount: 'max' }], from: { account: '1' }, feeRate: relayFee, label: 'fees: send-max home' });
    record('c fees', 'send-max home', back.txid, { fee: String(back.fee) });
    expect(back.change).toBe(0n);
    expect(back.changeAddress).toBeNull();
    const tx = await node.getRawTransaction(back.txid);
    expect(tx.vout).toHaveLength(1);
    expect(tx.vout[0]!.value).toBe(before - back.fee);
    await confirmed(back.txid);
    await wallet.sync();
    expect(wallet.balance({ account: '1' }).total).toBe(0n);
  });
});
