// JSON-RPC clients for pearld (node/rpcserver.go) and Oyster
// (wallet/rpc/jsonrpc), over fetch so they run in Node and browsers.
//
// Both servers take HTTP Basic auth on every POST to "/", serve TLS by default
// with a self-signed rpc.cert, and answer with HTTP 200 and a JSON-RPC 1.0
// envelope whose "error" carries the failure. There are no cookie files.
// Amounts arrive as PRL JSON numbers; they are converted to bigint grain from
// the response text, never through a JS number, and bigint params are sent
// back as exact PRL numbers.

import { formatPearl, parsePearl } from './amount.js';
import type { AddressPayment, BlockRef, ChainClient, ChainTransaction } from './client.js';
import type { PearlNetworkName } from './networks.js';

/** pearld's default RPC port per network (node/params.go). */
export const PEARLD_RPC_PORTS: Readonly<Record<PearlNetworkName, number>> = {
  mainnet: 44107,
  testnet: 44109,
  testnet2: 44111,
  regtest: 18334,
  simnet: 18556,
};

/** Oyster's default RPC port per network (wallet/netparams/params.go). */
export const OYSTER_RPC_PORTS: Readonly<Record<PearlNetworkName, number>> = {
  mainnet: 44207,
  testnet: 44209,
  testnet2: 44211,
  regtest: 18332,
  simnet: 18554,
};

export interface RpcClientOptions {
  /** Server URL, e.g. https://127.0.0.1:44107. Credentials in the URL are moved to the auth header. */
  readonly url: string | URL;
  readonly username?: string;
  readonly password?: string;
  /** Defaults to globalThis.fetch. */
  readonly fetch?: typeof fetch;
  /**
   * Merged into every request. Node users pass `{ dispatcher }` here, with an
   * undici Agent that trusts the server's rpc.cert.
   */
  readonly init?: RequestInit & Record<string, unknown>;
}

export interface CallOptions {
  /**
   * Object keys whose numeric values are PRL amounts, returned as bigint
   * grain. "result" names the result itself, as in getbalance.
   */
  readonly amounts?: readonly string[];
}

export type RpcErrorKind = 'rpc' | 'http' | 'network' | 'response';

/** Any failed call: an RPC error reply, an HTTP failure, an unreachable server or a malformed reply. */
export class PearlRpcError extends Error {
  override readonly name = 'PearlRpcError';
  readonly kind: RpcErrorKind;
  readonly method: string;
  /** JSON-RPC error code, for kind "rpc". */
  readonly code: number | undefined;
  /** HTTP status, for kind "http". */
  readonly status: number | undefined;

  constructor(
    kind: RpcErrorKind,
    method: string,
    message: string,
    extra: { code?: number; status?: number; cause?: unknown } = {},
  ) {
    super(`${method}: ${message}`, extra.cause === undefined ? undefined : { cause: extra.cause });
    this.kind = kind;
    this.method = method;
    this.code = extra.code;
    this.status = extra.status;
  }
}

/** Codes from node/btcjson/jsonrpcerr.go that callers commonly branch on. */
export const RPC_ERROR_CODES = {
  MISC: -1,
  WALLET: -4,
  INVALID_ADDRESS_OR_KEY: -5,
  NO_TX_INFO: -5,
  INSUFFICIENT_FUNDS: -6,
  INVALID_PARAMETER: -8,
  DESERIALIZATION: -22,
  VERIFY: -25,
  TX_REJECTED: -26,
  TX_ALREADY_IN_CHAIN: -27,
  WALLET_UNLOCK_NEEDED: -13,
  WALLET_PASSPHRASE_INCORRECT: -14,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
} as const;

/** A bare JSON-RPC client; PearldClient and OysterClient add typed methods. */
export class JsonRpcClient {
  readonly #url: string;
  readonly #origin: string;
  readonly #auth: string | undefined;
  readonly #fetch: typeof fetch;
  readonly #init: RequestInit & Record<string, unknown>;
  #id = 0;

