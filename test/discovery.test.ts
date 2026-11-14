// Address discovery through both wallet backends, over the wallet history of
// backendFixtures in vectors/rpcfixtures_test.go, ending in a payment built
// from what was found.

import { describe, expect, it } from 'vitest';
import {
  OYSTER_RECOVERY_WINDOW,
  discoverAccount,
  importWatchOnlyAccount,
  oysterBackend,
  parseTransaction,
  payFromAccount,
  pearldBackend,
  spendableUtxos,
  transactionId,
} from '../src/index.js';
import type { AddressPayment, WalletUtxo } from '../src/index.js';
import { account, change0, grain, indexedPearld, network, receive0, receive2, scenarioOyster, txids } from './backend-helpers.js';

const found = (index: number, change: boolean) => ({ address: account.deriveAddress(index, change), index, change });

describe('discoverAccount', () => {
  it('finds the used addresses, the next index of each chain, the outputs and the balance', async () => {
    const { client, sent } = indexedPearld();
    const discovery = await discoverAccount(account, pearldBackend(client, { network }), { gap: 3 });
    expect(discovery.receive).toEqual({ used: [found(0, false), found(2, false)], nextIndex: 3 });
    expect(discovery.change).toEqual({ used: [found(0, true)], nextIndex: 1 });
    expect(discovery.receive.used.map((u) => u.address)).toEqual([receive0, receive2]);
    expect(discovery.change.used[0]!.address).toBe(change0);
    expect(discovery.utxos.map((u) => [u.txid, u.index, u.change]).sort()).toEqual(
      [
        [txids.a2, 2, false],
        [txids.a3, 0, false],
        [txids.m1, 0, true],
      ].sort(),
    );
    expect(discovery.balance).toEqual({ confirmed: grain('confirmed'), unconfirmed: grain('unconfirmed'), immature: grain('immature') });

    // Receive indices 0 to 5 and change indices 0 to 3: three unused past the last used one.
    const scanned = new Set(sent.filter((r) => r.body.method === 'searchrawtransactions').map((r) => r.body.params[0]));
    const want = [0, 1, 2, 3, 4, 5].map((i) => account.deriveAddress(i)).concat([0, 1, 2, 3].map((i) => account.deriveAddress(i, true)));
    expect([...scanned].sort()).toEqual(want.sort());
  });

  it('misses an address beyond the gap, which is why the default is Oyster window of 250', async () => {
    const { client } = indexedPearld();
    const backend = pearldBackend(client, { network });
    const narrow = await discoverAccount(account, backend, { gap: 1 });
    expect(narrow.receive).toEqual({ used: [found(0, false)], nextIndex: 1 });
    const exact = await discoverAccount(account, backend, { gap: 2 });
    expect(exact.receive.nextIndex).toBe(3);
    expect(OYSTER_RECOVERY_WINDOW).toBe(250);
  });

  it('scans 250 unused addresses on each chain by default, in rounds of the batch size', async () => {
    const asked: string[][] = [];
    const empty = {
      network,
      getAddressActivity: async (): Promise<AddressPayment[]> => [],
      getUtxos: async (): Promise<WalletUtxo[]> => [],
      findUsed: async (addresses: readonly string[]) => {
        asked.push([...addresses]);
        return [];
      },
    };
    const discovery = await discoverAccount(account, empty);
    expect(discovery.receive).toEqual({ used: [], nextIndex: 0 });
    expect(discovery.utxos).toEqual([]);
    expect(asked.map((a) => a.length)).toEqual([...Array(10).fill(25), ...Array(10).fill(25)]);
    expect(asked[9]!.at(-1)).toBe(account.deriveAddress(249));
    expect(asked[19]!.at(-1)).toBe(account.deriveAddress(249, true));
  });

  it('works for a watch-only account and gives the same result through Oyster', async () => {
    const watchOnly = importWatchOnlyAccount(account.watchOnlyAccount().extendedPublicKey(), network);
    const viaNode = await discoverAccount(watchOnly, pearldBackend(indexedPearld().client, { network }), { gap: 3 });
    const viaWallet = await discoverAccount(watchOnly, oysterBackend(scenarioOyster().client, { network }), { gap: 3, batchSize: 2 });
    expect(viaWallet.receive).toEqual(viaNode.receive);
    expect(viaWallet.change).toEqual(viaNode.change);
    // Oyster holds the immature coinbase output back from listunspent.
    expect(viaWallet.utxos.map((u) => u.txid).sort()).toEqual([txids.a3, txids.m1].sort());
    expect(viaWallet.utxos.find((u) => u.txid === txids.m1)).toMatchObject({ index: 0, change: true, confirmations: 0 });
  });

  it('feeds payFromAccount, whose transaction the backend broadcasts', async () => {
    const { client, sent } = indexedPearld();
    const backend = pearldBackend(client, { network });
    const discovery = await discoverAccount(account, backend, { gap: 3 });
    const payment = payFromAccount(account, {
      network,
      utxos: discovery.utxos,
      recipients: [{ address: account.deriveAddress(7), amount: 25000000n }],
      feeRate: await backend.estimateFeeRate(),
      changeAddress: account.deriveAddress(discovery.change.nextIndex, true),
    });
    // Only the confirmed, mature output is spendable.
    expect(payment.inputs.map((u) => u.txid)).toEqual(spendableUtxos(discovery.utxos).map((u) => u.txid));
    expect(payment.inputs.map((u) => u.txid)).toEqual([txids.a3]);
    expect(payment.fee + payment.change + 25000000n).toBe(70000000n);
    await backend.broadcast(payment.hex);
    const broadcast = sent.at(-1)!;
    expect(broadcast.body.method).toBe('sendrawtransaction');
    expect(transactionId(parseTransaction(broadcast.body.params[0] as string))).toBe(payment.txid);
  });

  it('refuses a gap or batch size that is not a positive integer, and stops when aborted', async () => {
    const backend = pearldBackend(indexedPearld().client, { network });
    await expect(discoverAccount(account, backend, { gap: 0 })).rejects.toThrow('gap must be a positive integer');
    await expect(discoverAccount(account, backend, { batchSize: 1.5 })).rejects.toThrow('batchSize must be a positive integer');
    await expect(discoverAccount(account, backend, { signal: AbortSignal.abort() })).rejects.toThrow();
  });
});
