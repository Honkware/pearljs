// The second round of the RPC client against a regtest pearld: the typed
// methods added to PearldClient, a real JSON-RPC batch with a failing entry,
// timeouts and aborts around a call that proves blocks, the same typed
// methods over the websocket client, fallbackTransport with its first node
// stopped, and a node without --addrindex under pearldBackend.

import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Agent, WebSocket } from 'undici';
import {
  blockHashHex,
  blockSubsidy,
  DEFAULT_RPC_TIMEOUT,
  deriveSigningAccountFromSeed,
  fallbackTransport,
  httpTransport,
  JsonRpcClient,
  matchFilter,
  MissingIndexError,
  mnemonicToSeed,
  parseBlock,
  parseBlockHeader,
  payFromAccount,
  PearldClient,
  pearldBackend,
  PearlRpcError,
  PearlWsClient,
  requiredCertVersion,
  RPC_ERROR_CODES,
  toOutputScript,
} from '../src/index.js';
import type { AccountUtxo, Transaction } from '../src/index.js';
import { clientOptions } from './context.js';
import { describeLive, describeOyster, FEE_RATE, fund, live, mine, miner, network, nowhere, pearld } from './chain.js';
import { startPearld, type RunningPearld } from './processes.js';

const account = deriveSigningAccountFromSeed(mnemonicToSeed('zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong'), network, 6);
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

