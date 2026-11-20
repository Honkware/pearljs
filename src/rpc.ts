// JSON-RPC clients for pearld (node/rpcserver.go) and Oyster
// (wallet/rpc/jsonrpc), over fetch so they run in Node and browsers.
//
// Both servers take HTTP Basic auth on every POST to "/", serve TLS by default
// with a self-signed rpc.cert, and answer with HTTP 200 and a JSON-RPC 1.0
// envelope whose "error" carries the failure. There are no cookie files.
// Amounts arrive as PRL JSON numbers; they are converted to bigint grain from
// the response text, never through a JS number. Amount params are wrapped in
// prlAmount, which writes them as exact PRL numbers; a bare bigint param is
// written as the integer it is.
//
// The typed methods are mixins over anything with `call`, so the same set
// serves the fetch clients here, the websocket client in ws.ts, and any
// other transport through PearldRpc and OysterRpc.

/**
 * Typed JSON-RPC clients for pearld and Oyster over fetch, with transports,
 * retry, batching and one error type.
 *
 * @module
 */

import type { AddressPayment, BlockRef, ChainClient, ChainTransaction } from './client.js';
import { BASIC_FILTER_TYPE, checkFilterHeaders, decodeFilter, filterKey } from './gcs.js';
import type { BlockFilter } from './gcs.js';
import type { PearlNetworkName } from './networks.js';
import { fromHex, toHex as bytesToHex } from './internal/bytes.js';
import { Limiter } from './internal/limiter.js';
import { PrlAmount, UNBOUNDED_METHODS, basicAuth, encodeJson, isErrorReply, readBounded, readReply, rpcEndpoint, safeHeight } from './internal/rpc-wire.js';
import { PearlRpcError } from './errors.js';
import type { FeeRate } from './amount.js';

export { PearlRpcError };
export type { PrlAmount };
export type { RpcErrorKind } from './errors.js';

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

/**
 * Where Pearl's desktop wallet runs its Oyster, on mainnet and testnet2
 * alike: plain HTTP on loopback (--rpclisten=127.0.0.1:8335 --noservertls),
 * in SPV mode (--usespv). The username and password are the wallet's own
 * settings, not constants.
 */
export const DESKTOP_OYSTER_URL = 'http://127.0.0.1:8335';

/** Applied when neither the call nor the client names a timeout, in ms. */
export const DEFAULT_RPC_TIMEOUT = 60_000;

/**
 * Requests a client has in flight at once unless told otherwise. pearld
 * answers HTTP 503 to any past its --rpcmaxclients (10 by default), so this
 * leaves room for other clients of the same node.
 */
export const DEFAULT_MAX_CONCURRENT_REQUESTS = 4;

/**
 * The largest reply a client reads, in bytes, unless told otherwise: 64 MiB.
 * pearld reads requests of up to 16 MB (maxRequestSize, 4 * MaxBlockPayload),
 * and its largest ordinary reply, getblock with verbosity 2 for a block at
 * the 4 MB limit, decodes every input and output and comes to a few times
 * the block's size. A verbose getrawmempool of a full mempool can be larger;
 * raise the limit for that.
 */
export const DEFAULT_MAX_REPLY_SIZE = 64 * 1024 * 1024;

/** Where and how httpTransport sends requests. */
export interface HttpTransportOptions {
  /** Server URL, e.g. https://127.0.0.1:44107. Credentials in the URL are moved to the auth header. */
  readonly url: string | URL;
  readonly username?: string;
  readonly password?: string;
  /** Defaults to globalThis.fetch. */
  readonly fetch?: typeof fetch;
  /**
   * Merged into every request, e.g. `{ dispatcher }` with an undici Agent.
   * To trust a server's rpc.cert in Node, pass `fetch: pearldFetch({ ca })`
   * from pearljs/tls-fetch instead.
   */
  readonly init?: RequestInit & Record<string, unknown>;
  /** Limit per request in ms, 0 for none. Default DEFAULT_RPC_TIMEOUT, and none for generate, importprivkey and getblocktemplate. */
  readonly timeout?: number;
  /**
   * Basic auth over plain http:// sends the password in the clear, so it is
   * refused for any host but loopback unless this is set.
   */
  readonly allowInsecureAuth?: boolean;
  /** Replies longer than this many bytes fail with kind "response" before they are read in full. Default DEFAULT_MAX_REPLY_SIZE. */
  readonly maxReplySize?: number;
}

/** How a client retries read-only methods. */
export interface RetryOptions {
  /** Further tries after the first fails. Default 2. */
  readonly retries?: number;
  /** Delay before the first retry in ms; it doubles each time. Default 250. */
  readonly delay?: number;
  /** Default 5000. */
  readonly maxDelay?: number;
}

/** How a client gathers calls into JSON-RPC batches. */
export interface BatchOptions {
  /** How long to collect calls before sending them, in ms. Default 0, which gathers the calls of one tick. */
  readonly wait?: number;
  /** Most calls in one request. Default 100. */
  readonly maxSize?: number;
}

/** Options for PearldClient, OysterClient and JsonRpcClient. */
export interface RpcClientOptions extends Omit<HttpTransportOptions, 'url'> {
  /** Server URL; shorthand for `transport: httpTransport(...)` with the other HTTP options given here. */
  readonly url?: string | URL;
  /** Where requests go instead of `url`, e.g. a fallbackTransport. */
  readonly transport?: RpcTransport;
  /**
   * Retry read-only methods after a network failure or an HTTP 429 or 5xx,
   * with a doubling delay. Off by default. `true` is `{ retries: 2 }`, so
   * three tries in all, and a number is the retry count. Methods that send,
   * sign, create addresses or change server state are never retried, except
   * after a connection that timed out before it opened: no request was sent,
   * so every method is tried again, twice when `retry` is off.
   */
  readonly retry?: boolean | number | RetryOptions;
  /**
   * Requests in flight at once; the rest wait their turn, within their own
   * timeout and signal. Default DEFAULT_MAX_CONCURRENT_REQUESTS, 0 for no
   * limit. Calls with no time limit, such as getblocktemplate long polls,
   * have as many slots again of their own.
   */
  readonly maxConcurrentRequests?: number;
  /**
   * Send calls made close together as one JSON-RPC batch. pearld accepts
   * batches; Oyster does not, and OysterClient refuses the option. A call
   * with its own signal or timeout is sent alone.
   */
  readonly batch?: boolean | BatchOptions;
}

/** Per-call options: how to read numbers in the result, and when to give up. */
export interface CallOptions {
  /**
   * Object keys whose numeric values are PRL amounts, returned as bigint
   * grain. "result" names the result itself, as in getbalance, and "*" every
   * number inside the result, as in listaccounts.
   */
  readonly amounts?: readonly string[];
  /** Object keys whose integer values are returned as bigint, digit for digit: grain counts and 64-bit ids. */
  readonly integers?: readonly string[];
  /** Abandons the call when aborted. */
  readonly signal?: AbortSignal;
  /** Limit for this call in ms, 0 for none. */
  readonly timeout?: number;
}

/** Anything that can make a JSON-RPC call: the fetch clients, the websocket client, or your own. */
export interface Rpc {
  /** Calls a method and resolves to its result. Rejects with a PearlRpcError. */
  call<T = unknown>(method: string, params?: readonly unknown[], options?: CallOptions): Promise<T>;
}

/**
 * Codes from node/btcjson/jsonrpcerr.go that callers commonly branch on, to
 * compare with PearlRpcError.rpcCode. One name per number.
 *
 * -5 is the one to be careful with: Pearl uses it for an invalid address or
 * key, an unknown transaction, an unknown block and a missing index alike, so
 * the number alone does not say which. isUnknownTransaction tells a
 * transaction the server does not have from the rest.
 */
export const RPC_ERROR_CODES = {
  MISC: -1,
  WALLET: -4,
  INVALID_ADDRESS_OR_KEY: -5,
  INSUFFICIENT_FUNDS: -6,
  INVALID_PARAMETER: -8,
  CLIENT_NOT_CONNECTED: -9,
  WALLET_UNLOCK_NEEDED: -13,
  WALLET_PASSPHRASE_INCORRECT: -14,
  DESERIALIZATION: -22,
  VERIFY: -25,
  TX_REJECTED: -26,
  TX_ALREADY_IN_CHAIN: -27,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
} as const;

/**
 * The methods pearld lets its limited RPC user (--rpclimituser) call, from
 * rpcLimited in node/rpcserver.go. Everything else is refused with "limited
 * user not authorized for this method", code -32603 over HTTP and -32602 on
 * the websocket. Left out, among others: getblockchaininfo, getmempoolinfo,
 * getnetworkinfo, gettxspendingprevout, sendrawtransaction,
 * testmempoolaccept, and on the websocket the stopnotify commands.
 */
export const PEARLD_LIMITED_METHODS: ReadonlySet<string> = new Set([
  // Websocket only.
  'loadtxfilter',
  'notifyblocks',
  'notifynewtransactions',
  'notifyreceived',
  'notifyspent',
  'rescan',
  'rescanblocks',
  'session',
  // Both.
  'help',
  // HTTP, and the websocket, which takes any command.
  'createrawtransaction',
  'decoderawtransaction',
  'decodescript',
  'estimatefee',
  'getbestblock',
  'getbestblockhash',
  'getblock',
  'getblockcount',
  'getblockhash',
  'getblockheader',
  'getchaintips',
  'getcfilter',
  'getcfilterheader',
  'getcurrentnet',
  'getdifficulty',
  'getheaders',
  'getinfo',
  'getnettotals',
  'getnetworkhashps',
  'getrawmempool',
  'getrawtransaction',
  'gettxout',
  'searchrawtransactions',
  'uptime',
  'validateaddress',
  'verifymessage',
  'version',
]);

/** Whether an error is pearld refusing a method to its limited RPC user. */
export function isLimitedUserRefusal(err: unknown): boolean {
  return err instanceof PearlRpcError && err.kind === 'rpc' && err.message.includes('limited user not authorized');
}

/**
 * Marks a param as an amount in grains, sent as the exact PRL number the
 * servers expect: `call('sendtoaddress', [address, prlAmount(150000000n), prlAmount(1000n)])`.
 * A bare bigint is sent as an integer, which is right for heights and counts
 * and wrong by a factor of 10^8 for an amount.
 */
