// A client for a Blockbook indexer serving Pearl, as Pearl's team runs it
// (github.com/pearl-research-labs/blockbook, branches feat/pearl-coin-support
// and feat/pearl-fp8-testnet): the REST API v2 and the websocket API.
//
// The response shapes follow the fork's Go structs at commit 81f52f21
// (feat/pearl-coin-support; feat/pearl-fp8-testnet at 6d736fc6 does not
// differ in them): api/types.go (Tx, Vin, Vout, Address, Utxo, BalanceHistory,
// Block, BlockInfo, SystemInfo, BlockbookInfo, MempoolTxids, Token),
// common/internalstate.go (BackendInfo), server/ws_types.go (WsReq, WsRes,
// WsInfoRes, WsNewBlock, WsEstimateFeeRes) and the handlers in
// server/public.go and server/websocket.go. Amounts there are big integers
// written as decimal strings of grain, and become bigint here.
//
// Everything a client returns is the server's word. backend-blockbook.ts is
// the wallet backend that checks what it can of it.

/**
 * A client for Pearl's Blockbook indexer: REST API v2 and the websocket API.
 *
 * @module
 */

import { decodeAddress } from './address.js';
import type { FeeRate } from './amount.js';
import { PearlError, PearlRpcError } from './errors.js';
import { toHex } from './internal/bytes.js';
import { decimalToGrain, isLoopback, parseJson, readBounded } from './internal/rpc-wire.js';
import type { PearlNetwork } from './networks.js';
import { DEFAULT_MAX_CONCURRENT_REQUESTS, DEFAULT_MAX_REPLY_SIZE, DEFAULT_RPC_TIMEOUT } from './rpc.js';
import type { RetryOptions, TxRawResult } from './rpc.js';
import type { ReconnectOptions } from './ws.js';

/** Most transactions or txids Blockbook returns in one page of an address (txsInAPI, server/public.go). */
export const BLOCKBOOK_MAX_PAGE_SIZE = 1000;
/** Most full transactions in one page when `details` is "txs" (txsDetailsInAPI). */
export const BLOCKBOOK_MAX_TXS_PAGE_SIZE = 100;
/** Items past which Blockbook stops paging an address's history (maxAccountHistoryPagingOffset). */
export const BLOCKBOOK_MAX_HISTORY_OFFSET = 100_000;

/** A transaction input as Blockbook shows it (api.Vin). */
export interface BlockbookVin {
  /** Left out for a coinbase input. */
  readonly txid?: string;
  /** Left out when 0, since Go omits a zero; read a missing one as 0 when txid is there. */
  readonly vout?: number;
  readonly sequence?: number;
  readonly n: number;
  readonly addresses?: readonly string[];
  readonly isAddress: boolean;
  /** Grains of the output it spends. */
  readonly value?: bigint;
  /** The signature script. */
  readonly hex?: string;
  readonly coinbase?: string;
}

/** A transaction output as Blockbook shows it (api.Vout). */
export interface BlockbookVout {
  readonly value?: bigint;
  readonly n: number;
  /** Set for a confirmed spend only; a mempool spend leaves it out. */
  readonly spent?: boolean;
  readonly spentTxId?: string;
  readonly spentIndex?: number;
  readonly spentHeight?: number;
  /** The output script. */
  readonly hex?: string;
  /** null where Go has a nil list. */
  readonly addresses: readonly string[] | null;
  readonly isAddress: boolean;
}

/** A transaction (api.Tx). */
export interface BlockbookTx {
  readonly txid: string;
  readonly version?: number;
  readonly lockTime?: number;
  readonly vin: readonly BlockbookVin[];
  readonly vout: readonly BlockbookVout[];
  readonly blockHash?: string;
  /** -1 while in the mempool. */
  readonly blockHeight: number;
  readonly confirmations: number;
  /** For a mempool transaction: blocks until a block confirms it, by its fee rate against the server's estimates. */
  readonly confirmationETABlocks?: number;
  /** confirmationETABlocks times the average block interval the server has seen. */
  readonly confirmationETASeconds?: number;
  /** Block time, or the time the mempool took it in. */
  readonly blockTime: number;
  readonly size?: number;
  readonly vsize?: number;
  /** Sum of the outputs, grains. */
  readonly value: bigint;
  readonly valueIn?: bigint;
  readonly fees?: bigint;
  /** The serialized transaction; left out of "txslight" pages. */
  readonly hex?: string;
  readonly rbf?: boolean;
  readonly coinSpecificData?: unknown;
}

/** Paging fields of an address, xpub or block reply (api.Paging); left out when 0. */
export interface BlockbookPaging {
  readonly page?: number;
  /** -1 when Blockbook does not know, as for a query with `from` or `to`. */
  readonly totalPages?: number;
  readonly itemsOnPage?: number;
}

/** An address derived from an xpub (api.Token of type "XPUBAddress"). */
export interface BlockbookXpubAddress {
  readonly type: string;
  readonly standard: string;
  /** The address. */
  readonly name: string;
  /** The derivation path from the master key, e.g. m/86'/808276'/0'/0/5. */
  readonly path?: string;
  readonly transfers: number;
  readonly decimals: number;
  readonly balance?: bigint;
  readonly totalReceived?: bigint;
  readonly totalSent?: bigint;
}

/** An address or xpub with its balance and a page of history (api.Address). */
export interface BlockbookAddress extends BlockbookPaging {
  readonly address: string;
  /** Confirmed balance, grains. */
  readonly balance: bigint;
  readonly totalReceived?: bigint;
  readonly totalSent?: bigint;
  /** Left out for details "basic". */
  readonly unconfirmedBalance?: bigint;
  readonly unconfirmedTxs: number;
  readonly unconfirmedSending?: bigint;
  readonly unconfirmedReceiving?: bigint;
  /** Confirmed transactions. */
  readonly txs: number;
  readonly transactions?: readonly BlockbookTx[];
  readonly txids?: readonly string[];
  /** For an xpub: its derived addresses. */
  readonly tokens?: readonly BlockbookXpubAddress[];
  readonly usedTokens?: number;
}

