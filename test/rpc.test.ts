// The pearld and Oyster RPC clients against reply bodies written by Pearl's own
// handlers and btcjson types (vectors/rpcfixtures_test.go), through an injected
// fetch. The expected grain values come from the same Go program.

import { describe, expect, it, vi } from 'vitest';
import {
  DESKTOP_OYSTER_URL,
  JsonRpcClient,
  OysterClient,
  OysterRpc,
  PearldClient,
  PearldRpc,
  checkFilterHeaders,
  desktopOysterClient,
  fallbackTransport,
  filterKey,
  httpTransport,
  matchFilter,
  prlAmount,
  searchAllTransactions,
  blockHashHex,
  createInvoice,
  decodeWif,
  keyPathAddress,
  networks,
  parseBlock,
  parseTransaction,
  pearldChainClient,
  refreshInvoice,
  verifyMessage,
} from '../src/index.js';
import { expected, fakeFetch, fixture, rejection, type Route } from './rpc-helpers.js';
import { decimalToGrain } from '../src/internal/rpc-wire.js';

function pearld(routes: Record<string, Route>) {
  const fake = fakeFetch(routes);
  const client = new PearldClient({ url: 'https://127.0.0.1:18334', username: 'alice', password: 'sécret', fetch: fake.fetch });
  return { client, sent: fake.sent };
}

function oyster(routes: Record<string, Route>) {
  const fake = fakeFetch(routes);
  const client = new OysterClient({ url: 'https://127.0.0.1:18332', username: 'alice', password: 'pw', fetch: fake.fetch });
  return { client, sent: fake.sent };
}

const txid = expected('getrawtransaction-hex', 'txid') as string;
const genesisHash = expected('getblock-raw', 'hash') as string;
const address = expected('getrawtransaction-verbose', 'address') as string;

describe('requests', () => {
  it('posts a JSON-RPC 1.0 request with basic auth and an increasing id', async () => {
    const { client, sent } = pearld({ getblockcount: 'getblockcount' });
    expect(await client.getBlockCount()).toBe(321);
    await client.getBlockCount();

    const [first, second] = sent;
    expect(first!.url).toBe('https://127.0.0.1:18334/');
    expect(first!.init.method).toBe('POST');
    const headers = new Headers(first!.init.headers);
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(headers.get('Authorization')).toBe(`Basic ${Buffer.from('alice:sécret', 'utf8').toString('base64')}`);
    expect(first!.body).toEqual({ jsonrpc: '1.0', id: 1, method: 'getblockcount', params: [] });
    expect(second!.body.id).toBe(2);
  });

  it('moves credentials out of the URL and keeps extra init options such as a dispatcher', async () => {
    const fake = fakeFetch({ getbestblockhash: 'getbestblockhash' });
    const dispatcher = { name: 'agent trusting rpc.cert' };
    const client = new PearldClient({
      url: 'https://bob:p%40ss@localhost:44107',
      fetch: fake.fetch,
      init: { dispatcher, headers: { 'X-Trace': '1' } },
    });
    await client.getBestBlockHash();
    const [request] = fake.sent;
    expect(request!.url).toBe('https://localhost:44107/');
    expect(request!.init.dispatcher).toBe(dispatcher);
    const headers = new Headers(request!.init.headers);
    expect(headers.get('Authorization')).toBe(`Basic ${btoa('bob:p@ss')}`);
    expect(headers.get('X-Trace')).toBe('1');
  });

  it('sends the positional params pearld parses', async () => {
    const { client, sent } = pearld({
      getblockhash: 'getblockhash',
      getblock: 'getblock-raw',
      getrawtransaction: (r) => (r.body.params[1] === 0 ? 'getrawtransaction-hex' : 'getrawtransaction-verbose'),
      gettxout: 'gettxout',
      getrawmempool: (r) => (r.body.params[0] ? 'getrawmempool-verbose' : 'getrawmempool'),
      estimatefee: 'estimatefee',
      sendrawtransaction: 'sendrawtransaction',
      searchrawtransactions: 'searchrawtransactions',
      getblockheader: 'getblockheader',
    });
    await client.getBlockHash(7);
    await client.getBlockHex(genesisHash);
    await client.getRawTransactionHex(txid);
    await client.getRawTransaction(txid);
    await client.getTxOut(txid, 1);
    await client.getTxOut(txid, 1, false);
    await client.getRawMempool();
    await client.getRawMempoolVerbose();
    await client.estimateFee(6);
    await client.sendRawTransaction(new Uint8Array([0x02, 0xab]));
    await client.searchRawTransactions(address, { skip: 100, count: 50 });
    await client.searchRawTransactions(address, { reverse: true, vinExtra: true });
    await client.getBlockHeader(genesisHash);
    expect(sent.map((r) => [r.body.method, r.body.params])).toEqual([
      ['getblockhash', [7]],
      ['getblock', [genesisHash, 0]],
      ['getrawtransaction', [txid, 0]],
      ['getrawtransaction', [txid, 1]],
      ['gettxout', [txid, 1, true]],
      ['gettxout', [txid, 1, false]],
      ['getrawmempool', [false]],
      ['getrawmempool', [true]],
      ['estimatefee', [6]],
      ['sendrawtransaction', ['02ab']],
      ['searchrawtransactions', [address, 1, 100, 50, 0, false]],
      ['searchrawtransactions', [address, 1, 0, 100, 1, true]],
      ['getblockheader', [genesisHash, true]],
    ]);
  });

  it('writes amounts wrapped in prlAmount as PRL and bare bigints as the integers they are', async () => {
    const fake = fakeFetch({ getblockhash: 'getblockhash', sendtoaddress: 'sendtoaddress' });
    const client = new JsonRpcClient({ url: 'http://127.0.0.1:18332', fetch: fake.fetch });
    await client.call('getblockhash', [150n]);
    expect(fake.sent[0]!.text).toContain('"params":[150]');
    await client.call('getblockhash', [18446744073709551615n]);
    expect(fake.sent[1]!.text).toContain('"params":[18446744073709551615]');
    await client.call('sendtoaddress', [address, prlAmount(150n), prlAmount(1000n)]);
    expect(fake.sent[2]!.text).toContain(`"params":["${address}",0.0000015,0.00001]`);
    expect(() => prlAmount(1.5 as unknown as bigint)).toThrow('bigint number of grains');
  });

  it('writes the grain amounts of typed methods as exact PRL numbers', async () => {
    const { client: node, sent: nodeSent } = pearld({ testmempoolaccept: 'testmempoolaccept-allowed' });
    await node.testMempoolAccept(['00'], 10000000n);
    expect(nodeSent[0]!.text).toContain('"params":[["00"],0.1]');
    // A live pearld answers "wrong number of params (expected 2, received 1)" without the rate.
    await node.testMempoolAccept(['00']);
    expect(nodeSent[1]!.text).toContain('"params":[["00"],0]');

    const { client: wallet, sent } = oyster({ sendtoaddress: 'sendtoaddress' });
    await wallet.sendToAddress(address, 2099999999999999999n, 1000n);
    expect(sent[0]!.text).toContain(`"params":["${address}",20999999999.99999999,0.00001]`);
  });

  it('sends the Oyster params its handlers expect', async () => {
    const { client, sent } = oyster({
      getnewaddress: 'getnewaddress',
      getbalance: 'getbalance',
      getunconfirmedbalance: 'getbalance',
      listunspent: 'listunspent',
      signmessage: 'signmessage',
      verifymessage: 'verifymessage',
      walletpassphrase: 'walletpassphrase',
      walletlock: 'walletlock',
      importprivkey: 'importprivkey',
      dumpprivkey: 'dumpprivkey',
    });
    await client.getNewAddress();
    await client.getNewAddress('savings');
    await client.getBalance();
    await client.getBalance('default', 6);
    await client.getUnconfirmedBalance();
    await client.listUnspent();
    await client.signMessage(address, 'hi');
    await client.verifyMessage(address, 'c2ln', 'hi');
    await client.walletPassphrase('pw', 60);
    await client.walletLock();
    await client.importPrivKey('cWIF', false);
    await client.dumpPrivKey(address);
    expect(sent.map((r) => [r.body.method, r.body.params])).toEqual([
      ['getnewaddress', []],
      ['getnewaddress', ['savings']],
      ['getbalance', ['*', 1]],
      ['getbalance', ['default', 6]],
      ['getunconfirmedbalance', []],
      ['listunspent', [1, 9999999]],
      ['signmessage', [address, 'hi']],
      ['verifymessage', [address, 'c2ln', 'hi']],
      ['walletpassphrase', ['pw', 60]],
      ['walletlock', []],
      ['importprivkey', ['cWIF', 'imported', false]],
      ['dumpprivkey', [address]],
    ]);
  });
});

