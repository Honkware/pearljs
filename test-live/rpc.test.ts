// Every typed PearldClient method against a regtest pearld over its default
// TLS, with result shapes and grain amounts asserted, and the client's error
// mapping against the real servers: wrong password, plain HTTP to a TLS port,
// a refused connection, an untrusted certificate, an unknown method, and the
// limited user calling an admin method. OysterClient's methods are in
// oyster.test.ts and searchRawTransactions in invoice.test.ts.

import { beforeAll, expect, it } from 'vitest';
import {
  blockHashHex,
  createPsbt,
  createTransaction,
  deriveSigningAccountFromSeed,
  finalizePsbt,
  JsonRpcClient,
  mnemonicToSeed,
  parseBlock,
  parseTransaction,
  PearldClient,
  PearlRpcError,
  RPC_ERROR_CODES,
  serializeTransaction,
  toOutputScript,
  transactionId,
  witnessTransactionId,
} from '../src/index.js';
import type { Transaction } from '../src/index.js';
import { clientOptions, trustingAgent } from './context.js';
import { addChange, describeLive, describeOyster, fund, limited, live, mine, network, nowhere, oyster, pearld } from './chain.js';
import { freePort } from './processes.js';

const account = deriveSigningAccountFromSeed(mnemonicToSeed('zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong'), network);
const VALUE = 100_000_000n;
const HEX64 = /^[0-9a-f]{64}$/;
const address = account.deriveAddress(180);

async function failure(promise: Promise<unknown>): Promise<PearlRpcError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(PearlRpcError);
  return error as PearlRpcError;
}

