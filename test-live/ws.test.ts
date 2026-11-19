// PearlWsClient against a regtest pearld over wss with the certificate the
// node generated: both ways to log in, a wrong password, block and
// transaction notifications around a real payment from mempool to spend,
// rescanBlocks and rescan, the limited user, reconnection and resubscription across a
// restart of a second node, and Oyster's /ws.

import { join } from 'node:path';
import { afterAll, afterEach, expect, it } from 'vitest';
import type { Agent } from 'undici';
import { WebSocket } from 'undici';
import {
  OysterWsClient,
  blockHashHex,
  deriveSigningAccountFromSeed,
  mnemonicToSeed,
  parseBlock,
  parseTransaction,
  payFromAccount,
  PearlRpcError,
  PearlWsClient,
  toOutputScript,
  transactionId,
} from '../src/index.js';
import type { AccountUtxo, PearlWsClientOptions, PearlWsEvents } from '../src/index.js';
import type { Credentials, LiveEndpoint } from './context.js';
import { describeLive, describeOyster, FEE_RATE, fund, live, mine, miner, network, nowhere, pearld } from './chain.js';
import { freePort, startPearld, type RunningPearld } from './processes.js';
import { trustingAgent } from './context.js';

const account = deriveSigningAccountFromSeed(
  mnemonicToSeed('vessel ladder alter error federal sibling chat ability sun glass valve picture'),
  network,
);

const open: { ws: PearlWsClient; agent: Agent }[] = [];

/** A client for the endpoint that trusts its certificate; closed after the test. */
function client(endpoint: LiveEndpoint, options: Partial<PearlWsClientOptions> = {}, credentials: Credentials = endpoint): PearlWsClient {
  const agent = trustingAgent(endpoint.ca);
  const ws = new PearlWsClient({
    url: endpoint.url,
    username: credentials.username,
    password: credentials.password,
    WebSocket,
    webSocketInit: { dispatcher: agent },
    ...options,
  });
  open.push({ ws, agent });
  return ws;
}

/**
 * Closes every client a test opened. Oyster answers a close frame but never
 * closes the connection, so the dispatcher is destroyed first, which ends it.
 */
async function closeAll(): Promise<void> {
  for (const { ws, agent } of open.splice(0)) {
    const closing = ws.close();
    await agent.destroy();
    await closing;
  }
}

/** Every value of an event so far, and a wait for one that satisfies a test. */
function record<K extends keyof PearlWsEvents>(ws: PearlWsClient, event: K) {
  const seen: PearlWsEvents[K][] = [];
  const waiting: (() => void)[] = [];
  ws.on(event, (value) => {
    seen.push(value);
    for (const wake of waiting.splice(0)) wake();
  });
  return {
    seen,
    async until(test: (value: PearlWsEvents[K]) => boolean): Promise<PearlWsEvents[K]> {
      const deadline = Date.now() + 60_000;
      for (;;) {
        const found = seen.find(test);
        if (found !== undefined) return found;
        if (Date.now() > deadline) throw new Error(`no ${event} notification arrived`);
        await Promise.race([new Promise<void>((resolve) => waiting.push(resolve)), new Promise((resolve) => setTimeout(resolve, 1000))]);
      }
    },
  };
}

/** Lets a subscription command the client sent in the background reach pearld. */
const settle = (ws: PearlWsClient): Promise<unknown> => ws.call('getblockcount');

