// What a wallet makes of a broadcast that did not simply succeed. pearld
// answers a transaction it already holds with an error; that is not a
// refusal, and the send stands. Only the replies that mean the transaction
// is not in the mempool take it back out. Everything else leaves it
// recorded as not broadcast, and rebroadcast says what became of each.

import { describe, expect, it } from 'vitest';
import { PearlRpcError, PolicyError, parsePearl } from '../src/index.js';
import type { PearlWallet } from '../src/index.js';
import { FakeChain, STRANGER, newWallet } from './wallet-chain.js';

const prl = (text: string): bigint => parsePearl(text);
const payment = { recipients: [{ address: STRANGER, amount: prl('1') }], feeRate: 2000n };
const reply = (message: string, rpcCode: number): PearlRpcError => new PearlRpcError('rpc', 'sendrawtransaction', message, { rpcCode });

async function funded(): Promise<{ chain: FakeChain; wallet: PearlWallet; accept: FakeChain['broadcast'] }> {
  const chain = new FakeChain();
  const wallet = await newWallet(chain);
  chain.pay(await wallet.receiveAddress(), prl('3'));
  chain.mine();
  await wallet.sync();
  return { chain, wallet, accept: chain.broadcast.bind(chain) };
}

describe('wallet: broadcast replies', () => {
  it.each([
    ['in the mempool', 'TX rejected: already have transaction in mempool 00ff', -26],
    ['in a block', 'TX rejected: transaction already exists in blockchain', -27],
    ['under another code', 'transaction already exists', -1],
  ])('counts a transaction the node says it already has %s as sent', async (_, message, code) => {
    const { chain, wallet, accept } = await funded();
    // The node took it, the reply was lost, and a second attempt or a second server answers that it has it.
    chain.broadcast = async (hex) => {
      await accept(hex);
      throw reply(message, code);
    };
    const sent = await wallet.send(payment);
    expect(chain.mempool.has(sent.txid)).toBe(true);
    expect(wallet.transaction(sent.txid)).toMatchObject({ status: 'pending', broadcast: true, direction: 'outgoing' });
    expect(wallet.balance()).toMatchObject({ confirmed: 0n, unconfirmed: prl('2') - sent.fee });
    chain.broadcast = accept;
    expect(await wallet.rebroadcast()).toEqual({ accepted: [], refused: [], failed: [] });
  });

  it.each([
    ['a rule rejection', reply('TX rejected: transaction 00ff has insufficient priority', -26)],
    ['an orphan', reply('TX rejected: orphan transaction 00ff references outputs of unknown or fully-spent transaction 11ee', -25)],
    ['bytes it cannot decode', reply('TX decode failed: unexpected EOF', -22)],
    ['a policy check the backend ran itself', new PolicyError('POLICY_DUST', 'dust')],
  ])('takes a send back out on %s', async (_, error) => {
    const { chain, wallet } = await funded();
    chain.broadcast = async () => {
      throw error;
    };
    await expect(wallet.send(payment)).rejects.toMatchObject({ code: 'WALLET_BROADCAST_REFUSED', cause: error });
    expect(wallet.history()).toHaveLength(1);
    expect(wallet.balance().confirmed).toBe(prl('3'));
  });

  it.each([
    ['an error of a code it does not know', reply('something else went wrong', -32603)],
    ['a general transaction error that is not an orphan', reply('TX rejected: database is closed', -25)],
    ['a dropped connection', new PearlRpcError('network', 'sendrawtransaction', 'connection reset')],
    ['an HTTP failure', new PearlRpcError('http', 'sendrawtransaction', 'bad gateway', { status: 502 })],
    ['a reply that is not JSON-RPC', new PearlRpcError('response', 'sendrawtransaction', 'not JSON')],
    ['an error of no known kind', new Error('socket hang up')],
  ])('keeps a send recorded as not broadcast on %s', async (_, error) => {
    const { chain, wallet, accept } = await funded();
    chain.broadcast = async () => {
      throw error;
    };
    await expect(wallet.send(payment)).rejects.toMatchObject({ code: 'WALLET_BROADCAST_UNCERTAIN', cause: error });
    const [pending] = wallet.history();
    expect(wallet.transaction(pending!.txid)).toMatchObject({ status: 'pending', broadcast: false });
    // Its coin is taken, so a second send cannot spend it again.
    expect(wallet.balance().confirmed).toBe(0n);
    expect(await wallet.rebroadcast()).toEqual({ accepted: [], refused: [], failed: [{ txid: pending!.txid, error }] });
    chain.broadcast = accept;
    expect(await wallet.rebroadcast()).toEqual({ accepted: [pending!.txid], refused: [], failed: [] });
    expect(wallet.transaction(pending!.txid)!.broadcast).toBe(true);
  });

  it('stops sending a transaction again once the node says it has it', async () => {
    const { chain, wallet, accept } = await funded();
    // The first attempt reaches the node and the connection drops before the reply.
    chain.broadcast = async (hex) => {
      await accept(hex);
      throw new PearlRpcError('network', 'sendrawtransaction', 'connection reset');
    };
    await expect(wallet.send(payment)).rejects.toMatchObject({ code: 'WALLET_BROADCAST_UNCERTAIN' });
    const txid = wallet.history()[0]!.txid;
    chain.broadcast = accept;
    chain.calls.clear();
    // The node answers "already have transaction", which is what the wallet wanted to know.
    expect(await wallet.rebroadcast()).toEqual({ accepted: [txid], refused: [], failed: [] });
    expect(await wallet.rebroadcast()).toEqual({ accepted: [], refused: [], failed: [] });
    expect(chain.calls.get('broadcast')).toBe(1);
    expect(wallet.transaction(txid)).toMatchObject({ broadcast: true, missing: false });
  });

  it('reports a rebroadcast the node refuses and leaves the transaction for a sync to settle', async () => {
    const { chain, wallet } = await funded();
    chain.failNextBroadcast = true;
    await expect(wallet.send(payment)).rejects.toMatchObject({ code: 'WALLET_BROADCAST_UNCERTAIN' });
    const txid = wallet.history()[0]!.txid;
    const refusal = reply('TX rejected: transaction 00ff has insufficient priority', -26);
    chain.broadcast = async () => {
      throw refusal;
    };
    expect(await wallet.rebroadcast()).toEqual({ accepted: [], refused: [{ txid, error: refusal }], failed: [] });
    expect(wallet.transaction(txid)).toMatchObject({ status: 'pending', broadcast: false });
    await wallet.abandon(txid);
    expect(wallet.balance().confirmed).toBe(prl('3'));
  });

  it('does not abandon a send the node took though the reply was lost, so paying again cannot pay twice', async () => {
    const { chain, wallet, accept } = await funded();
    chain.broadcast = async (hex) => {
      await accept(hex);
      throw new PearlRpcError('network', 'sendrawtransaction', 'socket hang up');
    };
    const err = await wallet.send(payment).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'WALLET_BROADCAST_UNCERTAIN' });
    const txid = wallet.history()[0]!.txid;
    chain.broadcast = accept;
    await expect(wallet.abandon(txid)).rejects.toMatchObject({ code: 'WALLET_TRANSACTION_KNOWN' });
    // A larger coin arrives; with the first send's coins still spent, the balance holds no 1 PRL to pay again from them.
    chain.pay(await wallet.receiveAddress(), prl('10'));
    chain.mine();
    await wallet.sync();
    expect(wallet.transaction(txid)).toMatchObject({ status: 'confirmed' });
    expect(wallet.balance().confirmed).toBe(prl('12') - wallet.transaction(txid)!.fee!);
    expect(await wallet.rebroadcast()).toEqual({ accepted: [], refused: [], failed: [] });
    expect(err).toMatchObject({ message: expect.stringContaining('Call refresh') });
  });

  it('counts an abandoned send again once the backend shows it, in the mempool or a block', async () => {
    for (const how of ['refresh', 'sync'] as const) {
      const { chain, wallet, accept } = await funded();
      chain.failNextBroadcast = true;
      await expect(wallet.send(payment)).rejects.toMatchObject({ code: 'WALLET_BROADCAST_UNCERTAIN' });
      const entry = wallet.history()[0]!;
      await wallet.abandon(entry.txid);
      expect(wallet.balance().confirmed).toBe(prl('3'));
      // It reached a node after all, and comes to this one.
      await accept(wallet.transaction(entry.txid)!.hex);
      await wallet[how]();
      expect(wallet.transaction(entry.txid)).toMatchObject({ status: 'pending' });
      expect(wallet.balance().confirmed).toBe(0n);
    }
  });
});
