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
import type { BlockbookClient, BlockbookTx } from './blockbook.js';
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
import type { AddressHistoryEntry, SpendStatus, WalletChain, WalletUtxo, Watched } from './backend.js';
import type { ActivityScanner } from './wallet.js';

/** Options for blockbookBackend. */
export interface BlockbookBackendOptions {
  /**
   * Download each block a transaction is said to be in, once, and check that
   * it hashes to the block hash given, that its merkle root commits to the
   * transaction, and its witness commitment, certificate binding and bits as
   * pearld checks them before it verifies a proof. Default true.
   */
  verifyBlocks?: boolean;
  /**
   * Other Blockbook servers, on the same network, that must agree with the
   * first: on the block at the height the backend reads to, on the block at
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
}

/** blockbookBackend's result: a WalletChain that also answers the wallet's per-sync question. */
export interface BlockbookChain extends WalletChain, ActivityScanner {
  readonly client: BlockbookClient;
  /** Which of these addresses have been paid or spent from, by the servers' counts. */
  findUsed(addresses: readonly string[]): Promise<string[]>;
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
  const { verifyBlocks = true, crossCheckLag = 6, concurrency = 8, minFeeRate = DEFAULT_RELAY_FEE_RATE } = options;
  const others = options.crossCheck ?? [];
  if (!Number.isSafeInteger(crossCheckLag) || crossCheckLag < 0) throw new RangeError('crossCheckLag must be a number of blocks');
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new RangeError('concurrency must be a positive integer');
  if (typeof minFeeRate !== 'bigint' || minFeeRate < 0n) throw new RangeError('minFeeRate must be a bigint of grain per 1000 vbytes');
  const network = client.network;
  for (const other of others) {
    if (other.network.name !== network.name || other.network.genesisHash !== network.genesisHash) throw new TypeError('every crossCheck client must be for the backend\'s network');
  }

  // Transactions by txid, once their serialization hashed to it.
  const transactions = new Map<string, { tx: Transaction; hex: string }>();
  // Blocks by hash, once checked: the height they were claimed at, their time and txids.
  const blocks = new Map<string, { height: number; time: number; txids: Set<string> }>();
  // Heights and hashes every cross-check server has confirmed, since the last reorganization seen.
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
  const fetchTx = async (txid: string, spending = false): Promise<{ tx: Transaction; reply: BlockbookTx } | null> => {
    let reply: BlockbookTx;
    try {
      reply = await client.getTransaction(txid, { spending });
    } catch (err) {
      if (isBlockbookNotFound(err)) return null;
      throw err;
    }
    if (typeof reply.hex !== 'string') throw bad(`sent transaction ${txid} without its serialization`);
    let tx: Transaction;
    try {
      tx = parseTransaction(reply.hex);
    } catch (err) {
      throw new PearlError('BACKEND_RESPONSE', `the Blockbook sent transaction ${txid} in a form that does not parse: ${(err as Error).message}`, { cause: err });
    }
    if (transactionId(tx) !== txid) throw bad(`returned transaction ${transactionId(tx)} for ${txid}`);
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
  const tip = async (): Promise<BlockRef> => {
    const status = await client.getStatus();
    if (status.blockbook.initialSync === true) throw bad('is still on its initial sync, so its index is not complete');
    let height = safe(status.blockbook.bestHeight, 'a best height');
    if (others.length > 0) {
      const theirs = await Promise.all(others.map((_, i) => ask(i, async (other) => safe((await other.getStatus()).blockbook.bestHeight, 'a best height'))));
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

  // Where a transaction is, held to the block and the cross-check servers.
  const place = async (txid: string, at: NonNullable<Listed['at']>, upTo: BlockRef): Promise<BlockRef> => {
    if (at.height > upTo.height) throw bad(`places ${txid} at height ${at.height}, above its tip at ${upTo.height}`);
    let time = at.time;
    if (verifyBlocks) {
      const block = await checkedBlock(at.hash, at.height);
      if (!block.txids.has(txid)) throw bad(`places ${txid} in block ${at.hash}, which does not hold it`);
      time = block.time;
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

  // What the server lists for an address after `after`, mempool included, each txid once.
  const listedOf = async (address: string, upTo: BlockRef, after: number): Promise<Listed[]> => {
    const [chained, later] = await Promise.all([
      confirmedOf(client, address, after + 1, upTo.height),
      client.getAddress(address, { details: 'txids', pageSize: BLOCKBOOK_MAX_PAGE_SIZE, from: upTo.height + 1 }),
    ]);
    const pending = later.txids ?? [];
    if (!Array.isArray(pending)) throw bad(`sent mempool txids of ${address} that are not a list`);
    if (pending.length >= BLOCKBOOK_MAX_PAGE_SIZE) throw new PearlError('BACKEND_UNSUPPORTED', `${address} has ${BLOCKBOOK_MAX_PAGE_SIZE} or more mempool transactions, more than Blockbook lists`);
    if (others.length > 0) {
      const ours = new Set(chained.map((item) => item.txid));
      await Promise.all(others.map(async (_, i) => {
        const theirs = await ask(i, (other) => confirmedOf(other, address, after + 1, upTo.height));
        const missing = theirs.filter((item) => !ours.has(item.txid)).length;
        const extra = ours.size - (theirs.length - missing);
        if (missing > 0 || extra > 0) throw disagree(i, `lists ${theirs.length} confirmed transactions for ${address} from height ${after + 1} to ${upTo.height}, where the server lists ${ours.size}`);
      }));
    }
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

  return {
    network,
    client,
    getTip: tip,

    async getAddressActivity(address): Promise<AddressPayment[]> {
      return (await history(address)).filter((entry) => entry.received > 0n).map(({ txid, received, block }) => ({ txid, amount: received, block }));
    },

    async getTransaction(txid): Promise<ChainTransaction | null> {
      const upTo = await tip();
      const fetched = await fetchTx(txid);
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
      const reported = await client.sendTransaction(hex);
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
        if (spender === undefined || spender === '') return { status: 'spent', confirmed: true };
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

    async findUsed(addresses) {
      for (const address of addresses) addressOf(address);
      // Any server's word that an address was used is taken: a wrong yes only widens a scan.
      const sets = await Promise.all([usedBy(client, addresses), ...others.map((_, i) => ask(i, (other) => usedBy(other, addresses)))]);
      return addresses.filter((address) => sets.some((set) => set.has(address)));
    },

    async getActivitySince(watched, after) {
      const upTo = await tip();
      if (after.height > upTo.height) return null;
      const hash = after.height === upTo.height ? upTo.hash : await client.getBlockHash(after.height);
      if (hash !== after.hash) return null;
      await confirmAt(after.height, after.hash);
      const addresses = [...new Set(watched.map(addressOf))];
      const lists = await mapLimit(addresses, concurrency, (address) => touches(address, upTo, after.height));
      const activity = new Map<string, BlockRef | null>();
      for (const list of lists) for (const { txid, block } of list) activity.set(txid, block);
      return [...activity].map(([txid, block]) => ({ txid, block }));
    },
  };

  function safe(value: unknown, what: string): number {
    if (!Number.isSafeInteger(value) || (value as number) < 0) throw bad(`sent ${what} that is not a block height: ${JSON.stringify(value)}`);
    return value as number;
  }
}
