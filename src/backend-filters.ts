// A wallet backend that needs neither pearld's address index nor full RPC
// credentials: it walks the basic block filters (getcfilter) from a birthday
// height, checks them against the filter-header chain, matches the watched
// output scripts and downloads only the blocks that match (getblock). Every
// method it calls is on pearld's limited-user list but sendrawtransaction.
//
// What it found is kept in a WalletStore: a cursor (height, block hash and
// filter header of the last block scanned), one record per block (hash,
// filter header and, unless told not to, the filter itself), the watched
// scripts, and every transaction paying or spending them. A restart goes on
// from the cursor. A reorganization is found by comparing the stored hash at
// the cursor with the node's, and undone back to the last height where they
// agree. A spend is found because Pearl's filters hold the scripts a block's
// inputs spend as well as its outputs, so the block spending a watched
// output matches the same script.

/**
 * A wallet backend over pearld's compact block filters, for nodes without
 * the address index and for pearld's limited RPC user.
 *
 * @module
 */

import { fromOutputScript, toOutputScript } from './address.js';
import type { FeeRate } from './amount.js';
import { checkMerkleRoot, parseBlock } from './block.js';
import { blockHashHex } from './blockheader.js';
import type { AddressPayment, BlockRef, ChainTransaction } from './client.js';
import { PearlError, StoreError } from './errors.js';
import { decodeFilter, encodeFilter, filterHeader, filterHeaderHex, filterKey, matchAnyFilter } from './gcs.js';
import type { CompactFilter } from './gcs.js';
import type { PearlNetwork } from './networks.js';
import { PearlRpcError, PearldRpc, RPC_ERROR_CODES, isLimitedUserRefusal, isUnknownTransaction } from './rpc.js';
import type { OutPointParam, Rpc } from './rpc.js';
import { createMemoryStore } from './store.js';
import type { JsonValue, StoreOperation, WalletStore } from './store.js';
import { parseTransaction, transactionId } from './transaction.js';
import type { Transaction } from './transaction.js';
import { pearldBackend, sumBalance } from './backend.js';
import type { AddressHistoryEntry, SpendStatus, WalletBackend, WalletUtxo, Watched } from './backend.js';
import { fromHex, toHex } from './internal/bytes.js';
import { fetchBlockFilters, mapLimit } from './internal/filter-scan.js';
import type { HeightFilter } from './internal/filter-scan.js';
import { safeHeight } from './internal/rpc-wire.js';

/** Options for filterBackend. */
export interface FilterBackendOptions {
  network: PearlNetwork;
  /** The first block to scan: the height of the block the wallet's first address was made in, or 0 for the whole chain. */
  birthday: number;
  /** Where the cursor, block records and found transactions are kept. A memory store unless given. */
  store?: WalletStore;
  /** Prefix of every key the backend writes, so a store can hold other things too. Default "filters/". */
  prefix?: string;
  /** Addresses or output scripts to watch from the start. Others are added as they are asked about. */
  watch?: readonly Watched[];
  /** Blocks per round: each round checks its filters against the header chain and is written in one batch. Default 100. */
  batchSize?: number;
  /** Requests at once. Default 8; a client made with `batch` sends them together. */
  concurrency?: number;
  /**
   * Other pearld endpoints whose filter headers must agree with the ones
   * computed here, one getcfilterheader each per round. An endpoint that does
   * not know a block is skipped for that round.
   */
  crossCheck?: readonly Rpc[];
  /** Where broadcast sends transactions instead of `rpc`; see PearldBackendOptions. */
  broadcast?: Rpc;
  /** Keep each block's filter in the store, so a newly watched address needs no filter fetched again. Default true. */
  keepFilters?: boolean;
  /** Look through the mempool on each sync, as far as the credentials allow. Default true. */
  mempool?: boolean;
  /** How long a sync answers queries before the next one, in ms; 0 syncs before every query. Default 1000. */
  maxAge?: number;
  /** Milliseconds since the epoch; Date.now unless given. */
  now?: () => number;
}

/** What a sync reports after each round. */
export interface FilterSyncProgress {
  /** The last block scanned. */
  readonly height: number;
  /** The node's tip when the sync began. */
  readonly tip: number;
  /** Blocks downloaded in this sync because their filter matched. */
  readonly blocksFetched: number;
}