/** An unspent output (api.Utxo). */
export interface BlockbookUtxo {
  readonly txid: string;
  readonly vout: number;
  readonly value: bigint;
  /** Left out while in the mempool. */
  readonly height?: number;
  readonly confirmations: number;
  /** Set for an xpub's outputs. */
  readonly address?: string;
  readonly path?: string;
  readonly lockTime?: number;
  /**
   * Pearl's parser keeps Blockbook's default of 0 for the coinbase maturity
   * it checks against (BaseParser.MinimumCoinbaseConfirmations), so a
   * confirmed coinbase output never carries this flag.
   */
  readonly coinbase?: boolean;
}

/** One interval of an address's balance history (api.BalanceHistory). */
export interface BlockbookBalanceHistory {
  readonly time: number;
  readonly txs: number;
  readonly received: bigint;
  readonly sent: bigint;
  readonly sentToSelf: bigint;
  readonly rates?: Readonly<Record<string, number>>;
  readonly txid?: string;
}

/** A block with a page of its transactions (api.Block). */
export interface BlockbookBlock extends BlockbookPaging {
  readonly hash: string;
  readonly previousBlockHash?: string;
  readonly nextBlockHash?: string;
  readonly height: number;
  readonly confirmations: number;
  readonly size: number;
  readonly time?: number;
  readonly version: number | string;
  readonly merkleRoot: string;
  readonly nonce: string;
  readonly bits: string;
  readonly difficulty: string;
  readonly txCount: number;
  /** "txslight" transactions: no hex. */
  readonly txs?: readonly BlockbookTx[];
}

/** What GET /api/ reports (api.SystemInfo). */
export interface BlockbookStatus {
  readonly blockbook: {
    readonly coin: string;
    readonly network: string;
    readonly host: string;
    readonly version: string;
    readonly gitCommit: string;
    readonly buildTime: string;
    readonly syncMode: boolean;
    readonly initialSync: boolean;
    readonly inSync: boolean;
    readonly bestHeight: number;
    readonly lastBlockTime: string;
    readonly inSyncMempool: boolean;
    readonly lastMempoolTime: string;
    readonly mempoolSize: number;
    readonly decimals: number;
    readonly dbSize: number;
    readonly about: string;
  };
  /** The pearld behind it (common.BackendInfo); every field may be missing. */
  readonly backend: {
    readonly error?: string;
    /** getblockchaininfo's chain: "mainnet", "testnet", "testnet2", "regtest", "simnet" or "signet". */
    readonly chain?: string;
    readonly blocks?: number;
    readonly headers?: number;
    readonly bestBlockHash?: string;
    readonly difficulty?: string;
    readonly version?: string;
    readonly subversion?: string;
    readonly protocolVersion?: string;
    readonly warnings?: string;
  };
}

/** A page of the mempool (api.MempoolTxids). */
export interface BlockbookMempool extends BlockbookPaging {
  readonly mempool: readonly { readonly time: number; readonly txid: string }[];
  readonly mempoolSize: number;
}

/**
 * What an address or xpub query returns besides balances. An xpub's derived
 * addresses (`tokens`) come with "tokens" and every level after it, never
 * with "basic".
 */
export type BlockbookDetails = 'basic' | 'tokens' | 'tokenBalances' | 'txids' | 'txslight' | 'txs';

/** Query parameters of /api/v2/address and /api/v2/xpub. */
export interface BlockbookAddressQuery {
  /** From 1. Default 1. */
  readonly page?: number;
  /** Default and most 1000, or 100 for details "txs". */
  readonly pageSize?: number;
  /** Lowest block height of transactions to list. */
  readonly from?: number;
  /** Highest block height of transactions to list. Given, the mempool is left out. */
  readonly to?: number;
  /** Default "txids". */
  readonly details?: BlockbookDetails;
}

/** Query parameters of /api/v2/xpub. */
export interface BlockbookXpubQuery extends BlockbookAddressQuery {
  /** Which derived addresses to list: "nonzero" by default over REST. */
  readonly tokens?: 'derived' | 'used' | 'nonzero';
  /** Unused addresses derived past the last used one. */
  readonly gap?: number;
}

/** Options for BlockbookClient. */
export interface BlockbookClientOptions {
  /** The server's base URL, e.g. https://blockbook.example; paths such as api/v2/tx/ are taken from it. */
  readonly url: string | URL;
  /** The network the server must serve; checked before the first request that depends on it. */
  readonly network: PearlNetwork;
  /** Defaults to globalThis.fetch. */
  readonly fetch?: typeof fetch;
  /** Merged into every request. */
  readonly init?: RequestInit & Record<string, unknown>;
  /** Limit per request in ms, 0 for none. Default DEFAULT_RPC_TIMEOUT. */
  readonly timeout?: number;
  /** Retry reads after a network failure or an HTTP 429 or 5xx, as the RPC clients do. Off by default; broadcasts are never retried. */
  readonly retry?: boolean | number | RetryOptions;
  /** Requests in flight at once. Default DEFAULT_MAX_CONCURRENT_REQUESTS, 0 for no limit. */
  readonly maxConcurrentRequests?: number;
  /** Replies longer than this many bytes fail with kind "response". Default DEFAULT_MAX_REPLY_SIZE. */
  readonly maxReplySize?: number;
  /**
   * Plain http:// lets anyone on the path read and rewrite every reply,
   * broadcasts included, so it is refused for any host but loopback unless
   * this is set.
   */
  readonly allowInsecureHttp?: boolean;
}

