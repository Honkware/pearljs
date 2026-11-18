// The compact-filter backend over a scripted pearld (test/filter-node.ts)
// that serves real blocks, Pearl's basic filters and their header chain from
// a FakeChain: scans from a birthday, reorganizations, filter matches a block
// does not back, restarts from the stored cursor, the limited RPC user, a
// node that hides its mempool, filter headers that disagree, and a wallet
// synced through it next to one synced through pearldBackend on the same
// chain.

import { describe, expect, it } from 'vitest';
import {
  connectPearld,
  customNetwork,
  PearlError,
  PearlWallet,
  UnsupportedMethodError,
  addInputByTxid,
  createMemoryStore,
  createTransaction,
  deriveSigningAccountFromSeed,
  filterBackend,
  mnemonicToSeed,
  networks,
  pearldBackend,
  pearldTransactionSource,
  toOutputScript,
  type FilterBackend,
  type WalletStore,
} from '../src/index.js';
import { FakeNode, type FakeNodeOptions } from './filter-node.js';
import { FAST_KDF, FakeChain, MNEMONIC, PASSPHRASE, STRANGER, signWithTestWallet } from './wallet-chain.js';

const network = customNetwork(networks.regtest, { coinbaseMaturity: 2 });
const account = deriveSigningAccountFromSeed(mnemonicToSeed(MNEMONIC), network);
const [r0, r1, r2] = [0, 1, 2].map((i) => account.deriveAddress(i));
const c0 = account.deriveAddress(0, true);
const mine = [r0!, r1!, r2!, c0];

function setup(options: FakeNodeOptions = {}) {
  // Heights 0 to 4, with the first coinbases already mature for the faucet.
  const chain = new FakeChain({ network, premine: 4 });
  const node = new FakeNode(chain, options);
  return { chain, node };
}

const backendFor = (node: FakeNode, extra: Partial<Parameters<typeof filterBackend>[1]> = {}): FilterBackend =>
  filterBackend(node, { network, birthday: 3, maxAge: 0, batchSize: 4, ...extra });

const sorted = <T extends { txid: string; vout?: number }>(items: T[]) => [...items].sort((a, b) => `${a.txid}:${a.vout ?? 0}`.localeCompare(`${b.txid}:${b.vout ?? 0}`));

