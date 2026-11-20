// What a wallet needs from the chain, beyond the invoice monitor's
// ChainClient: unspent outputs in the shape coin selection takes, balances,
// history, broadcast, a fee rate and the spend status of an output.
//
// Two backends are here. pearldBackend reads pearld's address index
// (searchrawtransactions), so pearld must run with --addrindex, which needs
// --txindex. That index holds Taproot addresses only (addrToKey,
// node/blockchain/indexers/addrindex.go), so a P2MR address is found by
// matching the compact filter of every block instead. oysterBackend reads Oyster's own wallet (listunspent and
// friends) and so only knows the wallet's addresses. The interface asks for
// nothing either server has that a compact-filter scanner (backend-filters.ts)
// or another indexer could not also answer: every query is by address or
// output script.

/**
 * Wallet backends: what a wallet needs from the chain, answered by pearld's
 * address index or by an Oyster wallet.
 *
 * @module
 */

import { decodeAddress, fromOutputScript, toOutputScript } from './address.js';
import type { AddressPayment, BlockRef, ChainClient, ChainTransaction } from './client.js';
import type { Utxo } from './coinselect.js';
import { matchAnyFilter } from './gcs.js';
import type { PearlNetwork } from './networks.js';
import {
  OysterRpc,
  PearlRpcError,
  PearldRpc,
  RPC_ERROR_CODES,
  isLimitedUserRefusal,
  isUnknownTransaction,
  paidTo,
  pearldChainClient,
  searchAllTransactions,
} from './rpc.js';
import { toHex } from './internal/bytes.js';
import { fetchBlockFilters, mapLimit } from './internal/filter-scan.js';
import type { ChainPoint } from './internal/filter-scan.js';
import { safeHeight } from './internal/rpc-wire.js';
import type { OutPointParam, Rpc, SearchRawTransactionsResult, TxOutResult, WalletTransactionEntry } from './rpc.js';
import { PearlError } from './errors.js';
import { parseTransaction } from './transaction.js';
import type { FeeRate } from './amount.js';

/** An address, or the output script of one. */
export type Watched = string | Uint8Array;

/** An unspent output as coin selection takes it, with the fields a backend always knows. */
export interface WalletUtxo extends Utxo {
  address: string;
  /** 0 while the output is in the mempool. */
  confirmations: number;
  coinbase: boolean;
}

/** A balance in grain, split by how spendable it is. */
export interface WalletBalance {
  /** Outputs in a block, coinbase outputs once mature. */
  confirmed: bigint;
  /** Outputs of mempool transactions, the wallet's own change included. */
  unconfirmed: bigint;
  /** Coinbase outputs short of the network's maturity. */
  immature: bigint;
}

/** One transaction in the history of an address. */
export interface AddressHistoryEntry {
  txid: string;
  /** Confirming block, or null while in the mempool. */
  block: BlockRef | null;
  /** Grains the transaction pays to the address. */
  received: bigint;
  /** Grains of the address's outputs the transaction spends. Left out by a backend that cannot tell, as Oyster cannot. */
  spent?: bigint;
}

/** What a backend knows about one output: unspent, spent, or unknown. */
export type SpendStatus =
  | { status: 'unspent'; confirmations: number }
  /** `spender` is left out when the backend knows the output is gone but not where it went. */
  | { status: 'spent'; spender?: string; confirmed: boolean }
  /** The backend has never seen the output, or cannot look. */
  | { status: 'unknown' };

/**
 * A chain view for wallets. It is also a ChainClient, so one backend serves
 * the invoice monitor too.
 */
export interface WalletBackend extends ChainClient {
  readonly network: PearlNetwork;
  /**
   * Unspent outputs paying any of these, unconfirmed and immature ones
   * included; spendableUtxos filters them. An output a mempool transaction
   * spends is left out.
   */
  getUtxos(watched: readonly Watched[]): Promise<WalletUtxo[]>;
  /** Confirmed, unconfirmed and immature grain held by these addresses or scripts. */
  getBalance(watched: readonly Watched[]): Promise<WalletBalance>;
  /** Transactions paying or spending from one address, confirmed ones first. */
  getHistory(watched: Watched): Promise<AddressHistoryEntry[]>;
  /** Sends a signed transaction and returns its txid. */
  broadcast(tx: string | Uint8Array): Promise<string>;
  /**
   * True when a refusal from broadcast proves the transaction reached no
   * mempool, as from a node of your own. Otherwise a wallet keeps a refused
   * send recorded, its coins taken, since a server can relay a transaction
   * and still answer that it refused it.
   */
  readonly broadcastRefusalsFinal?: boolean;
  /** Grain per 1000 vbytes to confirm within `blocks`, never under the relay fee. */
  estimateFeeRate(blocks?: number): Promise<FeeRate>;
  /**
   * Whether an output is unspent, spent (and by which transaction, when known),
   * or unknown to the backend.
   */
  getSpendStatus(outpoint: OutPointParam): Promise<SpendStatus>;
  /**
   * Which of these addresses have ever been paid, when the backend can answer for many at once. Discovery falls back to getAddressActivity.
   * `accounts` says which of them are BIP86 account addresses and where they sit, for a backend that can ask about an account as a whole.
   */
  findUsed?(addresses: readonly string[], accounts?: readonly AccountAddresses[]): Promise<string[]>;
  /**
   * Where the history of these addresses can begin, for a backend that scans
   * blocks for some addresses and can start later than its own first block.
   * null forgets a birth given earlier. A backend without this method scans
   * as it always does.
   */
  setAddressBirths?(births: ReadonlyMap<string, AddressBirth | null>): void;
}