export function prlAmount(grain: bigint): PrlAmount {
  return new PrlAmount(grain);
}

// Transports

/** What a transport is told about the request it carries. */
export interface RpcRequestInfo {
  /** For error messages, and for the default timeout. */
  readonly method: string;
  readonly signal?: AbortSignal;
  readonly timeout?: number;
}

/** Carries request bodies to a server. httpTransport and fallbackTransport make them; a custom one can add signing, a proxy or a mock. */
export interface RpcTransport {
  /** host:port, for messages. */
  readonly origin: string;
  /** Sends one body and returns the reply text. Fails with a PearlRpcError of kind "network" or "http". */
  send(body: string, request: RpcRequestInfo): Promise<string>;
}

/**
 * POSTs to one pearld or Oyster with Basic auth. Redirects are refused, not
 * followed: a 307 or 308 would send the body, which can hold a wallet
 * passphrase or a private key, to wherever the server pointed.
 */
export function httpTransport(options: HttpTransportOptions): RpcTransport {
  const endpoint = rpcEndpoint(options);
  if (endpoint.url.protocol !== 'http:' && endpoint.url.protocol !== 'https:') {
    throw new TypeError(`not an HTTP URL: ${endpoint.url.protocol}`);
  }
  const url = endpoint.url.href;
  const origin = endpoint.url.host;
  const auth = endpoint.username || endpoint.password ? basicAuth(endpoint.username, endpoint.password) : undefined;
  const fetcher = options.fetch ?? globalThis.fetch;
  if (typeof fetcher !== 'function') throw new TypeError('no fetch implementation available');
  const init = options.init ?? {};
  const maxReplySize = options.maxReplySize ?? DEFAULT_MAX_REPLY_SIZE;
  if (!Number.isSafeInteger(maxReplySize) || maxReplySize < 1) throw new RangeError('maxReplySize must be a positive integer');

  return {
    origin,
    async send(body, request) {
      const { method } = request;
      const timeout = request.timeout ?? options.timeout ?? (UNBOUNDED_METHODS.has(method) ? 0 : DEFAULT_RPC_TIMEOUT);
      const headers = new Headers(init.headers);
      headers.set('Content-Type', 'application/json');
      if (auth !== undefined) headers.set('Authorization', auth);

      // One controller for the caller's signal, the client's and the timeout.
      // The fetch is also raced against it, for a fetch that ignores signals.
      const controller = new AbortController();
      let timedOut = false;
      const signals = [request.signal, init.signal].filter((s): s is AbortSignal => s !== undefined && s !== null);
      const onAbort = () => controller.abort();
      for (const signal of signals) {
        if (signal.aborted) controller.abort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
      const timer =
        timeout > 0
          ? setTimeout(() => {
              timedOut = true;
              controller.abort();
            }, timeout)
          : undefined;
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
          response = await Promise.race([
            fetcher(url, { ...init, method: 'POST', headers, body, signal: controller.signal, redirect: 'manual' }),
            aborted,
          ]);
          if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
            void response.body?.cancel().catch(() => {});
            const status = response.status === 0 ? '' : ` (HTTP ${response.status})`;
            throw new PearlRpcError('http', method, `${origin} answered with a redirect${status}, which is not followed: it would resend the request, credentials and all, elsewhere`, {
              status: response.status,
            });
          }
          text = await Promise.race([readBounded(response, maxReplySize, method, origin), aborted]);
        } catch (err) {
          if (err instanceof PearlRpcError) throw err;
          const message = timedOut ? `no reply from ${origin} within ${timeout} ms` : networkMessage(err, origin);
          throw new PearlRpcError('network', method, message, { cause: err });
        }
        // A server that answers an RPC error with an HTTP error status still gets its error read.
        if (!response.ok && !holdsErrorReply(text)) {
          throw new PearlRpcError('http', method, httpMessage(response, text, origin), { status: response.status });
        }
        return text;
      } finally {
        clearTimeout(timer);
        for (const signal of signals) signal.removeEventListener('abort', onAbort);
      }
    },
  };
}

/** Options for fallbackTransport. */
export interface FallbackOptions {
  /** Whether a failure moves on to the next transport. Default: every "network" and "http" failure. */
  readonly shouldFallback?: (error: PearlRpcError) => boolean;
}

/**
 * Tries each transport in order until one answers. An RPC error reply is an answer and is not retried elsewhere,
 * and a call the caller aborted stops at once. A send that timed out on one
 * server may still have reached it: the next server can then answer that it
 * already has the transaction.
 */
export function fallbackTransport(transports: readonly RpcTransport[], options: FallbackOptions = {}): RpcTransport {
  if (transports.length === 0) throw new TypeError('fallbackTransport needs at least one transport');
  const shouldFallback = options.shouldFallback ?? (() => true);
  return {
    origin: transports.map((t) => t.origin).join(', '),
    async send(body, request) {
      let last: unknown;
      for (const transport of transports) {
        try {
          return await transport.send(body, request);
        } catch (err) {
          last = err;
          if (request.signal?.aborted || !(err instanceof PearlRpcError) || !shouldFallback(err)) throw err;
        }
      }
      throw last;
    },
  };
}

// Methods that only read, so sending them twice is harmless. Left out on
// purpose: anything that sends or signs, getnewaddress and
// getrawchangeaddress (each call takes an address), and getblocktemplate.
const IDEMPOTENT_METHODS = new Set([
  'chainsynced',
  'createrawtransaction',
  'decoderawtransaction',
  'decodescript',
  'estimatefee',
  'getaccount',
  'getaddednodeinfo',
  'getaddressesbyaccount',
  'getbalance',
  'getbestblock',
  'getbestblockhash',
  'getblock',
  'getblockchaininfo',
  'getblockcount',
  'getblockhash',
  'getblockheader',
  'getcfilter',
  'getcfilterheader',
  'getchaintips',
  'getconnectioncount',
  'getcurrentnet',
  'getdifficulty',
  'getgenerate',
  'getheaders',
  'getinfo',
  'getmempoolinfo',
  'getmininginfo',
  'getnettotals',
  'getnetworkhashps',
  'getnetworkinfo',
  'getnodeaddresses',
  'getpeerinfo',
  'getrawmempool',
  'getrawtransaction',
  'getreceivedbyaccount',
  'getreceivedbyaddress',
  'getsyncprogress',
  'gettransaction',
  'gettxout',
  'gettxspendingprevout',
  'getunconfirmedbalance',
  'listaccounts',
  'listaddresstransactions',
  'listalltransactions',
  'listlockunspent',
  'listreceivedbyaccount',
  'listreceivedbyaddress',
  'listsinceblock',
  'listtransactions',
  'listunspent',
  'searchrawtransactions',
  'testmempoolaccept',
  'uptime',
  'validateaddress',
  'verifychain',
  'verifymessage',
  'version',
  'walletislocked',
]);

interface Queued {
  readonly id: number;
  readonly method: string;
  readonly body: string;
  readonly options: CallOptions;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
}

/** A bare JSON-RPC client; PearldClient and OysterClient add typed methods. */
export class JsonRpcClient implements Rpc {
  readonly #transport: RpcTransport;
  readonly #retry: Required<RetryOptions> | null;
  readonly #batch: Required<BatchOptions> | null;
  readonly #slots: Limiter;
  readonly #unbounded: Limiter;
  // The default limit of the transport the client made from `url`, or null for a transport given to it.
  readonly #timeout: number | undefined | null;
  #queue: Queued[] = [];
  #flushTimer: ReturnType<typeof setTimeout> | undefined;
  #id = 0;

  constructor(options: RpcClientOptions) {
    const { url, transport, retry = false, batch = false, maxConcurrentRequests = DEFAULT_MAX_CONCURRENT_REQUESTS, ...http } = options;
    if (!Number.isSafeInteger(maxConcurrentRequests) || maxConcurrentRequests < 0) throw new RangeError('maxConcurrentRequests must be a whole number, 0 for no limit');
    this.#slots = new Limiter(maxConcurrentRequests);
    this.#unbounded = new Limiter(maxConcurrentRequests);
    if ((url === undefined) === (transport === undefined)) throw new TypeError('give either url or transport');
    this.#timeout = transport === undefined ? http.timeout : null;
    this.#transport = transport ?? httpTransport({ ...http, url: url! });
    this.#retry =
      retry === false
        ? null
        : { retries: 2, delay: 250, maxDelay: 5000, ...(typeof retry === 'number' ? { retries: retry } : retry === true ? {} : retry) };
    this.#batch = batch === false ? null : { wait: 0, maxSize: 100, ...(batch === true ? {} : batch) };
  }

  /** Calls any method. Wrap amounts among the params in prlAmount. */
  async call<T = unknown>(method: string, params: readonly unknown[] = [], options: CallOptions = {}): Promise<T> {
    const id = ++this.#id;
    // pearld rejects requests without params or with a null id.
    const body = encodeJson({ jsonrpc: '1.0', id, method, params });
    const alone = options.signal !== undefined || options.timeout !== undefined || UNBOUNDED_METHODS.has(method);
    if (this.#batch === null || alone) {
      const info: RpcRequestInfo = {
        method,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
      };
      const text = await this.#send(body, info, IDEMPOTENT_METHODS.has(method));
      return readReply<T>(text, method, id, options, this.#transport.origin);
    }
    return new Promise<T>((resolve, reject) => {
      this.#queue.push({ id, method, body, options, resolve: resolve as (value: unknown) => void, reject });
      if (this.#queue.length >= this.#batch!.maxSize) this.#flush();
      else this.#flushTimer ??= setTimeout(() => this.#flush(), this.#batch!.wait);
    });
  }

  async #send(body: string, info: RpcRequestInfo, idempotent: boolean): Promise<string> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.#limited(info, (sent) => this.#transport.send(body, sent));
      } catch (err) {
        // A 503 is pearld's --rpcmaxclients turning the request away unread, so a read is retried even without `retry`.
        // A connection that never opened carried no request, so trying again cannot send anything twice.
        const retry = connectTimedOut(err) ? (this.#retry ?? BUSY_RETRY) : !idempotent ? null : (this.#retry ?? (isBusy(err) ? BUSY_RETRY : null));
        if (retry === null || attempt >= retry.retries || info.signal?.aborted || !isTransient(err)) throw err;
        await new Promise((resolve) => setTimeout(resolve, Math.min(retry.maxDelay, retry.delay * 2 ** attempt)));
      }
    }
  }