describeLive('pearld RPC over TLS', () => {
  let funding: Transaction;
  let fundingHeight: number;
  let spend: Transaction;
  let fee: bigint;

  beforeAll(async () => {
    funding = await fund([{ script: toOutputScript(address, network), value: VALUE }]);
    fundingHeight = await pearld.getBlockCount();
    const tx = createTransaction(2);
    tx.addInput(funding.getHash(), 0);
    addChange(tx, VALUE, [{ type: 'keyPath' }]);
    fee = VALUE - tx.outs[0]!.value;
    const psbt = createPsbt(tx);
    account.prepareInput(psbt, 0, { index: 180, value: VALUE });
    account.signInput(psbt, 0, { index: 180 });
    spend = finalizePsbt(psbt);
  });

  it('reads the chain tip the same way through every method', async () => {
    const info = await pearld.getBlockchainInfo();
    expect(info).toMatchObject({ chain: 'regtest', blocks: fundingHeight, headers: fundingHeight, difficulty: 1, pruned: false });
    expect(info.bestblockhash).toMatch(HEX64);
    expect(info.mediantime).toBeGreaterThan(1_700_000_000);
    expect(info.bip9_softforks?.['dummy-always-active']).toMatchObject({ status: 'active', bit: 30 });
    expect(await pearld.getBlockCount()).toBe(info.blocks);
    expect(await pearld.getBestBlockHash()).toBe(info.bestblockhash);
    expect(await pearld.getBlockHash(info.blocks)).toBe(info.bestblockhash);
  });

  it('reads a block header that matches the raw block', async () => {
    const hash = await pearld.getBestBlockHash();
    const previous = await pearld.getBlockHash(fundingHeight - 1);
    const header = await pearld.getBlockHeader(hash);
    const raw = await pearld.getRawBlock(hash);
    expect(raw).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(raw).toString('hex')).toBe(await pearld.getBlockHex(hash));
    const block = parseBlock(raw);
    const reversed = (bytes: Uint8Array): string => Buffer.from(bytes).reverse().toString('hex');

    expect(header).toEqual({
      hash: blockHashHex(block.header),
      confirmations: 1,
      height: fundingHeight,
      version: block.header.version,
      versionHex: block.header.version.toString(16).padStart(8, '0'),
      merkleroot: reversed(Uint8Array.from(block.header.merkleRoot)),
      time: block.header.timestamp,
      bits: block.header.bits.toString(16).padStart(8, '0'),
      difficulty: 1,
      previousblockhash: previous,
      proofcommitment: reversed(Uint8Array.from(block.header.proofCommitment)),
    });
    expect(header.hash).toBe(hash);
    expect(await pearld.getBlockHeader(previous)).toMatchObject({ confirmations: 2, height: fundingHeight - 1, nextblockhash: hash });
  });

  it('reads transactions and outputs with values in grains', async () => {
    const txid = transactionId(funding);
    expect(await pearld.getRawTransactionHex(txid)).toBe(serializeTransaction(funding));
    const info = await pearld.getRawTransaction(txid);
    expect(info).toMatchObject({
      hex: serializeTransaction(funding),
      txid,
      hash: witnessTransactionId(funding),
      vsize: funding.virtualSize(),
      size: funding.byteLength(),
      version: 2,
      locktime: 0,
      blockhash: await pearld.getBlockHash(fundingHeight),
      confirmations: 1,
    });
    expect(info.time).toBe(info.blocktime);
    expect(info.vin).toEqual([
      {
        txid: Buffer.from(funding.ins[0]!.hash).reverse().toString('hex'),
        vout: funding.ins[0]!.index,
        scriptSig: { asm: '', hex: '' },
        txinwitness: [Buffer.from(funding.ins[0]!.witness[0]!).toString('hex')],
        sequence: 0xffffffff,
      },
    ]);
    expect(info.vout.map((out) => out.value)).toEqual(funding.outs.map((out) => out.value));
    expect(info.vout[0]).toEqual({
      value: VALUE,
      n: 0,
      scriptPubKey: {
        asm: `1 ${Buffer.from(funding.outs[0]!.script.slice(2)).toString('hex')}`,
        hex: Buffer.from(funding.outs[0]!.script).toString('hex'),
        reqSigs: 1,
        type: 'witness_v1_taproot',
        address,
        addresses: [address],
      },
    });

    // A coinbase: thousands of PRL, still exact, and an input without a txid.
    const coinbase = parseBlock(await pearld.getRawBlock(await pearld.getBlockHash(1))).transactions[0]!;
    const coinbaseInfo = await pearld.getRawTransaction(transactionId(coinbase));
    expect(coinbaseInfo.vout.map((out) => out.value)).toEqual(coinbase.outs.map((out) => out.value));
    expect(coinbaseInfo.vout[0]!.value).toBeGreaterThan(100_000_000_000n);
    expect(coinbaseInfo.vin[0]).toMatchObject({ coinbase: Buffer.from(coinbase.ins[0]!.script).toString('hex') });
    expect(coinbaseInfo.vin[0]).not.toHaveProperty('txid');

    expect(await pearld.getTxOut(txid, 0)).toEqual({
      bestblock: await pearld.getBestBlockHash(),
      confirmations: 1,
      value: VALUE,
      scriptPubKey: info.vout[0]!.scriptPubKey,
      coinbase: false,
    });
    // The first coinbase was spent by the very first funding transaction of the run.
    expect(await pearld.getTxOut(transactionId(coinbase), 0)).toBeNull();
    const latest = parseBlock(await pearld.getRawBlock(await pearld.getBestBlockHash())).transactions[0]!;
    expect(await pearld.getTxOut(transactionId(latest), 0)).toMatchObject({ coinbase: true, value: latest.outs[0]!.value });
    expect(await pearld.getTxOut('00'.repeat(32), 0)).toBeNull();
  });

  it('tests, sends, lists and mines a transaction, with fees in grains', async () => {
    const hex = serializeTransaction(spend);
    const txid = transactionId(spend);
    const vsize = spend.virtualSize();
    const rate = (fee * 1000n) / BigInt(vsize);
    const accepted = {
      txid,
      wtxid: witnessTransactionId(spend),
      'package-error': '',
      allowed: true,
      vsize,
      fees: { base: fee, 'effective-feerate': rate, 'effective-includes': null },
    };
    expect(await pearld.testMempoolAccept([hex])).toEqual([accepted]);
    expect(await pearld.testMempoolAccept([Buffer.from(hex, 'hex')], rate)).toEqual([accepted]);
    expect(await pearld.testMempoolAccept([hex, hex], rate - 1n)).toEqual(
      [0, 1].map(() => ({
        txid,
        wtxid: witnessTransactionId(spend),
        'package-error': '',
        allowed: false,
        'reject-reason': 'max-fee-exceeded',
      })),
    );

    expect(await pearld.sendRawTransaction(Buffer.from(hex, 'hex'))).toBe(txid);
    const again = await failure(pearld.sendRawTransaction(hex));
    expect(again).toMatchObject({ kind: 'rpc', rpcCode: RPC_ERROR_CODES.TX_REJECTED });
    expect(again.message).toBe(`sendrawtransaction: TX rejected: already have transaction in mempool ${txid} (code -26)`);

    expect(await pearld.getMempoolInfo()).toEqual({ size: 1, bytes: spend.byteLength(), cap: 300_000_000 });
    expect(await pearld.getRawMempool()).toEqual([txid]);
    const entries = await pearld.getRawMempoolVerbose();
    expect(entries).toEqual({
      [txid]: { size: spend.byteLength(), vsize, fee, time: expect.any(Number) as number, height: fundingHeight, depends: [] },
    });
    expect(await pearld.getRawTransaction(txid)).not.toHaveProperty('blockhash');
    expect(await pearld.getTxOut(txid, 0)).toMatchObject({ confirmations: 0, value: spend.outs[0]!.value, coinbase: false });
    expect(await pearld.getTxOut(txid, 0, false)).toBeNull();
    // Unlike Bitcoin Core, pearld still reports an output that a mempool transaction spends.
    expect(await pearld.getTxOut(transactionId(funding), 0)).toMatchObject({ value: VALUE, confirmations: 1 });
    expect(await pearld.getTxOut(transactionId(funding), 0, false)).toMatchObject({ value: VALUE, confirmations: 1 });

    const [blockHash] = await mine(1);
    expect(await pearld.getRawTransaction(txid)).toMatchObject({ blockhash: blockHash, confirmations: 1 });
    expect(await pearld.getMempoolInfo()).toMatchObject({ size: 0, bytes: 0 });
    expect(parseTransaction(await pearld.getRawTransactionHex(txid)).getId()).toBe(txid);
    const chained = await failure(pearld.sendRawTransaction(hex));
    expect(chained).toMatchObject({ kind: 'rpc', rpcCode: RPC_ERROR_CODES.TX_ALREADY_IN_CHAIN });
  });

  it('estimates a fee in grain per 1000 bytes once transactions have confirmed', async () => {
    // Every transaction of this suite pays 2000 grain per 1000 vbytes or close to it.
    const estimate = await pearld.estimateFee(1);
    expect(typeof estimate).toBe('bigint');
    expect(estimate).toBeGreaterThan(0n);
    expect(estimate).toBeLessThan(100_000n);
  });

  it('answers over TLS 1.2 as well', async () => {
    const endpoint = live!.pearld;
    const client = new PearldClient({
      ...clientOptions(endpoint),
      init: { dispatcher: trustingAgent(endpoint.ca, { maxVersion: 'TLSv1.2' }) },
    });
    expect(await client.getBlockCount()).toBe(await pearld.getBlockCount());
  });
});

