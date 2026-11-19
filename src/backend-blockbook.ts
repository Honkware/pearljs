// A wallet backend over a Blockbook, for applications that run no node.
//
// Blockbook keys its address index by output script and indexes every
// output but OP_RETURN (PearlParser.IsAddrDescIndexable), and looks an
// address up by its script (GetAddrDescFromAddress), so P2TR and P2MR
// addresses are both found, payments and spends alike; the fork's commit
// 19ce79c7 only changed whether replies flag a P2MR output as an address.
//
// The server is a third party, so nothing it decodes is used: every
// transaction is read from its serialization, which must hash to the txid
// asked for, and an output counts for an address only when its script is
// the address's. What the server says about placement (which block, at
// which height) is held to the block itself when verifyBlocks is on, and to
// other servers when crossCheck is given. What it leaves out, nothing local
// can see.
//
// History is read in two queries per address, because Blockbook puts the
// mempool in front of the first page and cuts that page to the page size,
// which drops confirmed transactions off it (Worker.GetAddress): confirmed
// transactions up to the tip with `to`, which leaves the mempool out, and
// everything after the tip with `from`, which is the mempool and any block
// the tip query raced.
//
// With useXpub, an account's addresses are asked about together, by its key,
// with Blockbook's xpub query: the server derives the addresses (BIP86 P2TR
// key path on chains 0 and 1, api/xpub.go and PearlParser.ParseXpub) until
// `gap` unused ones past the last used, and lists each with its path and
// confirmed transaction count. The reply is a hint and nothing more: an index
// counts only where the server's address is the one the account derives
// there, the wallet still reads the history of every address the hint calls
// used, and what the server derived no further than is asked address by
// address.

/**
 * A wallet backend over a Blockbook server that checks what the server
 * says against the transactions and blocks themselves.
 *
 * @module
 */

import { fromOutputScript, toOutputScript } from './address.js';
import type { FeeRate } from './amount.js';
import { checkCertificateBinding, checkMerkleRoot, checkWitnessCommitment, parseBlock } from './block.js';
import { blockHashHex } from './blockheader.js';
import { BLOCKBOOK_MAX_HISTORY_OFFSET, BLOCKBOOK_MAX_PAGE_SIZE, isBlockbookNotFound } from './blockbook.js';
import type { BlockbookAddress, BlockbookClient, BlockbookTx, BlockbookXpubQuery } from './blockbook.js';
import type { AddressPayment, BlockRef, ChainTransaction } from './client.js';
import { bitsToTarget, checkCertificateRules } from './consensus.js';
import { PearlError, PearlRpcError } from './errors.js';
import { fromHex, toHex } from './internal/bytes.js';
import { mapLimit } from './internal/filter-scan.js';
import { DEFAULT_RELAY_FEE_RATE } from './policy.js';
import type { OutPointParam } from './rpc.js';
import { parseTransaction, transactionId } from './transaction.js';
import type { Transaction } from './transaction.js';
import { sumBalance } from './backend.js';
import type { AccountAddresses, AddressHistoryEntry, SpendStatus, WalletChain, WalletUtxo, Watched } from './backend.js';
import type { ActivityScanner } from './wallet.js';

/** Options for blockbookBackend. */
export interface BlockbookBackendOptions {
  /**
   * Download each block a transaction is said to be in, once, and check that
   * it hashes to the block hash given, that its merkle root commits to the
   * transaction, and its witness commitment, certificate binding and bits as
   * pearld checks them before it verifies a proof. Default true. When false,
   * a transaction's block and height are the server's word, held only to the
   * `crossCheck` servers, each asked where it places the transaction.
   */
  verifyBlocks?: boolean;
  /**
   * Other Blockbook servers, on the same network and each on a host of its
   * own, that must agree with the first: on the block at the height the backend reads to, on the block at
   * every height a transaction is placed at, and on the confirmed
   * transactions of every address it reads. One that cannot be asked or
   * disagrees fails the query with CROSS_CHECK_FAILED.
   */
  crossCheck?: readonly BlockbookClient[];
  /**
   * How many blocks apart the servers' tips may be. The backend reads no
   * further than the lowest of them, and fails with CROSS_CHECK_FAILED when
   * they are further apart. Default 6.
   */
  crossCheckLag?: number;
  /** Addresses or transactions asked about at once. Default 8; the client's maxConcurrentRequests still bounds requests. */
  concurrency?: number;
  /**
   * The lowest rate estimateFeeRate returns, grain per 1000 vbytes, since
   * Blockbook does not report its pearld's relay fee. Default
   * DEFAULT_RELAY_FEE_RATE, pearld's own default.
   */
  minFeeRate?: FeeRate;
  /**
   * Ask about the wallet's BIP86 accounts by their extended public keys,
   * one xpub query an account in place of a query an address, in discovery
   * and in later syncs. The server then knows every address of the account,
   * those it will use too. Default false.
   */
  useXpub?: boolean;
}

/** blockbookBackend's result: a WalletChain that also answers the wallet's per-sync question. */
export interface BlockbookChain extends WalletChain, ActivityScanner {
  readonly client: BlockbookClient;
  /** Which of these addresses have been paid or spent from, by the servers' counts. */
  findUsed(addresses: readonly string[], accounts?: readonly AccountAddresses[]): Promise<string[]>;
}

// A transaction a server listed for an address, with where it says it is.
interface Listed {
  txid: string;
  /** null for the mempool, or a block past the height being read to. */
  at: { height: number; hash: string; time: number } | null;
}

// A transaction read for an address: its outputs to the address and the address's outputs it spends.
interface Touch {
  txid: string;
  tx: Transaction;
  block: BlockRef | null;
  received: bigint;
  spent: bigint;
}

