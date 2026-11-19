// A Blockbook over a simulated chain: the REST API v2 as a fetch, and the
// websocket API as a WebSocket constructor, for BlockbookClient,
// BlockbookWsClient and blockbookBackend.
//
// Shapes and semantics follow Pearl's fork of Blockbook at commit 81f52f21
// (github.com/pearl-research-labs/blockbook, feat/pearl-coin-support;
// feat/pearl-fp8-testnet at 6d736fc6 is the same here): the structs in
// api/types.go, server/ws_types.go and common/internalstate.go, the
// handlers in server/public.go and server/websocket.go, and api/worker.go
// for what they compute, and held to replies of Pearl's own servers recorded
// on 2026-11-19 (test/fixtures/blockbook/). Kept on purpose: amounts as
// decimal strings, Go's omitted zero and empty fields, blockHeight -1 in the
// mempool, the mempool put in front of an address's first page and that
// page cut to the page size, the last page repeated for a page past the
// end, the spend of an output marked only once a block confirms it (with
// the extended index Pearl's configs turn on), a confirmed coinbase output
// never flagged as one in utxo replies, {"error": text} with HTTP 400 for an
// error Blockbook calls public and 500 otherwise, and the websocket's
// estimateFee refused, since it asks pearld for estimatesmartfee. Values
// Blockbook takes from its build, host and pearld (version, gitCommit,
// buildTime, host, about, dbSize, the backend's version and subversion) are
// placeholders, the confirmation ETA is approximate, and fiat rates (which
// Pearl's servers do not serve) and xpubs are left out.

import { fromOutputScript, toOutputScript } from '../address.js';
import { serializeBlock } from '../block.js';
import { difficultyForBits } from '../consensus.js';
import { toHex } from '../internal/bytes.js';
import { classifyOutputScript } from '../script.js';
import type { Transaction } from '../transaction.js';
import type { SimulatedBlock, SimulatedChain, SimulatedEvent } from './chain.js';
import { simulatedReply } from './rpc.js';

/** A Blockbook over a simulated chain. */
export interface SimulatedBlockbook {
  /** A base URL to give BlockbookClient and BlockbookWsClient; the host is never contacted. */
  readonly url: string;
  /** Answers Blockbook's REST paths under any host. */
  readonly fetch: typeof fetch;
  /** A WebSocket constructor speaking Blockbook's websocket protocol. */
  readonly WebSocket: SimulatedBlockbookWebSocket;
  /** Every REST path and query asked, in order, from "api/" on. */
  readonly requests: string[];
}

