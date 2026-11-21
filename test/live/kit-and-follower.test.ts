// pearljs's test kit and chain follower against real binaries: startRegtest
// from pearljs/testing-regtest starting and stopping pearld alone and with
// Oyster, trustingFetch over pearld's own certificate; followChain through a
// catch-up, a reorg, the websocket wake-up, the limited user and a resume from
// a stored cursor after a reorg it did not see; resolvePrevouts,
// prevoutsFromSearch and fetchMempool on nodes with and without --txindex.

import { join } from 'node:path';
import { WebSocket } from 'undici';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  deriveSigningAccountFromSeed,
  fetchMempool,
  followChain,
  generateMnemonic,
  MissingIndexError,
  mnemonicToSeed,
  payFromAccount,
  PearldClient,
  PearlWsClient,
  prevoutsFromSearch,
  resolvePrevouts,
  toOutputScript,
} from '../../src/index.js';
import type { FollowCursor, FollowEvent, Transaction } from '../../src/index.js';
import { startRegtest, trustingFetch } from '../../src/testing-regtest.js';
import { describeLive, eventually, FEE_RATE, fund, limited, live, mine, network, nowhere, pearld, spentOutputs } from './chain.js';
import { startPearld } from './processes.js';
import type { RunningPearld } from './processes.js';
import { trustingAgent } from './context.js';

const account = deriveSigningAccountFromSeed(mnemonicToSeed(generateMnemonic()), network);

/** Events from a follower until `done` says to stop, or a minute passes. */
async function collect(follower: AsyncIterator<FollowEvent>, done: (events: FollowEvent[]) => boolean): Promise<FollowEvent[]> {
  const events: FollowEvent[] = [];
  const deadline = Date.now() + 60_000;
  while (!done(events)) {
    if (Date.now() > deadline) throw new Error(`the follower stalled after ${JSON.stringify(events.map(({ type, height }) => [type, height]))}`);
    const next = await follower.next();
    if (next.done === true) break;
    events.push(next.value);
  }
  return events;
}

const brief = (events: FollowEvent[]) => events.map((event) => ({ type: event.type, height: event.height, hash: event.hash }));

describeLive('startRegtest', () => {
  it('starts pearld alone from the binary, mines a block and stops it', async () => {
    const regtest = await startRegtest({ pearld: process.env.PEARLD!, dir: join(live!.dir, 'kit-alone') });
    let stopped = false;
    try {
      expect(regtest.oyster).toBeNull();
      expect(await regtest.node.getBlockCount()).toBe(0);
      const [hash] = await regtest.mine(1);
      expect(await regtest.node.getBestBlockHash()).toBe(hash);
      const limitedClient = new PearldClient({ url: regtest.endpoint.url, ...regtest.limited, fetch: trustingFetch(regtest.endpoint.ca) });
      expect(await limitedClient.getBlockCount()).toBe(1);
      await expect(limitedClient.getBlockchainInfo()).rejects.toMatchObject({ code: 'RPC_ERROR' });
      await regtest.stop();
      stopped = true;
      await expect(regtest.node.getBlockCount()).rejects.toMatchObject({ code: 'RPC_NETWORK' });
      await regtest.stop();
    } finally {
      if (!stopped) await regtest.stop();
    }
  });

  it('starts pearld with Oyster on the mnemonic it is given and stops both', async () => {
    const mnemonic = generateMnemonic();
    const regtest = await startRegtest({ pearld: process.env.PEARLD!, oyster: process.env.OYSTER, dir: join(live!.dir, 'kit-oyster'), oysterMnemonic: mnemonic });
    try {
      const wallet = regtest.oyster;
      if (process.env.OYSTER === undefined || process.env.OYSTER === '') {
        expect(wallet).toBeNull();
        return;
      }
      expect(await wallet!.client.getInfo()).toMatchObject({ blocks: 0 });
      expect(await wallet!.client.getNewAddress()).toBe(deriveSigningAccountFromSeed(mnemonicToSeed(mnemonic), network).deriveAddress(0));
    } finally {
      await regtest.stop();
    }
    if (regtest.oyster !== null) await expect(regtest.oyster.client.getInfo()).rejects.toMatchObject({ code: 'RPC_NETWORK' });
    await expect(regtest.node.getBlockCount()).rejects.toMatchObject({ code: 'RPC_NETWORK' });
  });

  it('talks to the suite\'s pearld through trustingFetch and its certificate', async () => {
    const endpoint = live?.pearld ?? nowhere;
    const client = new PearldClient({ url: endpoint.url, username: endpoint.username, password: endpoint.password, fetch: trustingFetch(endpoint.ca) });
    expect(await client.getBestBlockHash()).toBe(await pearld.getBestBlockHash());
    const stranger = new PearldClient({ url: endpoint.url, username: endpoint.username, password: endpoint.password, fetch: trustingFetch((await startedCa()) ?? '') });
    await expect(stranger.getBlockCount()).rejects.toMatchObject({ code: 'RPC_NETWORK' });
  });
});