  constructor(options: RpcClientOptions) {
    const url = new URL(options.url);
    const username = options.username ?? decodeURIComponent(url.username);
    const password = options.password ?? decodeURIComponent(url.password);
    // fetch refuses URLs with credentials, so they travel in the header only.
    url.username = '';
    url.password = '';
    this.#url = url.href;
    this.#origin = url.host;
    this.#auth = username || password ? `Basic ${base64(`${username}:${password}`)}` : undefined;
    const fetcher = options.fetch ?? globalThis.fetch;
    if (typeof fetcher !== 'function') throw new TypeError('no fetch implementation available');
    this.#fetch = fetcher;
    this.#init = options.init ?? {};
  }

  /** Calls any method. bigint params are sent as exact PRL amounts. */
  async call<T = unknown>(method: string, params: readonly unknown[] = [], options: CallOptions = {}): Promise<T> {
    const id = ++this.#id;
    // pearld rejects requests without params or with a null id.
    const body = encodeJson({ jsonrpc: '1.0', id, method, params });
    const headers = new Headers(this.#init.headers);
    headers.set('Content-Type', 'application/json');
    if (this.#auth !== undefined) headers.set('Authorization', this.#auth);

    let response: Response;
    try {
      response = await this.#fetch(this.#url, { ...this.#init, method: 'POST', headers, body });
    } catch (err) {
      throw new PearlRpcError('network', method, networkMessage(err, this.#origin), { cause: err });
    }
    const text = await response.text();
    const amounts = new Set(options.amounts);
    if (!response.ok) {
      let reply: unknown;
      try {
        reply = parseJson(text, amounts);
      } catch {
        // Not JSON: report the HTTP failure.
      }
      if (isErrorReply(reply)) throw rpcError(method, reply.error);
      throw new PearlRpcError('http', method, httpMessage(response, text, this.#origin), { status: response.status });
    }
    let reply: unknown;
    try {
      reply = parseJson(text, amounts);
    } catch (err) {
      const reason = text.trim() === '' ? 'an empty body' : (err as Error).message;
      throw new PearlRpcError('response', method, `unreadable reply from ${this.#origin}: ${reason}`, { cause: err });
    }
    if (typeof reply !== 'object' || reply === null || !('result' in reply)) {
      throw new PearlRpcError('response', method, `expected a JSON-RPC reply, got ${JSON.stringify(text.slice(0, 120))}`);
    }
    if (isErrorReply(reply)) throw rpcError(method, reply.error);
    const replyId = (reply as { id?: unknown }).id;
    if (replyId !== id) {
      throw new PearlRpcError('response', method, `reply id ${JSON.stringify(replyId)} does not match request id ${id}`);
    }
    return (reply as { result: T }).result;
  }
}

// pearld results

export interface ScriptPubKeyResult {
  readonly asm: string;
  readonly hex?: string;
  /** Deprecated in Bitcoin Core, still sent by Pearl. */
  readonly reqSigs?: number;
  readonly type: string;
  readonly address?: string;
  readonly addresses?: string[];
}

export interface RpcVout {
  /** Grains. */
  readonly value: bigint;
  readonly n: number;
  readonly scriptPubKey: ScriptPubKeyResult;
}

export type RpcVin =
  | { readonly coinbase: string; readonly txinwitness?: string[]; readonly sequence: number }
  | {
      readonly txid: string;
      readonly vout: number;
      readonly scriptSig: { readonly asm: string; readonly hex: string };
      readonly txinwitness?: string[];
      readonly sequence: number;
    };

/** getrawtransaction with verbose 1 (btcjson.TxRawResult). */
export interface TxRawResult {
  readonly hex: string;
  readonly txid: string;
  readonly hash?: string;
  readonly vsize?: number;
  readonly size?: number;
  readonly version: number;
  readonly locktime: number;
  readonly vin: RpcVin[];
  readonly vout: RpcVout[];
  readonly blockhash?: string;
  readonly confirmations?: number;
  readonly time?: number;
  readonly blocktime?: number;
}

/** searchrawtransactions with verbose 1 (btcjson.SearchRawTransactionsResult). */
export interface SearchRawTransactionsResult {
  readonly hex?: string;
  readonly txid: string;
  /** Pearl leaves hash, size and vsize empty here, and block fields out for mempool transactions. */
  readonly hash: string;
  readonly size: string;
  readonly vsize: string;
  readonly version: number;
  readonly locktime: number;
  readonly vin: (RpcVin & { readonly prevOut?: { readonly addresses?: string[]; readonly value: bigint } })[];
  readonly vout: RpcVout[];
  readonly blockhash?: string;
  readonly confirmations?: number;
  readonly time?: number;
  readonly blocktime?: number;
}

export interface Bip9SoftForkDescription {
  readonly status: string;
  readonly bit: number;
  readonly startTime: number;
  readonly start_time: number;
  readonly timeout: number;
  readonly since: number;
  readonly min_activation_height: number;
}

/** getblockchaininfo (btcjson.GetBlockChainInfoResult). */
export interface BlockchainInfo {
  readonly chain: string;
  readonly blocks: number;
  /** Pearl reports its own tip height here, not the best known header. */
  readonly headers: number;
  readonly bestblockhash: string;
  readonly difficulty: number;
  readonly mediantime: number;
  readonly verificationprogress?: number;
  readonly initialblockdownload?: boolean;
  readonly pruned: boolean;
  readonly pruneheight?: number;
  readonly chainwork?: string;
  readonly size_on_disk?: number;
  readonly bip9_softforks?: Record<string, Bip9SoftForkDescription>;
}

/** getblockheader with verbose true (btcjson.GetBlockHeaderVerboseResult). */
export interface BlockHeaderResult {
  readonly hash: string;
  readonly confirmations: number;
  readonly height: number;
  readonly version: number;
  readonly versionHex: string;
  readonly merkleroot: string;
  readonly time: number;
  readonly bits: string;
  readonly difficulty: number;
  readonly previousblockhash?: string;
  readonly nextblockhash?: string;
  readonly proofcommitment: string;
}

/** getmempoolinfo. Pearl sends only these three fields. */
export interface MempoolInfo {
  readonly size: number;
  readonly bytes: number;
  /** Maximum mempool size in bytes. */
  readonly cap: number;
}

export interface MempoolEntry {
  readonly size: number;
  readonly vsize: number;
  /** Grains. */
  readonly fee: bigint;
  readonly time: number;
  readonly height: number;
  readonly depends: string[];
}

export interface TestMempoolAcceptResult {
  readonly txid: string;
  readonly wtxid: string;
  readonly 'package-error': string;
  /** Pearl omits "allowed" when false; it is always present here. */
  readonly allowed: boolean;
  readonly vsize?: number;
  readonly fees?: {
    /** Grains. */
    readonly base: bigint;
    /** Grain per 1000 vbytes. */
    readonly 'effective-feerate': bigint;
    readonly 'effective-includes': string[] | null;
  };
  readonly 'reject-reason'?: string;
}

/** gettxout. `value` is in grains. */
export interface TxOutResult {
  readonly bestblock: string;
  readonly confirmations: number;
  readonly value: bigint;
  readonly scriptPubKey: ScriptPubKeyResult;
  readonly coinbase: boolean;
}

export interface SearchOptions {
  readonly skip?: number;
  /** pearld caps this at 10000. */
  readonly count?: number;
  readonly reverse?: boolean;
  /** Adds `prevOut`, the spent output's addresses and value, to every input. */
  readonly vinExtra?: boolean;
}

/** Typed methods for pearld. */
export class PearldClient extends JsonRpcClient {
  getBlockchainInfo(): Promise<BlockchainInfo> {
    return this.call('getblockchaininfo');
  }

  getBlockCount(): Promise<number> {
    return this.call('getblockcount');
  }

  getBestBlockHash(): Promise<string> {
    return this.call('getbestblockhash');
  }

  getBlockHash(height: number): Promise<string> {
    return this.call('getblockhash', [height]);
  }

  /** The serialized block, certificate first, as hex. */
  getBlockHex(hash: string): Promise<string> {
    return this.call('getblock', [hash, 0]);
  }

  /** The serialized block as bytes, ready for parseBlock. */
  async getRawBlock(hash: string): Promise<Uint8Array> {
    return hexToBytes(await this.getBlockHex(hash));
  }

  getBlockHeader(hash: string): Promise<BlockHeaderResult> {
    return this.call('getblockheader', [hash, true]);
  }

  /** Mempool transactions only, unless pearld runs with --txindex. */
  getRawTransactionHex(txid: string): Promise<string> {
    return this.call('getrawtransaction', [txid, 0]);
  }

  getRawTransaction(txid: string): Promise<TxRawResult> {
    return this.call('getrawtransaction', [txid, 1], { amounts: ['value'] });
  }

  /** Returns the txid. pearld ignores Bitcoin Core's maxfeerate argument, so none is sent. */
  sendRawTransaction(tx: string | Uint8Array): Promise<string> {
    return this.call('sendrawtransaction', [typeof tx === 'string' ? tx : bytesToHex(tx)]);
  }

  /**
   * maxFeeRate is grain per 1000 vbytes. pearld refuses the call without it,
   * and reads 0, sent when none is given, as its default of 10000000 (0.1
   * PRL/kvB). A transaction above the rate is refused as "max-fee-exceeded".
   */
  async testMempoolAccept(txs: readonly (string | Uint8Array)[], maxFeeRate = 0n): Promise<TestMempoolAcceptResult[]> {
    const hexes = txs.map((tx) => (typeof tx === 'string' ? tx : bytesToHex(tx)));
    const results = await this.call<Omit<TestMempoolAcceptResult, 'allowed'>[]>('testmempoolaccept', [hexes, maxFeeRate], {
      amounts: ['base', 'effective-feerate'],
    });
    return results.map((r) => ({ ...r, allowed: (r as { allowed?: boolean }).allowed === true }));
  }

  /**
   * estimatefee: grain per 1000 bytes, for 1 to 25 blocks. It is 0 until
   * pearld has seen transactions confirm, so floor it at the relay fee. A
   * node that has connected fewer than three blocks answers with an error.
   * pearld has no estimatesmartfee.
   */
  estimateFee(blocks: number): Promise<bigint> {
    return this.call('estimatefee', [blocks], { amounts: ['result'] });
  }

  getMempoolInfo(): Promise<MempoolInfo> {
    return this.call('getmempoolinfo');
  }

  getRawMempool(): Promise<string[]> {
    return this.call('getrawmempool', [false]);
  }

  getRawMempoolVerbose(): Promise<Record<string, MempoolEntry>> {
    return this.call('getrawmempool', [true], { amounts: ['fee'] });
  }

  /**
   * null when the output is unknown or a block has spent it. pearld does not
   * count spends that are still in the mempool, whatever includeMempool says;
   * the flag only adds outputs of mempool transactions.
   */
  getTxOut(txid: string, vout: number, includeMempool = true): Promise<TxOutResult | null> {
    return this.call('gettxout', [txid, vout, includeMempool], { amounts: ['value'] });
  }

  /** Needs pearld with --addrindex and --txindex. Mempool transactions come last unless reversed. */
  searchRawTransactions(address: string, options: SearchOptions = {}): Promise<SearchRawTransactionsResult[]> {
    const { skip = 0, count = 100, reverse = false, vinExtra = false } = options;
    return this.call('searchrawtransactions', [address, 1, skip, count, vinExtra ? 1 : 0, reverse], {
      amounts: ['value'],
    });
  }
}

// Oyster results

/** listunspent (btcjson.ListUnspentResult). `amount` is in grains. */
export interface ListUnspentResult {
  readonly txid: string;
  readonly vout: number;
  readonly address: string;
  readonly account: string;
  readonly scriptPubKey: string;
  readonly redeemScript?: string;
  readonly amount: bigint;
  readonly confirmations: number;
  readonly spendable: boolean;
}

/**
 * Typed methods for Oyster. Methods Oyster does not handle are passed through
 * to its pearld, so `call` reaches node methods too. Oyster has no PSBT
 * methods.
 */
export class OysterClient extends JsonRpcClient {
  /** A new P2TR address. Oyster only makes bech32m Taproot addresses. */
  getNewAddress(account?: string): Promise<string> {
    return this.call('getnewaddress', account === undefined ? [] : [account]);
  }

  /** Spendable balance in grains; account "*" is the whole wallet. */
  getBalance(account = '*', minConf = 1): Promise<bigint> {
    return this.call('getbalance', [account, minConf], { amounts: ['result'] });
  }

  getUnconfirmedBalance(account?: string): Promise<bigint> {
    return this.call('getunconfirmedbalance', account === undefined ? [] : [account], { amounts: ['result'] });
  }

  /** Oyster refuses the address filter Bitcoin Core takes, so none is offered. */
  listUnspent(minConf = 1, maxConf = 9999999): Promise<ListUnspentResult[]> {
    return this.call('listunspent', [minConf, maxConf], { amounts: ['amount'] });
  }

  /** Oyster's BIP-322-style signature, base64; P2TR addresses only. */
  signMessage(address: string, message: string): Promise<string> {
    return this.call('signmessage', [address, message]);
  }

  verifyMessage(address: string, signature: string, message: string): Promise<boolean> {
    return this.call('verifymessage', [address, signature, message]);
  }

  /** Unlocks for timeoutSeconds. In Oyster a timeout of 0 never relocks. */
  async walletPassphrase(passphrase: string, timeoutSeconds: number): Promise<void> {
    await this.call('walletpassphrase', [passphrase, timeoutSeconds]);
  }

  async walletLock(): Promise<void> {
    await this.call('walletlock');
  }

  walletIsLocked(): Promise<boolean> {
    return this.call('walletislocked');
  }

  /**
   * Sends from the default account and returns the txid. Oyster requires a
   * fee rate, here in grain per 1000 bytes, where Bitcoin Core has none.
   */
  sendToAddress(address: string, amount: bigint, feeRatePerKb: bigint): Promise<string> {
    return this.call('sendtoaddress', [address, amount, feeRatePerKb]);
  }

  /** Imports into the "imported" account, the only label Oyster accepts. */
  async importPrivKey(wif: string, rescan = true): Promise<void> {
    await this.call('importprivkey', [wif, 'imported', rescan]);
  }

  dumpPrivKey(address: string): Promise<string> {
    return this.call('dumpprivkey', [address]);
  }
}

/** The most transactions searchrawtransactions returns in one call. */
const MAX_SEARCH_COUNT = 10000;

/**
 * A ChainClient over pearld for the invoice monitor. Address activity comes
 * from searchrawtransactions, so pearld must run with --addrindex and
 * --txindex.
 */
export function pearldChainClient(client: PearldClient, pageSize = 100): ChainClient {
  const blockRef = async (hash: string | undefined, heights: Map<string, number>): Promise<BlockRef | null> => {
    if (hash === undefined || hash === '') return null;
    let height = heights.get(hash);
    if (height === undefined) {
      height = (await client.getBlockHeader(hash)).height;
      heights.set(hash, height);
    }
    return { height, hash };
  };

  return {
    async getTip() {
      // One call, so the height and hash come from the same snapshot.
      const info = await client.getBlockchainInfo();
      return { height: info.blocks, hash: info.bestblockhash };
    },

    async getAddressActivity(address) {
      const found = new Map<string, { amount: bigint; blockhash: string | undefined }>();
      const add = (page: SearchRawTransactionsResult[]): void => {
        for (const tx of page) {
          const amount = tx.vout
            .filter((out) => out.scriptPubKey.address === address)
            .reduce((sum, out) => sum + out.value, 0n);
          if (amount > 0n && !found.has(tx.txid)) found.set(tx.txid, { amount, blockhash: tx.blockhash });
        }
      };
      try {
        // Confirmed transactions come first, in a fixed order, so skip counts only those.
        for (let confirmed = 0; ; ) {
          const page = await client.searchRawTransactions(address, { skip: confirmed, count: pageSize });
          // A short page is everything that was left, in one reply.
          if (page.length < pageSize) {
            add(page);
            break;
          }
          const mined = page.filter((tx) => tx.blockhash !== undefined && tx.blockhash !== '');
          add(mined);
          confirmed += mined.length;
          if (mined.length < pageSize) {
            // The page ran into the mempool, which pearld lists in a different
            // order on every call: paging through it can miss transactions,
            // so all of it is read in one request.
            add(await client.searchRawTransactions(address, { skip: confirmed, count: MAX_SEARCH_COUNT }));
            break;
          }
        }
      } catch (err) {
        if (!isUnusedAddress(err)) throw err;
      }
      const heights = new Map<string, number>();
      const payments: AddressPayment[] = [];
      for (const [txid, { amount, blockhash }] of found) {
        payments.push({ txid, amount, block: await blockRef(blockhash, heights) });
      }
      return payments;
    },

    async getTransaction(txid): Promise<ChainTransaction | null> {
      let tx: TxRawResult;
      try {
        tx = await client.getRawTransaction(txid);
      } catch (err) {
        if (err instanceof PearlRpcError && err.code === RPC_ERROR_CODES.NO_TX_INFO) return null;
        throw err;
      }
      return { txid: tx.txid, block: await blockRef(tx.blockhash, new Map()) };
    },
  };
}

// pearld answers -5 for an address it has never seen, for a skip past the
// last transaction, and for an address it cannot decode; only the first two
// mean "nothing here".
function isUnusedAddress(err: unknown): boolean {
  return (
    err instanceof PearlRpcError &&
    err.code === RPC_ERROR_CODES.NO_TX_INFO &&
    err.message.includes('No information available about address')
  );
}

function rpcError(method: string, error: { code?: unknown; message?: unknown }): PearlRpcError {
  // btcjson.RPCError tags both fields omitempty, so either can be missing.
  const code = typeof error.code === 'number' ? error.code : 0;
  const message = typeof error.message === 'string' && error.message !== '' ? error.message : 'unknown error';
  return new PearlRpcError('rpc', method, `${message} (code ${code})`, { code });
}

function isErrorReply(reply: unknown): reply is { error: { code?: unknown; message?: unknown } } {
  const error = typeof reply === 'object' && reply !== null ? (reply as { error?: unknown }).error : undefined;
  return typeof error === 'object' && error !== null;
}

function httpMessage(response: Response, text: string, origin: string): string {
  const { status } = response;
  if (status === 401) return `${origin} rejected the RPC username or password (HTTP 401)`;
  // Go's TLS server answers plain HTTP with this 400.
  if (status === 400 && text.includes('HTTP request to an HTTPS server')) {
    return `${origin} serves TLS; use an https:// URL (HTTP 400)`;
  }
  if (status === 413) return `request too large for ${origin} (HTTP 413)`;
  if (status === 429 || status === 503) return `${origin} has too many RPC clients connected (HTTP ${status})`;
  const detail = text.trim().split('\n')[0] || response.statusText;
  return `HTTP ${status} from ${origin}${detail ? `: ${detail.slice(0, 120)}` : ''}`;
}

const TLS_TRUST_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

function networkMessage(err: unknown, origin: string): string {
  if (err instanceof Error && err.name === 'AbortError') return `request to ${origin} was aborted`;
  // Node's fetch throws TypeError("fetch failed") with the socket error as cause.
  const cause = err instanceof Error && err.cause instanceof Error ? err.cause : err;
  const code = typeof cause === 'object' && cause !== null ? (cause as { code?: unknown }).code : undefined;
  if (code === 'ECONNREFUSED') return `connection refused by ${origin}; is the server running with RPC enabled on that port?`;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `cannot resolve host ${origin}`;
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') return `connection to ${origin} timed out`;
  if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET') return `${origin} closed the connection`;
  if (typeof code === 'string' && TLS_TRUST_CODES.has(code)) {
    return `TLS certificate of ${origin} is not trusted (${code}); pass a fetch or dispatcher that trusts the server's rpc.cert`;
  }
  if (code === 'ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION') {
    return `TLS handshake with ${origin} failed (${code}); the server needs a newer TLS version, and Oyster only speaks TLS 1.3`;
  }
  if (code === 'ERR_SSL_WRONG_VERSION_NUMBER' || code === 'EPROTO') {
    return `TLS handshake with ${origin} failed (${code}); if the server runs with notls or noservertls, use an http:// URL`;
  }
  const detail = cause instanceof Error ? cause.message : String(cause);
  return `cannot reach ${origin}: ${typeof code === 'string' ? `${code} ` : ''}${detail}`;
}

const NUMBER_RE = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

/**
 * JSON.parse, except that numbers under the given keys become bigint grain.
 * Those numbers are quoted in the text first, so their digits never pass
 * through a float.
 */
export function parseJson(text: string, amountKeys: ReadonlySet<string> = new Set()): unknown {
  if (amountKeys.size === 0) return JSON.parse(text);
  let out = '';
  let copied = 0;
  let lastString = '';
  let underKey: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      lastString = text.slice(i + 1, j);
      underKey = null;
      i = j;
    } else if (c === ':') {
      underKey = lastString;
    } else if (c === '-' || (c >= '0' && c <= '9')) {
      NUMBER_RE.lastIndex = i;
      const match = NUMBER_RE.exec(text);
      if (match === null) break;
      if (underKey !== null && amountKeys.has(underKey)) {
        out += `${text.slice(copied, i)}"${match[0]}"`;
        copied = i + match[0].length;
      }
      underKey = null;
      i += match[0].length - 1;
    } else if (c !== ' ' && c !== '\n' && c !== '\r' && c !== '\t') {
      underKey = null;
    }
  }
  out += text.slice(copied);
  return JSON.parse(out, (key, value: unknown) =>
    amountKeys.has(key) && typeof value === 'string' ? decimalToGrain(value) : value,
  );
}

const DECIMAL_RE = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;

/**
 * A PRL JSON number as grains. Go writes float amounts in shortest form, so
 * "1e-8" and "12.345678" both occur; digits past the eighth decimal round half
 * away from zero, as btcutil.NewAmount does.
 */
export function decimalToGrain(text: string): bigint {
  const m = DECIMAL_RE.exec(text);
  if (m === null) throw new Error(`invalid PRL amount: ${JSON.stringify(text)}`);
  const [, sign, whole, frac = '', exp = '0'] = m;
  const shift = Number(exp);
  if (Math.abs(shift) > 40) throw new Error(`PRL amount out of range: ${text}`);
  const digits = whole! + frac;
  const point = whole!.length + shift;
  const padded = point < 0 ? '0'.repeat(-point) + digits : digits.padEnd(point, '0');
  const at = Math.max(point, 0);
  const intPart = padded.slice(0, at) || '0';
  const fracPart = padded.slice(at);
  const roundUp = fracPart.length > 8 && fracPart[8]! >= '5' ? 1n : 0n;
  const grain = parsePearl(fracPart === '' ? intPart : `${intPart}.${fracPart.slice(0, 8)}`) + roundUp;
  return sign === '-' ? -grain : grain;
}

// JSON.stringify with bigint grains written as exact PRL numbers.
function encodeJson(value: unknown): string {
  if (typeof value === 'bigint') return formatPearl(value);
  if (Array.isArray(value)) return `[${value.map((v) => encodeJson(v === undefined ? null : v)).join(',')}]`;
  if (typeof value === 'object' && value !== null && !(value instanceof Date)) {
    const fields = Object.entries(value).filter(([, v]) => v !== undefined);
    return `{${fields.map(([k, v]) => `${JSON.stringify(k)}:${encodeJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function base64(text: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) throw new Error('expected hex from the server');
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}
