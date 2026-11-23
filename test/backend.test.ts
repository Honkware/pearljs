// The wallet backends over pearld's address index and over Oyster, against
// reply bodies from Pearl's own code (backendFixtures in
// vectors/rpcfixtures_test.go) for one wallet history seen both ways.

import { describe, expect, it } from 'vitest';
import {
  MissingIndexError,
  OYSTER_DEFAULT_FEE_RATE,
  PEARLD_LIMITED_METHODS,
  PearldClient,
  UnsupportedMethodError,
  probePearld,
  PearlRpcError,
  assembleScriptTree,
  blockHash,
  blockHashHex,
  buildFilter,
  checksigScript,
  createInvoice,
  filterBackend,
  encodeFilter,
  filterKey,
  fromOutputScript,
  networks,
  p2mr,
  oysterBackend,
  pearldBackend,
  refreshInvoice,
  serializeBlockHeader,
  spendableUtxos,
  sumBalance,
  toOutputScript,
  type PearlBlockHeader,
} from '../src/index.js';
import {
  blockHeights,
  change0,
  grain,
  indexedPearld,
  network,
  receive0,
  receive1,
  receive2,
  scenarioOyster,
  tipHeight,
  txids,
} from './backend-helpers.js';
import { expected, fakeFetch, fixture, rejection, type Route } from './rpc-helpers.js';

const outpoints = (utxos: { txid: string; vout: number }[]) => utxos.map((u) => `${u.txid}:${u.vout}`).sort();
const heightOf = (confirmations: number) => tipHeight - confirmations + 1;

