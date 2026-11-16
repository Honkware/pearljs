// What a notification command does when it is sent through Oyster. Oyster
// passes methods it does not handle to pearld over its own websocket, so
// stopnotifyblocks unsubscribes Oyster itself. Runs last: it leaves the
// suite's Oyster without its block feed for a while.

import { expect, it } from 'vitest';
import { toOutputScript } from '../src/index.js';
import { OYSTER_PASSPHRASE } from './context.js';
import { describeOyster, eventually, fund, mine, network, oyster, pearld } from './chain.js';

const oysterHeight = (): Promise<number> => oyster.call<number>('getblockcount');

describeOyster("Oyster's block feed", () => {
  it('stops following the chain once stopnotifyblocks is sent through it, and notifyblocks does not bring it back', async () => {
    await oyster.walletPassphrase(OYSTER_PASSPHRASE, 600);
    const start = await pearld.getBlockCount();
    expect(await eventually(oysterHeight, (height) => height === start)).toBe(start);
    const address = await oyster.getNewAddress();
    const balance = await oyster.getBalance();
    const unspent = await oyster.listUnspent(0);

    // Oyster has no handler for it and hands it to pearld on the connection its own notifications arrive on.
    expect(await oyster.call('stopnotifyblocks')).toBeNull();
    const payment = await fund([{ script: toOutputScript(address, network), value: 3_000_000n }]);
    await mine(1);
    expect(await pearld.getBlockCount()).toBe(start + 2);
    // Twenty seconds on, Oyster has heard of neither block. Its transaction notifications still
    // arrive, so it knows the payment, but as unconfirmed, two blocks after pearld mined it.
    expect(await eventually(oysterHeight, (height) => height > start, 20_000)).toBe(start);
    expect((await pearld.getRawTransaction(payment.getId())).confirmations).toBe(2);
    expect(await oyster.getBalance()).toBe(balance);
    const added = (await oyster.listUnspent(0)).filter((entry) => !unspent.some((old) => old.txid === entry.txid && old.vout === entry.vout));
    expect(added).toMatchObject([{ txid: payment.getId(), vout: 0, amount: 3_000_000n, confirmations: 0 }]);

    // Subscribing again the same way does not repair it: the next block does not connect to the last one Oyster stored.
    expect(await oyster.call('notifyblocks')).toBeNull();
    await mine(1);
    expect(await eventually(oysterHeight, (height) => height > start, 20_000)).toBe(start);
    expect(await oyster.getBalance()).toBe(balance);
  });
});
