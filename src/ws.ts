// A websocket client for pearld's /ws endpoint (node/rpcserver.go,
// node/rpcwebsocket.go): any RPC method, plus the notifications pearld pushes
// for blocks, mempool transactions, transaction filters and rescans.
//
// pearld accepts HTTP Basic auth on the upgrade, or an unauthenticated
// upgrade followed by an `authenticate` command, which is the only way a
// browser can log in. Until then it reads at most 64 KiB, disconnects on any
// other first message or on wrong credentials without a reply, and drops the
// client after 10 seconds. It answers commands concurrently, so replies are
// matched to requests by id, and it sends notifications with a null id.
//
// PearlWsClient carries the same typed methods as PearldClient, from the
// mixin in rpc.ts, so `ws.getBlock(hash)` works over the socket.

/**
 * A websocket client for pearld: typed notifications, every RPC method,
 * reconnect and resubscription.
 *
 * @module
 */

import { blockHashHex, parseBlockHeader, type PearlBlockHeader } from './blockheader.js';
import { UNBOUNDED_METHODS, basicAuth, decimalToGrain, encodeJson, parseJson, rpcEndpoint, rpcError } from './internal/rpc-wire.js';
import {
  DEFAULT_MAX_REPLY_SIZE,
  DEFAULT_RPC_TIMEOUT,
  PearlRpcError,
  isLimitedUserRefusal,
  oysterMethods,
  pearldMethods,
  type CallOptions,
  type Rpc,
  type RpcErrorKind,
  type TxRawResult,
} from './rpc.js';
import { fromHex } from './internal/bytes.js';
import { PearlError } from './errors.js';

/** Websocket path of pearld and Oyster. */
export const PEARLD_WS_PATH = '/ws';

// How long close() waits for the socket to report its close. Oyster answers a
// close frame but keeps the TCP connection open, and undici reports a close
// only when the connection ends, so against Oyster the report never comes.
const CLOSE_TIMEOUT = 3000;

/** How the websocket client reconnects after a session drops. */
export interface ReconnectOptions {
  /** Delay before the first retry in ms; it doubles on each failed attempt. Default 1000. */
  readonly initialDelay?: number;
  /** Default 30000. */
  readonly maxDelay?: number;
  /** Reconnection tries before giving up. Default unlimited. */
  readonly retries?: number;
}

/** Options for PearlWsClient, OysterWsClient and JsonRpcWsClient. */
export interface PearlWsClientOptions {
  /** e.g. wss://127.0.0.1:18334/ws. http(s) URLs and a missing path become ws(s) and /ws. */
  readonly url: string | URL;
  readonly username?: string;
  readonly password?: string;
  /**
   * A WebSocket constructor; defaults to globalThis.WebSocket (browsers,
   * Node 22). The `ws` package and undici's WebSocket also work.
   */
  readonly WebSocket?: abstract new (url: string, ...rest: never[]) => object;
  /**
   * "command" (the default) logs in with pearld's authenticate command, which
   * works everywhere. "header" sends HTTP Basic auth on the upgrade, which
   * needs a constructor that takes `{ headers }`, as undici's and `ws` do;
   * browsers cannot. Oyster accepts only "header".
   */
  readonly auth?: 'command' | 'header';
  /** Second constructor argument, e.g. `{ dispatcher }` for undici with a self-signed rpc.cert. */
  readonly webSocketInit?: Record<string, unknown>;
  /** Reconnect after a session drops, resubscribing. On by default; a first connection is never retried. */
  readonly reconnect?: boolean | ReconnectOptions;
  /**
   * Per-call limit in ms, including the wait for a connection; 0 for none.
   * Default DEFAULT_RPC_TIMEOUT, as for the fetch clients, and none for
   * generate, importprivkey, getblocktemplate, rescan and rescanblocks.
   */
  readonly timeout?: number;
  /**
   * False for a server that sends no notifications, which is Oyster: the
   * subscription methods then throw instead of sending a command Oyster would
   * pass to its own pearld connection. OysterWsClient sets it.
   */
  readonly notifications?: boolean;
  /** Both logins send the password as it is, so ws:// is refused for any host but loopback unless this is set. */
  readonly allowInsecureAuth?: boolean;
  /**
   * Frames longer than this many characters are refused and the connection
   * is dropped, failing the calls waiting on it; it reconnects as after any
   * drop. Default DEFAULT_MAX_REPLY_SIZE.
   */
  readonly maxReplySize?: number;
  /**
   * Sends pearld's `session` command this often, in ms, while connected; 0
   * (the default) for never. A ping still unanswered when the next is due
   * drops the session, which reconnecting replaces, so a dead connection
   * that never reports its close is found within twice this. The traffic
   * also keeps an extension's service worker running, which costs battery.
   * pearld only: Oyster has no `session` command.
   */
  readonly keepAlive?: number;
}

/** The websocket client takes the same per-call options as the fetch clients. */
export type WsCallOptions = CallOptions;

/** A transaction output, named as in pearljs's RPC results. */
export interface OutPointRef {
  readonly txid: string;
  readonly vout: number;
}

/** blockconnected, blockdisconnected, rescanprogress and rescanfinished. */
export interface BlockEvent {
  readonly type: 'connected' | 'disconnected';
  readonly hash: string;
  readonly height: number;
  /** Header timestamp, Unix seconds. */
  readonly time: number;
}

