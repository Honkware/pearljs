// The chain follower against the simulated chain of pearljs/testing: caught
// up and mid-catch-up, through reorganizations of several depths, a chain
// that gets shorter, restarts from a stored cursor, a node that fails for a
// while, and random histories. Every run replays the events it was given and
// must end with exactly the node's chain. Then resolvePrevouts and
// fetchMempool against the same node.

import { describe, expect, it } from 'vitest';
import {
  MissingIndexError,
  PearlRpcError,
  PearlWsClient,
  blockHashHex,
  checkPackageLimits,
  checkReplacement,
  customNetwork,
  fetchMempool,
  followChain,
  inspectTransaction,
  networks,
  parsePearl,
  payFromAccount,
  prevoutsFromSearch,
  resolvePrevouts,
  signalsReplacement,
  watchChain,
} from '../src/index.js';
import type { ChainFollower, FollowCursor, FollowEvent, FollowOptions, Rpc, Transaction } from '../src/index.js';
import { SimulatedChain, testAccount, testAddress } from '../src/testing.js';
import { seededRandom } from './wallet-helpers.js';
import { bytesToHex } from './vector-helpers.js';

const prl = parsePearl;
const quick = customNetwork(networks.regtest, { coinbaseMaturity: 5 });
const small = (premine = 12): SimulatedChain => new SimulatedChain({ network: quick, premine });
const alice = testAccount(0);
const FAST = { pollInterval: 1, retryDelay: 1, maxRetryDelay: 2 };

/** The chain a consumer would hold after applying the events: each must fit on what came before. */
class Replica {
  blocks: { height: number; hash: string }[] = [];
  log: string[] = [];

  apply(event: FollowEvent): void {
    const top = this.blocks[this.blocks.length - 1];
    this.log.push(`${event.type} ${event.height}`);
    if (event.type === 'connected') {
      expect(blockHashHex(event.block.header)).toBe(event.hash);
      if (top !== undefined) {
        expect(event.height).toBe(top.height + 1);
        expect(bytesToHex(event.block.header.prevBlock.slice().reverse())).toBe(top.hash);
      }
      this.blocks.push({ height: event.height, hash: event.hash });
    } else if (event.type === 'disconnected') {
      expect({ height: event.height, hash: event.hash }).toEqual(top);
      this.blocks.pop();
    } else {
      expect({ height: event.height, hash: event.hash }).toEqual(top);
    }
  }

  matches(chain: SimulatedChain): void {
    const from = this.blocks[0]?.height ?? 0;
    expect(this.blocks).toEqual(chain.blocks.slice(from).map(({ height, hash }) => ({ height, hash })));
  }
}

/** Pulls events until the follower says it is at the tip. */
async function toTip(follower: ChainFollower, replica: Replica): Promise<void> {
  for (;;) {
    const { value, done } = await follower.next();
    if (done === true) throw new Error('the follower ended');
    replica.apply(value);
    if (value.type === 'synced') return;
  }
}

function follow(chain: SimulatedChain, options: Partial<FollowOptions> = {}): { follower: ChainFollower; replica: Replica } {
  return { follower: followChain(chain.rpc, { from: { height: 0 }, ...FAST, ...options }), replica: new Replica() };
}

