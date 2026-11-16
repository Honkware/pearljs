// The server side of pearld's websocket (node/rpcwebsocket.go) over a
// simulated chain: RPC calls, the notification commands, and the frames the
// notification manager writes when a block connects or a transaction is
// accepted. A PearlWsClient cannot tell it from a socket to pearld.

import { toOutputScript } from '../address.js';
import { serializeBlockHeader } from '../blockheader.js';
import { AddressError, PearlRpcError } from '../errors.js';
import { toHex } from '../internal/bytes.js';
import { PrlAmount, encodeJson } from '../internal/rpc-wire.js';
import type { Transaction } from '../transaction.js';
import type { SimulatedBlock, SimulatedChain, SimulatedEvent } from './chain.js';
import { simulatedReply } from './rpc.js';

const prevTxid = (input: Transaction['ins'][number]): string => toHex(Uint8Array.from(input.hash).reverse());
const outpoint = (txid: string, vout: number): string => `${txid}:${vout}`;

/** One simulated connection; what a PearlWsClient needs of a WebSocket. */
export interface SimulatedSocket {
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onclose: ((event: { code?: number }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

/** A WebSocket constructor bound to one simulated chain. */
export interface SimulatedWebSocket {
  new (url: string, init?: object): SimulatedSocket;
  /** Connections open right now. */
  readonly connections: number;
  /** Closes every open connection from the server's side, as a restarted node does; clients with reconnect on come back. */
  dropAll(code?: number): void;
  /** Refuses the next `count` connections before they open. */
  refuseNext(count?: number): void;
}

interface Watch {
  scripts: Set<string>;
  outpoints: Set<string>;
}

const scriptsOf = (chain: SimulatedChain, addresses: unknown): string[] =>
  (Array.isArray(addresses) ? addresses : []).map((address) => toHex(toOutputScript(String(address), chain.network)));
const outpointsOf = (list: unknown): string[] =>
  (Array.isArray(list) ? (list as { hash?: unknown; index?: unknown }[]) : []).map((op) => outpoint(String(op.hash), Number(op.index)));

// Whether a transaction pays a watched script or spends a watched outpoint; outputs it pays to a watched script become watched.
function matches(watch: Watch, tx: Transaction): { pays: boolean; spends: boolean } {
  const spends = !tx.isCoinbase() && tx.ins.some((input) => watch.outpoints.has(outpoint(prevTxid(input), input.index)));
  let pays = false;
  tx.outs.forEach((out, vout) => {
    if (!watch.scripts.has(toHex(out.script))) return;
    watch.outpoints.add(outpoint(tx.getId(), vout));
    pays = true;
  });
  return { pays, spends };
}

export function simulatedWebSocket(chain: SimulatedChain): SimulatedWebSocket {
  const open = new Set<Socket>();
  let refusals = 0;
  let sessions = 0;

  class Socket implements SimulatedSocket {
    static get connections(): number {
      return open.size;
    }

    static dropAll(code = 1006): void {
      for (const socket of [...open]) socket.shut(code);
    }

    static refuseNext(count = 1): void {
      refusals += count;
    }

    readyState = 0;
    onopen: ((event: unknown) => void) | null = null;
    onclose: ((event: { code?: number }) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    #blocks = false;
    #transactions: 'plain' | 'verbose' | null = null;
    #filter: Watch | null = null;
    // notifyreceived and notifyspent share one watch list, apart from the filter.
    readonly #watched: Watch = { scripts: new Set(), outpoints: new Set() };
    readonly #session = ++sessions;
    #stop: (() => void) | null = null;

    constructor() {
      queueMicrotask(() => {
        if (this.readyState !== 0) return;
        if (refusals > 0) {
          refusals -= 1;
          this.readyState = 3;
          this.onerror?.({});
          this.onclose?.({ code: 1006 });
          return;
        }
        this.readyState = 1;
        open.add(this);
        this.#stop = chain.subscribe((event) => this.#notify(event));
        this.onopen?.({});
      });
    }

    send(data: string): void {
      if (this.readyState !== 1) throw new Error('the simulated websocket is not open');
      queueMicrotask(() => this.#receive(data));
    }

    close(code = 1000): void {
      this.shut(code);
    }

    shut(code: number): void {
      if (this.readyState === 3) return;
      this.readyState = 3;
      open.delete(this);
      this.#stop?.();
      queueMicrotask(() => this.onclose?.({ code }));
    }

    #push(frame: unknown): void {
      const text = typeof frame === 'string' ? frame : encodeJson(frame);
      queueMicrotask(() => {
        if (this.readyState === 1) this.onmessage?.({ data: text });
      });
    }

    #send(method: string, params: unknown[]): void {
      this.#push({ jsonrpc: '1.0', method, params, id: null });
    }

    #receive(data: string): void {
      if (this.readyState !== 1) return;
      let request: { id?: unknown; method?: unknown; params?: unknown };
      try {
        request = JSON.parse(data) as typeof request;
      } catch (err) {
        this.#push({ jsonrpc: '1.0', result: null, error: { code: -32700, message: `Failed to parse request: ${(err as Error).message}` }, id: null });
        return;
      }
      const id = typeof request.id === 'number' ? request.id : null;
      const method = String(request.method);
      const params = Array.isArray(request.params) ? (request.params as unknown[]) : [];
      try {
        chain.enter(method);
      } catch (err) {
        // A failed call on a socket is the socket going away.
        if (!(err instanceof PearlRpcError)) throw err;
        this.shut(1006);
        return;
      }
      const reply = (result: unknown): void => this.#push({ jsonrpc: '1.0', result, error: null, id });
      const fail = (code: number, message: string): void => this.#push({ jsonrpc: '1.0', result: null, error: { code, message }, id });
      try {
        switch (method) {
          case 'authenticate':
            return reply(null);
          case 'session':
            return reply({ sessionid: this.#session });
          case 'notifyblocks':
            this.#blocks = true;
            return reply(null);
          case 'stopnotifyblocks':
            this.#blocks = false;
            return reply(null);
          case 'notifynewtransactions':
            this.#transactions = params[0] === true ? 'verbose' : 'plain';
            return reply(null);
          case 'stopnotifynewtransactions':
            this.#transactions = null;
            return reply(null);
          case 'loadtxfilter':
            if (params[0] === true || this.#filter === null) this.#filter = { scripts: new Set(), outpoints: new Set() };
            for (const script of scriptsOf(chain, params[1])) this.#filter.scripts.add(script);
            for (const op of outpointsOf(params[2])) this.#filter.outpoints.add(op);
            return reply(null);
          case 'notifyreceived':
            for (const script of scriptsOf(chain, params[0])) this.#watched.scripts.add(script);
            return reply(null);
          case 'stopnotifyreceived':
            for (const script of scriptsOf(chain, params[0])) this.#watched.scripts.delete(script);
            return reply(null);
          case 'notifyspent':
            for (const op of outpointsOf(params[0])) this.#watched.outpoints.add(op);
            return reply(null);
          case 'stopnotifyspent':
            for (const op of outpointsOf(params[0])) this.#watched.outpoints.delete(op);
            return reply(null);
          case 'rescanblocks': {
            if (this.#filter === null) return fail(-1, 'Transaction filter must be loaded before rescanning');
            const found: { hash: string; transactions: string[] }[] = [];
            for (const hash of Array.isArray(params[0]) ? params[0] : []) {
              const block = chain.block(String(hash));
              if (block === null) return fail(-5, `Failed to fetch block: block ${String(hash)} not found`);
              const transactions = this.#relevant(this.#filter, block);
              if (transactions.length > 0) found.push({ hash: block.hash, transactions });
            }
            return reply(found);
          }
          case 'rescan': {
            const begin = chain.block(String(params[0]));
            const end = params[3] === undefined || params[3] === null ? chain.tip : chain.block(String(params[3]));
            if (begin === null || end === null || !chain.isActive(begin) || !chain.isActive(end)) return fail(-5, 'Error getting block: block not found');
            const watch: Watch = { scripts: new Set(scriptsOf(chain, params[1])), outpoints: new Set(outpointsOf(params[2])) };
            for (const block of chain.blocks.slice(begin.height, end.height + 1)) this.#transactionsOf(watch, block);
            this.#send('rescanfinished', [end.hash, end.height, end.time]);
            return reply(null);
          }
          default:
            return this.#push(simulatedReply(chain, method, params, id));
        }
      } catch (err) {
        // The only thing the cases above throw: an address of a filter or watch list that does not decode.
        if (!(err instanceof AddressError)) throw err;
        fail(-5, `Invalid address or key: ${err.message}`);
      }
    }

    // Hex of the block's transactions the filter matches.
    #relevant(filter: Watch, block: SimulatedBlock): string[] {
      return block.txs.filter((tx) => {
        const { pays, spends } = matches(filter, tx);
        return pays || spends;
      }).map((tx) => tx.toHex());
    }

    // recvtx and redeemingtx for one transaction, in a block or not.
    #transaction(watch: Watch, tx: Transaction, block: SimulatedBlock | null, index: number): void {
      const { pays, spends } = matches(watch, tx);
      const details = block === null ? [] : [{ height: block.height, hash: block.hash, index, time: block.time }];
      if (spends) this.#send('redeemingtx', [tx.toHex(), ...details]);
      if (pays) this.#send('recvtx', [tx.toHex(), ...details]);
    }

    #transactionsOf(watch: Watch, block: SimulatedBlock): void {
      block.txs.forEach((tx, index) => this.#transaction(watch, tx, block, index));
    }

    #notify(event: SimulatedEvent): void {
      if (event.type === 'connected' || event.type === 'disconnected') {
        const { block } = event;
        if (event.type === 'connected') this.#transactionsOf(this.#watched, block);
        if (!this.#blocks) return;
        const header = toHex(serializeBlockHeader(block.block.header));
        this.#send(`block${event.type}`, [block.hash, block.height, block.time]);
        if (event.type === 'disconnected') return this.#send('filteredblockdisconnected', [block.height, header]);
        const relevant = this.#filter === null ? [] : this.#relevant(this.#filter, block);
        return this.#send('filteredblockconnected', [block.height, header, relevant.length > 0 ? relevant : null]);
      }
      if (event.type !== 'accepted') return;
      const { tx } = event.entry;
      if (this.#transactions === 'plain') {
        this.#send('txaccepted', [tx.getId(), new PrlAmount(tx.outs.reduce((sum, out) => sum + out.value, 0n))]);
      } else if (this.#transactions === 'verbose') {
        // What getrawtransaction answers for it, cut out of the reply as text so no amount passes through a float.
        const reply = simulatedReply(chain, 'getrawtransaction', [tx.getId(), 1], null);
        const result = reply.slice(reply.indexOf('"result":') + 9, reply.lastIndexOf(',"error":null'));
        this.#push(`{"jsonrpc":"1.0","method":"txacceptedverbose","params":[${result}],"id":null}`);
      }
      if (this.#filter !== null) {
        const { pays, spends } = matches(this.#filter, tx);
        if (pays || spends) this.#send('relevanttxaccepted', [tx.toHex()]);
      }
      this.#transaction(this.#watched, tx, null, 0);
    }
  }

  return Socket;
}