describe('pearld results', () => {
  it('reads getblockchaininfo as pearld writes it', async () => {
    const { client } = pearld({ getblockchaininfo: 'getblockchaininfo' });
    const info = await client.getBlockchainInfo();
    expect(info.chain).toBe('regtest');
    expect(info.blocks).toBe(321);
    expect(info.bestblockhash).toBe(genesisHash);
    expect(info.bip9_softforks?.dummy?.status).toBe('defined');
  });

  it('returns raw block bytes that parseBlock reads', async () => {
    const { client } = pearld({ getblock: 'getblock-raw' });
    const block = parseBlock(await client.getRawBlock(genesisHash));
    expect(blockHashHex(block.header)).toBe(genesisHash);
  });

  it('returns raw transaction hex that parseTransaction reads', async () => {
    const { client } = pearld({ getrawtransaction: 'getrawtransaction-hex' });
    expect(parseTransaction(await client.getRawTransactionHex(txid)).getId()).toBe(txid);
  });

  it('converts output values to grains without float rounding', async () => {
    const { client } = pearld({ getrawtransaction: 'getrawtransaction-verbose' });
    const tx = await client.getRawTransaction(txid);
    expect(tx.vout.map((out) => out.value)).toEqual(
      (expected('getrawtransaction-verbose', 'values') as string[]).map(BigInt),
    );
    // As a float the largest value is off by 1 grain.
    expect(BigInt(Math.round(Number('20999999999.99999999') * 1e8))).not.toBe(tx.vout[0]!.value);
    expect(tx.vout[0]!.scriptPubKey.address).toBe(address);
    expect(tx.blockhash).toBe(genesisHash);
    expect(tx.vin[0]).toMatchObject({ txid: '22'.repeat(32), vout: 1 });
  });

  it('reads coinbase inputs', async () => {
    const { client } = pearld({ getrawtransaction: 'getrawtransaction-coinbase' });
    const tx = await client.getRawTransaction(txid);
    expect('coinbase' in tx.vin[0]!).toBe(true);
    expect(tx.vout[0]!.value).toBe(BigInt(expected('getrawtransaction-coinbase', 'value') as string));
  });

  it('reads gettxout and the null pearld sends for a spent output', async () => {
    const { client } = pearld({ gettxout: (r) => (r.body.params[1] === 0 ? 'gettxout' : 'gettxout-spent') });
    const out = await client.getTxOut(txid, 0);
    expect(out?.value).toBe(BigInt(expected('gettxout', 'value') as string));
    expect(out?.scriptPubKey.type).toBe('witness_v1_taproot');
    expect(await client.getTxOut(txid, 1)).toBeNull();
  });

  it('reads the mempool in both forms', async () => {
    const { client } = pearld({
      getmempoolinfo: 'getmempoolinfo',
      getrawmempool: (r) => (r.body.params[0] ? 'getrawmempool-verbose' : 'getrawmempool'),
    });
    expect(await client.getMempoolInfo()).toEqual({ size: 2, bytes: 431, cap: 300000000 });
    expect(await client.getRawMempool()).toEqual([txid]);
    const entries = await client.getRawMempoolVerbose();
    expect(entries[txid]?.fee).toBe(BigInt(expected('getrawmempool-verbose', 'fee') as string));
    expect(entries[txid]?.vsize).toBe(121);
  });

  it('reads testmempoolaccept fees in grains and fills in allowed', async () => {
    const { client } = pearld({
      testmempoolaccept: (r) => (r.body.params[1] !== 0 ? 'testmempoolaccept-rejected' : 'testmempoolaccept-allowed'),
    });
    const [ok] = await client.testMempoolAccept(['00']);
    expect(ok?.allowed).toBe(true);
    expect(ok?.wtxid).toBe(expected('testmempoolaccept-allowed', 'wtxid'));
    expect(ok?.fees?.base).toBe(BigInt(expected('testmempoolaccept-allowed', 'fee') as string));
    expect(ok?.fees?.['effective-feerate']).toBe(BigInt(expected('testmempoolaccept-allowed', 'feeRate') as string));

    const [refused] = await client.testMempoolAccept(['00'], 1n);
    expect(refused?.allowed).toBe(false);
    expect(refused?.['reject-reason']).toBe('transaction has insufficient priority');
  });

  it('reads estimatefee as grain per 1000 bytes', async () => {
    const { client } = pearld({ estimatefee: 'estimatefee' });
    expect(await client.estimateFee(6)).toBe(BigInt(expected('estimatefee', 'rate') as string));
  });

  it('returns the txid from sendrawtransaction', async () => {
    const { client } = pearld({ sendrawtransaction: 'sendrawtransaction' });
    expect(await client.sendRawTransaction('00')).toBe(txid);
  });
});

describe('Oyster results', () => {
  it('reads balances in grains, including the 1e-8 Go writes for one grain', async () => {
    const { client } = oyster({ getbalance: (r) => (r.body.params[1] === 1 ? 'getbalance' : 'getbalance-one-grain') });
    expect(await client.getBalance()).toBe(BigInt(expected('getbalance', 'balance') as string));
    expect(await client.getBalance('*', 0)).toBe(BigInt(expected('getbalance-one-grain', 'balance') as string));
  });

  it('reads listunspent amounts in grains', async () => {
    const { client } = oyster({ listunspent: 'listunspent' });
    const [utxo] = await client.listUnspent();
    expect(utxo).toMatchObject({ txid, vout: 0, address, account: 'default', spendable: true });
    expect(utxo?.amount).toBe(BigInt(expected('listunspent', 'amount') as string));
  });

  it('returns a signmessage signature that pearljs verifies', async () => {
    const { client } = oyster({ signmessage: 'signmessage', verifymessage: 'verifymessage' });
    const message = expected('signmessage', 'message') as string;
    const signature = await client.signMessage(address, message);
    expect(verifyMessage(address, signature, message, networks.regtest)).toBe(true);
    expect(await client.verifyMessage(address, signature, message)).toBe(true);
  });

  it('returns a dumpprivkey WIF for the key behind getnewaddress', async () => {
    const { client } = oyster({ dumpprivkey: 'dumpprivkey', getnewaddress: 'getnewaddress' });
    const { privateKey } = decodeWif(await client.dumpPrivKey(address), networks.regtest);
    expect(keyPathAddress(privateKey, networks.regtest)).toBe(await client.getNewAddress());
  });

  it('resolves the null results of walletpassphrase, walletlock and importprivkey', async () => {
    const { client } = oyster({ walletpassphrase: 'walletpassphrase', walletlock: 'walletlock', importprivkey: 'importprivkey' });
    await expect(client.walletPassphrase('pw', 0)).resolves.toBeUndefined();
    await expect(client.walletLock()).resolves.toBeUndefined();
    await expect(client.importPrivKey('cWIF')).resolves.toBeUndefined();
  });
});