/** The first block that can pay an address, as the wallet that made the address knows it. */
export interface AddressBirth {
  /** The lowest height that can hold a transaction paying the address. */
  readonly height: number;
  /**
   * The hash of the block at height - 1 when the wallet saw it. The birth
   * holds only while that block is on the best chain. Left out when the
   * height is the caller's word, which nothing checks.
   */
  readonly parent?: string;
}

/** Addresses of one BIP86 account and where each sits, given to a backend that can ask about the account by its key. */
export interface AccountAddresses {
  /** The account's extended public key. */
  readonly xpub: string;
  /** The account's addresses among those asked about: whether each is on the change chain, and its index. */
  readonly children: ReadonlyMap<string, { readonly change: boolean; readonly index: number }>;
  /** Unused addresses in a row past the last used one that the caller scans. */
  readonly gap: number;
}

/**
 * A backend that is also the source of full transactions a wallet needs:
 * one object for PearlWallet's `backend` and `transactions`, and, being a
 * ChainClient, for the invoice monitor. pearldBackend, oysterBackend and
 * filterBackend each return one.
 */
export interface WalletChain extends WalletBackend {
  /** The serialized transaction, or null when the backend cannot find it. */
  getRawTransaction(txid: string): Promise<string | null>;
}

/** pearld was asked for something only an index it runs without can answer. */
export class MissingIndexError extends PearlError {
  override name = 'MissingIndexError';
  readonly index: 'addrindex' | 'txindex';

  constructor(index: 'addrindex' | 'txindex', cause: PearlRpcError) {
    super(
      'BACKEND_MISSING_INDEX',
      index === 'addrindex'
        ? `this backend needs pearld's address index; start pearld with --addrindex (${cause.message})`
        : `this backend needs pearld's transaction index; start pearld with --txindex or --addrindex (${cause.message})`,
      { cause },
    );
    this.index = index;
  }
}

/**
 * The server will not do this for these credentials or in this mode: a
 * method pearld refuses its limited RPC user, or a raw broadcast through an
 * Oyster in SPV mode. `method` names the RPC method refused.
 */
export class UnsupportedMethodError extends PearlError {
  override name = 'UnsupportedMethodError';
  readonly method: string;

  constructor(method: string, message: string, cause?: unknown) {
    super('BACKEND_UNSUPPORTED', message, cause === undefined ? undefined : { cause });
    this.method = method;
  }
}

/** What a pearld endpoint lets a set of credentials do, as probePearld finds it. */
export interface PearldCapabilities {
  /** The credentials are pearld's limited RPC user (--rpclimituser). */
  readonly limited: boolean;
  /** sendrawtransaction is allowed. The limited user may not broadcast. */
  readonly broadcast: boolean;
  /** gettxspendingprevout is allowed, so a mempool spend is found by outpoint. Not for the limited user. */
  readonly mempoolSpends: boolean;
  /** getrawmempool is allowed, so mempool transactions can be seen at all. */
  readonly mempool: boolean;
  /** pearld runs with --addrindex: pearldBackend works. */
  readonly addrIndex: boolean;
  /** pearld runs with --txindex (which --addrindex turns on): getrawtransaction finds confirmed transactions. */
  readonly txIndex: boolean;
  /** pearld keeps its compact filter index (on unless --nocfilters): filterBackend works. */
  readonly cfIndex: boolean;
  /** The backend this endpoint serves best: pearldBackend with the address index, filterBackend with only filters, or neither. */
  readonly backend: 'pearld' | 'filters' | null;
}

/**
 * Finds out what a pearld endpoint allows with the credentials `rpc`
 * carries and which indexes it keeps, with eight calls that change nothing:
 * getbestblock, sendrawtransaction of an undecodable "00",
 * gettxspendingprevout of no outputs, getrawmempool, searchrawtransactions,
 * getcfilter and getblock of the tip, and getrawtransaction of the tip's
 * coinbase. On a chain of only the genesis block, whose coinbase no index
 * holds, `txIndex` follows `addrIndex`.
 */
export async function probePearld(rpc: Rpc): Promise<PearldCapabilities> {
  const node = new PearldRpc(rpc);
  // The error reply a call ends in, or null when it succeeds. Anything but an
  // error reply, such as an unreachable node, is thrown.
  const answer = async (run: () => Promise<unknown>): Promise<PearlRpcError | null> => {
    try {
      await run();
      return null;
    } catch (err) {
      if (err instanceof PearlRpcError && err.kind === 'rpc') return err;
      throw err;
    }
  };
  const best = await node.getBestBlock();
  const [send, spends, mempool, search, filter, coinbase] = await Promise.all([
    answer(() => node.sendRawTransaction('00')),
    answer(() => node.getTxSpendingPrevOut([])),
    answer(() => node.getRawMempool()),
    answer(() => node.searchRawTransactions('probe', { count: 1 })),
    answer(() => node.getCFilter(best.hash)),
    best.height === 0 ? Promise.resolve(undefined) : node.getBlock(best.hash).then((block) => answer(() => node.getRawTransactionHex(block.tx[0]!))),
  ]);
  const refused = [send, spends, mempool, search, filter, coinbase].some(isLimitedUserRefusal);
  const addrIndex = !(search !== null && search.message.includes('Address index must be enabled'));
  const cfIndex = !(filter !== null && filter.message.includes('CF index must be enabled'));
  return {
    limited: refused,
    broadcast: !isLimitedUserRefusal(send),
    mempoolSpends: !isLimitedUserRefusal(spends),
    mempool: !isLimitedUserRefusal(mempool),
    addrIndex,
    txIndex: coinbase === undefined ? addrIndex : coinbase === null,
    cfIndex,
    backend: addrIndex ? 'pearld' : cfIndex ? 'filters' : null,
  };
}