describeLive('typed pearld methods', () => {
  let funding: Transaction;
  let blockHash: string;
  beforeAll(async () => {
    funding = await fund([{ script: toOutputScript(account.deriveAddress(0), network), value: 40_000_000n }]);
    blockHash = await pearld.getBestBlockHash();
  });

  it('reads a block with a spend in it, by ids and with every transaction decoded', async () => {
    const parsed = parseBlock(await pearld.getRawBlock(blockHash));
    const height = await pearld.getBlockCount();
    const block = await pearld.getBlock(blockHash);
    expect(block).toMatchObject({
      hash: blockHash,
      height,
      confirmations: 1,
      tx: parsed.transactions.map((tx) => tx.getId()),
      previousblockhash: await pearld.getBlockHash(height - 1),
      time: parsed.header.timestamp,
      bits: parsed.header.bits.toString(16),
    });
    expect(block.tx[1]).toBe(funding.getId());
    expect(await pearld.getBestBlock()).toEqual({ hash: blockHash, height });

    const { rawtx, ...rest } = await pearld.getBlockWithTransactions(blockHash);
    expect({ ...rest, tx: block.tx }).toEqual(block);
    expect(rawtx.map((tx) => tx.txid)).toEqual(block.tx);
    expect(rawtx.map((tx) => tx.vout.map((out) => out.value))).toEqual(parsed.transactions.map((tx) => tx.outs.map((out) => out.value)));
    expect(rawtx[1]!.vin[0]).toMatchObject({ txid: Buffer.from(funding.ins[0]!.hash).reverse().toString('hex'), vout: funding.ins[0]!.index });
    expect(rawtx[1]!.hex).toBe(funding.toHex());
  });

  it('names the mempool transaction spending an output, and forgets it once the spend is mined', async () => {
    const coin: AccountUtxo = { txid: funding.getId(), vout: 0, value: 40_000_000n, script: funding.outs[0]!.script, confirmations: 1, index: 0 };
    const payment = payFromAccount(account, {
      network,
      utxos: [coin],
      recipients: [{ address: account.deriveAddress(1), amount: 'max' }],
      feeRate: FEE_RATE,
    });
    const outputs = [
      { txid: coin.txid, vout: 0 },
      { txid: payment.txid, vout: 0 },
    ];
    expect(await pearld.getTxSpendingPrevOut(outputs)).toEqual(outputs);
    await pearld.sendRawTransaction(payment.hex);
    expect(await pearld.getTxSpendingPrevOut(outputs)).toEqual([{ ...outputs[0], spendingtxid: payment.txid }, outputs[1]]);
    // gettxout still shows the output: pearld does not count mempool spends.
    expect(await pearld.getTxOut(coin.txid, 0)).not.toBeNull();
    await mine(1);
    expect(await pearld.getTxSpendingPrevOut(outputs)).toEqual(outputs);
    expect(await pearld.getTxOut(coin.txid, 0)).toBeNull();
  });

  it('fetches a compact filter checked against its header, and headers after a locator', async () => {
    const height = (await pearld.getBlock(blockHash)).height;
    const before = await pearld.getBlockHash(height - 1);
    const filter = await pearld.getCFilter(blockHash, await pearld.getCFilterHeader(before));
    expect(filter.header).toBe(await pearld.getCFilterHeader(blockHash));
    expect(matchFilter(filter.filter, filter.key, funding.outs[0]!.script)).toBe(true);
    await expect(pearld.getCFilter(blockHash, await pearld.getCFilterHeader(blockHash))).rejects.toThrow('does not match its header');

    const tip = await pearld.getBlockCount();
    const locator = await pearld.getBlockHash(tip - 3);
    const headers = await pearld.getHeaders([locator]);
    expect(headers).toHaveLength(3);
    for (const [i, header] of headers.entries()) {
      const hash = await pearld.getBlockHash(tip - 2 + i);
      // The block without its transactions: certificate first, the 108-byte header last.
      expect((await pearld.getBlockHex(hash)).startsWith(header)).toBe(true);
      expect(blockHashHex(parseBlockHeader(Buffer.from(header, 'hex').subarray(-108)))).toBe(hash);
    }
    expect(await pearld.getHeaders([locator], await pearld.getBlockHash(tip - 2))).toEqual([headers[0]]);
  });

  it('describes the next block in getBlockTemplate with amounts in grains', async () => {
    const tip = await pearld.getBlockCount();
    const template = await pearld.getBlockTemplate();
    const fees = template.transactions.reduce((sum, tx) => sum + tx.fee, 0n);
    expect(template).toMatchObject({
      height: tip + 1,
      previousblockhash: await pearld.getBestBlockHash(),
      requiredcertversion: requiredCertVersion(network, tip + 1),
      coinbasevalue: blockSubsidy(network, tip + 1) + fees,
    });
    // Asked for a coinbase, pearld builds one paying --miningaddr.
    const withCoinbase = await pearld.getBlockTemplate({ capabilities: ['coinbasetxn'] });
    expect(withCoinbase.coinbasetxn?.data).toMatch(/^[0-9a-f]+$/);
  });

  it('throws when pearld rejects a submitted block', async () => {
    const raw = await pearld.getBlockHex(blockHash);
    const duplicate = await pearld.submitBlock(raw).catch((error: unknown) => error);
    expect(duplicate).toBeInstanceOf(PearlRpcError);
    expect(duplicate).toMatchObject({ kind: 'rpc', method: 'submitblock', code: RPC_ERROR_CODES.VERIFY });
    expect((duplicate as PearlRpcError).message).toMatch(/^submitblock: rejected: /);

    // The tip again with one output value changed no longer matches its merkle root.
    const tipHex = await pearld.getBlockHex(await pearld.getBestBlockHash());
    const block = parseBlock(Buffer.from(tipHex, 'hex'));
    const value = Buffer.alloc(8);
    value.writeBigUInt64LE(block.transactions[0]!.outs[0]!.value);
    const at = tipHex.indexOf(value.toString('hex') + '22' + hex(block.transactions[0]!.outs[0]!.script).slice(0, 4));
    expect(at).toBeGreaterThan(0);
    const altered = tipHex.slice(0, at) + (tipHex[at] === '0' ? '1' : '0') + tipHex.slice(at + 1);
    const tip = await pearld.getBestBlockHash();
    await expect(pearld.submitBlock(altered)).rejects.toMatchObject({ kind: 'rpc', code: RPC_ERROR_CODES.VERIFY });
    expect(await pearld.getBestBlockHash()).toBe(tip);
    await expect(pearld.submitBlock('00')).rejects.toMatchObject({ kind: 'rpc' });
  });

  it('answers a batch in one request, with the failing call failing alone', async () => {
    const bodies: string[] = [];
    const options = clientOptions(live!.pearld);
    const batched = new PearldClient({
      ...options,
      batch: true,
      fetch: (input, init) => {
        bodies.push(String(init?.body));
        return fetch(input, init);
      },
    });
    const results = await Promise.allSettled([
      batched.getBlockCount(),
      batched.getBlockHash(1),
      batched.call('nosuchmethod'),
      batched.getRawTransaction(funding.getId()),
      batched.getRawTransaction('00'.repeat(32)),
      batched.getTxOut(funding.getId(), 1),
    ]);
    expect(bodies).toHaveLength(1);
    expect(JSON.parse(bodies[0]!)).toHaveLength(6);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled', 'rejected', 'fulfilled', 'rejected', 'fulfilled']);
    const values = results.map((result) => (result.status === 'fulfilled' ? result.value : result.reason)) as unknown[];
    expect(values[0]).toBe(await pearld.getBlockCount());
    expect(values[1]).toBe(await pearld.getBlockHash(1));
    expect(values[2]).toMatchObject({ kind: 'rpc', method: 'nosuchmethod', code: -32601 });
    expect(values[3]).toEqual(await pearld.getRawTransaction(funding.getId()));
    expect(values[4]).toMatchObject({ kind: 'rpc', method: 'getrawtransaction', code: RPC_ERROR_CODES.NO_TX_INFO });
    expect(values[5]).toEqual(await pearld.getTxOut(funding.getId(), 1));
  });

  it('leaves generate without a default timeout, and gives up on a call when told to', { timeout: 300_000 }, async () => {
    // Twenty blocks take longer to prove than the default timeout allows any other call.
    const started = Date.now();
    const hashes = await pearld.generate(20);
    expect(hashes).toHaveLength(20);
    expect(Date.now() - started).toBeGreaterThan(DEFAULT_RPC_TIMEOUT);

    // Giving up on the reply does not stop pearld: it goes on proving, refuses a
    // second generate meanwhile, and the block arrives.
    const mined = async (height: number): Promise<void> => {
      const deadline = Date.now() + 60_000;
      while ((await pearld.getBlockCount()) < height && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 250));
      expect(await pearld.getBlockCount()).toBe(height);
    };
    const before = await pearld.getBlockCount();
    await expect(pearld.generate(1, { timeout: 300 })).rejects.toMatchObject({
      kind: 'network',
      method: 'generate',
      message: expect.stringMatching(/no reply from 127\.0\.0\.1:\d+ within 300 ms/) as string,
    });
    await expect(pearld.generate(1)).rejects.toMatchObject({
      kind: 'rpc',
      message: expect.stringContaining('Server is already CPU mining') as string,
    });
    await mined(before + 1);

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    await expect(pearld.generate(1, { signal: controller.signal })).rejects.toMatchObject({ kind: 'network', method: 'generate' });
    await mined(before + 2);
    await expect(pearld.call('getblockcount', [], { signal: AbortSignal.abort() })).rejects.toMatchObject({ kind: 'network' });
    await expect(pearld.call('getblockcount', [], { timeout: 1 })).rejects.toMatchObject({ kind: 'network' });
  });

  it('gives the same typed results over the websocket client', async () => {
    const agent = new Agent({ connect: { ca: live!.pearld.ca } });
    const ws = new PearlWsClient({ ...live!.pearld, WebSocket, webSocketInit: { dispatcher: agent } });
    try {
      expect(await ws.getBlockCount()).toBe(await pearld.getBlockCount());
      expect(await ws.getBlock(blockHash)).toEqual(await pearld.getBlock(blockHash));
      expect(await ws.getBlockWithTransactions(blockHash)).toEqual(await pearld.getBlockWithTransactions(blockHash));
      expect(await ws.getRawTransaction(funding.getId())).toEqual(await pearld.getRawTransaction(funding.getId()));
      expect(await ws.getTxOut(funding.getId(), 1)).toEqual(await pearld.getTxOut(funding.getId(), 1));
      expect(await ws.testMempoolAccept([funding.toHex()])).toEqual(await pearld.testMempoolAccept([funding.toHex()]));
      expect(await ws.getInfo()).toEqual(await pearld.getInfo());
      expect((await ws.getInfo()).relayfee).toBe(1000n);
      const [viaWs, viaHttp] = [await ws.getBlockTemplate(), await pearld.getBlockTemplate()];
      expect(viaWs.coinbasevalue).toBe(viaHttp.coinbasevalue);
      expect((await ws.getCFilter(blockHash)).filter).toEqual((await pearld.getCFilter(blockHash)).filter);
      await expect(ws.getRawTransaction('00'.repeat(32))).rejects.toMatchObject({ kind: 'rpc', code: RPC_ERROR_CODES.NO_TX_INFO });
    } finally {
      await ws.close();
      await agent.destroy();
    }
  });
});

