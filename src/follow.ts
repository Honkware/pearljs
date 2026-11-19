// Following pearld's best chain block by block. The node is asked for one
// block at a time and every block is checked against the one before it by
// its previous-block hash, so what the follower hands out is always one
// chain: when the node has moved to another branch, the blocks that left are
// handed back, newest first, down to the common ancestor, before any block
// of the new branch.

/**
 * A reorg-aware chain follower over pearld's RPC, the outputs a transaction
 * spends for explorers, and the mempool in the shape the replacement checks
 * take.
 *
 * @module
 */

import { toOutputScript } from './address.js';
import { MissingIndexError } from './backend.js';
import { parseBlock } from './block.js';
import type { PearlBlock } from './block.js';
import { blockHashHex } from './blockheader.js';
import { PearlError, PearlRpcError } from './errors.js';
import { toHex } from './internal/bytes.js';
import type { PearlNetwork } from './networks.js';
import type { Mempool, MempoolTx } from './rbf.js';
import { PearldRpc, isUnknownTransaction } from './rpc.js';
import type { Rpc, SearchRawTransactionsResult } from './rpc.js';
import type { BlockEvent } from './ws.js';
import { parseTransaction } from './transaction.js';
import type { Transaction, TxOutput } from './transaction.js';

/** Blocks a follower remembers, and so the deepest reorganization it can walk back through, unless `depth` says otherwise. */
export const DEFAULT_FOLLOW_DEPTH = 100;

/**
 * Where a follower is: the last block it handed out, and the hashes of the
 * blocks before it, newest first, as far back as it remembers. Plain JSON;
 * store it in the same write as what you made of the block, and pass it as
 * `from: { cursor }` to go on from there.
 */
export interface FollowCursor {
  height: number;
  /** Display-order hex. */
  hash: string;
  /** Hashes at height - 1, height - 2 and so on. A cursor without them can go on, but not back. */
  ancestors?: string[];
}

/** What a follower hands out, in chain order. */
export type FollowEvent =
  /** The next block of the best chain. Its previous block is the last one connected and not disconnected since. */
  | { type: 'connected'; height: number; hash: string; block: PearlBlock }
  /** The last connected block is no longer on the best chain: undo it. Always the newest block first. */
  | { type: 'disconnected'; height: number; hash: string }
  /** The follower has reached the node's tip, which is this block; sent once each time it catches up. */
  | { type: 'synced'; height: number; hash: string };

/** Options for followChain. */
export interface FollowOptions {
  /**
   * Where to start. `{ height }` and `{ hash }` name the first block to hand
   * out (height 0 is genesis); `'tip'` starts after the node's current tip;
   * `{ cursor }` goes on after a cursor a follower gave earlier, first
   * handing back any of its blocks that have left the chain since.
   */
  from: 'tip' | { height: number } | { hash: string } | { cursor: FollowCursor };
  /** Blocks to remember. DEFAULT_FOLLOW_DEPTH (100) unless given; memory use does not grow past it. */
  depth?: number;
  /**
   * Milliseconds between looks at the node's tip once caught up. 5000 unless
   * given, and 30000 with `ws`, whose notifications then do the waking.
   */
  pollInterval?: number;
  /**
   * A PearlWsClient to be woken by: the follower then asks for a new block
   * the moment pearld announces it. It still reads everything over `rpc`
   * and still polls, since a notification sent while the socket was down is
   * never sent again.
   */
  ws?: { watchBlocks(options: { onBlock: (event: BlockEvent) => void; onError?: (error: Error) => void }): () => void };
  /** Ends the follower: the iterator finishes, without an error. */
  signal?: AbortSignal;
  /** Finish at the node's tip instead of waiting for more blocks. */
  stopAtTip?: boolean;
  /** Failed requests in a row before giving up; a node that is down is waited for without limit unless given. */
  retries?: number;
  /** Wait after the first failed request, in ms, doubling up to `maxRetryDelay`. 1000 unless given. */
  retryDelay?: number;
  /** 30000 unless given. */
  maxRetryDelay?: number;
  /** Told of every failed request that will be tried again. */
  onRetry?: (error: PearlRpcError, attempt: number) => void;
}

/** followChain's result: the events, and where the follower is. */
export interface ChainFollower extends AsyncIterableIterator<FollowEvent> {
  /**
   * The cursor after the last event handed out: store it once that event is
   * dealt with. Null until a follower started at genesis, or above the node's
   * tip, has a block to stand on.
   */
  cursor(): FollowCursor | null;
}