/** Splits unspent outputs into confirmed, unconfirmed and immature grains. */
export function sumBalance(utxos: readonly Utxo[], coinbaseMaturity: number): WalletBalance {
  const balance: WalletBalance = { confirmed: 0n, unconfirmed: 0n, immature: 0n };
  for (const utxo of utxos) {
    const confirmations = utxo.confirmations ?? 0;
    if (utxo.coinbase === true && confirmations < coinbaseMaturity) balance.immature += utxo.value;
    else if (confirmations >= 1) balance.confirmed += utxo.value;
    else balance.unconfirmed += utxo.value;
  }
  return balance;
}

export interface PearldBackendOptions {
  network: PearlNetwork;
  /** Transactions per searchrawtransactions request. Default 100. */
  pageSize?: number;
  /** Addresses queried at once, and blocks of the P2MR filter walk. Default 8; a client made with `batch` sends them in one request. */
  concurrency?: number;
  /**
   * The height the filter scan for P2MR addresses starts at: the block a
   * wallet's first P2MR address was made in, when known. 0 unless given.
   */
  scanFrom?: number;
  /**
   * Where broadcast sends transactions instead of `rpc`: a pearld endpoint
   * with full credentials, or a proxy that forwards sendrawtransaction to
   * one. Needed when `rpc` carries pearld's limited user, which may not
   * broadcast.
   */
  broadcast?: Rpc;
}

// The fields of a transaction the backend reads, from the address index or from a block.
type FoundTx = Pick<SearchRawTransactionsResult, 'txid' | 'vin' | 'vout' | 'blockhash' | 'blocktime' | 'confirmations'>;

// What a filter scan for one address has found up to a block.
interface FilterScan {
  /** The first height the scan looked at. */
  from: number;
  height: number;
  hash: string;
  found: Map<string, FoundTx & { height: number }>;
  outpoints: Set<string>;
}

// An address in a round of the shared filter walk.
interface Member {
  address: string;
  script: Uint8Array;
  state: FilterScan;
}

// What a scan returns: confirmed transactions with their heights, then the mempool's.
type Scanned = (FoundTx & { height?: number })[];

interface Caller {
  resolve(found: Scanned): void;
  reject(err: unknown): void;
}

// Blocks walked between looks at who else wants the walk, and the most
// filters held at once.
const SCAN_CHUNK = 1000;

// Whether the transaction pays the address or spends an output it was paid
// in an earlier block, recording the outputs it pays.
function touches(address: string, state: FilterScan, tx: FoundTx): boolean {
  let pays = false;
  for (const out of tx.vout) {
    if (out.scriptPubKey.address !== address) continue;
    state.outpoints.add(`${tx.txid}:${out.n}`);
    pays = true;
  }
  return pays || tx.vin.some((input) => 'txid' in input && state.outpoints.has(`${input.txid}:${input.vout}`));
}

// The address's transactions as of the tip: those the walk found, then the
// mempool's, which are looked at every time and never kept.
function collect(address: string, state: FilterScan, tip: BlockRef, mempool: readonly (FoundTx | null)[]): Scanned {
  const result: Scanned = [...state.found.values()].map((tx) => ({ ...tx, confirmations: tip.height - tx.height + 1 }));
  // Twice over, so a spend listed before the payment it spends is seen.
  const pending = new Map<string, FoundTx>();
  for (let pass = 0; pass < 2; pass += 1) {
    for (const tx of mempool) {
      if (tx === null || state.found.has(tx.txid) || (tx.blockhash !== undefined && tx.blockhash !== '')) continue;
      if (touches(address, state, tx)) pending.set(tx.txid, { txid: tx.txid, vin: tx.vin, vout: tx.vout });
    }
  }
  // Mempool outputs are not the next scan's to remember.
  for (const tx of pending.values()) for (const out of tx.vout) state.outpoints.delete(`${tx.txid}:${out.n}`);
  return [...result, ...pending.values()];
}

/**
 * A wallet backend over pearld, from a PearldClient, a PearlWsClient or
 * anything else with `call`. pearld must run with --addrindex (which turns
 * --txindex on); without it every address query fails with a
 * MissingIndexError. The address index covers P2TR addresses. For P2MR
 * addresses the backend walks the compact filters of the blocks from
 * `scanFrom` in one walk for all the P2MR addresses it has been asked about
 * or given a birth for, and reads the blocks that match, which needs
 * pearld's filter index (on unless --nocfilters) and takes three requests a
 * block; later queries go on from where the walk ended. An address given a birth with
 * setAddressBirths is scanned from the later of `scanFrom` and its birth,
 * while the birth's parent block, when it names one, is on the best chain.
 */