describe('followChain', () => {
  it('hands out the chain from genesis in order and ends at the tip when asked to', async () => {
    const chain = small();
    chain.pay(alice.deriveAddress(0), prl('1'));
    chain.mine();
    const replica = new Replica();
    const events: FollowEvent[] = [];
    for await (const event of followChain(chain.rpc, { from: { height: 0 }, stopAtTip: true })) {
      events.push(event);
      replica.apply(event);
    }
    replica.matches(chain);
    expect(events).toHaveLength(chain.height + 2);
    expect(events[events.length - 1]).toEqual({ type: 'synced', height: chain.height, hash: chain.tip.hash });
    const last = events[events.length - 2] as Extract<FollowEvent, { type: 'connected' }>;
    expect(last.block.transactions.map((tx) => tx.getId())).toEqual(chain.tip.txs.map((tx) => tx.getId()));
    expect(last.block.certificate?.version).toBe(chain.tip.block.certificate?.version);
    // Two requests a block while catching up, and the tip asked for only at the ends.
    expect(chain.calls.get('getblock')).toBe(chain.height + 1);
    expect(chain.calls.get('getblockhash')).toBe(chain.height + 1);
    expect(chain.calls.get('getbestblock')).toBeLessThanOrEqual(3);
  });

  it('starts at a height, at a hash, after the tip, and waits for a height the chain has not reached', async () => {
    const chain = small();
    const byHeight = follow(chain, { from: { height: 9 } });
    await toTip(byHeight.follower, byHeight.replica);
    expect(byHeight.replica.log).toEqual(['connected 9', 'connected 10', 'connected 11', 'connected 12', 'synced 12']);
    expect(byHeight.follower.cursor()).toEqual({ height: 12, hash: chain.tip.hash, ancestors: [11, 10, 9].map((height) => chain.blocks[height]!.hash) });

    const byHash = follow(chain, { from: { hash: chain.blocks[11]!.hash } });
    await toTip(byHash.follower, byHash.replica);
    expect(byHash.replica.log).toEqual(['connected 11', 'connected 12', 'synced 12']);
    const genesis = follow(chain, { from: { hash: chain.blocks[0]!.hash }, stopAtTip: true });
    expect((await genesis.follower.next()).value).toMatchObject({ type: 'connected', height: 0, hash: quick.genesisHash });

    const fromTip = follow(chain, { from: 'tip' });
    const future = follow(chain, { from: { height: 15 } });
    expect(future.follower.cursor()).toBeNull();
    const [atTip, later] = [fromTip.follower.next(), future.follower.next()];
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fromTip.follower.cursor()).toEqual({ height: 12, hash: chain.tip.hash, ancestors: [] });
    chain.mine(3);
    expect((await atTip).value).toMatchObject({ type: 'connected', height: 13 });
    expect((await later).value).toMatchObject({ type: 'connected', height: 15, hash: chain.tip.hash });
    for (const { follower } of [byHeight, byHash, genesis, fromTip, future]) await follower.return?.();
  });

  it('refuses a start it cannot stand on', async () => {
    const chain = small();
    const stale = chain.tip.hash;
    chain.reorg(1);
    await expect(followChain(chain.rpc, { from: { hash: stale } }).next()).rejects.toMatchObject({ code: 'FOLLOW_START_UNKNOWN', message: expect.stringContaining('not on the node') });
    await expect(followChain(chain.rpc, { from: { hash: 'ab'.repeat(32) } }).next()).rejects.toMatchObject({ code: 'FOLLOW_START_UNKNOWN' });
    expect(() => followChain(chain.rpc, { from: { hash: 'xyz' } })).toThrow(TypeError);
    expect(() => followChain(chain.rpc, { from: { height: -1 } })).toThrow(RangeError);
    expect(() => followChain(chain.rpc, { from: 'tip', depth: 0 })).toThrow(RangeError);
    for (const cursor of [{ height: 1 }, { height: 1, hash: 'ab'.repeat(32), ancestors: ['x'] }, { height: 1, hash: 'ab'.repeat(32), ancestors: ['ab'.repeat(32), 'cd'.repeat(32)] }, { height: 1.5, hash: 'ab'.repeat(32) }]) {
      expect(() => followChain(chain.rpc, { from: { cursor: cursor as FollowCursor } })).toThrow(TypeError);
    }
  });

  for (const depth of [1, 3, 10]) {
    it(`hands back the ${depth} blocks a reorganization removed, newest first, and then the new branch`, async () => {
      const chain = small();
      const { follower, replica } = follow(chain);
      await toTip(follower, replica);
      const height = chain.height;
      chain.reorg(depth);
      replica.log = [];
      await toTip(follower, replica);
      expect(replica.log).toEqual([
        ...Array.from({ length: depth }, (_, i) => `disconnected ${height - i}`),
        ...Array.from({ length: depth + 1 }, (_, i) => `connected ${height - depth + 1 + i}`),
        `synced ${height + 1}`,
      ]);
      replica.matches(chain);
      await follower.return?.();
    });
  }

  it('follows a chain that gets shorter, and back again', async () => {
    const chain = small();
    const { follower, replica } = follow(chain);
    await toTip(follower, replica);
    const removed = chain.blocks[10]!;
    chain.invalidate(removed.hash);
    replica.log = [];
    await toTip(follower, replica);
    expect(replica.log).toEqual(['disconnected 12', 'disconnected 11', 'disconnected 10', 'synced 9']);
    replica.matches(chain);
    chain.reconsider(removed.hash);
    replica.log = [];
    await toTip(follower, replica);
    expect(replica.log).toEqual(['connected 10', 'connected 11', 'connected 12', 'synced 12']);
    // Another branch of the same length as the one followed.
    chain.invalidate(chain.tip.hash);
    chain.mine();
    replica.log = [];
    await toTip(follower, replica);
    expect(replica.log).toEqual(['disconnected 12', 'connected 12', 'synced 12']);
    replica.matches(chain);
    await follower.return?.();
  });

  it('keeps one chain when the node reorganizes while it is still catching up', async () => {
    const chain = small(30);
    const { follower, replica } = follow(chain);
    for (let i = 0; i < 20; i += 1) replica.apply((await follower.next()).value as FollowEvent);
    // The follower stands on block 19; the node replaces everything from 16 up.
    chain.reorg(15);
    await toTip(follower, replica);
    expect(replica.log.slice(20, 25)).toEqual(['disconnected 19', 'disconnected 18', 'disconnected 17', 'disconnected 16', 'connected 16']);
    replica.matches(chain);
    await follower.return?.();
  });

  it('ends with the node\'s chain after any mix of blocks, reorganizations and invalidations', async () => {
    for (let seed = 1; seed <= 25; seed += 1) {
      const random = seededRandom(seed);
      const chain = small(8);
      const { follower, replica } = follow(chain, { depth: 40 });
      const steps: string[] = [];
      let waiting: Promise<IteratorResult<FollowEvent>> | null = null;
      for (let i = 0; i < 40; i += 1) {
        const roll = random();
        if (roll < 0.35) {
          const count = 1 + Math.floor(random() * 3);
          chain.mine(count);
          steps.push(`mine ${count}`);
        } else if (roll < 0.5 && chain.height > 6) {
          const depth = 1 + Math.floor(random() * 5);
          chain.reorg(depth, { mine: Math.floor(random() * (depth + 3)) });
          steps.push(`reorg ${depth}`);
        } else if (roll < 0.6 && chain.height > 6) {
          chain.invalidate(chain.blocks[chain.height - Math.floor(random() * 3)]!.hash);
          steps.push('invalidate');
        } else {
          // The follower takes a few steps between the node's moves, never enough to be sure of catching up.
          for (let pulls = Math.floor(random() * 4); pulls > 0; pulls -= 1) {
            // A pull that finds the follower waiting at the tip stays open, and is the first one answered later.
            waiting ??= follower.next();
            const next = await Promise.race([waiting, new Promise<null>((resolve) => setTimeout(() => resolve(null), 15))]);
            if (next === null) break;
            waiting = null;
            replica.apply(next.value as FollowEvent);
          }
          steps.push('follow');
        }
      }
      chain.mine();
      while (replica.blocks[replica.blocks.length - 1]?.hash !== chain.tip.hash) {
        replica.apply((await (waiting ?? follower.next())).value as FollowEvent);
        waiting = null;
      }
      try {
        replica.matches(chain);
      } catch (err) {
        throw new Error(`seed ${seed}: ${steps.join(', ')}\n${String(err)}`);
      }
      await follower.return?.();
    }
  });

  it('goes on from a stored cursor, handing back what left the chain while it was away', async () => {
    const chain = small();
    const first = follow(chain);
    await toTip(first.follower, first.replica);
    // The cursor survives a trip through JSON, as it would through a database.
    const stored = JSON.parse(JSON.stringify(first.follower.cursor())) as FollowCursor;
    expect(stored).toEqual({ height: 12, hash: chain.tip.hash, ancestors: chain.blocks.slice(0, 12).map((block) => block.hash).reverse() });
    await first.follower.return?.();

    chain.mine(2);
    const second = follow(chain, { from: { cursor: stored } });
    second.replica.blocks = [...first.replica.blocks];
    await toTip(second.follower, second.replica);
    expect(second.replica.log).toEqual(['connected 13', 'connected 14', 'synced 14']);
    const again = second.follower.cursor()!;
    await second.follower.return?.();

    chain.reorg(4);
    const third = follow(chain, { from: { cursor: again } });
    third.replica.blocks = [...second.replica.blocks];
    await toTip(third.follower, third.replica);
    expect(third.replica.log).toEqual(['disconnected 14', 'disconnected 13', 'disconnected 12', 'disconnected 11', 'connected 11', 'connected 12', 'connected 13', 'connected 14', 'connected 15', 'synced 15']);
    third.replica.matches(chain);
    await third.follower.return?.();

    // A cursor at the tip has nothing to hand out but the news that it is there.
    const idle = followChain(chain.rpc, { from: { cursor: third.follower.cursor()! }, stopAtTip: true });
    expect((await idle.next()).value).toEqual({ type: 'synced', height: 15, hash: chain.tip.hash });
    expect((await idle.next()).done).toBe(true);
  });

  it('remembers no more than its depth, and says so when the chain changes below that', async () => {
    const chain = small(30);
    const { follower, replica } = follow(chain, { depth: 5 });
    await toTip(follower, replica);
    const cursor = follower.cursor()!;
    expect(cursor.ancestors).toEqual(chain.blocks.slice(25, 30).map((block) => block.hash).reverse());
    // Five deep is as far as five remembered blocks reach.
    chain.reorg(5);
    replica.log = [];
    await toTip(follower, replica);
    expect(replica.log.slice(0, 6)).toEqual(['disconnected 30', 'disconnected 29', 'disconnected 28', 'disconnected 27', 'disconnected 26', 'connected 26']);
    replica.matches(chain);
    chain.reorg(6);
    const seen: string[] = [];
    await expect((async () => {
      for await (const event of follower) seen.push(`${event.type} ${event.height}`);
    })()).rejects.toMatchObject({ code: 'FOLLOW_REORG_TOO_DEEP', message: expect.stringContaining('height 26') });
    expect(seen).toEqual(['disconnected 31', 'disconnected 30', 'disconnected 29', 'disconnected 28', 'disconnected 27']);

    // A cursor that carries no ancestors can go forward only.
    const bare = { height: cursor.height, hash: cursor.hash };
    await expect(followChain(chain.rpc, { from: { cursor: bare }, ...FAST }).next()).rejects.toMatchObject({ code: 'FOLLOW_REORG_TOO_DEEP' });
    const fine = followChain(chain.rpc, { from: { cursor: { height: 20, hash: chain.blocks[20]!.hash } }, ...FAST });
    expect((await fine.next()).value).toMatchObject({ type: 'connected', height: 21 });
    await fine.return?.();
  });

  it('waits out a node that fails for a while and loses nothing', async () => {
    const chain = small();
    const retried: [string, number][] = [];
    const { follower, replica } = follow(chain, { onRetry: (error, attempt) => retried.push([error.kind, attempt]) });
    for (let i = 0; i < 5; i += 1) replica.apply((await follower.next()).value as FollowEvent);
    chain.failNext(4);
    await toTip(follower, replica);
    expect(retried).toEqual([['network', 1], ['network', 2], ['network', 3], ['network', 4]]);
    replica.matches(chain);
    // Failures are counted in a row: a reply in between starts the count again.
    chain.mine();
    chain.failNext(1);
    await toTip(follower, replica);
    expect(retried[4]).toEqual(['network', 1]);
    chain.reorg(2);
    chain.failNext(2, { error: (method) => new PearlRpcError('http', method, 'HTTP 503', { status: 503 }) });
    await toTip(follower, replica);
    replica.matches(chain);
    await follower.return?.();
  });

  it('gives up after the retries it was allowed, and at once on an answer that will not change', async () => {
    const chain = small();
    const limited = followChain(chain.rpc, { from: { height: 0 }, ...FAST, retries: 2 });
    chain.failNext(3);
    await expect(limited.next()).rejects.toMatchObject({ code: 'RPC_NETWORK' });
    const refused = followChain(chain.rpc, { from: 'tip', ...FAST });
    chain.failNext(1, { error: (method) => new PearlRpcError('rpc', method, 'limited user not authorized for this method', { rpcCode: -32602 }) });
    await expect(refused.next()).rejects.toMatchObject({ code: 'RPC_ERROR', rpcCode: -32602 });
    expect(chain.calls.get('getbestblock')).toBe(1);
  });

  it('ends without an error when its signal fires, waiting or working', async () => {
    const chain = small();
    const waiting = new AbortController();
    const { follower, replica } = follow(chain, { signal: waiting.signal, pollInterval: 60_000 });
    await toTip(follower, replica);
    const next = follower.next();
    setTimeout(() => waiting.abort(), 5);
    expect((await next).done).toBe(true);
    expect((await follower.next()).done).toBe(true);

    const before = new AbortController();
    before.abort();
    expect((await followChain(chain.rpc, { from: { height: 0 }, signal: before.signal }).next()).done).toBe(true);
    // Aborted in the middle of a request, which the client reports as a failure: still a clean end.
    const during = new AbortController();
    const slow: Rpc = { call: async (method, params, options) => (during.abort(), chain.rpc.call(method, params, options)) };
    expect((await followChain(slow, { from: { height: 0 }, signal: during.signal }).next()).done).toBe(true);
  });

  it('is woken by a websocket notification long before its next poll, and lets go of the socket when it ends', async () => {
    const chain = small();
    const ws = new PearlWsClient({ url: 'ws://simulated.invalid', WebSocket: chain.WebSocket });
    await ws.connect();
    let watching = 0;
    const counted = {
      watchBlocks: (options: Parameters<PearlWsClient['watchBlocks']>[0]) => {
        watching += 1;
        const off = ws.watchBlocks(options);
        return () => (watching -= 1, off());
      },
    };
    const follower = followChain(ws, { from: 'tip', ws: counted, pollInterval: 60_000 });
    const next = follower.next();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(watching).toBe(1);
    const started = Date.now();
    chain.mine();
    expect((await next).value).toMatchObject({ type: 'connected', height: chain.height, hash: chain.tip.hash });
    expect(Date.now() - started).toBeLessThan(2000);
    expect((await follower.next()).value).toMatchObject({ type: 'synced' });
    // A reorganization announced while the follower is busy is not lost: the next wait returns at once.
    const idle = follower.next();
    await new Promise((resolve) => setTimeout(resolve, 20));
    chain.reorg(1);
    expect((await idle).value).toMatchObject({ type: 'disconnected', height: chain.height - 1 });
    await follower.return?.();
    expect(watching).toBe(0);
    await ws.close();
  });
});