interface Remembered {
  height: number;
  hash: string;
  /** Whether the consumer was given this block, and so must be told when it leaves the chain. */
  seen: boolean;
}

const HASH = /^[0-9a-f]{64}$/;
const display = (hash: Uint8Array): string => toHex(Uint8Array.from(hash).reverse());

function checkCursor(cursor: FollowCursor): void {
  const ok =
    typeof cursor === 'object' &&
    cursor !== null &&
    Number.isSafeInteger(cursor.height) &&
    cursor.height >= 0 &&
    typeof cursor.hash === 'string' &&
    HASH.test(cursor.hash) &&
    (cursor.ancestors === undefined ||
      (Array.isArray(cursor.ancestors) && cursor.ancestors.length <= cursor.height && cursor.ancestors.every((hash) => typeof hash === 'string' && HASH.test(hash))));
  if (!ok) throw new TypeError('not a follower cursor: expected { height, hash, ancestors? } with display-order hex hashes');
}

// A request that failed for a reason that passes: the node is down, restarting or overloaded.
function isTransient(err: unknown): err is PearlRpcError {
  return err instanceof PearlRpcError && (err.kind === 'network' || err.kind === 'http');
}

/**
 * Follows pearld's best chain. Each `connected` block extends the one before
 * it; after a reorganization the blocks that left come back as `disconnected`,
 * newest first, down to the common ancestor, and then the new branch
 * connects. `synced` marks each arrival at the node's tip.
 *
 * The follower needs nothing from pearld but its default RPC: getbestblock,
 * getblockhash and getblock. A request that fails for a passing reason is
 * tried again, with a growing wait. It throws FOLLOW_REORG_TOO_DEEP when the
 * chain has changed below the oldest block it remembers, and
 * FOLLOW_START_UNKNOWN for a `from.hash` that is not on the best chain.
 */
