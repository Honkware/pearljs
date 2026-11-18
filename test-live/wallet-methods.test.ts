// The Oyster methods added in the second RPC round, against a running
// Oyster: sendMany, the signs of amounts and fees in listTransactions and
// getTransaction after a real send, lockUnspent, removeTransaction and
// rebroadcastTransaction on a pending transaction, and getSyncProgress from
// a second Oyster in SPV mode, which oysterBackend reads as far as a wallet
// without a node can answer.

import { join } from 'node:path';
import { beforeAll, expect, it } from 'vitest';
import { generateMnemonic, OYSTER_DEFAULT_FEE_RATE, oysterBackend, parseTransaction, pearldBackend, PearlError, toOutputScript } from '../src/index.js';
import { OYSTER_PASSPHRASE } from './context.js';
import { confirm, describeOyster, eventually, fund, live, mine, miner, network, oyster, pearld, spentOutputs } from './chain.js';
import { startOyster } from './processes.js';

const outside = miner.deriveAddress(500);

async function synced(): Promise<void> {
  const tip = await pearld.getBlockCount();
  expect((await eventually(() => oyster.getBestBlock(), (best) => best.height === tip)).height).toBe(tip);
  expect(await eventually(() => oyster.getUnconfirmedBalance(), (balance) => balance === 0n)).toBe(0n);
}

