// The simulated chain as the node an application talks to: its RPC replies
// against the ones pearld wrote for the fixtures, pearldBackend and
// PearlWallet over that RPC against the chain's own backend, and a
// PearlWsClient connected to its websocket.

import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  MissingIndexError,
  PearlWallet,
  PearlWsClient,
  assembleScriptTree,
  checkFilterHeaders,
  checksigScript,
  createMemoryStore,
  customNetwork,
  matchFilter,
  networks,
  p2mrAddress,
  parseBlock,
  parseBlockHeader,
  parsePearl,
  parseTransaction,
  payFromAccount,
  pearldBackend,
  pearldChainClient,
  pearldTransactionSource,
  toOutputScript,
} from '../src/index.js';
import type { BlockEvent, FilteredBlockEvent, TxAccepted, TxNotification, TxRawResult, WalletBackend } from '../src/index.js';
import { SimulatedChain, TEST_MNEMONIC, testAccount, testAddress } from '../src/testing.js';
import { simulatedReply } from '../src/testing/rpc.js';
import { fixture } from './rpc-helpers.js';
import { hexToBytes } from './vector-helpers.js';

const prl = parsePearl;
const quick = customNetwork(networks.regtest, { coinbaseMaturity: 5 });
const small = (options: object = {}): SimulatedChain => new SimulatedChain({ network: quick, ...options });
const alice = testAccount(0);
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

interface Reply {
  result: unknown;
  error: { code: number; message: string } | null;
}
// Request ids aside, which are the caller's.
const reply = (text: string): Reply => ({ ...(JSON.parse(text) as Reply), id: 0 }) as Reply;
const recorded = (name: string): Reply => reply(fixture(name).body);
const answered = (chain: SimulatedChain, method: string, params: unknown[] = []): Reply => reply(simulatedReply(chain, method, params, 1));

/** The keys of a value at every level, with arrays read through their first element: what a client's types depend on. */
function shape(value: unknown): unknown {
  if (Array.isArray(value)) return value.length === 0 ? [] : [shape(value[0])];
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.keys(value).sort().map((name) => [name, shape((value as Record<string, unknown>)[name])]));
  }
  return typeof value;
}

/** A chain with a confirmed payment to alice, a mempool spend of it, and both transactions. */
function scenario(options: object = {}) {
  const chain = small(options);
  const coin = chain.fund(alice.deriveAddress(0), prl('10'));
  const spend = payFromAccount(alice, {
    network: quick,
    utxos: [{ ...coin, index: 0 }],
    recipients: [{ address: alice.deriveAddress(1), amount: prl('4') }],
    feeRate: 2000n,
    changeAddress: alice.deriveAddress(0, true),
    rbf: true,
  });
  chain.accept(spend.transaction);
  return { chain, coin, spend };
}

