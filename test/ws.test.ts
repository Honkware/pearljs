// The websocket client against frames written by pearld's own notification
// manager and reply encoder (vectors/wsfixtures_test.go), through a fake
// WebSocket that plays the server side: authentication, id correlation,
// every notification type, reconnect and resubscription, close, bad frames.

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_RPC_TIMEOUT,
  OysterRpc,
  OysterWsClient,
  PearlError,
  PearlRpcError,
  PearlWsClient,
  pearldChainClient,
  prlAmount,
  parseTransaction,
  transactionId,
  type BlockEvent,
  type FilteredBlockEvent,
  type PearlNotifications,
  type PearlWsClientOptions,
  type PearlWsEvents,
  type TxAccepted,
} from '../src/index.js';
import fixtureFile from './fixtures/ws-frames.json' with { type: 'json' };
import { fixture as rpcFixture } from './rpc-helpers.js';
import { bytesToHex } from './vector-helpers.js';

interface Fixture {
  frame: string;
  expect?: Record<string, unknown>;
}
const fixtures = fixtureFile as Record<string, Fixture>;
const frame = (name: string): string => {
  const found = fixtures[name];
  if (found === undefined) throw new Error(`missing fixture ${name}`);
  return found.frame;
};
const expected = (name: string) => fixtures[name]!.expect!;
const replyFrame = (name: string, id: number) => frame(name).replace(/"id":(\d+|null)}$/, `"id":${id}}`);

interface Sent {
  id: number;
  method: string;
  params: unknown[];
}

class FakeSocket {
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: Sent[] = [];
  raw: string[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: { code?: number }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;

  constructor(
    readonly url: string,
    readonly init?: Record<string, unknown>,
  ) {
    FakeSocket.all.push(this);
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error('not open');
    this.raw.push(data);
    this.sent.push(JSON.parse(data) as Sent);
  }

  close(code = 1000): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    queueMicrotask(() => this.onclose?.({ code }));
  }

  // Server side.
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  push(text: string): void {
    this.onmessage?.({ data: text });
  }

  reply(method: string, result = 'null'): void {
    const request = this.sent.find((s) => s.method === method);
    if (request === undefined) throw new Error(`no ${method} sent`);
    this.push(`{"jsonrpc":"1.0","result":${result},"error":null,"id":${request.id}}`);
  }

  // Node 22's WebSocket after a refused upgrade: an error, no close.
  refuse(): void {
    this.onerror?.({});
  }

  drop(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }

