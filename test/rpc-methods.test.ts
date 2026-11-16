// The node administration and account methods typed last, against bodies
// from pearld's handlers and Oyster's btcjson types
// (vectors/rpcfixtures_test.go), and pearljs's method list checked against
// the handler tables the same program reads out of Pearl: a method Pearl adds
// shows up here as a failure when the fixtures are regenerated.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  OysterClient,
  PEARLD_LIMITED_METHODS,
  PearldClient,
  networks,
  parseTransaction,
  toOutputScript,
  transactionId,
} from '../src/index.js';
import { expected, fakeFetch, fixture, rejection, type Route } from './rpc-helpers.js';

function pearld(routes: Record<string, Route>) {
  const fake = fakeFetch(routes);
  return { client: new PearldClient({ url: 'https://127.0.0.1:18334', fetch: fake.fetch }), sent: fake.sent };
}

function oyster(routes: Record<string, Route>) {
  const fake = fakeFetch(routes);
  return { client: new OysterClient({ url: 'https://127.0.0.1:18332', fetch: fake.fetch }), sent: fake.sent };
}

const params = (sent: { body: { method: string; params: unknown[] } }[]) => sent.map((s) => [s.body.method, s.body.params]);

describe('pearld administration methods', () => {
  it('invalidates and reconsiders blocks, and reports pearld refusing a hash it does not know', async () => {
    const { client, sent } = pearld({ invalidateblock: 'null', reconsiderblock: 'reconsiderblock-unknown' });
    await client.invalidateBlock('ab'.repeat(32));
    expect(await rejection(client.reconsiderBlock('77'.repeat(32)))).toMatchObject({ kind: 'rpc', rpcCode: -32600 });
    expect(params(sent)).toEqual([['invalidateblock', ['ab'.repeat(32)]], ['reconsiderblock', ['77'.repeat(32)]]]);
  });

  it('reads byte counts as bigint, exact past 2^53', async () => {
    const { client } = pearld({ getnettotals: 'getnettotals' });
    const totals = await client.getNetTotals();
    expect(totals.totalbytessent).toBe(BigInt(expected('getnettotals', 'sent') as string));
    expect(totals.totalbytesrecv).toBe(BigInt(expected('getnettotals', 'received') as string));
    expect(totals.timemillis).toBe(1767225600123);
  });

  it('reads uptime, version and the network magic', async () => {
    const { client } = pearld({ uptime: 'uptime', version: 'version', getcurrentnet: 'getcurrentnet' });
    expect(await client.uptime()).toBe(86400);
    expect((await client.version()).pearldjsonrpcapi).toMatchObject({ versionstring: expect.any(String), major: expect.any(Number) });
    expect(await client.getCurrentNet()).toBe(networks.regtest.magic);
    expect(await client.getCurrentNet()).toBe(expected('getcurrentnet', 'net'));
  });

  it('lists known and added peers, with service flags as bigint', async () => {
    const { client, sent } = pearld({
      getnodeaddresses: 'getnodeaddresses',
      getaddednodeinfo: (r) => (r.body.params[0] === true ? 'getaddednodeinfo-dns' : 'getaddednodeinfo-none'),
    });
    const [address] = await client.getNodeAddresses(5);
    expect(address).toEqual({ time: 1767225600, services: BigInt(expected('getnodeaddresses', 'services') as string), address: '203.0.113.7', port: 44108 });
    expect(await client.getAddedNodeInfo(false)).toEqual([]);
    const [added] = await client.getAddedNodeInfo(true, 'node.example:44108');
    expect(added).toEqual({ addednode: 'node.example:44108', connected: true, addresses: [{ address: '203.0.113.7:44108', connected: 'outbound' }] });
    expect(params(sent)).toEqual([['getnodeaddresses', [5]], ['getaddednodeinfo', [false]], ['getaddednodeinfo', [true, 'node.example:44108']]]);
  });

  it('pings, verifies the chain, and drives the built-in miner', async () => {
    const { client, sent } = pearld({
      ping: 'ping',
      verifychain: 'verifychain',
      getgenerate: 'getgenerate',
      setgenerate: (r) => (r.body.params[0] === true ? 'setgenerate-no-address' : 'setgenerate-off'),
    });
    await client.ping();
    expect(await client.verifyChain(3, 1)).toBe(true);
    expect(await client.getGenerate()).toBe(false);
    await client.setGenerate(false);
    expect((await rejection(client.setGenerate(true, 1))).message).toContain('--miningaddr');
    expect(params(sent).slice(1)).toEqual([['verifychain', [3, 1]], ['getgenerate', []], ['setgenerate', [false]], ['setgenerate', [true, 1]]]);
  });

  it('signs with a WIF in the node and refuses a malformed one', async () => {
    const { client, sent } = pearld({ signmessagewithprivkey: (r) => (r.body.params[0] === 'notawif' ? 'signmessagewithprivkey-bad-key' : 'signmessagewithprivkey') });
    const wif = expected('signmessagewithprivkey', 'wif') as string;
    const signature = await client.signMessageWithPrivKey(wif, 'pearljs');
    expect(atob(signature)).toHaveLength(65);
    expect(await rejection(client.signMessageWithPrivKey('notawif', 'pearljs'))).toMatchObject({ rpcCode: -5 });
    expect(sent[0]!.body.params).toEqual([wif, 'pearljs']);
  });

  it('sets log levels and returns what pearld answers', async () => {
    const { client } = pearld({ debuglevel: (r) => (r.body.params[0] === 'show' ? 'debuglevel-show' : 'debuglevel-invalid') });
    expect(await client.debugLevel('show')).toMatch(/^Supported subsystems/);
    expect(await rejection(client.debugLevel('nosuchsubsystem=trace'))).toMatchObject({ rpcCode: -32602 });
  });

  it('creates a raw transaction with amounts sent as exact PRL', async () => {
    const { client, sent } = pearld({ createrawtransaction: 'createrawtransaction' });
    const address = expected('createrawtransaction', 'address') as string;
    const txid = expected('createrawtransaction', 'txid') as string;
    const amount = BigInt(expected('createrawtransaction', 'amount') as string);
    const hex = await client.createRawTransaction([{ txid, vout: 1 }], { [address]: amount }, 500);
    expect(sent[0]!.text).toContain(`{"${address}":1.50000001}`);
    expect(sent[0]!.body.params).toEqual([[{ txid, vout: 1 }], { [address]: 1.50000001 }, 500]);
    const tx = parseTransaction(hex);
    expect(tx.locktime).toBe(expected('createrawtransaction', 'locktime'));
    expect(tx.ins[0]!.sequence).toBe(0xfffffffe);
    expect(Buffer.from(tx.ins[0]!.hash).reverse().toString('hex')).toBe(txid);
    expect(tx.outs).toHaveLength(1);
    expect(tx.outs[0]!.value).toBe(amount);
    expect(Buffer.from(tx.outs[0]!.script)).toEqual(Buffer.from(toOutputScript(address, networks.regtest)));
    expect(transactionId(tx)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('Oyster account methods', () => {
  it('sends from an account with the amount and fee rate as exact PRL', async () => {
    const { client, sent } = oyster({ sendfrom: 'sendfrom' });
    expect(await client.sendFrom('default', 'rprl1pexample', 150000001n, 1000n, 2)).toBe('ab'.repeat(32));
    expect(sent[0]!.text).toContain('"params":["default","rprl1pexample",1.50000001,0.00001,2]');
  });

  it('accepts settxfee and keypoolrefill, which change nothing in Oyster', async () => {
    const { client, sent } = oyster({ settxfee: 'settxfee', keypoolrefill: 'keypoolrefill' });
    expect(await client.setTxFee(2000n)).toBe(true);
    await client.keypoolRefill();
    await client.keypoolRefill(200);
    expect(params(sent)).toEqual([['settxfee', [0.00002]], ['keypoolrefill', []], ['keypoolrefill', [200]]]);
  });

  it('reads an account address and what each account received, in grains', async () => {
    const { client, sent } = oyster({
      getaccountaddress: 'getaccountaddress',
      getreceivedbyaccount: 'getreceivedbyaccount',
      listreceivedbyaccount: 'listreceivedbyaccount',
      getblockcount: 'getblockcount',
      getbestblockhash: 'getbestblockhash',
    });
    expect(await client.getAccountAddress('default')).toMatch(/^rprl1p/);
    const amount = BigInt(expected('getreceivedbyaccount', 'amount') as string);
    expect(await client.getReceivedByAccount('default', 6)).toBe(amount);
    expect(await client.listReceivedByAccount()).toEqual([
      { account: 'default', amount, confirmations: 6 },
      { account: 'imported', amount: 0n, confirmations: 0 },
    ]);
    expect(await client.getBlockCount()).toBe(321);
    expect(await client.getBestBlockHash()).toMatch(/^[0-9a-f]{64}$/);
    expect(params(sent).slice(0, 3)).toEqual([['getaccountaddress', ['default']], ['getreceivedbyaccount', ['default', 6]], ['listreceivedbyaccount', [1]]]);
  });
});

// Every method pearljs types, read from the source: the first argument of
// each `this.call` in a mixin, and the commands the websocket client sends.
function typedMethods(): { pearld: Set<string>; oyster: Set<string> } {
  const rpc = readFileSync(new URL('../src/rpc.ts', import.meta.url), 'utf8');
  const ws = readFileSync(new URL('../src/ws.ts', import.meta.url), 'utf8');
  const calls = (text: string) => new Set([...text.matchAll(/this\.call(?:<[^(]*>)?\(\s*'([a-z]+)'/g)].map((m) => m[1]!));
  const pearldPart = rpc.slice(rpc.indexOf('export function pearldMethods'), rpc.indexOf('export function oysterMethods'));
  const oysterPart = rpc.slice(rpc.indexOf('export function oysterMethods'), rpc.indexOf('/** Typed methods for pearld over fetch. */'));
  const sent = new Set([...ws.matchAll(/'((?:stop)?notify\w+|authenticate|session|loadtxfilter|rescan|rescanblocks)'/g)].map((m) => m[1]!));
  return { pearld: new Set([...calls(pearldPart), ...calls(ws), ...sent]), oyster: calls(oysterPart) };
}

const tables = fixture('handler-tables').expect as Record<'pearld' | 'websocket' | 'limited' | 'oyster' | 'oysterRefused', string[]>;

// Methods pearljs leaves untyped on purpose, with the reason; `call` reaches
// each of them. A method Pearl adds fails the tests below until it is typed
// or pinned here.
const UNTYPED_PEARLD: Record<string, string> = {
  help: 'text for people, not for programs',
};
const UNTYPED_OYSTER: Record<string, string> = {
  help: 'text for people, not for programs',
};

describe('method coverage', () => {
  it('types every method pearld dispatches, but for the ones pinned here', () => {
    const { pearld } = typedMethods();
    const served = [...new Set([...tables.pearld, ...tables.websocket])];
    const untyped = served.filter((method) => !pearld.has(method)).sort();
    expect(untyped).toEqual(Object.keys(UNTYPED_PEARLD).sort());
    // And nothing typed that pearld does not serve; authenticate it handles before the table.
    expect([...pearld].filter((method) => !served.includes(method)).sort()).toEqual(['authenticate']);
  });

  it('types every method Oyster implements, but for the ones pinned here', () => {
    const { oyster } = typedMethods();
    const implemented = tables.oyster;
    expect(implemented.filter((method) => !oyster.has(method)).sort()).toEqual(Object.keys(UNTYPED_OYSTER).sort());
    // Oyster answers these with "unimplemented" or "unsupported"; none is typed.
    expect(tables.oysterRefused.filter((method) => oyster.has(method))).toEqual([]);
    // Oyster's typed methods are its own, apart from stop, which its server handles before the table.
    expect([...oyster].filter((method) => !implemented.includes(method)).sort()).toEqual(['stop']);
  });

  it('agrees with pearld on what its limited user may call', () => {
    expect([...PEARLD_LIMITED_METHODS].sort()).toEqual(tables.limited);
  });
});