// A certificate pearld did not make: the one the first kit node wrote.
async function startedCa(): Promise<string | null> {
  const { readFile } = await import('node:fs/promises');
  return readFile(join(live!.dir, 'kit-alone', 'pearld', 'rpc.cert'), 'utf8').catch(() => null);
}

describeLive('followChain on pearld', () => {
  it('catches up, says when it is synced, and walks a reorg back before the new branch', async () => {
    const tip = await pearld.getBlockCount();
    const follower = followChain(pearld, { from: { height: tip - 4 }, pollInterval: 500 });
    const caughtUp = await collect(follower, (events) => events.some((event) => event.type === 'synced'));
    expect(caughtUp.map((event) => event.type)).toEqual(['connected', 'connected', 'connected', 'connected', 'connected', 'synced']);
    for (const [i, event] of caughtUp.slice(0, 5).entries()) expect(event).toMatchObject({ height: tip - 4 + i, hash: await pearld.getBlockHash(tip - 4 + i) });
    const first = caughtUp[0] as Extract<FollowEvent, { type: 'connected' }>;
    expect(first.block.transactions[0]!.isCoinbase()).toBe(true);

    const old = await pearld.getBestBlockHash();
    await pearld.invalidateBlock(old);
    const branch = await mine(2);
    await pearld.reconsiderBlock(old);
    const reorg = await collect(follower, (events) => events.filter((event) => event.type === 'connected').length === 2);
    expect(brief(reorg)).toEqual([
      { type: 'disconnected', height: tip, hash: old },
      { type: 'connected', height: tip, hash: branch[0] },
      { type: 'connected', height: tip + 1, hash: branch[1] },
    ]);
    expect(follower.cursor()).toMatchObject({ height: tip + 1, hash: branch[1] });
    await follower.return?.();
  });

  it('is woken by the websocket long before its poll, as the limited user', async () => {
    const endpoint = live?.pearld ?? nowhere;
    const agent = trustingAgent(endpoint.ca);
    const ws = new PearlWsClient({ url: endpoint.url, username: live!.limited.username, password: live!.limited.password, WebSocket, webSocketInit: { dispatcher: agent } });
    const controller = new AbortController();
    try {
      const height = (await pearld.getBlockCount()) + 1;
      const follower = followChain(limited, { from: { height }, ws, pollInterval: 600_000, signal: controller.signal });
      // The follower starts on its first read; it is given time to find nothing there and wait before the block comes.
      const next = follower.next();
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const [hash] = await mine(1);
      const started = Date.now();
      expect((await next).value).toMatchObject({ type: 'connected', height, hash });
      // Ten minutes before its next poll: the websocket woke it.
      expect(Date.now() - started).toBeLessThan(30_000);
      controller.abort();
      expect(await follower.next()).toMatchObject({ done: true });
    } finally {
      await ws.close();
      await agent.close();
    }
  });

  it('resumes from a stored cursor and first hands back a block a reorg took while it was stopped', async () => {
    const follower = followChain(pearld, { from: 'tip', stopAtTip: true });
    await collect(follower, () => false);
    const [stored] = await mine(1);
    // Started a few blocks back, so the cursor carries the ancestors it needs to walk back.
    const again = followChain(pearld, { from: { height: (await pearld.getBlockCount()) - 3 }, stopAtTip: true });
    await collect(again, () => false);
    const cursor: FollowCursor = JSON.parse(JSON.stringify(again.cursor())) as FollowCursor;
    expect(cursor).toMatchObject({ hash: stored });
    expect(cursor.ancestors!.length).toBeGreaterThanOrEqual(3);

    // While stopped: the stored block is replaced by a longer branch.
    await pearld.invalidateBlock(stored!);
    const branch = await mine(2);
    await pearld.reconsiderBlock(stored!);
    const resumed = followChain(pearld, { from: { cursor }, stopAtTip: true });
    const events = await collect(resumed, () => false);
    expect(brief(events)).toEqual([
      { type: 'disconnected', height: cursor.height, hash: stored },
      { type: 'connected', height: cursor.height, hash: branch[0] },
      { type: 'connected', height: cursor.height + 1, hash: branch[1] },
      { type: 'synced', height: cursor.height + 1, hash: branch[1] },
    ]);
  });
});