describeLive('pearld RPC errors', () => {
  const endpoint = live?.pearld ?? nowhere;

  it('reports a wrong password as HTTP 401', async () => {
    const client = new PearldClient(clientOptions(endpoint, { username: endpoint.username, password: 'wrong' }));
    const error = await failure(client.getBlockCount());
    expect(error).toMatchObject({ kind: 'http', status: 401, rpcCode: undefined, method: 'getblockcount' });
    expect(error.message).toBe(`getblockcount: ${new URL(endpoint.url).host} rejected the RPC username or password (HTTP 401)`);
    // No credentials at all get the same answer.
    const anonymous = new PearldClient({ url: endpoint.url, init: clientOptions(endpoint).init! });
    expect(await failure(anonymous.getBlockCount())).toMatchObject({ kind: 'http', status: 401 });
  });

  it('reports plain HTTP sent to the TLS port', async () => {
    const client = new PearldClient({ ...clientOptions(endpoint), url: endpoint.url.replace('https:', 'http:') });
    const error = await failure(client.getBlockCount());
    expect(error).toMatchObject({ kind: 'http', status: 400 });
    expect(error.message).toBe(`getblockcount: ${new URL(endpoint.url).host} serves TLS; use an https:// URL (HTTP 400)`);
  });

  it('reports a refused connection', async () => {
    const port = await freePort();
    const client = new PearldClient({ ...clientOptions(endpoint), url: `https://127.0.0.1:${port}` });
    const error = await failure(client.getBlockCount());
    expect(error.kind).toBe('network');
    expect(error.message).toBe(
      `getblockcount: connection refused by 127.0.0.1:${port}; is the server running with RPC enabled on that port?`,
    );
  });

  it('reports the self-signed certificate when nothing trusts it', async () => {
    const client = new PearldClient({ url: endpoint.url, username: endpoint.username, password: endpoint.password });
    const error = await failure(client.getBlockCount());
    expect(error.kind).toBe('network');
    expect(error.message).toBe(
      `getblockcount: TLS certificate of ${new URL(endpoint.url).host} is not trusted (DEPTH_ZERO_SELF_SIGNED_CERT); pass a fetch or dispatcher that trusts the server's rpc.cert`,
    );
  });

  it('reports an unknown method, an unknown transaction and a bad parameter with pearld codes', async () => {
    expect(await failure(pearld.call('nosuchmethod'))).toMatchObject({
      kind: 'rpc',
      rpcCode: RPC_ERROR_CODES.METHOD_NOT_FOUND,
      message: 'nosuchmethod: Method not found (code -32601)',
    });
    expect(await failure(pearld.getRawTransaction('00'.repeat(32)))).toMatchObject({
      kind: 'rpc',
      rpcCode: RPC_ERROR_CODES.INVALID_ADDRESS_OR_KEY,
    });
    expect(await failure(pearld.getBlockHash(1_000_000))).toMatchObject({
      kind: 'rpc',
      rpcCode: RPC_ERROR_CODES.MISC,
      message: 'getblockhash: Block number out of range (code -1)',
    });
    expect(await failure(pearld.sendRawTransaction('zz'))).toMatchObject({ kind: 'rpc', rpcCode: RPC_ERROR_CODES.DESERIALIZATION });
  });

  it('lets the limited user read the chain but not call admin methods', async () => {
    expect(await limited.getBlockCount()).toBe(await pearld.getBlockCount());
    expect(await limited.getRawMempool()).toEqual(await pearld.getRawMempool());
    // getblockchaininfo and sendrawtransaction are admin-only in pearld.
    const refused = [
      () => limited.getBlockchainInfo(),
      () => limited.sendRawTransaction('00'),
      () => limited.call('generate', [1]),
    ];
    for (const call of refused) {
      const error = await failure(call());
      expect(error).toMatchObject({ kind: 'rpc', rpcCode: RPC_ERROR_CODES.INTERNAL });
      expect(error.message).toContain('limited user not authorized for this method');
    }
  });
});

