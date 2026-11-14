// The pearld and Oyster RPC clients against reply bodies written by Pearl's own
// handlers and btcjson types (vectors/rpcfixtures_test.go), through an injected
// fetch. The expected grain values come from the same Go program.

import { describe, expect, it } from 'vitest';
import {
  JsonRpcClient,
  OysterClient,
  PearlRpcError,
  PearldClient,
  blockHashHex,
  createInvoice,
  decimalToGrain,
  decodeWif,
  keyPathAddress,
  networks,
  parseBlock,
  parseTransaction,
  pearldChainClient,
  refreshInvoice,
  verifyMessage,
} from '../src/index.js';
import fixtureFile from './fixtures/rpc-responses.json' with { type: 'json' };

interface Fixture {
  body: string;
  expect?: Record<string, unknown>;
}
const fixtures = fixtureFile as Record<string, Fixture>;
const fixture = (name: string): Fixture => {
  const found = fixtures[name];
  if (found === undefined) throw new Error(`missing fixture ${name}`);
  return found;
};
const expected = (name: string, key: string) => fixture(name).expect![key];

interface SentRequest {
  url: string;
  init: RequestInit & Record<string, unknown>;
  body: { jsonrpc: string; id: number; method: string; params: unknown[] };
  text: string;
}

type Route = string | Response | ((request: SentRequest) => string | Response);

/** A fetch that answers each method from a fixture, with the reply id set to the request's. */
function fakeFetch(routes: Record<string, Route>) {
  const sent: SentRequest[] = [];
  const fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const text = init.body as string;
    const request = { url: String(input), init, body: JSON.parse(text), text } as SentRequest;
    sent.push(request);
    const route = routes[request.body.method];
    if (route === undefined) throw new Error(`unexpected method ${request.body.method}`);
    const answer = typeof route === 'function' ? route(request) : route;
    if (answer instanceof Response) return answer;
    const body = fixture(answer).body.replace(/"id":\d+}\n$/, `"id":${request.body.id}}\n`);
    return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return { fetch: fetch as typeof globalThis.fetch, sent };
}

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

async function rejection(promise: Promise<unknown>): Promise<PearlRpcError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(PearlRpcError);
    return err as PearlRpcError;
  }
  throw new Error('expected the call to fail');
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

  it('writes bigint grain params as exact PRL numbers', async () => {
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
    expect(missing).toMatchObject({ kind: 'rpc', code: -5, method: 'getrawtransaction', status: undefined });
    expect(missing.message).toBe(`getrawtransaction: No information available about transaction ${txid} (code -5)`);
    expect(await rejection(client.call('frobnicate'))).toMatchObject({ kind: 'rpc', code: -32601 });
  });

  it('maps pearld and Oyster refusals to their codes', async () => {
    const node = pearld({
      sendrawtransaction: 'sendrawtransaction-rejected',
      estimatefee: 'estimatefee-unavailable',
      stop: 'limited-user',
    });
    const rejected = await rejection(node.client.sendRawTransaction('00'));
    expect(rejected.code).toBe(-26);
    expect(rejected.message).toContain('TX rejected: transaction version 3 is not standard');
    expect((await rejection(node.client.estimateFee(6))).code).toBe(-1);
    expect((await rejection(node.client.call('stop'))).code).toBe(-32603);

    const wallet = oyster({ sendtoaddress: 'wallet-locked', walletlock: 'wallet-unsupported', getbalance: 'wallet-error' });
    expect((await rejection(wallet.client.sendToAddress(address, 1n, 1000n))).code).toBe(-13);
    expect((await rejection(wallet.client.walletLock())).code).toBe(-1);
    expect((await rejection(wallet.client.getBalance())).code).toBe(-4);
  });

  it('names a 401 as rejected credentials', async () => {
    const { client } = pearld({
      getblockcount: () => new Response('401 Unauthorized.\n', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="pearld RPC"' } }),
    });
    const err = await rejection(client.getBlockCount());
    expect(err).toMatchObject({ kind: 'http', status: 401, code: undefined });
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
    expect(err).toMatchObject({ kind: 'network', code: undefined, status: undefined });
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
    const chain = pearldChainClient(client, 2);
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
            ? { result: null, error: { code: -5, message: 'No information available about address' } }
            : { result: listed, error: null };
        return new Response(JSON.stringify({ ...reply, id: r.body.id }));
      },
    });
    for (const pageSize of [1, 2, 3, 4, 7, 8, 100]) {
      const activity = await pearldChainClient(client, pageSize).getAddressActivity(address);
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
    });
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