describe('the simulated RPC against replies pearld wrote', () => {
  it('answers for the regtest genesis block exactly as pearld does', () => {
    const chain = new SimulatedChain({ premine: 0 });
    const genesis = networks.regtest.genesisHash;
    expect(answered(chain, 'getblock', [genesis, 1])).toEqual(recorded('getblock-verbose'));
    expect(answered(chain, 'getblock', [genesis, 2])).toEqual(recorded('getblock-transactions'));
    expect(answered(chain, 'getblock', [genesis, 0])).toEqual(recorded('getblock-raw'));
    expect(answered(chain, 'getblockhash', [0])).toEqual(recorded('getblockhash'));
    expect(answered(chain, 'getbestblockhash')).toEqual(recorded('getbestblockhash'));
    expect(answered(chain, 'getbestblock')).toEqual(recorded('getbestblock'));
    expect(answered(chain, 'getchaintips')).toEqual(recorded('getchaintips'));
    expect(answered(chain, 'getdifficulty')).toEqual(recorded('getdifficulty'));
    // The fixture's header reply carries a made-up height and depth around the real header fields.
    expect(answered(chain, 'getblockheader', [genesis, true]).result).toEqual({ ...(recorded('getblockheader').result as object), confirmations: 1, height: 0 });
    // getrawtransaction of the genesis coinbase, which the fixture shows without its block.
    const coinbase = (recorded('getrawtransaction-coinbase').result as TxRawResult).txid;
    expect(answered(chain, 'getrawtransaction', [coinbase, 1]).result).toMatchObject(recorded('getrawtransaction-coinbase').result as object);
  });

  it('gives every reply the fields pearld gives it', () => {
    const { chain, coin, spend } = scenario();
    const same = (method: string, params: unknown[], name: string, pick: (result: never) => unknown = (result) => result): void => {
      const reply = answered(chain, method, params);
      expect(reply.error, method).toBeNull();
      expect(shape(pick(reply.result as never)), `${method} against ${name}`).toEqual(shape(pick(recorded(name).result as never)));
    };
    same('getrawtransaction', [coin.txid, 1], 'getrawtransaction-verbose');
    same('getblock', [chain.blocks[chain.height - 1]!.hash, 1], 'getblock-verbose', (result: Record<string, unknown>) => ({ ...result, nextblockhash: '' }));
    same('getblockheader', [chain.tip.hash, true], 'getblockheader');
    same('gettxout', [spend.txid, 0, true], 'gettxout');
    same('gettxout', [coin.txid, 0, true], 'gettxout-spent', () => null);
    same('getrawmempool', [true], 'getrawmempool-verbose', (result: Record<string, unknown>) => Object.values(result)[0]);
    same('getrawmempool', [false], 'getrawmempool');
    same('getmempoolinfo', [], 'getmempoolinfo');
    same('getinfo', [], 'getinfo');
    same('gettxspendingprevout', [[{ txid: coin.txid, vout: 0 }, { txid: spend.txid, vout: 0 }]], 'gettxspendingprevout');
    same('searchrawtransactions', [alice.deriveAddress(0), 1, 0, 100, 0, false], 'backend-search-receive0');
    same('testmempoolaccept', [[chain.faucet.build([{ address: testAddress(0), amount: prl('1') }]).toHex()], 0], 'testmempoolaccept-allowed');
    same('testmempoolaccept', [[spend.hex], 0], 'testmempoolaccept-rejected');
    same('validateaddress', [alice.deriveAddress(0)], 'validateaddress');
    same('validateaddress', ['nonsense'], 'validateaddress-invalid');
    same('estimatefee', [6], 'estimatefee');
    same('generate', [1], 'generate');
    same('decoderawtransaction', [spend.hex], 'decoderawtransaction');
    // Everything pearld reports of the chain except its soft-fork table.
    const info = { ...(recorded('getblockchaininfo').result as Record<string, unknown>) };
    delete info.bip9_softforks;
    expect(shape(answered(chain, 'getblockchaininfo').result)).toEqual(shape(info));
    expect(answered(chain, 'getblockchaininfo').result).toMatchObject({ chain: 'regtest', blocks: chain.height, bestblockhash: chain.tip.hash });
  });

  it('refuses with the codes and messages pearld uses', () => {
    const { chain, coin } = scenario();
    const unknown = (recorded('getrawtransaction-missing').error!.message.match(/[0-9a-f]{64}/) as RegExpMatchArray)[0];
    expect(answered(chain, 'getrawtransaction', [unknown, 1])).toEqual(recorded('getrawtransaction-missing'));
    expect(answered(chain, 'getblock', ['00'.repeat(32), 1])).toEqual(recorded('getblock-missing'));
    expect(answered(chain, 'searchrawtransactions', [testAddress(9), 1, 0, 100, 0, false])).toEqual(recorded('searchrawtransactions-none'));
    expect(answered(chain, 'nosuchmethod').error).toEqual(recorded('method-not-found').error);
    chain.feeRate = null;
    expect(answered(chain, 'estimatefee', [6])).toEqual(recorded('estimatefee-unavailable'));

    const bare = small({ txindex: false });
    const mined = bare.fund(alice.deriveAddress(0), prl('1'));
    expect(bare.addrindex).toBe(false);
    expect(answered(bare, 'getrawtransaction', [mined.txid, 1])).toEqual(recorded('getrawtransaction-noindex'));
    expect(answered(bare, 'searchrawtransactions', [alice.deriveAddress(0)]).error).toEqual(recorded('searchrawtransactions-noindex').error);
    // The mempool needs no index.
    const pending = bare.pay(alice.deriveAddress(1), prl('1'));
    expect((answered(bare, 'getrawtransaction', [pending.getId(), 1]).result as TxRawResult).txid).toBe(pending.getId());

    const version3 = parseTransaction(chain.faucet.build([{ address: testAddress(0), amount: prl('1') }]).toHex());
    version3.version = 3;
    const refused = answered(chain, 'sendrawtransaction', [version3.toHex()]).error!;
    expect(refused.code).toBe(recorded('sendrawtransaction-rejected').error!.code);
    expect(refused.message).toMatch(/^TX rejected: /);
    expect(answered(chain, 'getblockhash', [chain.height + 1]).error).toEqual({ code: -1, message: 'Block number out of range' });
    expect(answered(chain, 'searchrawtransactions', ['prl1nonsense']).error!.code).toBe(-5);
    expect(answered(chain, 'gettxout', [coin.txid, 7, true]).result).toBeNull();
  });

  it('pages an address search by skip and count, oldest first or newest first, mempool last', async () => {
    const chain = small();
    const address = alice.deriveAddress(7);
    const paid = [1, 2, 3, 4].map((n) => chain.fund(address, prl(String(n))).txid);
    paid.push(chain.pay(address, prl('5')).getId());
    const page = async (options: object): Promise<string[]> => (await chain.rpc.searchRawTransactions(address, options)).map((tx) => tx.txid);
    expect(await page({})).toEqual(paid);
    expect(await page({ skip: 1, count: 2 })).toEqual(paid.slice(1, 3));
    expect(await page({ skip: 3, count: 10 })).toEqual(paid.slice(3));
    expect(await page({ reverse: true, count: 2 })).toEqual([paid[4], paid[3]]);
    await expect(page({ skip: 5 })).rejects.toMatchObject({ rpcCode: -5 });
    await expect(page({ count: 10_001 })).rejects.toMatchObject({ rpcCode: -8 });
    // The backend reads the same history two transactions at a time.
    const paged = await pearldBackend(chain.rpc, { network: quick, pageSize: 2 }).getHistory(address);
    expect(paged).toEqual(await chain.getHistory(address));
    expect(paged.map((entry) => entry.txid)).toEqual(paid);
  });

  it('serves blocks, headers and filters an explorer can check', async () => {
    const { chain, coin } = scenario();
    chain.mine();
    const block = parseBlock(await chain.rpc.getRawBlock(chain.tip.hash));
    expect(block.transactions.map((tx) => tx.getId())).toEqual((await chain.rpc.getBlock(chain.tip.hash)).tx);
    expect(parseBlockHeader(hexToBytes(await chain.rpc.call<string>('getblockheader', [chain.tip.hash, false])))).toEqual(block.header);
    const headers = await chain.rpc.getHeaders([chain.blocks[chain.height - 3]!.hash]);
    expect(headers).toHaveLength(3);
    expect(parseBlock(hexToBytes(`${headers[2]!}00`)).header).toEqual(block.header);
    // Each filter holds the scripts its block pays and spends, and the headers chain from genesis.
    const filters = [];
    for (const { hash } of chain.blocks) filters.push({ ...(await chain.rpc.getCFilter(hash)), header: await chain.rpc.getCFilterHeader(hash) });
    checkFilterHeaders('00'.repeat(32), filters.map(({ filter, header }) => ({ filter, header })));
    const tip = filters[filters.length - 1]!;
    expect(matchFilter(tip.filter, tip.key, coin.script)).toBe(true);
    expect(matchFilter(tip.filter, tip.key, toOutputScript(alice.deriveAddress(1), quick))).toBe(true);
    expect(matchFilter(tip.filter, tip.key, toOutputScript(testAddress(42), quick))).toBe(false);
  });

  it('mines, invalidates and reconsiders over RPC, and counts every call', async () => {
    const chain = small();
    const height = chain.height;
    const [hash] = await chain.rpc.generate(2);
    expect(await chain.rpc.getBlockCount()).toBe(height + 2);
    await chain.rpc.call('invalidateblock', [hash]);
    expect(await chain.rpc.getBlockCount()).toBe(height);
    expect((await chain.rpc.getChainTips()).map((tip) => [tip.status, tip.branchlen])).toEqual([['active', 0], ['invalid', 2]]);
    expect((await chain.rpc.getBlockHeader(hash!)).confirmations).toBe(-1);
    await chain.rpc.call('reconsiderblock', [hash]);
    expect(await chain.rpc.getBlockCount()).toBe(height + 2);
    expect(chain.calls.get('getblockcount')).toBe(3);
    const stopped = new AbortController();
    stopped.abort();
    await expect(chain.rpc.call('getblockcount', [], { signal: stopped.signal })).rejects.toMatchObject({ code: 'RPC_NETWORK' });
    expect(chain.calls.get('getblockcount')).toBe(3);
  });
});

