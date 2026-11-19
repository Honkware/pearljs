// The Blockbook client, backend and simulated server against replies Pearl's
// own servers sent on 2026-11-19 (test/fixtures/blockbook/), so the suite
// keeps checking real shapes with no network.

import { describe, expect, it } from 'vitest';
import mainnet from './fixtures/blockbook/mainnet.json';
import testnet2 from './fixtures/blockbook/testnet2.json';
import fp8Blocks from './fixtures/testnet2-fp8-blocks.json';
import {
  BlockbookClient,
  BlockbookWsClient,
  blockbookBackend,
  blockHashHex,
  difficultyForBits,
  importWatchOnlyAccount,
  isBlockbookNotFound,
  networks,
  parseBlock,
  parseBlockbookJson,
  type PearlNetwork,
} from '../src/index.js';
import { SimulatedChain, simulatedBlockbook } from '../src/testing.js';
import { fromHex } from '../src/internal/bytes.js';

type Recorded = { rest: Record<string, { status: number; body: string }>; ws?: { request: { method: string; params: unknown }; reply: string }[] };

const P2MR_A = 'prl1zjrmn44f7n9cqekf9h4f2wl5hgp3apn0a2t7l09gcyc580gqsxm3ss67e3p';
const PAYOUT = 'prl1pl7ch5q7f225sumuutpw9u466auzellprh432z4vd9pfzvnfqmysq2f3xjw';
const BUSY = 'prl1pt8e88h9m5j26u04vw7dgv4zxp2y68fy5wx82g78465lfsvprsmss2962e4';
const RECIPIENT = 'prl1p6rfthfpcnuxjs8uycxthe6ayn5q5ftfv82fcqpy78s6jznz0y6dqm9sa35';
const COINBASE = 'bd62a0961cc23692ef247e380c2b1b5c548038b0f6be79cd3adb52501f469855';
const STRANGER = 'rprl1p8dhv8twyj9ezfvk62vvsfgw39s4dgl9t42y0549dc4d2947jj4cs30wfpz';
const XPUB = 'zpub6ruNaRWaDiUmXoxnKZ9KX6e6BjsJnK3jpfddbDrabB5zeBD9EA69KSHZMqk9n37kvAZCFrkgCLNZVhSDrtAbSQ6swxQW2cJaddBitWzWaHv';

