// BlockbookClient and BlockbookWsClient against the simulated Blockbook of
// pearljs/testing, and against replies written by hand where a shape comes
// from the fork's structs alone.

import { describe, expect, it } from 'vitest';
import { BlockbookClient, BlockbookWsClient, PearlRpcError, customNetwork, isBlockbookNotFound, networks, parseBlockbookJson } from '../src/index.js';
import { SimulatedChain, simulatedBlockbook } from '../src/testing.js';

const network = customNetwork(networks.regtest, { coinbaseMaturity: 2 });
const STRANGER = 'rprl1p8dhv8twyj9ezfvk62vvsfgw39s4dgl9t42y0549dc4d2947jj4cs30wfpz';

function setup() {
  const chain = new SimulatedChain({ network, premine: 4 });
  const server = simulatedBlockbook(chain);
  const client = new BlockbookClient({ url: server.url, network, fetch: server.fetch });
  return { chain, server, client };
}

const replying = (status: number, body: string) => (async () => new Response(body, { status })) as unknown as typeof fetch;

describe('BlockbookClient', () => {
  it('refuses plain http to a host other than loopback unless told to allow it', () => {
    expect(() => new BlockbookClient({ url: 'http://blockbook.example', network })).toThrow(/allowInsecureHttp/);
    expect(() => new BlockbookClient({ url: 'ws://blockbook.example', network })).toThrow(/not a Blockbook URL/);
    expect(() => new BlockbookWsClient({ url: 'http://blockbook.example', network, WebSocket: class {} as never })).toThrow(/allowInsecureHttp/);
    for (const url of ['http://127.0.0.1:9131', 'http://localhost:9131/', 'http://[::1]:9131', 'https://blockbook.example']) {
      expect(new BlockbookClient({ url, network }).url).toMatch(/\/$/);
    }
    expect(new BlockbookClient({ url: 'http://blockbook.example/prefix', network, allowInsecureHttp: true }).url).toBe('http://blockbook.example/prefix/');
  });

  it('names where a redirect leads, as Pearl\'s servers send http:// on to https://', async () => {
    const fetch = (async () => new Response(null, { status: 301, headers: { Location: 'https://blockbook.example:443/api/' } })) as unknown as typeof globalThis.fetch;
    const client = new BlockbookClient({ url: 'http://blockbook.example', network, fetch, allowInsecureHttp: true });
    await expect(client.getStatus()).rejects.toMatchObject({ kind: 'http', status: 301, message: expect.stringContaining('redirect to https://blockbook.example:443/api/') });
  });

  it('reads amounts as bigint grain and heights as numbers', async () => {
    const { chain, client } = setup();
    const paid = chain.pay(STRANGER, 123456789n);
    chain.mine(1);
    const tx = await client.getTransaction(paid.getId());
    expect(tx).toMatchObject({ txid: paid.getId(), blockHeight: chain.height, confirmations: 1, hex: paid.toHex() });
    expect(tx.vout.find((out) => out.addresses?.[0] === STRANGER)?.value).toBe(123456789n);
    expect(typeof tx.fees).toBe('bigint');
    expect(await client.getAddress(STRANGER, { details: 'basic' })).toEqual({
      address: STRANGER, balance: 123456789n, totalReceived: 123456789n, totalSent: 0n, unconfirmedTxs: 0, txs: 1,
    });
    expect(await client.getUtxos(STRANGER)).toEqual([{ txid: paid.getId(), vout: expect.any(Number), value: 123456789n, height: chain.height, confirmations: 1 }]);
    expect(await client.getBalanceHistory(STRANGER, { groupBy: 1 })).toEqual([{ time: chain.tip.time, txs: 1, received: 123456789n, sent: 0n, sentToSelf: 0n }]);
    expect((await client.getTransactionSpecific(paid.getId())).vout.map((out) => out.value)).toContain(123456789n);
    expect(await client.getBlockHash(chain.height)).toBe(chain.tip.hash);
    expect(await client.getBlockHash()).toBe(chain.tip.hash);
    expect(await client.getBlockHash(chain.height + 1)).toBeNull();
    expect((await client.getBlock(chain.height)).txs?.map((item) => item.txid)).toEqual(chain.tip.txs.map((item) => item.getId()));
    expect(await client.getRawBlock(chain.tip.hash)).toMatch(/^[0-9a-f]+$/);
    expect((await client.getStatus()).blockbook.bestHeight).toBe(chain.height);
  });

  it('puts the mempool before the confirmed history of an address and cuts the first page, as Blockbook does', async () => {
    const { chain, client } = setup();
    const confirmed = [chain.pay(STRANGER, 1000n), chain.pay(STRANGER, 2000n)];
    chain.mine(1);
    const pending = chain.pay(STRANGER, 3000n);
    const first = await client.getAddress(STRANGER, { pageSize: 2 });
    expect(first.txids).toEqual([pending.getId(), confirmed[0]!.getId()]);
    expect(first.unconfirmedBalance).toBe(3000n);
    // Without the mempool, the confirmed transaction it pushed off the page is there.
    expect((await client.getAddress(STRANGER, { pageSize: 2, to: chain.height })).txids).toEqual(confirmed.map((tx) => tx.getId()));
    // A page past the end is the last page again.
    expect((await client.getAddress(STRANGER, { pageSize: 2, page: 5, to: chain.height })).page).toBe(1);
  });

  it('converts the fee estimate from PRL per kB to grain per 1000 vbytes', async () => {
    const { chain, client, server } = setup();
    chain.feeRate = 12345n;
    expect(await client.estimateFee(6)).toBe(12345n);
    // The desktop wallet's v1 path is the same handler.
    const v1 = await server.fetch(`${server.url}api/v1/estimatefee/6`);
    expect(await v1.json()).toEqual({ result: '0.00012345' });
    chain.feeRate = null;
    await expect(client.estimateFee(6)).rejects.toMatchObject({ code: 'RPC_ERROR', status: 500 });
  });

  it('broadcasts, and reads pearld\'s refusal and its code out of Blockbook\'s error text', async () => {
    const { chain, client } = setup();
    const tx = chain.faucet.build([{ address: STRANGER, amount: 5000n }]);
    expect(await client.sendTransaction(tx.toHex())).toBe(tx.getId());
    const refused = await client.sendTransaction(tx.toHex()).catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(PearlRpcError);
    expect(refused).toMatchObject({ kind: 'rpc', status: 400, rpcCode: -26 });
    expect((refused as Error).message).toMatch(/^sendtx: -26: /);
  });

  it('tells a missing transaction from a failure', async () => {
    const { client } = setup();
    const missing = await client.getTransaction('11'.repeat(32)).catch((err: unknown) => err);
    expect(isBlockbookNotFound(missing)).toBe(true);
    const server = new BlockbookClient({ url: 'https://blockbook.example', network, fetch: replying(500, '{"error":"Internal server error"}') });
    expect(isBlockbookNotFound(await server.getTransaction('11'.repeat(32)).catch((err: unknown) => err))).toBe(false);
  });

  it('maps HTTP failures, unreadable replies and unreachable servers to error kinds', async () => {
    const cases: [typeof fetch, string][] = [
      [replying(404, '404 page not found\n'), 'http'],
      [replying(200, 'not json'), 'response'],
      [replying(200, '{"blockbook":{"decimals":8},"backend":{"chain":"regtest"}, "balance":"1.5"}'), 'response'],
      [(async () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) }); }) as unknown as typeof fetch, 'network'],
    ];
    for (const [fetcher, kind] of cases) {
      await expect(new BlockbookClient({ url: 'https://blockbook.example', network, fetch: fetcher }).checkNetwork()).rejects.toMatchObject({ kind });
    }
    await expect(new BlockbookClient({ url: 'https://blockbook.example', network, fetch: replying(302, '') }).checkNetwork()).rejects.toThrow(/redirect/);
  });

  it('refuses a server for another network before anything else', async () => {
    const chain = new SimulatedChain({ network: networks.testnet2, premine: 1 });
    const server = simulatedBlockbook(chain);
    const client = new BlockbookClient({ url: server.url, network, fetch: server.fetch });
    await expect(client.getAddress(STRANGER)).rejects.toMatchObject({ code: 'BACKEND_WRONG_NETWORK' });
    expect(server.requests.some((path) => path.startsWith('api/v2/address/'))).toBe(false);
    // Same genesis, other chain name: regtest and simnet.
    const sim = new SimulatedChain({ network: networks.simnet, premine: 1 });
    const simServer = simulatedBlockbook(sim);
    await expect(new BlockbookClient({ url: simServer.url, network: networks.regtest, fetch: simServer.fetch }).checkNetwork()).rejects.toMatchObject({ code: 'BACKEND_WRONG_NETWORK' });
  });

  it('retries reads after a failure when told to, and never a broadcast', async () => {
    const { server } = setup();
    let failures = 0;
    const flaky = (async (input: string | URL | Request, init?: RequestInit) => {
      if (failures > 0) {
        failures -= 1;
        return new Response('busy', { status: 503 });
      }
      return server.fetch(input, init);
    }) as typeof fetch;
    const client = new BlockbookClient({ url: server.url, network, fetch: flaky, retry: { retries: 2, delay: 1 } });
    failures = 2;
    await expect(client.getBlockHash(0)).resolves.toBe(networks.regtest.genesisHash);
    failures = 1;
    await expect(client.sendTransaction('00')).rejects.toMatchObject({ kind: 'http', status: 503 });
  });

  it('keeps no more requests in flight than allowed', async () => {
    const { server } = setup();
    let inFlight = 0;
    let most = 0;
    const counting = (async (input: string | URL | Request, init?: RequestInit) => {
      most = Math.max(most, ++inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inFlight -= 1;
      return server.fetch(input, init);
    }) as typeof fetch;
    const client = new BlockbookClient({ url: server.url, network, fetch: counting, maxConcurrentRequests: 2 });
    await Promise.all(Array.from({ length: 6 }, (_, i) => client.getBlockHash(i % 4)));
    expect(most).toBe(2);
  });

  it('reads an xpub reply with its derived addresses, as api.Address and api.Token write them', () => {
    // Fields as Worker.GetXpubAddress fills them for a Bitcoin-type xpub with tokens=used.
    const reply = parseBlockbookJson(
      '{"page":1,"totalPages":1,"itemsOnPage":1000,"address":"tr(xpub)","balance":"5000","totalReceived":"7000","totalSent":"2000","unconfirmedBalance":"0","unconfirmedTxs":0,"txs":2,"usedTokens":1,' +
        '"tokens":[{"type":"XPUBAddress","standard":"XPUBAddress","name":"rprl1p...","path":"m/86\'/1\'/0\'/0/0","transfers":2,"decimals":8,"balance":"5000","totalReceived":"7000","totalSent":"2000"}]}',
    );
    expect(reply).toMatchObject({ balance: 5000n, tokens: [{ path: "m/86'/1'/0'/0/0", balance: 5000n, totalSent: 2000n }] });
  });
});