/** Options for FilterBackend.sync. */
export interface FilterSyncOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: FilterSyncProgress) => void;
}

/** Where a filter backend stands. */
export interface FilterBackendStatus {
  /** The last block scanned, or null before the first sync reaches the birthday. */
  readonly cursor: BlockRef | null;
  readonly birthday: number;
  /** How many output scripts are watched. */
  readonly scripts: number;
  /** Transactions found in blocks. */
  readonly transactions: number;
  /** Mempool transactions found by the last sync. */
  readonly pending: number;
  /** Whether mempool transactions can be seen: false when pearld refuses getrawmempool or `mempool` is off, undefined before the first sync. */
  readonly mempool: boolean | undefined;
}

/**
 * A WalletBackend that is also the wallet's transaction source: it keeps
 * every transaction it found, so getRawTransaction answers for them without
 * --txindex.
 */
export interface FilterBackend extends WalletBackend {
  /** Scans from the cursor to the node's tip, undoing a reorganization first, then looks through the mempool. Resolves to the new cursor. */
  sync(options?: FilterSyncOptions): Promise<BlockRef>;
  /** Watches more addresses or scripts, scanning the blocks already passed for them. */
  watch(watched: readonly Watched[]): Promise<void>;
  /** Which of these addresses have been paid, scanning for any not yet watched. */
  findUsed(addresses: readonly string[]): Promise<string[]>;
  /** A transaction found or, failing that, pearld's copy, serialized; null when neither has it. */
  getRawTransaction(txid: string): Promise<string | null>;
  status(): Promise<FilterBackendStatus>;
}

// What the store holds, under the prefix.
const STATE_VERSION = 1;
interface State {
  version: number;
  network: string;
  birthday: number;
  /** The block before the birthday and its filter header, which the scan builds on. */
  anchor: Cursor;
  cursor: Cursor;
}
interface Cursor {
  height: number;
  /** '' for the anchor of birthday 0, which has no block. */
  hash: string;
  /** Filter header, display hex. */
  header: string;
}
// One transaction found in a block.
interface Found {
  tx: Transaction;
  hex: string;
  height: number;
  hash: string;
  time: number;
  /** Position in the block; 0 is the coinbase. */
  index: number;
}
interface Pending {
  tx: Transaction;
  hex: string;
}

const ZERO_HEADER = '00'.repeat(32);

/**
 * A wallet backend over pearld's compact block filters. pearld needs its
 * filter index, which is on unless --nocfilters, and nothing else: no
 * address or transaction index, and the limited RPC user will do for
 * everything but broadcast. The first query syncs from `birthday`.
 *
 * Trust: the filters and blocks come from one node. Each round's filters
 * are chained into filter headers and compared with that node's
 * getcfilterheader and with any `crossCheck` endpoints, and each downloaded
 * block is checked against its hash and merkle root, so a corrupted reply is
 * caught. A node that lies consistently, serving filters that leave out a
 * script, can still hide a transaction; checking headers across independent
 * nodes is what catches that.
 */