// Answers a request with the recorded reply to the same path and query, in any order of parameters.
function replay(recorded: Recorded): typeof fetch {
  const key = (url: URL) => `${url.pathname.slice(1)}?${[...url.searchParams].map(([k, v]) => `${k}=${v}`).sort().join('&')}`;
  const byKey = new Map(Object.entries(recorded.rest).map(([path, reply]) => [key(new URL(path, 'https://x/')), reply]));
  return (async (input: string | URL | Request) => {
    const reply = byKey.get(key(new URL(typeof input === 'string' || input instanceof URL ? input : input.url)));
    if (reply === undefined) throw new Error(`nothing recorded for ${String(input)}`);
    return new Response(reply.body, { status: reply.status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
  }) as typeof fetch;
}

const body = (recorded: Recorded, path: string): unknown => JSON.parse(recorded.rest[path]!.body);
const wsReply = (method: string, nth = 0): unknown => (JSON.parse(mainnet.ws.filter((frame) => frame.request.method === method)[nth]!.reply) as { data: unknown }).data;
const keys = (value: unknown): string[] => Object.keys(value as object).sort();
const client = (recorded: Recorded, network: PearlNetwork) => new BlockbookClient({ url: 'https://blockbook.example', network, fetch: replay(recorded) });

describe('Pearl\'s mainnet Blockbook, as recorded', () => {
  const bb = client(mainnet, networks.mainnet);

  it('serves mainnet, and the client checks that from the status and block 0', async () => {
    await bb.checkNetwork();
    const status = await bb.getStatus();
    expect(status.backend).toMatchObject({ chain: 'mainnet', version: '1050700', subversion: '/pearlwire:0.5.0/pearld:1.5.7/', protocolVersion: '2' });
    expect(status.blockbook).toMatchObject({ version: 'devel', gitCommit: '81f52f2', decimals: 8 });
    await expect(client(mainnet, networks.testnet2).checkNetwork()).rejects.toMatchObject({ code: 'BACKEND_WRONG_NETWORK' });
    expect(await bb.getBlockHash(99_999_999)).toBeNull();
  });

  it('describes a block as its serialization does: size, bits and difficulty to eight places', async () => {
    const block = await bb.getBlock(145337);
    const raw = fromHex(await bb.getRawBlock(block.hash));
    const parsed = parseBlock(raw);
    expect(blockHashHex(parsed.header)).toBe(block.hash);
    expect(block.size).toBe(raw.length);
    expect(block.bits).toBe(parsed.header.bits.toString(16));
    expect(block.difficulty).toBe(difficultyForBits(parsed.header.bits, networks.mainnet).toFixed(8));
    expect(block).toMatchObject({ height: 145337, version: 536870912, nonce: '', txCount: 1 });
  });

  it('places a real coinbase in its block with every block check on', async () => {
    const backend = blockbookBackend(bb);
    expect(await backend.getTransaction(COINBASE)).toEqual({
      txid: COINBASE,
      block: { height: 145337, hash: '08765eeb8892d8d94bb3a1cefe38c042b33e49ae5048b9557b76bfc3dead97d3', time: 1795063556 },
    });
  });

  it('reads transactions, the mempool\'s with its confirmation estimate, and P2MR inputs and outputs as addresses', async () => {
    const coinbase = await bb.getTransaction(COINBASE);
    expect(coinbase.vin[0]).toMatchObject({ n: 0, isAddress: false, sequence: 382077296 });
    expect(coinbase.vin[0]!.txid).toBeUndefined();
    expect(coinbase.vout[1]).toMatchObject({ value: 0n, addresses: [], isAddress: false });
    const specific = await bb.getTransactionSpecific(COINBASE);
    expect(specific.vout.map((out) => out.value)).toEqual([215742157897n, 0n]);

    const p2mr = await bb.getTransaction('1fc2168472af90dfbcd9cd6392b914c40150ce5eedaefa5d0bd60a02fbaa2b53');
    expect(p2mr.vin[0]).toMatchObject({ addresses: [P2MR_A], isAddress: true, value: 1000000000n });
    expect(p2mr.vout[0]).toMatchObject({ isAddress: true, spent: true, spentHeight: 56331 });

    const spent = await bb.getTransaction('b38eb21fdae142c31d8eb90b59cad40f75e36c57815a38bce131154236efcdd8');
    expect(spent.vout[0]).toMatchObject({ spent: true, spentTxId: 'c1b17b76c65f5eb68d61742ab7581997c93b3d8188192d152c1807faba6d81d8', spentHeight: 145149 });
    expect(spent.vout[0]!.spentIndex).toBeUndefined();

    const { mempool } = await bb.getMempool({ pageSize: 3 });
    const pending = await bb.getTransaction(mempool[0]!.txid);
    expect(pending).toMatchObject({ blockHeight: -1, confirmations: 0, confirmationETABlocks: 1, confirmationETASeconds: 178 });
    expect(pending.blockHash).toBeUndefined();
  });

  it('puts an address\'s mempool in front of its first page, and repeats the last page past the end', async () => {
    const first = await bb.getAddress(BUSY, { details: 'txids', pageSize: 2 });
    // Six in the mempool, yet the pages count the confirmed ones alone.
    expect(first).toMatchObject({ page: 1, itemsOnPage: 2, unconfirmedTxs: 6, txs: 38868, totalPages: 19434 });
    expect(first.txids).toHaveLength(2);
    const status = (body(mainnet, 'api/') as { blockbook: { bestHeight: number } }).blockbook;
    const past = await bb.getAddress(PAYOUT, { details: 'txids', pageSize: 3, page: 9, from: status.bestHeight - 60, to: status.bestHeight });
    expect(past).toMatchObject({ page: 2, totalPages: -1, itemsOnPage: 3 });
    expect(past.txids).toHaveLength(3);
    const basic = await bb.getAddress(PAYOUT, { details: 'basic' });
    expect(basic.unconfirmedBalance).toBeUndefined();
    expect(basic.page).toBeUndefined();
  });

  it('flags no confirmed coinbase output as coinbase, and keeps no fiat rates in balance history', async () => {
    const utxos = await bb.getUtxos(RECIPIENT);
    expect(utxos.length).toBeGreaterThan(0);
    for (const utxo of utxos) expect(keys(utxo)).toEqual(['confirmations', 'height', 'txid', 'value', 'vout']);
    expect(await bb.getBalanceHistory(P2MR_A, { groupBy: 86400 })).toEqual([{ time: 1779148800, txs: 2, received: 1000000000n, sent: 1000000000n, sentToSelf: 0n }]);
  });

  it('answers a fee estimate in PRL per kB, and HTTP 500 where pearld has none', async () => {
    expect(await bb.estimateFee(6)).toBe(1007n);
    await expect(bb.estimateFee(0)).rejects.toMatchObject({ kind: 'rpc', status: 500, message: 'estimatefee: Internal server error' });
    expect(await blockbookBackend(bb, { minFeeRate: 1500n }).estimateFeeRate(0)).toBe(1500n);
  });

  it('derives the same BIP86 addresses from an xpub as pearljs, and names their paths with the coin type', async () => {
    const reply = await bb.getXpub(XPUB, { details: 'tokens', tokens: 'derived', gap: 1 });
    const account = importWatchOnlyAccount(XPUB, networks.mainnet);
    const tokens = reply.tokens ?? [];
    expect(tokens.length).toBeGreaterThan(0);
    for (const token of tokens) {
      const [, change, index] = /^m\/86'\/808276'\/0'\/(\d)\/(\d+)$/.exec(token.path ?? '') ?? [];
      expect(token.name).toBe(account.deriveAddress(Number(index), change === '1'));
    }
  });

  it('answers what is missing with HTTP 400 and text isBlockbookNotFound reads', async () => {
    for (const run of [() => bb.getTransaction('0'.repeat(64)), () => bb.getBlock(99_999_999), () => bb.getRawBlock(99_999_999)]) {
      const err = await run().catch((e: unknown) => e);
      expect(err).toMatchObject({ kind: 'rpc', status: 400 });
      expect(isBlockbookNotFound(err)).toBe(true);
    }
    expect((await bb.getBlock(99_999_999).catch((e: unknown) => e)) as Error).toMatchObject({ message: 'block: Block not found, Block not found' });
  });

  it('answers over the websocket as it was recorded', async () => {
    const replies = new Map(mainnet.ws.map((frame) => [JSON.stringify([frame.request.method, frame.request.params]), frame.reply]));
    class Replayed {
      readyState = 0;
      onopen: ((event: unknown) => void) | null = null;
      onclose: ((event: { code?: number }) => void) | null = null;
      onerror: ((event: unknown) => void) | null = null;
      onmessage: ((event: { data: unknown }) => void) | null = null;
      constructor() {
        queueMicrotask(() => ((this.readyState = 1), this.onopen?.({})));
      }
      send(text: string): void {
        const { id, method, params } = JSON.parse(text) as { id: string; method: string; params: unknown };
        const reply = replies.get(JSON.stringify([method, params]));
        const frames = reply !== undefined ? [reply]
          : method === 'subscribeNewBlock' ? ['{"id":"1","data":{"subscribed":true}}', mainnet.notifications.newBlock]
          : method === 'subscribeAddresses' ? ['{"id":"2","data":{"subscribed":true}}', mainnet.notifications.mempoolTx, mainnet.notifications.blockTx] : [];
        for (const frame of frames) queueMicrotask(() => this.onmessage?.({ data: frame.replace(/"id":"\d+"/, `"id":"${id}"`) }));
      }
      close(): void {
        this.readyState = 3;
      }
    }
    const ws = new BlockbookWsClient({ url: 'https://blockbook.example', network: networks.mainnet, WebSocket: Replayed as never, keepAlive: 0 });
    expect(await ws.getInfo()).toMatchObject({ testnet: false, backend: { version: '1050700', subversion: '/pearlwire:0.5.0/pearld:1.5.7/' } });
    expect(await ws.getBlockHash(0)).toBe(networks.mainnet.genesisHash);
    expect(await ws.getBlockHash(99_999_999)).toBeNull();
    await expect(ws.call('estimateFee', { blocks: [1, 6] })).rejects.toMatchObject({ kind: 'rpc', message: 'estimateFee: EstimateSmartFee: not supported' });
    expect(await ws.getAccountInfo({ descriptor: P2MR_A })).toMatchObject({ balance: 0n, txs: 2 });
    const blocks: unknown[] = [];
    await ws.subscribeNewBlock((block) => blocks.push(block));
    const heights: number[] = [];
    await ws.subscribeAddresses([BUSY], ({ tx }) => heights.push(tx.blockHeight), { newBlockTxs: true });
    await new Promise((resolve) => setTimeout(resolve, 1));
    expect(blocks).toEqual([{ height: 145347, hash: '0260f118a76469a52cd9fc653bb59a2efc62d2b97fecc55144bfb4ca4dedd9a7', evmData: null }]);
    // The mempool's comes at height 0 and is read as -1.
    expect(heights).toEqual([-1, 145347]);
    await ws.close();
  });
});

describe('Pearl\'s testnet Blockbook, as recorded', () => {
  it('serves testnet2, and describes an FP8 block as its serialization does', () => {
    const status = parseBlockbookJson(testnet2.rest['api/']!.body) as { backend: object };
    expect(status.backend).toMatchObject({ chain: 'testnet2', subversion: '/pearlwire:0.5.0/pearld:1.6.0-fp8-testnet1/', protocolVersion: '3' });
    const block = parseBlockbookJson(testnet2.rest['api/v2/block/150283']!.body) as { size: number; difficulty: string; hash: string };
    const raw = fromHex(fp8Blocks.blocks.find((b) => b.height === 150283)!.hex);
    const parsed = parseBlock(raw);
    expect(blockHashHex(parsed.header)).toBe(block.hash);
    expect(block.size).toBe(raw.length);
    expect(block.difficulty).toBe(difficultyForBits(parsed.header.bits, networks.testnet2).toFixed(8));
  });
});

describe('the simulated Blockbook', () => {
  const chain = new SimulatedChain({ network: networks.regtest });
  const server = simulatedBlockbook(chain);
  const get = async (path: string): Promise<{ status: number; value: unknown }> => {
    const reply = await server.fetch(`${server.url}${path}`);
    return { status: reply.status, value: JSON.parse(await reply.text()) };
  };

  it('writes the fields the real one writes', async () => {
    const real = (path: string) => body(mainnet, path) as Record<string, unknown>;
    const realStatus = real('api/') as { blockbook: object; backend: object };
    const status = (await get('api/')).value as { blockbook: object; backend: object };
    expect(keys(status.blockbook)).toEqual(keys(realStatus.blockbook));
    expect(keys(status.backend)).toEqual(keys(realStatus.backend));
    expect(keys((await get('api/v2/block/1')).value)).toEqual(keys(real('api/v2/block/145337')));

    const coinbase = chain.blocks[1]!.txs[0]!.getId();
    expect(keys((await get(`api/v2/tx/${coinbase}`)).value)).toEqual(keys(real(`api/v2/tx/${COINBASE}`)));
    const paid = chain.pay(STRANGER, 5000n);
    const pending = (await get(`api/v2/tx/${paid.getId()}`)).value as Record<string, unknown>;
    const realPending = real(`api/v2/tx/${(real('api/v2/mempool/?pageSize=3').mempool as { txid: string }[])[0]!.txid}`);
    expect(keys(pending).filter((key) => key !== 'rbf')).toEqual(keys(realPending).filter((key) => key !== 'rbf'));
    expect(keys(real('api/v2/mempool/?pageSize=3'))).toEqual(keys((await get('api/v2/mempool/?pageSize=3')).value));
  });

  it('words its errors as the real one does', async () => {
    chain.feeRate = null;
    for (const path of ['api/v2/block/99999999', 'api/v2/rawblock/99999999', `api/v2/tx/${'0'.repeat(64)}`, 'api/v2/estimatefee/0']) {
      const recorded = mainnet.rest[path as keyof typeof mainnet.rest] as { status: number; body: string };
      const reply = await get(path);
      expect([path, reply.status, reply.value]).toEqual([path, recorded.status, JSON.parse(recorded.body)]);
    }
  });

  it('tells of new blocks and of an address\'s mempool and block transactions in the real one\'s shapes', async () => {
    const frames: { id: string; data: Record<string, unknown> }[] = [];
    class Spy extends server.WebSocket {
      constructor(url: string) {
        super(url);
        const self = this as unknown as { onmessage: ((event: { data: unknown }) => void) | null };
        queueMicrotask(() => {
          const deliver = self.onmessage;
          self.onmessage = (event) => (frames.push(JSON.parse(String(event.data)) as never), deliver?.(event));
        });
      }
    }
    const ws = new BlockbookWsClient({ url: server.url, network: chain.network, WebSocket: Spy, keepAlive: 0 });
    await ws.subscribeNewBlock(() => {});
    await ws.subscribeAddresses([STRANGER], () => {}, { newBlockTxs: true });
    chain.pay(STRANGER, 5000n);
    chain.mine(1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const real = (frame: string) => (JSON.parse(frame) as { data: Record<string, unknown> }).data;
    const txOf = (data: Record<string, unknown>) => data.tx as Record<string, unknown>;
    const ours = frames.map((frame) => frame.data).filter((data) => !('subscribed' in data));
    const block = ours.find((data) => 'height' in data)!;
    const [pending, mined] = ours.filter((data) => 'tx' in data);
    expect(keys(block)).toEqual(keys(real(mainnet.notifications.newBlock)));
    expect(keys(txOf(pending!)).filter((key) => key !== 'rbf')).toEqual(keys(txOf(real(mainnet.notifications.mempoolTx))).filter((key) => key !== 'rbf'));
    expect(txOf(pending!).blockHeight).toBe(0);
    expect(keys(txOf(mined!))).toEqual(keys(txOf(real(mainnet.notifications.blockTx))));
    await ws.close();
  });

  it('answers the websocket\'s getInfo, an unknown height and estimateFee as the real one does', async () => {
    const ws = new BlockbookWsClient({ url: server.url, network: chain.network, WebSocket: server.WebSocket, keepAlive: 0 });
    expect(keys(await ws.getInfo())).toEqual(keys(wsReply('getInfo')));
    expect(keys((await ws.getInfo()).backend)).toEqual(keys((wsReply('getInfo') as { backend: object }).backend));
    expect(await ws.call('getBlockHash', { height: 99_999_999 })).toEqual(wsReply('getBlockHash', 1));
    const refusal = (wsReply('estimateFee') as { error: { message: string } }).error.message;
    await expect(ws.call('estimateFee', { blocks: [1, 6] })).rejects.toMatchObject({ message: `estimateFee: ${refusal}` });
    await ws.close();
  });
});