const prevTxid = (input: Transaction['ins'][number]): string => toHex(Uint8Array.from(input.hash).reverse());
const outpointOf = (input: Transaction['ins'][number]): string => `${prevTxid(input)}:${input.index}`;
const TXID_RE = /^[0-9a-f]{64}$/;
// server/public.go maxGapValue, and api/xpub.go maxAddressesGap.
const XPUB_MAX_GAP = 10_000;
// Transactions to a page of an account's history since a block.
const XPUB_PAGE_SIZE = 100;
// How long an account's xpub hint answers the later batches of a scan, in ms.
const SCAN_HINT_AGE = 30_000;

// What an xpub reply says of the account's addresses: on each chain, the
// address and confirmed transaction count the server gives each index, and
// how many indices from 0 it derived without a hole.
interface XpubHint {
  chains: [Map<number, { name: string; path: string; transfers: number }>, Map<number, { name: string; path: string; transfers: number }>];
  derived: [number, number];
  unconfirmed: number;
}

/**
 * A wallet backend over a Blockbook serving Pearl (BlockbookClient). It
 * sees P2TR and P2MR addresses alike, needs no node of your own, and is a
 * WalletChain and an ActivityScanner, so PearlWallet, discovery, invoices
 * and sweep run over it unchanged.
 *
 * Trust: the server can leave transactions out and can make up blocks,
 * since pearljs verifies no proof; `crossCheck` against servers run by
 * others is what catches that. What it cannot do unnoticed is change a
 * transaction, credit an address with an output that does not pay it,
 * place a transaction in a block that does not hold it (with verifyBlocks),
 * or say an output is spent by a transaction that does not spend it.
 */