describe('watchChain', () => {
  it('hands events to a handler one at a time with the cursor to store, until stopped', async () => {
    const chain = small();
    const replica = new Replica();
    const cursors: FollowCursor[] = [];
    let busy = 0;
    let overlapped = false;
    const watch = watchChain(chain.rpc, {
      from: { height: 0 },
      ...FAST,
      onEvent: async (event, cursor) => {
        busy += 1;
        overlapped ||= busy > 1;
        await new Promise((resolve) => setTimeout(resolve, 1));
        replica.apply(event);
        cursors.push(cursor);
        busy -= 1;
        if (event.type === 'synced' && event.height === 14) watch.stop();
      },
    });
    chain.mine(2);
    await watch.done;
    expect(overlapped).toBe(false);
    replica.matches(chain);
    expect(cursors[5]).toEqual({ height: 5, hash: chain.blocks[5]!.hash, ancestors: chain.blocks.slice(0, 5).map((block) => block.hash).reverse() });
    expect(watch.cursor()).toEqual(cursors[cursors.length - 1]);
    expect(watch.cursor()!.height).toBe(14);
  });

  it('stops and rejects when the handler throws, or tells onError when there is one', async () => {
    const chain = small();
    let handled = 0;
    const failing = watchChain(chain.rpc, {
      from: { height: 0 },
      onEvent: () => {
        handled += 1;
        if (handled === 3) throw new Error('database is down');
      },
    });
    await expect(failing.done).rejects.toThrow('database is down');
    expect(handled).toBe(3);
    expect(failing.cursor()!.height).toBe(2);

    const errors: unknown[] = [];
    const told = watchChain(chain.rpc, { from: { hash: 'ab'.repeat(32) }, onEvent: () => {}, onError: (error) => errors.push(error) });
    await told.done;
    expect(errors).toEqual([expect.objectContaining({ code: 'FOLLOW_START_UNKNOWN' })]);

    const outer = new AbortController();
    const stopped = watchChain(chain.rpc, { from: 'tip', signal: outer.signal, pollInterval: 60_000, onEvent: () => {} });
    outer.abort();
    await expect(stopped.done).resolves.toBeUndefined();
    const never = new AbortController();
    never.abort();
    await expect(watchChain(chain.rpc, { from: 'tip', signal: never.signal, onEvent: () => {} }).done).resolves.toBeUndefined();
  });
});