describe('BlockbookWsClient', () => {
  const connect = (chain: SimulatedChain, extra: Partial<ConstructorParameters<typeof BlockbookWsClient>[0]> = {}) => {
    const server = simulatedBlockbook(chain);
    return { server, ws: new BlockbookWsClient({ url: server.url, network: chain.network, WebSocket: server.WebSocket, ...extra }) };
  };
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 1));
  };

  it('answers requests and tells of new blocks and of transactions touching subscribed addresses', async () => {
    const chain = new SimulatedChain({ network, premine: 4 });
    const { ws } = connect(chain);
    expect(await ws.getInfo()).toMatchObject({ bestHeight: chain.height, bestHash: chain.tip.hash, block0Hash: network.genesisHash, decimals: 8 });
    expect(await ws.getBlockHash(1)).toBe(chain.blocks[1]!.hash);
    chain.feeRate = 3000n;
    await expect(ws.call('estimateFee', { blocks: [2, 6] })).rejects.toMatchObject({ kind: 'rpc', message: 'estimateFee: EstimateSmartFee: not supported' });

    const blocks: number[] = [];
    const seen: { address: string; txid: string; height: number }[] = [];
    await ws.subscribeNewBlock((block) => blocks.push(block.height));
    await ws.subscribeAddresses([STRANGER], (event) => seen.push({ address: event.address, txid: event.tx.txid, height: event.tx.blockHeight }), { newBlockTxs: true });
    const paid = chain.pay(STRANGER, 5000n);
    chain.mine(1);
    await until(() => blocks.length === 1 && seen.length === 2);
    expect(blocks).toEqual([chain.height]);
    expect(seen).toEqual([
      { address: STRANGER, txid: paid.getId(), height: -1 },
      { address: STRANGER, txid: paid.getId(), height: chain.height },
    ]);
    expect(await ws.getAccountInfo({ descriptor: STRANGER })).toMatchObject({ balance: 5000n, txs: 1 });
    expect((await ws.getAccountUtxo(STRANGER)).map((utxo) => utxo.value)).toEqual([5000n]);
    expect((await ws.getTransaction(paid.getId())).hex).toBe(paid.toHex());
    expect(await ws.getBlockHash(999)).toBeNull();
    await ws.close();
  });

  it('subscribes again after the server drops the connection', async () => {
    const chain = new SimulatedChain({ network, premine: 4 });
    const { server, ws } = connect(chain, { reconnect: { initialDelay: 1 } });
    const blocks: number[] = [];
    const stop = await ws.subscribeNewBlock((block) => blocks.push(block.height));
    server.WebSocket.dropAll();
    await until(() => server.WebSocket.connections === 1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    chain.mine(1);
    await until(() => blocks.length === 1);
    expect(blocks).toEqual([chain.height]);
    await stop();
    chain.mine(1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(blocks).toHaveLength(1);
    await ws.close();
  });

  it('pings while connected, so a proxy that closes quiet websockets keeps the session', async () => {
    const chain = new SimulatedChain({ network, premine: 4 });
    const server = simulatedBlockbook(chain);
    const sent: string[] = [];
    const Spy = class extends server.WebSocket {
      override send(data: string): void {
        sent.push((JSON.parse(data) as { method: string }).method);
        super.send(data);
      }
    };
    const ws = new BlockbookWsClient({ url: server.url, network, WebSocket: Spy, keepAlive: 5 });
    await ws.subscribeNewBlock(() => {});
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(sent.filter((method) => method === 'ping').length).toBeGreaterThanOrEqual(2);
    await ws.close();
    const after = sent.length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent).toHaveLength(after);
  });

  it('refuses a server whose block 0 is another network\'s', async () => {
    const chain = new SimulatedChain({ network: networks.testnet2, premine: 1 });
    const server = simulatedBlockbook(chain);
    const ws = new BlockbookWsClient({ url: server.url, network, WebSocket: server.WebSocket });
    await expect(ws.getInfo()).rejects.toMatchObject({ code: 'BACKEND_WRONG_NETWORK' });
    await ws.close();
  });
});
