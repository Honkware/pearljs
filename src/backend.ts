// What a wallet needs from the chain, beyond the invoice monitor's
// ChainClient: unspent outputs in the shape coin selection takes, balances,
// history, broadcast, a fee rate and the spend status of an output.
//
// Two backends are here. pearldBackend reads pearld's address index
// (searchrawtransactions), so pearld must run with --addrindex, which needs
// --txindex. oysterBackend reads Oyster's own wallet (listunspent and
// friends) and so only knows the wallet's addresses. The interface asks for
// nothing either server has that a compact-filter scanner or a Blockbook
// client could not also answer: every query is by address or output script.

/**
 * Wallet backends: what a wallet needs from the chain, answered by pearld's
 * address index or by an Oyster wallet.
 *
 * @module
 */

import { fromOutputScript, toOutputScript } from './address.js';
import type { AddressPayment, BlockRef, ChainClient, ChainTransaction } from './client.js';
import type { Utxo } from './coinselect.js';
import type { PearlNetwork } from './networks.js';
import {
  OysterRpc,
  PearlRpcError,
  PearldRpc,
  RPC_ERROR_CODES,
  isUnknownTransaction,
  paidTo,
  pearldChainClient,
  safeHeight,
  searchAllTransactions,
} from './rpc.js';
import type { OutPointParam, Rpc, SearchRawTransactionsResult, WalletTransactionEntry } from './rpc.js';
import { PearlError } from './errors.js';
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
  /** Grain per 1000 vbytes to confirm within `blocks`, never under the relay fee. */
  estimateFeeRate(blocks?: number): Promise<FeeRate>;
  /**
   * Whether an output is unspent, spent (and by which transaction, when known),
   * or unknown to the backend.
   */
  getSpendStatus(outpoint: OutPointParam): Promise<SpendStatus>;
  /** Which of these addresses have ever been paid, when the backend can answer for many at once. Discovery falls back to getAddressActivity. */
  findUsed?(addresses: readonly string[]): Promise<string[]>;
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

/** Options for pearldBackend. */
export interface PearldBackendOptions {
  network: PearlNetwork;
  /** Transactions per searchrawtransactions request. Default 100. */
  pageSize?: number;
  /** Addresses queried at once. Default 8; a client made with `batch` sends them in one request. */
  concurrency?: number;
}

/**
 * A wallet backend over pearld, from a PearldClient, a PearlWsClient or
 * anything else with `call`. pearld must run with --addrindex (which turns
 * --txindex on); without it every address query fails with a
 * MissingIndexError. The address index covers P2TR and P2MR outputs only,
 * which is every output Pearl relays.
 */
export function pearldBackend(rpc: Rpc, options: PearldBackendOptions): WalletBackend {
  const { network, pageSize = 100, concurrency = 8 } = options;
  const node = new PearldRpc(rpc);
  const chain = pearldChainClient(node, pageSize);
  const search = (address: string) => indexed(() => searchAllTransactions(node, address, { pageSize }));

  const getUtxos = async (watched: readonly Watched[]): Promise<WalletUtxo[]> => {
    const addresses = [...new Set(watched.map((item) => addressOf(item, network)))];
    // Every transaction touching an address is in its list, the ones
    // spending its outputs included, so the unspent ones are those no input
    // here refers to. Mempool transactions are in the lists too.
    const transactions = new Map<string, SearchRawTransactionsResult>();
    for (const list of await mapLimit(addresses, concurrency, search)) {
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

  return {
    network,
    getTip: () => chain.getTip(),
    getAddressActivity: (address) => indexed(() => chain.getAddressActivity(address)),
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

    broadcast: (tx) => node.sendRawTransaction(tx),

    async estimateFeeRate(blocks = 6) {
      const floor = grains((await node.getInfo()).relayfee, 'getinfo');
      return maxRate(await estimateOrZero(node, blocks), floor);
    },

    getSpendStatus: (outpoint) => nodeSpendStatus(node, outpoint, spenderOf),
  };
}

/** txrules.DefaultRelayFeePerKb, the rate Oyster falls back to (wallet/wallet/txrules/rules.go:19). */
export const OYSTER_DEFAULT_FEE_RATE = 1000n;

/** Options for oysterBackend. */
export interface OysterBackendOptions {
  network: PearlNetwork;
}

/**
 * A wallet backend over Oyster, from an OysterClient or anything else with
 * `call`. It answers for the wallet's own addresses only, from what Oyster
 * has processed, which can trail the node. listunspent leaves out outputs
 * locked with lockunspent, so they count in no balance here, and Oyster
 * lists no receive for change it pays itself, so getHistory and
 * getAddressActivity show a change address only what others paid it.
 *
 * Broadcast, fee estimates and the spend status of outputs the wallet does
 * not hold go through Oyster to its pearld, which needs Oyster connected to
 * one over RPC. In SPV mode, as Pearl's desktop wallet runs it, broadcast
 * fails (send with sendMany), the fee rate is Oyster's default and the
 * status of such outputs is "unknown".
 */
export function oysterBackend(rpc: Rpc, options: OysterBackendOptions): WalletBackend {
  const { network } = options;
  const wallet = new OysterRpc(rpc);
  const node = new PearldRpc(rpc);

  const getTip = async (): Promise<BlockRef> => {
    const best = await wallet.getBestBlock();
    return { height: safeHeight(best.height, 'getbestblock'), hash: best.hash };
  };

  // Oyster reports confirmations, not heights, counted from the block it has
  // processed up to.
  const blockOf = (entry: { blockhash?: string; confirmations: number }, tip: BlockRef, method: string): BlockRef | null => {
    if (entry.blockhash === undefined || entry.blockhash === '') return null;
    return { height: safeHeight(tip.height - entry.confirmations + 1, method), hash: entry.blockhash };
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
    return [...received(entries, address).values()].map((entry) => ({
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
        throw new PearlError('BACKEND_UNSUPPORTED', 'Oyster has no RPC connection to a pearld (SPV mode), so it cannot broadcast a raw transaction; send with sendMany instead', {
          cause: err,
        });
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
        return await nodeSpendStatus(node, outpoint, async (txid, vout) => {
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
// output from one that never existed.
async function nodeSpendStatus(
  node: PearldRpc,
  outpoint: OutPointParam,
  gone: (txid: string, vout: number) => Promise<SpendStatus>,
): Promise<SpendStatus> {
  const { txid, vout } = outpoint;
  const [spends, out] = await Promise.all([node.getTxSpendingPrevOut([{ txid, vout }]), node.getTxOut(txid, vout, true)]);
  const spender = spends[0]?.spendingtxid;
  if (spender !== undefined && spender !== '') return { status: 'spent', spender, confirmed: false };
  if (out !== null) {
    if (!Number.isSafeInteger(out.confirmations) || out.confirmations < 0) {
      throw new PearlRpcError('response', 'gettxout', `output ${txid}:${vout} has no valid confirmation count`);
    }
    return { status: 'unspent', confirmations: out.confirmations };
  }
  return gone(txid, vout);
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

async function mapLimit<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      results[i] = await run(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}