export function followChain(rpc: Rpc, options: FollowOptions): ChainFollower {
  const { from, signal, stopAtTip = false, retries = Infinity, retryDelay = 1000, maxRetryDelay = 30_000 } = options;
  const depth = options.depth ?? DEFAULT_FOLLOW_DEPTH;
  if (!Number.isInteger(depth) || depth < 1) throw new RangeError('depth must be a whole number of blocks, at least 1');
  const pollInterval = options.pollInterval ?? (options.ws === undefined ? 5000 : 30_000);
  if (typeof from === 'object' && 'cursor' in from) checkCursor(from.cursor);
  if (typeof from === 'object' && 'height' in from && (!Number.isSafeInteger(from.height) || from.height < 0)) throw new RangeError('from.height must be a block height');
  if (typeof from === 'object' && 'hash' in from && !HASH.test(from.hash)) throw new TypeError('from.hash must be 64 lowercase hex characters');
  const node = new PearldRpc(rpc, signal === undefined ? {} : { signal });

  // The blocks handed out most recently, oldest first, under one block the follower stands on without having handed it out.
  let remembered: Remembered[] = [];
  let started = false;
  let wake: (() => void) | null = null;
  let pending = false;

  // Resolves after the time given, on a block notification, or when the signal fires.
  const pause = (ms: number, notified: boolean): Promise<void> =>
    new Promise((resolve) => {
      if (signal?.aborted === true || (notified && pending)) {
        pending = false;
        resolve();
        return;
      }
      const done = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        wake = null;
        pending = false;
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal?.addEventListener('abort', done, { once: true });
      if (notified) wake = done;
    });

  // The hash at a height of the node's best chain, or null when the chain is shorter.
  const hashAt = async (height: number): Promise<string | null> => {
    try {
      return await node.getBlockHash(height);
    } catch (err) {
      if (err instanceof PearlRpcError && err.kind === 'rpc') return null;
      throw err;
    }
  };

  const start = async (): Promise<void> => {
    if (from === 'tip') {
      remembered = [{ ...(await node.getBestBlock()), seen: false }];
    } else if ('cursor' in from) {
      const { height, hash, ancestors = [] } = from.cursor;
      remembered = [...ancestors.slice(0, depth).map((ancestor, i) => ({ height: height - 1 - i, hash: ancestor, seen: true })).reverse(), { height, hash, seen: true }];
    } else if ('hash' in from) {
      let header;
      try {
        header = await node.getBlockHeader(from.hash);
      } catch (err) {
        if (!(err instanceof PearlRpcError) || err.kind !== 'rpc') throw err;
        throw new PearlError('FOLLOW_START_UNKNOWN', `the node does not know block ${from.hash}`, { cause: err });
      }
      if (header.confirmations < 1) throw new PearlError('FOLLOW_START_UNKNOWN', `block ${from.hash} is not on the node's best chain`);
      remembered = header.height === 0 ? [] : [{ height: header.height - 1, hash: header.previousblockhash!, seen: false }];
    } else if (from.height > 0) {
      const hash = await hashAt(from.height - 1);
      // A start above the tip waits for the chain to get there.
      remembered = hash === null ? [{ height: from.height - 1, hash: '', seen: false }] : [{ height: from.height - 1, hash, seen: false }];
    }
    started = true;
  };

  // What the follower believes of the node: its tip's height, whether the block
  // it stands on needs checking, and whether this arrival at the tip was announced.
  let tipHeight = -1;
  let suspect = false;
  let announced = false;

  // One move along the chain: an event to hand out, 'wait' when there is nothing to do until the node moves, or null to look again.
  const step = async (): Promise<FollowEvent | 'wait' | null> => {
    const top = remembered[remembered.length - 1];
    if (top !== undefined && top.hash === '') {
      const hash = await hashAt(top.height);
      if (hash === null) return 'wait';
      top.hash = hash;
      return null;
    }
    if (top !== undefined && top.height >= tipHeight) {
      const best = await node.getBestBlock();
      tipHeight = best.height;
      if (best.hash === top.hash) {
        suspect = false;
        if (announced || !top.seen) return 'wait';
        announced = true;
        return { type: 'synced', height: top.height, hash: top.hash };
      }
      // Another block at this height or below it: the one the follower stands on has left the chain.
      if (best.height <= top.height) suspect = true;
    }
    if (top !== undefined && suspect) {
      const current = await hashAt(top.height);
      if (current !== top.hash) {
        announced = false;
        if (!top.seen) {
          // Nobody was given this block, so there is nothing to undo: stand on what is there now.
          tipHeight = -1;
          if (current === null) return 'wait';
          top.hash = current;
          return null;
        }
        if (remembered.length === 1) {
          throw new PearlError(
            'FOLLOW_REORG_TOO_DEEP',
            `the chain changed at or below height ${top.height}, the oldest block this follower remembers; start again from an earlier block, or follow with a larger depth`,
          );
        }
        // The block under it is checked next, before anything connects.
        remembered.pop();
        return { type: 'disconnected', height: top.height, hash: top.hash };
      }
      suspect = false;
    }
    const height = top === undefined ? 0 : top.height + 1;
    const hash = await hashAt(height);
    if (hash === null) {
      // The chain ends lower than it did; ask for the tip again.
      tipHeight = -1;
      return top === undefined ? 'wait' : null;
    }
    const block = parseBlock(await node.getRawBlock(hash));
    if (blockHashHex(block.header) !== hash) throw new PearlRpcError('response', 'getblock', `asked for block ${hash} and got ${blockHashHex(block.header)}`);
    if (top !== undefined && display(block.header.prevBlock) !== top.hash) {
      // The node changed branch under the follower, perhaps between these two requests.
      suspect = true;
      return null;
    }
    remembered.push({ height, hash, seen: true });
    if (remembered.length > depth + 1) remembered.shift();
    announced = false;
    return { type: 'connected', height, hash, block };
  };

  // A function, so the compiler does not take one reading of the signal as true for the whole loop.
  const aborted = (): boolean => signal?.aborted === true;

  async function* events(): AsyncGenerator<FollowEvent, void, undefined> {
    const stopWatching = options.ws?.watchBlocks({
      onBlock: () => {
        pending = true;
        wake?.();
      },
      onError: () => {},
    });
    try {
      let failures = 0;
      let idle = 0;
      while (!aborted()) {
        let moved: FollowEvent | 'wait' | null;
        try {
          if (!started) await start();
          moved = await step();
          failures = 0;
        } catch (err) {
          if (aborted()) return;
          if (!isTransient(err) || failures >= retries) throw err;
          failures += 1;
          options.onRetry?.(err, failures);
          await pause(Math.min(maxRetryDelay, retryDelay * 2 ** (failures - 1)), false);
          continue;
        }
        if (moved === 'wait') {
          if (stopAtTip) return;
          idle = 0;
          await pause(pollInterval, true);
        } else if (moved === null) {
          // Nothing to hand out twice in a row means the node is mid-change; give it a moment.
          idle += 1;
          if (idle > 3) await pause(Math.min(pollInterval, 250), false);
        } else {
          idle = 0;
          yield moved;
        }
      }
    } finally {
      stopWatching?.();
    }
  }

  const iterator = events();
  const follower: ChainFollower = {
    next: () => iterator.next(),
    return: (value?: unknown) => iterator.return(value as undefined),
    throw: (err?: unknown) => iterator.throw(err),
    [Symbol.asyncIterator]: () => follower,
    cursor() {
      const top = remembered[remembered.length - 1];
      if (top === undefined || top.hash === '') return null;
      return { height: top.height, hash: top.hash, ancestors: remembered.slice(0, -1).filter((block) => block.seen).map((block) => block.hash).reverse() };
    },
  };
  return follower;
}