export function pearldBackend(rpc: Rpc, options: PearldBackendOptions): WalletChain {
  const { network, pageSize = 100, concurrency = 8, scanFrom = 0 } = options;
  if (!Number.isSafeInteger(scanFrom) || scanFrom < 0) throw new RangeError('scanFrom must be a block height');
  const node = new PearldRpc(rpc);
  const sender = options.broadcast === undefined ? node : new PearldRpc(options.broadcast);
  const mempoolSpender = mempoolSpends(node);
  const chain = pearldChainClient(node, { pageSize });
  const scans = new Map<string, FilterScan>();
  const births = new Map<string, AddressBirth>();
  // Every address the walk covers: those asked about and those given a birth.
  const walked = new Set<string>();
  let waiting = new Map<string, Caller[]>();
  let walking = false;

  // The block a new scan for the address goes on from: the birth's parent
  // while that block is on the best chain, else the block before scanFrom.
  const startOf = async (address: string, tip: BlockRef, hashAt: (height: number) => Promise<string>): Promise<{ height: number; hash: string }> => {
    const birth = births.get(address);
    const fallback = { height: scanFrom - 1, hash: '' };
    if (birth === undefined || birth.height <= scanFrom) return fallback;
    if (birth.parent === undefined) return { height: birth.height - 1, hash: '' };
    // A chain without the parent may hold a payment anywhere after where it forked.
    if (birth.height - 1 > tip.height || (await hashAt(birth.height - 1)) !== birth.parent) return fallback;
    return { height: birth.height - 1, hash: birth.parent };
  };

  // Where the address's scan goes on from this round: its last block, or its start again.
  const prepare = async (address: string, tip: BlockRef, hashAt: (height: number) => Promise<string>): Promise<Member> => {
    let state = scans.get(address);
    // A reorganization under the block the last scan ended at: start over.
    if (state !== undefined && (state.height > tip.height || (await hashAt(state.height)) !== state.hash)) state = undefined;
    // A birth moved below where the scan began: the blocks between were never looked at.
    if (state !== undefined && state.from > Math.max(scanFrom, births.get(address)?.height ?? 0)) state = undefined;
    if (state === undefined) {
      const start = await startOf(address, tip, hashAt);
      state = { from: start.height + 1, ...start, found: new Map(), outpoints: new Set() };
    }
    return { address, script: toOutputScript(address, network), state };
  };

  // Matches each block's filter once against every member at or past its
  // start, lowest first, and fetches a block once however many it touches.
  // Addresses asked about meanwhile join at the next chunk. Each caller gets
  // its address's transactions as of the round's tip and mempool.
  const walk = async (): Promise<void> => {
    const members = new Map<string, Member>();
    const callers = new Map<string, Caller[]>();
    const join = (): string[] => {
      const joining = waiting;
      waiting = new Map();
      for (const [address, list] of joining) callers.set(address, [...(callers.get(address) ?? []), ...list]);
      return [...walked].filter((address) => !members.has(address));
    };
    let fresh = join();
    try {
      const tip = await chain.getTip();
      const hashes = new Map<number, Promise<string>>();
      const hashAt = (height: number): Promise<string> => {
        let hash = hashes.get(height);
        if (hash === undefined) hashes.set(height, (hash = node.getBlockHash(height)));
        return hash;
      };
      let carried: ChainPoint | null = null;
      for (;;) {
        if (fresh.length > 0) {
          for (const member of await mapLimit(fresh, concurrency, (address) => prepare(address, tip, hashAt))) members.set(member.address, member);
          fresh = [];
        }
        if (waiting.size > 0) {
          fresh = join();
          continue;
        }
        const behind = [...members.values()].filter((member) => member.state.height < tip.height);
        if (behind.length === 0) break;
        const low = Math.min(...behind.map((member) => member.state.height));
        const group = behind.filter((member) => member.state.height === low);
        const to = Math.min(tip.height, low + SCAN_CHUNK, ...behind.filter((member) => member.state.height > low).map((member) => member.state.height));
        const hash = group.find((member) => member.state.hash !== '')?.state.hash ?? '';
        const from: ChainPoint = carried !== null && carried.height === low && (hash === '' || hash === carried.hash) ? carried : { height: low, hash };
        const filters = await fetchBlockFilters(node, network, from, to, concurrency);
        const scripts = group.map((member) => member.script);
        const matched = filters.filter(({ filter, key }) => filter.n > 0 && matchAnyFilter(filter, key, scripts));
        for (let i = 0; i < matched.length; i += concurrency) {
          const slice = matched.slice(i, i + concurrency);
          const blocks = await Promise.all(slice.map(({ hash: block }) => node.getBlockWithTransactions(block)));
          blocks.forEach((block, j) => {
            const { height, hash: blockhash } = slice[j]!;
            for (const tx of block.rawtx) {
              for (const { address, state } of group) {
                if (touches(address, state, tx)) state.found.set(tx.txid, { txid: tx.txid, vin: tx.vin, vout: tx.vout, blockhash, height, ...(tx.blocktime === undefined ? {} : { blocktime: tx.blocktime }) });
              }
            }
          });
        }
        const last = filters.at(-1)!;
        carried = { height: last.height, hash: last.hash, blockHeader: last.header };
        for (const member of group) {
          member.state.height = last.height;
          member.state.hash = last.hash;
          scans.set(member.address, member.state);
        }
      }
      const mempool = await mapLimit(await node.getRawMempool(), concurrency, (txid) => node.getRawTransaction(txid).catch(() => null));
      for (const [address, list] of callers) {
        const { state } = members.get(address)!;
        if (state.hash !== '') scans.set(address, state);
        for (const caller of list) caller.resolve(collect(address, state, tip, mempool));
      }
    } catch (err) {
      for (const list of callers.values()) for (const caller of list) caller.reject(err);
    } finally {
      walking = false;
      if (waiting.size > 0) {
        walking = true;
        void walk();
      }
    }
  };

  // Every transaction paying or spending from an address pearld's index does not hold, mempool included.
  const scan = (address: string): Promise<Scanned> => {
    toOutputScript(address, network);
    walked.add(address);
    return new Promise((resolve, reject) => {
      waiting.set(address, [...(waiting.get(address) ?? []), { resolve, reject }]);
      if (!walking) {
        walking = true;
        void walk();
      }
    });
  };

  const search = (address: string): Promise<FoundTx[]> =>
    decodeAddress(address, network).version === 1 ? indexed(() => searchAllTransactions(node, address, { pageSize })) : scan(address);

  const getUtxos = async (watched: readonly Watched[]): Promise<WalletUtxo[]> => {
    const addresses = [...new Set(watched.map((item) => addressOf(item, network)))];
    // Every transaction touching an address is in its list, the ones
    // spending its outputs included, so the unspent ones are those no input
    // here refers to. Mempool transactions are in the lists too.
    const transactions = new Map<string, FoundTx>();
    // Every scanned address joins the walk at once, so one walk serves them all.
    const lists = new Map<string, FoundTx[]>();
    const listed = addresses.filter((address) => decodeAddress(address, network).version === 1);
    await Promise.all([
      ...addresses.filter((address) => !listed.includes(address)).map(async (address) => lists.set(address, await scan(address))),
      mapLimit(listed, concurrency, async (address) => lists.set(address, await search(address))),
    ]);
    for (const list of addresses.map((address) => lists.get(address)!)) {
      for (const tx of list) transactions.set(tx.txid, tx);
    }
    const spent = new Set<string>();
    for (const tx of transactions.values()) {
      for (const input of tx.vin) if ('txid' in input) spent.add(`${input.txid}:${input.vout}`);
    }
    const wanted = new Set(addresses);
    const utxos: WalletUtxo[] = [];
    for (const tx of transactions.values()) {
      const confirmations = tx.confirmations ?? 0;
      if (!Number.isSafeInteger(confirmations) || confirmations < 0) {
        throw new PearlRpcError('response', 'searchrawtransactions', `transaction ${tx.txid} has no valid confirmation count`);
      }
      const coinbase = tx.vin[0] !== undefined && 'coinbase' in tx.vin[0];
      for (const out of tx.vout) {
        const address = out.scriptPubKey.address;
        if (address === undefined || !wanted.has(address) || spent.has(`${tx.txid}:${out.n}`)) continue;
        utxos.push({
          txid: tx.txid,
          vout: out.n,
          value: grains(out.value, 'searchrawtransactions'),
          script: toOutputScript(address, network),
          address,
          confirmations,
          coinbase,
        });
      }
    }
    return utxos;
  };

  const spenderOf = async (txid: string, vout: number): Promise<SpendStatus> => {
    // gettxout says nothing of an output a block has spent, so the
    // transaction index says whether it ever existed, and the address index
    // which transaction spent it.
    let address: string | undefined;
    try {
      const out = (await indexed(() => node.getRawTransaction(txid))).vout[vout];
      if (out === undefined) return { status: 'unknown' };
      address = out.scriptPubKey.address;
    } catch (err) {
      if (isUnknownTransaction(err)) return { status: 'unknown' };
      throw err;
    }
    if (address !== undefined) {
      for (const tx of await search(address)) {
        if (tx.vin.some((input) => 'txid' in input && input.txid === txid && input.vout === vout)) {
          return { status: 'spent', spender: tx.txid, confirmed: tx.blockhash !== undefined && tx.blockhash !== '' };
        }
      }
    }
    return { status: 'spent', confirmed: true };
  };

  // Without gettxspendingprevout, as for the limited user, the address's
  // transactions show a mempool spend, since they include the mempool.
  const listedSpender = async (txid: string, vout: number, out: TxOutResult): Promise<string | null> => {
    const address = out.scriptPubKey.address;
    if (address === undefined) return null;
    const spender = (await search(address)).find((tx) => tx.vin.some((input) => 'txid' in input && input.txid === txid && input.vout === vout));
    return spender?.txid ?? null;
  };

  return {
    network,
    broadcastRefusalsFinal: true,
    getTip: () => chain.getTip(),
    async getAddressActivity(address) {
      if (decodeAddress(address, network).version === 1) return indexed(() => chain.getAddressActivity(address));
      const payments: AddressPayment[] = [];
      for (const tx of await scan(address)) {
        const amount = paidTo(tx, address);
        if (amount === 0n) continue;
        if (tx.blockhash === undefined) {
          payments.push({ txid: tx.txid, amount, block: null });
          continue;
        }
        const height = tx.height!;
        // The header time lets an invoice judge expiry by the block, as the indexed path does.
        const time = tx.blocktime === undefined || tx.blocktime === 0 ? {} : { time: tx.blocktime };
        payments.push({ txid: tx.txid, amount, block: { height, hash: tx.blockhash, ...time } });
      }
      return payments;
    },
    getTransaction: (txid) => indexed(() => chain.getTransaction(txid)),
    getUtxos,

    async getBalance(watched) {
      return sumBalance(await getUtxos(watched), network.coinbaseMaturity);
    },

    async getHistory(watched) {
      const address = addressOf(watched, network);
      const transactions = await search(address);
      const own = new Map<string, bigint>();
      for (const tx of transactions) {
        for (const out of tx.vout) {
          if (out.scriptPubKey.address === address) own.set(`${tx.txid}:${out.n}`, grains(out.value, 'searchrawtransactions'));
        }
      }
      const heights = new Map<string, number>();
      const history: AddressHistoryEntry[] = [];
      for (const tx of transactions) {
        const received = paidTo(tx, address);
        let spent = 0n;
        for (const input of tx.vin) if ('txid' in input) spent += own.get(`${input.txid}:${input.vout}`) ?? 0n;
        if (received === 0n && spent === 0n) continue;
        let block: BlockRef | null = null;
        if (tx.blockhash !== undefined && tx.blockhash !== '') {
          let height = heights.get(tx.blockhash);
          if (height === undefined) {
            height = safeHeight((await node.getBlockHeader(tx.blockhash)).height, 'getblockheader');
            heights.set(tx.blockhash, height);
          }
          block = { height, hash: tx.blockhash };
        }
        history.push({ txid: tx.txid, block, received, spent });
      }
      return history;
    },

    broadcast: (tx) => sendRaw(sender, tx),

    async estimateFeeRate(blocks = 6) {
      const floor = grains((await node.getInfo()).relayfee, 'getinfo');
      return maxRate(await estimateOrZero(node, blocks), floor);
    },

    getSpendStatus: (outpoint) => nodeSpendStatus(node, outpoint, mempoolSpender, spenderOf, listedSpender),

    // Confirmed transactions need --txindex, which --addrindex turns on.
    getRawTransaction: (txid) => rawOrNull(node, txid),

    setAddressBirths(entries) {
      for (const [address, birth] of entries) {
        if (birth === null) {
          births.delete(address);
          continue;
        }
        if (!Number.isSafeInteger(birth.height) || birth.height < 0) throw new RangeError('a birth height must be a block height');
        births.set(address, { height: birth.height, ...(birth.parent === undefined ? {} : { parent: birth.parent }) });
      }
      // The caller will ask about these, so the walk takes them along from the next query on.
      for (const address of entries.keys()) {
        try {
          if (decodeAddress(address, network).version !== 1) walked.add(address);
        } catch {
          // Not an address of this network: a query for it fails as before.
        }
      }
    },
  };
}