// Fields Blockbook writes as api.Amount: big integers in a JSON string.
const AMOUNT_KEYS = new Set([
  'value', 'valueIn', 'fees', 'balance', 'totalReceived', 'totalSent', 'unconfirmedBalance',
  'unconfirmedSending', 'unconfirmedReceiving', 'received', 'sent', 'sentToSelf',
]);
const TXID_RE = /^[0-9a-f]{64}$/;
const HEX_RE = /^(?:[0-9a-f]{2})*$/i;

/**
 * Blockbook's JSON with every api.Amount as bigint grain. A field under one
 * of those names that is not a decimal integer string is refused.
 */
export function parseBlockbookJson(text: string): unknown {
  return JSON.parse(text, (key, value: unknown) => {
    if (!AMOUNT_KEYS.has(key) || typeof value !== 'string') return value;
    if (!/^-?\d+$/.test(value)) throw new SyntaxError(`"${key}" is not an amount: ${JSON.stringify(value.slice(0, 40))}`);
    return BigInt(value);
  });
}

/**
 * Whether a Blockbook error is its answer that a transaction, block or
 * address is not there, as opposed to a failure.
 */
export function isBlockbookNotFound(err: unknown): boolean {
  return err instanceof PearlRpcError && err.kind === 'rpc' && /^[^:]+: (?:Transaction '[^']*' not found|Block not found)/.test(err.message);
}

/**
 * The REST API v2 of a Blockbook serving Pearl. Every method checks first,
 * once, that the server indexes the client's network (BACKEND_WRONG_NETWORK
 * if not): its pearld's chain name and its block 0 must be the network's.
 */
export class BlockbookClient {
  readonly network: PearlNetwork;
  /** The base URL, ending in a slash. */
  readonly url: string;
  readonly #origin: string;
  readonly #fetch: typeof fetch;
  readonly #init: RequestInit & Record<string, unknown>;
  readonly #timeout: number;
  readonly #retry: Required<RetryOptions> | null;
  readonly #maxConcurrent: number;
  readonly #maxReplySize: number;
  #inFlight = 0;
  readonly #waiting: (() => void)[] = [];
  #checked: Promise<void> | null = null;

  constructor(options: BlockbookClientOptions) {
    const url = baseUrl(options.url, options.allowInsecureHttp === true, ['http:', 'https:']);
    this.network = options.network;
    this.url = url.href;
    this.#origin = url.host;
    const fetcher = options.fetch ?? globalThis.fetch;
    if (typeof fetcher !== 'function') throw new TypeError('no fetch implementation available');
    this.#fetch = fetcher;
    this.#init = options.init ?? {};
    this.#timeout = options.timeout ?? DEFAULT_RPC_TIMEOUT;
    const { retry = false, maxConcurrentRequests = DEFAULT_MAX_CONCURRENT_REQUESTS, maxReplySize = DEFAULT_MAX_REPLY_SIZE } = options;
    if (!Number.isSafeInteger(maxConcurrentRequests) || maxConcurrentRequests < 0) throw new RangeError('maxConcurrentRequests must be a whole number, 0 for no limit');
    if (!Number.isSafeInteger(maxReplySize) || maxReplySize < 1) throw new RangeError('maxReplySize must be a positive integer');
    this.#maxConcurrent = maxConcurrentRequests;
    this.#maxReplySize = maxReplySize;
    this.#retry = retry === false ? null : { retries: 2, delay: 250, maxDelay: 5000, ...(typeof retry === 'number' ? { retries: retry } : retry === true ? {} : retry) };
  }

  /**
   * Checks that the server indexes this client's network. Every other
   * method does this once on its own; calling it says early.
   */
  checkNetwork(): Promise<void> {
    this.#checked ??= (async () => {
      const [status, genesis] = await Promise.all([this.#status(), this.#blockHash(0)]);
      const { network } = this;
      const chain = status.backend?.chain;
      const wrong = (what: string) => new PearlError('BACKEND_WRONG_NETWORK', `the Blockbook at ${this.#origin} serves ${what}, not ${network.name}`);
      if (typeof chain === 'string' && chain !== network.name) throw wrong(`Pearl's ${chain}`);
      if (genesis === null) throw new PearlError('BACKEND_RESPONSE', `the Blockbook at ${this.#origin} has no block 0 yet, so its network cannot be checked`);
      if (genesis !== network.genesisHash) throw wrong(`a chain whose block 0 is ${genesis}`);
      if (status.blockbook?.decimals !== 8) throw wrong(`a coin with ${String(status.blockbook?.decimals)} decimals`);
    })().catch((err: unknown) => {
      // A failure to ask is asked again next time; an answer is kept.
      if (!(err instanceof PearlError && (err.code === 'BACKEND_WRONG_NETWORK' || err.code === 'BACKEND_RESPONSE'))) this.#checked = null;
      throw err;
    });
    return this.#checked;
  }

  /** GET /api/: the indexer's and its pearld's state. */
  async getStatus(): Promise<BlockbookStatus> {
    await this.checkNetwork();
    return this.#status();
  }

  /** The hash of the block at `height` on the server's chain, or of its best block when left out; null for a height it has not indexed. */
  async getBlockHash(height?: number): Promise<string | null> {
    if (height !== undefined) checkHeight(height, 'height');
    await this.checkNetwork();
    return this.#blockHash(height);
  }

  /** A block by height or hash, with one page of its transactions ("txslight": no hex). */
  async getBlock(id: number | string, options: { page?: number } = {}): Promise<BlockbookBlock> {
    await this.checkNetwork();
    return this.#get('block', `api/v2/block/${blockId(id)}`, { page: options.page }, isObjectWith('hash'));
  }