export function blockbookBackend(client: BlockbookClient, options: BlockbookBackendOptions = {}): BlockbookChain {
  const { verifyBlocks = true, crossCheckLag = 6, concurrency = 8, minFeeRate = DEFAULT_RELAY_FEE_RATE, useXpub = false } = options;
  const others = options.crossCheck ?? [];
  if (!Number.isSafeInteger(crossCheckLag) || crossCheckLag < 0) throw new RangeError('crossCheckLag must be a number of blocks');
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new RangeError('concurrency must be a positive integer');
  if (typeof minFeeRate !== 'bigint' || minFeeRate < 0n) throw new RangeError('minFeeRate must be a bigint of grain per 1000 vbytes');
  const network = client.network;
  const hosts = new Set([new URL(client.url).host]);
  for (const other of others) {
    if (other.network.name !== network.name || other.network.genesisHash !== network.genesisHash) throw new TypeError('every crossCheck client must be for the backend\'s network');
    // A server checked against itself checks nothing.
    const host = new URL(other.url).host;
    if (hosts.has(host)) throw new TypeError(`crossCheck names ${host} twice, or the backend's own server: each must be another server`);
    hosts.add(host);
  }

  // Transactions by txid, once their serialization hashed to it.
  const transactions = new Map<string, { tx: Transaction; hex: string }>();
  // Blocks by hash, once checked: the height they were claimed at, their time and txids.
  const blocks = new Map<string, { height: number; time: number; txids: Set<string> }>();
  // Heights and hashes every cross-check server has confirmed, and without verifyBlocks the placements they agree
  // on, since the last reorganization seen.
  const confirmed = new Set<string>();
  let anchor: BlockRef | null = null;

  const bad = (message: string): PearlError => new PearlError('BACKEND_RESPONSE', `the Blockbook at ${new URL(client.url).host} ${message}`);
  const disagree = (i: number, message: string): PearlError => new PearlError('CROSS_CHECK_FAILED', `cross-check server ${i + 1} ${message}`);
  const ask = async <T>(i: number, run: (other: BlockbookClient) => Promise<T>): Promise<T> => {
    try {
      return await run(others[i]!);
    } catch (err) {
      if (err instanceof PearlError && err.code === 'BACKEND_WRONG_NETWORK') throw err;
      throw new PearlError('CROSS_CHECK_FAILED', `cross-check server ${i + 1} could not be asked: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
  };

  // The transaction, from its serialization, or null when the server has none.
  const fetchTx = async (txid: string, spending = false, source = client): Promise<{ tx: Transaction; reply: BlockbookTx } | null> => {
    let reply: BlockbookTx;
    try {
      reply = await source.getTransaction(txid, { spending });
    } catch (err) {
      if (isBlockbookNotFound(err)) return null;
      throw err;
    }
    if (typeof reply.hex !== 'string') throw badAt(source, `sent transaction ${txid} without its serialization`);
    let tx: Transaction;
    try {
      tx = parseTransaction(reply.hex);
    } catch (err) {
      throw new PearlError('BACKEND_RESPONSE', `the Blockbook sent transaction ${txid} in a form that does not parse: ${(err as Error).message}`, { cause: err });
    }
    if (transactionId(tx) !== txid) throw badAt(source, `returned transaction ${transactionId(tx)} for ${txid}`);
    transactions.set(txid, { tx, hex: reply.hex });
    return { tx, reply };
  };

  const txOf = async (txid: string): Promise<Transaction> => {
    const known = transactions.get(txid);
    if (known !== undefined) return known.tx;
    const fetched = await fetchTx(txid);
    if (fetched === null) throw bad(`listed transaction ${txid} but does not have it`);
    return fetched.tx;
  };

  // The height read to and its block: the server's best, or with crossCheck the lowest server's, which all must share.
  // Calls made while one is under way share its answer.
  let reading: Promise<BlockRef> | null = null;
  const tip = (): Promise<BlockRef> => (reading ??= readTip().finally(() => (reading = null)));
  const readTip = async (): Promise<BlockRef> => {
    const status = await client.getStatus();
    if (status.blockbook?.initialSync === true) throw bad('is still on its initial sync, so its index is not complete');
    let height = safe(status.blockbook?.bestHeight, 'a best height');
    if (others.length > 0) {
      const theirs = await Promise.all(others.map((_, i) => ask(i, async (other) => safe((await other.getStatus()).blockbook?.bestHeight, 'a best height'))));
      const all = [height, ...theirs];
      if (Math.max(...all) - Math.min(...all) > crossCheckLag) {
        throw new PearlError('CROSS_CHECK_FAILED', `the server's tip is at height ${height} and the cross-check servers' at ${theirs.join(', ')}, more than crossCheckLag (${crossCheckLag}) blocks apart`);
      }
      height = Math.min(...all);
    }
    const hash = await client.getBlockHash(height);
    if (hash === null) throw bad(`has no block at height ${height}, its own best`);
    if (others.length > 0) {
      await Promise.all(others.map(async (_, i) => {
        const theirs = await ask(i, (other) => other.getBlockHash(height));
        if (theirs !== hash) throw disagree(i, `has block ${String(theirs)} at height ${height}, where the server has ${hash}`);
      }));
      // The servers moved on: unless they all still have the last tip's block, a reorganization may have undone what they confirmed.
      const last = anchor;
      if (last !== null && (last.height !== height || last.hash !== hash)) {
        const kept = last.height < height && (await Promise.all(others.map((_, i) => ask(i, (other) => other.getBlockHash(last.height))))).every((theirs) => theirs === last.hash);
        if (!kept) confirmed.clear();
      }
      anchor = { height, hash };
      confirmed.add(`${height}:${hash}`);
    }
    return { height, hash };
  };

  // Every cross-check server has `hash` at `height`.
  const confirmAt = async (height: number, hash: string): Promise<void> => {
    if (others.length === 0 || confirmed.has(`${height}:${hash}`)) return;
    await Promise.all(others.map(async (_, i) => {
      const theirs = await ask(i, (other) => other.getBlockHash(height));
      if (theirs !== hash) throw disagree(i, `has block ${String(theirs)} at height ${height}, where the server places a transaction in ${hash}`);
    }));
    confirmed.add(`${height}:${hash}`);
  };

  const checkedBlock = async (hash: string, height: number): Promise<{ time: number; txids: Set<string> }> => {
    const known = blocks.get(hash);
    if (known !== undefined) {
      if (known.height !== height) throw bad(`places block ${hash} at height ${height} and at ${known.height}`);
      return known;
    }
    const block = parseBlock(fromHex(await client.getRawBlock(hash)));
    if (blockHashHex(block.header) !== hash) throw bad(`returned block ${blockHashHex(block.header)} for ${hash}`);
    const target = bitsToTarget(block.header.bits);
    if (target <= 0n || target > network.powLimit) throw new PearlError('BLOCK_HEADER_INVALID', `block ${hash} has bits ${block.header.bits.toString(16)}, outside the network's proof-of-work limit`);
    checkMerkleRoot(block);
    checkWitnessCommitment(block);
    if (height > 0) {
      checkCertificateBinding(block);
      checkCertificateRules(block.certificate, network, height);
    }
    const record = { height, time: block.header.timestamp, txids: new Set(block.transactions.map(transactionId)) };
    blocks.set(hash, record);
    return record;
  };

  // Without the block, only the cross-check servers can say a transaction is in it: each must place it there too.
  const placedAlike = async (txid: string, at: NonNullable<Listed['at']>): Promise<void> => {
    const key = `${txid}@${at.height}:${at.hash}`;
    if (confirmed.has(key)) return;
    await Promise.all(others.map(async (_, i) => {
      const theirs = await ask(i, (other) => other.getTransaction(txid).catch((err: unknown) => (isBlockbookNotFound(err) ? null : Promise.reject(err))));
      if (theirs?.blockHeight !== at.height || theirs.blockHash !== at.hash) {
        throw disagree(i, `places ${txid} ${theirs === null ? 'nowhere' : `at height ${String(theirs.blockHeight)} in block ${String(theirs.blockHash)}`}, where the server places it at height ${at.height} in ${at.hash}`);
      }
    }));
    confirmed.add(key);
  };

  // Where a transaction is, held to the block and the cross-check servers.
  const place = async (txid: string, at: NonNullable<Listed['at']>, upTo: BlockRef): Promise<BlockRef> => {
    if (at.height > upTo.height) throw bad(`places ${txid} at height ${at.height}, above its tip at ${upTo.height}`);
    let time = at.time;
    if (verifyBlocks) {
      const block = await checkedBlock(at.hash, at.height);
      if (!block.txids.has(txid)) throw bad(`places ${txid} in block ${at.hash}, which does not hold it`);
      time = block.time;
    } else {
      await placedAlike(txid, at);
    }
    await confirmAt(at.height, at.hash);
    return time > 0 ? { height: at.height, hash: at.hash, time } : { height: at.height, hash: at.hash };
  };

  // Every confirmed txid of an address from `from` to `to`, page by page, with where the server says each is.
  const confirmedOf = async (source: BlockbookClient, address: string, from: number, to: number): Promise<Listed[]> => {
    const listed: Listed[] = [];
    if (from > to) return listed;
    for (let page = 1; ; page++) {
      const reply = await source.getAddress(address, { details: 'txslight', page, pageSize: BLOCKBOOK_MAX_PAGE_SIZE, from, to });
      // Past the last page Blockbook answers with the last page again.
      if (reply.page !== undefined && reply.page !== page) break;
      const items = reply.transactions ?? [];
      if (!Array.isArray(items)) throw bad(`sent a history of ${address} that is not a list`);
      for (const item of items) {
        const { txid, blockHeight, blockHash, blockTime } = item ?? ({} as BlockbookTx);
        if (typeof txid !== 'string' || !TXID_RE.test(txid)) throw bad(`listed something other than a txid for ${address}`);
        if (!Number.isSafeInteger(blockHeight) || blockHeight < from || blockHeight > to || typeof blockHash !== 'string' || !TXID_RE.test(blockHash)) {
          throw bad(`places ${txid} at height ${String(blockHeight)} in block ${String(blockHash)}, outside heights ${from} to ${to} asked for`);
        }
        listed.push({ txid, at: { height: blockHeight, hash: blockHash, time: Number.isSafeInteger(blockTime) && blockTime > 0 ? blockTime : 0 } });
      }
      if (items.length < BLOCKBOOK_MAX_PAGE_SIZE) break;
      if (page * BLOCKBOOK_MAX_PAGE_SIZE >= BLOCKBOOK_MAX_HISTORY_OFFSET) {
        throw new PearlError('BACKEND_UNSUPPORTED', `${address} has more than ${BLOCKBOOK_MAX_HISTORY_OFFSET} confirmed transactions, past which Blockbook does not page`);
      }
    }
    return listed;
  };

  // An address's confirmed transactions from `after` + 1 to the height read to, held to the cross-check servers.
  const checkedConfirmed = async (address: string, upTo: BlockRef, after: number): Promise<Listed[]> => {
    const chained = await confirmedOf(client, address, after + 1, upTo.height);
    if (others.length > 0) {
      const ours = new Set(chained.map((item) => item.txid));
      await Promise.all(others.map(async (_, i) => {
        const theirs = await ask(i, (other) => confirmedOf(other, address, after + 1, upTo.height));
        const missing = theirs.filter((item) => !ours.has(item.txid)).length;
        const extra = ours.size - (theirs.length - missing);
        if (missing > 0 || extra > 0) throw disagree(i, `lists ${theirs.length} confirmed transactions for ${address} from height ${after + 1} to ${upTo.height}, where the server lists ${ours.size}`);
      }));
    }
    return chained;
  };

  // Whole confirmed histories up to the block read to, by address, for as long as that block is the one read to: a
  // sync reads an address's history for its transactions and again for its coins, and asking twice about the same
  // blocks only gives the server a second chance to answer differently.
  let historiesAt = '';
  const histories = new Map<string, Promise<Listed[]>>();
  const confirmedHistory = (address: string, upTo: BlockRef): Promise<Listed[]> => {
    const at = `${upTo.height}:${upTo.hash}`;
    if (historiesAt !== at) {
      histories.clear();
      historiesAt = at;
    }
    let listing = histories.get(address);
    if (listing === undefined) {
      const fresh = checkedConfirmed(address, upTo, -1);
      fresh.catch(() => histories.get(address) === fresh && histories.delete(address));
      histories.set(address, (listing = fresh));
    }
    return listing;
  };

  // What the server lists for an address after `after`, mempool included, each txid once.
  const listedOf = async (address: string, upTo: BlockRef, after: number): Promise<Listed[]> => {
    const [chained, later] = await Promise.all([
      after === -1 ? confirmedHistory(address, upTo) : checkedConfirmed(address, upTo, after),
      client.getAddress(address, { details: 'txids', pageSize: BLOCKBOOK_MAX_PAGE_SIZE, from: upTo.height + 1 }),
    ]);
    const pending = later.txids ?? [];
    if (!Array.isArray(pending)) throw bad(`sent mempool txids of ${address} that are not a list`);
    if (pending.length >= BLOCKBOOK_MAX_PAGE_SIZE) throw new PearlError('BACKEND_UNSUPPORTED', `${address} has ${BLOCKBOOK_MAX_PAGE_SIZE} or more mempool transactions, more than Blockbook lists`);
    const seen = new Set<string>();
    const result: Listed[] = [];
    for (const item of [...chained, ...pending.map((txid): Listed => ({ txid, at: null }))]) {
      if (typeof item.txid !== 'string' || !TXID_RE.test(item.txid)) throw bad(`listed something other than a txid for ${address}`);
      if (seen.has(item.txid)) continue;
      seen.add(item.txid);
      result.push(item);
    }
    return result;
  };

  // The listed transactions read from their serializations, each shown to pay
  // the address's script or spend an output that does.
  const touches = async (address: string, upTo: BlockRef, after: number): Promise<Touch[]> => {
    const script = toHex(toOutputScript(address, network));
    const listed = await listedOf(address, upTo, after);
    const txs = await mapLimit(listed, concurrency, (item) => txOf(item.txid));
    const owned = new Map<string, bigint>();
    txs.forEach((tx, i) => tx.outs.forEach((out, vout) => toHex(out.script) === script && owned.set(`${listed[i]!.txid}:${vout}`, out.value)));
    return mapLimit(listed, concurrency, async (item) => {
      const tx = transactions.get(item.txid)!.tx;
      let received = 0n;
      for (const out of tx.outs) if (toHex(out.script) === script) received += out.value;
      let spent = 0n;
      if (!tx.isCoinbase()) {
        for (const input of tx.ins) {
          const key = outpointOf(input);
          let value = owned.get(key);
          // An output from before `after`: its own transaction says whose it was.
          if (value === undefined && received === 0n && spent === 0n) {
            const out = (await txOf(prevTxid(input))).outs[input.index];
            if (out !== undefined && toHex(out.script) === script) owned.set(key, (value = out.value));
          }
          if (value !== undefined) spent += value;
        }
      }
      if (received === 0n && spent === 0n) throw bad(`listed ${item.txid} for ${address}, which neither pays it nor spends from it`);
      // A block past the height read to counts as not yet confirmed.
      const block = item.at === null ? null : await place(item.txid, item.at, upTo);
      return { txid: item.txid, tx, block, received, spent };
    });
  };

  const addressOf = (watched: Watched): string => {
    if (typeof watched !== 'string') return fromOutputScript(watched, network);
    toOutputScript(watched, network);
    return watched;
  };

  const confirmations = (block: BlockRef | null, upTo: BlockRef): number => (block === null ? 0 : upTo.height - block.height + 1);

  const getUtxos = async (watched: readonly Watched[]): Promise<WalletUtxo[]> => {
    const addresses = [...new Set(watched.map(addressOf))];
    const upTo = await tip();
    const lists = await mapLimit(addresses, concurrency, (address) => touches(address, upTo, -1));
    const utxos: WalletUtxo[] = [];
    lists.forEach((list, i) => {
      const address = addresses[i]!;
      const script = toOutputScript(address, network);
      const hex = toHex(script);
      // Every spend of an address's output is in its own history, the mempool's included.
      const spent = new Set(list.flatMap(({ tx }) => (tx.isCoinbase() ? [] : tx.ins.map(outpointOf))));
      for (const { txid, tx, block } of list) {
        tx.outs.forEach((out, vout) => {
          if (toHex(out.script) !== hex || spent.has(`${txid}:${vout}`)) return;
          utxos.push({ txid, vout, value: out.value, script: Uint8Array.from(script), address, confirmations: confirmations(block, upTo), coinbase: tx.isCoinbase() });
        });
      }
    });
    return utxos;
  };

  const history = async (watched: Watched): Promise<AddressHistoryEntry[]> => {
    const address = addressOf(watched);
    const list = await touches(address, await tip(), -1);
    const order = (a: Touch) => a.block?.height ?? Infinity;
    return [...list].sort((a, b) => order(a) - order(b)).map(({ txid, block, received, spent }) => ({ txid, block, received, spent }));
  };

  // Which mempool transaction listed for the output's address spends it, if any.
  const pendingSpender = async (script: Uint8Array, outpoint: string, upTo: BlockRef): Promise<string | null> => {
    let address: string;
    try {
      address = fromOutputScript(script, network);
    } catch {
      return null;
    }
    const later = (await client.getAddress(address, { details: 'txids', pageSize: BLOCKBOOK_MAX_PAGE_SIZE, from: upTo.height + 1 })).txids ?? [];
    for (const txid of later) {
      if (typeof txid !== 'string' || !TXID_RE.test(txid)) throw bad(`listed something other than a txid for ${address}`);
      const tx = await txOf(txid);
      if (!tx.isCoinbase() && tx.ins.some((input) => outpointOf(input) === outpoint)) return txid;
    }
    return null;
  };

  const usedBy = async (source: BlockbookClient, addresses: readonly string[]): Promise<Set<string>> => {
    const counts = await mapLimit(addresses, concurrency, (address) => source.getAddress(address, { details: 'basic' }));
    return new Set(addresses.filter((_, i) => (counts[i]!.txs ?? 0) > 0 || (counts[i]!.unconfirmedTxs ?? 0) > 0));
  };

  const badAt = (source: BlockbookClient, message: string): PearlError => new PearlError('BACKEND_RESPONSE', `the Blockbook at ${new URL(source.url).host} ${message}`);
  const scriptOf = (address: string): string => toHex(toOutputScript(address, network));
  const accountGap = (account: AccountAddresses, least = 1): number => {
    if (!Number.isSafeInteger(account.gap) || account.gap < 1) throw new RangeError('an account\'s gap must be a positive integer');
    return Math.min(Math.max(account.gap, least), XPUB_MAX_GAP);
  };

  // An xpub query, or null when the server will not answer it, as one without xpub support or past its derivation limit does.
  const xpubQuery = async (source: BlockbookClient, xpub: string, query: BlockbookXpubQuery): Promise<BlockbookAddress | null> => {
    try {
      return await source.getXpub(xpub, query);
    } catch (err) {
      if (err instanceof PearlRpcError && err.kind === 'rpc') return null;
      throw err;
    }
  };

  const readHint = (source: BlockbookClient, reply: BlockbookAddress): XpubHint => {
    const chains: XpubHint['chains'] = [new Map(), new Map()];
    const tokens = reply.tokens ?? [];
    if (!Array.isArray(tokens)) throw badAt(source, 'sent the derived addresses of an xpub as something other than a list');
    for (const token of tokens) {
      const path = typeof token?.path === 'string' ? token.path : '';
      const match = /\/([01])\/(0|[1-9]\d{0,9})$/.exec(path);
      if (match === null || typeof token.name !== 'string' || !Number.isSafeInteger(token.transfers) || token.transfers < 0) {
        throw badAt(source, `sent a derived address at ${JSON.stringify(path)}, which is not an index of chain 0 or 1 with a transaction count`);
      }
      const chain = chains[match[1] === '1' ? 1 : 0];
      const index = Number(match[2]);
      if (chain.has(index)) throw badAt(source, `lists two addresses at ${path}`);
      chain.set(index, { name: token.name, path, transfers: token.transfers });
    }
    const derived = chains.map((chain) => {
      let count = 0;
      while (chain.has(count)) count += 1;
      return count;
    }) as [number, number];
    if (!Number.isSafeInteger(reply.unconfirmedTxs) || reply.unconfirmedTxs < 0) throw badAt(source, `sent ${JSON.stringify(reply.unconfirmedTxs)} as an xpub's mempool transaction count`);
    return { chains, derived, unconfirmed: reply.unconfirmedTxs };
  };

  // The server's word on a child, where it derived that far without a hole; null past that. Its address must be the one the account derives there.
  const tokenFor = (source: BlockbookClient, hint: XpubHint, address: string, child: { change: boolean; index: number }): { transfers: number } | null => {
    const chain = child.change ? 1 : 0;
    if (child.index >= hint.derived[chain]) return null;
    const token = hint.chains[chain].get(child.index)!;
    if (token.name !== address) throw badAt(source, `derives ${token.name} at ${token.path}, where the account has ${address}`);
    return token;
  };

  // The account's mempool transactions, each read and hash-checked. Blockbook puts them in front of the first page
  // and counts them in unconfirmedTxs of the same reply, which the page of one confirmed transaction then follows.
  // Unlike an address's, the xpub page is not cut to the page size: GetXpubAddress (api/xpub.go, 81f52f21) appends
  // every mempool entry first and pages only the confirmed transactions after them.
  const pendingOf = async (source: BlockbookClient, xpub: string, gap: number): Promise<{ txid: string; tx: Transaction }[] | null> => {
    const reply = await xpubQuery(source, xpub, { details: 'txids', pageSize: 1, tokens: 'used', gap });
    if (reply === null) return null;
    const txids = reply.txids ?? [];
    if (!Array.isArray(txids)) throw badAt(source, 'sent the txids of an xpub as something other than a list');
    if (!Number.isSafeInteger(reply.unconfirmedTxs) || reply.unconfirmedTxs < 0) throw badAt(source, `sent ${JSON.stringify(reply.unconfirmedTxs)} as an xpub's mempool transaction count`);
    const pending = [...new Set(txids.slice(0, reply.unconfirmedTxs))];
    for (const txid of pending) if (typeof txid !== 'string' || !TXID_RE.test(txid)) throw badAt(source, 'listed something other than a txid for an xpub');
    const fetched = await mapLimit(pending, concurrency, async (txid) => ({ txid, tx: transactions.get(txid)?.tx ?? (await fetchTx(txid, false, source))?.tx }));
    // One that left the mempool between the queries is no longer the account's news.
    return fetched.flatMap(({ txid, tx }) => (tx === undefined ? [] : [{ txid, tx }]));
  };

  // An account's hint for a scan: its derived addresses, and the scripts its mempool transactions pay.
  const scanHintOf = async (source: BlockbookClient, xpub: string, gap: number): Promise<{ hint: XpubHint; paid: Set<string> } | null> => {
    const reply = await xpubQuery(source, xpub, { details: 'tokens', tokens: 'derived', gap });
    if (reply === null) return null;
    const hint = readHint(source, reply);
    const paid = new Set<string>();
    if (hint.unconfirmed > 0) {
      const pending = await pendingOf(source, xpub, gap);
      if (pending === null) return null;
      for (const { tx } of pending) for (const out of tx.outs) paid.add(toHex(out.script));
    }
    return { hint, paid };
  };

  // Each account's hint from each server for the scan under way, and the indices that scan has asked about. A scan asks
  // about each index once, so an index asked again is a new scan, which asks the server again; so does a batch asked
  // SCAN_HINT_AGE after the hint, which a caller going on with its own scan later would otherwise get stale.
  const scans = new Map<string, { gap: number; at: number; asked: Set<string>; hint: Promise<{ hint: XpubHint; paid: Set<string> } | null> }>();
  const scanHint = (i: number, source: BlockbookClient, account: AccountAddresses, children: readonly (readonly [string, { change: boolean; index: number }])[]) => {
    const gap = accountGap(account);
    const key = `${i}:${account.xpub}`;
    const marks = children.map(([, child]) => `${child.change ? 1 : 0}/${child.index}`);
    let scan = scans.get(key);
    const now = Date.now();
    if (scan === undefined || scan.gap !== gap || now - scan.at >= SCAN_HINT_AGE || marks.some((mark) => scan!.asked.has(mark))) {
      const fresh = { gap, at: now, asked: new Set<string>(), hint: scanHintOf(source, account.xpub, gap) };
      fresh.hint.catch(() => scans.get(key) === fresh && scans.delete(key));
      scans.set(key, (scan = fresh));
    }
    for (const mark of marks) scan.asked.add(mark);
    return scan.hint;
  };

  // Which addresses one server calls used: account addresses it derived by its xpub hint, the rest one query each.
  const usedVia = async (i: number, source: BlockbookClient, addresses: readonly string[], accounts: readonly AccountAddresses[]): Promise<Set<string>> => {
    const used = new Set<string>();
    const rest = new Set(addresses);
    if (useXpub) {
      for (const account of accounts) {
        const children = [...rest].flatMap((address) => {
          const child = account.children.get(address);
          return child === undefined ? [] : [[address, child] as const];
        });
        if (children.length === 0) continue;
        const found = await scanHint(i, source, account, children);
        if (found === null) continue;
        for (const [address, child] of children) {
          const token = tokenFor(source, found.hint, address, child);
          if (token === null) continue;
          rest.delete(address);
          if (token.transfers > 0 || found.paid.has(scriptOf(address))) used.add(address);
        }
      }
    }
    for (const address of await usedBy(source, [...rest])) used.add(address);
    return used;
  };

  // The account's confirmed transactions after `after` as one server lists them, with its hint. Blockbook leaves the
  // mempool out of a listing with `from` and still counts it in unconfirmedTxs.
  const listSince = async (source: BlockbookClient, xpub: string, gap: number, after: number): Promise<{ hint: XpubHint; listed: Listed[] } | null> => {
    const listed: Listed[] = [];
    let hint: XpubHint | null = null;
    for (let page = 1; ; page++) {
      const reply = await xpubQuery(source, xpub, { details: 'txslight', tokens: 'derived', gap, from: after + 1, page, pageSize: XPUB_PAGE_SIZE });
      if (reply === null) {
        if (hint === null) return null;
        throw badAt(source, `answered page ${page - 1} of an xpub's history and refused page ${page}`);
      }
      hint ??= readHint(source, reply);
      if (reply.page !== undefined && reply.page !== page) break;
      const items = reply.transactions ?? [];
      if (!Array.isArray(items)) throw badAt(source, 'sent the history of an xpub as something other than a list');
      for (const item of items) {
        const { txid, blockHeight, blockHash, blockTime } = item ?? ({} as BlockbookTx);
        if (typeof txid !== 'string' || !TXID_RE.test(txid)) throw badAt(source, 'listed something other than a txid for an xpub');
        if (!Number.isSafeInteger(blockHeight) || blockHeight <= after || typeof blockHash !== 'string' || !TXID_RE.test(blockHash)) {
          throw badAt(source, `places ${txid} at height ${String(blockHeight)} in block ${String(blockHash)}, outside the heights from ${after + 1} asked for`);
        }
        listed.push({ txid, at: { height: blockHeight, hash: blockHash, time: Number.isSafeInteger(blockTime) && blockTime > 0 ? blockTime : 0 } });
      }
      if (items.length < XPUB_PAGE_SIZE) break;
      if (page * XPUB_PAGE_SIZE >= BLOCKBOOK_MAX_HISTORY_OFFSET) throw new PearlError('BACKEND_UNSUPPORTED', `an account has more than ${BLOCKBOOK_MAX_HISTORY_OFFSET} transactions since height ${after}, past which Blockbook does not page`);
    }
    return { hint: hint!, listed };
  };

  // What touched the account's watched addresses after `after`, by the xpub query: the watched addresses every server
  // derived (the rest are left to the per-address queries) and the transactions that pay or spend from them. Null
  // when the server will not answer for the key.
  const accountSince = async (account: AccountAddresses, watched: ReadonlySet<string>, upTo: BlockRef, after: number): Promise<{ covered: string[]; activity: Map<string, BlockRef | null> } | null> => {
    let children = [...account.children].filter(([address]) => watched.has(address));
    if (children.length === 0) return null;
    // Wide enough that the server derives every watched index.
    const gap = accountGap(account, Math.max(...children.map(([, child]) => child.index + 1)));
    const ours = await listSince(client, account.xpub, gap, after);
    if (ours === null) return null;
    children = children.filter(([address, child]) => tokenFor(client, ours.hint, address, child) !== null);
    const atOrBelow = (listed: Listed[]): Set<string> => new Set(listed.flatMap((item) => (item.at !== null && item.at.height <= upTo.height ? [item.txid] : [])));
    const confirmedHere = atOrBelow(ours.listed);
    const theirs = await Promise.all(others.map((_, i) => ask(i, async (other) => {
      const listing = await listSince(other, account.xpub, gap, after);
      if (listing !== null) children = children.filter(([address, child]) => tokenFor(other, listing.hint, address, child) !== null);
      return listing;
    })));
    theirs.forEach((listing, i) => {
      // One that will not answer for the key covers nothing, and the per-address queries are held to it instead.
      if (listing === null) return void (children = []);
      const listed = atOrBelow(listing.listed);
      const missing = [...listed].filter((txid) => !confirmedHere.has(txid)).length;
      if (missing > 0 || listed.size - missing !== confirmedHere.size) {
        throw disagree(i, `lists ${listed.size} confirmed transactions for an account from height ${after + 1} to ${upTo.height}, where the server lists ${confirmedHere.size}`);
      }
    });
    if (children.length === 0) return null;
    // A block past the height read to counts as not yet confirmed.
    const candidates = new Map(ours.listed.map((item) => [item.txid, item.at !== null && item.at.height <= upTo.height ? item.at : null]));
    if (ours.hint.unconfirmed > 0) {
      const pending = await pendingOf(client, account.xpub, gap);
      if (pending === null) return null;
      for (const { txid } of pending) if (!candidates.has(txid)) candidates.set(txid, null);
    }
    const scripts = new Set(children.map(([address]) => scriptOf(address)));
    const listed = [...candidates];
    const txs = await mapLimit(listed, concurrency, ([txid]) => txOf(txid));
    const owned = new Set<string>();
    txs.forEach((tx, i) => tx.outs.forEach((out, vout) => scripts.has(toHex(out.script)) && owned.add(`${listed[i]![0]}:${vout}`)));
    const found = await mapLimit(listed, concurrency, async ([txid, at]): Promise<[string, BlockRef | null] | null> => {
      const tx = transactions.get(txid)!.tx;
      let touched = tx.outs.some((out) => scripts.has(toHex(out.script)));
      for (const input of tx.isCoinbase() ? [] : tx.ins) {
        if (touched) break;
        if (owned.has(outpointOf(input))) touched = true;
        else touched = scripts.has(toHex((await txOf(prevTxid(input))).outs[input.index]?.script ?? new Uint8Array(0)));
      }
      // One for an address of the account that is not watched, which the server derives further than the wallet
      // watches, is left out as the per-address queries would leave it out.
      if (!touched) return null;
      return [txid, at === null ? null : await place(txid, at, upTo)];
    });
    return { covered: children.map(([address]) => address), activity: new Map(found.filter((item) => item !== null)) };
  };

  return {
    network,
    client,
    getTip: tip,

    async getAddressActivity(address): Promise<AddressPayment[]> {
      return (await history(address)).filter((entry) => entry.received > 0n).map(({ txid, received, block }) => ({ txid, amount: received, block }));
    },

    async getTransaction(txid): Promise<ChainTransaction | null> {
      const upTo = await tip();
      let fetched = await fetchTx(txid);
      // One server's "not found" is not the answer while another has the transaction: a wallet frees coins on it.
      for (let i = 0; fetched === null && i < others.length; i++) fetched = await ask(i, (other) => fetchTx(txid, false, other));
      if (fetched === null) return null;
      const { blockHeight, blockHash, blockTime } = fetched.reply;
      if (!Number.isSafeInteger(blockHeight) || blockHeight < 0 || blockHeight > upTo.height || typeof blockHash !== 'string' || !TXID_RE.test(blockHash)) return { txid, block: null };
      return { txid, block: await place(txid, { height: blockHeight, hash: blockHash, time: Number.isSafeInteger(blockTime) ? blockTime : 0 }, upTo) };
    },

    async getRawTransaction(txid) {
      const known = transactions.get(txid);
      if (known !== undefined) return known.hex;
      await fetchTx(txid);
      return transactions.get(txid)?.hex ?? null;
    },

    getUtxos,

    async getBalance(watched) {
      return sumBalance(await getUtxos(watched), network.coinbaseMaturity);
    },

    getHistory: history,

    async broadcast(tx) {
      const hex = typeof tx === 'string' ? tx : toHex(tx);
      const txid = transactionId(parseTransaction(hex));
      let reported: string;
      try {
        reported = await client.sendTransaction(hex);
      } catch (err) {
        // A refusal is the server's word, and a cross-check server that has the transaction shows it went out all the same.
        if (err instanceof PearlRpcError && err.kind === 'rpc') {
          for (let i = 0; i < others.length; i++) if ((await ask(i, (other) => fetchTx(txid, false, other)).catch(() => null)) !== null) return txid;
        }
        throw err;
      }
      if (reported !== txid) throw bad(`reported txid ${reported} for transaction ${txid}`);
      return txid;
    },

    async estimateFeeRate(blocks = 6) {
      let rate = 0n;
      try {
        rate = await client.estimateFee(blocks);
      } catch (err) {
        // pearld without an estimate yet makes Blockbook answer HTTP 500.
        if (!(err instanceof PearlRpcError && err.kind === 'rpc' && err.status === 500)) throw err;
      }
      return rate > minFeeRate ? rate : minFeeRate;
    },

    async getSpendStatus(outpoint: OutPointParam): Promise<SpendStatus> {
      const { txid, vout } = outpoint;
      const upTo = await tip();
      const fetched = await fetchTx(txid, true);
      const out = fetched?.tx.outs[vout];
      if (fetched === null || out === undefined) return { status: 'unknown' };
      const id = `${txid}:${vout}`;
      const said = fetched.reply.vout?.find((item) => item?.n === vout);
      if (said?.spent === true) {
        const spender = said.spentTxId;
        // A spend is believed only with the spending transaction in hand.
        if (spender === undefined || spender === '') return { status: 'unknown' };
        if (!TXID_RE.test(spender)) throw bad(`names ${String(spender)} as the spender of ${id}`);
        const spending = await fetchTx(spender);
        if (spending === null || spending.tx.isCoinbase() || !spending.tx.ins.some((input) => outpointOf(input) === id)) throw bad(`names ${spender} as the spender of ${id}, which it does not spend`);
        const { blockHeight, blockHash, blockTime } = spending.reply;
        const inBlock = Number.isSafeInteger(blockHeight) && blockHeight >= 0 && blockHeight <= upTo.height && typeof blockHash === 'string' && TXID_RE.test(blockHash);
        if (inBlock) await place(spender, { height: blockHeight, hash: blockHash, time: blockTime }, upTo);
        return { status: 'spent', spender, confirmed: inBlock };
      }
      // Blockbook marks confirmed spends only, so a mempool spend is looked for among the address's mempool transactions.
      const pending = await pendingSpender(out.script, id, upTo);
      if (pending !== null) return { status: 'spent', spender: pending, confirmed: false };
      const { blockHeight, blockHash, blockTime } = fetched.reply;
      if (!Number.isSafeInteger(blockHeight) || blockHeight < 0 || blockHeight > upTo.height || typeof blockHash !== 'string' || !TXID_RE.test(blockHash)) return { status: 'unspent', confirmations: 0 };
      const block = await place(txid, { height: blockHeight, hash: blockHash, time: blockTime }, upTo);
      return { status: 'unspent', confirmations: confirmations(block, upTo) };
    },

    async findUsed(addresses, accounts = []) {
      for (const address of addresses) addressOf(address);
      // Any server's word that an address was used is taken: a wrong yes only widens a scan.
      const sets = await Promise.all([usedVia(0, client, addresses, accounts), ...others.map((_, i) => ask(i, (other) => usedVia(i + 1, other, addresses, accounts)))]);
      return addresses.filter((address) => sets.some((set) => set.has(address)));
    },

    async getActivitySince(watched, after, accounts = []) {
      const upTo = await tip();
      if (after.height > upTo.height) return null;
      const hash = after.height === upTo.height ? upTo.hash : await client.getBlockHash(after.height);
      if (hash !== after.hash) return null;
      await confirmAt(after.height, after.hash);
      const rest = new Set(watched.map(addressOf));
      const activity = new Map<string, BlockRef | null>();
      if (useXpub) {
        for (const account of accounts) {
          const found = await accountSince(account, rest, upTo, after.height);
          if (found === null) continue;
          for (const address of found.covered) rest.delete(address);
          for (const [txid, block] of found.activity) activity.set(txid, block);
        }
      }
      const lists = await mapLimit([...rest], concurrency, (address) => touches(address, upTo, after.height));
      for (const list of lists) for (const { txid, block } of list) activity.set(txid, block);
      return [...activity].map(([txid, block]) => ({ txid, block }));
    },
  };

  function safe(value: unknown, what: string): number {
    if (!Number.isSafeInteger(value) || (value as number) < 0) throw bad(`sent ${what} that is not a block height: ${JSON.stringify(value)}`);
    return value as number;
  }
}