describeOyster('Oyster RPC errors', () => {
  const endpoint = live?.oyster ?? nowhere;
  const host = new URL(endpoint.url).host;

  it('reports a wrong password, plain HTTP and an untrusted certificate like pearld', async () => {
    const wrong = new JsonRpcClient(clientOptions(endpoint, { username: endpoint.username, password: 'wrong' }));
    expect(await failure(wrong.call('getinfo'))).toMatchObject({
      kind: 'http',
      status: 401,
      message: `getinfo: ${host} rejected the RPC username or password (HTTP 401)`,
    });
    const plain = new JsonRpcClient({ ...clientOptions(endpoint), url: endpoint.url.replace('https:', 'http:') });
    expect(await failure(plain.call('getinfo'))).toMatchObject({
      kind: 'http',
      status: 400,
      message: `getinfo: ${host} serves TLS; use an https:// URL (HTTP 400)`,
    });
    const untrusting = new JsonRpcClient({ url: endpoint.url, username: endpoint.username, password: endpoint.password });
    const error = await failure(untrusting.call('getinfo'));
    expect(error.kind).toBe('network');
    expect(error.message).toContain('is not trusted (DEPTH_ZERO_SELF_SIGNED_CERT)');
  });

  it('refuses TLS 1.2, which pearld accepts', async () => {
    const client = new JsonRpcClient({
      ...clientOptions(endpoint),
      init: { dispatcher: trustingAgent(endpoint.ca, { maxVersion: 'TLSv1.2' }) },
    });
    const error = await failure(client.call('getinfo'));
    expect(error.kind).toBe('network');
    expect(error.message).toBe(
      `getinfo: TLS handshake with ${host} failed (ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION); the server needs a newer TLS version, and Oyster only speaks TLS 1.3`,
    );
  });

  it('passes methods it does not handle to pearld, and reports ones nobody knows', async () => {
    expect(await oyster.call('getblockcount')).toBe(await pearld.getBlockCount());
    expect(await oyster.call('getbestblockhash')).toBe(await pearld.getBestBlockHash());
    expect(await failure(oyster.call('nosuchmethod'))).toMatchObject({ kind: 'rpc', rpcCode: RPC_ERROR_CODES.METHOD_NOT_FOUND });
  });
});