describe('the SDK over the simulated node', () => {
  const tree = assembleScriptTree([checksigScript(alice.derivePublicKey(5))]);
  const p2mr = p2mrAddress({ merkleRoot: tree.root }, quick);

  /** History that exercises every query: confirmed, spent, pending, coinbase and P2MR coins. */
  function busy(options: object = {}) {
    const { chain, coin, spend } = scenario(options);
    chain.mine(1, { coinbaseTo: alice.deriveAddress(2), value: prl('50') });
    chain.fund(p2mr, prl('3'));
    chain.pay(alice.deriveAddress(3), prl('1'));
    chain.pay(p2mr, prl('2'));
    const watched = [0, 1, 2, 3, 4].map((i) => alice.deriveAddress(i)).concat(alice.deriveAddress(0, true), p2mr);
    return { chain, coin, spend, watched };
  }

  it('gives pearldBackend over its RPC the answers of its own backend', async () => {
    const { chain, coin, spend, watched } = busy();
    const node: WalletBackend = pearldBackend(chain.rpc, { network: quick });
    const byOutpoint = <T extends { txid: string; vout?: number }>(list: T[]): T[] => [...list].sort((a, b) => `${a.txid}:${a.vout}`.localeCompare(`${b.txid}:${b.vout}`));
    expect(await node.getTip()).toEqual(await chain.getTip());
    expect(byOutpoint(await node.getUtxos(watched))).toEqual(byOutpoint(await chain.getUtxos(watched)));
    expect(await node.getBalance(watched)).toEqual(await chain.getBalance(watched));
    expect(await chain.getBalance(watched)).toMatchObject({ immature: prl('50'), unconfirmed: prl('3'), confirmed: prl('3') + prl('4') + spend.change });
    for (const address of watched) {
      expect(await node.getHistory(address), address).toEqual(await chain.getHistory(address));
      expect(await node.getAddressActivity(address), address).toEqual(await chain.getAddressActivity(address));
    }
    for (const outpoint of [{ txid: coin.txid, vout: 0 }, { txid: spend.txid, vout: 0 }, { txid: spend.txid, vout: 9 }, { txid: 'cd'.repeat(32), vout: 0 }]) {
      expect(await node.getSpendStatus(outpoint), `${outpoint.txid}:${outpoint.vout}`).toEqual(await chain.getSpendStatus(outpoint));
    }
    for (const txid of [coin.txid, spend.txid, 'cd'.repeat(32)]) expect(await node.getTransaction(txid)).toEqual(await chain.getTransaction(txid));
    expect(await node.estimateFeeRate()).toBe(await chain.estimateFeeRate());
    chain.feeRate = null;
    expect([await node.estimateFeeRate(), await chain.estimateFeeRate()]).toEqual([1000n, 1000n]);
    expect(await pearldTransactionSource(chain.rpc).getRawTransaction(spend.txid)).toBe(await chain.getRawTransaction(spend.txid));
    expect(await pearldTransactionSource(chain.rpc).getRawTransaction('cd'.repeat(32))).toBeNull();
    expect(await pearldChainClient(chain.rpc).getAddressActivity(watched[0]!)).toEqual(await chain.getAddressActivity(watched[0]!));

    // A spend confirmed in a block is still a spend, with its spender.
    chain.mine();
    expect(await node.getSpendStatus({ txid: coin.txid, vout: 0 })).toEqual({ status: 'spent', spender: spend.txid, confirmed: true });
    expect(await chain.getSpendStatus({ txid: coin.txid, vout: 0 })).toEqual({ status: 'spent', spender: spend.txid, confirmed: true });
    expect(await node.broadcast(chain.faucet.build([{ address: watched[4]!, amount: prl('1') }]).toHex())).toHaveLength(64);
    await expect(node.broadcast(spend.hex)).rejects.toMatchObject({ rpcCode: -27, method: 'sendrawtransaction' });
    await expect(chain.broadcast(spend.hex)).rejects.toMatchObject({ rpcCode: -27, method: 'sendrawtransaction' });
  });

  it('fails a backend the way a pearld without its indexes does', async () => {
    const noAddresses = pearldBackend(busy({ addrindex: false }).chain.rpc, { network: quick });
    await expect(noAddresses.getUtxos([alice.deriveAddress(0)])).rejects.toMatchObject({ code: 'BACKEND_MISSING_INDEX', index: 'addrindex' });
    const { chain, coin } = busy({ txindex: false });
    const bare = pearldBackend(chain.rpc, { network: quick });
    await expect(bare.getHistory(alice.deriveAddress(0))).rejects.toBeInstanceOf(MissingIndexError);
    await expect(bare.getTransaction(coin.txid)).rejects.toMatchObject({ index: 'txindex' });
  });

  it('runs a PearlWallet over RPC through payments, a send, a reorg and a double spend, in step with one on the native backend', async () => {
    const chain = small();
    const open = (backend: WalletBackend, transactions: NonNullable<Parameters<typeof PearlWallet.create>[0]['transactions']>): Promise<PearlWallet> =>
      PearlWallet.create({ store: createMemoryStore(), backend, transactions, mnemonic: TEST_MNEMONIC, passphrase: 'correct horse battery staple', kdf: { N: 2 ** 10 }, now: () => chain.time * 1000 });
    const overRpc = await open(pearldBackend(chain.rpc, { network: quick }), pearldTransactionSource(chain.rpc));
    const native = await open(chain, chain);
    const view = (wallet: PearlWallet): unknown => ({
      balance: wallet.balance(),
      history: wallet.history().map(({ txid, status, direction, amount, fee }) => ({ txid, status, direction, amount, fee })).sort((a, b) => a.txid.localeCompare(b.txid)),
    });
    const inStep = async (): Promise<void> => {
      await overRpc.sync();
      await native.sync();
      expect(view(overRpc)).toEqual(view(native));
    };

    const address = await overRpc.receiveAddress();
    expect(await native.receiveAddress()).toBe(address);
    const first = chain.pay(address, prl('10'));
    await inStep();
    expect(overRpc.balance()).toMatchObject({ unconfirmed: prl('10'), confirmed: 0n });
    chain.mine();
    const second = chain.pay(await overRpc.receiveAddress(), prl('5'));
    chain.mine();
    await inStep();
    expect(overRpc.balance().confirmed).toBe(prl('15'));

    const sent = await overRpc.send({ recipients: [{ address: testAddress(0), amount: prl('3') }], feeRate: 2000n });
    expect(chain.mempool.has(sent.txid)).toBe(true);
    await inStep();
    chain.mine();
    await inStep();
    expect(overRpc.history().find((entry) => entry.txid === sent.txid)).toMatchObject({ status: 'confirmed', direction: 'outgoing' });

    // The second payment is double-spent three blocks down; the first, and the send built on it, are mined again.
    chain.reorg(2, { replace: [second.getId()] });
    await inStep();
    expect(overRpc.balance().confirmed).toBe(prl('10') - prl('3') - sent.fee);
    expect(['conflicted', 'orphaned']).toContain(overRpc.history().find((entry) => entry.txid === second.getId())!.status);
    expect(overRpc.history().find((entry) => entry.txid === first.getId())).toMatchObject({ status: 'confirmed' });

    // A dropped connection during a send leaves it recorded, and a rebroadcast gets it out.
    chain.failNext(1, { method: 'sendrawtransaction' });
    await expect(overRpc.send({ recipients: [{ address: testAddress(1), amount: prl('1') }], feeRate: 2000n })).rejects.toMatchObject({ code: 'WALLET_BROADCAST_UNCERTAIN' });
    expect(chain.mempool.size).toBe(0);
    overRpc.close();
    native.close();
  });
});