/** txrules.DefaultRelayFeePerKb, the rate Oyster falls back to (wallet/wallet/txrules/rules.go:19). */
export const OYSTER_DEFAULT_FEE_RATE = 1000n;

export interface OysterBackendOptions {
  network: PearlNetwork;
}

/**
 * A wallet backend over Oyster, from an OysterClient or anything else with
 * `call`. It answers for the wallet's own addresses only, from what Oyster
 * has processed, which can trail the node. listunspent leaves out outputs
 * locked with lockunspent, so they count in no balance here. Oyster lists
 * no receive for change it pays itself; getHistory and getAddressActivity
 * read what such a transaction paid the address from the transaction.
 *
 * Broadcast, fee estimates and the spend status of outputs the wallet does
 * not hold go through Oyster to its pearld, which needs Oyster connected to
 * one over RPC. In SPV mode, as Pearl's desktop wallet runs it, broadcast
 * fails (send with sendMany), the fee rate is Oyster's default and the
 * status of such outputs is "unknown".
 */
export function oysterBackend(rpc: Rpc, options: OysterBackendOptions): WalletChain {
  const { network } = options;
  const wallet = new OysterRpc(rpc);
  const node = new PearldRpc(rpc);
  const mempoolSpender = mempoolSpends(node);

  const getTip = async (): Promise<BlockRef> => {
    const best = await wallet.getBestBlock();
    return { height: safeHeight(best.height, 'getbestblock'), hash: best.hash };
  };

  // Oyster reports confirmations, not heights, counted from the block it has
  // processed up to.
  const blockOf = (entry: { blockhash?: string; blocktime?: number; confirmations: number }, tip: BlockRef, method: string): BlockRef | null => {
    if (entry.blockhash === undefined || entry.blockhash === '') return null;
    const block = { height: safeHeight(tip.height - entry.confirmations + 1, method), hash: entry.blockhash };
    return entry.blocktime === undefined || entry.blocktime === 0 ? block : { ...block, time: entry.blocktime };
  };

  const received = (entries: readonly WalletTransactionEntry[], address: string): Map<string, WalletTransactionEntry & { total: bigint }> => {
    const byTxid = new Map<string, WalletTransactionEntry & { total: bigint }>();
    for (const entry of entries) {
      if (entry.category === 'send' || entry.address !== address) continue;
      const amount = grains(entry.amount, 'listaddresstransactions');
      const seen = byTxid.get(entry.txid);
      if (seen === undefined) byTxid.set(entry.txid, { ...entry, total: amount });
      else seen.total += amount;
    }
    return byTxid;
  };

  const payments = async (address: string): Promise<AddressPayment[]> => {
    const [tip, entries] = await Promise.all([getTip(), wallet.listAddressTransactions([address])]);
    const paid = received(entries, address);
    // Oyster lists a payment to the wallet's own change as nothing but the
    // send, so what such a transaction paid the address is read from the
    // transaction itself.
    const script = toHex(toOutputScript(address, network));
    for (const entry of entries) {
      if (paid.has(entry.txid)) continue;
      const tx = parseTransaction((await wallet.getTransaction(entry.txid)).hex);
      const total = tx.outs.reduce((sum, out) => (toHex(out.script) === script ? sum + out.value : sum), 0n);
      if (total > 0n) paid.set(entry.txid, { ...entry, total });
    }
    return [...paid.values()].map((entry) => ({
      txid: entry.txid,
      amount: entry.total,
      block: blockOf(entry, tip, 'listaddresstransactions'),
    }));
  };

  const getUtxos = async (watched: readonly Watched[]): Promise<WalletUtxo[]> => {
    const wanted = new Set(watched.map((item) => addressOf(item, network)));
    const unspent = (await wallet.listUnspent(0)).filter((utxo) => wanted.has(utxo.address));
    if (unspent.length === 0) return [];
    // listunspent has no coinbase flag; the transaction list marks them.
    const generated = new Set((await wallet.listAllTransactions()).filter((entry) => entry.generated === true).map((entry) => entry.txid));
    return unspent.map((utxo) => {
      if (!Number.isSafeInteger(utxo.confirmations) || utxo.confirmations < 0) {
        throw new PearlRpcError('response', 'listunspent', `output ${utxo.txid}:${utxo.vout} has no valid confirmation count`);
      }
      return {
        txid: utxo.txid,
        vout: utxo.vout,
        value: grains(utxo.amount, 'listunspent'),
        script: toOutputScript(utxo.address, network),
        address: utxo.address,
        confirmations: utxo.confirmations,
        coinbase: generated.has(utxo.txid),
      };
    });
  };

  return {
    network,
    broadcastRefusalsFinal: true,
    getTip,
    getAddressActivity: payments,

    async getTransaction(txid): Promise<ChainTransaction | null> {
      try {
        const [tip, tx] = await Promise.all([getTip(), wallet.getTransaction(txid)]);
        return { txid: tx.txid, block: blockOf(tx, tip, 'gettransaction') };
      } catch (err) {
        if (isUnknownTransaction(err)) return null;
        throw err;
      }
    },

    getUtxos,

    async getBalance(watched) {
      const wanted = new Set(watched.map((item) => addressOf(item, network)));
      // Oyster holds immature coinbase outputs back from listunspent, so they are read from the transaction list.
      const [utxos, entries] = await Promise.all([getUtxos(watched), wallet.listAllTransactions()]);
      const balance = sumBalance(utxos, network.coinbaseMaturity);
      for (const entry of entries) {
        if (entry.category === 'immature' && entry.address !== undefined && wanted.has(entry.address)) {
          balance.immature += grains(entry.amount, 'listalltransactions');
        }
      }
      return balance;
    },

    async getHistory(watched) {
      return (await payments(addressOf(watched, network))).map(({ txid, amount, block }) => ({ txid, block, received: amount }));
    },

    async broadcast(tx) {
      try {
        return await node.sendRawTransaction(tx);
      } catch (err) {
        if (!isChainInactive(err)) throw err;
        throw new UnsupportedMethodError(
          'sendrawtransaction',
          'Oyster has no RPC connection to a pearld (SPV mode), so it cannot broadcast a raw transaction; send with sendMany instead',
          err,
        );
      }
    },

    async estimateFeeRate(blocks = 6) {
      try {
        return maxRate(await estimateOrZero(node, blocks), OYSTER_DEFAULT_FEE_RATE);
      } catch (err) {
        if (isChainInactive(err)) return OYSTER_DEFAULT_FEE_RATE;
        throw err;
      }
    },

    async getSpendStatus(outpoint) {
      const held = (await wallet.listUnspent(0)).find((utxo) => utxo.txid === outpoint.txid && utxo.vout === outpoint.vout);
      if (held !== undefined) return { status: 'unspent', confirmations: held.confirmations };
      try {
        return await nodeSpendStatus(node, outpoint, mempoolSpender, async (txid, vout) => {
          // Spent in a block, if the node can show the output ever existed.
          try {
            return (await node.getRawTransaction(txid)).vout[vout] === undefined ? { status: 'unknown' } : { status: 'spent', confirmed: true };
          } catch (err) {
            if (err instanceof PearlRpcError && err.kind === 'rpc' && !isChainInactive(err)) return { status: 'unknown' };
            throw err;
          }
        });
      } catch (err) {
        if (isChainInactive(err)) return { status: 'unknown' };
        throw err;
      }
    },

    async getRawTransaction(txid) {
      try {
        return (await wallet.getTransaction(txid)).hex;
      } catch (err) {
        if (!isUnknownTransaction(err)) throw err;
      }
      // Not the wallet's: its pearld may have it, unless Oyster runs in SPV mode.
      try {
        return await rawOrNull(node, txid);
      } catch (err) {
        if (isChainInactive(err)) return null;
        throw err;
      }
    },

    async findUsed(addresses) {
      // Oyster selects the transactions paying an address, then lists a
      // payment to the wallet's own change as nothing but the send, so an
      // address is used when anything at all comes back for it alone.
      const lists = await mapLimit(addresses, 8, (address) => wallet.listAddressTransactions([address]));
      return addresses.filter((_, i) => lists[i]!.length > 0);
    },
  };
}

