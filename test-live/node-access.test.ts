// Reaching pearld with what a deployment has: probePearld and connectPearld
// as the admin and the limited user, on the suite's node and on a second
// pearld started without indexes that follows it; filterBackend on that node
// with the limited user (a birthday sync, a payment and its spend, the
// mempool, a reorg, a restart from a file store, a cross-check against the
// suite's node and broadcast through an admin endpoint); a PearlWallet on
// filterBackend beside one on pearldBackend; the newer typed methods of
// pearld and Oyster; a redirect and an oversized reply refused; and the
// limited user dropping a block watcher over the websocket.

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { WebSocket } from 'undici';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  connectPearld,
  createMemoryStore,
  createPsbt,
  deriveSigningAccountFromSeed,
  encodeWif,
  filterBackend,
  finalizePsbt,
  generateMnemonic,
  isLimitedUserRefusal,
  mnemonicToSeed,
  parseTransaction,
  payFromAccount,
  PearldClient,
  PEARLD_LIMITED_METHODS,
  pearldBackend,
  PearlRpcError,
  PearlWallet,
  PearlWsClient,
  probePearld,
  sha256,
  toOutputScript,
} from '../src/index.js';
import type { PearldCapabilities } from '../src/index.js';
import { createFileStore } from '../src/store-file.js';
import { clientOptions, pearldClient, trustingAgent } from './context.js';
import { describeLive, describeOyster, eventually, FEE_RATE, fund, limited, live, mine, network, nowhere, oyster, pearld } from './chain.js';
import { startPearld } from './processes.js';
import type { RunningPearld } from './processes.js';
import { connection, outsider, PASSPHRASE, QUICK_KDF } from './wallets.js';

const { payPending } = outsider(15);
const FULL: PearldCapabilities = { limited: false, broadcast: true, mempoolSpends: true, mempool: true, addrIndex: true, txIndex: true, cfIndex: true, backend: 'pearld' };
const LIMITED = { limited: true, broadcast: false, mempoolSpends: false, mempool: true } as const;