describe('resolvePrevouts', () => {
  /** A confirmed payment to alice, an unconfirmed spend of it, and a spend of that. */
  function history(options: object = {}) {
    const chain = new SimulatedChain({ network: quick, ...options });
    const coin = chain.fund(alice.deriveAddress(0), prl('10'));
    const first = payFromAccount(alice, { network: quick, utxos: [{ ...coin, index: 0 }], recipients: [{ address: alice.deriveAddress(1), amount: prl('4') }], feeRate: 2000n, changeAddress: alice.deriveAddress(2), rbf: true });
    chain.accept(first.transaction);
    const second = payFromAccount(alice, {
      network: quick,
      utxos: [
        { txid: first.txid, vout: 0, value: prl('4'), script: first.transaction.outs[0]!.script, index: 1 },
        { txid: first.txid, vout: 1, value: first.change, script: first.transaction.outs[1]!.script, index: 2 },
      ],
      recipients: [{ address: testAddress(0), amount: 'max' }],
      feeRate: 2000n,
      minConfirmations: 0,
    });
    chain.accept(second.transaction);
    return { chain, coin, first, second };
  }

  it('reads each parent once and returns what inspectTransaction needs', async () => {
    const { chain, coin, first, second } = history();
    expect(await resolvePrevouts(first.transaction, chain.rpc)).toEqual([{ script: coin.script, value: prl('10') }]);
    chain.calls.clear();
    const prevouts = await resolvePrevouts(second.transaction, chain.rpc);
    expect(prevouts).toEqual(second.prevouts);
    // Two inputs, one parent, one request.
    expect(chain.calls.get('getrawtransaction')).toBe(1);
    const info = inspectTransaction(second.transaction, prevouts, quick);
    expect(info.fee).toBe(second.fee);
    expect(info.inputs.map((input) => input.address)).toEqual([alice.deriveAddress(1), alice.deriveAddress(2)]);
    chain.mine();
    expect(await resolvePrevouts(second.transaction, chain.rpc)).toEqual(second.prevouts);
    expect(await resolvePrevouts(chain.tip.txs[0]!, chain.rpc)).toEqual([]);
  });

  it('looks in what the caller already has before asking, and adds what it fetched', async () => {
    const { chain, first, second } = history();
    chain.mine();
    const known = new Map<string, Transaction>();
    // Every transaction of a block, resolved against the block itself first.
    for (const tx of chain.tip.txs) known.set(tx.getId(), tx);
    chain.calls.clear();
    expect(await resolvePrevouts(second.transaction, chain.rpc, { known })).toEqual(second.prevouts);
    expect(chain.calls.get('getrawtransaction')).toBeUndefined();
    await resolvePrevouts(first.transaction, chain.rpc, { known });
    await resolvePrevouts(first.transaction, chain.rpc, { known });
    expect(chain.calls.get('getrawtransaction')).toBe(1);
    expect(known.size).toBe(chain.tip.txs.length + 1);
  });

  it('refuses a parent other than the one asked for, and keeps it out of what the caller has', async () => {
    const { chain, coin, first, second } = history();
    const rpc = {
      call: async <T,>(method: string, params: readonly unknown[] = []): Promise<T> =>
        chain.rpc.call<T>(method, method === 'getrawtransaction' && params[0] === first.txid ? [coin.txid, ...params.slice(1)] : params),
    };
    const known = new Map<string, Transaction>();
    await expect(resolvePrevouts(second.transaction, rpc, { known })).rejects.toMatchObject({ code: 'RPC_RESPONSE', message: expect.stringContaining(first.txid) });
    expect(known.has(first.txid)).toBe(false);
  });

  it('says which parent or output is missing, and which index pearld runs without', async () => {
    const { chain, coin, first } = history();
    const orphan = payFromAccount(alice, { network: quick, utxos: [{ ...coin, txid: 'ef'.repeat(32), index: 0 }], recipients: [{ address: testAddress(0), amount: 'max' }], feeRate: 2000n });
    await expect(resolvePrevouts(orphan.transaction, chain.rpc)).rejects.toMatchObject({ code: 'PREVOUT_NOT_FOUND', message: expect.stringContaining('ef'.repeat(32)) });
    const beyond = payFromAccount(alice, { network: quick, utxos: [{ ...coin, vout: 9, index: 0 }], recipients: [{ address: testAddress(0), amount: 'max' }], feeRate: 2000n });
    await expect(resolvePrevouts(beyond.transaction, chain.rpc)).rejects.toMatchObject({ code: 'PREVOUT_NOT_FOUND', message: expect.stringContaining('no output 9') });

    const bare = history({ txindex: false });
    const failure = await resolvePrevouts(bare.first.transaction, bare.chain.rpc).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(MissingIndexError);
    expect(failure).toMatchObject({ index: 'txindex' });
    // A parent still in the mempool needs no index.
    expect(await resolvePrevouts(bare.second.transaction, bare.chain.rpc)).toEqual(bare.second.prevouts);
    chain.failNext(1);
    await expect(resolvePrevouts(first.transaction, chain.rpc)).rejects.toMatchObject({ code: 'RPC_NETWORK' });
    const stopped = new AbortController();
    stopped.abort();
    await expect(resolvePrevouts(first.transaction, chain.rpc, { signal: stopped.signal })).rejects.toMatchObject({ code: 'RPC_NETWORK' });
  });

  it('takes prevouts from an address search that asked for them, when every input has one', async () => {
    const { chain, coin, first, second } = history();
    chain.mine();
    const address = alice.deriveAddress(1);
    const withExtra = await chain.rpc.searchRawTransactions(address, { vinExtra: true });
    expect(withExtra.map((tx) => tx.txid)).toEqual([first.txid, second.txid]);
    expect(prevoutsFromSearch(withExtra[0]!, quick)).toEqual([{ script: coin.script, value: prl('10') }]);
    expect(prevoutsFromSearch(withExtra[1]!, quick)).toEqual(second.prevouts);
    expect(prevoutsFromSearch(withExtra[1]!, quick)).toEqual(await resolvePrevouts(second.transaction, chain.rpc));
    const plain = await chain.rpc.searchRawTransactions(address);
    expect(prevoutsFromSearch(plain[0]!, quick)).toBeNull();
    const mined = await chain.rpc.searchRawTransactions(chain.faucet.address, { vinExtra: true, count: 1 });
    expect(prevoutsFromSearch(mined[0]!, quick)).toEqual([]);
  });
});