// The mempool spender first, since gettxout keeps reporting an output that
// only the mempool has spent; then gettxout; then whatever can tell a spent
// output from one that never existed. When pearld will not say which mempool
// transaction spends an output, `listed` looks elsewhere, or the output
// counts as unspent while gettxout has it.
async function nodeSpendStatus(
  node: PearldRpc,
  outpoint: OutPointParam,
  spends: MempoolSpender,
  gone: (txid: string, vout: number) => Promise<SpendStatus>,
  listed?: (txid: string, vout: number, out: TxOutResult) => Promise<string | null>,
): Promise<SpendStatus> {
  const { txid, vout } = outpoint;
  const [spender, out] = await Promise.all([spends(outpoint), node.getTxOut(txid, vout, true)]);
  if (spender !== null && spender !== undefined) return { status: 'spent', spender, confirmed: false };
  if (out !== null) {
    if (!Number.isSafeInteger(out.confirmations) || out.confirmations < 0) {
      throw new PearlRpcError('response', 'gettxout', `output ${txid}:${vout} has no valid confirmation count`);
    }
    const fallback = spender === undefined && listed !== undefined ? await listed(txid, vout, out) : null;
    if (fallback !== null) return { status: 'spent', spender: fallback, confirmed: false };
    return { status: 'unspent', confirmations: out.confirmations };
  }
  return gone(txid, vout);
}