describe('pearld backend', () => {
  it('says a refusal from pearld or Oyster is final, and from filterBackend\'s node is not', async () => {
    const { client } = indexedPearld();
    expect(pearldBackend(client, { network }).broadcastRefusalsFinal).toBe(true);
    expect(oysterBackend(client, { network }).broadcastRefusalsFinal).toBe(true);
    expect(filterBackend(client, { network, birthday: 0 }).broadcastRefusalsFinal).toBeUndefined();
  });

  it('finds the unspent outputs of a set of addresses, mempool spends taken out and mempool outputs put in', async () => {
    const { client } = indexedPearld();
    const backend = pearldBackend(client, { network });
    const utxos = await backend.getUtxos([receive0, receive1, receive2, change0]);
    expect(outpoints(utxos)).toEqual([`${txids.a2}:0`, `${txids.a3}:0`, `${txids.m1}:0`].sort());
    const byTxid = Object.fromEntries(utxos.map((u) => [u.txid, u]));
    expect(byTxid[txids.a3]).toEqual({
      txid: txids.a3,
      vout: 0,
      value: 70000000n,
      script: toOutputScript(receive0, network),
      address: receive0,
      confirmations: 3,
      coinbase: false,
    });
    expect(byTxid[txids.a2]).toMatchObject({ value: 5000000000n, address: receive2, confirmations: 10, coinbase: true });
    expect(byTxid[txids.m1]).toMatchObject({ value: 100000000n, address: change0, confirmations: 0, coinbase: false });
    // What Oyster would spend: the immature coinbase and the unconfirmed change stay behind.
    expect(outpoints(spendableUtxos(utxos))).toEqual([`${txids.a3}:0`]);
  });

  it('still lists an output whose mempool spender pays an address outside the set', async () => {
    const { client } = indexedPearld();
    const utxos = await pearldBackend(client, { network }).getUtxos([receive0]);
    // receive/0's own list holds m1, which spends a1:0.
    expect(outpoints(utxos)).toEqual([`${txids.a3}:0`]);
  });

  it('takes output scripts in place of addresses and asks once for a repeated one', async () => {
    const { client, sent } = indexedPearld();
    const utxos = await pearldBackend(client, { network }).getUtxos([toOutputScript(receive2, network), receive2]);
    expect(outpoints(utxos)).toEqual([`${txids.a2}:0`]);
    expect(sent.map((r) => r.body.params[0])).toEqual([receive2]);
  });

  it('splits the balance into confirmed, unconfirmed and immature', async () => {
    const { client } = indexedPearld();
    const balance = await pearldBackend(client, { network }).getBalance([receive0, receive2, change0]);
    expect(balance).toEqual({ confirmed: grain('confirmed'), unconfirmed: grain('unconfirmed'), immature: grain('immature') });
    expect(sumBalance([{ txid: '', vout: 0, value: 5n, script: new Uint8Array(), confirmations: 100, coinbase: true }], 100).confirmed).toBe(5n);
    expect(sumBalance([{ txid: '', vout: 0, value: 5n, script: new Uint8Array(), confirmations: 99, coinbase: true }], 100).immature).toBe(5n);
    expect(sumBalance([{ txid: '', vout: 0, value: 5n, script: new Uint8Array() }], 100).unconfirmed).toBe(5n);
  });

  it('lists the history of an address with what each transaction paid it and spent from it', async () => {
    const { client } = indexedPearld();
    const history = await pearldBackend(client, { network }).getHistory(receive0);
    const blockOf = (confirmations: number) => {
      const hash = Object.keys(blockHeights).find((h) => blockHeights[h] === heightOf(confirmations))!;
      return { height: heightOf(confirmations), hash };
    };
    expect(history).toEqual([
      { txid: txids.a1, block: blockOf(6), received: 150000000n, spent: 0n },
      { txid: txids.a3, block: blockOf(3), received: 70000000n, spent: 0n },
      { txid: txids.m1, block: null, received: 0n, spent: 150000000n },
    ]);
    expect(await pearldBackend(client, { network }).getHistory(receive1)).toEqual([]);
  });

  it('is a chain client the invoice monitor accepts', async () => {
    const { client } = indexedPearld();
    const backend = pearldBackend(client, { network });
    expect(await backend.getTip()).toEqual({ height: tipHeight, hash: expected('getblock-raw', 'hash') });
    const invoice = createInvoice({ id: 'i', address: receive0, amount: 220000000n, createdAt: 1, expiresAt: 9, requiredConfirmations: 3 }, network);
    const refreshed = await refreshInvoice(invoice, backend, 5);
    expect(refreshed.paidAmount).toBe(220000000n);
    expect(refreshed.state).toBe('confirmed');
  });

  it('estimates a fee rate and never goes under the node relay fee', async () => {
    const estimated = pearldBackend(indexedPearld().client, { network });
    expect(await estimated.estimateFeeRate()).toBe(BigInt(expected('estimatefee', 'rate') as string));

    const young = indexedPearld({ estimatefee: 'estimatefee-unavailable' });
    expect(await pearldBackend(young.client, { network }).estimateFeeRate(2)).toBe(BigInt(expected('getinfo', 'relayFee') as string));
    expect(young.sent.find((r) => r.body.method === 'estimatefee')!.body.params).toEqual([2]);

    const zero = indexedPearld({ estimatefee: (r) => new Response(`{"result":0,"error":null,"id":${r.body.id}}`) });
    expect(await pearldBackend(zero.client, { network }).estimateFeeRate()).toBe(1000n);
  });

  it('broadcasts a transaction and returns its txid', async () => {
    const { client, sent } = indexedPearld();
    expect(await pearldBackend(client, { network }).broadcast(Uint8Array.of(1, 2, 3))).toBe(expected('getrawtransaction-hex', 'txid'));
    expect(sent[0]!.body).toMatchObject({ method: 'sendrawtransaction', params: ['010203'] });
  });

  it('reports an output as spent by a mempool transaction although gettxout still shows it', async () => {
    const { client } = indexedPearld({ gettxout: 'backend-gettxout-a1', gettxspendingprevout: 'backend-spending-a1' });
    expect(await pearldBackend(client, { network }).getSpendStatus({ txid: txids.a1, vout: 0 })).toEqual({
      status: 'spent',
      spender: txids.m1,
      confirmed: false,
    });
  });

  it('reports an unspent output with its confirmations', async () => {
    const { client } = indexedPearld({ gettxout: 'backend-gettxout-a3', gettxspendingprevout: 'backend-spending-a3' });
    expect(await pearldBackend(client, { network }).getSpendStatus({ txid: txids.a3, vout: 0 })).toEqual({ status: 'unspent', confirmations: 3 });
  });

  it('tells an output a block spent from one that never existed, and names the spender', async () => {
    const gone = { gettxout: 'gettxout-spent', gettxspendingprevout: 'backend-spending-a3' };
    const spent = indexedPearld({ ...gone, getrawtransaction: 'backend-getrawtransaction-a1' });
    expect(await pearldBackend(spent.client, { network }).getSpendStatus({ txid: txids.a1, vout: 0 })).toEqual({
      status: 'spent',
      spender: txids.m1,
      confirmed: false,
    });
    // An output index the transaction does not have.
    expect(await pearldBackend(spent.client, { network }).getSpendStatus({ txid: txids.a1, vout: 9 })).toEqual({ status: 'unknown' });

    const unknown = indexedPearld({ ...gone, getrawtransaction: 'getrawtransaction-missing' });
    expect(await pearldBackend(unknown.client, { network }).getSpendStatus({ txid: '00'.repeat(32), vout: 0 })).toEqual({ status: 'unknown' });
  });

  it('says which index is missing when pearld runs without it', async () => {
    const bare = indexedPearld({ searchrawtransactions: 'searchrawtransactions-noindex', getrawtransaction: 'getrawtransaction-noindex' });
    const backend = pearldBackend(bare.client, { network });
    for (const call of [backend.getUtxos([receive0]), backend.getBalance([receive0]), backend.getHistory(receive0), backend.getAddressActivity(receive0)]) {
      const err = await call.catch((e: unknown) => e);
      expect(err).toBeInstanceOf(MissingIndexError);
      expect(err).toMatchObject({ index: 'addrindex' });
      expect((err as Error).message).toContain('--addrindex');
    }
    const err = await backend.getTransaction(txids.a1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MissingIndexError);
    expect(err).toMatchObject({ index: 'txindex' });
  });

  it('refuses an address of another network before asking the node', async () => {
    const { client, sent } = indexedPearld();
    const mainnetAddress = receive0.replace(/^rprl/, 'prl');
    await expect(pearldBackend(client, { network: networks.mainnet }).getUtxos([receive0])).rejects.toThrow();
    await expect(pearldBackend(client, { network }).getHistory(mainnetAddress)).rejects.toThrow();
    expect(sent).toHaveLength(0);
  });

  it('refuses a confirmation count or an output value that is not one', async () => {
    const body = (edit: (text: string) => string) => (r: { body: { id: number } }) =>
      new Response(edit(fixture('backend-search-receive2').body).replace(/"id":\d+}\n$/, `"id":${r.body.id}}`));
    const fractional = indexedPearld({ searchrawtransactions: body((t) => t.replace('"confirmations":10', '"confirmations":1.5')) });
    expect((await rejection(pearldBackend(fractional.client, { network }).getUtxos([receive2]))).message).toContain('no valid confirmation count');
    const negative = indexedPearld({ searchrawtransactions: body((t) => t.replace('"value":50.00000000', '"value":-50.00000000')) });
    expect((await rejection(pearldBackend(negative.client, { network }).getUtxos([receive2]))).message).toContain('expected an amount');
  });
});