  // A call waits for a slot within its own time limit and signal, and is sent with what is left of the limit. One
  // with no limit, such as a getblocktemplate long poll, waits among its own kind, so it never holds a slot that a
  // bounded call is waiting for.
  async #limited(info: RpcRequestInfo, run: (info: RpcRequestInfo) => Promise<string>): Promise<string> {
    const limit = info.timeout ?? (this.#timeout === null ? undefined : (this.#timeout ?? (UNBOUNDED_METHODS.has(info.method) ? 0 : DEFAULT_RPC_TIMEOUT)));
    const slots = limit === 0 || (limit === undefined && UNBOUNDED_METHODS.has(info.method)) ? this.#unbounded : this.#slots;
    const origin = this.#transport.origin;
    const started = Date.now();
    const release = await slots.acquire({ signal: info.signal, timeout: limit }, (reason) => {
      if (reason === 'timeout') return new PearlRpcError('network', info.method, `no reply from ${origin} within ${limit} ms`);
      const cause = new DOMException('The operation was aborted', 'AbortError');
      return new PearlRpcError('network', info.method, networkMessage(cause, origin), { cause });
    });
    const waited = Date.now() - started;
    try {
      return await run(limit === undefined || limit === 0 || waited === 0 ? info : { ...info, timeout: Math.max(1, limit - waited) });
    } catch (err) {
      // The transport timed out on what was left of the limit; the caller set the whole of it.
      if (waited > 0 && limit !== undefined && limit > 0 && err instanceof PearlRpcError && err.kind === 'network' && Date.now() - started >= limit) {
        throw new PearlRpcError('network', info.method, `no reply from ${origin} within ${limit} ms`, { cause: err });
      }
      throw err;
    } finally {
      release();
    }
  }

  #flush(): void {
    clearTimeout(this.#flushTimer);
    this.#flushTimer = undefined;
    const entries = this.#queue;
    this.#queue = [];
    if (entries.length === 0) return;
    const origin = this.#transport.origin;
    const single = entries.length === 1;
    const body = single ? entries[0]!.body : `[${entries.map((e) => e.body).join(',')}]`;
    const method = single ? entries[0]!.method : 'batch';
    this.#send(body, { method }, entries.every((e) => IDEMPOTENT_METHODS.has(e.method))).then(
      (text) => {
        // pearld answers a batch with an array in request order, and anything
        // it could not read as a batch with one error object.
        const replies = single ? [text] : splitJsonArray(text);
        const byId = new Map<unknown, string>();
        for (const reply of replies ?? []) {
          try {
            byId.set((JSON.parse(reply) as { id?: unknown }).id, reply);
          } catch {
            // Reported below, to the calls left without a reply.
          }
        }
        for (const entry of entries) {
          try {
            if (replies === null) {
              // readReply throws the error the server gave for the whole batch.
              readReply(text, entry.method, null, {}, origin);
              throw new PearlRpcError('response', entry.method, `expected a batch reply from ${origin}, got ${JSON.stringify(text.slice(0, 120))}`);
            }
            const reply = single ? text : byId.get(entry.id);
            if (reply === undefined) {
              throw new PearlRpcError('response', entry.method, `${origin} left this call out of its batch reply`);
            }
            entry.resolve(readReply(reply, entry.method, entry.id, entry.options, origin));
          } catch (err) {
            entry.reject(err);
          }
        }
      },
      (err: unknown) => {
        for (const entry of entries) entry.reject(err instanceof PearlRpcError ? renamed(err, entry.method) : err);
      },
    );
  }
}

const BUSY_RETRY: Required<RetryOptions> = { retries: 2, delay: 250, maxDelay: 5000 };

function isBusy(err: unknown): boolean {
  return err instanceof PearlRpcError && err.kind === 'http' && err.status === 503;
}

// undici's connect timeout, or the kernel's from connect(2). ETIMEDOUT from a read on an open socket has another syscall.
function connectTimedOut(err: unknown): boolean {
  if (!(err instanceof PearlRpcError) || err.kind !== 'network') return false;
  let cause: unknown = err.cause;
  for (let depth = 0; depth < 4 && typeof cause === 'object' && cause !== null; depth++) {
    const { code, syscall } = cause as { code?: unknown; syscall?: unknown };
    if (code === 'UND_ERR_CONNECT_TIMEOUT' || (code === 'ETIMEDOUT' && syscall === 'connect')) return true;
    cause = (cause as { cause?: unknown }).cause;
  }
  return false;
}

function isTransient(err: unknown): boolean {
  if (!(err instanceof PearlRpcError)) return false;
  return err.kind === 'network' || (err.kind === 'http' && (err.status === 429 || (err.status ?? 0) >= 500));
}

// The same failure under another method's name, for the calls of a batch.
function renamed(err: PearlRpcError, method: string): PearlRpcError {
  return new PearlRpcError(err.kind, method, err.message.slice(err.method.length + 2), {
    ...(err.rpcCode === undefined ? {} : { rpcCode: err.rpcCode }),
    ...(err.status === undefined ? {} : { status: err.status }),
    cause: err.cause,
  });
}

// The texts of a JSON array's elements, so each batch reply keeps its own
// digits for amount conversion. null when the text is not an array.
function splitJsonArray(text: string): string[] | null {
  const start = text.search(/\S/);
  if (start < 0 || text[start] !== '[') return null;
  const parts: string[] = [];
  let depth = 0;
  let from = start + 1;
  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
    } else if (c === '[' || c === '{') {
      depth++;
    } else if (c === ']' || c === '}') {
      depth--;
      if (depth === 0) {
        if (text.slice(from, i).trim() !== '') parts.push(text.slice(from, i));
        return parts;
      }
    } else if (c === ',' && depth === 1) {
      parts.push(text.slice(from, i));
      from = i + 1;
    }
  }
  return null;
}

// pearld results

/** The script classes pearld names (scriptClassToName, node/txscript/standard.go). */
export type ScriptType = 'nonstandard' | 'nulldata' | 'witness_v1_taproot' | 'witness_v2_merkleroot';

/** The network a node runs on, as getblockchaininfo names it (chaincfg Params.Name). pearld can run signet; pearljs has no network object for it. */
export type ChainName = PearlNetworkName | 'signet';

/** A chain tip's status (blockchain.TipStatus); anything else Pearl prints as "unknown: " and the flag bits. */
export type ChainTipStatus = 'active' | 'invalid' | 'valid-fork' | `unknown: ${string}`;

/** A BIP9 deployment's state, as getblockchaininfo names it (softForkStatus, node/rpcserver.go). */
export type SoftForkStatus = 'defined' | 'started' | 'lockedin' | 'active' | 'failed';

/** An output script as pearld decodes it. */
export interface ScriptPubKeyResult {
  readonly asm: string;
  readonly hex?: string;
  /** Deprecated in Bitcoin Core, still sent by Pearl. */
  readonly reqSigs?: number;
  readonly type: ScriptType;
  readonly address?: string;
  readonly addresses?: string[];
}

/** A transaction output in a decoded transaction. */
export interface RpcVout {
  /** Grains. */
  readonly value: bigint;
  readonly n: number;
  readonly scriptPubKey: ScriptPubKeyResult;
}

/** A transaction input in a decoded transaction: a coinbase input, or one that spends an output. */
export type RpcVin =
  | { readonly coinbase: string; readonly sequence: number; /** The coinbase's witness, under this name on coinbase inputs only. */ readonly witness?: string[] }
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

/** A BIP9 deployment in getblockchaininfo. */
export interface Bip9SoftForkDescription {
  readonly status: SoftForkStatus;
  readonly bit: number;
  readonly startTime: number;
  readonly start_time: number;
  readonly timeout: number;
  readonly since: number;
  readonly min_activation_height: number;
}