describeLive('websocket', () => {
  const node = live?.pearld ?? nowhere;
  let second: RunningPearld | undefined;
  afterEach(closeAll);
  afterAll(async () => {
    await second?.stop();
  });

  it('logs in with the authenticate command and with a Basic header, and calls methods', async () => {
    for (const auth of ['command', 'header'] as const) {
      const ws = client(node, { auth });
      await ws.connect();
      expect(await ws.call<number>('getblockcount')).toBe(await pearld.getBlockCount());
      expect(await ws.call<string>('getbestblockhash')).toBe(await pearld.getBestBlockHash());
      expect(typeof (await ws.session())).toBe('bigint');
      await expect(ws.call('nosuchmethod')).rejects.toMatchObject({ kind: 'rpc', rpcCode: -32601 });
    }
  });

  it('gives each connection its own session id', async () => {
    const [a, b] = [client(node), client(node)];
    expect(await a.session()).not.toBe(await b.session());
    expect(await a.session()).toBe(await a.session());
  });

  it('reports a wrong password, sent either way, without retrying', async () => {
    const wrong = { username: node.username, password: 'not the password' };
    const byCommand = await client(node, {}, wrong).connect().catch((error: unknown) => error);
    expect(byCommand).toBeInstanceOf(PearlRpcError);
    expect(byCommand).toMatchObject({ kind: 'http', status: 401 });
    const byHeader = await client(node, { auth: 'header' }, wrong).call('getblockcount').catch((error: unknown) => error);
    expect(byHeader).toBeInstanceOf(PearlRpcError);
    expect(byHeader).toMatchObject({ kind: 'network', method: 'getblockcount' });
  });

  it('refuses a certificate it was not told to trust', async () => {
    const ws = new PearlWsClient({ url: node.url, username: node.username, password: node.password, WebSocket });
    await expect(ws.connect()).rejects.toMatchObject({ kind: 'network' });
    await ws.close();
  });

  it('reports each mined block to watchBlocks and watchFilteredBlocks, and stops when unsubscribed', async () => {
    const ws = client(node);
    const blocks: PearlWsEvents['blockconnected'][] = [];
    const filtered: PearlWsEvents['filteredblockconnected'][] = [];
    const stopBlocks = ws.watchBlocks({ onBlock: (event) => blocks.push(event) });
    const stopFiltered = ws.watchFilteredBlocks({ onBlock: (event) => filtered.push(event) });
    const connected = record(ws, 'blockconnected');
    await settle(ws);

    const hashes = await mine(2);
    await connected.until((event) => event.hash === hashes[1]);
    const height = await pearld.getBlockCount();
    const headers = await Promise.all(hashes.map((hash) => pearld.getBlockHeader(hash)));
    expect(blocks).toEqual(hashes.map((hash, i) => ({ type: 'connected', hash, height: height - 1 + i, time: headers[i]!.time })));
    expect(filtered.map((event) => [event.type, event.hash, event.height, event.transactions])).toEqual(
      hashes.map((hash, i) => ['connected', hash, height - 1 + i, []]),
    );
    expect(blockHashHex(filtered[1]!.header)).toBe(hashes[1]);
    expect(filtered[1]!.header.timestamp).toBe(headers[1]!.time);

    stopBlocks();
    stopFiltered();
    await settle(ws);
    const other = client(node);
    const seen = record(other, 'blockconnected');
    other.watchBlocks({ onBlock: () => {} });
    await settle(other);
    const [next] = await mine(1);
    await seen.until((event) => event.hash === next);
    await settle(ws);
    expect(connected.seen).toHaveLength(2);
  });

  it('follows a payment to a watched address from the mempool into a block and on to its spend', async () => {
    const address = account.deriveAddress(1);
    const funding = await fund([{ script: toOutputScript(account.deriveAddress(0), network), value: 50_000_000n }]);
    const coin: AccountUtxo = { txid: funding.getId(), vout: 0, value: 50_000_000n, script: funding.outs[0]!.script, confirmations: 1, index: 0 };

    const ws = client(node);
    const received = record(ws, 'recvtx');
    const redeeming = record(ws, 'redeemingtx');
    const relevant = record(ws, 'relevanttxaccepted');
    const filteredBlocks = record(ws, 'filteredblockconnected');
    const accepted: PearlWsEvents['txaccepted'][] = [];
    const verbose: PearlWsEvents['txacceptedverbose'][] = [];
    ws.watchTransactions({ onTransaction: (tx) => accepted.push(tx) });
    ws.watchTransactions({ verbose: true, onTransaction: (tx) => verbose.push(tx) });
    ws.watchFilteredBlocks({ onBlock: () => {} });
    await ws.loadTxFilter({ addresses: [address] });
    await ws.notifyReceived([address]);
    await settle(ws);

    // In the mempool.
    const payment = payFromAccount(account, {
      network,
      utxos: [coin],
      recipients: [{ address, amount: 30_000_000n }],
      feeRate: FEE_RATE,
      changeAddress: account.deriveAddress(0, true),
    });
    await pearld.sendRawTransaction(payment.hex);
    expect(await received.until((event) => transactionId(parseTransaction(event.transaction)) === payment.txid)).toEqual({
      transaction: payment.hex,
      block: null,
    });
    expect(await relevant.until(() => true)).toEqual({ transaction: payment.hex });
    const total = payment.transaction.outs.reduce((sum, out) => sum + out.value, 0n);
    await settle(ws);
    expect(accepted).toEqual([{ txid: payment.txid, amount: total }]);
    expect(verbose.map((tx) => [tx.txid, tx.hex, tx.vout.map((out) => out.value)])).toEqual([
      [payment.txid, payment.hex, payment.transaction.outs.map((out) => out.value)],
    ]);

    // Mined.
    const [blockHash] = await mine(1);
    const block = parseBlock(await pearld.getRawBlock(blockHash!));
    const height = await pearld.getBlockCount();
    const mined = await received.until((event) => event.block !== null);
    expect(mined).toEqual({
      transaction: payment.hex,
      block: { hash: blockHash, height, index: 1, time: block.header.timestamp },
    });
    expect((await filteredBlocks.until((event) => event.hash === blockHash)).transactions).toEqual([payment.hex]);

    // Spent: pearld watches the output it reported without being asked.
    const spend = payFromAccount(account, {
      network,
      utxos: [{ txid: payment.txid, vout: 0, value: 30_000_000n, script: toOutputScript(address, network), confirmations: 1, index: 1 }],
      recipients: [{ address: miner.deriveAddress(320), amount: 'max' }],
      feeRate: FEE_RATE,
    });
    await pearld.sendRawTransaction(spend.hex);
    expect(await redeeming.until(() => true)).toEqual({ transaction: spend.hex, block: null });
    expect((await relevant.until((event) => event.transaction === spend.hex)).transaction).toBe(spend.hex);
    const [spendBlock] = await mine(1);
    expect((await redeeming.until((event) => event.block !== null)).block).toMatchObject({ hash: spendBlock, height: height + 1, index: 1 });
    expect((await filteredBlocks.until((event) => event.hash === spendBlock)).transactions).toEqual([spend.hex]);

    // rescanBlocks finds both again with the same filter, and nothing in a block without them.
    const [empty] = await mine(1);
    expect(await ws.rescanBlocks([blockHash!, spendBlock!, empty!])).toEqual([
      { hash: blockHash, transactions: [payment.hex] },
      { hash: spendBlock, transactions: [spend.hex] },
    ]);

    // The older rescan, on a connection that has watched nothing: the payment and its spend come
    // back as recvtx and redeemingtx with their blocks, then rescanfinished names the last block.
    const fresh = client(node);
    const found = { received: record(fresh, 'recvtx'), redeeming: record(fresh, 'redeemingtx'), finished: record(fresh, 'rescanfinished') };
    const progress = record(fresh, 'rescanprogress');
    // The end block is where pearld's rescan stops, not the last block it scans.
    await fresh.rescan(blockHash!, [address], [], empty);
    const last = parseBlock(await pearld.getRawBlock(spendBlock!));
    expect(await found.finished.until(() => true)).toEqual({ hash: spendBlock, height: height + 1, time: last.header.timestamp });
    expect(found.received.seen).toEqual([{ transaction: payment.hex, block: { hash: blockHash, height, index: 1, time: block.header.timestamp } }]);
    expect(found.redeeming.seen).toMatchObject([{ transaction: spend.hex, block: { hash: spendBlock, height: height + 1, index: 1 } }]);
    // pearld sends rescanprogress from a ten-second ticker, which two blocks never reach.
    expect(progress.seen).toEqual([]);
    // A rescan that starts after the payment sees only the spend of an outpoint it is told about.
    const later = client(node);
    const spends = record(later, 'redeemingtx');
    const done = record(later, 'rescanfinished');
    await later.rescan(spendBlock!, [], [{ txid: payment.txid, vout: 0 }]);
    await done.until(() => true);
    expect(spends.seen).toMatchObject([{ transaction: spend.hex, block: { hash: spendBlock } }]);
  });

  it('serves the limited user notifications and chain reads, and refuses it admin methods', async () => {
    const ws = client(node, {}, live!.limited);
    const connected = record(ws, 'blockconnected');
    ws.watchBlocks({ onBlock: () => {} });
    expect(await ws.call<number>('getblockcount')).toBe(await pearld.getBlockCount());
    const refused = await ws.call('getblockchaininfo').catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(PearlRpcError);
    expect((refused as PearlRpcError).message).toContain('limited user not authorized for this method');
    const [hash] = await mine(1);
    expect((await connected.until((event) => event.hash === hash)).hash).toBe(hash);
  });

  it('reconnects to a restarted node and resubscribes without being asked', async () => {
    const options = {
      exe: process.env.PEARLD!,
      dir: join(live!.dir, 'pearld-ws'),
      miningAddress: miner.deriveAddress(1),
      rpcPort: await freePort(),
    };
    second = await startPearld(options);
    const ws = client(second.endpoint, { reconnect: { initialDelay: 200, maxDelay: 1000 } });
    const connected = record(ws, 'blockconnected');
    const connects = record(ws, 'connect');
    const disconnects = record(ws, 'disconnect');
    const errors = record(ws, 'error');
    ws.watchBlocks({ onBlock: () => {} });
    const address = account.deriveAddress(5);
    await ws.notifyReceived([address]);
    const session = await ws.session();
    const [first] = await second.client.call<string[]>('generate', [1]);
    expect(await connected.until((event) => event.hash === first)).toMatchObject({ height: 1 });
    expect(connects.seen).toEqual([{ reconnect: false }]);

    await second.stop();
    expect((await disconnects.until(() => true)).error).toMatchObject({ kind: 'network' });
    // A call made while the node is down waits for the next session.
    const waiting = ws.call<number>('getblockcount');
    second = await startPearld(options);
    // pearld wipes its regtest chain on start, so the node is at genesis again.
    expect(await waiting).toBe(0);
    await connects.until((event) => event.reconnect);
    expect(await ws.session()).not.toBe(session);

    const [again] = await second.client.call<string[]>('generate', [1]);
    expect(again).not.toBe(first);
    expect(await connected.until((event) => event.hash === again)).toMatchObject({ height: 1 });
    expect(errors.seen).toEqual([]);
  });
});