describe('pearld backend and P2MR addresses', () => {
  // pearld's address index holds Taproot addresses only and answers a P2MR
  // address with an internal error, so the backend scans block filters.
  const tree = assembleScriptTree([checksigScript(new Uint8Array(32).fill(3))]);
  const script = p2mr({ merkleRoot: tree.root }).output;
  const address = fromOutputScript(script, network);
  const other = toOutputScript(receive0, network);
  // Linked headers, so the scan's header checks pass; a variant at a height gives that block and the ones after it other hashes.
  const headerOf = (height: number, variants: ReadonlyMap<number, number> = new Map()): PearlBlockHeader => ({
    version: 1,
    prevBlock: height === 0 ? new Uint8Array(32) : blockHash(headerOf(height - 1, variants)),
    merkleRoot: new Uint8Array(32).fill(variants.get(height) ?? 0),
    timestamp: 1767225600 + height * 600,
    bits: network.powLimitBits,
    proofCommitment: new Uint8Array(32),
  });
  const hashOf = (height: number, variants?: ReadonlyMap<number, number>): string => blockHashHex(headerOf(height, variants));
  const vout = (n: number, to: Uint8Array, value: bigint) => ({ n, value, scriptPubKey: { hex: Buffer.from(to).toString('hex'), address: fromOutputScript(to, network) } });
  const tx = (txid: string, spends: [string, number][], pays: [Uint8Array, bigint][]) => ({
    txid,
    vin: spends.map(([prev, n]) => ({ txid: prev, vout: n, sequence: 0 })),
    vout: pays.map(([to, value], n) => vout(n, to, value)),
  });
  const [funding, spend, pending] = ['a1'.repeat(32), 'b2'.repeat(32), 'c3'.repeat(32)];

  function chain() {
    // Blocks 1 and 3 touch the address: one pays it twice, the other spends the first output.
    const blocks: ReturnType<typeof tx>[][] = [[], [tx(funding, [['ff'.repeat(32), 0]], [[script, 700n], [script, 300n], [other, 5n]])], [tx('d4'.repeat(32), [], [[other, 9n]])], [tx(spend, [[funding, 0]], [[other, 650n]])]];
    const mempool = [tx(pending, [[funding, 1]], [[script, 250n]])];
    const calls: string[] = [];
    // A replaced block gets another header at its height.
    const renamed = new Map<number, number>();
    const hashAt = (height: number): string => hashOf(height, renamed);
    const heightOf = (hash: string): number => blocks.findIndex((_, height) => hashAt(height) === hash);
    const rpc = {
      async call<T>(method: string, params: readonly unknown[] = []): Promise<T> {
        calls.push(method);
        const answer = (): unknown => {
          switch (method) {
            case 'getbestblock':
              return { height: blocks.length - 1, hash: hashAt(blocks.length - 1) };
            case 'getblockhash':
              return hashAt(params[0] as number);
            case 'getcfilter': {
              const items = blocks[heightOf(params[0] as string)]!.flatMap((item) => [...item.vout.map((out) => Buffer.from(out.scriptPubKey.hex, 'hex')), ...(item.txid === spend ? [script] : [])]);
              return Buffer.from(encodeFilter(buildFilter(filterKey(params[0] as string), items))).toString('hex');
            }
            case 'getblock':
              return { rawtx: blocks[heightOf(params[0] as string)] };
            case 'getblockheader':
              return params[1] === false ? Buffer.from(serializeBlockHeader(headerOf(heightOf(params[0] as string), renamed))).toString('hex') : { height: heightOf(params[0] as string) };
            case 'getrawmempool':
              return mempool.map((item) => item.txid);
            case 'getrawtransaction':
              return mempool.find((item) => item.txid === params[0]);
            case 'searchrawtransactions':
              throw new PearlRpcError('rpc', method, 'address type is not supported by the address index (code -32603)', { rpcCode: -32603 });
            default:
              throw new Error(`unexpected method ${method}`);
          }
        };
        return answer() as T;
      },
    };
    return { rpc, blocks, mempool, calls, renamed };
  }

  it('finds the outputs, balance and history of a P2MR address from block filters and the mempool', async () => {
    const { rpc, calls } = chain();
    const backend = pearldBackend(rpc, { network });
    expect(await backend.getUtxos([address])).toEqual([{ txid: pending, vout: 0, value: 250n, script, address, confirmations: 0, coinbase: false }]);
    expect(calls).not.toContain('searchrawtransactions');
    // Only the blocks whose filter matched were fetched.
    expect(calls.filter((method) => method === 'getblock')).toHaveLength(2);
    expect(await backend.getBalance([script])).toEqual({ confirmed: 0n, unconfirmed: 250n, immature: 0n });
    expect(await backend.getHistory(address)).toEqual([
      { txid: funding, block: { height: 1, hash: hashOf(1) }, received: 1000n, spent: 0n },
      { txid: spend, block: { height: 3, hash: hashOf(3) }, received: 0n, spent: 700n },
      { txid: pending, block: null, received: 250n, spent: 300n },
    ]);
    expect(await backend.getAddressActivity(address)).toEqual([
      { txid: funding, amount: 1000n, block: { height: 1, hash: hashOf(1) } },
      { txid: pending, amount: 250n, block: null },
    ]);
  });

  it('goes on from the last block scanned, takes the mempool afresh, and starts over after a reorganization', async () => {
    const { rpc, blocks, mempool, calls, renamed } = chain();
    const backend = pearldBackend(rpc, { network });
    await backend.getUtxos([address]);
    const filters = (): number => calls.filter((method) => method === 'getcfilter').length;
    expect(filters()).toBe(4);
    // The pending transaction is mined in a new block.
    blocks.push(mempool.splice(0));
    expect(await backend.getUtxos([address])).toEqual([{ txid: pending, vout: 0, value: 250n, script, address, confirmations: 1, coinbase: false }]);
    expect(filters()).toBe(5);
    // The block is replaced by one without it: the scan runs again from the start and the output is back.
    blocks.splice(3, 2, []);
    renamed.set(3, 0xee);
    expect(await backend.getUtxos([address])).toEqual([
      { txid: funding, vout: 0, value: 700n, script, address, confirmations: 3, coinbase: false },
      { txid: funding, vout: 1, value: 300n, script, address, confirmations: 3, coinbase: false },
    ]);
  });

  it('starts the scan at scanFrom', async () => {
    const { rpc, calls } = chain();
    const backend = pearldBackend(rpc, { network, scanFrom: 2 });
    expect(await backend.getHistory(address)).toEqual([{ txid: pending, block: null, received: 250n, spent: 0n }]);
    expect(calls.filter((method) => method === 'getcfilter')).toHaveLength(2);
    expect(() => pearldBackend(rpc, { network, scanFrom: -1 })).toThrow(RangeError);
  });

  it("starts an address's scan at its birth while the parent block stands, and from scanFrom once the birth is forgotten", async () => {
    const { rpc, calls } = chain();
    const backend = pearldBackend(rpc, { network });
    const txids = async (on: typeof backend): Promise<string[]> => (await on.getHistory(address)).map((entry) => entry.txid);
    backend.setAddressBirths!(new Map([[address, { height: 2, parent: hashOf(1) }]]));
    expect(await txids(backend)).toEqual([pending]);
    expect(calls.filter((method) => method === 'getcfilter')).toHaveLength(2);
    backend.setAddressBirths!(new Map([[address, null]]));
    expect(await txids(backend)).toEqual([funding, spend, pending]);
    // A parent the chain does not hold: the birth says nothing.
    const other = pearldBackend(rpc, { network });
    other.setAddressBirths!(new Map([[address, { height: 2, parent: hashOf(1, new Map([[1, 0xee]])) }]]));
    expect(await txids(other)).toEqual([funding, spend, pending]);
    expect(() => other.setAddressBirths!(new Map([[address, { height: -1 }]]))).toThrow(RangeError);
  });
});

