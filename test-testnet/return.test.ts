// The last file: whatever the wallet still holds, in any account or key, goes
// back to the first address in one send, and the wallet then agrees with the
// node about everything it has ever done.

import { afterAll, beforeAll, expect, it } from 'vitest';
import type { PearlWallet } from '../src/index.js';
import { confirmed, describeTestnet, feeRate, home, openWallet, record } from './env.js';
import { expectWalletMatchesNode } from './node-view.js';

let wallet: PearlWallet;

describeTestnet('returning everything to the first address', () => {
  beforeAll(async () => {
    wallet = await openWallet();
    await wallet.sync();
  });
  afterAll(async () => {
    await wallet?.close();
  });

  it('sends every coin to the first address and agrees with the node afterwards', async (context) => {
    const elsewhere = wallet.coins().filter((coin) => coin.address !== home() && coin.confirmations > 0);
    if (elsewhere.length === 0) context.skip('everything is at the first address already');
    const sent = await wallet.send({ recipients: [{ address: home(), amount: 'max' }], from: 'all', feeRate: await feeRate(), label: 'return everything' });
    record('return', 'everything to the first address', sent.txid, { inputs: sent.inputs.length, fee: String(sent.fee) });
    await confirmed(sent.txid);
    await wallet.sync();
    expect(wallet.coins().every((coin) => coin.address === home())).toBe(true);
    await expectWalletMatchesNode(wallet);
  });
});