describeLive('node access', () => {
  let bare: RunningPearld;
  let bareAdmin: PearldClient;
  let bareLimited: PearldClient;

  const followed = async (): Promise<void> => {
    const tip = await pearld.getBestBlockHash();
    await eventually(() => bareAdmin.getBestBlockHash(), (hash) => hash === tip, 120_000);
    expect(await bareAdmin.getBestBlockHash()).toBe(tip);
  };

  beforeAll(async () => {
    bare = await startPearld({ exe: process.env.PEARLD!, dir: join(live!.dir, 'pearld-bare'), miningAddress: deriveSigningAccountFromSeed(mnemonicToSeed(generateMnemonic()), network).deriveAddress(0), withoutIndexes: true, extraArgs: [`--connect=${live!.p2p}`] });
    bareAdmin = bare.client;
    bareLimited = pearldClient(bare.endpoint, bare.limited);
    await followed();
  });
  afterAll(async () => {
    await bare?.stop();
  });

  it('probes what each set of credentials may do and which indexes each node keeps, and connects the backend that fits', async () => {
    expect(await probePearld(pearld)).toEqual(FULL);
    expect(await probePearld(limited)).toEqual({ ...FULL, ...LIMITED });
    expect(await probePearld(bareAdmin)).toEqual({ ...FULL, addrIndex: false, txIndex: false, backend: 'filters' });
    expect(await probePearld(bareLimited)).toEqual({ ...FULL, ...LIMITED, addrIndex: false, txIndex: false, backend: 'filters' });
    for (const method of ['getrawmempool', 'searchrawtransactions', 'getcfilter', 'getblock']) expect(PEARLD_LIMITED_METHODS.has(method)).toBe(true);
    const refusal = await limited.getBlockchainInfo().catch((err: unknown) => err);
    expect(isLimitedUserRefusal(refusal)).toBe(true);

    const birthday = await pearld.getBlockCount();
    expect(await connectPearld(pearld, { network, birthday })).toMatchObject({ kind: 'pearld', capabilities: FULL });
    expect(await connectPearld(limited, { network, birthday })).toMatchObject({ kind: 'pearld', capabilities: { limited: true } });
    const viaFilters = await connectPearld(bareLimited, { network, birthday, broadcast: bareAdmin });
    expect(viaFilters).toMatchObject({ kind: 'filters', capabilities: { limited: true, addrIndex: false } });
    expect(await viaFilters.getTip()).toEqual({ height: birthday, hash: await pearld.getBestBlockHash() });
    // With the address index connectPearld would return pearldBackend, which cannot be cross-checked, so it refuses;
    // on a node without it, filterBackend asks the endpoint and fails when it is down.
    const down = new PearldClient({ url: 'https://127.0.0.1:1', username: 'x', password: 'x' });
    await expect(connectPearld(pearld, { network, birthday, crossCheck: [down] })).rejects.toMatchObject({ code: 'CROSS_CHECK_UNSUPPORTED' });
    await expect(connectPearld(bareLimited, { network, birthday, crossCheck: [down] }).then((chain) => chain.getTip())).rejects.toMatchObject({ code: 'CROSS_CHECK_FAILED' });
  });

  it('follows a payment and its spend on the index-free node as the limited user, through the mempool, a reorg and a restart from its store', async () => {
    const account = deriveSigningAccountFromSeed(mnemonicToSeed(generateMnemonic()), network);
    const address = account.deriveAddress(0);
    const birthday = await pearld.getBlockCount();
    const store = createFileStore(join(live!.dir, 'filters-store'), { create: true });
    const backend = filterBackend(bareLimited, { network, birthday, store, watch: [address], crossCheck: [pearld], broadcast: bareAdmin, maxAge: 0 });
    expect(await backend.getUtxos([address])).toEqual([]);
    expect(await backend.status()).toMatchObject({ birthday, mempool: true, transactions: 0 });

    // Paid through the suite's node; the payment reaches the bare node in a block.
    const funding = await fund([{ script: toOutputScript(address, network), value: 9_000_000n }]);
    await followed();
    const tip = await bareLimited.getBestBlock();
    expect(await backend.getUtxos([address])).toMatchObject([{ txid: funding.getId(), vout: 0, value: 9_000_000n, confirmations: 1, address }]);
    expect(await backend.getTransaction(funding.getId())).toEqual({ txid: funding.getId(), block: { height: tip.height, hash: tip.hash, time: expect.any(Number) as number } });
    expect(await backend.getRawTransaction(funding.getId())).toBe(funding.toHex());
    // Without --txindex the node itself does not know it.
    await expect(bareAdmin.getRawTransaction(funding.getId())).rejects.toBeInstanceOf(PearlRpcError);

    // Spent through the backend, which broadcasts on the admin endpoint; the limited user sees it in the mempool.
    const spend = payFromAccount(account, {
      network,
      utxos: [{ txid: funding.getId(), vout: 0, value: 9_000_000n, script: funding.outs[0]!.script, confirmations: 1, index: 0 }],
      recipients: [{ address: account.deriveAddress(1), amount: 4_000_000n }],
      feeRate: FEE_RATE,
      changeAddress: account.deriveAddress(0, true),
    });
    expect(await backend.broadcast(spend.hex)).toBe(spend.txid);
    await backend.watch([account.deriveAddress(1)]);
    expect(await backend.getSpendStatus({ txid: funding.getId(), vout: 0 })).toMatchObject({ status: 'spent', spender: spend.txid });
    expect(await backend.getUtxos([address, account.deriveAddress(1)])).toMatchObject([{ txid: spend.txid, confirmations: 0, value: 4_000_000n }]);
    expect((await backend.status()).pending).toBe(1);
    await pearld.sendRawTransaction(spend.hex).catch(() => spend.txid);
    const [spentIn] = await mine(1);
    await followed();
    expect(await backend.getTransaction(spend.txid)).toMatchObject({ block: { hash: spentIn } });
    expect(await backend.getHistory(address)).toEqual(expect.arrayContaining([expect.objectContaining({ txid: funding.getId() }), expect.objectContaining({ txid: spend.txid })]));

    // The suite's node drops the spend's block and mines a longer branch; the bare node follows and the backend walks back.
    await pearld.invalidateBlock(spentIn!);
    const branch = await mine(2);
    await pearld.reconsiderBlock(spentIn!);
    await followed();
    const moved = await backend.getTransaction(spend.txid);
    expect(moved?.block?.hash).toBe(branch[0]);
    expect((await backend.status()).cursor).toMatchObject({ hash: branch[1] });

    // A new backend over the same store goes on from the cursor and fetches no block it has seen.
    const cursor = (await backend.status()).cursor;
    store.close?.();
    const again = filterBackend(bareLimited, { network, birthday, store: createFileStore(join(live!.dir, 'filters-store'), { breakLock: true }), maxAge: 0 });
    const progress: number[] = [];
    await again.sync({ onProgress: (round) => void progress.push(round.blocksFetched) });
    expect((await again.status()).cursor).toEqual(cursor);
    expect(progress.every((fetched) => fetched === 0)).toBe(true);
    expect(await again.getUtxos([account.deriveAddress(1), account.deriveAddress(0, true)])).toHaveLength(2);
  });

  it('gives a wallet on filterBackend the balance and history of the same wallet on pearldBackend', async () => {
    const mnemonic = generateMnemonic();
    const birthday = await pearld.getBlockCount();
    const viaFilters = await PearlWallet.create({ store: createMemoryStore(), backend: filterBackend(bareLimited, { network, birthday, broadcast: bareAdmin }), mnemonic, passphrase: PASSPHRASE, unlockTimeout: null, kdf: QUICK_KDF });
    const viaIndex = await PearlWallet.create({ ...connection(createMemoryStore(), pearldBackend(pearld, { network })), mnemonic, passphrase: PASSPHRASE, unlockTimeout: null, kdf: QUICK_KDF });
    const first = await viaIndex.receiveAddress();
    const second = await viaFilters.receiveAddress();
    expect(second).toBe(first);
    await payPending(first, 5_000_000n);
    await fund([{ script: toOutputScript(await viaIndex.receiveAddress(), network), value: 6_000_000n }]);
    await viaFilters.receiveAddress();
    await followed();
    await viaFilters.sync();
    const sent = await viaFilters.send({ recipients: [{ address: deriveSigningAccountFromSeed(mnemonicToSeed(generateMnemonic()), network).deriveAddress(0), amount: 2_000_000n }], feeRate: FEE_RATE });
    await eventually(() => pearld.getRawMempool(), (mempool) => mempool.includes(sent.txid));
    await mine(1);
    await followed();
    await viaIndex.sync();
    await viaFilters.sync();
    expect(viaFilters.balance()).toEqual(viaIndex.balance());
    const summary = (wallet: PearlWallet) => wallet.history().map(({ txid, status, amount, block, direction }) => ({ txid, status, amount, block, direction })).sort((a, b) => a.txid.localeCompare(b.txid));
    expect(summary(viaFilters)).toEqual(summary(viaIndex));
    // The fee of a payment received needs the transactions it spends, which a node without --txindex cannot give.
    for (const entry of viaFilters.history()) expect(entry.fee, entry.txid).toBe(entry.direction === 'incoming' ? null : viaIndex.transaction(entry.txid)!.fee);
    expect(viaFilters.coins()).toEqual(viaIndex.coins());
    await viaFilters.close();
    await viaIndex.close();
  });

  it('answers the newer typed pearld methods with what their types say', async () => {
    // A fork: one block invalidated, one mined in its place, and the old one reconsidered.
    const [old] = await mine(1);
    await pearld.invalidateBlock(old!);
    const [replacement] = await mine(1);
    await pearld.reconsiderBlock(old!);
    expect(await pearld.getBestBlockHash()).toBe(replacement);
    expect((await pearld.getChainTips()).find((tip) => tip.hash === old)).toMatchObject({ status: 'valid-fork', branchlen: 1 });
    await expect(pearld.invalidateBlock('00'.repeat(32))).rejects.toMatchObject({ code: 'RPC_ERROR' });

    const totals = await pearld.getNetTotals();
    expect(totals).toMatchObject({ totalbytesrecv: expect.any(BigInt) as bigint, totalbytessent: expect.any(BigInt) as bigint });
    expect(totals.totalbytessent).toBeGreaterThan(0n);
    expect(Math.abs(totals.timemillis - Date.now())).toBeLessThan(60_000);
    expect(await pearld.uptime()).toBeGreaterThan(0);
    expect(await pearld.version()).toHaveProperty('pearldjsonrpcapi');

    // pearld lists an added node once it has connected to it (getAddedNodesMsg in node/server.go).
    await pearld.addNode(bare.p2p, 'add');
    expect(await eventually(() => pearld.getAddedNodeInfo(false), (nodes) => nodes.includes(bare.p2p), 30_000)).toContain(bare.p2p);
    const added = await pearld.getAddedNodeInfo(true, bare.p2p);
    expect(added).toMatchObject([{ addednode: bare.p2p }]);
    const addresses = await pearld.getNodeAddresses(10);
    for (const entry of addresses) expect(entry).toMatchObject({ time: expect.any(Number) as number, services: expect.any(BigInt) as bigint, address: expect.any(String) as string, port: expect.any(Number) as number });
    await pearld.addNode(bare.p2p, 'remove');
    expect(await eventually(() => pearld.getAddedNodeInfo(false), (nodes) => !nodes.includes(bare.p2p), 30_000)).not.toContain(bare.p2p);
    expect(await pearld.verifyChain(3, 20)).toBe(true);

    // The built-in miner, switched on and off on the node without indexes, which has a mining address.
    expect(await bareAdmin.getGenerate()).toBe(false);
    await bareAdmin.setGenerate(true, 1);
    expect(await bareAdmin.getGenerate()).toBe(true);
    await bareAdmin.setGenerate(false);
    expect(await bareAdmin.getGenerate()).toBe(false);

    // createrawtransaction, signed here and sent.
    const account = deriveSigningAccountFromSeed(mnemonicToSeed(generateMnemonic()), network);
    const funding = await fund([{ script: toOutputScript(account.deriveAddress(0), network), value: 8_000_000n }]);
    const to = account.deriveAddress(1);
    const hex = await pearld.createRawTransaction([{ txid: funding.getId(), vout: 0 }], { [to]: 7_990_000n });
    const tx = parseTransaction(hex);
    expect(tx.outs).toMatchObject([{ value: 7_990_000n }]);
    expect(tx.outs[0]!.script).toEqual(toOutputScript(to, network));
    const psbt = createPsbt(tx);
    account.prepareInput(psbt, 0, { index: 0, value: 8_000_000n });
    account.signInput(psbt, 0);
    const signed = finalizePsbt(psbt);
    expect(await pearld.sendRawTransaction(signed.toHex())).toBe(signed.getId());
    await mine(1);

    // A key's legacy message signature, made in the node.
    const wif = encodeWif(sha256(new TextEncoder().encode('pearljs live signmessage')), network);
    const signature = await pearld.signMessageWithPrivKey(wif, 'pearljs');
    expect(Buffer.from(signature, 'base64')).toHaveLength(65);
    expect(await pearld.signMessageWithPrivKey(wif, 'pearljs')).toBe(signature);
  });

  it('refuses a redirect in front of pearld and a reply larger than maxReplySize', async () => {
    const endpoint = live?.pearld ?? nowhere;
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.writeHead(307, { location: endpoint.url });
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const redirected = new PearldClient({ url: `http://127.0.0.1:${port}`, username: endpoint.username, password: endpoint.password });
      const refused = await redirected.getBlockCount().catch((err: unknown) => err);
      expect(refused).toBeInstanceOf(PearlRpcError);
      expect(refused).toMatchObject({ code: 'RPC_HTTP', kind: 'http', message: expect.stringContaining('redirect') as string });
      expect(requests).toBe(1);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }

    const small = new PearldClient({ ...clientOptions(endpoint), maxReplySize: 2000 });
    expect(await small.getBlockCount()).toBeGreaterThan(0);
    const tooLarge = await small.getRawBlock(await pearld.getBestBlockHash()).catch((err: unknown) => err);
    expect(tooLarge).toMatchObject({ name: 'PearlRpcError', code: 'RPC_RESPONSE', message: expect.stringContaining('maxReplySize') as string });
  });

  it('lets the limited user drop a block watcher over the websocket though pearld refuses it stopnotifyblocks', async () => {
    const endpoint = live?.pearld ?? nowhere;
    const agent = trustingAgent(endpoint.ca);
    const ws = new PearlWsClient({ url: endpoint.url, username: live!.limited.username, password: live!.limited.password, WebSocket, webSocketInit: { dispatcher: agent } });
    const errors: Error[] = [];
    ws.on('error', (error) => void errors.push(error));
    try {
      // Every block notification that reaches the client, watched or not.
      const arrived: string[] = [];
      ws.on('blockconnected', (event) => void arrived.push(event.hash));
      const first: string[] = [];
      const offFirst = ws.watchBlocks({ onBlock: (event) => void first.push(event.hash) });
      await ws.call('getblockcount');
      const [a] = await mine(1);
      await eventually(async () => first, (seen) => seen.includes(a!));
      // The last watcher goes: pearljs asks pearld to stop, pearld refuses the limited user, and that is no error.
      offFirst();
      const [b] = await mine(1);
      // pearld keeps sending, and no watcher hears it.
      await eventually(async () => arrived, (seen) => seen.includes(b!));
      const second: string[] = [];
      ws.watchBlocks({ onBlock: (event) => void second.push(event.hash) });
      const [c] = await mine(1);
      await eventually(async () => second, (seen) => seen.includes(c!));
      expect(first).toEqual([a]);
      expect(second).not.toContain(b);
      expect(errors).toEqual([]);
      const refused = await ws.call('stopnotifyblocks').catch((err: unknown) => err);
      expect(isLimitedUserRefusal(refused)).toBe(true);
    } finally {
      await ws.close();
      await agent.close();
    }
  });
});