describe('Oyster backend', () => {
  it('lists the wallet outputs paying the watched addresses, as coin selection takes them', async () => {
    const { client, sent } = scenarioOyster();
    const backend = oysterBackend(client, { network });
    const utxos = await backend.getUtxos([receive0, change0]);
    expect(outpoints(utxos)).toEqual([`${txids.a3}:0`, `${txids.m1}:0`].sort());
    expect(utxos.find((u) => u.txid === txids.a3)).toEqual({
      txid: txids.a3,
      vout: 0,
      value: 70000000n,
      script: toOutputScript(receive0, network),
      address: receive0,
      confirmations: 3,
      coinbase: false,
    });
    expect(sent[0]!.body).toMatchObject({ method: 'listunspent', params: [0, 9999999] });
    expect(outpoints(await backend.getUtxos([receive0]))).toEqual([`${txids.a3}:0`]);
    expect(await backend.getUtxos([receive1])).toEqual([]);
  });

  it('marks coinbase outputs from the transaction list, since listunspent has no flag', async () => {
    const coinbase = fixture('backend-listunspent').body.replaceAll(txids.a3, txids.a2);
    const { client } = scenarioOyster({ listunspent: (r) => new Response(coinbase.replace(/"id":\d+}\n$/, `"id":${r.body.id}}`)) });
    const utxos = await oysterBackend(client, { network }).getUtxos([receive0]);
    expect(utxos).toMatchObject([{ txid: txids.a2, coinbase: true }]);
  });

  it('reports the same balance as the address index, immature coinbase included', async () => {
    const { client } = scenarioOyster();
    const balance = await oysterBackend(client, { network }).getBalance([receive0, receive2, change0]);
    expect(balance).toEqual({ confirmed: grain('confirmed'), unconfirmed: grain('unconfirmed'), immature: grain('immature') });
    expect((await oysterBackend(client, { network }).getBalance([receive0])).immature).toBe(0n);
  });

  it('lists what an address received, with block heights worked out from confirmations', async () => {
    const { client } = scenarioOyster();
    const backend = oysterBackend(client, { network });
    const history = await backend.getHistory(receive0);
    expect(history.map((h) => [h.txid, h.received, h.block?.height, 'spent' in h])).toEqual([
      [txids.a1, 150000000n, heightOf(6), false],
      [txids.a3, 70000000n, heightOf(3), false],
    ]);
    expect(await backend.getAddressActivity(receive0)).toEqual(history.map((h) => ({ txid: h.txid, amount: h.received, block: h.block })));
    expect(await backend.getTip()).toEqual({ height: tipHeight, hash: expected('getblock-raw', 'hash') });
  });

  it('counts a change address as used although Oyster lists no receive for it, and reads what it was paid from the transaction', async () => {
    // Oyster answers for the change address with the send alone; the amount is in the transaction it holds.
    const { hex } = (JSON.parse(fixture('backend-search-change0').body) as { result: { hex: string }[] }).result[0]!;
    const { client, sent } = scenarioOyster({
      gettransaction: (r) => new Response(JSON.stringify({ result: { hex, txid: r.body.params[0], details: [] }, error: null, id: r.body.id })),
    });
    const backend = oysterBackend(client, { network });
    expect(await backend.findUsed!([receive0, receive1, receive2, change0])).toEqual([receive0, receive2, change0]);
    expect(await backend.getAddressActivity(change0)).toEqual([{ txid: txids.m1, amount: 100000000n, block: null }]);
    expect(await backend.getHistory(change0)).toEqual([{ txid: txids.m1, block: null, received: 100000000n }]);
    expect(sent.filter((r) => r.body.method === 'gettransaction').map((r) => r.body.params[0])).toEqual([txids.m1, txids.m1]);
    // An address others paid needs no such lookup.
    await backend.getHistory(receive0);
    expect(sent.filter((r) => r.body.method === 'gettransaction')).toHaveLength(2);
  });

  it('looks up a wallet transaction and returns null for one the wallet does not hold', async () => {
    const { client } = scenarioOyster({ gettransaction: (r) => (r.body.params[0] === txids.a1 ? 'gettransaction' : 'gettransaction-missing') });
    const backend = oysterBackend(client, { network });
    expect(await backend.getTransaction(txids.a1)).toEqual({ txid: 'ab'.repeat(32), block: { height: heightOf(6), hash: expected('getblock-raw', 'hash'), time: 1767225600 } });
    expect(await backend.getTransaction('00'.repeat(32))).toBeNull();
  });

  it('reaches pearld through Oyster for broadcast, fee rate and spend status', async () => {
    const { client } = scenarioOyster({
      sendrawtransaction: 'sendrawtransaction',
      estimatefee: 'estimatefee',
      gettxout: 'backend-gettxout-a1',
      gettxspendingprevout: 'backend-spending-a1',
    });
    const backend = oysterBackend(client, { network });
    expect(await backend.broadcast('00')).toBe(expected('getrawtransaction-hex', 'txid'));
    expect(await backend.estimateFeeRate()).toBe(BigInt(expected('estimatefee', 'rate') as string));
    expect(await backend.getSpendStatus({ txid: txids.a1, vout: 0 })).toEqual({ status: 'spent', spender: txids.m1, confirmed: false });
    expect(await backend.getSpendStatus({ txid: txids.a3, vout: 0 })).toEqual({ status: 'unspent', confirmations: 3 });
  });

  it('gives full transactions from the wallet, then from its pearld, then null', async () => {
    const wallet = scenarioOyster({ gettransaction: 'gettransaction' });
    expect(await oysterBackend(wallet.client, { network }).getRawTransaction('ab'.repeat(32))).toBe('00');
    const node = scenarioOyster({ gettransaction: 'gettransaction-missing', getrawtransaction: 'getrawtransaction-hex' });
    expect(await oysterBackend(node.client, { network }).getRawTransaction('cd'.repeat(32))).toMatch(/^0[12]000000/);
    const neither = scenarioOyster({ gettransaction: 'gettransaction-missing', getrawtransaction: 'chain-rpc-inactive' });
    expect(await oysterBackend(neither.client, { network }).getRawTransaction('cd'.repeat(32))).toBeNull();
    const pearld = indexedPearld({ getrawtransaction: (r) => (r.body.params[0] === 'ab'.repeat(32) ? 'getrawtransaction-hex' : 'getrawtransaction-missing') });
    const backend = pearldBackend(pearld.client, { network });
    expect(await backend.getRawTransaction('ab'.repeat(32))).toMatch(/^0[12]000000/);
    expect(await backend.getRawTransaction('cd'.repeat(32))).toBeNull();
  });

  it('says what an SPV Oyster cannot do instead of failing obscurely', async () => {
    const inactive = 'chain-rpc-inactive';
    const { client } = scenarioOyster({ sendrawtransaction: inactive, estimatefee: inactive, gettxout: inactive, gettxspendingprevout: inactive });
    const backend = oysterBackend(client, { network });
    await expect(backend.broadcast('00')).rejects.toThrow('send with sendMany instead');
    expect(await backend.estimateFeeRate()).toBe(OYSTER_DEFAULT_FEE_RATE);
    expect(await backend.getSpendStatus({ txid: txids.a1, vout: 0 })).toEqual({ status: 'unknown' });
  });
});