describe('filterBackend', () => {
  it('finds outputs, spends, balance and history from the birthday on, as the address index does', async () => {
    const { chain, node } = setup();
    const before = chain.pay(r0!, 150000000n);
    chain.mine(1, { coinbaseTo: r2! });
    chain.pay(r1!, 70000000n);
    chain.mine(2);
    // A spend of r0's output to change and a stranger, in the mempool.
    const tx = createTransaction(2);
    addInputByTxid(tx, before.getId(), 0);
    tx.addOutput(toOutputScript(c0, network), 100000000n);
    tx.addOutput(toOutputScript(STRANGER, network), 49990000n);
    await chain.broadcast(signWithTestWallet(tx, chain.prevouts(tx)!).toHex());

    const filters = backendFor(node);
    const indexed = pearldBackend(node, { network });
    expect(sorted(await filters.getUtxos(mine))).toEqual(sorted(await indexed.getUtxos(mine)));
    expect(await filters.getBalance(mine)).toEqual(await indexed.getBalance(mine));
    for (const address of mine) {
      const history = (entries: Awaited<ReturnType<FilterBackend['getHistory']>>) => entries.map(({ txid, received, spent, block }) => ({ txid, received, spent, height: block?.height }));
      expect(history(await filters.getHistory(address))).toEqual(history(await indexed.getHistory(address)));
    }
    expect(await filters.getSpendStatus({ txid: before.getId(), vout: 0 })).toEqual({ status: 'spent', spender: tx.getId(), confirmed: false });
    expect(await filters.getRawTransaction(before.getId())).toBe(before.toHex());
    expect(await filters.findUsed([r0!, r1!, account.deriveAddress(7)])).toEqual([r0!, r1!]);

    chain.mine(1);
    expect(await filters.getSpendStatus({ txid: before.getId(), vout: 0 })).toEqual({ status: 'spent', spender: tx.getId(), confirmed: true });
    expect((await filters.getBalance([r0!])).confirmed).toBe(0n);
  });

  it('follows a watched output into the block that spends it to someone else', async () => {
    const { chain, node } = setup();
    const payment = chain.pay(r0!, 9000n);
    chain.mine(2);
    const backend = backendFor(node, { watch: [r0!] });
    expect(await backend.getUtxos([r0!])).toHaveLength(1);
    const spend = createTransaction(2);
    addInputByTxid(spend, payment.getId(), 0);
    spend.addOutput(toOutputScript(STRANGER, network), 8000n);
    await chain.broadcast(signWithTestWallet(spend, chain.prevouts(spend)!).toHex());
    chain.mine(1);
    const restarted = backendFor(new FakeNode(chain), { watch: [r0!] });
    for (const view of [backend, restarted]) {
      expect(await view.getUtxos([r0!])).toEqual([]);
      expect(await view.getSpendStatus({ txid: payment.getId(), vout: 0 })).toEqual({ status: 'spent', spender: spend.getId(), confirmed: true });
      expect((await view.getHistory(r0!)).map(({ txid, received, spent }) => ({ txid, received, spent }))).toEqual([
        { txid: payment.getId(), received: 9000n, spent: 0n },
        { txid: spend.getId(), received: 0n, spent: 9000n },
      ]);
    }
  });

  it('downloads only the blocks whose filters match, and nothing from a match the block does not back', async () => {
    const { chain, node } = setup();
    chain.mine(6);
    chain.pay(r0!, 5000n);
    chain.mine(1);
    // Height 7's filter claims r0's script though the block does not pay it.
    node.extraFilterItems.set(7, [toOutputScript(r0!, network)]);
    const backend = backendFor(node, { watch: [r0!] });
    await backend.sync();
    expect(node.count('getblock')).toBe(2);
    expect((await backend.getHistory(r0!)).map((entry) => entry.block?.height)).toEqual([11]);
    expect(await backend.status()).toMatchObject({ cursor: { height: 11 }, transactions: 1, scripts: 1 });
  });

  it('walks back to the common block in a reorganization and drops what left the chain', async () => {
    const { chain, node } = setup();
    const payment = chain.pay(r0!, 9000n);
    chain.mine(3);
    const store = createMemoryStore();
    const backend = backendFor(node, { store, watch: [r0!] });
    expect((await backend.getUtxos([r0!])).map((utxo) => utxo.confirmations)).toEqual([3]);
    const fetched = node.count('getcfilter');
    chain.reorg(3, { replace: [payment.getId()] });
    expect(await backend.getUtxos([r0!])).toEqual([]);
    expect(await backend.getHistory(r0!)).toEqual([]);
    const tip = await backend.getTip();
    expect(tip).toEqual({ height: 8, hash: node.blocks()[8]!.hash });
    const heights = (await store.list('filters/block/')).map(([key]) => Number(key.slice('filters/block/'.length)));
    expect(Math.max(...heights)).toBe(8);
    expect(await store.list('filters/tx/')).toEqual([]);
    // Filters from the fork on, not from the birthday.
    expect(node.count('getcfilter') - fetched).toBe(4);
    expect(await backend.getTransaction(payment.getId())).toBeNull();
  });

  it('follows a payment a reorganization moves into another block', async () => {
    const { chain, node } = setup();
    const payment = chain.pay(r0!, 9000n);
    chain.mine(1);
    const backend = backendFor(node, { watch: [r0!] });
    expect((await backend.getTransaction(payment.getId()))?.block?.height).toBe(5);
    chain.reorg(1, { mine: 2, keepInMempool: true });
    expect((await backend.getTransaction(payment.getId()))?.block).toBeNull();
    chain.mine(1);
    expect((await backend.getTransaction(payment.getId()))?.block?.height).toBe(7);
  });

  it('goes on from the stored cursor after a restart, fetching no filter twice', async () => {
    const { chain, node } = setup();
    chain.pay(r0!, 4000n);
    chain.mine(5);
    const store = createMemoryStore();
    await backendFor(node, { store, watch: [r0!] }).sync();
    const filtersBefore = node.count('getcfilter');
    expect(filtersBefore).toBe(7);
    chain.mine(2);
    const again = backendFor(node, { store });
    expect((await again.getUtxos([r0!])).map((utxo) => utxo.value)).toEqual([4000n]);
    expect(node.count('getcfilter') - filtersBefore).toBe(2);
    expect(await again.status()).toMatchObject({ cursor: { height: 11 }, birthday: 3 });
  });

  it('scans the blocks already passed for an address watched later, from the stored filters or fetched again', async () => {
    for (const keepFilters of [true, false]) {
      const { chain, node } = setup();
      chain.pay(r1!, 3000n);
      chain.mine(3);
      const backend = backendFor(node, { watch: [r0!], keepFilters });
      await backend.sync();
      const fetched = node.count('getcfilter');
      expect(await backend.getAddressActivity(r1!)).toMatchObject([{ amount: 3000n, block: { height: 5 } }]);
      expect(node.count('getcfilter') - fetched).toBe(keepFilters ? 0 : 5);
    }
  });

  it('refuses a store holding another network\'s or another birthday\'s scan', async () => {
    const { node } = setup();
    const store = createMemoryStore();
    await backendFor(node, { store }).sync();
    await expect(backendFor(node, { store, birthday: 1 }).sync()).rejects.toMatchObject({ code: 'STORE_INVALID' });
    await expect(filterBackend(node, { network: networks.mainnet, birthday: 3, store }).sync()).rejects.toMatchObject({ code: 'STORE_INVALID' });
    // Another prefix keeps its own scan in the same store.
    await backendFor(node, { store, birthday: 1, prefix: 'early/' }).sync();
  });

  it('serves every read with the limited RPC user, and says broadcast needs another endpoint', async () => {
    const { chain, node } = setup({ limited: true, addrIndex: false, txIndex: false });
    const paid = chain.pay(r0!, 6000n);
    chain.mine(1);
    chain.pay(r0!, 7000n);
    const backend = backendFor(node);
    expect((await backend.getBalance([r0!])).confirmed).toBe(6000n);
    expect((await backend.getBalance([r0!])).unconfirmed).toBe(7000n);
    expect(await backend.status()).toMatchObject({ mempool: true });
    const err = await backend.broadcast('00').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnsupportedMethodError);
    expect(err).toMatchObject({ method: 'sendrawtransaction' });
    expect(node.calls.filter((call) => call === 'getblockchaininfo' || call === 'gettxspendingprevout')).toEqual([]);

    const admin = new FakeNode(chain);
    const sending = backendFor(node, { broadcast: admin, store: createMemoryStore() });
    const tx = createTransaction(2);
    addInputByTxid(tx, paid.getId(), 0);
    tx.addOutput(toOutputScript(STRANGER, network), 5000n);
    expect(await sending.broadcast(signWithTestWallet(tx, chain.prevouts(tx)!).toHex())).toBe(tx.getId());
    expect(chain.mempool.has(tx.getId())).toBe(true);
  });

  it('says plainly when the mempool cannot be seen, and counts confirmed outputs only', async () => {
    const { chain, node } = setup({ noMempool: true });
    chain.pay(r0!, 6000n);
    chain.mine(1);
    chain.pay(r0!, 7000n);
    const backend = backendFor(node);
    expect(await backend.getBalance([r0!])).toEqual({ confirmed: 6000n, unconfirmed: 0n, immature: 0n });
    expect(await backend.status()).toMatchObject({ mempool: false });
    const off = backendFor(new FakeNode(chain), { mempool: false });
    expect((await off.getBalance([r0!])).unconfirmed).toBe(0n);
  });

  it('refuses filters whose header chain the node or a cross-check endpoint contradicts', async () => {
    const { chain, node } = setup();
    chain.mine(2);
    const tipHash = node.blocks()[6]!.hash;
    const liar = new FakeNode(chain);
    liar.lyingHeaders.set(tipHash, 'ee'.repeat(32));
    const checked = backendFor(node, { crossCheck: [new FakeNode(chain), liar], batchSize: 10 });
    const err = await checked.sync().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PearlError);
    expect(err).toMatchObject({ code: 'FILTER_HEADER_MISMATCH', message: expect.stringContaining('cross-check endpoint 2') });

    node.lyingHeaders.set(tipHash, 'ee'.repeat(32));
    await expect(backendFor(node, { batchSize: 10 }).sync()).rejects.toMatchObject({ code: 'FILTER_HEADER_MISMATCH' });
  });

  it('refuses a block other than the one asked for', async () => {
    const { chain, node } = setup();
    chain.pay(r0!, 1000n);
    chain.mine(2);
    node.swapBlock = { asked: 5, served: 6 };
    await expect(backendFor(node, { watch: [r0!] }).sync()).rejects.toMatchObject({ code: 'BACKEND_RESPONSE' });
  });

  it('costs two requests a block, one a round and two a sync, plus a download for each match', async () => {
    const { chain, node } = setup();
    chain.mine(95);
    // Blocks 3 to 99, after the anchor at 2: getblockhash and getcfilterheader for it.
    await backendFor(node, { batchSize: 10 }).sync();
    const counts = Object.fromEntries(['getbestblock', 'getblockhash', 'getcfilter', 'getcfilterheader', 'getblock', 'getrawmempool'].map((m) => [m, node.count(m)]));
    expect(counts).toEqual({ getbestblock: 1, getblockhash: 98, getcfilter: 97, getcfilterheader: 11, getblock: 0, getrawmempool: 1 });
  });

  it('reports each round, and stops between rounds when aborted', async () => {
    const { chain, node } = setup();
    chain.mine(10);
    const seen: number[] = [];
    await backendFor(node).sync({ onProgress: ({ height }) => seen.push(height) });
    expect(seen).toEqual([6, 10, 14]);
    const controller = new AbortController();
    const aborted = backendFor(new FakeNode(chain)).sync({ signal: controller.signal, onProgress: () => controller.abort() });
    await expect(aborted).rejects.toThrow();
  });

  it('syncs a wallet to the same balance, coins and history as pearldBackend on the same chain', async () => {
    const { chain, node } = setup();
    const open = (backend: FilterBackend | ReturnType<typeof pearldBackend>, transactions: { getRawTransaction(txid: string): Promise<string | Uint8Array | null> }, store: WalletStore) =>
      PearlWallet.create({ store, backend, transactions, passphrase: PASSPHRASE, mnemonic: MNEMONIC, kdf: FAST_KDF, gapLimit: 10 });
    chain.pay(r0!, 150000000n);
    chain.mine(1, { coinbaseTo: r2! });
    chain.pay(account.deriveAddress(4), 25000000n);
    chain.mine(2);
    chain.pay(r1!, 1000000n);

    const filters = backendFor(node, { birthday: 0 });
    const viaFilters = await open(filters, filters, createMemoryStore());
    const viaIndex = await open(pearldBackend(node, { network }), pearldTransactionSource(node), createMemoryStore());
    await viaFilters.sync();
    await viaIndex.sync();
    const view = (wallet: PearlWallet) => ({
      balance: wallet.balance(),
      coins: [...wallet.coins()].map(({ txid, vout, value }) => ({ txid, vout, value })).sort((a, b) => `${a.txid}${a.vout}`.localeCompare(`${b.txid}${b.vout}`)),
      history: wallet.history().map(({ txid }) => txid).sort(),
    });
    expect(view(viaFilters)).toEqual(view(viaIndex));
    expect(view(viaFilters).coins).toHaveLength(4);
    await viaFilters.close();
    await viaIndex.close();
  });
});