describe('generic calls', () => {
  it('returns plain JSON numbers unless amount keys are named', async () => {
    const fake = fakeFetch({ getbalance: 'getbalance', listunspent: 'listunspent' });
    const client = new JsonRpcClient({ url: 'http://127.0.0.1:18332', fetch: fake.fetch });
    expect(await client.call('getbalance')).toBe(12.345678);
    expect(await client.call('getbalance', [], { amounts: ['result'] })).toBe(1234567800n);
    const [utxo] = await client.call<{ amount: bigint; confirmations: number }[]>('listunspent', [], { amounts: ['amount'] });
    expect(utxo).toMatchObject({ amount: 150000000n, confirmations: 6 });
    expect(new Headers(fake.sent[0]!.init.headers).has('Authorization')).toBe(false);
  });
});

describe('errors', () => {
  it('carries the RPC code and message from an error reply', async () => {
    const { client } = pearld({ getrawtransaction: 'getrawtransaction-missing', frobnicate: 'method-not-found' });
    const missing = await rejection(client.getRawTransaction(txid));
    expect(missing).toMatchObject({ kind: 'rpc', rpcCode: -5, method: 'getrawtransaction', status: undefined });
    expect(missing.message).toBe(`getrawtransaction: No information available about transaction ${txid} (code -5)`);
    expect(await rejection(client.call('frobnicate'))).toMatchObject({ kind: 'rpc', rpcCode: -32601 });
  });

  it('maps pearld and Oyster refusals to their codes', async () => {
    const node = pearld({
      sendrawtransaction: 'sendrawtransaction-rejected',
      estimatefee: 'estimatefee-unavailable',
      stop: 'limited-user',
    });
    const rejected = await rejection(node.client.sendRawTransaction('00'));
    expect(rejected.rpcCode).toBe(-26);
    expect(rejected.message).toContain('TX rejected: transaction version 3 is not standard');
    expect((await rejection(node.client.estimateFee(6))).rpcCode).toBe(-1);
    expect((await rejection(node.client.call('stop'))).rpcCode).toBe(-32603);

    const wallet = oyster({ sendtoaddress: 'wallet-locked', walletlock: 'wallet-unsupported', getbalance: 'wallet-error' });
    expect((await rejection(wallet.client.sendToAddress(address, 1n, 1000n))).rpcCode).toBe(-13);
    expect((await rejection(wallet.client.walletLock())).rpcCode).toBe(-1);
    expect((await rejection(wallet.client.getBalance())).rpcCode).toBe(-4);
  });

  it('names a 401 as rejected credentials', async () => {
    const { client } = pearld({
      getblockcount: () => new Response('401 Unauthorized.\n', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="pearld RPC"' } }),
    });
    const err = await rejection(client.getBlockCount());
    expect(err).toMatchObject({ kind: 'http', status: 401, rpcCode: undefined });
    expect(err.message).toBe('getblockcount: 127.0.0.1:18334 rejected the RPC username or password (HTTP 401)');
    expect(err.message).not.toContain('sécret');
  });

  it('names plain HTTP sent to a TLS port', async () => {
    const { client } = pearld({
      getblockcount: () => new Response('Client sent an HTTP request to an HTTPS server.\n', { status: 400 }),
    });
    expect((await rejection(client.getBlockCount())).message).toContain('serves TLS; use an https:// URL');
  });

  it('names a refused connection and an untrusted certificate', async () => {
    const failing = (code: string) =>
      (async () => {
        const cause = Object.assign(new Error(`connect ${code} 127.0.0.1:18334`), { code });
        throw new TypeError('fetch failed', { cause });
      }) as typeof fetch;
    const refused = new PearldClient({ url: 'https://127.0.0.1:18334', fetch: failing('ECONNREFUSED') });
    const err = await rejection(refused.getBlockCount());
    expect(err).toMatchObject({ kind: 'network', rpcCode: undefined, status: undefined });
    expect(err.message).toContain('connection refused by 127.0.0.1:18334');
    expect(err.cause).toBeInstanceOf(TypeError);

    // What Node reports when Oyster, which requires TLS 1.3, is offered TLS 1.2.
    const oldTls = new OysterClient({ url: 'https://127.0.0.1:18332', fetch: failing('ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION') });
    const tlsErr = await rejection(oldTls.walletIsLocked());
    expect(tlsErr.kind).toBe('network');
    expect(tlsErr.message).toContain('Oyster only speaks TLS 1.3');

    const untrusted = new PearldClient({ url: 'https://127.0.0.1:18334', fetch: failing('DEPTH_ZERO_SELF_SIGNED_CERT') });
    expect((await rejection(untrusted.getBlockCount())).message).toContain("trusts the server's rpc.cert");
  });

  it('rejects an empty body, a non-JSON body and a reply to another request', async () => {
    const { client } = pearld({
      getblockcount: () => new Response('', { status: 200 }),
      getbestblockhash: () => new Response('<html>', { status: 200 }),
      getblockhash: () => 'getblockhash',
    });
    expect((await rejection(client.getBlockCount())).message).toContain('an empty body');
    expect((await rejection(client.getBestBlockHash())).kind).toBe('response');

    const stale = new PearldClient({
      url: 'https://127.0.0.1:18334',
      fetch: (async () => new Response(fixture('getblockhash').body)) as typeof fetch,
    });
    expect((await rejection(stale.getBlockHash(0))).message).toContain('does not match request id 1');
  });
});

describe('decimalToGrain', () => {
  it('reads every form Go writes for a float amount', () => {
    expect(decimalToGrain('1.5')).toBe(150000000n);
    expect(decimalToGrain('1e-8')).toBe(1n);
    expect(decimalToGrain('1.2e-7')).toBe(12n);
    expect(decimalToGrain('2.1e+09')).toBe(210000000000000000n);
    expect(decimalToGrain('-0.5')).toBe(-50000000n);
    expect(decimalToGrain('0.30000000000000004')).toBe(30000000n);
    expect(decimalToGrain('0.000000015')).toBe(2n);
    expect(decimalToGrain('20999999999.99999999')).toBe(2099999999999999999n);
  });

  it('refuses text that is not a JSON number', () => {
    expect(() => decimalToGrain('1.')).toThrow('invalid PRL amount');
    expect(() => decimalToGrain('0x10')).toThrow('invalid PRL amount');
  });
});

describe('pearldChainClient', () => {
  it('reports address payments and tip for the invoice monitor', async () => {
    const { client, sent } = pearld({
      getblockchaininfo: 'getblockchaininfo',
      // The fixture holds one confirmed and one mempool transaction; the
      // mempool is then read from the confirmed count on, in one request.
      searchrawtransactions: (r) =>
        r.body.params[2] === 0 || r.body.params[3] === 10000 ? 'searchrawtransactions' : 'searchrawtransactions-none',
      getblockheader: 'getblockheader',
    });
    const chain = pearldChainClient(client, { pageSize: 2 });
    expect(await chain.getTip()).toEqual({ height: 321, hash: genesisHash });

    const activity = await chain.getAddressActivity(address);
    expect(activity).toEqual([
      {
        txid: expected('searchrawtransactions', 'confirmed'),
        amount: BigInt(expected('searchrawtransactions', 'confirmedAmount') as string),
        block: { height: 316, hash: genesisHash },
      },
      {
        txid: expected('searchrawtransactions', 'pending'),
        amount: BigInt(expected('searchrawtransactions', 'pendingAmount') as string),
        block: null,
      },
    ]);
    const skips = sent.filter((r) => r.body.method === 'searchrawtransactions').map((r) => r.body.params[2]);
    expect(skips).toEqual([0, 1]);
  });

  it('finds every mempool payment although pearld lists the mempool in a new order on each call', async () => {
    // What a live pearld does: confirmed transactions in a fixed order, then
    // the mempool's in Go map order, and -5 once skip passes the end.
    const entry = (n: number, blockhash?: string) => ({
      txid: n.toString(16).padStart(64, '0'),
      ...(blockhash === undefined ? {} : { blockhash, confirmations: 1 }),
      vin: [],
      vout: [{ value: n, n: 0, scriptPubKey: { asm: '', type: 'witness_v1_taproot', address } }],
    });
    const confirmed = [1, 2, 3].map((n) => entry(n, genesisHash));
    const mempool = [4, 5, 6, 7, 8].map((n) => entry(n));
    let calls = 0;
    const { client } = pearld({
      getblockheader: 'getblockheader',
      searchrawtransactions: (r) => {
        const [, , skip, count] = r.body.params as [string, number, number, number];
        const turn = calls++ % mempool.length;
        const listed = [...confirmed, ...mempool.slice(turn), ...mempool.slice(0, turn)].slice(skip, skip + count);
        const reply =
          listed.length === 0
            ? { result: null, error: { rpcCode: -5, message: 'No information available about address' } }
            : { result: listed, error: null };
        return new Response(JSON.stringify({ ...reply, id: r.body.id }));
      },
    });
    for (const pageSize of [1, 2, 3, 4, 7, 8, 100]) {
      const activity = await pearldChainClient(client, { pageSize }).getAddressActivity(address);
      expect(activity.map((payment) => Number(payment.amount / 100000000n)).sort()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      expect(activity.filter((payment) => payment.block === null)).toHaveLength(5);
    }
  });

  it('returns null for a transaction pearld does not know', async () => {
    const { client } = pearld({ getrawtransaction: 'getrawtransaction-missing' });
    expect(await pearldChainClient(client).getTransaction(txid)).toBeNull();
  });

  it('finds the confirming block of a known transaction', async () => {
    const { client } = pearld({ getrawtransaction: 'getrawtransaction-verbose', getblockheader: 'getblockheader' });
    expect(await pearldChainClient(client).getTransaction(txid)).toEqual({ txid, block: { height: 316, hash: genesisHash } });
  });

  it('feeds the invoice monitor, which waits on the unconfirmed payment', async () => {
    const { client } = pearld({
      getblockchaininfo: 'getblockchaininfo',
      searchrawtransactions: 'searchrawtransactions',
      getblockheader: 'getblockheader',
      getrawtransaction: 'getrawtransaction-verbose',
    });
    const invoice = createInvoice({
      id: 'inv-1',
      address,
      amount: 100000000n,
      createdAt: 1000,
      expiresAt: 2000,
      requiredConfirmations: 6,
    }, networks.regtest);
    const refreshed = await refreshInvoice(invoice, pearldChainClient(client), 1500);
    const paid = ['confirmedAmount', 'pendingAmount'].map((k) => BigInt(expected('searchrawtransactions', k) as string));
    expect(refreshed.paidAmount).toBe(paid[0]! + paid[1]!);
    expect(refreshed.state).toBe('pending');
  });

  it('passes on errors other than an unused address', async () => {
    const { client } = pearld({
      searchrawtransactions: 'searchrawtransactions-noindex',
    });
    const err = await rejection(pearldChainClient(client).getAddressActivity(address));
    expect(err.message).toContain('--addrindex');
  });
});

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const unhex = (text: string) => Uint8Array.from(Buffer.from(text, 'hex'));

describe('more pearld methods', () => {
  it('sends the positional params pearld parses for them', async () => {
    const { client, sent } = pearld({
      getblock: (r) => (r.body.params[1] === 1 ? 'getblock-verbose' : 'getblock-transactions'),
      getbestblock: 'getbestblock',
      getchaintips: 'getchaintips',
      gettxspendingprevout: 'gettxspendingprevout',
      decoderawtransaction: 'decoderawtransaction',
      decodescript: 'decodescript',
      validateaddress: 'validateaddress',
      getcfilterheader: 'getcfilterheader',
      getheaders: 'getheaders',
      getnetworkhashps: 'getnetworkhashps',
      getblocktemplate: 'getblocktemplate',
      submitblock: 'submitblock-accepted',
      generate: 'generate',
      addnode: 'addnode',
      node: 'node',
      stop: 'stop',
    });
    await client.getBlock(genesisHash);
    await client.getBlockWithTransactions(genesisHash);
    await client.getBestBlock();
    await client.getChainTips();
    await client.getTxSpendingPrevOut([{ txid, vout: 1 }]);
    await client.decodeRawTransaction(Uint8Array.of(1, 2));
    await client.decodeScript('51');
    await client.validateAddress(address);
    await client.getCFilterHeader(genesisHash);
    await client.getHeaders([genesisHash]);
    await client.getNetworkHashPs();
    await client.getBlockTemplate({ capabilities: ['coinbasevalue'] });
    await client.submitBlock(Uint8Array.of(0xab));
    await client.generate(2);
    await client.addNode('127.0.0.1:18444', 'onetry');
    await client.node('disconnect', 7);
    await client.node('connect', '127.0.0.1:18444', 'temp');
    expect(await client.stop()).toBe('pearld stopping.');
    expect(sent.map((r) => [r.body.method, r.body.params])).toEqual([
      ['getblock', [genesisHash, 1]],
      ['getblock', [genesisHash, 2]],
      ['getbestblock', []],
      ['getchaintips', []],
      ['gettxspendingprevout', [[{ txid, vout: 1 }]]],
      ['decoderawtransaction', ['0102']],
      ['decodescript', ['51']],
      ['validateaddress', [address]],
      ['getcfilterheader', [genesisHash, 0]],
      ['getheaders', [[genesisHash], '']],
      ['getnetworkhashps', [120, -1]],
      ['getblocktemplate', [{ capabilities: ['coinbasevalue'] }]],
      ['submitblock', ['ab']],
      ['generate', [2]],
      ['addnode', ['127.0.0.1:18444', 'onetry']],
      ['node', ['disconnect', '7']],
      ['node', ['connect', '127.0.0.1:18444', 'temp']],
      ['stop', []],
    ]);
  });

  it('reads getblock with transaction ids, and with transactions under rawtx', async () => {
    const { client } = pearld({ getblock: (r) => (r.body.params[1] === 1 ? 'getblock-verbose' : 'getblock-transactions') });
    const block = await client.getBlock(genesisHash);
    expect(block).toMatchObject({ hash: genesisHash, height: 0, confirmations: 1, previousblockhash: '0'.repeat(64) });
    expect(block.tx).toEqual([expected('getblock-verbose', 'txid')]);
    expect(block.nextblockhash).toBeUndefined();

    const full = await client.getBlockWithTransactions(genesisHash);
    expect('tx' in full).toBe(false);
    expect(full.rawtx).toHaveLength(1);
    expect(full.rawtx[0]!.txid).toBe(block.tx[0]);
    expect(full.rawtx[0]!.vout[0]!.value).toBe(BigInt(expected('getblock-transactions', 'value') as string));
    expect(full.rawtx[0]!.vin[0]).toHaveProperty('coinbase');
  });

  it('reads the tip, chain tips and the mempool spender of an output', async () => {
    const { client } = pearld({ getbestblock: 'getbestblock', getchaintips: 'getchaintips', gettxspendingprevout: 'gettxspendingprevout' });
    expect(await client.getBestBlock()).toEqual({ hash: genesisHash, height: 0 });
    expect(await client.getChainTips()).toEqual([{ height: 0, hash: genesisHash, branchlen: 0, status: 'active' }]);
    const [spent, unspent] = await client.getTxSpendingPrevOut([
      { txid: '22'.repeat(32), vout: 1 },
      { txid, vout: 0 },
    ]);
    expect(spent!.spendingtxid).toBe(expected('gettxspendingprevout', 'spender'));
    expect(unspent).not.toHaveProperty('spendingtxid');
  });

  it('decodes transactions, scripts and addresses as pearld does', async () => {
    const { client } = pearld({
      decoderawtransaction: 'decoderawtransaction',
      decodescript: 'decodescript',
      validateaddress: (r) => (r.body.params[0] === address ? 'validateaddress' : 'validateaddress-invalid'),
    });
    const tx = await client.decodeRawTransaction('00');
    expect(tx.txid).toBe(expected('decoderawtransaction', 'txid'));
    expect(tx.vout.map((out) => String(out.value))).toEqual(expected('decoderawtransaction', 'values'));
    expect(await client.decodeScript('00')).toMatchObject({ type: 'witness_v1_taproot', address: expected('decodescript', 'address') });
    expect(await client.validateAddress(address)).toEqual({
      isvalid: true,
      address,
      iswitness: true,
      witness_version: 1,
      witness_program: expected('validateaddress', 'program'),
    });
    expect(await client.validateAddress('nope')).toEqual({ isvalid: false });
  });

  it('returns a decoded filter that matches the scripts of its block and checks its header', async () => {
    const { client, sent } = pearld({ getcfilter: 'getcfilter', getcfilterheader: 'getcfilterheader' });
    const prevHeader = expected('getcfilter', 'prevHeader') as string;
    const { filter, key, header } = await client.getCFilter(genesisHash, prevHeader);
    expect(filter.n).toBe(expected('getcfilter', 'n'));
    expect(hex(key)).toBe(hex(filterKey(genesisHash)));
    expect(matchFilter(filter, key, unhex(expected('getcfilter', 'paid') as string))).toBe(true);
    expect(matchFilter(filter, key, unhex(expected('getcfilter', 'spent') as string))).toBe(true);
    expect(matchFilter(filter, key, unhex('5120' + '99'.repeat(32)))).toBe(false);
    expect(header).toBe(await client.getCFilterHeader(genesisHash));
    expect(() => checkFilterHeaders('11'.repeat(32), [{ filter, header: header! }])).toThrow('does not match its header');
    expect(sent[0]!.body.params).toEqual([genesisHash, 0]);

    const none = pearld({ getcfilter: 'getcfilter-noindex' });
    expect((await rejection(none.client.getCFilter(genesisHash))).message).toContain('CF index must be enabled');
  });

  it('returns headers as the block serialized without its transactions', async () => {
    const { client } = pearld({ getheaders: 'getheaders' });
    const [header] = await client.getHeaders([genesisHash]);
    expect(header).toBe(expected('getheaders', 'header'));
    expect(blockHashHex(parseBlock(unhex(`${header}00`)).header)).toBe(expected('getheaders', 'hash'));
  });

  it('reads node, network, peer and mining information with fee rates in grains', async () => {
    const { client } = pearld({
      getinfo: 'getinfo',
      getnetworkinfo: 'getnetworkinfo',
      getpeerinfo: 'getpeerinfo',
      getconnectioncount: 'getconnectioncount',
      getdifficulty: 'getdifficulty',
      getnetworkhashps: 'getnetworkhashps',
      getmininginfo: 'getmininginfo',
    });
    const relayFee = BigInt(expected('getinfo', 'relayFee') as string);
    expect(await client.getInfo()).toMatchObject({ blocks: 0, connections: 3, relayfee: relayFee, testnet: false });
    const network = await client.getNetworkInfo();
    expect(network.relayfee).toBe(relayFee);
    expect(network.incrementalfee).toBe(relayFee);
    expect(network.networks.map((n) => n.name)).toEqual(['ipv4', 'ipv6', 'onion']);
    const [peer] = await client.getPeerInfo();
    expect(peer).toMatchObject({ id: 7, addr: '127.0.0.1:18444', syncnode: true, v2_connection: true, pingtime: 1500 });
    expect(peer!.feefilter).toBe(BigInt(expected('getpeerinfo', 'feeFilter') as string));
    expect(await client.getConnectionCount()).toBe(3);
    expect(await client.getDifficulty()).toBe(1);
    expect(await client.getNetworkHashPs()).toBe(0);
    expect(await client.getMiningInfo()).toMatchObject({ blocks: 0, currentblocktx: 1, generate: false, pooledtx: 2 });
  });

  it('reads a block template with its required certificate version and the coinbase value in grains', async () => {
    const { client } = pearld({ getblocktemplate: 'getblocktemplate' });
    const template = await client.getBlockTemplate();
    expect(template.requiredcertversion).toBe(3);
    expect(template.height).toBe(1);
    expect(template.previousblockhash).toBe(genesisHash);
    expect(template.coinbasevalue).toBe(BigInt(expected('getblocktemplate', 'coinbaseValue') as string));
    expect(template.transactions).toEqual([]);
  });

  it('throws for the "rejected" string submitblock returns as a result', async () => {
    const accepted = pearld({ submitblock: 'submitblock-accepted' });
    expect(await accepted.client.submitBlock('00')).toBeUndefined();

    const rejected = pearld({ submitblock: 'submitblock-rejected' });
    const err = await rejection(rejected.client.submitBlock('00'));
    expect(err).toMatchObject({ kind: 'rpc', method: 'submitblock', rpcCode: -25 });
    expect(err.message).toBe(`submitblock: rejected: already have block ${genesisHash}`);

    const undecodable = pearld({ submitblock: 'submitblock-undecodable' });
    expect(await rejection(undecodable.client.submitBlock('00'))).toMatchObject({ kind: 'rpc', rpcCode: -22 });
  });

  it('returns the hashes generate mined and its error without a mining address', async () => {
    const { client } = pearld({ generate: (r) => (r.body.params[0] === 1 ? 'generate' : 'generate-no-address') });
    expect(await client.generate(1)).toEqual([genesisHash]);
    expect((await rejection(client.generate(2))).message).toContain('--miningaddr');
  });

  it('throws when the server answers estimatefee with -1 instead of returning a negative rate', async () => {
    const { client } = pearld({ estimatefee: 'estimatefee-negative' });
    expect(await rejection(client.estimateFee(6))).toMatchObject({ kind: 'rpc', rpcCode: -1, method: 'estimatefee' });
  });
});

describe('more Oyster methods', () => {
  it('sends the params its handlers expect', async () => {
    const { client, sent } = oyster({
      sendmany: 'sendmany',
      listtransactions: 'listtransactions',
      listalltransactions: 'listalltransactions',
      listaddresstransactions: 'listaddresstransactions',
      listsinceblock: 'listsinceblock',
      gettransaction: 'gettransaction',
      getreceivedbyaddress: 'getreceivedbyaddress',
      listreceivedbyaddress: 'listreceivedbyaddress',
      getrawchangeaddress: 'getrawchangeaddress',
      lockunspent: 'lockunspent',
      listlockunspent: 'listlockunspent',
      createnewaccount: 'null',
      listaccounts: 'listaccounts',
      renameaccount: 'null',
      getaccount: 'getaccount',
      getaddressesbyaccount: 'getaddressesbyaccount',
      signrawtransaction: 'signrawtransaction',
      validateaddress: 'validateaddress-wallet',
      walletpassphrasechange: 'null',
      getinfo: 'getinfo-wallet',
      getsyncprogress: 'getsyncprogress',
      chainsynced: 'chainsynced',
      removetransaction: 'removetransaction',
      rebroadcasttransaction: 'rebroadcasttransaction',
      getbestblock: 'getbestblock-wallet',
    });
    await client.sendMany({ [address]: 150000000n }, 1000n);
    await client.sendMany({ [address]: 1n }, 2500n, { fromAccount: 'savings', minConf: 3 });
    await client.listTransactions();
    await client.listTransactions(50, 100);
    await client.listAllTransactions();
    await client.listAddressTransactions([address]);
    await client.listSinceBlock();
    await client.listSinceBlock(genesisHash, 6);
    await client.getTransaction(txid);
    await client.getReceivedByAddress(address);
    await client.listReceivedByAddress(0);
    await client.getRawChangeAddress();
    await client.lockUnspent(false, [{ txid, vout: 1 }]);
    await client.lockUnspent(true);
    await client.listLockUnspent();
    await client.createNewAccount('savings');
    await client.listAccounts();
    await client.renameAccount('savings', 'rainy day');
    await client.getAccount(address);
    await client.getAddressesByAccount('default');
    await client.signRawTransaction('00', { inputs: [{ txid, vout: 1, scriptPubKey: '51' }], sighash: 'NONE' });
    await client.validateAddress(address);
    await client.walletPassphraseChange('old', 'new');
    await client.getInfo();
    await client.getSyncProgress();
    await client.chainSynced();
    await client.removeTransaction(txid);
    await client.rebroadcastTransaction(txid);
    await client.getBestBlock();
    expect(sent.map((r) => [r.body.method, r.body.params])).toEqual([
      ['sendmany', ['default', { [address]: 1.5 }, 0.00001, 1]],
      ['sendmany', ['savings', { [address]: 1e-8 }, 0.000025, 3]],
      ['listtransactions', ['*', 10, 0]],
      ['listtransactions', ['*', 50, 100]],
      ['listalltransactions', []],
      ['listaddresstransactions', [[address]]],
      ['listsinceblock', []],
      ['listsinceblock', [genesisHash, 6]],
      ['gettransaction', [txid]],
      ['getreceivedbyaddress', [address, 1]],
      ['listreceivedbyaddress', [0]],
      ['getrawchangeaddress', []],
      ['lockunspent', [false, [{ txid, vout: 1 }]]],
      ['lockunspent', [true, []]],
      ['listlockunspent', []],
      ['createnewaccount', ['savings']],
      ['listaccounts', [1]],
      ['renameaccount', ['savings', 'rainy day']],
      ['getaccount', [address]],
      ['getaddressesbyaccount', ['default']],
      ['signrawtransaction', ['00', [{ redeemScript: '', txid, vout: 1, scriptPubKey: '51' }], [], 'NONE']],
      ['validateaddress', [address]],
      ['walletpassphrasechange', ['old', 'new']],
      ['getinfo', []],
      ['getsyncprogress', []],
      ['chainsynced', []],
      ['removetransaction', [txid]],
      ['rebroadcasttransaction', [txid]],
      ['getbestblock', []],
    ]);
    // The exact digits, not a float's: one grain is 0.00000001.
    expect(sent[1]!.text).toContain(':0.00000001}');
  });

  it('reads transaction lists with sends and their fees as negative grains', async () => {
    const { client } = oyster({
      listtransactions: 'listtransactions',
      listalltransactions: 'listalltransactions',
      listaddresstransactions: 'listaddresstransactions',
      listsinceblock: 'listsinceblock',
    });
    const want = (key: string) => BigInt(expected('listtransactions', key) as string);
    const [send, receive, immature] = await client.listTransactions();
    expect(send).toMatchObject({ category: 'send', amount: want('sent'), fee: want('fee'), confirmations: 6, account: '' });
    expect(send!.amount).toBeLessThan(0n);
    expect(send!.fee).toBeLessThan(0n);
    expect(receive).toMatchObject({ category: 'receive', amount: want('received'), confirmations: 0, account: 'default' });
    expect(receive).not.toHaveProperty('fee');
    expect(receive).not.toHaveProperty('blockhash');
    expect(immature).toMatchObject({ category: 'immature', amount: want('immature'), generated: true });
    expect(await client.listAllTransactions()).toEqual([send, receive, immature]);
    expect(await client.listAddressTransactions([address])).toEqual([receive, immature]);
    expect(await client.listSinceBlock()).toEqual({ transactions: [send, receive, immature], lastblock: genesisHash });
  });

  it('reads gettransaction, whose fee is positive and whose send detail is negative', async () => {
    const { client } = oyster({ gettransaction: (r) => (r.body.params[0] === txid ? 'gettransaction' : 'gettransaction-missing') });
    const want = (key: string) => BigInt(expected('gettransaction', key) as string);
    const tx = await client.getTransaction(txid);
    expect(tx.amount).toBe(want('amount'));
    expect(tx.fee).toBe(want('fee'));
    expect(tx.details[0]).toMatchObject({ category: 'send', amount: want('debit'), fee: want('fee') });
    expect(tx.details[1]).toMatchObject({ category: 'receive', amount: want('amount'), vout: 1, address });
    expect(await rejection(client.getTransaction('00'.repeat(32)))).toMatchObject({ kind: 'rpc', rpcCode: -5 });
  });

  it('reads balances by account, whatever the accounts are called', async () => {
    const { client } = oyster({ listaccounts: 'listaccounts' });
    const accounts = await client.listAccounts();
    expect(Object.fromEntries(Object.entries(accounts).map(([name, grain]) => [name, String(grain)]))).toEqual(fixture('listaccounts').expect);
    expect(accounts.id).toBe(1n);
  });

  it('reads the remaining wallet results', async () => {
    const { client } = oyster({
      getreceivedbyaddress: 'getreceivedbyaddress',
      listreceivedbyaddress: 'listreceivedbyaddress',
      lockunspent: 'lockunspent',
      listlockunspent: 'listlockunspent',
      signrawtransaction: 'signrawtransaction',
      validateaddress: (r) => (r.body.params[0] === address ? 'validateaddress-wallet' : 'validateaddress-wallet-invalid'),
      getinfo: 'getinfo-wallet',
      getsyncprogress: 'getsyncprogress',
      chainsynced: 'chainsynced',
      removetransaction: 'removetransaction',
      rebroadcasttransaction: 'rebroadcasttransaction',
      createnewaccount: 'null',
      sendmany: 'sendmany',
    });
    const received = BigInt(expected('getreceivedbyaddress', 'amount') as string);
    expect(await client.getReceivedByAddress(address)).toBe(received);
    expect(await client.listReceivedByAddress()).toEqual([{ account: '', address, amount: received, confirmations: 6, txids: ['ab'.repeat(32)] }]);
    expect(await client.lockUnspent(false, [{ txid, vout: 0 }])).toBe(true);
    expect(await client.listLockUnspent()).toEqual([{ txid: 'ab'.repeat(32), vout: 1 }]);
    expect(await client.signRawTransaction('00')).toMatchObject({ complete: false, errors: [{ vout: 1, error: 'no key for input' }] });
    expect(await client.validateAddress(address)).toMatchObject({ isvalid: true, ismine: true, account: 'default' });
    expect(await client.validateAddress('nope')).toEqual({ isvalid: false });
    const info = await client.getInfo();
    expect(info.balance).toBe(BigInt(expected('getinfo-wallet', 'balance') as string));
    expect(info.relayfee).toBe(BigInt(expected('getinfo-wallet', 'relayFee') as string));
    // Oyster writes this one as a bare number of grains.
    expect(info.paytxfee).toBe(expected('getinfo-wallet', 'payTxFee'));
    expect(await client.getSyncProgress()).toMatchObject({ header_height: 321, block_height: 319, synced: false });
    expect(await client.chainSynced()).toBe(true);
    expect(await client.removeTransaction(txid)).toEqual(['ab'.repeat(32)]);
    expect(await client.rebroadcastTransaction(txid)).toEqual(['ab'.repeat(32)]);
    expect(await client.createNewAccount('x')).toBeUndefined();
    expect(await client.sendMany({ [address]: 1n }, 1000n)).toBe('ab'.repeat(32));
  });

  it('offers the desktop wallet Oyster as a preset on loopback without TLS', async () => {
    const fake = fakeFetch({ chainsynced: 'chainsynced' });
    const client = desktopOysterClient({ username: 'u', password: 'p' }, { fetch: fake.fetch });
    await client.chainSynced();
    expect(DESKTOP_OYSTER_URL).toBe('http://127.0.0.1:8335');
    expect(fake.sent[0]!.url).toBe('http://127.0.0.1:8335/');
    expect(new Headers(fake.sent[0]!.init.headers).get('Authorization')).toBe(`Basic ${btoa('u:p')}`);
  });
});

describe('typed methods over any transport', () => {
  it('runs pearld and Oyster methods over anything with call, adding options to every call', async () => {
    const calls: unknown[][] = [];
    const rpc = {
      async call<T>(method: string, params: readonly unknown[] = [], options = {}): Promise<T> {
        calls.push([method, params, options]);
        return (method === 'getblockcount' ? 321 : 1234567800n) as T;
      },
    };
    const controller = new AbortController();
    expect(await new PearldRpc(rpc, { signal: controller.signal, timeout: 5 }).getBlockCount()).toBe(321);
    expect(await new OysterRpc(rpc).getBalance()).toBe(1234567800n);
    expect(calls).toEqual([
      ['getblockcount', [], { signal: controller.signal, timeout: 5 }],
      ['getbalance', ['*', 1], { amounts: ['result'] }],
    ]);
  });

  it('reaches pearld through Oyster with the node methods over an OysterClient', async () => {
    const { client, sent } = oyster({ gettxout: 'gettxout' });
    const out = await new PearldRpc(client).getTxOut(txid, 0);
    expect(out!.value).toBe(BigInt(expected('gettxout', 'value') as string));
    expect(sent[0]!.url).toBe('https://127.0.0.1:18332/');
  });
});

describe('transport options', () => {
  const never = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;

  it('gives up after the client timeout, or the one given for a call', async () => {
    const client = new PearldClient({ url: 'https://127.0.0.1:18334', fetch: never, timeout: 20 });
    const err = await rejection(client.getBlockCount());
    expect(err).toMatchObject({ kind: 'network', method: 'getblockcount' });
    expect(err.message).toBe('getblockcount: no reply from 127.0.0.1:18334 within 20 ms');

    const slow = new PearldClient({ url: 'https://127.0.0.1:18334', fetch: never });
    expect((await rejection(slow.call('getblockcount', [], { timeout: 10 }))).message).toContain('within 10 ms');
  });

  it('applies a default timeout, except to calls that are slow by design', async () => {
    vi.useFakeTimers();
    try {
      const client = new PearldClient({ url: 'https://127.0.0.1:18334', fetch: never });
      const outcomes: string[] = [];
      void client.getBlockCount().catch((e: Error) => outcomes.push(e.message));
      void client.generate(1).catch((e: Error) => outcomes.push(e.message));
      await vi.advanceTimersByTimeAsync(59_999);
      expect(outcomes).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(outcomes).toEqual(['getblockcount: no reply from 127.0.0.1:18334 within 60000 ms']);
      await vi.advanceTimersByTimeAsync(3_600_000);
      expect(outcomes).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('abandons a call when its signal aborts, and passes a signal to fetch', async () => {
    let seen: AbortSignal | undefined;
    const hanging = ((_url: string, init: RequestInit) => {
      seen = init.signal ?? undefined;
      return new Promise<Response>(() => {});
    }) as unknown as typeof fetch;
    const client = new PearldClient({ url: 'https://127.0.0.1:18334', fetch: hanging });
    const controller = new AbortController();
    const call = rejection(client.call('getblockcount', [], { signal: controller.signal }));
    controller.abort();
    expect((await call).message).toBe('getblockcount: request to 127.0.0.1:18334 was aborted');
    expect(seen!.aborted).toBe(true);

    const already = await rejection(new PearldRpc(client, { signal: AbortSignal.abort() }).getBlockCount());
    expect(already.kind).toBe('network');
  });

  it('keeps the password out of the error for a malformed URL', () => {
    let error: unknown;
    try {
      new PearldClient({ url: 'https://alice:hunter2@127.0.0.1:port' });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(TypeError);
    expect(JSON.stringify([String(error), (error as Error).cause ?? null, Object.values(error as object)])).not.toContain('hunter2');
  });

  it('refuses basic auth over plain http to another host unless told to', async () => {
    const options = { username: 'alice', password: 'pw', fetch: never };
    for (const url of ['http://node.example:44107', 'http://10.0.0.5:44107', 'http://alice:pw@192.168.1.9:44107']) {
      expect(() => new PearldClient({ ...options, url })).toThrow('refusing to send the RPC password');
    }
    for (const url of ['http://127.0.0.1:44107', 'http://localhost:44107', 'http://[::1]:44107', 'http://127.8.9.1:1', 'https://node.example:44107']) {
      expect(() => new PearldClient({ ...options, url })).not.toThrow();
    }
    expect(() => new PearldClient({ url: 'http://node.example:44107', fetch: never })).not.toThrow();
    const fake = fakeFetch({ getblockcount: 'getblockcount' });
    const client = new PearldClient({ ...options, fetch: fake.fetch, url: 'http://node.example:44107', allowInsecureAuth: true });
    expect(await client.getBlockCount()).toBe(321);
  });

  it('sends calls made together as one batch and gives each its own result or error', async () => {
    const bodies: string[] = [];
    const batching = (async (_url: string, init: RequestInit) => {
      bodies.push(init.body as string);
      return new Response(fixture('batch').body, { status: 200 });
    }) as unknown as typeof fetch;
    const client = new PearldClient({ url: 'https://127.0.0.1:18334', fetch: batching, batch: true });
    const results = await Promise.allSettled([
      client.getBlockCount(),
      client.getBestBlockHash(),
      client.getBlock('77'.repeat(32)),
      client.getInfo(),
      client.call('frobnicate'),
    ]);
    expect(bodies).toHaveLength(1);
    expect((JSON.parse(bodies[0]!) as { method: string; id: number }[]).map((r) => [r.id, r.method])).toEqual([
      [1, 'getblockcount'],
      [2, 'getbestblockhash'],
      [3, 'getblock'],
      [4, 'getinfo'],
      [5, 'frobnicate'],
    ]);
    expect(results[0]).toEqual({ status: 'fulfilled', value: 0 });
    expect(results[1]).toEqual({ status: 'fulfilled', value: expected('batch', 'hash') });
    expect((results[2] as PromiseRejectedResult).reason).toMatchObject({ kind: 'rpc', rpcCode: -5, method: 'getblock' });
    // The amount conversion asked for by one call does not touch the others.
    expect((results[3] as PromiseFulfilledResult<{ relayfee: bigint }>).value.relayfee).toBe(BigInt(expected('batch', 'relayFee') as string));
    expect((results[4] as PromiseRejectedResult).reason).toMatchObject({ kind: 'rpc', rpcCode: -32601, method: 'frobnicate' });
  });

  it('sends a lone call, and a call with its own signal, outside a batch', async () => {
    const fake = fakeFetch({ getblockcount: 'getblockcount', getbestblockhash: 'getbestblockhash' });
    const client = new PearldClient({ url: 'https://127.0.0.1:18334', fetch: fake.fetch, batch: { wait: 1 } });
    expect(await client.getBlockCount()).toBe(321);
    expect(fake.sent[0]!.text.startsWith('{')).toBe(true);
    await Promise.all([client.getBlockCount(), client.call('getbestblockhash', [], { signal: new AbortController().signal })]);
    expect(fake.sent).toHaveLength(3);
  });

  it('fails every call of a batch the server could not read or answered short', async () => {
    const answer = (body: string) =>
      new PearldClient({ url: 'https://127.0.0.1:18334', fetch: (async () => new Response(body)) as unknown as typeof fetch, batch: true });
    const unreadable = answer(fixture('batch-unreadable').body);
    const failures = await Promise.all([rejection(unreadable.getBlockCount()), rejection(unreadable.getBestBlockHash())]);
    expect(failures.map((e) => [e.kind, e.rpcCode, e.method])).toEqual([
      ['rpc', -32700, 'getblockcount'],
      ['rpc', -32700, 'getbestblockhash'],
    ]);

    const short = answer('[{"jsonrpc":"1.0","result":7,"error":null,"id":1}]');
    const [first, second] = await Promise.allSettled([short.getBlockCount(), short.getBestBlockHash()]);
    expect(first).toEqual({ status: 'fulfilled', value: 7 });
    expect((second as PromiseRejectedResult).reason.message).toContain('left this call out of its batch reply');

    const single = answer(fixture('getblockcount').body);
    const both = await Promise.all([rejection(single.getBlockCount()), rejection(single.getBestBlockHash())]);
    expect(both.map((e) => e.kind)).toEqual(['response', 'response']);
  });

  it('refuses batching for Oyster, which reads one request per POST', () => {
    expect(() => new OysterClient({ url: 'https://127.0.0.1:18332', batch: true } as never)).toThrow('does not accept JSON-RPC batches');
  });

  it('retries read-only calls after a transient failure, and never a send', async () => {
    let attempts = 0;
    const flaky = (async (_url: string, init: RequestInit) => {
      attempts++;
      const { id, method } = JSON.parse(init.body as string) as { id: number; method: string };
      if (attempts < 3) {
        if (attempts === 1) throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) });
        return new Response('busy', { status: 503 });
      }
      const name = method === 'getblockcount' ? 'getblockcount' : 'sendrawtransaction';
      return new Response(fixture(name).body.replace(/"id":\d+}/, `"id":${id}}`));
    }) as unknown as typeof fetch;
    const client = new PearldClient({ url: 'https://127.0.0.1:18334', fetch: flaky, retry: { retries: 2, delay: 1 } });
    expect(await client.getBlockCount()).toBe(321);
    expect(attempts).toBe(3);

    attempts = 0;
    expect((await rejection(client.sendRawTransaction('00'))).kind).toBe('network');
    expect(attempts).toBe(1);

    attempts = 0;
    const once = new PearldClient({ url: 'https://127.0.0.1:18334', fetch: flaky, retry: { retries: 1, delay: 1 } });
    expect(await rejection(once.getBlockCount())).toMatchObject({ kind: 'http', status: 503 });
    expect(attempts).toBe(2);

    attempts = 0;
    const plain = new PearldClient({ url: 'https://127.0.0.1:18334', fetch: flaky });
    await rejection(plain.getBlockCount());
    expect(attempts).toBe(1);
  });

  it('does not retry an RPC error or a refused password', async () => {
    let attempts = 0;
    const refusing = (async () => {
      attempts++;
      return attempts === 1 ? new Response('', { status: 401 }) : new Response(fixture('method-not-found').body.replace(/"id":\d+}/, '"id":2}'));
    }) as unknown as typeof fetch;
    const client = new PearldClient({ url: 'https://127.0.0.1:18334', fetch: refusing, retry: 5 });
    expect((await rejection(client.getBlockCount())).status).toBe(401);
    expect((await rejection(client.getBlockCount())).rpcCode).toBe(-32601);
    expect(attempts).toBe(2);
  });

  it('falls back to the next server when one cannot be reached, and stays put on an RPC error', async () => {
    const down = (async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) });
    }) as unknown as typeof fetch;
    const up = fakeFetch({ getblockcount: 'getblockcount', getrawtransaction: 'getrawtransaction-missing' });
    const transport = fallbackTransport([
      httpTransport({ url: 'https://a.example:44107', username: 'a', password: 'x', fetch: down }),
      httpTransport({ url: 'https://b.example:44107', username: 'b', password: 'y', fetch: up.fetch }),
    ]);
    const client = new PearldClient({ transport });
    expect(await client.getBlockCount()).toBe(321);
    expect(up.sent[0]!.url).toBe('https://b.example:44107/');
    expect(new Headers(up.sent[0]!.init.headers).get('Authorization')).toBe(`Basic ${btoa('b:y')}`);
    expect(await rejection(client.getRawTransaction(txid))).toMatchObject({ kind: 'rpc', rpcCode: -5 });

    const answering = fakeFetch({ getrawtransaction: 'getrawtransaction-missing' });
    const never2 = fakeFetch({});
    const first = new PearldClient({
      transport: fallbackTransport([
        httpTransport({ url: 'https://a.example:44107', fetch: answering.fetch }),
        httpTransport({ url: 'https://b.example:44107', fetch: never2.fetch }),
      ]),
    });
    await rejection(first.getRawTransaction(txid));
    expect(never2.sent).toHaveLength(0);

    const allDown = new PearldClient({
      transport: fallbackTransport([httpTransport({ url: 'https://a.example:1', fetch: down }), httpTransport({ url: 'https://b.example:2', fetch: down })]),
    });
    expect((await rejection(allDown.getBlockCount())).message).toContain('connection refused by b.example:2');
    expect(() => fallbackTransport([])).toThrow('at least one transport');
    expect(() => new PearldClient({ url: 'https://a.example', transport })).toThrow('either url or transport');
  });
});