/** getblockchaininfo (btcjson.GetBlockChainInfoResult). */
export interface BlockchainInfo {
  readonly chain: ChainName;
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

/** One transaction in getrawmempool's verbose result. */
export interface MempoolEntry {
  readonly size: number;
  readonly vsize: number;
  /** Grains. */
  readonly fee: bigint;
  readonly time: number;
  readonly height: number;
  readonly depends: string[];
}

/** testmempoolaccept's verdict on one transaction. */
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

/** Options for searchRawTransactions. */
export interface SearchOptions {
  readonly skip?: number;
  /** pearld caps this at 10000. */
  readonly count?: number;
  readonly reverse?: boolean;
  /** Adds `prevOut`, the spent output's addresses and value, to every input. */
  readonly vinExtra?: boolean;
}

/** getblock with verbosity 1 (btcjson.GetBlockVerboseResult). */
export interface BlockResult {
  /** As the caller wrote it; pearld echoes the hash it was asked for. */
  readonly hash: string;
  readonly confirmations: number;
  readonly size: number;
  readonly strippedsize: number;
  readonly vsize: number;
  readonly height: number;
  readonly version: number;
  readonly versionHex: string;
  readonly merkleroot: string;
  /** Transaction ids, in block order. */
  readonly tx: string[];
  readonly time: number;
  readonly bits: string;
  readonly difficulty: number;
  /** All zeros for the genesis block. */
  readonly previousblockhash: string;
  readonly nextblockhash?: string;
  readonly proofcommitment: string;
}

/** getblock with verbosity 2. pearld puts the transactions under `rawtx`, where Bitcoin Core uses `tx`. */
export interface BlockWithTransactionsResult extends Omit<BlockResult, 'tx'> {
  readonly rawtx: TxRawResult[];
}

/** getbestblock, on pearld and Oyster. */
export interface BestBlockResult {
  readonly hash: string;
  readonly height: number;
}

/** One entry of getchaintips. */
export interface ChainTip {
  readonly height: number;
  readonly hash: string;
  /** Blocks between this tip and the best chain; 0 for the best chain itself. */
  readonly branchlen: number;
  /** "active" for the best chain, "valid-fork" for a branch with its blocks stored, "invalid" for one containing an invalid block. */
  readonly status: ChainTipStatus;
}

/** gettxspendingprevout. pearld looks in the mempool only, so a spend that has confirmed is not reported. */
export interface TxSpendingPrevOut {
  readonly txid: string;
  readonly vout: number;
  /** The mempool transaction spending the output, if there is one. */
  readonly spendingtxid?: string;
}

/** decoderawtransaction (btcjson.TxRawDecodeResult). */
export interface DecodedTransaction {
  readonly txid: string;
  readonly version: number;
  readonly locktime: number;
  readonly vin: RpcVin[];
  readonly vout: RpcVout[];
}

/** decodescript (btcjson.DecodeScriptResult). */
export type DecodedScript = Omit<ScriptPubKeyResult, 'hex'>;

/** pearld's validateaddress (btcjson.ValidateAddressChainResult). Only `isvalid` is sent for an invalid address. */
export interface ValidateAddressResult {
  readonly isvalid: boolean;
  readonly address?: string;
  readonly iswitness?: boolean;
  readonly witness_version?: number;
  readonly witness_program?: string;
}

/** pearld's getinfo (btcjson.InfoChainResult). */
export interface NodeInfo {
  readonly version: number;
  readonly protocolversion: number;
  readonly blocks: number;
  readonly timeoffset: number;
  readonly connections: number;
  readonly proxy: string;
  readonly difficulty: number;
  readonly testnet: boolean;
  /** --minrelaytxfee, grain per 1000 vbytes. */
  readonly relayfee: bigint;
  readonly errors: string;
}

/** getnetworkinfo (btcjson.GetNetworkInfoResult). */
export interface NetworkInfo {
  readonly version: number;
  readonly subversion: string;
  readonly protocolversion: number;
  readonly localservices: string;
  readonly localservicesnames: string[];
  readonly localrelay: boolean;
  readonly timeoffset: number;
  readonly connections: number;
  readonly connections_in: number;
  readonly connections_out: number;
  readonly networkactive: boolean;
  readonly networks: {
    /** The three pearld lists (node/rpcserver.go, handleGetNetworkInfo). */
    readonly name: 'ipv4' | 'ipv6' | 'onion';
    readonly limited: boolean;
    readonly reachable: boolean;
    readonly proxy: string;
    readonly proxy_randomize_credentials: boolean;
  }[];
  /** Grain per 1000 vbytes. */
  readonly relayfee: bigint;
  /** pearld reports its relay fee here too. */
  readonly incrementalfee: bigint;
  readonly localaddresses: { readonly address: string; readonly port: number; readonly score: number }[];
  readonly warnings: string[];
}

/** getpeerinfo (btcjson.GetPeerInfoResult). */
export interface PeerInfo {
  readonly id: number;
  readonly addr: string;
  readonly addrlocal?: string;
  readonly services: string;
  readonly relaytxes: boolean;
  readonly lastsend: number;
  readonly lastrecv: number;
  readonly bytessent: number;
  readonly bytesrecv: number;
  readonly conntime: number;
  readonly timeoffset: number;
  /** Microseconds, where Bitcoin Core reports seconds. */
  readonly pingtime: number;
  readonly pingwait?: number;
  readonly version: number;
  readonly subver: string;
  readonly inbound: boolean;
  readonly startingheight: number;
  readonly currentheight?: number;
  readonly banscore: number;
  /** The peer's feefilter, grain per 1000 vbytes. */
  readonly feefilter: bigint;
  readonly syncnode: boolean;
  readonly v2_connection: boolean;
}

/** getmininginfo (btcjson.GetMiningInfoResult). */
export interface MiningInfo {
  readonly blocks: number;
  readonly currentblocksize: number;
  readonly currentblockvsize: number;
  readonly currentblocktx: number;
  readonly difficulty: number;
  readonly errors: string;
  readonly generate: boolean;
  readonly genproclimit: number;
  readonly networkhashps: number;
  readonly pooledtx: number;
  readonly testnet: boolean;
}

/** The request object of getblocktemplate (btcjson.TemplateRequest), template mode. */
export interface BlockTemplateRequest {
  /** "coinbasetxn" asks for a coinbase paying --miningaddr; pearld sends only `coinbasevalue` otherwise. */
  readonly capabilities?: readonly string[];
  /** Waits for a new template instead of returning the one this id names. */
  readonly longpollid?: string;
  readonly rules?: readonly string[];
}

/** A transaction in a block template. */
export interface BlockTemplateTransaction {
  readonly data: string;
  /** The witness transaction id. */
  readonly hash: string;
  readonly txid: string;
  /** 1-based positions in `transactions` of the transactions this one spends. */
  readonly depends: number[];
  /** Grains. */
  readonly fee: bigint;
  readonly vsize: number;
}

/** getblocktemplate (btcjson.GetBlockTemplateResult). */
export interface BlockTemplate {
  readonly bits: string;
  readonly curtime: number;
  readonly height: number;
  readonly previousblockhash: string;
  readonly vsizelimit?: number;
  readonly transactions: BlockTemplateTransaction[];
  readonly version: number;
  readonly coinbaseaux?: { readonly flags: string };
  readonly coinbasetxn?: BlockTemplateTransaction;
  /** Subsidy plus fees, in grains. */
  readonly coinbasevalue?: bigint;
  readonly default_witness_commitment?: string;
  readonly longpollid?: string;
  readonly longpolluri?: string;
  readonly submitold?: boolean;
  readonly target?: string;
  readonly expires?: number;
  readonly maxtime?: number;
  readonly mintime?: number;
  readonly mutable?: string[];
  readonly noncerange?: string;
  readonly capabilities?: string[];
  /** Pearl's addition: the certificate version a block at `height` must carry (1 to 4). */
  readonly requiredcertversion: number;
  /**
   * Pearl's addition for V4 templates only: hex of the full 108-byte headers
   * of up to four most recent ancestors, parent first. A V4 proof is keyed by
   * one of them and its certificate carries the ones in between.
   */
  readonly ancestorheaders?: string[];
}

/** An output named by transaction id (display hex) and output index. */
export interface OutPointParam {
  readonly txid: string;
  readonly vout: number;
}

/** getnettotals (btcjson.GetNetTotalsResult). Byte counts are bigint, as uint64s may pass 2^53. */
export interface NetTotals {
  readonly totalbytesrecv: bigint;
  readonly totalbytessent: bigint;
  /** The node's clock, Unix milliseconds. */
  readonly timemillis: number;
}

/** One API's version in the version result (btcjson.VersionResult). pearld reports one, "pearldjsonrpcapi". */
export interface VersionInfo {
  readonly versionstring: string;
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: string;
  readonly buildmetadata: string;
}

/** A peer address the node knows (btcjson.GetNodeAddressesResult). */
export interface NodeAddress {
  /** When the node last heard of the address, Unix seconds. */
  readonly time: number;
  /** Service flags, a uint64 bit field. */
  readonly services: bigint;
  readonly address: string;
  readonly port: number;
}

/** getaddednodeinfo with dns true (btcjson.GetAddedNodeInfoResult). */
export interface AddedNodeInfo {
  readonly addednode: string;
  readonly connected?: boolean;
  /** The addresses the name resolved to, with the direction of the connection to each, or "false" for none. */
  readonly addresses?: { readonly address: string; readonly connected: 'inbound' | 'outbound' | 'false' }[];
}

/** A class whose instances can `call`: what pearldMethods and oysterMethods extend. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- TypeScript requires this constructor shape of a mixin base.
export type RpcClass = abstract new (...args: any[]) => Rpc;

/**
 * pearld's typed methods, written once over `call`. PearldClient, PearldRpc
 * and PearlWsClient carry them; pearldMethods puts them on another class.
 */
export abstract class PearldMethods implements Rpc {
  /** Calls a method and resolves to its result; the class this is mixed into supplies it. */
  abstract call<T = unknown>(method: string, params?: readonly unknown[], options?: CallOptions): Promise<T>;

  /** getblockchaininfo: the chain, its height, best block hash, difficulty and median time. */
  getBlockchainInfo(): Promise<BlockchainInfo> {
    return this.call('getblockchaininfo');
  }

  /** Height of the best chain's tip. */
  getBlockCount(): Promise<number> {
    return this.call('getblockcount');
  }

  /** Hash of the best chain's tip, display hex. */
  getBestBlockHash(): Promise<string> {
    return this.call('getbestblockhash');
  }

  /** Height and hash of the tip from one snapshot. */
  getBestBlock(): Promise<BestBlockResult> {
    return this.call('getbestblock');
  }

  /** Hash of the block at a height on the best chain. */
  getBlockHash(height: number): Promise<string> {
    return this.call('getblockhash', [height]);
  }

  /** The serialized block, certificate first, as hex. */
  getBlockHex(hash: string): Promise<string> {
    return this.call('getblock', [hash, 0]);
  }

  /** The serialized block as bytes, ready for parseBlock. */
  async getRawBlock(hash: string): Promise<Uint8Array> {
    return fromHex(await this.getBlockHex(hash), 'expected hex from the server');
  }

  /** The block's header fields, sizes and transaction ids. */
  getBlock(hash: string): Promise<BlockResult> {
    return this.call('getblock', [hash, 1]);
  }

  /** The block with every transaction decoded, output values in grains. */
  getBlockWithTransactions(hash: string): Promise<BlockWithTransactionsResult> {
    return this.call('getblock', [hash, 2], { amounts: ['value'] });
  }

  /** The block's header fields, decoded. Code -5 for a hash pearld does not know. */
  getBlockHeader(hash: string): Promise<BlockHeaderResult> {
    return this.call('getblockheader', [hash, true]);
  }

  /** The block's 108-byte header as bytes, ready for parseBlockHeader. Code -5 for a hash pearld does not know. */
  async getRawBlockHeader(hash: string): Promise<Uint8Array> {
    return fromHex(await this.call<string>('getblockheader', [hash, false]), 'expected hex from the server');
  }

  /**
   * Headers after the first locator on the best chain, up to hashStop or
   * 100 of them (wire.MaxBlockHeadersPerMsg). Each is hex of the block as
   * serialized without its transactions: the certificate, then the 108-byte
   * header.
   */
  getHeaders(blockLocators: readonly string[], hashStop = ''): Promise<string[]> {
    return this.call('getheaders', [[...blockLocators], hashStop]);
  }

  /** Every chain tip pearld knows, the best chain and side branches. */
  getChainTips(): Promise<ChainTip[]> {
    return this.call('getchaintips');
  }

  /** Difficulty of the tip, relative to the network's powLimitBits; see difficultyForBits. */
  getDifficulty(): Promise<number> {
    return this.call('getdifficulty');
  }