// The mempool transaction spending an outpoint, null for none, or undefined
// when pearld will not say.
type MempoolSpender = (outpoint: OutPointParam) => Promise<string | null | undefined>;

// gettxspendingprevout until pearld refuses it to a limited user; then
// undefined without asking again.
function mempoolSpends(node: PearldRpc): MempoolSpender {
  let allowed = true;
  return async ({ txid, vout }) => {
    if (!allowed) return undefined;
    try {
      const spender = (await node.getTxSpendingPrevOut([{ txid, vout }]))[0]?.spendingtxid;
      return spender === undefined || spender === '' ? null : spender;
    } catch (err) {
      if (!isLimitedUserRefusal(err)) throw err;
      allowed = false;
      return undefined;
    }
  };
}

async function sendRaw(node: PearldRpc, tx: string | Uint8Array): Promise<string> {
  try {
    return await node.sendRawTransaction(tx);
  } catch (err) {
    if (!isLimitedUserRefusal(err)) throw err;
    throw new UnsupportedMethodError(
      'sendrawtransaction',
      "pearld refuses sendrawtransaction to its limited RPC user; broadcast through an endpoint with full credentials or a proxy that forwards the call, given as the backend's `broadcast` option",
      err,
    );
  }
}

async function rawOrNull(node: PearldRpc, txid: string): Promise<string | null> {
  try {
    return await node.getRawTransactionHex(txid);
  } catch (err) {
    if (isUnknownTransaction(err)) return null;
    throw err;
  }
}