describeOyster('Oyster wallet methods', () => {
  beforeAll(async () => {
    await oyster.walletPassphrase(OYSTER_PASSPHRASE, 3600);
    const outputs = [];
    for (const value of [60_000_000n, 40_000_000n]) outputs.push({ script: toOutputScript(await oyster.getNewAddress(), network), value });
    await fund(outputs);
    await synced();
  });

  it('pays two recipients with sendMany, and reports the send with the signs its types document', async () => {
    const own = await oyster.getNewAddress();
    const txid = await oyster.sendMany({ [outside]: 3_000_000n, [own]: 2_000_000n }, 2000n);
    const tx = parseTransaction(await pearld.getRawTransactionHex(txid));
    const spent = await spentOutputs(tx);
    const inputTotal = spent.reduce((sum, prevout) => sum + prevout.value, 0n);
    const fee = inputTotal - tx.outs.reduce((sum, out) => sum + out.value, 0n);
    expect((await pearld.getRawMempoolVerbose())[txid]).toMatchObject({ fee });
    const paid = (address: string): bigint[] =>
      tx.outs.filter((out) => Buffer.from(out.script).equals(toOutputScript(address, network))).map((out) => out.value);
    expect(paid(outside)).toEqual([3_000_000n]);
    expect(paid(own)).toEqual([2_000_000n]);

    // gettransaction: fee positive, one send entry for the whole transaction, one receive per output paid to the wallet.
    const pending = await oyster.getTransaction(txid);
    expect(pending).toMatchObject({ txid, fee, confirmations: 0, blockhash: '', hex: tx.toHex() });
    const send = pending.details.filter((detail) => detail.category === 'send');
    expect(send).toMatchObject([{ amount: -inputTotal, fee }]);
    const received = pending.details.filter((detail) => detail.category === 'receive');
    expect(received.map((detail) => [detail.address, detail.amount])).toContainEqual([own, 2_000_000n]);
    expect(pending.amount).toBe(received.reduce((sum, detail) => sum + detail.amount, 0n));

    // listtransactions: a send per output paid out, negative, each carrying the negative fee; a receive for the wallet's own.
    const entries = (await oyster.listTransactions(20)).filter((entry) => entry.txid === txid);
    const sends = entries.filter((entry) => entry.category === 'send');
    expect(sends.map((entry) => [entry.address, entry.amount, entry.fee]).sort()).toEqual(
      [
        [outside, -3_000_000n, -fee],
        [own, -2_000_000n, -fee],
      ].sort(),
    );
    expect(entries.filter((entry) => entry.category === 'receive').map((entry) => [entry.address, entry.amount])).toEqual([[own, 2_000_000n]]);
    for (const entry of entries) expect(entry).toMatchObject({ confirmations: 0, abandoned: false });

    const info = await confirm(tx);
    await synced();
    expect(await oyster.getTransaction(txid)).toMatchObject({ confirmations: 1, blockhash: info.blockhash, fee });
    const mined = (await oyster.listAllTransactions()).filter((entry) => entry.txid === txid);
    expect(mined.length).toBe(entries.length);
    for (const entry of mined) expect(entry).toMatchObject({ confirmations: 1, blockhash: info.blockhash });
    await expect(oyster.getTransaction('00'.repeat(32))).rejects.toMatchObject({ kind: 'rpc', rpcCode: -5 });
  });

  it('keeps a locked output out of listUnspent and out of a send until it is unlocked', async () => {
    const unspent = await oyster.listUnspent();
    const largest = unspent.reduce((max, entry) => (entry.amount > max.amount ? entry : max));
    const locked = { txid: largest.txid, vout: largest.vout };
    expect(await oyster.listLockUnspent()).toEqual([]);
    expect(await oyster.lockUnspent(false, [locked])).toBe(true);
    expect(await oyster.listLockUnspent()).toEqual([locked]);
    expect((await oyster.listUnspent()).some((entry) => entry.txid === locked.txid && entry.vout === locked.vout)).toBe(false);

    const txid = await oyster.sendToAddress(outside, 1_000_000n, 1000n);
    const tx = parseTransaction(await pearld.getRawTransactionHex(txid));
    expect(tx.ins.some((input) => Buffer.from(input.hash).reverse().toString('hex') === locked.txid && input.index === locked.vout)).toBe(false);

    expect(await oyster.lockUnspent(true)).toBe(true);
    expect(await oyster.listLockUnspent()).toEqual([]);
    expect((await oyster.listUnspent()).some((entry) => entry.txid === locked.txid && entry.vout === locked.vout)).toBe(true);
    await confirm(tx);
    await synced();
  });

  it('announces a pending transaction again, and forgets it when told to while pearld keeps it', async () => {
    const before = await oyster.listUnspent();
    const txid = await oyster.sendToAddress(outside, 1_500_000n, 1000n);
    const tx = parseTransaction(await pearld.getRawTransactionHex(txid));
    expect(await oyster.rebroadcastTransaction(txid)).toEqual([txid]);
    expect(await pearld.getRawMempool()).toEqual([txid]);

    expect(await oyster.removeTransaction(txid)).toEqual([txid]);
    await expect(oyster.getTransaction(txid)).rejects.toMatchObject({ kind: 'rpc', rpcCode: -5 });
    // Its inputs are the wallet's to spend again, though pearld still holds the transaction.
    const key = (entry: { txid: string; vout: number }): string => `${entry.txid}:${entry.vout}`;
    expect((await oyster.listUnspent()).map(key).sort()).toEqual(before.map(key).sort());
    expect(await pearld.getRawMempool()).toEqual([txid]);

    // Once a block confirms it the wallet takes it back.
    await mine(1);
    await synced();
    expect(await oyster.getTransaction(txid)).toMatchObject({ txid, confirmations: 1 });
    const spent = `${Buffer.from(tx.ins[0]!.hash).reverse().toString('hex')}:${tx.ins[0]!.index}`;
    expect((await oyster.listUnspent()).map(key)).not.toContain(spent);
  });

  it('has no sync progress to report while it follows pearld over RPC', async () => {
    await expect(oyster.getSyncProgress()).rejects.toMatchObject({
      kind: 'rpc',
      rpcCode: -4,
      message: 'getsyncprogress: sync progress tracking is only available in SPV mode (code -4)',
    });
    const tip = await pearld.getBlockCount();
    expect(await oyster.chainSynced()).toBe(true);
    expect(await oyster.getBestBlock()).toEqual({ hash: await pearld.getBestBlockHash(), height: tip });
  });

  it('reports sync progress in SPV mode, following pearld as a peer', async () => {
    const spv = await startOyster({
      exe: process.env.OYSTER!,
      dir: join(live!.dir, 'oyster-spv'),
      pearld: live!.pearld,
      mnemonic: generateMnemonic(),
      passphrase: OYSTER_PASSPHRASE,
      spvPeer: live!.p2p,
    });
    try {
      const tip = await pearld.getBlockCount();
      const progress = await eventually(() => spv.client.getSyncProgress(), (state) => state.synced && state.block_height === tip, 120_000);
      expect(progress).toEqual({
        header_height: tip,
        filter_header_height: tip,
        block_height: tip,
        best_peer_height: tip,
        connections: 1,
        synced: true,
      });
      // What needs pearld's RPC is not there in this mode.
      await expect(spv.client.getInfo()).rejects.toMatchObject({ kind: 'rpc', message: expect.stringContaining('Chain RPC is inactive') as string });

      // oysterBackend still reads what the wallet holds, and says what it cannot do without a node.
      const backend = oysterBackend(spv.client, { network });
      const node = pearldBackend(pearld, { network });
      const address = await spv.client.getNewAddress();
      const funding = await fund([{ script: toOutputScript(address, network), value: 9_000_000n }]);
      const paid = await pearld.getBlockCount();
      await eventually(() => spv.client.getSyncProgress(), (state) => state.synced && state.block_height === paid, 120_000);
      await eventually(() => spv.client.getBalance(), (balance) => balance === 9_000_000n, 120_000);
      expect(await backend.getTip()).toEqual(await node.getTip());
      expect(await backend.getUtxos([address])).toEqual(await node.getUtxos([address]));
      expect(await backend.getBalance([address])).toEqual({ confirmed: 9_000_000n, unconfirmed: 0n, immature: 0n });
      // Oyster gives the block's header time with the block.
      const best = await node.getTip();
      const block = { ...best, time: (await pearld.getBlockHeader(best.hash)).time };
      expect(await backend.getHistory(address)).toEqual([{ txid: funding.getId(), block, received: 9_000_000n }]);
      expect(await backend.getTransaction(funding.getId())).toEqual({ txid: funding.getId(), block });
      expect(await backend.getTransaction('00'.repeat(32))).toBeNull();
      expect(await backend.findUsed!([address, miner.deriveAddress(0)])).toEqual([address]);
      expect(await backend.getSpendStatus({ txid: funding.getId(), vout: 0 })).toEqual({ status: 'unspent', confirmations: 1 });
      // An output the wallet does not hold needs the node, which is not there.
      expect(await backend.getSpendStatus({ txid: funding.getId(), vout: 1 })).toEqual({ status: 'unknown' });
      expect(await backend.estimateFeeRate()).toBe(OYSTER_DEFAULT_FEE_RATE);
      const refused = await backend.broadcast(funding.toHex()).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(PearlError);
      expect(refused).toMatchObject({ code: 'BACKEND_UNSUPPORTED', message: expect.stringContaining('sendMany') as string });
      expect((refused as PearlError).cause).toMatchObject({ code: 'RPC_ERROR', kind: 'rpc' });
    } finally {
      await spv.stop();
    }
  });
});