  /** Estimated network hashes per second over the last `blocks` blocks ending at `height`, -1 for the tip. */
  getNetworkHashPs(blocks = 120, height = -1): Promise<number> {
    return this.call('getnetworkhashps', [blocks, height]);
  }

  /** getmininginfo: height, difficulty, network hash rate and what the built-in miner is doing. */
  getMiningInfo(): Promise<MiningInfo> {
    return this.call('getmininginfo');
  }

  /**
   * A block template in template mode. `coinbasevalue` and each
   * transaction's `fee` are grains; `requiredcertversion` says which
   * certificate version the block must carry, and a V4 template lists the
   * headers its proof may be keyed by in `ancestorheaders`.
   */
  getBlockTemplate(request: BlockTemplateRequest = {}, options: Pick<CallOptions, 'signal' | 'timeout'> = {}): Promise<BlockTemplate> {
    return this.call('getblocktemplate', [request], { ...options, integers: ['fee', 'coinbasevalue'] });
  }

  /**
   * Submits a mined block. pearld answers a block it refuses with the
   * string "rejected: ..." as a successful result; that becomes a
   * PearlRpcError of kind "rpc" with code -25 here.
   */
  async submitBlock(block: string | Uint8Array): Promise<void> {
    const result = await this.call<string | null>('submitblock', [toHex(block)]);
    if (typeof result === 'string') throw new PearlRpcError('rpc', 'submitblock', result, { rpcCode: RPC_ERROR_CODES.VERIFY });
  }

  /**
   * Mines blocks to --miningaddr and returns their hashes; regtest and
   * simnet only. Every block is proven, seconds each, so no default
   * timeout applies.
   */
  generate(blocks: number, options: Pick<CallOptions, 'signal' | 'timeout'> = {}): Promise<string[]> {
    return this.call('generate', [blocks], options);
  }

  /** Mempool transactions only, unless pearld runs with --txindex. */
  getRawTransactionHex(txid: string): Promise<string> {
    return this.call('getrawtransaction', [txid, 0]);
  }

  /**
   * The transaction decoded, output values in grain. Mempool transactions
   * only, unless pearld runs with --txindex.
   */
  getRawTransaction(txid: string): Promise<TxRawResult> {
    return this.call('getrawtransaction', [txid, 1], { amounts: ['value'] });
  }

  /** Decodes a serialized transaction without looking it up. Output values are in grain. */
  decodeRawTransaction(tx: string | Uint8Array): Promise<DecodedTransaction> {
    return this.call('decoderawtransaction', [toHex(tx)], { amounts: ['value'] });
  }

  /** Decodes a script: its disassembly, type and address. */
  decodeScript(script: string | Uint8Array): Promise<DecodedScript> {
    return this.call('decodescript', [toHex(script)]);
  }

  /** Whether pearld can decode the address for its network. It never throws for a bad one. */
  validateAddress(address: string): Promise<ValidateAddressResult> {
    return this.call('validateaddress', [address]);
  }

  /** Returns the txid. pearld ignores Bitcoin Core's maxfeerate argument, so none is sent. */
  sendRawTransaction(tx: string | Uint8Array): Promise<string> {
    return this.call('sendrawtransaction', [toHex(tx)]);
  }

  /**
   * maxFeeRate is grain per 1000 vbytes. pearld refuses the call without it,
   * and reads 0, sent when none is given, as its default of 10000000 (0.1
   * PRL/kvB). A transaction above the rate is refused as "max-fee-exceeded".
   */
  async testMempoolAccept(txs: readonly (string | Uint8Array)[], maxFeeRate: FeeRate = 0n): Promise<TestMempoolAcceptResult[]> {
    const results = await this.call<Omit<TestMempoolAcceptResult, 'allowed'>[]>(
      'testmempoolaccept',
      [txs.map(toHex), prlAmount(maxFeeRate)],
      { amounts: ['base', 'effective-feerate'] },
    );
    return results.map((r) => ({ ...r, allowed: (r as { allowed?: boolean }).allowed === true }));
  }

  /**
   * estimatefee: a fee rate in grain per 1000 vbytes, for 1 to 25 blocks. It is 0 until
   * pearld has seen transactions confirm, so floor it at the relay fee. A
   * node that has connected fewer than three blocks answers with an error
   * of code -1, and so does this method for a server that answers -1, as
   * Bitcoin Core's estimatefee did. pearld has no estimatesmartfee.
   */
  async estimateFee(blocks: number): Promise<FeeRate> {
    const rate = await this.call<bigint>('estimatefee', [blocks], { amounts: ['result'] });
    if (rate < 0n) throw new PearlRpcError('rpc', 'estimatefee', 'the server has no fee estimate', { rpcCode: RPC_ERROR_CODES.MISC });
    return rate;
  }

  /** Number of mempool transactions, their total size and the size cap. pearld reports no fee fields. */
  getMempoolInfo(): Promise<MempoolInfo> {
    return this.call('getmempoolinfo');
  }

  /** Txids of every mempool transaction. */
  getRawMempool(): Promise<string[]> {
    return this.call('getrawmempool', [false]);
  }

  /** Every mempool transaction by txid, with its size, fee in grain and unconfirmed parents. */
  getRawMempoolVerbose(): Promise<Record<string, MempoolEntry>> {
    return this.call('getrawmempool', [true], { amounts: ['fee'] });
  }

  /**
   * null when the output is unknown or a block has spent it. pearld does not
   * count spends that are still in the mempool, whatever includeMempool says;
   * the flag only adds outputs of mempool transactions. getTxSpendingPrevOut
   * finds the mempool spends.
   */
  getTxOut(txid: string, vout: number, includeMempool = true): Promise<TxOutResult | null> {
    return this.call('gettxout', [txid, vout, includeMempool], { amounts: ['value'] });
  }

  /** The mempool transaction spending each output, if any. Spends that have confirmed are not found. */
  getTxSpendingPrevOut(outputs: readonly OutPointParam[]): Promise<TxSpendingPrevOut[]> {
    return this.call('gettxspendingprevout', [outputs.map(({ txid, vout }) => ({ txid, vout }))]);
  }

  /** Needs pearld with --addrindex and --txindex. Mempool transactions come last unless reversed. */
  searchRawTransactions(address: string, options: SearchOptions = {}): Promise<SearchRawTransactionsResult[]> {
    const { skip = 0, count = 100, reverse = false, vinExtra = false } = options;
    return this.call('searchrawtransactions', [address, 1, skip, count, vinExtra ? 1 : 0, reverse], {
      amounts: ['value'],
    });
  }

  /**
   * getcfilter: a block's basic filter with the key to match it with. Given
   * prevHeader, the filter header of the block before, it also fetches
   * getcfilterheader and throws FILTER_HEADER_MISMATCH unless the filter
   * hashes to it. Both come from the same node, so this detects corruption,
   * not a lying node; compare headers across sources for that. pearld needs
   * its CF index, which is on unless --nocfilters.
   */
  async getCFilter(blockHash: string, prevHeader?: string): Promise<BlockFilter> {
    const filter = decodeFilter(await this.call<string>('getcfilter', [blockHash, BASIC_FILTER_TYPE]));
    const key = filterKey(blockHash);
    if (prevHeader === undefined) return { blockHash, key, filter };
    const header = await this.getCFilterHeader(blockHash);
    checkFilterHeaders(prevHeader, [{ filter, header }]);
    return { blockHash, key, filter, header };
  }

  /** The block's basic filter header, as hex in display order. */
  getCFilterHeader(blockHash: string): Promise<string> {
    return this.call('getcfilterheader', [blockHash, BASIC_FILTER_TYPE]);
  }

  /** getinfo: version, height, connections, difficulty and the relay fee in grain per 1000 vbytes. */
  getInfo(): Promise<NodeInfo> {
    return this.call('getinfo', [], { amounts: ['relayfee'] });
  }

  /** getnetworkinfo: protocol version, local addresses and the relay fee. */
  getNetworkInfo(): Promise<NetworkInfo> {
    return this.call('getnetworkinfo', [], { amounts: ['relayfee', 'incrementalfee'] });
  }

  /** Connected peers. Ping times are in microseconds. */
  getPeerInfo(): Promise<PeerInfo[]> {
    return this.call('getpeerinfo', [], { integers: ['feefilter'] });
  }

  /** Number of connected peers. */
  getConnectionCount(): Promise<number> {
    return this.call('getconnectioncount');
  }

  /** addnode: "add" keeps the peer, "onetry" connects once, "remove" drops a kept peer. */
  async addNode(address: string, command: 'add' | 'remove' | 'onetry'): Promise<void> {
    await this.call('addnode', [address, command]);
  }

  /**
   * pearld's node command. The target is an address, or for "disconnect"
   * and "remove" a peer id; "connect" takes "perm" or "temp".
   */
  async node(command: 'connect' | 'remove' | 'disconnect', target: string | number, connect?: 'perm' | 'temp'): Promise<void> {
    await this.call('node', connect === undefined ? [command, String(target)] : [command, String(target), connect]);
  }

  /** Asks pearld to shut down. It answers before it stops. */
  stop(): Promise<string> {
    return this.call('stop');
  }

  /**
   * Marks a block and every block after it invalid and moves the chain off
   * them. pearld answers a hash it does not know with code -32600.
   */
  async invalidateBlock(hash: string): Promise<void> {
    await this.call('invalidateblock', [hash]);
  }

  /** Takes back invalidateBlock: the block and its descendants may be the best chain again. */
  async reconsiderBlock(hash: string): Promise<void> {
    await this.call('reconsiderblock', [hash]);
  }

  /** Bytes sent and received over the peer-to-peer network since the node started. */
  getNetTotals(): Promise<NetTotals> {
    return this.call('getnettotals', [], { integers: ['totalbytesrecv', 'totalbytessent'] });
  }

  /** Seconds since the node started. */
  uptime(): Promise<number> {
    return this.call('uptime');
  }

  /** The version of each RPC API the node serves, by name; pearld reports "pearldjsonrpcapi". */
  version(): Promise<Record<string, VersionInfo>> {
    return this.call('version');
  }

  /** Up to `count` peer addresses from the node's address manager. pearld refuses a count under 1. */
  getNodeAddresses(count = 1): Promise<NodeAddress[]> {
    return this.call('getnodeaddresses', [count], { integers: ['services'] });
  }