/** One simulated Blockbook websocket connection. */
export interface SimulatedBlockbookSocket {
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onclose: ((event: { code?: number }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  send(data: string): void;
  close(code?: number): void;
}

/** The WebSocket constructor of a simulated Blockbook. */
export interface SimulatedBlockbookWebSocket {
  new (url: string, init?: object): SimulatedBlockbookSocket;
  /** Connections open right now. */
  readonly connections: number;
  /** Closes every connection from the server's side. */
  dropAll(code?: number): void;
}

// server/public.go
const TXS_IN_API = 1000;
const TXS_DETAILS_IN_API = 100;
const MAX_PAGE_NUMBER = 1_000_000;
const MAX_ACCOUNT_HISTORY_OFFSET = 100_000;

const prevTxid = (input: Transaction['ins'][number]): string => toHex(Uint8Array.from(input.hash).reverse());

class ApiError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

/** Blockbook's REST and websocket APIs over `chain`. */
export function simulatedBlockbook(chain: SimulatedChain): SimulatedBlockbook {
  const requests: string[] = [];
  const network = chain.network;
  const mempoolOrder = (): Transaction[] => [...chain.mempool.values()].map((entry) => entry.tx);

  const addressesOf = (script: Uint8Array): { addresses: string[]; isAddress: boolean } => {
    const type = classifyOutputScript(script);
    return type === 'p2tr' || type === 'p2mr' ? { addresses: [fromOutputScript(script, network)], isAddress: true } : { addresses: [], isAddress: false };
  };
  const confirmations = (block: SimulatedBlock | null): number => (block === null ? 0 : chain.height - block.height + 1);
  const valueIn = (tx: Transaction): bigint => (tx.isCoinbase() ? 0n : tx.ins.reduce((sum, input) => sum + (chain.output(prevTxid(input), input.index)?.value ?? 0n), 0n));
  const valueOut = (tx: Transaction): bigint => tx.outs.reduce((sum, out) => sum + out.value, 0n);
  const fees = (tx: Transaction): bigint => (tx.isCoinbase() ? 0n : valueIn(tx) - valueOut(tx) > 0n ? valueIn(tx) - valueOut(tx) : 0n);
  const spentFields = (txid: string, vout: number): Record<string, unknown> => {
    const spender = chain.spender(txid, vout);
    if (spender === null || !spender.confirmed) return {};
    const spending = chain.transaction(spender.txid)!;
    const index = spending.tx.ins.findIndex((input) => prevTxid(input) === txid && input.index === vout);
    return { spent: true, spentTxId: spender.txid, ...(index > 0 ? { spentIndex: index } : {}), spentHeight: spending.block!.height };
  };
  const omitZero = (key: string, value: number): Record<string, number> => (value === 0 ? {} : { [key]: value });
  // Worker.getConfirmationETA: one block while the mempool holds under 32
  // transactions, which is taken here for any size, times the average
  // interval of the last 100 blocks.
  const confirmationEta = (): Record<string, number> => {
    const recent = chain.blocks.slice(-101);
    const period = recent.length < 2 ? network.targetSpacing : Math.floor((recent.at(-1)!.time - recent[0]!.time) / (recent.length - 1));
    return { confirmationETABlocks: 1, ...omitZero('confirmationETASeconds', period) };
  };

  // api.Tx as GetTransactionFromBchainTx builds it.
  const fullTx = (tx: Transaction, block: SimulatedBlock | null): Record<string, unknown> => {
    const txid = tx.getId();
    const vin = tx.isCoinbase()
      ? [{ ...omitZero('sequence', tx.ins[0]!.sequence), n: 0, isAddress: false, coinbase: toHex(tx.ins[0]!.script) }]
      : tx.ins.map((input, n) => {
          const out = chain.output(prevTxid(input), input.index);
          const { addresses, isAddress } = out === null ? { addresses: [], isAddress: false } : addressesOf(out.script);
          return {
            txid: prevTxid(input), ...omitZero('vout', input.index), ...omitZero('sequence', input.sequence), n,
            ...(addresses.length > 0 ? { addresses } : {}), isAddress,
            ...(out === null ? {} : { value: out.value.toString() }), ...(input.script.length > 0 ? { hex: toHex(input.script) } : {}),
          };
        });
    const vout = tx.outs.map((out, n) => ({ value: out.value.toString(), n, ...(block === null ? {} : spentFields(txid, n)), hex: toHex(out.script), ...addressesOf(out.script) }));
    const time = block === null ? chain.mempool.get(txid)!.time : block.time;
    const rbf = block === null && tx.ins.some((input) => input.sequence < 0xfffffffe);
    return {
      txid, ...omitZero('version', tx.version), ...omitZero('lockTime', tx.locktime), vin, vout,
      ...(block === null ? {} : { blockHash: block.hash }), blockHeight: block === null ? -1 : block.height,
      confirmations: confirmations(block), ...(block === null ? confirmationEta() : {}), blockTime: time, size: tx.byteLength(), vsize: tx.virtualSize(),
      value: valueOut(tx).toString(), valueIn: valueIn(tx).toString(), fees: fees(tx).toString(), hex: tx.toHex(),
      ...(rbf ? { rbf: true } : {}),
      ...(block === null ? { coinSpecificData: (JSON.parse(simulatedReply(chain, 'getrawtransaction', [txid, 1], 1)) as { result: unknown }).result } : {}),
    };
  };

  // api.Tx as txFromTxAddress builds it from the index: no hex, no scripts, no sequences.
  const lightTx = (tx: Transaction, block: SimulatedBlock): Record<string, unknown> => {
    const txid = tx.getId();
    const vin = tx.isCoinbase()
      ? [{ n: 0, isAddress: false, value: '0' }]
      : tx.ins.map((input, n) => {
          const out = chain.output(prevTxid(input), input.index)!;
          const { addresses, isAddress } = addressesOf(out.script);
          return { txid: prevTxid(input), ...omitZero('vout', input.index), n, ...(addresses.length > 0 ? { addresses } : {}), isAddress, value: out.value.toString() };
        });
    const vout = tx.outs.map((out, n) => ({ value: out.value.toString(), n, ...spentFields(txid, n), ...addressesOf(out.script) }));
    return {
      txid, vin, vout, blockHash: block.hash, blockHeight: block.height, confirmations: confirmations(block), blockTime: block.time,
      vsize: tx.virtualSize(), value: valueOut(tx).toString(), valueIn: valueIn(tx).toString(), fees: fees(tx).toString(),
    };
  };

  // GetAddrDescFromAddress: btcutil.DecodeAddress, then PayToAddrScript.
  const scriptOfAddress = (address: string): Uint8Array => {
    try {
      return toOutputScript(address, network);
    } catch (err) {
      throw new ApiError(`Invalid address, ${(err as Error).message}`);
    }
  };

  const touches = (tx: Transaction, hex: string): boolean =>
    tx.outs.some((out) => toHex(out.script) === hex) ||
    (!tx.isCoinbase() && tx.ins.some((input) => toHex(chain.output(prevTxid(input), input.index)?.script ?? new Uint8Array(0)) === hex));

  // Confirmed transactions of a script, newest block first, in block order within a block (db.GetAddrDescTransactions).
  const confirmedOf = (hex: string, from: number, to: number): { tx: Transaction; block: SimulatedBlock }[] => {
    const byHeight: { tx: Transaction; block: SimulatedBlock }[][] = [];
    for (const block of chain.blocks) {
      if (block.height < from || block.height > to) continue;
      byHeight.push(block.txs.filter((tx) => touches(tx, hex)).map((tx) => ({ tx, block })));
    }
    return byHeight.reverse().flat();
  };

  const sums = (tx: Transaction, hex: string): { received: bigint; sent: bigint } => {
    const received = tx.outs.reduce((sum, out) => (toHex(out.script) === hex ? sum + out.value : sum), 0n);
    let sent = 0n;
    if (!tx.isCoinbase()) {
      for (const input of tx.ins) {
        const out = chain.output(prevTxid(input), input.index);
        if (out !== null && toHex(out.script) === hex) sent += out.value;
      }
    }
    return { received, sent };
  };

  // Worker.GetAddress for a Bitcoin-type chain.
  const address = (addressParam: string, query: URLSearchParams): Record<string, unknown> => {
    const script = scriptOfAddress(addressParam);
    const hex = toHex(script);
    const details = query.get('details') ?? 'txids';
    const option = { basic: 0, txids: 1, txslight: 2, txs: 3 }[details] ?? 1;
    const max = option === 3 ? TXS_DETAILS_IN_API : TXS_IN_API;
    const paged = accountPaging(int(query.get('page'), 0, 0, MAX_PAGE_NUMBER), int(query.get('pageSize'), max, 0, max), max);
    let page = paged[0];
    const pageSize = paged[1];
    const from = int(query.get('from'), 0, 0, 10_000_000_000);
    const to = int(query.get('to'), 0, 0, 10_000_000_000);
    page = Math.max(page - 1, 0);
    const all = confirmedOf(hex, 0, Infinity);
    let balance = 0n;
    let totalReceived = 0n;
    let totalSent = 0n;
    for (const { tx } of all) {
      const { received, sent } = sums(tx, hex);
      totalReceived += received;
      totalSent += sent;
    }
    for (const { tx } of all) {
      tx.outs.forEach((out, vout) => {
        const spender = chain.spender(tx.getId(), vout);
        if (toHex(out.script) === hex && (spender === null || !spender.confirmed)) balance += out.value;
      });
    }
    const known = all.length > 0;
    const totalResults = known ? (from === 0 && to === 0 ? all.length : -1) : 0;
    if (!known) page = 0;
    let unconfirmedTxs = 0;
    let receiving = 0n;
    let sending = 0n;
    const txids: string[] = [];
    const txs: Record<string, unknown>[] = [];
    if (to === 0) {
      const pooled = mempoolOrder().filter((tx) => touches(tx, hex));
      if (option === 0) unconfirmedTxs = pooled.length;
      else {
        for (const tx of pooled) {
          unconfirmedTxs += 1;
          const { received, sent } = sums(tx, hex);
          receiving += received;
          sending += sent;
          if (page === 0) {
            if (option === 1) txids.push(tx.getId());
            else txs.push(fullTx(tx, null));
          }
        }
      }
    }
    let paging: Record<string, number> = {};
    if (option >= 1) {
      const txc = confirmedOf(hex, from, to === 0 ? Infinity : to).slice(0, (page + 1) * pageSize);
      const computed = computePaging(txc.length, page, pageSize);
      paging = computed.paging;
      page = computed.page;
      if (txc.length >= pageSize) paging = totalResults < 0 ? { ...paging, totalPages: -1 } : computePaging(totalResults, page, pageSize).paging;
      for (const { tx, block } of txc.slice(computed.from, computed.to)) {
        if (option === 1) txids.push(tx.getId());
        else txs.push(option === 2 ? lightTx(tx, block) : fullTx(tx, block));
      }
    }
    if (page === 0 && pageSize > 0) {
      if (txids.length > pageSize) txids.length = pageSize;
      if (txs.length > pageSize) txs.length = pageSize;
    }
    const net = receiving - sending;
    return {
      ...paging, address: addressParam, balance: balance.toString(), totalReceived: totalReceived.toString(), totalSent: totalSent.toString(),
      ...(option > 0 ? { unconfirmedBalance: net.toString() } : {}), unconfirmedTxs,
      ...(sending === 0n ? {} : { unconfirmedSending: sending.toString() }), ...(receiving === 0n ? {} : { unconfirmedReceiving: receiving.toString() }),
      txs: all.length, ...(txs.length > 0 ? { transactions: txs } : {}), ...(txids.length > 0 ? { txids } : {}),
    };
  };

  // Worker.getAddrDescUtxo.
  const utxos = (addressParam: string, query: URLSearchParams): Record<string, unknown>[] => {
    const hex = toHex(scriptOfAddress(addressParam));
    const onlyConfirmed = query.get('confirmed') === 'true';
    const result: Record<string, unknown>[] = [];
    const spentInMempool = new Set<string>();
    if (!onlyConfirmed) {
      const pooled = mempoolOrder().filter((tx) => touches(tx, hex));
      for (const tx of pooled) for (const input of tx.ins) spentInMempool.add(`${prevTxid(input)}:${input.index}`);
      for (const tx of pooled) {
        tx.outs.forEach((out, vout) => {
          if (toHex(out.script) !== hex || spentInMempool.has(`${tx.getId()}:${vout}`)) return;
          result.push({ txid: tx.getId(), vout, value: out.value.toString(), confirmations: 0, ...omitZero('lockTime', tx.locktime), ...(tx.isCoinbase() ? { coinbase: true } : {}) });
        });
      }
    }
    // ba.Utxos runs oldest first and is read backwards.
    const held: Record<string, unknown>[] = [];
    for (const { tx, block } of confirmedOf(hex, 0, Infinity).reverse()) {
      tx.outs.forEach((out, vout) => {
        const spender = chain.spender(tx.getId(), vout);
        if (toHex(out.script) !== hex || (spender !== null && spender.confirmed)) return;
        if (spentInMempool.has(`${tx.getId()}:${vout}`)) return;
        held.push({ txid: tx.getId(), vout, value: out.value.toString(), height: block.height, confirmations: confirmations(block) });
      });
    }
    return [...result, ...held.reverse()];
  };

  // Worker.GetBalanceHistory over confirmed transactions, grouped by `groupBy` seconds.
  const balanceHistory = (addressParam: string, query: URLSearchParams): Record<string, unknown>[] => {
    const hex = toHex(scriptOfAddress(addressParam));
    const groupBy = Number(query.get('groupBy')) > 0 ? Number(query.get('groupBy')) : 3600;
    const fromTime = Number(query.get('from') ?? 0);
    const toTime = Number(query.get('to') ?? 0) || Infinity;
    const points = confirmedOf(hex, 0, Infinity)
      .filter(({ block }) => block.time >= fromTime && block.time < toTime)
      .map(({ tx, block }) => {
        const { received, sent } = sums(tx, hex);
        const sentToSelf = sent > 0n ? received : 0n;
        return { time: block.time, txid: tx.getId(), received, sent, sentToSelf };
      })
      .sort((a, b) => a.time - b.time || a.txid.localeCompare(b.txid));
    const out: { time: number; txs: number; received: bigint; sent: bigint; sentToSelf: bigint }[] = [];
    for (const point of points) {
      const time = point.time - (point.time % groupBy);
      let last = out.at(-1);
      if (last === undefined || last.time !== time) out.push((last = { time, txs: 0, received: 0n, sent: 0n, sentToSelf: 0n }));
      last.txs += 1;
      last.received += point.received;
      last.sent += point.sent;
      last.sentToSelf += point.sentToSelf;
    }
    return out.map((item) => ({ time: item.time, txs: item.txs, received: item.received.toString(), sent: item.sent.toString(), sentToSelf: item.sentToSelf.toString() }));
  };

  const blockOf = (id: string): SimulatedBlock => {
    const height = /^\d+$/.test(id) ? Number(id) : NaN;
    const block = Number.isSafeInteger(height) ? chain.blocks[height] : chain.block(id);
    if (block === undefined || block === null || !chain.isActive(block)) throw new ApiError('Block not found');
    return block;
  };
  // The block handler wraps the worker's error in another of the same text.
  const blockReply = (id: string): SimulatedBlock => {
    try {
      return blockOf(id);
    } catch (err) {
      throw err instanceof ApiError ? new ApiError(`${err.message}, ${err.message}`) : err;
    }
  };

  const status = (): Record<string, unknown> => {
    const tip = chain.tip;
    const time = new Date(tip.time * 1000).toISOString();
    return {
      blockbook: {
        coin: 'Pearl', network: 'PRL', host: 'simulated', version: 'simulated', gitCommit: 'simulated', buildTime: time,
        syncMode: true, initialSync: false, inSync: true, bestHeight: chain.height, lastBlockTime: time,
        inSyncMempool: true, lastMempoolTime: time, mempoolSize: chain.mempool.size, decimals: 8, dbSize: 0, about: 'simulated',
      },
      backend: {
        chain: network.name, blocks: chain.height, headers: chain.height, bestBlockHash: tip.hash,
        difficulty: difficultyForBits(tip.block.header.bits, network).toFixed(8),
        // getnetworkinfo's, as strings; the simulated pearld reports version 0.
        version: '0', subversion: '/simulated/', protocolVersion: '0',
      },
    };
  };

  const estimateFee = (): string => {
    if (chain.feeRate === null) throw new ApiError('Internal server error', 500);
    return decimalString(chain.feeRate);
  };

  const route = (method: string, path: string, query: URLSearchParams, body: string): unknown => {
    const tail = (prefix: string): string | null => (path.startsWith(prefix) ? decodeURIComponent(path.slice(prefix.length)) : null);
    let arg: string | null;
    if (path === 'api/' || path === 'api/v2/') return status();
    if ((arg = tail('api/v2/block-index/')) !== null) {
      const height = /^\d+$/.test(arg) ? Number(arg) : -1;
      return { blockHash: height < 0 ? chain.tip.hash : (chain.blocks[height]?.hash ?? '') };
    }
    if ((arg = tail('api/v2/tx-specific/')) !== null) {
      const reply = JSON.parse(simulatedReply(chain, 'getrawtransaction', [arg, 1], 1)) as { result: unknown; error: unknown };
      if (reply.error !== null) throw new ApiError('Internal server error', 500);
      return reply.result;
    }
    if ((arg = tail('api/v2/tx/')) !== null) {
      const found = chain.transaction(arg);
      if (found === null) throw new ApiError(`Transaction '${arg}' not found`);
      return fullTx(found.tx, found.block);
    }
    if ((arg = tail('api/v2/address/')) !== null) return address(arg, query);
    if ((arg = tail('api/v2/utxo/')) !== null) return utxos(arg, query);
    if ((arg = tail('api/v2/balancehistory/')) !== null) return balanceHistory(arg, query);
    if ((arg = tail('api/v2/rawblock/')) !== null) return { hex: toHex(serializeBlock(blockOf(arg).block)) };
    if ((arg = tail('api/v2/block/')) !== null) {
      const block = blockReply(arg);
      const { paging, from, to } = computePaging(block.txs.length, Math.max(int(query.get('page'), 0, 0, MAX_PAGE_NUMBER) - 1, 0), TXS_IN_API);
      const header = block.block.header;
      return {
        ...paging, hash: block.hash, ...(block.height > 0 ? { previousBlockHash: block.parent } : {}),
        ...(block.height < chain.height ? { nextBlockHash: chain.blocks[block.height + 1]!.hash } : {}),
        height: block.height, confirmations: confirmations(block), size: serializeBlock(block.block).length, time: block.time,
        version: header.version, merkleRoot: toHex(Uint8Array.from(header.merkleRoot).reverse()), nonce: '',
        bits: header.bits.toString(16).padStart(8, '0'), difficulty: difficultyForBits(header.bits, network).toFixed(8),
        txCount: block.txs.length, txs: block.txs.slice(from, to).map((tx) => lightTx(tx, block)),
      };
    }
    if ((arg = tail('api/v2/sendtx/')) !== null) {
      const hex = method === 'POST' ? body : arg;
      if (hex === '') throw new ApiError('Missing tx blob');
      const reply = JSON.parse(simulatedReply(chain, 'sendrawtransaction', [hex], 1)) as { result: string | null; error: { code: number; message: string } | null };
      // SendRawTransaction's error is btcjson.RPCError, whose text is "code: message".
      if (reply.error !== null) throw new ApiError(`${reply.error.code}: ${reply.error.message}`);
      return { result: reply.result };
    }
    if ((arg = tail('api/v2/estimatefee/')) !== null || (arg = tail('api/v1/estimatefee/')) !== null) {
      if (!/^-?\d+$/.test(arg)) throw new ApiError("Parameter 'number of blocks' is not a number");
      return { result: estimateFee() };
    }
    if (path === 'api/v2/mempool/') {
      const entries = [...chain.mempool.values()];
      const size = int(query.get('pageSize'), TXS_IN_API, 1, 10_000);
      const { paging, from, to } = computePaging(entries.length, Math.max(int(query.get('page'), 0, 0, MAX_PAGE_NUMBER) - 1, 0), size);
      return { ...paging, mempool: entries.slice(from, to).map((entry) => ({ time: entry.time, txid: entry.tx.getId() })), mempoolSize: entries.length };
    }
    return undefined;
  };

  const fetcher = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const path = url.pathname.replace(/^\//, '');
    requests.push(path + url.search);
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? init.body : '';
    chain.enter(`blockbook ${path.replace(/^api\/(?:v\d\/)?([a-z-]*).*$/, '$1') || 'status'}`);
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    try {
      const value = route(method, path, url.searchParams, body);
      if (value === undefined) return new Response('404 page not found\n', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      return json(value);
    } catch (err) {
      if (err instanceof ApiError) return json({ error: err.message }, err.status);
      throw err;
    }
  };

  return { url: 'http://127.0.0.1:9131/', fetch: fetcher as typeof fetch, WebSocket: socketClass(chain, { fullTx, touches, utxos, address, estimateFee, route }), requests };
}

interface Server {
  fullTx(tx: Transaction, block: SimulatedBlock | null): Record<string, unknown>;
  touches(tx: Transaction, hex: string): boolean;
  utxos(address: string, query: URLSearchParams): Record<string, unknown>[];
  address(address: string, query: URLSearchParams): Record<string, unknown>;
  estimateFee(): string;
  route(method: string, path: string, query: URLSearchParams, body: string): unknown;
}

// server/websocket.go: requests by method name, replies and notifications as {id, data}.
function socketClass(chain: SimulatedChain, server: Server): SimulatedBlockbookWebSocket {
  const open = new Set<Socket>();

  class Socket implements SimulatedBlockbookSocket {
    static get connections(): number {
      return open.size;
    }

    static dropAll(code = 1006): void {
      for (const socket of [...open]) socket.shut(code);
    }

    readyState = 0;
    onopen: ((event: unknown) => void) | null = null;
    onclose: ((event: { code?: number }) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    #blocks: string | null = null;
    #addresses: { id: string; scripts: Map<string, string>; newBlockTxs: boolean } | null = null;
    #stop: (() => void) | null = null;

    constructor() {
      queueMicrotask(() => {
        if (this.readyState !== 0) return;
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

    #out(id: string, data: unknown): void {
      if (this.readyState === 1) queueMicrotask(() => this.readyState === 1 && this.onmessage?.({ data: JSON.stringify({ id, data }) }));
    }

    #receive(text: string): void {
      let req: { id?: unknown; method?: unknown; params?: Record<string, unknown> };
      try {
        req = JSON.parse(text) as typeof req;
      } catch {
        return;
      }
      const id = String(req.id ?? '');
      const params = req.params ?? {};
      try {
        chain.enter(`blockbook ws ${String(req.method)}`);
        const data = this.#handle(id, String(req.method), params);
        // An unknown method gets no reply.
        if (data !== undefined) this.#out(id, data);
      } catch (err) {
        this.#out(id, { error: { message: err instanceof Error ? err.message : String(err) } });
      }
    }

    #handle(id: string, method: string, params: Record<string, unknown>): unknown {
      const rest = (path: string, query: Record<string, unknown> = {}): unknown => {
        const search = new URLSearchParams();
        for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== null) search.set(key, String(value));
        return server.route('GET', path, search, '');
      };
      switch (method) {
        case 'getInfo': {
          const { blockbook, backend } = rest('api/') as { blockbook: Record<string, unknown>; backend: Record<string, unknown> };
          return {
            name: 'Pearl', shortcut: 'PRL', network: 'PRL', decimals: 8, version: blockbook.version, bestHeight: chain.height, bestHash: chain.tip.hash,
            block0Hash: chain.blocks[0]!.hash, testnet: chain.network.name !== 'mainnet' && chain.network.name !== 'simnet',
            backend: { version: backend.version, subversion: backend.subversion },
          };
        }
        case 'getBlockHash':
          // An unknown height is an empty hash, not an error.
          return { hash: chain.blocks[Number(params.height)]?.hash ?? '' };
        case 'getAccountInfo': {
          const { descriptor, details, page, pageSize, from, to } = params;
          // The websocket defaults to details "basic" and 25 to a page (txsOnPage).
          return server.address(String(descriptor), new URLSearchParams(Object.entries({ details: details ?? 'basic', page, pageSize: pageSize ?? 25, from, to }).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])));
        }
        case 'getAccountUtxo':
          return server.utxos(String(params.descriptor), new URLSearchParams());
        case 'getTransaction':
          return rest(`api/v2/tx/${String(params.txid)}`);
        case 'estimateFee': {
          const blocks = Array.isArray(params.blocks) ? params.blocks : [];
          if (blocks.length > 32) throw new Error('blocks max 32');
          // Blockbook asks for estimatesmartfee here, which pearld does not have.
          throw new Error('EstimateSmartFee: not supported');
        }
        case 'sendTransaction': {
          const reply = JSON.parse(simulatedReply(chain, 'sendrawtransaction', [String(params.hex ?? '')], 1)) as { result: string | null; error: { code: number; message: string } | null };
          if (reply.error !== null) throw new Error(`${reply.error.code}: ${reply.error.message}`);
          return { result: reply.result };
        }
        case 'subscribeNewBlock':
          this.#blocks = id;
          return { subscribed: true };
        case 'unsubscribeNewBlock':
          this.#blocks = null;
          return { subscribed: false };
        case 'subscribeAddresses': {
          const addresses = Array.isArray(params.addresses) ? params.addresses.map(String) : [];
          const newBlockTxs = params.newBlockTxs === true;
          if (addresses.length > (newBlockTxs ? 100 : 1000)) throw new Error(`addresses max ${newBlockTxs ? 100 : 1000}`);
          const scripts = new Map<string, string>();
          for (const address of addresses) scripts.set(toHex(toOutputScript(address, chain.network)), address);
          this.#addresses = { id, scripts, newBlockTxs };
          return { subscribed: true };
        }
        case 'unsubscribeAddresses':
          this.#addresses = null;
          return { subscribed: false };
        case 'ping':
          return {};
        default:
          return undefined;
      }
    }

    #notify(event: SimulatedEvent): void {
      if (event.type === 'connected') {
        if (this.#blocks !== null) this.#out(this.#blocks, { height: event.block.height, hash: event.block.hash, evmData: null });
        const subs = this.#addresses;
        if (subs?.newBlockTxs === true) for (const tx of event.block.txs) this.#tellAddresses(tx, event.block);
      } else if (event.type === 'accepted') {
        this.#tellAddresses(event.entry.tx, null);
      }
    }

    #tellAddresses(tx: Transaction, block: SimulatedBlock | null): void {
      const subs = this.#addresses;
      if (subs === null) return;
      for (const [hex, address] of subs.scripts) {
        if (server.touches(tx, hex)) this.#out(subs.id, { address, tx: server.fullTx(tx, block) });
      }
    }
  }