describeLive('prevouts and the mempool with and without --txindex', () => {
  let bare: RunningPearld;
  let parent: Transaction;
  let child: ReturnType<typeof payFromAccount>;

  beforeAll(async () => {
    bare = await startPearld({ exe: process.env.PEARLD!, dir: join(live!.dir, 'pearld-noindex'), miningAddress: account.deriveAddress(50), withoutIndexes: true, extraArgs: [`--connect=${live!.p2p}`] });
    parent = await fund([
      { script: toOutputScript(account.deriveAddress(0), network), value: 6_000_000n },
      { script: toOutputScript(account.deriveAddress(1), network), value: 4_000_000n },
    ]);
    const tip = await pearld.getBestBlockHash();
    await eventually(() => bare.client.getBestBlockHash(), (hash) => hash === tip, 120_000);
    child = payFromAccount(account, {
      network,
      utxos: [0, 1].map((vout) => ({ txid: parent.getId(), vout, value: parent.outs[vout]!.value, script: parent.outs[vout]!.script, confirmations: 1, index: vout })),
      recipients: [{ address: account.deriveAddress(2), amount: 9_000_000n }],
      feeRate: FEE_RATE,
      changeAddress: account.deriveAddress(3),
    });
    await pearld.sendRawTransaction(child.hex);
    await bare.client.sendRawTransaction(child.hex);
  });
  afterAll(async () => {
    await mine(1);
    await bare?.stop();
  });

  it('resolves prevouts with the index, refuses with MissingIndexError without it, and reads them from a search page', async () => {
    const tx = child.transaction;
    const expected = await spentOutputs(tx);
    expect(await resolvePrevouts(tx, pearld)).toEqual(expected);
    const known = new Map<string, Transaction>();
    expect(await resolvePrevouts(tx, limited, { known })).toEqual(expected);
    expect([...known.keys()]).toEqual([parent.getId()]);
    // The bare node knows the parent only from a block, which getrawtransaction cannot reach without --txindex.
    await expect(resolvePrevouts(tx, bare.client)).rejects.toBeInstanceOf(MissingIndexError);
    expect(await resolvePrevouts(tx, bare.client, { known: new Map([[parent.getId(), parent]]) })).toEqual(expected);

    const page = await pearld.searchRawTransactions(account.deriveAddress(2), { vinExtra: true });
    const found = page.find((entry) => entry.txid === tx.getId())!;
    expect(prevoutsFromSearch(found, network)).toEqual(expected);
  });

  it('reads the same mempool from both nodes, with fees and parents first', async () => {
    const withIndex = await fetchMempool(pearld);
    const without = await fetchMempool(bare.client);
    expect(without.get(child.txid)).toMatchObject({ fee: child.fee });
    expect(withIndex.get(child.txid)).toMatchObject({ fee: child.fee });
    expect(withIndex.get(child.txid)!.tx.toHex()).toBe(child.hex);
    expect(without.get(child.txid)!.tx.toHex()).toBe(child.hex);
  });
});