/** A follower started by watchChain. */
export interface ChainWatch {
  /** Stops after the event being handled, if any. */
  stop(): void;
  /** Settles when the follower has stopped: resolves after `stop`, the signal or `stopAtTip`; rejects with what ended it otherwise, unless `onError` took that. */
  readonly done: Promise<void>;
  /** As ChainFollower.cursor. */
  cursor(): FollowCursor | null;
}

/**
 * followChain with a callback. Events are handed to `onEvent` one at a time:
 * the next block is not fetched until the promise it returns has settled, so
 * a handler can write to a database and store `cursor()` in the same step.
 * An error thrown by the handler stops the follower and rejects `done`.
 */
export function watchChain(
  rpc: Rpc,
  options: FollowOptions & { onEvent: (event: FollowEvent, cursor: FollowCursor) => void | Promise<void>; onError?: (error: unknown) => void },
): ChainWatch {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  if (options.signal?.aborted === true) abort();
  else options.signal?.addEventListener('abort', abort, { once: true });
  const follower = followChain(rpc, { ...options, signal: controller.signal });
  const done = (async () => {
    try {
      for await (const event of follower) {
        await options.onEvent(event, follower.cursor()!);
        if (controller.signal.aborted) break;
      }
    } catch (err) {
      if (options.onError === undefined) throw err;
      options.onError(err);
    } finally {
      options.signal?.removeEventListener('abort', abort);
    }
  })();
  return { stop: abort, done, cursor: () => follower.cursor() };
}

export interface ResolvePrevoutsOptions {
  /**
   * Transactions already at hand, by txid: the other transactions of the
   * block being read, or an explorer's own store. Looked in before the node
   * is asked, and filled with what the node returns. A Map works.
   */
  known?: { get(txid: string): Transaction | undefined; set(txid: string, tx: Transaction): unknown };
  /** Abandons the lookups when aborted. */
  signal?: AbortSignal;
}

/**
 * The outputs a transaction spends, in input order, as inspectTransaction and
 * verifyTransaction take them: each parent is read with getrawtransaction,
 * once. Nothing is asked for a coinbase, which gives an empty list.
 *
 * pearld answers getrawtransaction for mempool transactions always and for
 * confirmed ones only with --txindex; without it this throws a
 * MissingIndexError. It throws PREVOUT_NOT_FOUND when the node has no such
 * parent or the parent has no such output, and RPC_RESPONSE when the node
 * answers with another transaction than the one asked for.
 */