describeOyster("Oyster's account methods", () => {
  it('answers sendFrom, getAccountAddress, getReceivedByAccount and listReceivedByAccount', async () => {
    await oyster.walletPassphrase('pearljs-live', 600);
    const address = await oyster.getAccountAddress('default');
    expect(await oyster.getAccountAddress('default')).toBe(address);
    const before = await oyster.getReceivedByAccount('default');
    await fund([{ script: toOutputScript(address, network), value: 3_000_000n }]);
    await eventually(() => oyster.getReceivedByAccount('default'), (amount) => amount === before + 3_000_000n);
    expect(await oyster.getReceivedByAccount('default')).toBe(before + 3_000_000n);
    expect((await oyster.listReceivedByAccount()).find((entry) => entry.account === 'default')).toMatchObject({ amount: before + 3_000_000n, confirmations: 1 });
    const recipient = deriveSigningAccountFromSeed(mnemonicToSeed(generateMnemonic()), network).deriveAddress(0);
    const txid = await oyster.sendFrom('default', recipient, 1_000_000n, FEE_RATE);
    const tx = parseTransaction(await pearld.getRawTransactionHex(txid));
    expect(tx.outs.some((out) => out.value === 1_000_000n && Buffer.from(out.script).equals(toOutputScript(recipient, network)))).toBe(true);
    await mine(1);
  });
});