  /**
   * Peers added with addNode, or the one named. Without dns, their
   * addresses as strings; with it, each with what its name resolves to and
   * whether it is connected. Code -24 for a node that was not added.
   */
  getAddedNodeInfo(dns: false, node?: string): Promise<string[]>;
  getAddedNodeInfo(dns: true, node?: string): Promise<AddedNodeInfo[]>;
  getAddedNodeInfo(dns: boolean, node?: string): Promise<string[] | AddedNodeInfo[]> {
    return this.call('getaddednodeinfo', node === undefined ? [dns] : [dns, node]);
  }

  /** Sends a ping to every peer; the round trips show in getPeerInfo's ping times. */
  async ping(): Promise<void> {
    await this.call('ping');
  }

  /** The network's magic number, as `PearlNetwork.magic` holds it. */
  getCurrentNet(): Promise<number> {
    return this.call('getcurrentnet');
  }

  /**
   * Checks the last `checkDepth` blocks (0 for all) at `checkLevel`, and
   * says whether they passed. A deep check is slow; give it a timeout, or 0
   * for none.
   */
  verifyChain(checkLevel = 3, checkDepth = 288, options: Pick<CallOptions, 'signal' | 'timeout'> = {}): Promise<boolean> {
    return this.call('verifychain', [checkLevel, checkDepth], options);
  }

  /** Whether the built-in miner is running. */
  getGenerate(): Promise<boolean> {
    return this.call('getgenerate');
  }

  /**
   * Starts or stops the built-in miner, with `threads` workers (-1 for one
   * per CPU; 0 stops it). Starting needs --miningaddr.
   */
  async setGenerate(generate: boolean, threads?: number): Promise<void> {
    await this.call('setgenerate', threads === undefined ? [generate] : [generate, threads]);
  }

  /**
   * Signs a message with a WIF key in the node, the legacy ECDSA compact
   * signature over the double SHA-256 of the message with pearld's header,
   * base64. This is not Oyster's signMessage; verifyMessage in
   * pearljs/message checks it with format 'legacy'. The key travels to the node.
   */
  signMessageWithPrivKey(wif: string, message: string): Promise<string> {
    return this.call('signmessagewithprivkey', [wif, message]);
  }

  /**
   * Sets log levels, as --debuglevel does: a level for everything, or
   * "SUBSYSTEM=level,..."; "show" lists the subsystems. Returns pearld's
   * answer text.
   */
  debugLevel(levelSpec: string): Promise<string> {
    return this.call('debuglevel', [levelSpec]);
  }

  /**
   * An unsigned transaction spending `inputs` and paying `outputs`, grains
   * by address, as hex. A lockTime other than 0 makes every input's
   * sequence 0xfffffffe so it applies. pearld orders the outputs as its
   * map iteration does, which is not the order given.
   */
  createRawTransaction(inputs: readonly OutPointParam[], outputs: Readonly<Record<string, bigint>>, lockTime?: number): Promise<string> {
    const amounts = Object.fromEntries(Object.entries(outputs).map(([address, amount]) => [address, prlAmount(amount)]));
    const params: unknown[] = [inputs.map(({ txid, vout }) => ({ txid, vout })), amounts];
    if (lockTime !== undefined) params.push(lockTime);
    return this.call('createrawtransaction', params);
  }
}

/**
 * Adds pearld's typed methods (PearldMethods) to a class with `call`.
 * PearldClient, PearldRpc and PearlWsClient are built with it.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- the constructor shape TypeScript requires of a mixin. */
export function pearldMethods<Base extends RpcClass>(Base: Base): Base & (abstract new (...args: any[]) => PearldMethods) {
  abstract class WithPearldMethods extends Base {}
  copyMethods(WithPearldMethods.prototype, PearldMethods.prototype);
  return WithPearldMethods as unknown as Base & (abstract new (...args: any[]) => PearldMethods);
}
/* eslint-enable @typescript-eslint/no-explicit-any */

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
 * One entry of listtransactions and its relatives
 * (btcjson.ListTransactionsResult). A transaction lists a "send" for every
 * output the wallet paid out and a "receive", "generate" or "immature" for
 * every output paid to it; change lists nothing.
 */
export interface WalletTransactionEntry {
  readonly abandoned: boolean;
  /** The receiving account; empty on sends. */
  readonly account: string;
  readonly address?: string;
  /** Grains, negative on a send. */
  readonly amount: bigint;
  readonly blockhash?: string;
  readonly blocktime?: number;
  readonly category: 'send' | 'receive' | 'generate' | 'immature';
  readonly confirmations: number;
  /**
   * On sends only, the fee of the whole transaction in grains, negative. It
   * is 0 unless every input is the wallet's.
   */
  readonly fee?: bigint;
  /** Set on the outputs of a coinbase. */
  readonly generated?: boolean;
  readonly time: number;
  readonly timereceived: number;
  readonly trusted: boolean;
  readonly txid: string;
  readonly vout: number;
  readonly walletconflicts: string[];
}

/** listsinceblock: the transactions, and the block hash to pass next time. */
export interface ListSinceBlockResult {
  readonly transactions: WalletTransactionEntry[];
  readonly lastblock: string;
}

/** gettransaction (btcjson.GetTransactionResult). */
export interface WalletTransaction {
  /** Grains received by the wallet, change left out. Not reduced by what it sent. */
  readonly amount: bigint;
  /** Grains, positive, and only when the wallet funded the transaction and owns every input. */
  readonly fee?: bigint;
  readonly confirmations: number;
  /** Empty while unconfirmed. */
  readonly blockhash: string;
  readonly blockindex: number;
  readonly blocktime: number;
  readonly txid: string;
  readonly walletconflicts: string[];
  readonly time: number;
  readonly timereceived: number;
  /**
   * One "send" entry for the whole transaction when the wallet funded it,
   * with the total of its inputs as a negative amount, then one entry per
   * output received.
   */
  readonly details: {
    readonly account: string;
    readonly address?: string;
    /** Grains, negative on the send entry. */
    readonly amount: bigint;
    readonly category: 'send' | 'receive' | 'generate' | 'immature';
    /** Grains, positive, on the send entry. */
    readonly fee?: bigint;
    readonly vout: number;
  }[];
  readonly hex: string;
}

/** One entry of listreceivedbyaddress. */
export interface ReceivedByAddress {
  readonly account: string;
  readonly address: string;
  /** Grains. */
  readonly amount: bigint;
  /** Confirmations of the latest payment. */
  readonly confirmations: number;
  readonly txids?: string[];
}

/** signrawtransaction (btcjson.SignRawTransactionResult). */
export interface SignRawTransactionResult {
  readonly hex: string;
  readonly complete: boolean;
  readonly errors?: {
    readonly txid: string;
    readonly vout: number;
    readonly scriptSig: string;
    readonly sequence: number;
    readonly error: string;
  }[];
}

/** An input of signrawtransaction whose previous output Oyster cannot look up. */
export interface RawTxInput extends OutPointParam {
  readonly scriptPubKey: string;
  readonly redeemScript?: string;
}

/** A sighash type as signrawtransaction names it. */
export type SighashFlag = 'ALL' | 'NONE' | 'SINGLE' | 'ALL|ANYONECANPAY' | 'NONE|ANYONECANPAY' | 'SINGLE|ANYONECANPAY';

/** Oyster's validateaddress (btcjson.ValidateAddressWalletResult). Fields past `address` are sent only for the wallet's own addresses. */
export interface WalletAddressInfo {
  readonly isvalid: boolean;
  readonly address?: string;
  readonly ismine?: boolean;
  readonly iswatchonly?: boolean;
  readonly isscript?: boolean;
  readonly pubkey?: string;
  readonly iscompressed?: boolean;
  readonly account?: string;
  readonly addresses?: string[];
  readonly hex?: string;
  readonly script?: string;
}

/** Oyster's getinfo (btcjson.InfoWalletResult): pearld's, with the wallet's fields filled in. */
export interface WalletInfo extends NodeInfo {
  readonly walletversion: number;
  /** Spendable grains at one confirmation. */
  readonly balance: bigint;
  readonly keypoololdest: number;
  readonly keypoolsize: number;
  readonly unlocked_until: number;
  /** Oyster writes its default relay fee here as a bare count of grains per 1000 vbytes, not in PRL like the other amounts. */
  readonly paytxfee: number;
}

/** getsyncprogress, Pearl's addition for wallets in SPV mode. */
export interface SyncProgress {
  readonly header_height: number;
  readonly filter_header_height: number;
  /** The height the wallet has processed. */
  readonly block_height: number;
  readonly best_peer_height: number;
  readonly connections: number;
  readonly synced: boolean;
}

/** One entry of listreceivedbyaccount (btcjson.ListReceivedByAccountResult). */
export interface ReceivedByAccount {
  readonly account: string;
  /** Grains. */
  readonly amount: bigint;
  /** Confirmations of the latest payment, 0 for none. */
  readonly confirmations: number;
}

/** Options for sendMany. */
export interface SendManyOptions {
  /** "default" unless given. */
  readonly fromAccount?: string;
  /** Confirmations the spent outputs need. Default 1. */
  readonly minConf?: number;
}

/**
 * Oyster's typed methods, written once over `call`. OysterClient, OysterRpc
 * and OysterWsClient carry them; oysterMethods puts them on another class.
 */
export abstract class OysterMethods implements Rpc {
  /** Calls a method and resolves to its result; the class this is mixed into supplies it. */
  abstract call<T = unknown>(method: string, params?: readonly unknown[], options?: CallOptions): Promise<T>;

  /** A new P2TR address. Oyster only makes bech32m Taproot addresses. */
  getNewAddress(account?: string): Promise<string> {
    return this.call('getnewaddress', account === undefined ? [] : [account]);
  }

  /** A new address on the account's change chain. */
  getRawChangeAddress(account?: string): Promise<string> {
    return this.call('getrawchangeaddress', account === undefined ? [] : [account]);
  }

  /** Spendable balance in grains; account "*" is the whole wallet. */
  getBalance(account = '*', minConf = 1): Promise<bigint> {
    return this.call('getbalance', [account, minConf], { amounts: ['result'] });
  }