// What pearld lets its limited RPC user call (rpcLimited, node/rpcserver.go),
// with refusals served by pearld's own HTTP handler for that user.
describe('the limited RPC user', () => {
  const probe = (routes: Record<string, Route>) =>
    probePearld(
      new PearldClient({
        url: 'https://127.0.0.1:18334',
        fetch: fakeFetch({
          getbestblock: 'backend-getbestblock',
          getblock: 'getblock-verbose',
          getrawmempool: 'getrawmempool',
          getcfilter: 'getcfilter',
          ...routes,
        }).fetch,
      }),
    );

  it('is told apart from the admin, with the indexes each node keeps', async () => {
    const admin = await probe({
      sendrawtransaction: 'sendrawtransaction-undecodable',
      gettxspendingprevout: 'gettxspendingprevout-empty',
      searchrawtransactions: 'searchrawtransactions-none',
      getrawtransaction: 'getrawtransaction-hex',
    });
    expect(admin).toEqual({ limited: false, broadcast: true, mempoolSpends: true, mempool: true, addrIndex: true, txIndex: true, cfIndex: true, backend: 'pearld' });

    const limited = await probe({
      sendrawtransaction: 'limited-sendrawtransaction',
      gettxspendingprevout: 'limited-gettxspendingprevout',
      searchrawtransactions: 'searchrawtransactions-noindex',
      getrawtransaction: 'getrawtransaction-noindex',
    });
    expect(limited).toEqual({ limited: true, broadcast: false, mempoolSpends: false, mempool: true, addrIndex: false, txIndex: false, cfIndex: true, backend: 'filters' });

    const bare = await probe({
      sendrawtransaction: 'sendrawtransaction-undecodable',
      gettxspendingprevout: 'gettxspendingprevout-empty',
      searchrawtransactions: 'searchrawtransactions-noindex',
      getrawtransaction: 'getrawtransaction-noindex',
      getcfilter: 'getcfilter-noindex',
    });
    expect(bare).toMatchObject({ limited: false, addrIndex: false, cfIndex: false, backend: null });
  });

  it('lets an unreachable node fail the probe instead of reading it as a refusal', async () => {
    const down = new PearldClient({ url: 'https://127.0.0.1:18334', fetch: (async () => Promise.reject(new TypeError('fetch failed'))) as typeof fetch });
    await expect(probePearld(down)).rejects.toMatchObject({ kind: 'network' });
  });

  it('may call every method the backends and the filter scan use to read, and none that send', () => {
    for (const method of ['getbestblock', 'getblockhash', 'getblock', 'getblockheader', 'getcfilter', 'getcfilterheader', 'getrawmempool', 'getrawtransaction', 'gettxout', 'searchrawtransactions', 'estimatefee', 'getinfo']) {
      expect(PEARLD_LIMITED_METHODS.has(method)).toBe(true);
    }
    for (const method of ['getblockchaininfo', 'sendrawtransaction', 'gettxspendingprevout', 'testmempoolaccept', 'stopnotifyblocks']) {
      expect(PEARLD_LIMITED_METHODS.has(method)).toBe(false);
    }
  });

  it('reads the tip with getbestblock, which the limited user may call', async () => {
    const { client, sent } = indexedPearld({ getbestblock: 'limited-getbestblock', getblockchaininfo: 'limited-getblockchaininfo' });
    expect(await pearldBackend(client, { network }).getTip()).toEqual({ height: 0, hash: expected('getblock-raw', 'hash') });
    expect(sent.map((s) => s.body.method)).toEqual(['getbestblock']);
  });

  it('refuses a broadcast with a typed error that names the method and the way out', async () => {
    const { client } = indexedPearld({ sendrawtransaction: 'limited-sendrawtransaction' });
    const err = await pearldBackend(client, { network }).broadcast('00').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnsupportedMethodError);
    expect(err).toMatchObject({ code: 'BACKEND_UNSUPPORTED', method: 'sendrawtransaction' });
    expect((err as Error).message).toMatch(/limited RPC user.*proxy/);
    expect((err as Error).cause).toBeInstanceOf(PearlRpcError);
  });

  it('broadcasts through the endpoint given for it while reading through the limited one', async () => {
    const reader = indexedPearld({ sendrawtransaction: 'limited-sendrawtransaction' });
    const writer = indexedPearld();
    const backend = pearldBackend(reader.client, { network, broadcast: writer.client });
    expect(await backend.broadcast('00')).toBe(expected('getrawtransaction-hex', 'txid'));
    expect(reader.sent).toEqual([]);
    expect(writer.sent.map((s) => s.body.method)).toEqual(['sendrawtransaction']);
  });

  it('finds a mempool spend from the address index when gettxspendingprevout is refused, and stops asking for it', async () => {
    const { client, sent } = indexedPearld({ gettxout: 'backend-gettxout-a1', gettxspendingprevout: 'limited-gettxspendingprevout' });
    const backend = pearldBackend(client, { network });
    expect(await backend.getSpendStatus({ txid: txids.a1, vout: 0 })).toEqual({ status: 'spent', spender: txids.m1, confirmed: false });
    const unspent = indexedPearld({ gettxout: 'backend-gettxout-a3', gettxspendingprevout: 'limited-gettxspendingprevout' });
    const other = pearldBackend(unspent.client, { network });
    expect(await other.getSpendStatus({ txid: txids.a3, vout: 0 })).toEqual({ status: 'unspent', confirmations: 3 });
    expect(await other.getSpendStatus({ txid: txids.a3, vout: 0 })).toEqual({ status: 'unspent', confirmations: 3 });
    expect(unspent.sent.filter((s) => s.body.method === 'gettxspendingprevout')).toHaveLength(1);
    expect(sent.filter((s) => s.body.method === 'gettxspendingprevout')).toHaveLength(1);
  });

  it('finds a mempool spend from the address index when the server does not know gettxspendingprevout', async () => {
    const { client, sent } = indexedPearld({ gettxout: 'backend-gettxout-a1', gettxspendingprevout: 'method-not-found' });
    const backend = pearldBackend(client, { network });
    expect(await backend.getSpendStatus({ txid: txids.a1, vout: 0 })).toEqual({ status: 'spent', spender: txids.m1, confirmed: false });
    expect(await backend.getSpendStatus({ txid: txids.a1, vout: 0 })).toEqual({ status: 'spent', spender: txids.m1, confirmed: false });
    expect(sent.filter((s) => s.body.method === 'gettxspendingprevout')).toHaveLength(1);
  });
});