describeOyster("Oyster's websocket", () => {
  const wallet = live?.oyster ?? nowhere;
  afterEach(closeAll);

  it('answers wallet and passed-through node calls with header auth', async () => {
    const ws = client(wallet, { auth: 'header', notifications: false });
    expect(await ws.call<boolean>('walletislocked')).toEqual(expect.any(Boolean));
    expect(await ws.call<bigint>('getbalance', ['*', 1], { amounts: ['result'] })).toEqual(expect.any(BigInt));
    expect(await ws.call<string>('getblockhash', [1])).toBe(await pearld.getBlockHash(1));
  });

  it('runs Oyster\'s typed methods over OysterWsClient', async () => {
    const agent = trustingAgent(wallet.ca);
    const ws = new OysterWsClient({
      url: wallet.url,
      username: wallet.username,
      password: wallet.password,
      WebSocket,
      webSocketInit: { dispatcher: agent },
    });
    try {
      expect(await ws.walletIsLocked()).toEqual(expect.any(Boolean));
      expect(await ws.getBalance()).toEqual(expect.any(BigInt));
      expect(() => ws.watchBlocks({ onBlock: () => {} })).toThrow("Oyster's websocket sends no notifications");
    } finally {
      await ws.close();
      await agent.close();
    }
  });

  it('does not accept the authenticate command', async () => {
    const ws = client(wallet, { auth: 'command', notifications: false });
    await expect(ws.connect()).rejects.toBeInstanceOf(PearlRpcError);
  });

  // Oyster echoes the close frame and keeps the TCP connection open
  // (wallet/rpc/jsonrpc/server.go never closes the upgraded connection), and
  // undici reports a close only once the connection ends.
  it('closes a connection to Oyster without waiting for a close Oyster never completes', async () => {
    const ws = client(wallet, { auth: 'header', notifications: false });
    await ws.connect();
    const started = Date.now();
    await ws.close();
    expect(Date.now() - started).toBeLessThan(5000);
    await expect(ws.call('getblockcount')).rejects.toThrow(/closed/);
  });

  it('refuses notification commands before they reach Oyster', async () => {
    const ws = client(wallet, { auth: 'header', notifications: false });
    await ws.connect();
    const text = "Oyster's websocket sends no notifications";
    expect(() => ws.watchBlocks({ onBlock: () => {} })).toThrow(text);
    expect(() => ws.watchFilteredBlocks({ onBlock: () => {} })).toThrow(text);
    expect(() => ws.watchTransactions({ onTransaction: () => {} })).toThrow(text);
    await expect(ws.loadTxFilter({ addresses: [account.deriveAddress(0)] })).rejects.toThrow(text);
    await expect(ws.notifyReceived([account.deriveAddress(0)])).rejects.toThrow(text);
    await expect(ws.notifySpent([])).rejects.toThrow(text);
    await expect(ws.rescanBlocks([])).rejects.toThrow(text);
  });
});