describeLive('a second pearld without indexes', () => {
  let second: RunningPearld;
  beforeAll(async () => {
    second = await startPearld({
      exe: process.env.PEARLD!,
      dir: join(live!.dir, 'pearld-noindex'),
      miningAddress: miner.deriveAddress(1),
      withoutIndexes: true,
    });
    await second.client.node('connect', live!.p2p, 'temp');
    const deadline = Date.now() + 300_000;
    while ((await second.client.getBestBlockHash()) !== (await pearld.getBestBlockHash())) {
      if (Date.now() > deadline) throw new Error('the second node did not sync');
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }, 600_000);
  afterAll(async () => {
    await second?.stop();
  });

  it('shows up in getPeerInfo on both sides', async () => {
    const [inbound] = await pearld.getPeerInfo();
    const [outbound] = await second.client.getPeerInfo();
    expect(await pearld.getConnectionCount()).toBe(1);
    expect(inbound).toMatchObject({ inbound: true, relaytxes: true, feefilter: expect.any(BigInt) as bigint, version: outbound!.version });
    expect(outbound).toMatchObject({ addr: live!.p2p, inbound: false, subver: inbound!.subver });
    expect(inbound!.addr).toMatch(/^127\.0\.0\.1:\d+$/);
    expect(outbound!.startingheight).toBeGreaterThan(100);
  });

  it('fails address queries with MissingIndexError', async () => {
    const backend = pearldBackend(second.client, { network });
    const address = account.deriveAddress(0);
    for (const query of [() => backend.getUtxos([address]), () => backend.getBalance([address]), () => backend.getHistory(address)]) {
      const error = await query().catch((err: unknown) => err);
      expect(error).toBeInstanceOf(MissingIndexError);
      expect(error).toMatchObject({ index: 'addrindex' });
      expect((error as Error).message).toContain('start pearld with --addrindex');
    }
    // What needs no index still works.
    expect(await backend.getTip()).toEqual(await pearldBackend(pearld, { network }).getTip());
    expect(await backend.estimateFeeRate()).toBeGreaterThanOrEqual(1000n);
  });

  it('falls back to the second transport once the first node is stopped', async () => {
    const transports = [second.endpoint, live!.pearld].map((endpoint) => {
      const { url, username, password, init } = clientOptions(endpoint);
      return httpTransport({ url: url!, username: username!, password: password!, init: init! });
    });
    const client = new PearldClient({ transport: fallbackTransport(transports) });
    const txid = (await fund([{ script: toOutputScript(account.deriveAddress(2), network), value: 1_000_000n }])).getId();
    while ((await second.client.getBestBlockHash()) !== (await pearld.getBestBlockHash())) await new Promise((resolve) => setTimeout(resolve, 250));
    // While both are up the first answers, and it has no transaction index. Its
    // RPC error is an answer, so the node that knows the transaction is not asked.
    await expect(client.getRawTransaction(txid)).rejects.toMatchObject({ kind: 'rpc', code: RPC_ERROR_CODES.NO_TX_INFO });

    await second.stop();
    expect((await client.getRawTransaction(txid)).txid).toBe(txid);
    expect(await client.getBlockCount()).toBe(await pearld.getBlockCount());
    // With nobody left the last failure is reported.
    const dead = new PearldClient({ transport: fallbackTransport([transports[0]!, transports[0]!]) });
    await expect(dead.getBlockCount()).rejects.toMatchObject({ kind: 'network' });
  });
});

describeOyster('batches and Oyster', () => {
  it('gets one error for a whole batch from Oyster, which every call reports', async () => {
    const client = new JsonRpcClient({ ...clientOptions(live?.oyster ?? nowhere), batch: true });
    const results = await Promise.allSettled([client.call('getblockcount'), client.call('walletislocked')]);
    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected']);
    for (const result of results) expect((result as PromiseRejectedResult).reason).toBeInstanceOf(PearlRpcError);
  });
});