// estimatefee, or 0 when pearld has no estimate yet: it answers code -1
// until it has connected three blocks, and when estimation is off.
async function estimateOrZero(node: PearldRpc, blocks: number): Promise<bigint> {
  try {
    return await node.estimateFee(blocks);
  } catch (err) {
    if (err instanceof PearlRpcError && err.kind === 'rpc' && err.rpcCode === RPC_ERROR_CODES.MISC && !isChainInactive(err)) return 0n;
    throw err;
  }
}

function maxRate(rate: bigint, floor: bigint): bigint {
  return rate > floor ? rate : floor;
}

function isChainInactive(err: unknown): boolean {
  return err instanceof PearlRpcError && err.kind === 'rpc' && err.message.includes('Chain RPC is inactive');
}

async function indexed<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof PearlRpcError && err.kind === 'rpc') {
      if (err.message.includes('Address index must be enabled')) throw new MissingIndexError('addrindex', err);
      if (/transaction index must be enabled/i.test(err.message)) throw new MissingIndexError('txindex', err);
    }
    throw err;
  }
}

function addressOf(watched: Watched, network: PearlNetwork): string {
  if (typeof watched !== 'string') return fromOutputScript(watched, network);
  // Decoding refuses an address of another network before any request is made.
  toOutputScript(watched, network);
  return watched;
}

// An amount from a reply, refused unless it is a count of grains.
function grains(value: unknown, method: string): bigint {
  if (typeof value !== 'bigint' || value < 0n) {
    throw new PearlRpcError('response', method, `expected an amount, got ${typeof value === 'bigint' ? value : JSON.stringify(value)}`);
  }
  return value;
}