export function filterBackend(rpc: Rpc, options: FilterBackendOptions): FilterBackend {
  const { network, birthday, batchSize = 100, concurrency = 8, keepFilters = true, maxAge = 1000 } = options;
  if (!Number.isSafeInteger(birthday) || birthday < 0) throw new RangeError('birthday must be a block height');
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) throw new RangeError('batchSize must be a positive integer');
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new RangeError('concurrency must be a positive integer');
  const store = options.store ?? createMemoryStore();
  const prefix = options.prefix ?? 'filters/';
  const now = options.now ?? Date.now;
  const node = new PearldRpc(rpc);
  const others = (options.crossCheck ?? []).map((other) => new PearldRpc(other));
  const base = pearldBackend(rpc, { network, ...(options.broadcast === undefined ? {} : { broadcast: options.broadcast }) });
  const key = {
    state: `${prefix}state`,
    scripts: `${prefix}scripts`,
    block: (height: number) => `${prefix}block/${String(height).padStart(10, '0')}`,
    blocks: `${prefix}block/`,
    tx: (txid: string) => `${prefix}tx/${txid}`,
    txs: `${prefix}tx/`,
  };

  let state: State | null = null;
  const scripts = new Set<string>();
  const found = new Map<string, Found>();
  const pending = new Map<string, Pending>();
  // Mempool txids already looked at and found irrelevant.
  const ignored = new Set<string>();
  let mempoolVisible: boolean | undefined = options.mempool === false ? false : undefined;
  let syncedAt = -Infinity;

  // Every operation that changes state runs alone, in order.
  let queue: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(run: () => Promise<T>): Promise<T> => {
    const result = queue.then(run, run);
    queue = result.catch(() => {});
    return result;
  };

  const loaded = (async () => {
    const stored = await store.get(key.state);
    if (stored !== undefined) {
      const saved = stored as unknown as State;
      if (saved.version !== STATE_VERSION || saved.network !== network.name || saved.birthday !== birthday) {
        throw new StoreError(
          'STORE_INVALID',
          `the filter scan under "${prefix}" in this store is for ${saved.network} from height ${saved.birthday} (version ${saved.version}); use another prefix or a fresh store`,
        );
      }
      state = saved;
    }
    for (const script of ((await store.get(key.scripts)) as string[] | undefined) ?? []) scripts.add(script);
    for (const [, value] of await store.list(key.txs)) {
      const record = value as { hex: string; height: number; hash: string; time: number; index: number };
      const tx = parseTransaction(record.hex);
      found.set(transactionId(tx), { tx, ...record });
    }
  })();
  loaded.catch(() => {});

  const scriptOf = (watched: Watched): string => {
    if (typeof watched === 'string') return toHex(toOutputScript(watched, network));
    // Decoding refuses a script that is no address on this network.
    fromOutputScript(watched, network);
    return toHex(watched);
  };

  // Outputs paying a watched script, by outpoint, with what spends them.
  const outputs = () => {
    const owned = new Map<string, { txid: string; vout: number; value: bigint; script: string; source: Found | Pending; coinbase: boolean }>();
    const spentBy = new Map<string, { txid: string; confirmed: boolean }>();
    const add = (txid: string, item: Found | Pending, confirmed: boolean) => {
      item.tx.outs.forEach((out, vout) => {
        const script = toHex(out.script);
        if (scripts.has(script)) owned.set(`${txid}:${vout}`, { txid, vout, value: out.value, script, source: item, coinbase: isFound(item) && item.index === 0 });
      });
      for (const input of item.tx.ins) spentBy.set(outpointOf(input), { txid, confirmed });
    };
    for (const [txid, item] of found) add(txid, item, true);
    for (const [txid, item] of pending) add(txid, item, false);
    return { owned, spentBy };
  };

  // Records the block's transactions that pay a watched script or spend an
  // output that does, in block order so a spend within the block is seen.
  const takeBlock = (block: ReturnType<typeof parseBlock>, height: number, hash: string, writes: StoreOperation[]): void => {
    const owned = new Set<string>();
    for (const [txid, item] of found) item.tx.outs.forEach((out, vout) => scripts.has(toHex(out.script)) && owned.add(`${txid}:${vout}`));
    block.transactions.forEach((tx, index) => {
      const pays = tx.outs.some((out) => scripts.has(toHex(out.script)));
      if (!pays && !tx.ins.some((input) => owned.has(outpointOf(input)))) return;
      const txid = transactionId(tx);
      const record: Found = { tx, hex: tx.toHex(), height, hash, time: block.header.timestamp, index };
      found.set(txid, record);
      pending.delete(txid);
      tx.outs.forEach((out, vout) => scripts.has(toHex(out.script)) && owned.add(`${txid}:${vout}`));
      writes.push({ type: 'set', key: key.tx(txid), value: { hex: record.hex, height, hash, time: record.time, index } });
    });
  };

  // Downloads the blocks whose filters match, checks each is the block
  // asked for, and takes their transactions in height order.
  const fetchMatches = async (matched: readonly { height: number; hash: string }[], writes: StoreOperation[]): Promise<void> => {
    const blocks = await mapLimit(matched, concurrency, async ({ height, hash }) => {
      const block = parseBlock(await node.getRawBlock(hash));
      if (blockHashHex(block.header) !== hash) {
        throw new PearlError('BACKEND_RESPONSE', `getblock ${hash} returned block ${blockHashHex(block.header)}`);
      }
      checkMerkleRoot(block);
      return { block, height, hash };
    });
    blocksFetched += blocks.length;
    for (const { block, height, hash } of blocks) takeBlock(block, height, hash, writes);
  };
  let blocksFetched = 0;

  const matches = (filter: CompactFilter, filterKeyBytes: Uint8Array, among: readonly Uint8Array[]): boolean =>
    among.length > 0 && filter.n > 0 && matchAnyFilter(filter, filterKeyBytes, among);

  // The filter header every other source must agree with at `hash`.
  const crossCheck = async (hash: string, header: string, primaryToo: boolean): Promise<void> => {
    const sources = primaryToo ? [node, ...others] : others;
    await Promise.all(
      sources.map(async (source, i) => {
        let theirs: string;
        try {
          theirs = await source.getCFilterHeader(hash);
        } catch (err) {
          // A node that has not seen the block neither confirms nor contradicts.
          if (source !== node && err instanceof PearlRpcError && err.kind === 'rpc' && err.rpcCode === RPC_ERROR_CODES.INVALID_ADDRESS_OR_KEY) return;
          throw err;
        }
        if (theirs !== header) {
          const who = source === node ? 'the node' : `cross-check endpoint ${primaryToo ? i : i + 1}`;
          throw new PearlError('FILTER_HEADER_MISMATCH', `${who} has filter header ${theirs} for block ${hash}, where the filters chain to ${header}`);
        }
      }),
    );
  };

  // The block before the birthday and its filter header, or null while the
  // chain is shorter than that.
  const anchor = async (tip: BlockRef): Promise<Cursor | null> => {
    if (birthday === 0) return { height: -1, hash: '', header: ZERO_HEADER };
    if (tip.height < birthday - 1) return null;
    const hash = await node.getBlockHash(birthday - 1);
    const header = await node.getCFilterHeader(hash);
    await crossCheck(hash, header, false);
    return { height: birthday - 1, hash, header };
  };

  const hashAt = async (height: number, tip: BlockRef): Promise<string | null> => (height > tip.height ? null : node.getBlockHash(height));

  // Undoes blocks the node no longer has on its best chain, back to the
  // last height where the stored hash and the node's agree.
  const reconcile = async (tip: BlockRef): Promise<void> => {
    const current = state!;
    if (current.cursor.height < birthday) return;
    if ((await hashAt(current.cursor.height, tip)) === current.cursor.hash) return;
    let common: Cursor | null = null;
    for (let top = current.cursor.height - 1; top >= birthday && common === null; top -= concurrency) {
      const heights = Array.from({ length: Math.min(concurrency, top - birthday + 1) }, (_, i) => top - i);
      const [theirs, ours] = await Promise.all([
        mapLimit(heights, concurrency, (height) => hashAt(height, tip)),
        Promise.all(heights.map((height) => store.get(key.block(height)) as Promise<[string, string, string | null] | undefined>)),
      ]);
      const at = heights.findIndex((_, i) => ours[i] !== undefined && ours[i]![0] === theirs[i]);
      if (at >= 0) common = { height: heights[at]!, hash: ours[at]![0], header: ours[at]![1] };
    }
    if (common === null) {
      // Back past the birthday: the anchor block itself may be gone.
      const fresh = await anchor(tip);
      common = fresh !== null && fresh.hash === current.anchor.hash ? current.anchor : null;
      if (common === null) {
        await disconnect(current.anchor.height, null);
        state = null;
        return;
      }
    }
    await disconnect(common.height, common);
  };

  const disconnect = async (above: number, cursor: Cursor | null): Promise<void> => {
    const writes: StoreOperation[] = [];
    for (const [stored] of await store.list(key.blocks)) {
      if (Number(stored.slice(key.blocks.length)) > above) writes.push({ type: 'delete', key: stored });
    }
    for (const [txid, item] of found) {
      if (item.height <= above) continue;
      found.delete(txid);
      writes.push({ type: 'delete', key: key.tx(txid) });
    }
    if (cursor === null) writes.push({ type: 'delete', key: key.state });
    else {
      state = { ...state!, cursor };
      writes.push({ type: 'set', key: key.state, value: state as unknown as JsonValue });
    }
    await store.batch(writes);
  };

  // Scans one round of blocks after the cursor. False when the node's chain
  // changed under the round, so the caller reconciles and tries again.
  const scanRound = async (to: number): Promise<boolean> => {
    const current = state!;
    const heights = Array.from({ length: to - current.cursor.height }, (_, i) => current.cursor.height + 1 + i);
    let filters: HeightFilter[];
    try {
      filters = await fetchBlockFilters(node, heights, concurrency);
    } catch (err) {
      // A height past a tip that moved back, or a block that left the chain.
      if (err instanceof PearlRpcError && err.kind === 'rpc' && !((await stillOn(current.cursor)) && (await node.getBlockCount()) >= to)) return false;
      throw err;
    }
    let prev = current.cursor.header;
    const headers = filters.map(({ filter }) => (prev = filterHeaderHex(filterHeader(filter, prev))));
    const last = filters.at(-1)!;
    try {
      await crossCheck(last.hash, prev, true);
    } catch (err) {
      // The node's chain may have moved between the hashes and the filters.
      if (err instanceof PearlError && err.code === 'FILTER_HEADER_MISMATCH' && !(await stillOn(current.cursor))) return false;
      throw err;
    }
    const list = [...scripts].map((script) => fromHex(script));
    const writes: StoreOperation[] = [];
    await fetchMatches(
      filters.filter(({ filter, key: k }) => matches(filter, k, list)),
      writes,
    );
    filters.forEach(({ height, hash, filter }, i) => {
      writes.push({ type: 'set', key: key.block(height), value: [hash, headers[i]!, keepFilters ? toHex(encodeFilter(filter)) : null] });
    });
    state = { ...current, cursor: { height: last.height, hash: last.hash, header: prev } };
    writes.push({ type: 'set', key: key.state, value: state as unknown as JsonValue });
    await store.batch(writes);
    return true;
  };

  const stillOn = async (cursor: Cursor): Promise<boolean> => {
    if (cursor.hash === '') return true;
    try {
      return (await node.getBlockHash(cursor.height)) === cursor.hash;
    } catch {
      return false;
    }
  };

  // Mempool transactions paying a watched script or spending a watched
  // output, looked at once each; none at all when pearld will not list them.
  const scanMempool = async (): Promise<void> => {
    if (mempoolVisible === false) return;
    let txids: string[];
    try {
      txids = await node.getRawMempool();
      mempoolVisible = true;
    } catch (err) {
      if (!isLimitedUserRefusal(err) && !(err instanceof PearlRpcError && err.rpcCode === RPC_ERROR_CODES.METHOD_NOT_FOUND)) throw err;
      mempoolVisible = false;
      pending.clear();
      return;
    }
    const listed = new Set(txids);
    for (const txid of pending.keys()) if (!listed.has(txid) || found.has(txid)) pending.delete(txid);
    for (const txid of ignored) if (!listed.has(txid)) ignored.delete(txid);
    const fresh = txids.filter((txid) => !pending.has(txid) && !ignored.has(txid) && !found.has(txid));
    const fetched = await mapLimit(fresh, concurrency, async (txid) => {
      try {
        return { txid, hex: await node.getRawTransactionHex(txid) };
      } catch (err) {
        // Mined or evicted since the list was read.
        if (isUnknownTransaction(err) || (err instanceof PearlRpcError && err.rpcCode === RPC_ERROR_CODES.INVALID_ADDRESS_OR_KEY)) return null;
        throw err;
      }
    });
    const candidates = fetched.filter((item) => item !== null).map(({ txid, hex }) => ({ txid, hex, tx: parseTransaction(hex) }));
    // A spend may come before the payment it spends, so look until nothing more turns up.
    for (let added = true; added; ) {
      added = false;
      const { owned } = outputs();
      for (const candidate of candidates) {
        if (pending.has(candidate.txid)) continue;
        const relevant = candidate.tx.outs.some((out) => scripts.has(toHex(out.script))) || candidate.tx.ins.some((input) => owned.has(outpointOf(input)));
        if (!relevant) continue;
        pending.set(candidate.txid, { tx: candidate.tx, hex: candidate.hex });
        added = true;
      }
    }
    // A mempool transaction spending what a block has already spent lost.
    const confirmedSpends = new Set<string>();
    for (const item of found.values()) for (const input of item.tx.ins) confirmedSpends.add(outpointOf(input));
    for (const [txid, item] of pending) if (item.tx.ins.some((input) => confirmedSpends.has(outpointOf(input)))) pending.delete(txid);
    for (const candidate of candidates) if (!pending.has(candidate.txid)) ignored.add(candidate.txid);
  };

  const sync = (syncOptions: FilterSyncOptions = {}): Promise<BlockRef> =>
    exclusive(async () => {
      await loaded;
      await initial;
      const { signal, onProgress } = syncOptions;
      blocksFetched = 0;
      const best = await node.getBestBlock();
      const tip: BlockRef = { height: safeHeight(best.height, 'getbestblock'), hash: best.hash };
      for (let attempt = 0; ; attempt++) {
        signal?.throwIfAborted();
        if (state !== null) await reconcile(tip);
        if (state === null) {
          const start = await anchor(tip);
          if (start === null) break;
          state = { version: STATE_VERSION, network: network.name, birthday, anchor: start, cursor: start };
          await store.set(key.state, state as unknown as JsonValue);
        }
        let changed = false;
        while (state!.cursor.height < tip.height) {
          signal?.throwIfAborted();
          if (!(await scanRound(Math.min(tip.height, state!.cursor.height + batchSize)))) {
            changed = true;
            break;
          }
          onProgress?.({ height: state!.cursor.height, tip: tip.height, blocksFetched });
        }
        if (!changed) break;
        if (attempt >= 3) throw new PearlError('BACKEND_RESPONSE', 'the node\'s chain kept changing under the filter scan; try again');
      }
      await scanMempool();
      syncedAt = now();
      return cursorRef() ?? tip;
    });

  const cursorRef = (): BlockRef | null => (state === null || state.cursor.hash === '' ? null : { height: state.cursor.height, hash: state.cursor.hash });

  const fresh = async (): Promise<void> => {
    if (now() - syncedAt >= maxAge || state === null) await sync();
  };

  // Adds scripts and scans the blocks already passed for them alone.
  const watch = (watched: readonly Watched[]): Promise<void> =>
    exclusive(async () => {
      await loaded;
      const added = [...new Set(watched.map(scriptOf))].filter((script) => !scripts.has(script));
      if (added.length === 0) return;
      for (const script of added) scripts.add(script);
      const writes: StoreOperation[] = [{ type: 'set', key: key.scripts, value: [...scripts] }];
      if (state !== null && state.cursor.height >= birthday) {
        const list = added.map((script) => fromHex(script));
        const records = (await store.list(key.blocks)) as [string, [string, string, string | null]][];
        const matched: { height: number; hash: string }[] = [];
        const missing: { height: number; hash: string }[] = [];
        for (const [stored, [hash, , filter]] of records) {
          const height = Number(stored.slice(key.blocks.length));
          if (filter === null) missing.push({ height, hash });
          else if (matches(decodeFilter(filter), filterKey(hash), list)) matched.push({ height, hash });
        }
        const refetched = await mapLimit(missing, concurrency, async ({ height, hash }) => ({ height, hash, ...(await node.getCFilter(hash)) }));
        for (const { height, hash, filter, key: k } of refetched) if (matches(filter, k, list)) matched.push({ height, hash });
        matched.sort((a, b) => a.height - b.height);
        await fetchMatches(matched, writes);
        // The mempool is looked through afresh for the new scripts.
        ignored.clear();
      }
      await store.batch(writes);
    });

  const initial = options.watch === undefined || options.watch.length === 0 ? Promise.resolve() : watch(options.watch);
  initial.catch(() => {});

  const ensureWatched = async (watched: readonly Watched[]): Promise<string[]> => {
    const wanted = watched.map(scriptOf);
    if (wanted.some((script) => !scripts.has(script))) await watch(watched);
    await fresh();
    return wanted;
  };

  const tipHeight = (): number => state?.cursor.height ?? -1;
  const blockRef = (item: Found): BlockRef => ({ height: item.height, hash: item.hash, time: item.time });

  const getUtxos = async (watched: readonly Watched[]): Promise<WalletUtxo[]> => {
    const wanted = new Set(await ensureWatched(watched));
    const { owned, spentBy } = outputs();
    const utxos: WalletUtxo[] = [];
    for (const [outpoint, out] of owned) {
      if (!wanted.has(out.script) || spentBy.has(outpoint)) continue;
      const script = fromHex(out.script);
      utxos.push({
        txid: out.txid,
        vout: out.vout,
        value: out.value,
        script,
        address: fromOutputScript(script, network),
        confirmations: isFound(out.source) ? tipHeight() - out.source.height + 1 : 0,
        coinbase: out.coinbase,
      });
    }
    return utxos;
  };

  const history = async (watched: Watched): Promise<AddressHistoryEntry[]> => {
    const [script] = await ensureWatched([watched]);
    const { owned } = outputs();
    const entries: AddressHistoryEntry[] = [];
    const confirmed = [...found].sort(([, a], [, b]) => a.height - b.height || a.index - b.index);
    for (const [txid, item] of [...confirmed, ...pending]) {
      let received = 0n;
      for (const out of item.tx.outs) if (toHex(out.script) === script) received += out.value;
      let spent = 0n;
      for (const input of item.tx.ins) {
        const out = owned.get(outpointOf(input));
        if (out !== undefined && out.script === script) spent += out.value;
      }
      if (received === 0n && spent === 0n) continue;
      entries.push({ txid, block: isFound(item) ? blockRef(item) : null, received, spent });
    }
    return entries;
  };

  return {
    network,
    sync,
    watch,

    async getTip() {
      await fresh();
      return cursorRef() ?? base.getTip();
    },

    async getAddressActivity(address): Promise<AddressPayment[]> {
      return (await history(address)).filter((entry) => entry.received > 0n).map(({ txid, received, block }) => ({ txid, amount: received, block }));
    },

    async getTransaction(txid): Promise<ChainTransaction | null> {
      await fresh();
      const item = found.get(txid);
      if (item !== undefined) return { txid, block: blockRef(item) };
      if (pending.has(txid)) return { txid, block: null };
      return base.getTransaction(txid).catch((err: unknown) => {
        // Without --txindex pearld cannot say anything of a confirmed transaction it did not find for us.
        if (err instanceof PearlError && err.code === 'BACKEND_MISSING_INDEX') return null;
        throw err;
      });
    },

    async getRawTransaction(txid) {
      await loaded;
      const item = found.get(txid) ?? pending.get(txid);
      if (item !== undefined) return item.hex;
      try {
        return await node.getRawTransactionHex(txid);
      } catch (err) {
        if (err instanceof PearlRpcError && err.rpcCode === RPC_ERROR_CODES.INVALID_ADDRESS_OR_KEY) return null;
        throw err;
      }
    },

    getUtxos,

    async getBalance(watched) {
      return sumBalance(await getUtxos(watched), network.coinbaseMaturity);
    },

    getHistory: history,

    broadcast: (tx) => base.broadcast(tx),

    estimateFeeRate: (blocks?: number): Promise<FeeRate> => base.estimateFeeRate(blocks),

    async getSpendStatus(outpoint: OutPointParam): Promise<SpendStatus> {
      await fresh();
      const { owned, spentBy } = outputs();
      const id = `${outpoint.txid}:${outpoint.vout}`;
      const spender = spentBy.get(id);
      if (spender !== undefined) return { status: 'spent', spender: spender.txid, confirmed: spender.confirmed };
      const out = owned.get(id);
      if (out !== undefined) return { status: 'unspent', confirmations: isFound(out.source) ? tipHeight() - out.source.height + 1 : 0 };
      // Not the wallet's: gettxout knows unspent outputs, and nothing else here can tell spent from unknown.
      const result = await node.getTxOut(outpoint.txid, outpoint.vout, true);
      return result === null ? { status: 'unknown' } : { status: 'unspent', confirmations: result.confirmations };
    },

    async findUsed(addresses) {
      await ensureWatched(addresses);
      const paid = new Set<string>();
      for (const item of [...found.values(), ...pending.values()]) for (const out of item.tx.outs) paid.add(toHex(out.script));
      return addresses.filter((address) => paid.has(scriptOf(address)));
    },

    async status() {
      await loaded;
      return {
        cursor: cursorRef(),
        birthday,
        scripts: scripts.size,
        transactions: found.size,
        pending: pending.size,
        mempool: mempoolVisible,
      };
    },
  };
}

function isFound(item: Found | Pending): item is Found {
  return 'height' in item;
}

function outpointOf(input: Transaction['ins'][number]): string {
  return `${toHex(Uint8Array.from(input.hash).reverse())}:${input.index}`;
}