describe('a PearlWsClient on the simulated websocket', () => {
  const connect = async (chain: SimulatedChain, options: object = {}): Promise<PearlWsClient> => {
    const ws = new PearlWsClient({ url: 'ws://simulated.invalid', WebSocket: chain.WebSocket, username: 'any', password: 'any', allowInsecureAuth: true, ...options });
    await ws.connect();
    return ws;
  };

  it('answers RPC calls and reports blocks as they connect and disconnect, in order', async () => {
    const chain = small();
    const ws = await connect(chain);
    expect(chain.WebSocket.connections).toBe(1);
    expect(await ws.getBlockCount()).toBe(chain.height);
    expect(typeof (await ws.session())).toBe('bigint');
    const blocks: BlockEvent[] = [];
    const filtered: FilteredBlockEvent[] = [];
    ws.watchBlocks({ onBlock: (event) => blocks.push(event) });
    ws.watchFilteredBlocks({ onBlock: (event) => filtered.push(event) });
    await ws.getBlockCount();
    const height = chain.height;
    const old = chain.tip;
    chain.mine();
    chain.reorg(2);
    await flush();
    expect(blocks.map((event) => `${event.type} ${event.height}`)).toEqual([
      `connected ${height + 1}`,
      `disconnected ${height + 1}`,
      `disconnected ${height}`,
      `connected ${height}`,
      `connected ${height + 1}`,
      `connected ${height + 2}`,
    ]);
    expect(blocks[2]).toEqual({ type: 'disconnected', hash: old.hash, height, time: old.time });
    expect(blocks[5]).toEqual({ type: 'connected', hash: chain.tip.hash, height: chain.height, time: chain.tip.time });
    expect(filtered.map((event) => `${event.type} ${event.hash}`)).toEqual(blocks.map((event) => `${event.type} ${event.hash}`));
    expect(filtered[5]!.header).toEqual(chain.tip.block.header);
    await ws.close();
    await flush();
    expect(chain.WebSocket.connections).toBe(0);
  });

  it('reports mempool transactions, plain and verbose', async () => {
    const chain = small();
    const plain = await connect(chain);
    const verbose = await connect(chain);
    const seen: TxAccepted[] = [];
    const full: TxRawResult[] = [];
    plain.watchTransactions({ onTransaction: (tx) => seen.push(tx) });
    verbose.watchTransactions({ verbose: true, onTransaction: (tx) => full.push(tx) });
    await Promise.all([plain.getBlockCount(), verbose.getBlockCount()]);
    const tx = chain.pay(alice.deriveAddress(0), prl('1.23456789'));
    await flush();
    const total = tx.outs.reduce((sum, out) => sum + out.value, 0n);
    expect(seen).toEqual([{ txid: tx.getId(), amount: total }]);
    expect(full).toHaveLength(1);
    expect(full[0]).toMatchObject({ txid: tx.getId(), hex: tx.toHex() });
    expect(full[0]!.vout[0]).toMatchObject({ value: prl('1.23456789'), n: 0, scriptPubKey: { address: alice.deriveAddress(0) } });
    expect(full[0]!.blockhash).toBeUndefined();
    await Promise.all([plain.close(), verbose.close()]);
  });

  it('matches a loaded filter against the mempool, new blocks and old ones', async () => {
    const chain = small();
    const mine = alice.deriveAddress(0);
    const earlier = chain.fund(mine, prl('1'));
    const ws = await connect(chain);
    await ws.loadTxFilter({ addresses: [mine] });
    const relevant: string[] = [];
    const filtered: FilteredBlockEvent[] = [];
    ws.on('relevanttxaccepted', (event) => relevant.push(event.transaction));
    ws.watchFilteredBlocks({ onBlock: (event) => filtered.push(event) });
    await ws.getBlockCount();
    chain.pay(testAddress(3), prl('1'));
    const paid = chain.pay(mine, prl('2'));
    await flush();
    expect(relevant).toEqual([paid.toHex()]);
    chain.mine();
    // pearld watches the outputs it saw paying a filter address, so the spend of one matches too.
    const onward = payFromAccount(alice, { network: quick, utxos: [{ txid: paid.getId(), vout: 0, value: prl('2'), script: earlier.script, confirmations: 1, index: 0 }], recipients: [{ address: testAddress(4), amount: 'max' }], feeRate: 2000n });
    chain.accept(onward.transaction);
    chain.mine(2);
    await flush();
    expect(relevant).toEqual([paid.toHex(), onward.hex]);
    expect(filtered.map((event) => event.transactions)).toEqual([[paid.toHex()], [onward.hex], []]);
    const rescanned = await ws.rescanBlocks(chain.blocks.slice(-5).map((block) => block.hash));
    expect(rescanned).toEqual([
      { hash: chain.transaction(earlier.txid)!.block!.hash, transactions: [chain.transaction(earlier.txid)!.tx.toHex()] },
      { hash: chain.blocks[chain.height - 2]!.hash, transactions: [paid.toHex()] },
      { hash: chain.blocks[chain.height - 1]!.hash, transactions: [onward.hex] },
    ]);
    await ws.close();
  });

  it('sends recvtx for a watched address and redeemingtx when the coin moves, with the block once mined', async () => {
    const chain = small();
    const mine = alice.deriveAddress(0);
    const ws = await connect(chain);
    const received: TxNotification[] = [];
    const redeemed: TxNotification[] = [];
    ws.on('recvtx', (event) => received.push(event));
    ws.on('redeemingtx', (event) => redeemed.push(event));
    await ws.notifyReceived([mine]);
    const paid = chain.pay(mine, prl('2'));
    chain.mine();
    const onward = payFromAccount(alice, { network: quick, utxos: [{ txid: paid.getId(), vout: 0, value: prl('2'), script: toOutputScript(mine, quick), confirmations: 1, index: 0 }], recipients: [{ address: testAddress(4), amount: 'max' }], feeRate: 2000n });
    chain.accept(onward.transaction);
    await flush();
    const block = chain.tip;
    expect(received).toEqual([
      { transaction: paid.toHex(), block: null },
      { transaction: paid.toHex(), block: { hash: block.hash, height: block.height, index: 1, time: block.time } },
    ]);
    expect(redeemed).toEqual([{ transaction: onward.hex, block: null }]);

    // The older rescan walks the chain again and ends with rescanfinished.
    const again: TxNotification[] = [];
    const finished: unknown[] = [];
    ws.on('recvtx', (event) => again.push(event));
    ws.on('rescanfinished', (event) => finished.push(event));
    await ws.rescan(chain.blocks[1]!.hash, [mine], []);
    await flush();
    expect(again).toEqual([received[1]]);
    expect(finished).toEqual([{ hash: block.hash, height: block.height, time: block.time }]);
    await ws.close();
  });

  it('drops connections when told to, and a client with reconnect on resubscribes', async () => {
    const chain = small();
    const ws = await connect(chain, { reconnect: { initialDelay: 1, maxDelay: 1 } });
    const blocks: BlockEvent[] = [];
    const connects: boolean[] = [];
    ws.on('connect', (event) => connects.push(event.reconnect));
    ws.watchBlocks({ onBlock: (event) => blocks.push(event) });
    await ws.getBlockCount();
    chain.WebSocket.dropAll();
    chain.mine();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(connects).toEqual([true]);
    chain.mine();
    await flush();
    // The block mined while the client was away is not sent again; a follower catches up over RPC.
    expect(blocks.map((event) => event.height)).toEqual([chain.height]);
    await ws.close();

    chain.WebSocket.refuseNext();
    const refused = new PearlWsClient({ url: 'ws://simulated.invalid', WebSocket: chain.WebSocket, reconnect: false });
    await expect(refused.connect()).rejects.toMatchObject({ code: 'RPC_NETWORK' });
    await expect((await connect(chain)).close()).resolves.toBeUndefined();
  });

  it('closes the socket for a call failNext fails, as a dying node would', async () => {
    const chain = small();
    const ws = await connect(chain, { reconnect: false });
    chain.failNext(1, { method: 'getblockcount' });
    await expect(ws.getBlockCount()).rejects.toMatchObject({ code: 'RPC_NETWORK' });
    await flush();
    expect(chain.WebSocket.connections).toBe(0);
  });
});

describe('the kit in a bundle', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const inputs = async (entry: string, platform: 'browser' | 'node'): Promise<string[]> => {
    const result = await build({
      entryPoints: [`${root}${entry}`],
      bundle: true,
      write: false,
      metafile: true,
      format: 'esm',
      platform,
      treeShaking: true,
      loader: { '.wasm': 'empty' },
      logLevel: 'silent',
      absWorkingDir: root,
    });
    return Object.keys(result.metafile.inputs);
  };

  it('stays out of the main entry point', async () => {
    const files = await inputs('src/index.ts', 'browser');
    expect(files).toContain('src/wallet.ts');
    expect(files.filter((file) => file.includes('testing'))).toEqual([]);
  });

  it('bundles for a browser without anything from Node, the launcher being its own module', async () => {
    const files = await inputs('src/testing.ts', 'browser');
    expect(files).toContain('src/testing/chain.ts');
    expect(files).not.toContain('src/testing-regtest.ts');
    // The control: the launcher does need Node, and a browser build of it fails.
    await expect(inputs('src/testing-regtest.ts', 'browser')).rejects.toThrow(/node:child_process/);
    expect(await inputs('src/testing-regtest.ts', 'node')).toContain('src/testing-regtest.ts');
  });
});