describe('address paging', () => {
  it('stops with an error when the server ignores skip instead of looping forever', async () => {
    let requests = 0;
    const client = {
      async searchRawTransactions() {
        requests++;
        const page = JSON.parse(fixture('searchrawtransactions').body) as { result: { txid: string; blockhash?: string }[] };
        return [page.result[0]] as never;
      },
    };
    const err = await rejection(searchAllTransactions(client, address, { pageSize: 1 }));
    expect(err).toMatchObject({ kind: 'response', method: 'searchrawtransactions' });
    expect(err.message).toContain('does not honor skip');
    expect(requests).toBe(2);
  });

  it('gives up after maxPages requests', async () => {
    let n = 0;
    const client = {
      async searchRawTransactions() {
        return [{ txid: String(n++), blockhash: 'aa', vin: [], vout: [] }] as never;
      },
    };
    const err = await rejection(searchAllTransactions(client, address, { pageSize: 1, maxPages: 5 }));
    expect(err.message).toContain('more than 5 pages');
    expect(n).toBe(5);
  });

  it('refuses a page size pearld would not honor', async () => {
    const { client } = pearld({});
    for (const pageSize of [0, -1, 1.5, 10001, Number.NaN]) {
      await expect(searchAllTransactions(client, address, { pageSize })).rejects.toThrow('pageSize must be an integer from 1 to 10000');
      await expect(pearldChainClient(client, { pageSize }).getAddressActivity(address)).rejects.toThrow(RangeError);
    }
  });

  it('does not take a missing transaction index for an unknown transaction', async () => {
    const { client } = pearld({ getrawtransaction: 'getrawtransaction-noindex' });
    const err = await rejection(pearldChainClient(client).getTransaction(txid));
    expect(err).toMatchObject({ kind: 'rpc', rpcCode: -5 });
    expect(err.message).toContain('transaction index must be enabled');
  });

  it('refuses a tip height that is not a block height', async () => {
    const bad = fixture('getblockchaininfo').body.replace('"blocks":321', '"blocks":3.5');
    const { client } = pearld({ getblockchaininfo: (r) => new Response(bad.replace(/"id":\d+}/, `"id":${r.body.id}}`)) });
    expect((await rejection(pearldChainClient(client).getTip())).message).toContain('expected a block height, got 3.5');
  });
});