  /** What the account holds beyond its spendable balance at one confirmation: unconfirmed and immature outputs. */
  getUnconfirmedBalance(account?: string): Promise<bigint> {
    return this.call('getunconfirmedbalance', account === undefined ? [] : [account], { amounts: ['result'] });
  }

  /**
   * Unspent outputs Oyster would spend: immature coinbase outputs and
   * outputs locked with lockUnspent are left out. Oyster refuses the
   * address filter Bitcoin Core takes, so none is offered.
   */
  listUnspent(minConf = 1, maxConf = 9999999): Promise<ListUnspentResult[]> {
    return this.call('listunspent', [minConf, maxConf], { amounts: ['amount'] });
  }

  /** Keeps outputs out of coin selection until unlocked or Oyster restarts. Unlocking with no outputs unlocks all. */
  lockUnspent(unlock: boolean, outputs: readonly OutPointParam[] = []): Promise<boolean> {
    return this.call('lockunspent', [unlock, outputs.map(({ txid, vout }) => ({ txid, vout }))]);
  }

  /** Outputs currently locked with lockUnspent. */
  listLockUnspent(): Promise<OutPointParam[]> {
    return this.call('listlockunspent');
  }

  /** Grains in each account at minConf confirmations, by account name. */
  async listAccounts(minConf = 1): Promise<Record<string, bigint>> {
    return this.call('listaccounts', [minConf], { amounts: ['*'] });
  }

  /** Needs the wallet unlocked. */
  async createNewAccount(account: string): Promise<void> {
    await this.call('createnewaccount', [account]);
  }

  /** Renames an account. */
  async renameAccount(oldAccount: string, newAccount: string): Promise<void> {
    await this.call('renameaccount', [oldAccount, newAccount]);
  }

  /** The account an address of the wallet belongs to. */
  getAccount(address: string): Promise<string> {
    return this.call('getaccount', [address]);
  }

  /** Every address of an account. */
  getAddressesByAccount(account: string): Promise<string[]> {
    return this.call('getaddressesbyaccount', [account]);
  }

  /**
   * The newest `count` transactions after skipping `from`, as entries; see
   * WalletTransactionEntry. Oyster lists the whole wallet and refuses any
   * account but "*".
   */
  listTransactions(count = 10, from = 0): Promise<WalletTransactionEntry[]> {
    return this.call('listtransactions', ['*', count, from], { amounts: ['amount', 'fee'] });
  }

  /** Every wallet transaction, newest first. */
  listAllTransactions(): Promise<WalletTransactionEntry[]> {
    return this.call('listalltransactions', [], { amounts: ['amount', 'fee'] });
  }

  /** Entries of the wallet transactions that pay any of these addresses, oldest first. */
  listAddressTransactions(addresses: readonly string[]): Promise<WalletTransactionEntry[]> {
    return this.call('listaddresstransactions', [[...addresses]], { amounts: ['amount', 'fee'] });
  }

  /**
   * Transactions in blocks after the given one, or all of them, and the
   * hash to pass next time. Oyster needs a pearld RPC connection for this;
   * in SPV mode it answers "Chain RPC is inactive".
   */
  listSinceBlock(blockHash?: string, targetConfirmations = 1): Promise<ListSinceBlockResult> {
    return this.call('listsinceblock', blockHash === undefined ? [] : [blockHash, targetConfirmations], { amounts: ['amount', 'fee'] });
  }

  /** A wallet transaction; code -5 for one the wallet does not hold. */
  getTransaction(txid: string): Promise<WalletTransaction> {
    return this.call('gettransaction', [txid], { amounts: ['amount', 'fee'] });
  }

  /** Grains received by an address in transactions with minConf confirmations. */
  getReceivedByAddress(address: string, minConf = 1): Promise<bigint> {
    return this.call('getreceivedbyaddress', [address, minConf], { amounts: ['result'] });
  }

  /** Totals per address. Oyster lists every active address, used or not, whatever includeEmpty says. */
  listReceivedByAddress(minConf = 1): Promise<ReceivedByAddress[]> {
    return this.call('listreceivedbyaddress', [minConf], { amounts: ['amount'] });
  }

  /** Oyster's BIP-322-style signature, base64; P2TR addresses only. */
  signMessage(address: string, message: string): Promise<string> {
    return this.call('signmessage', [address, message]);
  }

  /** Oyster's verifymessage. False for a signature that does not match. */
  verifyMessage(address: string, signature: string, message: string): Promise<boolean> {
    return this.call('verifymessage', [address, signature, message]);
  }

  /** Unlocks for timeoutSeconds. In Oyster a timeout of 0 never relocks. */
  async walletPassphrase(passphrase: string, timeoutSeconds: number): Promise<void> {
    await this.call('walletpassphrase', [passphrase, timeoutSeconds]);
  }

  /** Changes the private passphrase and locks the wallet. Code -14 when the old one is wrong. */
  async walletPassphraseChange(oldPassphrase: string, newPassphrase: string): Promise<void> {
    await this.call('walletpassphrasechange', [oldPassphrase, newPassphrase]);
  }

  /** Locks the wallet, forgetting the private passphrase. */
  async walletLock(): Promise<void> {
    await this.call('walletlock');
  }

  /** Whether the wallet is locked. */
  walletIsLocked(): Promise<boolean> {
    return this.call('walletislocked');
  }

  /**
   * Sends from the default account and returns the txid. Oyster requires a
   * fee rate, here in grain per 1000 vbytes, where Bitcoin Core has none.
   */
  sendToAddress(address: string, amount: bigint, feeRate: FeeRate): Promise<string> {
    return this.call('sendtoaddress', [address, prlAmount(amount), prlAmount(feeRate)]);
  }

  /**
   * Pays several addresses in one transaction and returns the txid; this
   * is what Pearl's desktop wallet sends with. Amounts are grains by
   * address, and the fee rate is grain per 1000 vbytes.
   */
  sendMany(amounts: Readonly<Record<string, bigint>>, feeRate: FeeRate, options: SendManyOptions = {}): Promise<string> {
    const pairs = Object.fromEntries(Object.entries(amounts).map(([address, amount]) => [address, prlAmount(amount)]));
    return this.call('sendmany', [options.fromAccount ?? 'default', pairs, prlAmount(feeRate), options.minConf ?? 1]);
  }

  /**
   * Signs the inputs the wallet has keys for. `inputs` describes previous
   * outputs Oyster cannot find. Oyster needs a pearld RPC connection for
   * this; in SPV mode it answers "Chain RPC is inactive".
   */
  signRawTransaction(
    tx: string | Uint8Array,
    options: { inputs?: readonly RawTxInput[]; privateKeys?: readonly string[]; sighash?: SighashFlag } = {},
  ): Promise<SignRawTransactionResult> {
    const { inputs = [], privateKeys = [], sighash = 'ALL' } = options;
    const prevouts = inputs.map((input) => ({ redeemScript: '', ...input }));
    return this.call('signrawtransaction', [toHex(tx), prevouts, [...privateKeys], sighash]);
  }

  /** Forgets an unconfirmed wallet transaction and those that spend it, freeing their inputs. Returns the txids removed. */
  async removeTransaction(txid: string): Promise<string[]> {
    return (await this.call<{ removed: string[] }>('removetransaction', [txid])).removed;
  }

  /** Announces an unconfirmed wallet transaction and its unconfirmed ancestors again. Returns the txids announced. */
  async rebroadcastTransaction(txid: string): Promise<string[]> {
    return (await this.call<{ announced: string[] }>('rebroadcasttransaction', [txid])).announced;
  }

  /** Imports into the "imported" account, the only label Oyster accepts. */
  async importPrivKey(wif: string, rescan = true): Promise<void> {
    await this.call('importprivkey', [wif, 'imported', rescan]);
  }

  /** The WIF private key of an address the wallet holds. Needs the wallet unlocked. */
  dumpPrivKey(address: string): Promise<string> {
    return this.call('dumpprivkey', [address]);
  }

  /** Whether the address is valid, and what the wallet knows about it when it is its own. */
  validateAddress(address: string): Promise<WalletAddressInfo> {
    return this.call('validateaddress', [address]);
  }

  /** Needs a pearld RPC connection; in SPV mode Oyster answers "Chain RPC is inactive". */
  getInfo(): Promise<WalletInfo> {
    return this.call('getinfo', [], { amounts: ['balance', 'relayfee'] });
  }

  /** The block the wallet has processed up to, which can trail the node's tip. */
  getBestBlock(): Promise<BestBlockResult> {
    return this.call('getbestblock');
  }

  /** How far the wallet has synced with its chain source. */
  getSyncProgress(): Promise<SyncProgress> {
    return this.call('getsyncprogress');
  }

  /** Whether the wallet has caught up with its chain source. */
  chainSynced(): Promise<boolean> {
    return this.call('chainsynced');
  }

  /** Asks Oyster to shut down. */
  stop(): Promise<string> {
    return this.call('stop');
  }

  /** The height the wallet has processed up to, which can trail the node. */
  getBlockCount(): Promise<number> {
    return this.call('getblockcount');
  }

  /** The hash of the block the wallet has processed up to. */
  getBestBlockHash(): Promise<string> {
    return this.call('getbestblockhash');
  }

  /**
   * Pays one address from an account and returns the txid. Like
   * sendToAddress, Oyster requires a fee rate, grain per 1000 vbytes, and
   * needs a pearld RPC connection; in SPV mode it answers "Chain RPC is
   * inactive".
   */
  sendFrom(fromAccount: string, address: string, amount: bigint, feeRate: FeeRate, minConf = 1): Promise<string> {
    return this.call('sendfrom', [fromAccount, address, prlAmount(amount), prlAmount(feeRate), minConf]);
  }

  /**
   * Oyster's settxfee checks that the rate is not negative and returns
   * true; it changes nothing, since every send names its own fee rate.
   */
  setTxFee(feeRate: FeeRate): Promise<boolean> {
    return this.call('settxfee', [prlAmount(feeRate)]);
  }

  /** The account's current receive address: the last one handed out, or a new one once that has been paid. */
  getAccountAddress(account: string): Promise<string> {
    return this.call('getaccountaddress', [account]);
  }

  /** Grains received by an account's addresses in transactions with minConf confirmations. */
  getReceivedByAccount(account: string, minConf = 1): Promise<bigint> {
    return this.call('getreceivedbyaccount', [account, minConf], { amounts: ['result'] });
  }