describe('one object per node', () => {
  it('picks pearldBackend for a node with the address index and filterBackend for one without', async () => {
    const { chain, node } = setup();
    chain.pay(r0!, 8000n);
    chain.mine(1);
    const indexed = await connectPearld(node, { network, birthday: 3 });
    expect(indexed).toMatchObject({ kind: 'pearld', capabilities: { addrIndex: true, backend: 'pearld' } });
    const plain = await connectPearld(new FakeNode(chain, { addrIndex: false, txIndex: false, limited: true }), { network, birthday: 3, maxAge: 0 });
    expect(plain).toMatchObject({ kind: 'filters', capabilities: { limited: true, addrIndex: false, cfIndex: true } });
    for (const backend of [indexed, plain]) {
      expect((await backend.getUtxos([r0!])).map((utxo) => utxo.value)).toEqual([8000n]);
      const [utxo] = await backend.getUtxos([r0!]);
      expect(await backend.getRawTransaction(utxo!.txid)).toMatch(/^[0-9a-f]+$/);
      expect(await backend.getRawTransaction('00'.repeat(32))).toBeNull();
    }
  });

  it('serves a wallet as backend and transaction source at once', async () => {
    const { chain } = setup();
    chain.pay(r0!, 8000n);
    chain.mine(1);
    const backend = await connectPearld(new FakeNode(chain, { addrIndex: false }), { network, birthday: 0, maxAge: 0 });
    const wallet = await PearlWallet.create({ store: createMemoryStore(), backend, passphrase: PASSPHRASE, mnemonic: MNEMONIC, kdf: FAST_KDF, gapLimit: 10 });
    await wallet.sync();
    expect(wallet.balance()).toMatchObject({ confirmed: 8000n });
    await wallet.close();
  });

  it('answers a wallet\'s later syncs with one question for every address', async () => {
    const { chain, node } = setup();
    chain.pay(r0!, 8000n);
    chain.mine(1);
    const filters = backendFor(node, { birthday: 0 });
    const asked = { history: 0, since: 0 };
    const backend: FilterBackend = {
      ...filters,
      getHistory: (watched) => (asked.history++, filters.getHistory(watched)),
      getActivitySince: (watched, after) => (asked.since++, filters.getActivitySince(watched, after)),
    };
    const wallet = await PearlWallet.create({ store: createMemoryStore(), backend, passphrase: PASSPHRASE, mnemonic: MNEMONIC, kdf: FAST_KDF, gapLimit: 10 });
    await wallet.sync();
    expect(asked.since).toBe(0);
    const before = asked.history;
    // To the address already used, so no new address comes into the window to be asked about on its own.
    chain.pay(r0!, 9000n);
    chain.mine(1);
    chain.pay(r0!, 1000n);
    await wallet.sync();
    expect(asked).toEqual({ history: before, since: 1 });
    expect(wallet.balance()).toMatchObject({ confirmed: 17000n, unconfirmed: 1000n });
    await wallet.close();
  });

  it('cannot answer from a block that left the chain or lies before the birthday', async () => {
    const { chain, node } = setup();
    const filters = backendFor(node);
    await filters.sync();
    const tip = (await filters.getTip())!;
    expect(await filters.getActivitySince([r0!], tip)).toEqual([]);
    expect(await filters.getActivitySince([r0!], { height: 1, hash: chain.blocks[1]!.hash })).toBeNull();
    chain.reorg(1);
    expect(await filters.getActivitySince([r0!], tip)).toBeNull();
  });

});