export async function resolvePrevouts(tx: Transaction, rpc: Rpc, options: ResolvePrevoutsOptions = {}): Promise<TxOutput[]> {
  if (tx.isCoinbase()) return [];
  const node = new PearldRpc(rpc, options.signal === undefined ? {} : { signal: options.signal });
  const parents = new Map<string, Promise<Transaction>>();
  const parent = (txid: string): Promise<Transaction> => {
    let found = parents.get(txid);
    if (found === undefined) {
      const known = options.known?.get(txid);
      found =
        known !== undefined
          ? Promise.resolve(known)
          : node.getRawTransactionHex(txid).then(
              (hex) => {
                const fetched = parseTransaction(hex);
                if (fetched.getId() !== txid) throw new PearlRpcError('response', 'getrawtransaction', `asked for transaction ${txid} and got ${fetched.getId()}`);
                options.known?.set(txid, fetched);
                return fetched;
              },
              (err: unknown) => {
                if (isUnknownTransaction(err)) throw new PearlError('PREVOUT_NOT_FOUND', `the node has no transaction ${txid}, which ${tx.getId()} spends`, { cause: err });
                if (err instanceof PearlRpcError && err.kind === 'rpc' && /transaction index must be enabled/i.test(err.message)) throw new MissingIndexError('txindex', err);
                throw err;
              },
            );
      parents.set(txid, found);
    }
    return found;
  };
  return Promise.all(
    tx.ins.map(async (input) => {
      const txid = display(input.hash);
      const out = (await parent(txid)).outs[input.index];
      if (out === undefined) throw new PearlError('PREVOUT_NOT_FOUND', `transaction ${txid} has no output ${input.index}, which ${tx.getId()} spends`);
      return { script: Uint8Array.from(out.script), value: out.value };
    }),
  );
}

/**
 * The outputs a transaction from searchRawTransactions spends, taken from
 * the `prevOut` pearld adds to each input when asked with `vinExtra`: no
 * further request, where an address page lists the transactions anyway.
 * pearld needs --addrindex for the search and --txindex for `vinExtra`.
 *
 * pearld gives the address and value of a spent output, not its script, so
 * the script is rebuilt from the address. Returns null when an input has no
 * `prevOut` or spent an output without an address; resolvePrevouts reads
 * those from the parent transactions. Empty for a coinbase.
 */
export function prevoutsFromSearch(tx: Pick<SearchRawTransactionsResult, 'vin'>, network: PearlNetwork): TxOutput[] | null {
  const prevouts: TxOutput[] = [];
  for (const input of tx.vin) {
    if ('coinbase' in input) return [];
    const address = input.prevOut?.addresses?.[0];
    if (input.prevOut === undefined || address === undefined || input.prevOut.addresses!.length !== 1 || typeof input.prevOut.value !== 'bigint') return null;
    prevouts.push({ script: toOutputScript(address, network), value: input.prevOut.value });
  }
  return prevouts;
}

/**
 * pearld's mempool as checkReplacement, checkPackageLimits and
 * signalsReplacement take it: every transaction with its fee, parents ahead
 * of the transactions that spend them. Read with getrawmempool and one
 * getrawtransaction each, which needs no index. A transaction that leaves
 * the mempool between the two requests is left out, with everything that
 * spends from it.
 *
 * The result is a snapshot: check a replacement against it and broadcast
 * soon, and let pearld have the last word.
 */
export async function fetchMempool(rpc: Rpc, options: { signal?: AbortSignal; concurrency?: number } = {}): Promise<Mempool> {
  const node = new PearldRpc(rpc, options.signal === undefined ? {} : { signal: options.signal });
  const entries = Object.entries(await node.getRawMempoolVerbose());
  const fetched = new Map<string, MempoolTx>();
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < entries.length) {
      const [txid, entry] = entries[next++]!;
      try {
        fetched.set(txid, { tx: parseTransaction(await node.getRawTransactionHex(txid)), fee: entry.fee });
      } catch (err) {
        // Mined or evicted since the list was read.
        if (!isUnknownTransaction(err) && !(err instanceof PearlRpcError && err.kind === 'rpc' && /transaction index must be enabled/i.test(err.message))) throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(options.concurrency ?? 8, entries.length)) }, worker));

  // Oldest first, as pearld accepted them, with each parent placed before its first child.
  const order = entries.filter(([txid]) => fetched.has(txid)).sort(([, a], [, b]) => a.time - b.time);
  const depends = new Map(entries.map(([txid, entry]) => [txid, entry.depends]));
  const mempool = new Map<string, MempoolTx>();
  const dropped = new Set(entries.map(([txid]) => txid).filter((txid) => !fetched.has(txid)));
  const place = (txid: string): boolean => {
    if (mempool.has(txid)) return true;
    if (dropped.has(txid)) return false;
    // Marked first, so a cycle a broken server reports cannot recurse forever.
    dropped.add(txid);
    for (const parent of depends.get(txid) ?? []) if (depends.has(parent) && !place(parent)) return false;
    dropped.delete(txid);
    mempool.set(txid, fetched.get(txid)!);
    return true;
  };
  for (const [txid] of order) place(txid);
  return mempool;
}