  /** The serialized block, certificate included, as hex. */
  async getRawBlock(id: number | string): Promise<string> {
    await this.checkNetwork();
    const reply = await this.#get<{ hex: string }>('rawblock', `api/v2/rawblock/${blockId(id)}`, {}, isObjectWith('hex'));
    if (typeof reply.hex !== 'string' || !HEX_RE.test(reply.hex)) throw this.#bad('rawblock', 'a block that is not hex');
    return reply.hex;
  }

  /** A transaction. `spending` asks for the spender of each spent output on a server without the extended index. */
  async getTransaction(txid: string, options: { spending?: boolean } = {}): Promise<BlockbookTx> {
    checkTxid(txid);
    await this.checkNetwork();
    return this.#get('tx', `api/v2/tx/${txid}`, { spending: options.spending === true ? 'true' : undefined }, isObjectWith('txid'));
  }

  /** pearld's own getrawtransaction reply for a transaction, which Blockbook passes through. */
  async getTransactionSpecific(txid: string): Promise<TxRawResult> {
    checkTxid(txid);
    await this.checkNetwork();
    return this.#get('tx-specific', `api/v2/tx-specific/${txid}`, {}, isObjectWith('txid'), (text) => parseJson(text, new Set(['value'])));
  }

  /** An address's balances and one page of its history. P2TR and P2MR addresses alike. */
  async getAddress(address: string, query: BlockbookAddressQuery = {}): Promise<BlockbookAddress> {
    decodeAddress(address, this.network);
    await this.checkNetwork();
    return this.#get('address', `api/v2/address/${address}`, addressParams(query), isObjectWith('address'));
  }

  /**
   * An extended public key or a tr() descriptor over one, with its derived
   * addresses as `tokens`. Pearl's fork derives BIP86 key-path P2TR
   * addresses only, on change chains 0 and 1 unless the descriptor names
   * others (PearlParser.ParseXpub), so no P2MR address is ever among them.
   */
  async getXpub(descriptor: string, query: BlockbookXpubQuery = {}): Promise<BlockbookAddress> {
    await this.checkNetwork();
    return this.#get('xpub', `api/v2/xpub/${encodeURIComponent(descriptor)}`, { ...addressParams(query), tokens: query.tokens, gap: query.gap }, isObjectWith('address'));
  }

  /** Unspent outputs of an address or an xpub, mempool ones first. */
  async getUtxos(addressOrXpub: string, options: { confirmed?: boolean; gap?: number } = {}): Promise<BlockbookUtxo[]> {
    await this.checkNetwork();
    return this.#get('utxo', `api/v2/utxo/${encodeURIComponent(addressOrXpub)}`, { confirmed: options.confirmed === true ? 'true' : undefined, gap: options.gap }, isArray);
  }

  /** An address's or xpub's balance history in intervals of `groupBy` seconds (default 3600), from confirmed transactions. `from` and `to` are Unix seconds. */
  async getBalanceHistory(addressOrXpub: string, options: { from?: number; to?: number; groupBy?: number; gap?: number } = {}): Promise<BlockbookBalanceHistory[]> {
    await this.checkNetwork();
    const { from, to, groupBy, gap } = options;
    return this.#get('balancehistory', `api/v2/balancehistory/${encodeURIComponent(addressOrXpub)}`, { from, to, groupBy, gap }, isArray);
  }

  /** One page of the mempool's txids, by the time the server took them in. */
  async getMempool(options: { page?: number; pageSize?: number } = {}): Promise<BlockbookMempool> {
    await this.checkNetwork();
    return this.#get('mempool', 'api/v2/mempool/', { page: options.page, pageSize: options.pageSize }, isObjectWith('mempool'));
  }

  /**
   * Broadcasts a signed transaction through the server's pearld and returns
   * the txid it reports. pearld's refusal comes back as kind "rpc" with
   * pearld's code in `rpcCode`, as from PearldClient.
   */
  async sendTransaction(tx: string | Uint8Array): Promise<string> {
    const hex = typeof tx === 'string' ? tx : toHex(tx);
    if (!HEX_RE.test(hex) || hex === '') throw new TypeError('a transaction is hex or bytes');
    await this.checkNetwork();
    const reply = await this.#request<{ result: string }>('sendtx', 'api/v2/sendtx/', { method: 'POST', body: hex, headers: { 'Content-Type': 'text/plain' } }, false, isObjectWith('result'));
    if (typeof reply.result !== 'string' || !TXID_RE.test(reply.result)) throw this.#bad('sendtx', 'no txid');
    return reply.result;
  }

  /**
   * pearld's estimatefee through the server, in grain per 1000 vbytes: what
   * /api/v2/estimatefee and the desktop wallet's /api/v1/estimatefee both
   * answer, in PRL per kB. pearld without an estimate makes the server
   * answer HTTP 500.
   */
  async estimateFee(blocks: number, options: { conservative?: boolean } = {}): Promise<FeeRate> {
    checkHeight(blocks, 'blocks');
    await this.checkNetwork();
    const reply = await this.#get<{ result: string }>('estimatefee', `api/v2/estimatefee/${blocks}`, { conservative: options.conservative === undefined ? undefined : String(options.conservative) }, isObjectWith('result'));
    if (typeof reply.result !== 'string') throw this.#bad('estimatefee', 'no fee rate');
    const rate = decimalToGrain(reply.result);
    if (rate < 0n) throw this.#bad('estimatefee', `a negative fee rate, ${reply.result}`);
    return rate;
  }