/** filteredblockconnected and filteredblockdisconnected. */
export interface FilteredBlockEvent {
  readonly type: 'connected' | 'disconnected';
  readonly height: number;
  readonly hash: string;
  readonly header: PearlBlockHeader;
  /** Serialized transactions that matched the loaded filter, hex; always empty on disconnect. */
  readonly transactions: string[];
}

/** txaccepted: a transaction entered the mempool. */
export interface TxAccepted {
  readonly txid: string;
  /** Sum of the outputs, grains. */
  readonly amount: bigint;
}

/** btcjson.BlockDetails, attached to recvtx and redeemingtx for mined transactions. */
export interface BlockDetails {
  readonly hash: string;
  readonly height: number;
  /** Position of the transaction in the block. */
  readonly index: number;
  readonly time: number;
}

/** recvtx and redeemingtx. */
export interface TxNotification {
  /** Serialized transaction, hex. */
  readonly transaction: string;
  /** null while the transaction is in the mempool. */
  readonly block: BlockDetails | null;
}

/** rescanprogress and rescanfinished: the block the rescan has reached. */
export interface RescanEvent {
  readonly hash: string;
  readonly height: number;
  /** Header timestamp, Unix seconds. */
  readonly time: number;
}

/** rescanblocks: blocks with at least one matching transaction. */
export interface RescannedBlock {
  readonly hash: string;
  readonly transactions: string[];
}

/** Every notification pearld sends, by method. */
export interface PearlNotifications {
  blockconnected: BlockEvent;
  blockdisconnected: BlockEvent;
  filteredblockconnected: FilteredBlockEvent;
  filteredblockdisconnected: FilteredBlockEvent;
  txaccepted: TxAccepted;
  txacceptedverbose: TxRawResult;
  /** A mempool transaction touching the loaded filter. */
  relevanttxaccepted: { readonly transaction: string };
  /** A transaction paying an address passed to notifyReceived, or rescan. */
  recvtx: TxNotification;
  /** A transaction spending an outpoint passed to notifySpent, or one recvtx reported. */
  redeemingtx: TxNotification;
  rescanprogress: RescanEvent;
  rescanfinished: RescanEvent;
}

/** Everything on() can listen for: pearld's notifications and the client's own connection events. */
export interface PearlWsEvents extends PearlNotifications {
  /** A session is ready: authenticated and resubscribed. */
  connect: { readonly reconnect: boolean };
  /** A session dropped; the client reconnects unless told not to. */
  disconnect: { readonly error: PearlRpcError };
  /** Bad frames, failed subscriptions and other errors no call returns. */
  error: Error;
  /** The client stopped for good, with the error that stopped it, if any. */
  close: { readonly error?: Error };
}