  methods(): string[] {
    return this.sent.map((s) => s.method);
  }
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const last = () => FakeSocket.all.at(-1)!;

function client(options: Partial<PearlWsClientOptions> = {}): PearlWsClient {
  return new PearlWsClient({
    url: 'wss://127.0.0.1:18334',
    username: 'user',
    password: 'pass',
    WebSocket: FakeSocket,
    ...options,
  });
}

// Opens the newest socket, answers authenticate and every resubscription.
async function serve(socket = last()): Promise<FakeSocket> {
  socket.open();
  await flush();
  if (socket.sent[0]?.method === 'authenticate') socket.reply('authenticate');
  await flush();
  for (const s of socket.sent.slice(1)) socket.push(`{"jsonrpc":"1.0","result":null,"error":null,"id":${s.id}}`);
  await flush();
  return socket;
}

function collect<K extends keyof PearlWsEvents>(ws: PearlWsClient, event: K): PearlWsEvents[K][] {
  const seen: PearlWsEvents[K][] = [];
  ws.on(event, (value) => seen.push(value));
  return seen;
}

afterEach(() => {
  FakeSocket.all = [];
  vi.useRealTimers();
});

describe('pearld websocket client', () => {
  it('logs in with authenticate before sending anything else', async () => {
    const ws = client();
    const count = ws.call<number>('getblockcount');
    await flush();
    const socket = last();
    expect(socket.url).toBe('wss://127.0.0.1:18334/ws');
    expect(socket.init).toBeUndefined();
    socket.open();
    await flush();
    expect(socket.sent).toEqual([{ jsonrpc: '1.0', id: 1, method: 'authenticate', params: ['user', 'pass'] }]);
    socket.push(replyFrame('reply-authenticate', 1));
    await flush();
    expect(socket.methods()).toEqual(['authenticate', 'getblockcount']);
    socket.push(`{"jsonrpc":"1.0","result":321,"error":null,"id":${socket.sent[1]!.id}}`);
    expect(await count).toBe(321);
    await ws.close();
  });

  it('sends Basic auth on the upgrade instead when asked, keeping other init fields', async () => {
    const dispatcher = {};
    const ws = new PearlWsClient({
      url: 'https://alice:s%40cret@node.example:44107',
      WebSocket: FakeSocket,
      auth: 'header',
      webSocketInit: { dispatcher },
    });
    const ready = ws.connect();
    const socket = last();
    expect(socket.url).toBe('wss://node.example:44107/ws');
    expect(socket.init).toEqual({ dispatcher, headers: { Authorization: `Basic ${btoa('alice:s@cret')}` } });
    socket.open();
    await ready;
    expect(socket.sent).toEqual([]);
    await ws.close();
  });

  it('matches replies to calls by id when pearld answers out of order', async () => {
    const ws = client();
    await Promise.all([ws.connect(), serve()]);
    const socket = last();
    const a = ws.call('getbestblockhash');
    const b = ws.call<string>('getblockhash', [7]);
    await flush();
    const [ida, idb] = socket.sent.slice(1).map((s) => s.id);
    socket.push(`{"jsonrpc":"1.0","result":"bb","error":null,"id":${idb}}`);
    socket.push(`{"jsonrpc":"1.0","result":"aa","error":null,"id":${ida}}`);
    expect(await Promise.all([a, b])).toEqual(['aa', 'bb']);
    await ws.close();
  });

  it('returns RPC errors as PearlRpcError with Pearl code', async () => {
    const ws = client();
    await Promise.all([ws.connect(), serve()]);
    const call = ws.call('stopnotifyblocks');
    await flush();
    last().push(replyFrame('reply-limited', last().sent.at(-1)!.id));
    const err = await call.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PearlRpcError);
    expect(err).toMatchObject({ kind: 'rpc', method: 'stopnotifyblocks', rpcCode: expected('reply-limited').code });
    expect((err as Error).message).toBe('stopnotifyblocks: limited user not authorized for this method (code -32602)');
    await ws.close();
  });

  it('keeps a subscription the limited user may not stop, without reporting an error', async () => {
    const ws = client();
    await Promise.all([ws.connect(), serve()]);
    const socket = last();
    const errors = collect(ws, 'error');
    const stop = ws.watchBlocks({ onBlock: () => {} });
    await flush();
    socket.reply('notifyblocks');
    stop();
    await flush();
    expect(socket.methods().at(-1)).toBe('stopnotifyblocks');
    socket.push(replyFrame('reply-limited', socket.sent.at(-1)!.id));
    await flush();
    expect(errors).toEqual([]);
    // pearld still sends blocks, so a new watcher needs no notifyblocks.
    const blocks: BlockEvent[] = [];
    ws.watchBlocks({ onBlock: (event) => blocks.push(event) });
    await flush();
    expect(socket.methods().filter((m) => m === 'notifyblocks')).toHaveLength(1);
    await ws.close();
  });

  it('converts amounts both ways and keeps the session id exact', async () => {
    const ws = client();
    await Promise.all([ws.connect(), serve()]);
    const socket = last();
    // A bare bigint is a count, here of blocks; only prlAmount is an amount.
    const balance = ws.call('estimatefee', [6n], { amounts: ['result'] });
    await flush();
    expect(socket.raw.at(-1)).toContain('"params":[6]');
    socket.push(`{"jsonrpc":"1.0","result":0.00012345,"error":null,"id":${socket.sent.at(-1)!.id}}`);
    expect(await balance).toBe(12345n);
    void ws.call('testmempoolaccept', [['00'], prlAmount(10000000n)]).catch(() => {});
    await flush();
    expect(socket.raw.at(-1)).toContain('"params":[["00"],0.1]');
    const session = ws.session();
    await flush();
    socket.push(replyFrame('reply-session', socket.sent.at(-1)!.id));
    expect(await session).toBe(BigInt(expected('reply-session').sessionId as string));
    await ws.close();
  });

  it('decodes every notification pearld sends', async () => {
    const ws = client();
    await Promise.all([ws.connect(), serve()]);
    const socket = last();
    const events = Object.fromEntries(
      (
        [
          'blockconnected',
          'blockdisconnected',
          'filteredblockconnected',
          'filteredblockdisconnected',
          'txaccepted',
          'txacceptedverbose',
          'relevanttxaccepted',
          'recvtx',
          'redeemingtx',
          'rescanprogress',
          'rescanfinished',
        ] as const
      ).map((name) => [name, collect(ws, name)]),
    ) as unknown as { [K in keyof PearlNotifications]: PearlNotifications[K][] };
    const errors = collect(ws, 'error');
    for (const name of Object.keys(fixtures).filter((n) => !n.startsWith('reply-'))) socket.push(frame(name));
    expect(errors).toEqual([]);

    const block = expected('blockconnected');
    expect(events.blockconnected).toEqual([{ type: 'connected', ...block }]);
    expect(events.blockdisconnected).toEqual([{ type: 'disconnected', ...block }]);
    expect(events.rescanprogress).toEqual([block]);
    expect(events.rescanfinished).toEqual([block]);

    const header = (event: FilteredBlockEvent) => ({
      version: event.header.version,
      prevBlock: bytesToHex(event.header.prevBlock),
      merkleRoot: bytesToHex(event.header.merkleRoot),
      timestamp: event.header.timestamp,
      bits: event.header.bits,
      proofCommitment: bytesToHex(event.header.proofCommitment),
    });
    const [connected, empty] = events.filteredblockconnected;
    const fexp = expected('filteredblockconnected');
    expect(connected).toMatchObject({ type: 'connected', height: fexp.height, hash: fexp.hash });
    expect(header(connected!)).toEqual(fexp.header);
    expect(connected!.transactions.map((tx) => transactionId(parseTransaction(tx)))).toEqual(fexp.txids);
    expect(empty!.transactions).toEqual([]);
    const disconnected = events.filteredblockdisconnected[0]!;
    expect(disconnected).toMatchObject({ type: 'disconnected', hash: expected('filteredblockdisconnected').hash, transactions: [] });
    expect(header(disconnected)).toEqual(expected('filteredblockdisconnected').header);

    // Two txaccepted frames, then one derived from txacceptedverbose.
    expect(events.txaccepted).toEqual([
      { txid: expected('txaccepted').txid, amount: BigInt(expected('txaccepted').amount as string) },
      { txid: expected('txaccepted-large').txid, amount: BigInt(expected('txaccepted-large').amount as string) },
      { txid: expected('txacceptedverbose').txid, amount: BigInt(expected('txacceptedverbose').amount as string) },
    ]);
    const verbose = events.txacceptedverbose[0]!;
    expect(verbose.txid).toBe(expected('txacceptedverbose').txid);
    expect(verbose.vout.map((out) => out.value.toString())).toEqual(expected('txacceptedverbose').values);

    const txid = (hex: string) => transactionId(parseTransaction(hex));
    expect(events.relevanttxaccepted.map((e) => txid(e.transaction))).toEqual([expected('relevanttxaccepted').txid]);
    const [mined, mempool] = events.recvtx;
    expect(txid(mined!.transaction)).toBe(expected('recvtx').txid);
    expect(mined!.block).toEqual(expected('recvtx').block);
    expect(mempool!.block).toBeNull();
    expect(events.redeemingtx.map((e) => [txid(e.transaction), e.block])).toEqual([[expected('redeemingtx').txid, null]]);
    await ws.close();
  });

  it('returns rescanblocks results and refuses notifications on Oyster', async () => {
    const ws = client();
    await Promise.all([ws.connect(), serve()]);
    const rescan = ws.rescanBlocks([expected('reply-rescanblocks').hash as string]);
    await flush();
    expect(last().sent.at(-1)).toMatchObject({ method: 'rescanblocks', params: [[expected('reply-rescanblocks').hash]] });
    last().push(replyFrame('reply-rescanblocks', last().sent.at(-1)!.id));
    const [found] = await rescan;
    expect(found!.hash).toBe(expected('reply-rescanblocks').hash);
    expect(transactionId(parseTransaction(found!.transactions[0]!))).toBe(expected('reply-rescanblocks').txid);
    await ws.close();

    const oyster = client({ notifications: false, auth: 'header' });
    expect(() => oyster.watchBlocks({ onBlock: () => {} })).toThrow(/Oyster/);
    await expect(oyster.notifyReceived(['rprl1x'])).rejects.toThrow(/Oyster/);
    expect(FakeSocket.all).toHaveLength(1);
  });

  it('subscribes once for many block watchers and stops after the last', async () => {
    const ws = client();
    const first: BlockEvent[] = [];
    const filtered: FilteredBlockEvent[] = [];
    const stopA = ws.watchBlocks({ onBlock: (e) => first.push(e) });
    const stopB = ws.watchFilteredBlocks({ onBlock: (e) => filtered.push(e) });
    const socket = await serve();
    expect(socket.methods()).toEqual(['authenticate', 'notifyblocks']);
    socket.push(frame('blockconnected'));
    socket.push(frame('filteredblockconnected'));
    expect([first.length, filtered.length]).toEqual([1, 1]);
    stopA();
    await flush();
    expect(socket.methods()).not.toContain('stopnotifyblocks');
    stopB();
    stopB();
    await flush();
    expect(socket.methods()).toEqual(['authenticate', 'notifyblocks', 'stopnotifyblocks']);
    socket.push(frame('blockconnected'));
    expect(first).toHaveLength(1);
    await ws.close();
  });

  it('switches pearld between plain and verbose transactions as watchers come and go', async () => {
    const ws = client();
    await Promise.all([ws.connect(), serve()]);
    const socket = last();
    const plain: TxAccepted[] = [];
    const stopPlain = ws.watchTransactions({ onTransaction: (tx) => plain.push(tx) });
    await flush();
    const stopVerbose = ws.watchTransactions({ verbose: true, onTransaction: () => {} });
    await flush();
    socket.push(frame('txacceptedverbose'));
    expect(plain.map((tx) => tx.txid)).toEqual([expected('txacceptedverbose').txid]);
    stopVerbose();
    await flush();
    stopPlain();
    await flush();
    expect(socket.sent.slice(1).map((s) => [s.method, ...s.params])).toEqual([
      ['notifynewtransactions', false],
      ['notifynewtransactions', true],
      ['notifynewtransactions', false],
      ['stopnotifynewtransactions'],
    ]);
    await ws.close();
  });

  it('reconnects with backoff and replays every subscription', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const ws = client({ reconnect: { initialDelay: 100, maxDelay: 250 } });
    const connects = collect(ws, 'connect');
    const disconnects = collect(ws, 'disconnect');
    ws.watchBlocks({ onBlock: () => {} });
    ws.watchTransactions({ verbose: true, onTransaction: () => {} });
    await serve();
    const addr = 'rprl1pzyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygsnspr4u';
    const op = { txid: 'ab'.repeat(32), vout: 1 };
    const loads = [ws.loadTxFilter({ addresses: [addr], outpoints: [op] }), ws.notifyReceived([addr]), ws.notifySpent([op])];
    await flush();
    for (const s of last().sent.slice(3)) last().push(`{"jsonrpc":"1.0","result":null,"error":null,"id":${s.id}}`);
    await Promise.all(loads);

    const inFlight = ws.call('getblockcount');
    const queued = expect(inFlight).rejects.toMatchObject({ kind: 'network', method: 'getblockcount' });
    await flush();
    last().drop();
    await queued;
    expect(disconnects).toHaveLength(1);
    const waiting = ws.call<number>('getblockcount');

    // Three failed attempts: 100, 200, then capped at 250 ms.
    for (const delay of [100, 200, 250]) {
      const before = FakeSocket.all.length;
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(FakeSocket.all).toHaveLength(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(FakeSocket.all).toHaveLength(before + 1);
      last().drop();
    }
    await vi.advanceTimersByTimeAsync(250);
    const socket = await serve();
    expect(socket.sent[0]!.method).toBe('authenticate');
    expect(socket.sent.slice(1, 6).map((s) => [s.method, ...s.params])).toEqual([
      ['notifyblocks'],
      ['notifynewtransactions', true],
      ['loadtxfilter', true, [addr], [{ hash: op.txid, index: 1 }]],
      ['notifyreceived', [addr]],
      ['notifyspent', [{ hash: op.txid, index: 1 }]],
    ]);
    expect(connects).toEqual([{ reconnect: false }, { reconnect: true }]);
    expect(disconnects).toHaveLength(1);
    socket.push(`{"jsonrpc":"1.0","result":322,"error":null,"id":${socket.sent.at(-1)!.id}}`);
    expect(await waiting).toBe(322);
    await ws.close();
  });

  it('gives up after the allowed attempts and fails waiting calls', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const ws = client({ reconnect: { initialDelay: 10, retries: 2 } });
    const closes = collect(ws, 'close');
    await Promise.all([ws.connect(), serve()]);
    last().drop();
    const waiting = ws.call('getblockcount');
    const failed = expect(waiting).rejects.toMatchObject({ kind: 'network', method: 'getblockcount' });
    await vi.advanceTimersByTimeAsync(10);
    last().drop();
    await vi.advanceTimersByTimeAsync(20);
    last().drop();
    await failed;
    expect(((await waiting.catch((e: unknown) => e)) as Error).message).toMatch(/gave up after 2 reconnect attempts/);
    expect(closes).toHaveLength(1);
    expect(closes[0]!.error).toBeInstanceOf(PearlRpcError);
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeSocket.all).toHaveLength(3);
    await expect(ws.call('getblockcount')).rejects.toMatchObject({ kind: 'network' });
    await ws.close();
  });

  it('reports refused credentials as HTTP 401 and does not retry', async () => {
    const ws = client({ password: 'wrong' });
    const call = ws.call('getblockcount');
    await flush();
    last().open();
    await flush();
    last().drop(1006);
    const err = await call.catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'http', status: 401, method: 'getblockcount' });
    expect((err as Error).message).toMatch(/username or password was refused/);
    await flush();
    expect(FakeSocket.all).toHaveLength(1);
  });

  it('fails a first connection that never opens, then tries afresh on the next call', async () => {
    const ws = client({ auth: 'header' });
    const call = ws.call('getblockcount');
    await flush();
    last().drop(1006);
    await expect(call).rejects.toMatchObject({ kind: 'network', method: 'getblockcount' });
    const again = ws.call<number>('getblockcount');
    await flush();
    expect(FakeSocket.all).toHaveLength(2);
    last().open();
    await flush();
    last().push(`{"jsonrpc":"1.0","result":5,"error":null,"id":${last().sent[0]!.id}}`);
    expect(await again).toBe(5);
    await ws.close();
  });

  it('treats an error before open as a failed connection, even with no close event', async () => {
    const ws = client({ auth: 'header' });
    const call = ws.call('getblockcount');
    await flush();
    last().refuse();
    await expect(call).rejects.toMatchObject({ kind: 'network', message: expect.stringMatching(/cannot open a websocket/) });
    expect(last().readyState).toBe(3);
    const connecting = ws.call('getblockcount');
    await flush();
    await ws.close();
    await expect(connecting).rejects.toThrow(/closed/);
  });

  it('fails pending calls on close, ends iterators and stays closed', async () => {
    const ws = client();
    const iterator = ws.blocks();
    const next = iterator.next();
    await serve();
    const socket = last();
    const pending = ws.call('getblockcount');
    await flush();
    const closing = ws.close();
    await expect(pending).rejects.toMatchObject({ kind: 'network', method: 'getblockcount' });
    await closing;
    expect(socket.readyState).toBe(3);
    expect(await next).toEqual({ value: undefined, done: true });
    await expect(ws.call('getblockcount')).rejects.toThrow(/closed/);
    expect(() => ws.blocks()).not.toThrow();
    expect(FakeSocket.all).toHaveLength(1);
    await ws.close();
  });

  it('resolves close after three seconds when the socket never reports its close, as with Oyster', async () => {
    vi.useFakeTimers();
    try {
      const ws = client({ auth: 'header' });
      const ready = ws.connect();
      const socket = last();
      socket.open();
      await ready;
      // Oyster echoes the close frame and keeps the connection, so no close event follows.
      socket.close = () => {
        socket.readyState = 2;
      };
      let closed = false;
      const closing = ws.close().then(() => (closed = true));
      await vi.advanceTimersByTimeAsync(2999);
      expect(closed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await closing;
      expect(closed).toBe(true);
      await expect(ws.call('getblockcount')).rejects.toThrow(/closed/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not start a session that was closed while authenticating', async () => {
    const ws = client();
    const connects = collect(ws, 'connect');
    const errors = collect(ws, 'error');
    const ready = ws.connect();
    last().open();
    await flush();
    const closing = ws.close();
    last().reply('authenticate');
    await closing;
    await expect(ready).rejects.toThrow(/closed/);
    await flush();
    expect(connects).toEqual([]);
    expect(errors).toEqual([]);
    expect(last().methods()).toEqual(['authenticate']);
  });

  it('yields blocks from an async iterator and unsubscribes on break', async () => {
    const ws = client();
    const seen: BlockEvent[] = [];
    const loop = (async () => {
      for await (const block of ws.blocks()) {
        seen.push(block);
        if (seen.length === 2) break;
      }
    })();
    const socket = await serve();
    socket.push(frame('blockconnected'));
    socket.push(frame('blockdisconnected'));
    await loop;
    await flush();
    expect(seen.map((b) => b.type)).toEqual(['connected', 'disconnected']);
    expect(socket.methods()).toEqual(['authenticate', 'notifyblocks', 'stopnotifyblocks']);
    await ws.close();
  });

  it('reports malformed frames without disturbing pending calls', async () => {
    const ws = client();
    await Promise.all([ws.connect(), serve()]);
    const socket = last();
    const errors = collect(ws, 'error');
    const blocks: BlockEvent[] = [];
    ws.on('blockconnected', (e) => blocks.push(e));
    ws.on('blockconnected', () => {
      throw new Error('listener failed');
    });
    const call = ws.call<number>('getblockcount');
    await flush();
    socket.push('{not json');
    socket.push('[1,2]');
    socket.push('{"jsonrpc":"1.0","result":1,"error":null,"id":999}');
    socket.push(frame('reply-parse-error'));
    socket.push('{"jsonrpc":"1.0","method":"blockconnected","params":["x"],"id":null}');
    socket.push('{"jsonrpc":"1.0","method":"txaccepted","params":["zz",1],"id":null}');
    socket.push('{"jsonrpc":"1.0","method":"somethingnew","params":[],"id":null}');
    socket.onmessage?.({ data: new TextEncoder().encode(frame('blockconnected')) });
    socket.onmessage?.({ data: 42 });
    socket.push(`{"jsonrpc":"1.0","result":9,"error":null,"id":${socket.sent.at(-1)!.id}}`);
    expect(await call).toBe(9);
    expect(blocks).toHaveLength(1);
    expect(errors.map((e) => e.message)).toEqual([
      expect.stringMatching(/unreadable frame/),
      expect.stringMatching(/expected a JSON-RPC object/),
      expect.stringMatching(/unknown request id 999/),
      'websocket: Failed to parse request: unexpected end of JSON input (code -32700)',
      expect.stringMatching(/malformed blockconnected notification: height/),
      expect.stringMatching(/malformed txaccepted notification/),
      expect.stringMatching(/unknown notification somethingnew/),
      'listener failed',
      expect.stringMatching(/non-text frame/),
    ]);
    expect(errors.slice(0, 3).every((e) => e instanceof PearlRpcError && e.kind === 'response')).toBe(true);
    await ws.close();
  });

  it('times out a call and never sends one abandoned before the connection was ready', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const ws = client({ timeout: 50 });
    const call = ws.call('sendrawtransaction', ['00']);
    const failed = expect(call).rejects.toMatchObject({ kind: 'network', method: 'sendrawtransaction' });
    await vi.advanceTimersByTimeAsync(50);
    await failed;
    await serve();
    expect(last().methods()).toEqual(['authenticate']);
    const controller = new AbortController();
    const aborted = ws.call('getblockcount', [], { signal: controller.signal });
    controller.abort();
    await expect(aborted).rejects.toThrow(/aborted/);
    await ws.close();
  });

  it('forgets a call it gave up on, and drops its late reply quietly', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const ws = client({ timeout: 50 });
    const ready = ws.connect();
    await serve();
    await ready;
    const errors = collect(ws, 'error');
    const call = ws.call('getblockcount');
    const failed = expect(call).rejects.toMatchObject({ kind: 'network' });
    await flush();
    expect(ws.pending).toBe(1);
    await vi.advanceTimersByTimeAsync(50);
    await failed;
    expect(ws.pending).toBe(0);
    const controller = new AbortController();
    const aborted = ws.call('getbestblockhash', [], { signal: controller.signal });
    await flush();
    expect(ws.pending).toBe(1);
    controller.abort();
    await expect(aborted).rejects.toThrow(/aborted/);
    expect(ws.pending).toBe(0);
    for (const sent of last().sent.slice(1)) last().push(`{"jsonrpc":"1.0","result":1,"error":null,"id":${sent.id}}`);
    expect(errors).toEqual([]);
    await ws.close();
  });

  it('drops the connection on a frame past maxReplySize and fails the calls waiting on it', async () => {
    const ws = client({ maxReplySize: 100, reconnect: false });
    const ready = ws.connect();
    await serve();
    await ready;
    const errors = collect(ws, 'error');
    const call = ws.call('getblock', ['00'.repeat(32), 0]);
    await flush();
    last().push(`{"jsonrpc":"1.0","result":"${'00'.repeat(100)}","error":null,"id":${last().sent.at(-1)!.id}}`);
    await expect(call).rejects.toMatchObject({ kind: 'network' });
    expect(errors[0]?.message).toMatch(/maxReplySize/);
    expect(() => client({ maxReplySize: -1 })).toThrow(RangeError);
  });

  it('gives up on a silent server after the default timeout, except for calls that are slow by design', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const ws = client();
    const count = ws.call('getblockcount');
    const failed = expect(count).rejects.toThrow(`no reply from 127.0.0.1:18334 within ${DEFAULT_RPC_TIMEOUT} ms`);
    let rescanned = false;
    ws.call('rescan', ['00'.repeat(32)]).then(
      () => undefined,
      () => (rescanned = true),
    );
    // No limit at all when the client is told 0.
    const patient = client({ timeout: 0 });
    let patientFailed = false;
    patient.call('getblockcount').catch(() => (patientFailed = true));
    await vi.advanceTimersByTimeAsync(DEFAULT_RPC_TIMEOUT * 2);
    await failed;
    expect(rescanned).toBe(false);
    expect(patientFailed).toBe(false);
  });

  it('offers Oyster\'s typed methods on its own client, with header auth and no notification commands', async () => {
    const ws = new OysterWsClient({ url: 'wss://127.0.0.1:18332', username: 'user', password: 'pass', WebSocket: FakeSocket });
    const locked = ws.walletIsLocked();
    await flush();
    const socket = last();
    expect(socket.init).toEqual({ headers: { Authorization: `Basic ${btoa('user:pass')}` } });
    socket.open();
    await flush();
    expect(socket.methods()).toEqual(['walletislocked']);
    socket.reply('walletislocked', 'true');
    expect(await locked).toBe(true);
    expect(() => ws.watchBlocks({ onBlock: () => {} })).toThrow(PearlError);
    expect(() => ws.watchBlocks({ onBlock: () => {} })).toThrow("Oyster's websocket sends no notifications");
    await ws.close();
  });

  it('runs the typed pearld methods of the fetch client over the socket', async () => {
    const ws = client();
    await Promise.all([ws.connect(), serve()]);
    const socket = last();
    const answer = async (name: string) => {
      await flush();
      socket.push(rpcFixture(name).body.trim().replace(/"id":\d+}$/, `"id":${socket.sent.at(-1)!.id}}`));
    };
    const block = ws.getBlockWithTransactions('00'.repeat(32));
    await answer('getblock-transactions');
    expect((await block).rawtx[0]!.vout[0]!.value).toBe(0n);
    expect(socket.sent.at(-1)).toMatchObject({ method: 'getblock', params: ['00'.repeat(32), 2] });

    const rejected = ws.submitBlock('00').catch((e: unknown) => e);
    await answer('submitblock-rejected');
    expect(await rejected).toMatchObject({ kind: 'rpc', rpcCode: -25, method: 'submitblock' });

    const template = ws.getBlockTemplate();
    await answer('getblocktemplate');
    expect((await template).coinbasevalue).toBe(BigInt(rpcFixture('getblocktemplate').expect!.coinbaseValue as string));

    // The chain client for the invoice monitor takes the websocket client as it takes the fetch one.
    const tip = pearldChainClient(ws).getTip();
    await answer('backend-getbestblock');
    expect((await tip).height).toBe(321);

    const balance = new OysterRpc(ws).getBalance();
    await answer('getbalance');
    expect(await balance).toBe(BigInt(rpcFixture('getbalance').expect!.balance as string));
    await ws.close();
  });

  it('keeps the password out of a malformed URL error and off plain ws to another host', () => {
    let error: unknown;
    try {
      client({ url: 'wss://alice:hunter2@127.0.0.1:port' });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(TypeError);
    expect(JSON.stringify([String(error), Object.values(error as object)])).not.toContain('hunter2');
    expect(() => client({ url: 'ws://node.example:44107' })).toThrow('refusing to send the RPC password');
    expect(() => client({ url: 'http://node.example:44107' })).toThrow('refusing to send the RPC password');
    expect(() => client({ url: 'ws://node.example:44107', allowInsecureAuth: true })).not.toThrow();
    expect(() => client({ url: 'ws://127.0.0.1:18334' })).not.toThrow();
  });

  it('leaves no unhandled rejection when watchers outlive a failed connection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const ws = client();
      const stop = ws.watchBlocks({ onBlock: () => {} });
      ws.watchTransactions({ onTransaction: () => {} });
      await flush();
      last().drop();
      await flush();
      stop();
      await ws.close();
      await flush();
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