  /** Totals per account, every account listed. */
  listReceivedByAccount(minConf = 1): Promise<ReceivedByAccount[]> {
    return this.call('listreceivedbyaccount', [minConf], { amounts: ['amount'] });
  }

  /** Accepted for compatibility; Oyster derives addresses as it needs them and does nothing here. */
  async keypoolRefill(newSize?: number): Promise<void> {
    await this.call('keypoolrefill', newSize === undefined ? [] : [newSize]);
  }
}

/**
 * Adds Oyster's typed methods (OysterMethods) to a class with `call`.
 * OysterClient and OysterRpc are built with it.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- the constructor shape TypeScript requires of a mixin. */
export function oysterMethods<Base extends RpcClass>(Base: Base): Base & (abstract new (...args: any[]) => OysterMethods) {
  abstract class WithOysterMethods extends Base {}
  copyMethods(WithOysterMethods.prototype, OysterMethods.prototype);
  return WithOysterMethods as unknown as Base & (abstract new (...args: any[]) => OysterMethods);
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Typed methods for pearld over fetch. */
export class PearldClient extends /* @__PURE__ */ pearldMethods(JsonRpcClient) {
  // The mixin's constructor takes anything; this one says what the client takes.
  constructor(options: RpcClientOptions) {
    super(options);
  }
}

/**
 * Typed methods for Oyster over fetch. Methods Oyster does not handle are
 * passed through to its pearld when it has an RPC connection to one, so
 * `call` reaches node methods too. Oyster has no PSBT methods and reads one
 * request per POST, so batching is refused.
 */
export class OysterClient extends /* @__PURE__ */ oysterMethods(JsonRpcClient) {
  constructor(options: Omit<RpcClientOptions, 'batch'>) {
    if ((options as RpcClientOptions).batch) throw new TypeError('Oyster does not accept JSON-RPC batches');
    super(options);
  }
}

/** Forwards to another Rpc, adding options to every call. */
class RpcView implements Rpc {
  readonly #rpc: Rpc;
  readonly #defaults: CallOptions;

  constructor(rpc: Rpc, defaults: CallOptions = {}) {
    this.#rpc = rpc;
    this.#defaults = defaults;
  }

  call<T = unknown>(method: string, params: readonly unknown[] = [], options: CallOptions = {}): Promise<T> {
    return this.#rpc.call<T>(method, params, { ...this.#defaults, ...options });
  }
}

/**
 * pearld's typed methods over anything with `call`, with options added to
 * every call: `new PearldRpc(node, { signal })` aborts whatever it started,
 * and `new PearldRpc(oyster)` reaches pearld through Oyster's passthrough.
 */
export class PearldRpc extends /* @__PURE__ */ pearldMethods(RpcView) {
  constructor(rpc: Rpc, defaults: Pick<CallOptions, 'signal' | 'timeout'> = {}) {
    super(rpc, defaults);
  }
}

/** Oyster's typed methods over anything with `call`. */
export class OysterRpc extends /* @__PURE__ */ oysterMethods(RpcView) {
  constructor(rpc: Rpc, defaults: Pick<CallOptions, 'signal' | 'timeout'> = {}) {
    super(rpc, defaults);
  }
}

/** The desktop wallet's Oyster, given the RPC username and password from the wallet's settings. */
export function desktopOysterClient(credentials: { username: string; password: string }, options: Omit<RpcClientOptions, 'batch' | 'url' | 'transport'> = {}): OysterClient {
  return new OysterClient({ ...options, ...credentials, url: DESKTOP_OYSTER_URL });
}

/** The most transactions searchrawtransactions returns in one call. */
const MAX_SEARCH_COUNT = 10000;

/** Options for searchAllTransactions. */
export interface SearchAllOptions {
  /** Transactions per request, 1 to 10000. Default 100. */
  readonly pageSize?: number;
  /** Requests before giving up on an address. Default 10000. */
  readonly maxPages?: number;
  /** Adds `prevOut` to every input; see SearchOptions. */
  readonly vinExtra?: boolean;
}

/**
 * Every transaction touching an address, confirmed ones first in block
 * order, each once. An address pearld has never seen gives an empty list.
 * Needs --addrindex and --txindex. The pages are separate requests, so a
 * reorganization in between can hide a transaction until the next call.
 */
export async function searchAllTransactions(
  client: { searchRawTransactions(address: string, options?: SearchOptions): Promise<SearchRawTransactionsResult[]> },
  address: string,
  options: SearchAllOptions = {},
): Promise<SearchRawTransactionsResult[]> {
  const { pageSize = 100, maxPages = 10000, vinExtra = false } = options;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_SEARCH_COUNT) {
    throw new RangeError(`pageSize must be an integer from 1 to ${MAX_SEARCH_COUNT}`);
  }
  const found = new Map<string, SearchRawTransactionsResult>();
  const add = (page: readonly SearchRawTransactionsResult[]): number => {
    const before = found.size;
    for (const tx of page) if (!found.has(tx.txid)) found.set(tx.txid, tx);
    return found.size - before;
  };
  try {
    // Confirmed transactions come first, in a fixed order, so skip counts only those.
    for (let confirmed = 0, pages = 0; ; pages++) {
      if (pages >= maxPages) {
        throw new PearlRpcError('response', 'searchrawtransactions', `${address} has more than ${maxPages} pages of ${pageSize} transactions`);
      }
      const page = await client.searchRawTransactions(address, { skip: confirmed, count: pageSize, vinExtra });
      // A short page is everything that was left, in one reply.
      if (page.length < pageSize) {
        add(page);
        break;
      }
      const mined = page.filter((tx) => tx.blockhash !== undefined && tx.blockhash !== '');
      // A server that ignores skip would send the first page forever.
      if (mined.length > 0 && add(mined) === 0) {
        throw new PearlRpcError('response', 'searchrawtransactions', 'the server sent the same page twice; it does not honor skip');
      }
      confirmed += mined.length;
      if (mined.length < pageSize) {
        // The page ran into the mempool, which pearld lists in a different
        // order on every call: paging through it can miss transactions,
        // so all of it is read in one request.
        add(await client.searchRawTransactions(address, { skip: confirmed, count: MAX_SEARCH_COUNT, vinExtra }));
        break;
      }
    }
  } catch (err) {
    if (!isUnusedAddress(err)) throw err;
  }
  return [...found.values()];
}

/**
 * A ChainClient over pearld for the invoice monitor, from a PearldClient, a
 * PearlWsClient or a PearldRpc. Address activity comes from
 * searchrawtransactions, so pearld must run with --addrindex and --txindex.
 */
export function pearldChainClient(
  client: Pick<PearldRpc, 'getBestBlock' | 'getBlockHeader' | 'getRawTransaction' | 'searchRawTransactions'>,
  options: { pageSize?: number } = {},
): ChainClient {
  const pageSize = options.pageSize ?? 100;
  const blockRef = async (tx: { blockhash?: string; blocktime?: number }, heights: Map<string, number>): Promise<BlockRef | null> => {
    const hash = tx.blockhash;
    if (hash === undefined || hash === '') return null;
    let height = heights.get(hash);
    if (height === undefined) {
      height = safeHeight((await client.getBlockHeader(hash)).height, 'getblockheader');
      heights.set(hash, height);
    }
    return tx.blocktime === undefined ? { height, hash } : { height, hash, time: tx.blocktime };
  };

  return {
    async getTip() {
      // One call, so the height and hash come from the same snapshot, and
      // one pearld's limited user may make.
      const best = await client.getBestBlock();
      return { height: safeHeight(best.height, 'getbestblock'), hash: best.hash };
    },

    async getAddressActivity(address) {
      const heights = new Map<string, number>();
      const payments: AddressPayment[] = [];
      for (const tx of await searchAllTransactions(client, address, { pageSize })) {
        const amount = paidTo(tx, address);
        if (amount > 0n) payments.push({ txid: tx.txid, amount, block: await blockRef(tx, heights) });
      }
      return payments;
    },

    async getTransaction(txid): Promise<ChainTransaction | null> {
      let tx: TxRawResult;
      try {
        tx = await client.getRawTransaction(txid);
      } catch (err) {
        if (isUnknownTransaction(err)) return null;
        throw err;
      }
      return { txid: tx.txid, block: await blockRef(tx, new Map()) };
    },
  };
}

/** Grains a transaction pays to an address, over all its outputs. */
export function paidTo(tx: { readonly vout: readonly RpcVout[] }, address: string): bigint {
  let sum = 0n;
  for (const out of tx.vout) {
    if (out.scriptPubKey.address !== address) continue;
    if (typeof out.value !== 'bigint' || out.value < 0n) {
      throw new PearlRpcError('response', 'searchrawtransactions', `output ${out.n} has no valid value`);
    }
    sum += out.value;
  }
  return sum;
}

/**
 * Whether an error is pearld or Oyster saying it has no such transaction.
 * pearld also answers code -5 when it runs without --txindex and the
 * transaction is not in the mempool, which says nothing about the
 * transaction; that case is not this one.
 */
export function isUnknownTransaction(err: unknown): boolean {
  return (
    err instanceof PearlRpcError &&
    err.rpcCode === RPC_ERROR_CODES.INVALID_ADDRESS_OR_KEY &&
    (err.message.includes('No information available about transaction') || err.message.includes('No information for transaction'))
  );
}

// pearld answers -5 for an address it has never seen, for a skip past the
// last transaction, and for an address it cannot decode; only the first two
// mean "nothing here".
function isUnusedAddress(err: unknown): boolean {
  return (
    err instanceof PearlRpcError &&
    err.rpcCode === RPC_ERROR_CODES.INVALID_ADDRESS_OR_KEY &&
    err.message.includes('No information available about address')
  );
}

// Puts the methods of one prototype on another, as a mixin's class body would.
function copyMethods(target: object, source: object): void {
  for (const name of Object.getOwnPropertyNames(source)) {
    if (name !== 'constructor') Object.defineProperty(target, name, Object.getOwnPropertyDescriptor(source, name)!);
  }
}

function holdsErrorReply(text: string): boolean {
  try {
    return isErrorReply(JSON.parse(text));
  } catch {
    return false;
  }
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

function toHex(value: string | Uint8Array): string {
  return typeof value === 'string' ? value : bytesToHex(value);
}