describe('fetchMempool', () => {
  it('gives the replacement checks the mempool pearld has, parents ahead of children', async () => {
    const chain = new SimulatedChain({ network: quick });
    const coin = chain.fund(alice.deriveAddress(0), prl('10'));
    const spend = (utxo: object, index: number, fee: bigint, to = alice.deriveAddress(index + 1)) =>
      payFromAccount(alice, { network: quick, utxos: [{ ...coin, ...utxo, index }], recipients: [{ address: to, amount: 'max' }], feeRate: fee, rbf: index === 0, minConfirmations: 0 });
    const parent = spend({}, 0, 2000n);
    chain.accept(parent.transaction);
    const child = spend({ txid: parent.txid, value: parent.transaction.outs[0]!.value, script: parent.transaction.outs[0]!.script }, 1, 2000n);
    chain.accept(child.transaction);
    chain.pay(testAddress(5), prl('1'));

    const mempool = await fetchMempool(chain.rpc);
    expect([...mempool.keys()].sort()).toEqual([...chain.mempool.keys()].sort());
    for (const [txid, entry] of mempool) {
      expect(entry.fee).toBe(chain.mempool.get(txid)!.fee);
      expect(entry.tx.toHex()).toBe(chain.mempool.get(txid)!.tx.toHex());
    }
    const order = [...mempool.keys()];
    expect(order.indexOf(parent.txid)).toBeLessThan(order.indexOf(child.txid));
    // pearld lists its mempool in no order; a child listed first still comes after its parent.
    const shuffled: Rpc = {
      call: async <T>(method: string, params?: readonly unknown[], options?: object) => {
        const result = await chain.rpc.call<T>(method, params, options);
        return method === 'getrawmempool' ? (Object.fromEntries(Object.entries(result as object).reverse()) as T) : result;
      },
    };
    const listed = [...(await fetchMempool(shuffled)).keys()];
    expect(listed.indexOf(parent.txid)).toBeLessThan(listed.indexOf(child.txid));
    expect(listed).toHaveLength(3);
    expect(signalsReplacement(child.transaction, mempool)).toBe(true);

    // The same verdicts the node gives.
    const better = spend({}, 0, 20_000n, testAddress(6));
    expect(checkReplacement(better.transaction, better.fee, mempool).sort()).toEqual(chain.check(better.transaction).evicts.sort());
    expect(checkReplacement(better.transaction, better.fee, mempool).sort()).toEqual([parent.txid, child.txid].sort());
    const cheap = spend({}, 0, 2100n, testAddress(6));
    expect(() => checkReplacement(cheap.transaction, cheap.fee, mempool)).toThrow(expect.objectContaining({ name: 'PolicyError' }));
    expect(() => chain.check(cheap.transaction)).toThrow(/TX rejected/);
    let last = { txid: child.txid, value: child.transaction.outs[0]!.value, script: child.transaction.outs[0]!.script };
    for (let i = 2; i < 25; i += 1) {
      const next = spend(last, i, 2000n);
      chain.accept(next.transaction);
      last = { txid: next.txid, value: next.transaction.outs[0]!.value, script: next.transaction.outs[0]!.script };
    }
    const full = await fetchMempool(chain.rpc, { concurrency: 3 });
    const tooLong = spend(last, 25, 2000n);
    expect(() => checkPackageLimits(tooLong.transaction, full)).toThrow(/too-long-mempool-chain/);
    expect(() => chain.check(tooLong.transaction)).toThrow(/too-long-mempool-chain/);
    // Twenty-five in a line come back in line.
    const line = [...full.keys()].filter((txid) => txid !== [...chain.mempool.keys()][2]);
    expect(line).toEqual([...chain.mempool.keys()].filter((txid) => line.includes(txid)));
  });

  it('leaves out a transaction that was mined between its two requests, with what spends it', async () => {
    const chain = new SimulatedChain({ network: quick });
    const coin = chain.fund(alice.deriveAddress(0), prl('10'));
    const parent = payFromAccount(alice, { network: quick, utxos: [{ ...coin, index: 0 }], recipients: [{ address: alice.deriveAddress(1), amount: 'max' }], feeRate: 2000n });
    chain.accept(parent.transaction);
    const child = payFromAccount(alice, { network: quick, utxos: [{ txid: parent.txid, vout: 0, value: parent.transaction.outs[0]!.value, script: parent.transaction.outs[0]!.script, index: 1 }], recipients: [{ address: testAddress(1), amount: 'max' }], feeRate: 2000n, minConfirmations: 0 });
    chain.accept(child.transaction);
    const other = chain.pay(testAddress(2), prl('1'));
    // A node without --txindex that lost the parent after listing it.
    const racing: Rpc = {
      call: async (method, params, options) => {
        if (method === 'getrawtransaction' && params?.[0] === parent.txid) throw new PearlRpcError('rpc', method, `No information available about transaction ${parent.txid} (code -5)`, { rpcCode: -5 });
        return chain.rpc.call(method, params, options);
      },
    };
    expect([...(await fetchMempool(racing)).keys()]).toEqual([other.getId()]);
    expect(await fetchMempool(new SimulatedChain({ network: quick, premine: 0 }).rpc)).toEqual(new Map());
    chain.failNext(1, { method: 'getrawmempool' });
    await expect(fetchMempool(chain.rpc)).rejects.toMatchObject({ code: 'RPC_NETWORK' });
  });
});