  return Socket as unknown as SimulatedBlockbookWebSocket;
}

// validateIntParam: the default when missing or unreadable, clamped to the range.
function int(text: string | null, fallback: number, min: number, max: number): number {
  if (text === null || text === '') return fallback;
  const value = Number.parseInt(text, 10);
  if (!Number.isFinite(value) || String(value) !== text.trim()) return fallback;
  return Math.min(Math.max(value, min), max);
}

function accountPaging(page: number, pageSize: number, fallback: number): [number, number] {
  const size = pageSize === 0 ? fallback : pageSize;
  return [page > 0 && page > MAX_ACCOUNT_HISTORY_OFFSET / size ? Math.floor(MAX_ACCOUNT_HISTORY_OFFSET / size) : page, size];
}

// api.computePaging: a page past the end is the last page.
function computePaging(count: number, page: number, itemsOnPage: number): { paging: Record<string, number>; from: number; to: number; page: number } {
  const totalPages = Math.max(Math.floor((count - 1) / itemsOnPage), 0);
  let from = page * itemsOnPage;
  if (from >= count) {
    page = totalPages;
    from = page * itemsOnPage;
  }
  const to = Math.min((page + 1) * itemsOnPage, count);
  return { paging: { page: page + 1, totalPages: totalPages + 1, itemsOnPage }, from, to, page };
}

// bchain.AmountToDecimalString with 8 decimals: no trailing zeros, no point for a whole number.
function decimalString(grain: bigint): string {
  const digits = grain.toString().padStart(9, '0');
  const whole = digits.slice(0, -8);
  const frac = digits.slice(-8).replace(/0+$/, '');
  return frac === '' ? whole : `${whole}.${frac}`;
}