  #status(): Promise<BlockbookStatus> {
    return this.#get('status', 'api/', {}, isObjectWith('blockbook'));
  }

  async #blockHash(height?: number): Promise<string | null> {
    const reply = await this.#get<{ blockHash: string }>('block-index', `api/v2/block-index/${height ?? ''}`, {}, isObjectWith('blockHash'));
    if (reply.blockHash === '') return null;
    if (typeof reply.blockHash !== 'string' || !TXID_RE.test(reply.blockHash)) throw this.#bad('block-index', 'no block hash');
    return reply.blockHash;
  }

  #get<T>(name: string, path: string, query: Record<string, string | number | undefined>, check: (value: unknown) => boolean, parse?: (text: string) => unknown): Promise<T> {
    const url = new URL(path, this.url);
    for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, String(value));
    return this.#request(name, url.href, { method: 'GET' }, true, check, parse);
  }

  async #request<T>(name: string, target: string, init: RequestInit, idempotent: boolean, check: (value: unknown) => boolean, parse = parseBlockbookJson): Promise<T> {
    const url = new URL(target, this.url).href;
    for (let attempt = 0; ; attempt++) {
      try {
        const text = await this.#limited(() => this.#send(name, url, init));
        let value: unknown;
        try {
          value = parse(text);
        } catch (err) {
          throw new PearlRpcError('response', name, `unreadable reply from ${this.#origin}: ${(err as Error).message}`, { cause: err });
        }
        if (!check(value)) throw this.#bad(name, `an unexpected reply ${JSON.stringify(text.slice(0, 120))}`);
        return value as T;
      } catch (err) {
        const retry = idempotent ? this.#retry : null;
        if (retry === null || attempt >= retry.retries || !isTransient(err)) throw err;
        await new Promise((resolve) => setTimeout(resolve, Math.min(retry.maxDelay, retry.delay * 2 ** attempt)));
      }
    }
  }

  async #send(name: string, url: string, request: RequestInit): Promise<string> {
    const origin = this.#origin;
    const controller = new AbortController();
    const signal = this.#init.signal;
    const onAbort = () => controller.abort();
    if (signal !== undefined && signal !== null) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    let timedOut = false;
    const timer = this.#timeout > 0 ? setTimeout(() => ((timedOut = true), controller.abort()), this.#timeout) : undefined;
    const aborted = new Promise<never>((_, reject) => {
      const fail = () => reject(new DOMException('The operation was aborted', 'AbortError'));
      if (controller.signal.aborted) fail();
      else controller.signal.addEventListener('abort', fail, { once: true });
    });
    aborted.catch(() => {});
    try {
      let response: Response;
      let text: string;
      try {
        const headers = new Headers(this.#init.headers);
        for (const [key, value] of new Headers(request.headers)) headers.set(key, value);
        response = await Promise.race([this.#fetch(url, { ...this.#init, ...request, headers, signal: controller.signal, redirect: 'manual' }), aborted]);
        if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
          void response.body?.cancel().catch(() => {});
          // Pearl's servers send plain http:// on to https:// this way.
          const location = response.headers.get('location');
          throw new PearlRpcError('http', name, `${origin} answered with a redirect${location === null ? '' : ` to ${location.slice(0, 200)}`}, which is not followed`, { status: response.status });
        }
        text = await Promise.race([readBounded(response, this.#maxReplySize, name, origin), aborted]);
      } catch (err) {
        if (err instanceof PearlRpcError) throw err;
        throw new PearlRpcError('network', name, timedOut ? `no reply from ${origin} within ${this.#timeout} ms` : unreachable(err, origin), { cause: err });
      }
      if (!response.ok) {
        const message = errorText(text);
        if (message === null) throw new PearlRpcError('http', name, `HTTP ${response.status} from ${origin}${text.trim() === '' ? '' : `: ${text.trim().split('\n')[0]!.slice(0, 120)}`}`, { status: response.status });
        // A refusal from pearld reaches the reply as btcjson.RPCError's text, "code: message".
        const code = /^(-?\d+): /.exec(message);
        throw new PearlRpcError('rpc', name, message, { status: response.status, ...(code === null ? {} : { rpcCode: Number(code[1]) }) });
      }
      return text;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async #limited<T>(run: () => Promise<T>): Promise<T> {
    if (this.#maxConcurrent > 0 && this.#inFlight >= this.#maxConcurrent) await new Promise<void>((resolve) => this.#waiting.push(resolve));
    else this.#inFlight++;
    try {
      return await run();
    } finally {
      const next = this.#waiting.shift();
      if (next === undefined) this.#inFlight--;
      else next();
    }
  }

  #bad(name: string, what: string): PearlRpcError {
    return new PearlRpcError('response', name, `${this.#origin} sent ${what}`);
  }
}

/** Options for BlockbookWsClient. */
export interface BlockbookWsClientOptions {
  /** The server's base URL; http(s) becomes ws(s) and the path gains "websocket", as Blockbook serves it. A ws(s) URL is taken as it is. */
  readonly url: string | URL;
  /** The network the server must serve: its block 0 is checked on every connection. */
  readonly network: PearlNetwork;
  /** A WebSocket constructor; defaults to globalThis.WebSocket. */
  readonly WebSocket?: abstract new (url: string, ...rest: never[]) => object;
  /** Second constructor argument, e.g. `{ dispatcher }` for undici. */
  readonly webSocketInit?: Record<string, unknown>;
  /** Reconnect after a session drops, subscribing again. On by default; a first connection is never retried. */
  readonly reconnect?: boolean | ReconnectOptions;
  /** Per-call limit in ms, the wait for a connection included; 0 for none. Default DEFAULT_RPC_TIMEOUT. */
  readonly timeout?: number;
  /** Frames longer than this many characters drop the connection. Default DEFAULT_MAX_REPLY_SIZE. */
  readonly maxReplySize?: number;
  /** ws:// is refused for any host but loopback unless this is set; see BlockbookClientOptions. */
  readonly allowInsecureHttp?: boolean;
  /** Told of a failure no call is waiting on: a dropped session, a reconnect that failed. */
  readonly onError?: (error: Error) => void;
  /**
   * Sends Blockbook's `ping` this often, in ms, while connected; 0 for
   * never. Pearl's servers sit behind a proxy that closes a websocket after
   * 30 seconds without a frame from the client. Default 20,000.
   */
  readonly keepAlive?: number;
}

/** getInfo over the websocket (WsInfoRes). */
export interface BlockbookWsInfo {
  readonly name: string;
  readonly shortcut: string;
  readonly network: string;
  readonly decimals: number;
  readonly version: string;
  readonly bestHeight: number;
  readonly bestHash: string;
  readonly block0Hash: string;
  readonly testnet: boolean;
  readonly backend: { readonly version?: string; readonly subversion?: string };
}

/** A block the server connected (WsNewBlock). */
export interface BlockbookNewBlock {
  readonly height: number;
  readonly hash: string;
}

/** A transaction touching a subscribed address (sendOnNewTxAddr). */
export interface BlockbookAddressTx {
  readonly address: string;
  readonly tx: BlockbookTx;
}

/** Parameters of getAccountInfo (WsAccountInfoReq). */
export interface BlockbookAccountInfoParams extends BlockbookAddressQuery {
  /** An address, an xpub or a tr() descriptor. */
  readonly descriptor: string;
  readonly tokens?: 'derived' | 'used' | 'nonzero';
  readonly gap?: number;
}

type Socket = {
  readyState: number;
  onopen: ((event: unknown) => void) | null;
  onclose: ((event: { code?: number }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  send(data: string): void;
  close(code?: number): void;
};

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

interface Subscription {
  method: 'subscribeNewBlock' | 'subscribeAddresses';
  params: Record<string, unknown>;
  deliver: (data: unknown) => void;
}

// subscribeAddresses takes at most this many addresses, 100 with newBlockTxs (server/websocket.go).
const MAX_SUBSCRIBED_ADDRESSES = 1000;
const MAX_SUBSCRIBED_ADDRESSES_WITH_BLOCKS = 100;

/**
 * Blockbook's websocket API: requests, new blocks, and transactions
 * touching a set of addresses, with reconnect and resubscription.
 * Requests and replies carry a string id; a subscription's notifications
 * come with the id of the request that made it.
 */
export class BlockbookWsClient {
  readonly network: PearlNetwork;
  readonly #url: string;
  readonly #origin: string;
  readonly #ctor: new (url: string, init?: Record<string, unknown>) => Socket;
  readonly #init: Record<string, unknown> | undefined;
  readonly #reconnect: Required<ReconnectOptions> | null;
  readonly #timeout: number;
  readonly #maxReplySize: number;
  readonly #onError: ((error: Error) => void) | undefined;
  readonly #keepAlive: number;
  #pinger: ReturnType<typeof setInterval> | undefined;
  #socket: Socket | null = null;
  #ready: Promise<void> | null = null;
  #closed = false;
  #id = 0;
  #attempt = 0;
  readonly #pending = new Map<string, Pending>();
  readonly #subscriptions = new Map<string, Subscription>();

  constructor(options: BlockbookWsClientOptions) {
    const url = baseUrl(options.url, options.allowInsecureHttp === true, ['http:', 'https:', 'ws:', 'wss:']);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
      url.pathname += 'websocket';
    } else {
      url.pathname = url.pathname.replace(/\/$/, '');
    }
    this.#url = url.href;
    this.#origin = url.host;
    this.network = options.network;
    const ctor = options.WebSocket ?? (globalThis as { WebSocket?: unknown }).WebSocket;
    if (typeof ctor !== 'function') throw new TypeError('no WebSocket implementation available; pass one as WebSocket');
    this.#ctor = ctor as unknown as new (url: string, init?: Record<string, unknown>) => Socket;
    this.#init = options.webSocketInit;
    const reconnect = options.reconnect ?? true;
    this.#reconnect = reconnect === false ? null : { initialDelay: 1000, maxDelay: 30000, retries: Infinity, ...(reconnect === true ? {} : reconnect) };
    this.#timeout = options.timeout ?? DEFAULT_RPC_TIMEOUT;
    this.#maxReplySize = options.maxReplySize ?? DEFAULT_MAX_REPLY_SIZE;
    this.#onError = options.onError;
    const keepAlive = options.keepAlive ?? 20_000;
    if (!Number.isSafeInteger(keepAlive) || keepAlive < 0) throw new RangeError('keepAlive must be a whole number of ms, 0 for never');
    this.#keepAlive = keepAlive;
  }

  /** Opens the connection and checks the network; calls do this on their own. */
  connect(): Promise<void> {
    if (this.#closed) return Promise.reject(new PearlRpcError('network', 'connect', 'this client is closed'));
    this.#ready ??= this.#open().catch((err: unknown) => {
      this.#ready = null;
      throw err;
    });
    return this.#ready;
  }

  /** Any method, with its params object. Rejects with a PearlRpcError; an error reply is kind "rpc". */
  async call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    await this.connect();
    return (await this.#request(method, params)) as T;
  }

  getInfo(): Promise<BlockbookWsInfo> {
    return this.call('getInfo');
  }

  /** The hash of the block at `height` on the server's chain, null for a height it has not indexed. */
  async getBlockHash(height: number): Promise<string | null> {
    checkHeight(height, 'height');
    const { hash } = await this.call<{ hash: string }>('getBlockHash', { height });
    if (hash === '') return null;
    if (typeof hash !== 'string' || !TXID_RE.test(hash)) throw new PearlRpcError('response', 'getBlockHash', `${this.#origin} sent no block hash`);
    return hash;
  }

  /** An address's or xpub's balances and a page of history; the websocket form of getAddress and getXpub. */
  getAccountInfo(params: BlockbookAccountInfoParams): Promise<BlockbookAddress> {
    return this.call('getAccountInfo', { ...params });
  }

  getAccountUtxo(descriptor: string): Promise<BlockbookUtxo[]> {
    return this.call('getAccountUtxo', { descriptor });
  }

  getTransaction(txid: string): Promise<BlockbookTx> {
    checkTxid(txid);
    return this.call('getTransaction', { txid });
  }

  async sendTransaction(tx: string | Uint8Array): Promise<string> {
    const hex = typeof tx === 'string' ? tx : toHex(tx);
    return (await this.call<{ result: string }>('sendTransaction', { hex })).result;
  }

  /** Calls `listener` for every block the server connects from now on. Resolves to a function that ends the subscription. */
  subscribeNewBlock(listener: (block: BlockbookNewBlock) => void): Promise<() => Promise<void>> {
    return this.#subscribe('subscribeNewBlock', 'unsubscribeNewBlock', {}, listener as (data: unknown) => void);
  }

  /**
   * Calls `listener` for each mempool transaction paying or spending from
   * any of the addresses, and with `newBlockTxs` for each one a new block
   * confirms. Blockbook keeps one address set per connection, so this
   * replaces the last one.
   */
  subscribeAddresses(addresses: readonly string[], listener: (event: BlockbookAddressTx) => void, options: { newBlockTxs?: boolean } = {}): Promise<() => Promise<void>> {
    const limit = options.newBlockTxs === true ? MAX_SUBSCRIBED_ADDRESSES_WITH_BLOCKS : MAX_SUBSCRIBED_ADDRESSES;
    if (addresses.length > limit) throw new RangeError(`Blockbook takes at most ${limit} addresses in one subscription`);
    for (const address of addresses) decodeAddress(address, this.network);
    for (const [id, sub] of this.#subscriptions) if (sub.method === 'subscribeAddresses') this.#subscriptions.delete(id);
    const params = { addresses: [...addresses], ...(options.newBlockTxs === true ? { newBlockTxs: true } : {}) };
    return this.#subscribe('subscribeAddresses', 'unsubscribeAddresses', params, listener as (data: unknown) => void);
  }

  /** Stops reconnecting, fails pending calls and closes the socket. */
  async close(): Promise<void> {
    this.#closed = true;
    this.#subscriptions.clear();
    this.#failAll(new PearlRpcError('network', 'close', 'the client was closed'));
    const socket = this.#socket;
    this.#socket = null;
    this.#stopPinging();
    if (socket !== null && socket.readyState <= 1) socket.close(1000);
  }

  async #subscribe(method: Subscription['method'], stop: string, params: Record<string, unknown>, deliver: (data: unknown) => void): Promise<() => Promise<void>> {
    await this.connect();
    const id = this.#nextId();
    const sub: Subscription = { method, params, deliver };
    this.#subscriptions.set(id, sub);
    try {
      await this.#request(method, params, id);
    } catch (err) {
      this.#subscriptions.delete(id);
      throw err;
    }
    return async () => {
      // A later subscribeAddresses replaced this one already.
      if (this.#subscriptions.get(id) !== sub) return;
      this.#subscriptions.delete(id);
      if (!this.#closed) await this.call(stop);
    };
  }

  async #open(): Promise<void> {
    const socket = await new Promise<Socket>((resolve, reject) => {
      let opened = false;
      const s = this.#init === undefined ? new this.#ctor(this.#url) : new this.#ctor(this.#url, this.#init);
      s.onopen = () => {
        opened = true;
        resolve(s);
      };
      s.onerror = () => {
        if (!opened) reject(new PearlRpcError('network', 'connect', `cannot open a websocket to ${this.#origin}`));
      };
      s.onclose = () => {
        if (!opened) reject(new PearlRpcError('network', 'connect', `the websocket to ${this.#origin} closed before it opened`));
        else this.#dropped(s);
      };
      s.onmessage = (event) => this.#receive(s, event.data);
    });
    this.#socket = socket;
    try {
      const info = (await this.#request('getInfo', {})) as Partial<BlockbookWsInfo> | null;
      if (info?.block0Hash !== this.network.genesisHash) {
        throw new PearlError('BACKEND_WRONG_NETWORK', `the Blockbook at ${this.#origin} serves a chain whose block 0 is ${String(info?.block0Hash)}, not ${this.network.name}`);
      }
      for (const [id, sub] of this.#subscriptions) await this.#request(sub.method, sub.params, id);
    } catch (err) {
      // A session that never got going is closed, so the next connect starts clean.
      this.#socket = null;
      socket.close(1000);
      throw err;
    }
    this.#attempt = 0;
    this.#stopPinging();
    if (this.#keepAlive > 0) {
      this.#pinger = setInterval(() => this.#request('ping', {}).catch(() => {}), this.#keepAlive);
      (this.#pinger as { unref?: () => void }).unref?.();
    }
  }

  #stopPinging(): void {
    clearInterval(this.#pinger);
    this.#pinger = undefined;
  }

  #dropped(socket: Socket): void {
    if (this.#socket !== socket) return;
    this.#socket = null;
    this.#ready = null;
    this.#stopPinging();
    this.#failAll(new PearlRpcError('network', 'websocket', `the websocket to ${this.#origin} closed`));
    if (this.#closed || this.#subscriptions.size === 0 || this.#reconnect === null) return;
    const policy = this.#reconnect;
    const retry = () => {
      if (this.#closed || this.#ready !== null) return;
      this.#attempt += 1;
      this.connect().catch((err: unknown) => {
        this.#onError?.(err as Error);
        if (err instanceof PearlError && err.code === 'BACKEND_WRONG_NETWORK') return;
        if (this.#attempt >= policy.retries) return;
        setTimeout(retry, Math.min(policy.maxDelay, policy.initialDelay * 2 ** this.#attempt));
      });
    };
    setTimeout(retry, policy.initialDelay);
  }

  #request(method: string, params: Record<string, unknown>, id = this.#nextId()): Promise<unknown> {
    const socket = this.#socket;
    if (socket === null) return Promise.reject(new PearlRpcError('network', method, `no websocket to ${this.#origin}`));
    return new Promise((resolve, reject) => {
      const timer = this.#timeout > 0 ? setTimeout(() => {
        this.#pending.delete(id);
        reject(new PearlRpcError('network', method, `no reply from ${this.#origin} within ${this.#timeout} ms`));
      }, this.#timeout) : undefined;
      this.#pending.set(id, { method, resolve, reject, timer });
      try {
        socket.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(new PearlRpcError('network', method, `cannot send to ${this.#origin}`, { cause: err }));
      }
    });
  }

  #receive(socket: Socket, data: unknown): void {
    const text = typeof data === 'string' ? data : '';
    if (text.length > this.#maxReplySize) {
      this.#onError?.(new PearlRpcError('response', 'websocket', `a frame from ${this.#origin} is larger than maxReplySize, ${this.#maxReplySize} characters`));
      socket.close(1009);
      this.#dropped(socket);
      return;
    }
    let message: { id?: unknown; data?: unknown };
    try {
      message = parseBlockbookJson(text) as { id?: unknown; data?: unknown };
    } catch (err) {
      this.#onError?.(new PearlRpcError('response', 'websocket', `unreadable frame from ${this.#origin}`, { cause: err }));
      return;
    }
    const id = typeof message?.id === 'string' ? message.id : '';
    const payload = message.data;
    const sub = this.#subscriptions.get(id);
    const pending = this.#pending.get(id);
    // A subscription's reply carries "subscribed" or "error"; anything else under its id is a notification, even one that beats the reply.
    if (sub !== undefined && !(typeof payload === 'object' && payload !== null && ('subscribed' in payload || 'error' in payload))) {
      sub.deliver(payload);
      return;
    }
    if (pending === undefined) return;
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    const error = typeof payload === 'object' && payload !== null ? (payload as { error?: { message?: unknown } }).error : undefined;
    if (error !== undefined) pending.reject(new PearlRpcError('rpc', pending.method, typeof error?.message === 'string' ? error.message : 'unknown error'));
    else pending.resolve(payload);
  }

  #failAll(error: PearlRpcError): void {
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      this.#pending.delete(id);
      pending.reject(new PearlRpcError(error.kind, pending.method, error.message.replace(/^[^:]+: /, '')));
    }
  }

  #nextId(): string {
    return String(++this.#id);
  }
}

function baseUrl(input: string | URL, allowInsecure: boolean, protocols: readonly string[]): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new TypeError('invalid Blockbook URL');
  }
  if (!protocols.includes(url.protocol)) throw new TypeError(`not a Blockbook URL: ${url.protocol}`);
  if ((url.protocol === 'http:' || url.protocol === 'ws:') && !allowInsecure && !isLoopback(url.hostname)) {
    throw new TypeError(`refusing ${url.protocol}// to ${url.host}: anyone on the path can read and rewrite every reply; use TLS or set allowInsecureHttp`);
  }
  if (url.username !== '' || url.password !== '') throw new TypeError('a Blockbook URL takes no credentials');
  url.search = '';
  url.hash = '';
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}

function addressParams(query: BlockbookAddressQuery): Record<string, string | number | undefined> {
  const { page, pageSize, from, to, details } = query;
  for (const [name, value] of Object.entries({ page, pageSize, from, to })) if (value !== undefined) checkHeight(value, name);
  return { page, pageSize, from, to, details };
}

function blockId(id: number | string): string {
  if (typeof id === 'number') {
    checkHeight(id, 'height');
    return String(id);
  }
  if (!TXID_RE.test(id)) throw new TypeError('a block is a height or a 64-character hex hash');
  return id;
}

function checkTxid(txid: string): void {
  if (typeof txid !== 'string' || !TXID_RE.test(txid)) throw new TypeError('a txid is 64 lowercase hex characters');
}

function checkHeight(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a whole number`);
}

const isObjectWith = (key: string) => (value: unknown): boolean => typeof value === 'object' && value !== null && !Array.isArray(value) && key in value;
const isArray = (value: unknown): boolean => Array.isArray(value);

function isTransient(err: unknown): boolean {
  if (!(err instanceof PearlRpcError)) return false;
  return err.kind === 'network' || ((err.kind === 'http' || err.kind === 'rpc') && (err.status === 429 || (err.status ?? 0) >= 500));
}

// Blockbook writes every error as {"error": "text"}.
function errorText(text: string): string | null {
  try {
    const reply = JSON.parse(text) as { error?: unknown };
    return typeof reply?.error === 'string' ? reply.error : null;
  } catch {
    return null;
  }
}

function unreachable(err: unknown, origin: string): string {
  if (err instanceof Error && err.name === 'AbortError') return `request to ${origin} was aborted`;
  const cause = err instanceof Error && err.cause instanceof Error ? err.cause : err;
  const code = typeof cause === 'object' && cause !== null ? (cause as { code?: unknown }).code : undefined;
  if (code === 'ECONNREFUSED') return `connection refused by ${origin}`;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `cannot resolve host ${origin}`;
  const detail = cause instanceof Error ? cause.message : String(cause);
  return `cannot reach ${origin}: ${typeof code === 'string' ? `${code} ` : ''}${detail}`;
}