// The parts of a WebSocket the client uses; browsers, undici and ws all have them.
interface Socket {
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onclose: ((event: { code?: number }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

interface Pending {
  readonly method: string;
  readonly parse: (text: string) => unknown;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
}

// Why the connection is unusable; each waiting call turns it into a
// PearlRpcError under its own method name.
interface Failure {
  readonly kind: RpcErrorKind;
  readonly message: string;
  readonly status?: number;
  readonly cause?: unknown;
}

type Listener = (value: never) => void;

const OPEN = 1;
const BLOCK_EVENTS = ['blockconnected', 'blockdisconnected'] as const;
const FILTERED_EVENTS = ['filteredblockconnected', 'filteredblockdisconnected'] as const;

// How many given-up call ids a connection remembers.
const MAX_ABANDONED = 1000;

/**
 * pearld's websocket RPC with typed notifications, reconnect and
 * resubscription, without the typed methods; PearlWsClient adds those.
 */
export class JsonRpcWsClient implements Rpc {
  readonly #url: string;
  readonly #origin: string;
  readonly #username: string;
  readonly #password: string;
  readonly #ctor: new (url: string, init?: object) => Socket;
  readonly #auth: 'command' | 'header';
  readonly #init: Record<string, unknown> | undefined;
  readonly #reconnect: Required<ReconnectOptions> | null;
  readonly #timeout: number | undefined;
  readonly #oyster: boolean;
  readonly #maxReplySize: number;
  readonly #keepAlive: number;

  #socket: Socket | null = null;
  // Drops the given socket as if it had closed, for a session that stopped answering.
  #lose: ((socket: Socket) => void) | null = null;
  #pinger: ReturnType<typeof setInterval> | undefined;
  #live = false;
  #authenticating = false;
  #ready: Promise<void> | null = null;
  #settle: { resolve: () => void; reject: (failure: Failure) => void } | null = null;
  #sessions = 0;
  #attempt = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #closed: Failure | null = null;
  #closing: Promise<void> | null = null;
  #closeDone: (() => void) | null = null;
  #closeTimer: ReturnType<typeof setTimeout> | undefined;
  #id = 0;
  readonly #pending = new Map<number, Pending>();
  // Ids of calls given up on by timeout or abort, so a late reply is dropped quietly: the most
  // recent MAX_ABANDONED of them, since a server that never answers would otherwise grow the set
  // for as long as the connection lasts.
  readonly #abandoned = new Set<number>();
  readonly #listeners = new Map<string, Set<Listener>>();

  // Server-side state, replayed after a reconnect.
  #blockWatchers = 0;
  #serverBlocks = false;
  /** null when not subscribed, else whether verbose. */
  #serverTx: boolean | null = null;
  #plainTxWatchers = 0;
  #verboseTxWatchers = 0;
  #filter: { addresses: Set<string>; outpoints: Map<string, OutPointRef> } | null = null;
  readonly #received = new Set<string>();
  readonly #spent = new Map<string, OutPointRef>();

  constructor(options: PearlWsClientOptions) {
    const { url, username, password } = rpcEndpoint(options);
    if (url.protocol === 'https:') url.protocol = 'wss:';
    else if (url.protocol === 'http:') url.protocol = 'ws:';
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') throw new TypeError(`not a websocket URL: ${url.protocol}`);
    if (url.pathname === '/' || url.pathname === '') url.pathname = PEARLD_WS_PATH;
    this.#username = username;
    this.#password = password;
    this.#url = url.href;
    this.#origin = url.host;
    const ctor = options.WebSocket ?? (globalThis as { WebSocket?: unknown }).WebSocket;
    if (typeof ctor !== 'function') throw new TypeError('no WebSocket implementation available; pass one as WebSocket');
    this.#ctor = ctor as new (url: string, init?: object) => Socket;
    this.#auth = options.auth ?? 'command';
    this.#init = options.webSocketInit;
    const reconnect = options.reconnect ?? true;
    this.#reconnect =
      reconnect === false
        ? null
        : { initialDelay: 1000, maxDelay: 30000, retries: Infinity, ...(reconnect === true ? {} : reconnect) };
    this.#timeout = options.timeout;
    this.#oyster = options.notifications === false;
    this.#maxReplySize = options.maxReplySize ?? DEFAULT_MAX_REPLY_SIZE;
    if (!Number.isSafeInteger(this.#maxReplySize) || this.#maxReplySize < 1) throw new RangeError('maxReplySize must be a positive integer');
    this.#keepAlive = options.keepAlive ?? 0;
    if (!Number.isSafeInteger(this.#keepAlive) || this.#keepAlive < 0) throw new RangeError('keepAlive must be a whole number of ms, 0 for never');
    if (this.#keepAlive > 0 && this.#oyster) throw new TypeError('keepAlive pings with pearld\'s session command, which Oyster does not have');
  }

  /** Calls sent and still waiting for their reply. */
  get pending(): number {
    return this.#pending.size;
  }

  /** Opens the connection now instead of on first use. */
  async connect(): Promise<void> {
    try {
      await this.#whenReady();
    } catch (failure) {
      throw this.#error(failure, 'connect');
    }
  }

  /** Calls any method. Wrap amounts among the params in prlAmount. */
  async call<T = unknown>(method: string, params: readonly unknown[] = [], options: WsCallOptions = {}): Promise<T> {
    const amounts = new Set(options.amounts);
    const integers = new Set(options.integers);
    const parse = (text: string) => (parseJson(text, amounts, integers) as { result: unknown }).result;
    return this.#call(method, params, parse, options) as Promise<T>;
  }

  /**
   * Listens for a notification by its pearld name, or for connect, disconnect,
   * error and close. Returns a function that removes the listener.
   */
  on<K extends keyof PearlWsEvents>(event: K, listener: (value: PearlWsEvents[K]) => void): () => void {
    let set = this.#listeners.get(event);
    if (set === undefined) this.#listeners.set(event, (set = new Set()));
    const entry = listener as Listener;
    set.add(entry);
    return () => {
      set.delete(entry);
    };
  }

  /** Block connects and disconnects (notifyblocks). */
  watchBlocks(options: { onBlock: (event: BlockEvent) => void; onError?: (error: Error) => void }): () => void {
    return this.#watch(BLOCK_EVENTS, options.onBlock, options.onError, 'blocks');
  }

  /**
   * filteredblockconnected and filteredblockdisconnected, which pearld sends
   * alongside the plain ones. Transactions are included for the loaded filter.
   */
  watchFilteredBlocks(options: { onBlock: (event: FilteredBlockEvent) => void; onError?: (error: Error) => void }): () => void {
    return this.#watch(FILTERED_EVENTS, options.onBlock, options.onError, 'blocks');
  }

  /**
   * New mempool transactions (notifynewtransactions). pearld sends one form
   * per connection, so while any watcher is verbose the plain ones get txid
   * and amount computed from the verbose form.
   */
  watchTransactions(options: { verbose: true; onTransaction: (tx: TxRawResult) => void; onError?: (error: Error) => void }): () => void;
  watchTransactions(options: { verbose?: false; onTransaction: (tx: TxAccepted) => void; onError?: (error: Error) => void }): () => void;
  watchTransactions(options: {
    verbose?: boolean;
    onTransaction: ((tx: TxRawResult) => void) | ((tx: TxAccepted) => void);
    onError?: (error: Error) => void;
  }): () => void {
    const verbose = options.verbose === true;
    const event = verbose ? 'txacceptedverbose' : 'txaccepted';
    return this.#watch([event], options.onTransaction as Listener, options.onError, verbose ? 'verbose' : 'plain');
  }

  /** Block events as an async iterator; leaving the loop unsubscribes. */
  blocks(): AsyncIterableIterator<BlockEvent> {
    return this.#iterate((push) => this.watchBlocks({ onBlock: push }));
  }

  /** Filtered block events as an async iterator; leaving the loop unsubscribes. */
  filteredBlocks(): AsyncIterableIterator<FilteredBlockEvent> {
    return this.#iterate((push) => this.watchFilteredBlocks({ onBlock: push }));
  }

  /** New mempool transactions as an async iterator; leaving the loop unsubscribes. */
  transactions(): AsyncIterableIterator<TxAccepted> {
    return this.#iterate((push) => this.watchTransactions({ onTransaction: push }));
  }

  /**
   * Loads or extends the transaction filter behind relevanttxaccepted,
   * filteredblockconnected and rescanBlocks. pearld adds the outputs it sees
   * paying a filter address; those additions are lost on reconnect, when the
   * client reloads only what was passed here.
   */
  async loadTxFilter(filter: { addresses?: readonly string[]; outpoints?: readonly OutPointRef[] }, reload = false): Promise<void> {
    this.#notifications('loadtxfilter');
    const addresses = [...(filter.addresses ?? [])];
    const outpoints = [...(filter.outpoints ?? [])];
    await this.call('loadtxfilter', [reload, addresses, outpoints.map(wireOutPoint)]);
    if (reload || this.#filter === null) this.#filter = { addresses: new Set(), outpoints: new Map() };
    for (const address of addresses) this.#filter.addresses.add(address);
    for (const op of outpoints) this.#filter.outpoints.set(outPointKey(op), op);
  }

  /**
   * recvtx for transactions paying these addresses. pearld then also watches
   * each paid output for redeemingtx; after a reconnect only the addresses
   * and the outpoints given to notifySpent are watched again.
   */
  async notifyReceived(addresses: readonly string[]): Promise<void> {
    this.#notifications('notifyreceived');
    await this.call('notifyreceived', [[...addresses]]);
    for (const address of addresses) this.#received.add(address);
  }

  /** Stops recvtx for these addresses. The limited RPC user may not call it. */
  async stopNotifyReceived(addresses: readonly string[]): Promise<void> {
    this.#notifications('stopnotifyreceived');
    for (const address of addresses) this.#received.delete(address);
    await this.call('stopnotifyreceived', [[...addresses]]);
  }

  /** redeemingtx for transactions spending these outpoints. */
  async notifySpent(outpoints: readonly OutPointRef[]): Promise<void> {
    this.#notifications('notifyspent');
    await this.call('notifyspent', [outpoints.map(wireOutPoint)]);
    for (const op of outpoints) this.#spent.set(outPointKey(op), op);
  }

  /** Stops redeemingtx for these outpoints. The limited RPC user may not call it. */
  async stopNotifySpent(outpoints: readonly OutPointRef[]): Promise<void> {
    this.#notifications('stopnotifyspent');
    for (const op of outpoints) this.#spent.delete(outPointKey(op));
    await this.call('stopnotifyspent', [outpoints.map(wireOutPoint)]);
  }

  /** Matches the loaded filter against consecutive blocks, by display hash. */
  async rescanBlocks(blockHashes: readonly string[]): Promise<RescannedBlock[]> {
    this.#notifications('rescanblocks');
    return (await this.call<RescannedBlock[] | null>('rescanblocks', [[...blockHashes]])) ?? [];
  }

  /**
   * btcd's older rescan: recvtx, redeemingtx and rescanprogress
   * notifications from beginBlock to endBlock or the tip, then rescanfinished.
   */
  async rescan(beginBlock: string, addresses: readonly string[], outpoints: readonly OutPointRef[], endBlock?: string): Promise<void> {
    this.#notifications('rescan');
    const params: unknown[] = [beginBlock, [...addresses], outpoints.map(wireOutPoint)];
    if (endBlock !== undefined) params.push(endBlock);
    await this.call('rescan', params);
  }

  /** pearld's random id for this connection; it changes when the client reconnects. */
  async session(): Promise<bigint> {
    // Session ids are random uint64s, past what a JS number holds exactly.
    const { sessionid } = await this.call<{ sessionid?: unknown }>('session', [], { integers: ['sessionid'] });
    if (typeof sessionid !== 'bigint') throw new PearlRpcError('response', 'session', 'no sessionid in the reply');
    return sessionid;
  }

  /**
   * Stops reconnecting, fails pending calls and closes the socket. Resolves
   * once the socket reports its close, or after three seconds if it never does.
   */
  close(): Promise<void> {
    if (this.#closing === null) {
      this.#closing = new Promise((resolve) => (this.#closeDone = resolve));
      if (this.#closed === null) this.#stop({ kind: 'network', message: 'the websocket client was closed' }, undefined);
      else if (this.#socket === null) this.#closeDone!();
    }
    return this.#closing;
  }

  // Calls

  async #call(
    method: string,
    params: readonly unknown[],
    parse: (text: string) => unknown,
    options: WsCallOptions,
  ): Promise<unknown> {
    const limit = options.timeout ?? this.#timeout ?? (UNBOUNDED_METHODS.has(method) ? 0 : DEFAULT_RPC_TIMEOUT);
    const timeout = limit > 0 ? limit : undefined;
    const { signal } = options;
    let abandoned: PearlRpcError | null = null;
    let sent: number | undefined;
    const run = async (): Promise<unknown> => {
      for (;;) {
        try {
          await this.#whenReady();
        } catch (failure) {
          throw this.#error(failure, method);
        }
        if (abandoned !== null) throw abandoned;
        const socket = this.#socket;
        if (socket === null || !this.#live) continue;
        return this.#request(socket, method, params, parse, (id) => (sent = id));
      }
    };
    if (timeout === undefined && signal === undefined) return run();
    return new Promise((resolve, reject) => {
      const give = (error: PearlRpcError) => {
        abandoned = error;
        if (sent !== undefined && this.#pending.delete(sent)) {
          this.#abandoned.add(sent);
          if (this.#abandoned.size > MAX_ABANDONED) this.#abandoned.delete(this.#abandoned.values().next().value!);
        }
        reject(error);
      };
      const timer =
        timeout === undefined
          ? undefined
          : setTimeout(() => give(new PearlRpcError('network', method, `no reply from ${this.#origin} within ${timeout} ms`)), timeout);
      const onAbort = () => give(new PearlRpcError('network', method, `call to ${this.#origin} was aborted`, { cause: signal?.reason }));
      if (signal?.aborted) onAbort();
      signal?.addEventListener('abort', onAbort, { once: true });
      run()
        .then(resolve, reject)
        .finally(() => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
        });
    });
  }

  #request(socket: Socket, method: string, params: readonly unknown[], parse: (text: string) => unknown, onSent?: (id: number) => void): Promise<unknown> {
    const id = ++this.#id;
    onSent?.(id);
    // pearld rejects requests without params.
    const body = encodeJson({ jsonrpc: '1.0', id, method, params });
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { method, parse, resolve, reject });
      try {
        socket.send(body);
      } catch (err) {
        this.#pending.delete(id);
        reject(new PearlRpcError('network', method, `cannot send to ${this.#origin}: ${(err as Error).message}`, { cause: err }));
      }
    });
  }

  #error(failure: unknown, method: string): PearlRpcError {
    if (failure instanceof PearlRpcError) return failure;
    const f = failure as Failure;
    const extra: { status?: number; cause?: unknown } = {};
    if (f.status !== undefined) extra.status = f.status;
    if (f.cause !== undefined) extra.cause = f.cause;
    return new PearlRpcError(f.kind, method, f.message, extra);
  }

  // Connection

  #whenReady(): Promise<void> {
    if (this.#closed !== null) return Promise.reject(this.#closed);
    if (this.#ready === null) {
      this.#waitForSession();
      this.#open();
    }
    return this.#ready!;
  }

  #waitForSession(): void {
    this.#ready = new Promise<void>((resolve, reject) => (this.#settle = { resolve, reject }));
    // Nobody may be waiting; the failure still reaches every caller that is.
    this.#ready.catch(() => {});
  }

  #open(): void {
    let socket: Socket;
    try {
      const auth = this.#auth === 'header' && (this.#username || this.#password);
      const headers = auth ? { Authorization: basicAuth(this.#username, this.#password) } : undefined;
      const init =
        headers === undefined
          ? this.#init
          : { ...this.#init, headers: { ...(this.#init?.headers as Record<string, string> | undefined), ...headers } };
      socket = init === undefined ? new this.#ctor(this.#url) : new this.#ctor(this.#url, init);
    } catch (err) {
      this.#dropped(false, { kind: 'network', message: `cannot open a websocket to ${this.#origin}: ${(err as Error).message}`, cause: err });
      return;
    }
    this.#socket = socket;
    let opened = false;
    socket.onopen = () => {
      opened = true;
      void this.#start(socket);
    };
    socket.onmessage = (event) => {
      if (this.#socket === socket && this.#closed === null) this.#receive(event.data);
    };
    const lost = (event: { code?: number } | undefined) => {
      if (this.#socket !== socket) return;
      this.#socket = null;
      this.#live = false;
      this.#serverBlocks = false;
      this.#serverTx = null;
      const code = typeof event?.code === 'number' ? ` (code ${event.code})` : '';
      const message = opened
        ? `${this.#origin} closed the websocket${code}`
        : `cannot open a websocket to ${this.#origin}${code}; check the URL, TLS trust, and credentials when auth is "header"`;
      this.#dropped(opened, { kind: 'network', message });
    };
    socket.onclose = lost;
    this.#lose = (dead) => {
      if (dead !== socket) return;
      lost(undefined);
      try {
        socket.close(1000);
      } catch {
        // Already closing.
      }
    };
    // Once open, a close event follows any error. Node 22's WebSocket sends
    // no close after a refused upgrade, so an error before open ends it here.
    socket.onerror = () => {
      if (opened) return;
      lost(undefined);
      try {
        socket.close();
      } catch {
        // Some implementations refuse close while connecting; the socket is already abandoned.
      }
    };
  }

  async #start(socket: Socket): Promise<void> {
    try {
      if (this.#auth === 'command' && (this.#username || this.#password)) {
        this.#authenticating = true;
        await this.#request(socket, 'authenticate', [this.#username, this.#password], () => null);
        this.#authenticating = false;
      }
    } catch (err) {
      // A close during authenticate is handled by onclose; an error reply is not something pearld sends.
      if (this.#socket === socket && err instanceof PearlRpcError && err.kind === 'rpc') {
        this.#authenticating = false;
        this.#emit('error', err);
        socket.close(1000);
      }
      return;
    }
    if (this.#socket !== socket || this.#closed !== null) return;
    this.#live = true;
    await this.#resubscribe(socket);
    if (this.#socket !== socket || this.#closed !== null) return;
    const reconnect = this.#sessions > 0;
    this.#sessions++;
    this.#attempt = 0;
    this.#settle?.resolve();
    this.#settle = null;
    this.#ping(socket);
    this.#emit('connect', { reconnect });
  }

  #ping(socket: Socket): void {
    this.#stopPinging();
    if (this.#keepAlive === 0) return;
    let waiting = false;
    this.#pinger = setInterval(() => {
      if (this.#socket !== socket || !this.#live) {
        this.#stopPinging();
        return;
      }
      if (waiting) {
        // A half-open connection may never report its close; this is how it is found.
        this.#stopPinging();
        this.#emit('error', new PearlRpcError('network', 'session', `${this.#origin} did not answer a ping within ${this.#keepAlive} ms, so the session is dropped`));
        this.#lose?.(socket);
        return;
      }
      waiting = true;
      this.#request(socket, 'session', [], () => null).then(
        () => (waiting = false),
        () => undefined,
      );
    }, this.#keepAlive);
    (this.#pinger as { unref?: () => void }).unref?.();
  }

  #stopPinging(): void {
    clearInterval(this.#pinger);
    this.#pinger = undefined;
  }

  async #resubscribe(socket: Socket): Promise<void> {
    const commands: [string, unknown[]][] = [];
    this.#serverBlocks = this.#blockWatchers > 0;
    this.#serverTx = this.#wantedTx();
    if (this.#serverBlocks) commands.push(['notifyblocks', []]);
    if (this.#serverTx !== null) commands.push(['notifynewtransactions', [this.#serverTx]]);
    if (this.#filter !== null) {
      commands.push(['loadtxfilter', [true, [...this.#filter.addresses], [...this.#filter.outpoints.values()].map(wireOutPoint)]]);
    }
    if (this.#received.size > 0) commands.push(['notifyreceived', [[...this.#received]]]);
    if (this.#spent.size > 0) commands.push(['notifyspent', [[...this.#spent.values()].map(wireOutPoint)]]);
    const results = await Promise.allSettled(commands.map(([method, params]) => this.#request(socket, method, params, () => null)));
    for (const result of results) {
      if (result.status === 'rejected' && this.#socket === socket) this.#emit('error', result.reason as Error);
    }
  }

  #dropped(opened: boolean, failure: Failure): void {
    this.#stopPinging();
    const authenticating = this.#authenticating;
    this.#authenticating = false;
    this.#abandoned.clear();
    for (const [id, pending] of this.#pending) {
      this.#pending.delete(id);
      pending.reject(new PearlRpcError('network', pending.method, `${failure.message} before the reply`));
    }
    if (this.#closed !== null) {
      clearTimeout(this.#closeTimer);
      this.#closeDone?.();
      return;
    }
    if (this.#sessions === 0) {
      // The first connection is not retried: report why and start afresh on the next call.
      const reason: Failure =
        opened && authenticating
          ? {
              kind: 'http',
              status: 401,
              message: `${this.#origin} closed the websocket after authenticate: the RPC username or password was refused, or rpcmaxwebsockets clients are connected`,
            }
          : failure;
      this.#settle?.reject(reason);
      this.#settle = null;
      this.#ready = null;
      return;
    }
    if (this.#settle === null) {
      this.#waitForSession();
      this.#emit('disconnect', { error: new PearlRpcError(failure.kind, 'websocket', failure.message) });
    }
    const policy = this.#reconnect;
    if (policy === null || this.#attempt >= policy.retries) {
      const reason = policy === null ? failure : { ...failure, message: `${failure.message}; gave up after ${this.#attempt} reconnect attempts` };
      this.#stop(reason, new PearlRpcError(reason.kind, 'websocket', reason.message));
      return;
    }
    const delay = Math.min(policy.maxDelay, policy.initialDelay * 2 ** this.#attempt);
    this.#attempt++;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      if (this.#closed === null) this.#open();
    }, delay);
  }

  #stop(reason: Failure, error: Error | undefined): void {
    if (this.#closed !== null) return;
    this.#closed = reason;
    this.#stopPinging();
    clearTimeout(this.#timer);
    this.#settle?.reject(reason);
    this.#settle = null;
    for (const [id, pending] of this.#pending) {
      this.#pending.delete(id);
      pending.reject(new PearlRpcError(reason.kind, pending.method, `${reason.message} before the reply`));
    }
    const socket = this.#socket;
    this.#live = false;
    if (error !== undefined) this.#emit('error', error);
    this.#emit('close', error === undefined ? {} : { error });
    if (socket !== null && socket.readyState === OPEN) {
      socket.close(1000);
      this.#closeTimer = setTimeout(() => {
        if (this.#socket !== socket) return;
        this.#socket = null;
        this.#closeDone?.();
      }, CLOSE_TIMEOUT);
      return;
    }
    // A socket still connecting may never report its close.
    this.#socket = null;
    try {
      socket?.close(1000);
    } catch {
      // Already failed or closed.
    }
    this.#closeDone?.();
  }

  // Frames

  #receive(data: unknown): void {
    const text = typeof data === 'string' ? data : data instanceof ArrayBuffer || ArrayBuffer.isView(data) ? decode(data) : null;
    if (text === null) {
      this.#emit('error', this.#bad(`a non-text frame from ${this.#origin}`));
      return;
    }
    if (text.length > this.#maxReplySize) {
      this.#emit('error', this.#bad(`a frame from ${this.#origin} is larger than maxReplySize, ${this.#maxReplySize} characters; dropping the connection`));
      // The close fails the calls waiting on this socket. Browsers refuse
      // 1009 from a client, so the code is the plain one.
      this.#socket?.close(1000);
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch (err) {
      this.#emit('error', this.#bad(`unreadable frame from ${this.#origin}: ${(err as Error).message}`, err));
      return;
    }
    if (typeof message !== 'object' || message === null || Array.isArray(message)) {
      this.#emit('error', this.#bad(`expected a JSON-RPC object from ${this.#origin}, got ${text.slice(0, 120)}`));
      return;
    }
    const { id, method, params, error } = message as { id?: unknown; method?: unknown; params?: unknown; error?: unknown };
    if (typeof method === 'string' && (id === null || id === undefined)) {
      this.#notification(method, params, text);
      return;
    }
    const pending = typeof id === 'number' ? this.#pending.get(id) : undefined;
    if (pending === undefined && typeof id === 'number' && this.#abandoned.delete(id)) return;
    if (pending === undefined) {
      const err = isError(error)
        ? rpcError('websocket', error)
        : this.#bad(`reply for unknown request id ${JSON.stringify(id)} from ${this.#origin}`);
      this.#emit('error', err);
      return;
    }
    this.#pending.delete(id as number);
    if (isError(error)) {
      pending.reject(rpcError(pending.method, error));
      return;
    }
    if (!('result' in message)) {
      pending.reject(new PearlRpcError('response', pending.method, `expected a JSON-RPC reply, got ${text.slice(0, 120)}`));
      return;
    }
    try {
      pending.resolve(pending.parse(text));
    } catch (err) {
      pending.reject(new PearlRpcError('response', pending.method, `unreadable reply: ${(err as Error).message}`, { cause: err }));
    }
  }

  #notification(method: string, params: unknown, text: string): void {
    let value: unknown;
    try {
      if (!Array.isArray(params)) throw new Error('params is not an array');
      value = decodeNotification(method, params, text);
    } catch (err) {
      this.#emit('error', this.#bad(`malformed ${method} notification: ${(err as Error).message}`, err));
      return;
    }
    if (value === undefined) {
      this.#emit('error', this.#bad(`unknown notification ${method}`));
      return;
    }
    this.#emit(method as keyof PearlNotifications, value as never);
    if (method === 'txacceptedverbose') {
      const tx = value as TxRawResult;
      this.#emit('txaccepted', { txid: tx.txid, amount: tx.vout.reduce((sum, out) => sum + out.value, 0n) });
    }
  }

  #bad(message: string, cause?: unknown): PearlRpcError {
    return new PearlRpcError('response', 'websocket', message, cause === undefined ? {} : { cause });
  }

  #emit<K extends keyof PearlWsEvents>(event: K, value: PearlWsEvents[K]): void {
    for (const listener of [...(this.#listeners.get(event) ?? [])]) {
      try {
        (listener as (value: PearlWsEvents[K]) => void)(value);
      } catch (err) {
        // A throwing listener must not break dispatch; report it unless it was an error listener.
        if (event !== 'error') this.#emit('error', err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  // Subscriptions

  #notifications(method: string): void {
    if (this.#oyster) {
      throw new PearlError('BACKEND_UNSUPPORTED', `${method}: Oyster's websocket sends no notifications and would pass ${method} to its own pearld connection`);
    }
  }

  #watch(
    events: readonly (keyof PearlNotifications)[],
    listener: Listener,
    onError: ((error: Error) => void) | undefined,
    kind: 'blocks' | 'plain' | 'verbose',
  ): () => void {
    this.#notifications(kind === 'blocks' ? 'notifyblocks' : 'notifynewtransactions');
    const offs = events.map((event) => this.on(event, listener as never));
    if (onError !== undefined) offs.push(this.on('error', onError));
    const count = (delta: number) => {
      if (kind === 'blocks') this.#blockWatchers += delta;
      else if (kind === 'verbose') this.#verboseTxWatchers += delta;
      else this.#plainTxWatchers += delta;
      this.#sync();
    };
    count(1);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      for (const off of offs) off();
      count(-1);
    };
  }

  #wantedTx(): boolean | null {
    return this.#plainTxWatchers + this.#verboseTxWatchers > 0 ? this.#verboseTxWatchers > 0 : null;
  }

  // Brings pearld's block and transaction subscriptions in line with the
  // watchers. Without a live session there is nothing to stop, and the next
  // session subscribes as it starts.
  #sync(): void {
    const wantBlocks = this.#blockWatchers > 0;
    const wantTx = this.#wantedTx();
    if (!this.#live && !wantBlocks && wantTx === null) return;
    // The command that moves one subscription toward what the watchers want,
    // and how to take the move back if pearld refuses it.
    const next = (): [string, unknown[], () => void] | null => {
      if (this.#blockWatchers > 0 !== this.#serverBlocks) {
        this.#serverBlocks = !this.#serverBlocks;
        const undo = () => (this.#serverBlocks = !this.#serverBlocks);
        return [this.#serverBlocks ? 'notifyblocks' : 'stopnotifyblocks', [], undo];
      }
      const tx = this.#wantedTx();
      if (tx !== this.#serverTx) {
        const was = this.#serverTx;
        this.#serverTx = tx;
        const undo = () => (this.#serverTx = was);
        return tx === null ? ['stopnotifynewtransactions', [], undo] : ['notifynewtransactions', [tx], undo];
      }
      return null;
    };
    const run = async (): Promise<void> => {
      for (;;) {
        await this.#whenReady();
        const socket = this.#socket;
        if (socket === null || !this.#live) continue;
        const commands: Promise<unknown>[] = [];
        for (let command = next(); command !== null; command = next()) {
          const [method, params, undo] = command;
          const sent = this.#request(socket, method, params, () => null);
          // pearld's limited user may subscribe but not unsubscribe. The
          // subscription then stays, and its notifications reach no listener.
          commands.push(
            method.startsWith('stop')
              ? sent.catch((err: unknown) => {
                  if (!isLimitedUserRefusal(err)) throw err;
                  undo();
                })
              : sent,
          );
        }
        await Promise.all(commands);
        return;
      }
    };
    run().catch((err: unknown) => {
      if (this.#closed === null) this.#emit('error', this.#error(err, 'subscribe'));
    });
  }

  #iterate<T>(watch: (push: (value: T) => void) => () => void): AsyncIterableIterator<T> {
    const queue: T[] = [];
    const waiting: { resolve: (r: IteratorResult<T>) => void; reject: (e: unknown) => void }[] = [];
    let ended: { error?: Error } | null = null;
    const finish = (end: { error?: Error }) => {
      if (ended !== null) return;
      ended = end;
      unwatch();
      offClose();
      for (const w of waiting.splice(0)) {
        if (end.error === undefined) w.resolve({ value: undefined, done: true });
        else w.reject(end.error);
      }
    };
    const offClose = this.on('close', (event) => finish(event));
    const unwatch = this.#closed === null ? watch((value) => {
      const w = waiting.shift();
      if (w !== undefined) w.resolve({ value, done: false });
      else queue.push(value);
    }) : () => {};
    if (this.#closed !== null) finish({});
    const iterator: AsyncIterableIterator<T> = {
      next: () => {
        if (queue.length > 0) return Promise.resolve({ value: queue.shift()!, done: false });
        if (ended !== null) {
          const end: { error?: Error } = ended;
          return end.error === undefined ? Promise.resolve({ value: undefined, done: true }) : Promise.reject(end.error);
        }
        return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
      },
      return: () => {
        finish({});
        queue.length = 0;
        return Promise.resolve({ value: undefined, done: true });
      },
      [Symbol.asyncIterator]: () => iterator,
    };
    return iterator;
  }
}

/** pearld's websocket client: every typed method of PearldClient, plus notifications. */
export class PearlWsClient extends /* @__PURE__ */ pearldMethods(JsonRpcWsClient) {
  constructor(options: PearlWsClientOptions) {
    super(options);
  }
}

/**
 * Oyster's websocket client: every typed method of OysterClient over one
 * connection. Oyster's /ws answers calls and sends no notifications, and it
 * would pass a notification command on to its own pearld connection, so the
 * subscription methods throw BACKEND_UNSUPPORTED; subscribe on a PearlWsClient
 * to pearld. Oyster only takes Basic auth on the upgrade, so `auth` is
 * "header" unless given, which needs a WebSocket constructor that accepts
 * headers (undici's or the `ws` package's, not a browser's).
 */
export class OysterWsClient extends /* @__PURE__ */ oysterMethods(JsonRpcWsClient) {
  constructor(options: Omit<PearlWsClientOptions, 'notifications'>) {
    super({ auth: 'header', ...options, notifications: false });
  }
}

// Decoding

const TXACCEPTED_RE = /"params"\s*:\s*\[\s*"([0-9a-f]{64})"\s*,\s*(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\s*\]/;

function decodeNotification(method: string, params: unknown[], text: string): unknown {
  switch (method) {
    case 'blockconnected':
    case 'blockdisconnected':
      return { type: method === 'blockconnected' ? 'connected' : 'disconnected', ...rescanEvent(params) };
    case 'rescanprogress':
    case 'rescanfinished':
      return rescanEvent(params);
    case 'filteredblockconnected':
    case 'filteredblockdisconnected': {
      const header = parseBlockHeader(fromHex(str(params[1], 'header'), 'header is not hex'));
      const txs = params[2] ?? [];
      if (!Array.isArray(txs) || !txs.every((tx) => typeof tx === 'string')) throw new Error('transactions are not hex strings');
      return {
        type: method === 'filteredblockconnected' ? 'connected' : 'disconnected',
        height: int(params[0], 'height'),
        hash: blockHashHex(header),
        header,
        transactions: txs as string[],
      };
    }
    case 'txaccepted': {
      // The amount is a bare number in the params, so it is taken from the text.
      const m = TXACCEPTED_RE.exec(text);
      if (m === null) throw new Error('expected a txid and an amount');
      return { txid: m[1]!, amount: decimalToGrain(m[2]!) };
    }
    case 'txacceptedverbose': {
      const parsed = parseJson(text, new Set(['value'])) as { params: [TxRawResult] };
      const tx = parsed.params[0];
      if (typeof tx !== 'object' || tx === null || typeof tx.txid !== 'string' || !Array.isArray(tx.vout)) {
        throw new Error('expected a raw transaction result');
      }
      return tx;
    }
    case 'relevanttxaccepted':
      return { transaction: str(params[0], 'transaction') };
    case 'recvtx':
    case 'redeemingtx': {
      const block = params[1];
      if (block === undefined || block === null) return { transaction: str(params[0], 'transaction'), block: null };
      const b = block as Record<string, unknown>;
      return {
        transaction: str(params[0], 'transaction'),
        block: { hash: str(b.hash, 'block hash'), height: int(b.height, 'height'), index: int(b.index, 'index'), time: int(b.time, 'time') },
      };
    }
    default:
      return undefined;
  }
}

function rescanEvent(params: unknown[]): RescanEvent {
  return { hash: str(params[0], 'hash'), height: int(params[1], 'height'), time: int(params[2], 'time') };
}

function str(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} is not a string`);
  return value;
}

function int(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(`${label} is not an integer`);
  return value as number;
}

function isError(error: unknown): error is { code?: unknown; message?: unknown } {
  return typeof error === 'object' && error !== null;
}

function wireOutPoint(op: OutPointRef): { hash: string; index: number } {
  return { hash: op.txid, index: op.vout };
}

function outPointKey(op: OutPointRef): string {
  return `${op.txid}:${op.vout}`;
}

function decode(data: ArrayBuffer | ArrayBufferView): string {
  return new TextDecoder().decode(data);
}

