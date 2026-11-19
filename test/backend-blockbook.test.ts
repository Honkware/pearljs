// blockbookBackend over the simulated Blockbook of pearljs/testing, held to
// the simulated chain it reads: coins, balance, history and spends of P2TR
// and P2MR addresses, a wallet, discovery and an invoice run over it, and a
// server that lies, by rewriting what the simulated one answers.

import { describe, expect, it } from 'vitest';
import {
  BlockbookClient,
  PearlWallet,
  addInputByTxid,
  blockbookBackend,
  createInvoice,
  refreshInvoice,
  createMemoryStore,
  createTransaction,
  customNetwork,
  deriveSigningAccountFromSeed,
  discoverAccount,
  mnemonicToSeed,
  networks,
  p2mrAddress,
  toOutputScript,
  type BlockbookBackendOptions,
} from '../src/index.js';
import { simulatedBlockbook } from '../src/testing.js';
import { FAST_KDF, FakeChain, MNEMONIC, PASSPHRASE, STRANGER, signWithTestWallet } from './wallet-chain.js';

const network = customNetwork(networks.regtest, { coinbaseMaturity: 2 });
const account = deriveSigningAccountFromSeed(mnemonicToSeed(MNEMONIC), network);
const [r0, r1, r2] = [0, 1, 2].map((i) => account.deriveAddress(i)) as [string, string, string];
const c0 = account.deriveAddress(0, true);
const vault = p2mrAddress({ merkleRoot: new Uint8Array(32).fill(7) }, network);
const mine = [r0, r1, r2, c0, vault];

type Rewrite = (path: string, body: unknown) => unknown;

function setup(options: { premine?: number } = {}) {
  const chain = new FakeChain({ network, premine: options.premine ?? 4 });
  return { chain, ...serve(chain) };
}

// A client for the chain's simulated Blockbook, whose JSON replies `rewrite` may change.
function serve(chain: FakeChain, rewrite: { current: Rewrite | null } = { current: null }) {
  const server = simulatedBlockbook(chain);
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const reply = await server.fetch(input, init);
    if (rewrite.current === null || !reply.ok) return reply;
    const path = new URL(String(input)).pathname.slice(1);
    const body = rewrite.current(path, await reply.json());
    return body instanceof Response ? body : new Response(JSON.stringify(body), { status: 200 });
  }) as typeof globalThis.fetch;
  const client = new BlockbookClient({ url: server.url, network, fetch });
  const backend = (options: BlockbookBackendOptions = {}) => blockbookBackend(client, options);
  return { server, client, backend, rewrite };
}

// Blockbook's answer for a transaction it does not have.
const notFound = (txid: string): Response => new Response(JSON.stringify({ error: `Transaction '${txid}' not found` }), { status: 400 });

const sorted = <T extends { txid: string; vout?: number }>(items: T[]) => [...items].sort((a, b) => `${a.txid}:${a.vout ?? 0}`.localeCompare(`${b.txid}:${b.vout ?? 0}`));
const historyOf = (entries: { txid: string; received: bigint; spent?: bigint; block: { height: number } | null }[]) =>
  sorted(entries.map(({ txid, received, spent, block }) => ({ txid, received, spent, height: block?.height ?? null })));

describe('blockbookBackend', () => {
  it('finds coins, balance, history and spends of P2TR and P2MR addresses as the chain holds them', async () => {
    const { chain, backend } = setup();
    const before = chain.pay(r0, 150000000n);
    chain.mine(1, { coinbaseTo: r2 });
    chain.pay(vault, 70000000n);
    chain.pay(r1, 5000000n);
    chain.mine(2);
    // A spend of r0's output to change and a stranger, in the mempool.
    const tx = createTransaction(2);
    addInputByTxid(tx, before.getId(), 0);
    tx.addOutput(toOutputScript(c0, network), 100000000n);
    tx.addOutput(toOutputScript(STRANGER, network), 49990000n);
    const spend = signWithTestWallet(tx, chain.prevouts(tx)!);
    await chain.broadcast(spend.toHex());

    const blockbook = backend();
    expect(sorted(await blockbook.getUtxos(mine))).toEqual(sorted(await chain.getUtxos(mine)));
    expect(await blockbook.getBalance(mine)).toEqual(await chain.getBalance(mine));
    for (const address of mine) {
      expect(historyOf(await blockbook.getHistory(address))).toEqual(historyOf(await chain.getHistory(address)));
      expect(sorted([...(await blockbook.getAddressActivity(address))].map(({ txid, amount }) => ({ txid, amount })))).toEqual(
        sorted([...(await chain.getAddressActivity(address))].map(({ txid, amount }) => ({ txid, amount }))),
      );
    }
    expect((await blockbook.getUtxos([vault])).map(({ value }) => value)).toEqual([70000000n]);
    expect((await blockbook.getUtxos([r2]))[0]).toMatchObject({ coinbase: true });
    expect(await blockbook.getSpendStatus({ txid: before.getId(), vout: 0 })).toEqual({ status: 'spent', spender: tx.getId(), confirmed: false });
    expect(await blockbook.getTip()).toEqual(await chain.getTip());

    chain.mine(1);
    expect(await blockbook.getSpendStatus({ txid: before.getId(), vout: 0 })).toEqual({ status: 'spent', spender: tx.getId(), confirmed: true });
    expect(await blockbook.getSpendStatus({ txid: tx.getId(), vout: 0 })).toEqual({ status: 'unspent', confirmations: 1 });
    expect(await blockbook.getSpendStatus({ txid: tx.getId(), vout: 9 })).toEqual({ status: 'unknown' });
    expect(await blockbook.getSpendStatus({ txid: '11'.repeat(32), vout: 0 })).toEqual({ status: 'unknown' });
    expect(await blockbook.getTransaction(tx.getId())).toEqual(await chain.getTransaction(tx.getId()));
    expect(await blockbook.getRawTransaction(tx.getId())).toBe(spend.toHex());
    expect(await blockbook.getRawTransaction('11'.repeat(32))).toBeNull();
    expect(await blockbook.findUsed([r0, r1, vault, account.deriveAddress(7)])).toEqual([r0, r1, vault]);
  });

  it('broadcasts, and passes on pearld\'s refusal with its code', async () => {
    const { chain, backend } = setup();
    const paid = chain.pay(r0, 150000000n);
    chain.mine(1);
    const tx = createTransaction(2);
    addInputByTxid(tx, paid.getId(), 0);
    tx.addOutput(toOutputScript(STRANGER, network), 149990000n);
    const signed = signWithTestWallet(tx, chain.prevouts(tx)!);
    const blockbook = backend();
    expect(await blockbook.broadcast(signed.toHex())).toBe(signed.getId());
    expect(chain.mempool.has(signed.getId())).toBe(true);
    const greedy = createTransaction(2);
    addInputByTxid(greedy, paid.getId(), 0);
    greedy.addOutput(toOutputScript(STRANGER, network), 149999999n);
    await expect(blockbook.broadcast(signWithTestWallet(greedy, chain.prevouts(greedy)!).toHex())).rejects.toMatchObject({ code: 'RPC_ERROR', rpcCode: -26 });
  });

  it('estimates the chain\'s fee rate, and the floor while pearld has none', async () => {
    const { chain, backend } = setup();
    chain.feeRate = 4321n;
    expect(await backend().estimateFeeRate(3)).toBe(4321n);
    chain.feeRate = null;
    expect(await backend().estimateFeeRate(3)).toBe(1000n);
    expect(await backend({ minFeeRate: 1500n }).estimateFeeRate(3)).toBe(1500n);
  });

  it('syncs a wallet, sends from it and sees the send confirm, as over the chain itself', async () => {
    const { chain, backend } = setup();
    chain.pay(r0, 150000000n);
    chain.mine(1, { coinbaseTo: r2 });
    chain.pay(account.deriveAddress(4), 25000000n);
    chain.mine(2);
    chain.pay(r1, 1000000n);
    const open = (b: Parameters<typeof PearlWallet.create>[0]['backend']) =>
      PearlWallet.create({ store: createMemoryStore(), backend: b, passphrase: PASSPHRASE, mnemonic: MNEMONIC, kdf: FAST_KDF, gapLimit: 10 });
    const viaBlockbook = await open(backend());
    const viaChain = await open(chain);
    await viaBlockbook.sync();
    await viaChain.sync();
    const view = (wallet: PearlWallet) => ({
      balance: wallet.balance(),
      coins: sorted([...wallet.coins()].map(({ txid, vout, value }) => ({ txid, vout, value }))),
      history: wallet.history().map(({ txid }) => txid).sort(),
    });
    expect(view(viaBlockbook)).toEqual(view(viaChain));
    expect(view(viaBlockbook).coins).toHaveLength(4);

    const sent = await viaBlockbook.send({ recipients: [{ address: STRANGER, amount: 30000000n }] });
    expect(chain.mempool.has(sent.txid)).toBe(true);
    chain.mine(1);
    await viaBlockbook.sync();
    await viaChain.sync();
    expect(view(viaBlockbook)).toEqual(view(viaChain));
    await viaBlockbook.close();
    await viaChain.close();
  });

  it('answers a wallet\'s later syncs with one question for every address', async () => {
    const { chain, backend } = setup();
    chain.pay(r0, 8000n);
    chain.mine(1);
    const blockbook = backend();
    const asked = { history: 0, since: 0 };
    const counted = {
      ...blockbook,
      getHistory: (watched: Parameters<typeof blockbook.getHistory>[0]) => (asked.history++, blockbook.getHistory(watched)),
      getActivitySince: (watched: Parameters<typeof blockbook.getActivitySince>[0], after: Parameters<typeof blockbook.getActivitySince>[1]) => (asked.since++, blockbook.getActivitySince(watched, after)),
    };
    const wallet = await PearlWallet.create({ store: createMemoryStore(), backend: counted, passphrase: PASSPHRASE, mnemonic: MNEMONIC, kdf: FAST_KDF, gapLimit: 10 });
    await wallet.sync();
    const before = asked.history;
    chain.pay(r0, 9000n);
    chain.mine(1);
    chain.pay(r0, 1000n);
    await wallet.sync();
    expect(asked).toEqual({ history: before, since: 1 });
    expect(wallet.balance()).toMatchObject({ confirmed: 17000n, unconfirmed: 1000n });
    await wallet.close();
  });

  it('cannot answer since a block that left the chain', async () => {
    const { chain, backend } = setup();
    const blockbook = backend();
    const tip = await blockbook.getTip();
    expect(await blockbook.getActivitySince([r0], tip)).toEqual([]);
    chain.pay(r0, 8000n);
    chain.mine(1);
    expect((await blockbook.getActivitySince([r0], tip))!.map(({ block }) => block?.height)).toEqual([tip.height + 1]);
    chain.reorg(2);
    expect(await blockbook.getActivitySince([r0], tip)).toBeNull();
  });

  it('serves discovery and an invoice', async () => {
    const { chain, backend } = setup();
    chain.pay(account.deriveAddress(3), 40000n);
    chain.mine(1);
    const blockbook = backend();
    const found = await discoverAccount(account, blockbook, { gap: 5 });
    expect(found.utxos.map(({ value }) => value)).toEqual([40000n]);

    const invoice = createInvoice({ id: 'order-1', address: r1, amount: 50000n, createdAt: chain.time, expiresAt: chain.time + 3600, requiredConfirmations: 1 }, network);
    chain.pay(r1, 50000n);
    chain.mine(1);
    expect(await refreshInvoice(invoice, blockbook, chain.time)).toMatchObject({ state: 'confirmed', paidAmount: 50000n, confirmations: 1 });
  });
});

describe('a Blockbook that lies', () => {
  it('refuses a transaction that does not hash to the txid asked for', async () => {
    const { chain, backend, rewrite } = setup();
    const paid = chain.pay(r0, 8000n);
    const other = chain.pay(r1, 9000n);
    rewrite.current = (path, body) => (path === `api/v2/tx/${paid.getId()}` ? { ...(body as object), hex: other.toHex() } : body);
    await expect(backend().getRawTransaction(paid.getId())).rejects.toMatchObject({ code: 'BACKEND_RESPONSE' });
    await expect(backend().getUtxos([r0])).rejects.toMatchObject({ code: 'BACKEND_RESPONSE' });
  });

  it('reads amounts and scripts from the transaction, not the server\'s decoding of it', async () => {
    const { chain, backend, rewrite } = setup();
    chain.pay(r0, 8000n);
    chain.mine(1);
    rewrite.current = (_path, body) => JSON.parse(JSON.stringify(body).replaceAll('"8000"', '"8000000000"'));
    expect((await backend().getBalance([r0])).confirmed).toBe(8000n);
  });

  it('refuses a transaction listed for an address it neither pays nor spends from', async () => {
    const { chain, backend, rewrite } = setup();
    chain.pay(r0, 8000n);
    const stranger = chain.pay(STRANGER, 9000n);
    rewrite.current = (path, body) => {
      if (!path.startsWith(`api/v2/address/${r0}`)) return body;
      const reply = body as { txids?: string[] };
      return reply.txids === undefined ? body : { ...reply, txids: [...reply.txids, stranger.getId()] };
    };
    await expect(backend().getHistory(r0)).rejects.toThrow(/neither pays it nor spends from it/);
  });

  it('refuses a transaction placed in a block that does not hold it, unless told not to look', async () => {
    const { chain, backend, rewrite } = setup();
    chain.pay(r0, 8000n);
    chain.mine(1);
    const elsewhere = chain.blocks[2]!;
    rewrite.current = (path, body) => {
      if (!path.startsWith(`api/v2/address/${r0}`)) return body;
      const reply = body as { transactions?: { blockHash: string; blockHeight: number }[] };
      return { ...reply, transactions: reply.transactions?.map((tx) => ({ ...tx, blockHash: elsewhere.hash, blockHeight: elsewhere.height })) };
    };
    await expect(backend().getHistory(r0)).rejects.toThrow(/which does not hold it/);
    expect((await backend({ verifyBlocks: false }).getHistory(r0))[0]!.block).toMatchObject({ height: 2, hash: elsewhere.hash });
  });

  it('refuses a spender that does not spend the output', async () => {
    const { chain, backend, rewrite } = setup();
    const paid = chain.pay(r0, 8000n);
    const tx = createTransaction(2);
    addInputByTxid(tx, paid.getId(), 0);
    tx.addOutput(toOutputScript(STRANGER, network), 7000n);
    await chain.broadcast(signWithTestWallet(tx, chain.prevouts(tx)!).toHex());
    const unrelated = chain.pay(r1, 5000n);
    chain.mine(1);
    rewrite.current = (path, body) => {
      if (path !== `api/v2/tx/${paid.getId()}`) return body;
      const reply = body as { vout: { n: number }[] };
      return { ...reply, vout: reply.vout.map((out) => (out.n === 0 ? { ...out, spent: true, spentTxId: unrelated.getId() } : out)) };
    };
    await expect(backend().getSpendStatus({ txid: paid.getId(), vout: 0 })).rejects.toThrow(/which it does not spend/);
  });

  it('calls an output spent only when the server names the transaction that spends it', async () => {
    const { chain, backend, rewrite } = setup();
    const paid = chain.pay(r0, 8000n);
    chain.mine(1);
    rewrite.current = (path, body) => {
      if (path !== `api/v2/tx/${paid.getId()}`) return body;
      const reply = body as { vout: { n: number }[] };
      return { ...reply, vout: reply.vout.map((out) => ({ ...out, spent: true })) };
    };
    expect(await backend().getSpendStatus({ txid: paid.getId(), vout: 0 })).toEqual({ status: 'unknown' });
  });

  it('refuses a server for another network', async () => {
    const chain = new FakeChain({ network: networks.testnet2, premine: 1 });
    const server = simulatedBlockbook(chain);
    const client = new BlockbookClient({ url: server.url, network, fetch: server.fetch });
    await expect(blockbookBackend(client).getTip()).rejects.toMatchObject({ code: 'BACKEND_WRONG_NETWORK' });
  });
});

describe('cross-checked against other Blockbooks', () => {
  // Two chains built the same way are the same chain, block for block, until one is told otherwise.
  const twins = () => {
    const a = setup();
    const b = serve(new FakeChain({ network, premine: 4 }));
    return { a, b };
  };

  it('agrees with servers on the same chain', async () => {
    const { a, b } = twins();
    const backend = a.backend({ crossCheck: [b.client] });
    expect(await backend.getTip()).toEqual(await a.chain.getTip());
    expect(await backend.getUtxos([r0])).toEqual([]);
  });

  it('fails when another server lists confirmed transactions the server does not', async () => {
    const a = setup();
    const chainB = new FakeChain({ network, premine: 4 });
    const b = serve(chainB);
    a.chain.mine(1);
    chainB.pay(r0, 8000n);
    chainB.mine(1);
    // Same height, other blocks: the tips disagree first.
    await expect(a.backend({ crossCheck: [b.client] }).getUtxos([r0])).rejects.toMatchObject({ code: 'CROSS_CHECK_FAILED' });

    // The same chain, with the server hiding a payment.
    const c = serve(chainB);
    const hiding = serve(chainB, {
      current: (path, body) => {
        if (!path.startsWith(`api/v2/address/${r0}`)) return body;
        const reply = body as { transactions?: unknown[] };
        return { ...reply, transactions: [] };
      },
    });
    await expect(hiding.backend().getUtxos([r0])).resolves.toEqual([]);
    await expect(hiding.backend({ crossCheck: [c.client] }).getUtxos([r0])).rejects.toThrow(/lists 1 confirmed transactions/);
  });

  it('asks the other servers about a transaction the server says it does not have', async () => {
    const chain = new FakeChain({ network, premine: 4 });
    const paid = chain.pay(r0, 8000n);
    const hiding = serve(chain, { current: (path, body) => (path === `api/v2/tx/${paid.getId()}` ? notFound(paid.getId()) : body) });
    const witness = serve(chain);
    expect(await hiding.backend().getTransaction(paid.getId())).toBeNull();
    expect(await hiding.backend({ crossCheck: [witness.client] }).getTransaction(paid.getId())).toEqual({ txid: paid.getId(), block: null });
    chain.mine(1);
    expect(await hiding.backend({ crossCheck: [witness.client] }).getTransaction(paid.getId())).toMatchObject({ txid: paid.getId(), block: { height: chain.height, hash: chain.tip.hash } });
    expect(await hiding.backend({ crossCheck: [witness.client] }).getTransaction('11'.repeat(32))).toBeNull();
  });

  it('cannot make a wallet take its own pending send for conflicted and pay again', async () => {
    const chain = new FakeChain({ network, premine: 4 });
    const lie: { current: Rewrite | null } = { current: null };
    const primary = serve(chain, lie);
    const wallet = await PearlWallet.create({ store: createMemoryStore(), backend: primary.backend({ crossCheck: [serve(chain).client] }), passphrase: PASSPHRASE, mnemonic: MNEMONIC, kdf: FAST_KDF, gapLimit: 10 });
    chain.pay(r0, 300000000n);
    chain.pay(r1, 300000000n);
    chain.mine(1);
    await wallet.sync();
    const first = await wallet.send({ recipients: [{ address: STRANGER, amount: 200000000n }] });
    const funding = new Set(chain.transaction(first.txid)!.tx.ins.map((input) => Buffer.from(input.hash).reverse().toString('hex')));
    // The send is "not found", its coins "spent" by nothing named, and it is left out of every mempool list.
    lie.current = (path, body) => {
      if (path === `api/v2/tx/${first.txid}`) return notFound(first.txid);
      const tx = /^api\/v2\/tx\/([0-9a-f]{64})$/.exec(path)?.[1];
      const reply = body as { vout?: { spent?: boolean; spentTxId?: string }[]; txids?: string[] };
      if (tx !== undefined && funding.has(tx)) return { ...reply, vout: reply.vout!.map(({ spentTxId: _, ...out }) => ({ ...out, spent: true })) };
      return Array.isArray(reply.txids) ? { ...reply, txids: reply.txids.filter((txid) => txid !== first.txid) } : body;
    };
    const conflicts: unknown[] = [];
    wallet.on('conflict', (event) => conflicts.push(event));
    await wallet.sync();
    expect(conflicts).toEqual([]);
    expect(wallet.transaction(first.txid)).toMatchObject({ status: 'pending' });
    expect(wallet.balance().confirmed).toBe(300000000n);
    await wallet.close();
  });

  it('keeps a send the server calls refused, which it may have relayed, until a sync or abandon settles it', async () => {
    const chain = new FakeChain({ network, premine: 4 });
    const lie: { current: Rewrite | null } = { current: null };
    const primary = serve(chain, lie);
    const wallet = await PearlWallet.create({ store: createMemoryStore(), backend: primary.backend(), passphrase: PASSPHRASE, mnemonic: MNEMONIC, kdf: FAST_KDF, gapLimit: 10 });
    chain.pay(r0, 300000000n);
    chain.mine(1);
    await wallet.sync();
    // The server relays the send and answers with pearld's refusal.
    lie.current = (path, body) => (path === 'api/v2/sendtx/' ? new Response(JSON.stringify({ error: '-26: txn-mempool-conflict' }), { status: 400 }) : body);
    const error = await wallet.send({ recipients: [{ address: STRANGER, amount: 100000000n }] }).catch((err: unknown) => err);
    expect(error).toMatchObject({ code: 'WALLET_BROADCAST_UNCERTAIN', cause: { rpcCode: -26 } });
    const [sent] = [...chain.mempool.keys()];
    expect(wallet.transaction(sent!)).toMatchObject({ status: 'pending', broadcast: false });
    expect(wallet.balance().confirmed).toBe(0n);
    lie.current = null;
    await wallet.sync();
    expect(wallet.transaction(sent!)).toMatchObject({ status: 'pending', missing: false });
    await expect(wallet.abandon(sent!)).rejects.toMatchObject({ code: 'WALLET_TRANSACTION_KNOWN' });
    await wallet.close();
  });

  it('takes a broadcast the server refused as sent when another server has it', async () => {
    const attempt = async (checked: boolean) => {
      const chain = new FakeChain({ network, premine: 4 });
      const paid = chain.pay(r0, 8000n);
      chain.mine(1);
      const tx = createTransaction(2);
      addInputByTxid(tx, paid.getId(), 0);
      tx.addOutput(toOutputScript(STRANGER, network), 7000n);
      const spend = signWithTestWallet(tx, chain.prevouts(tx)!);
      // The server relays the transaction and answers with pearld's refusal.
      const relaying = serve(chain, { current: (path, body) => (path === 'api/v2/sendtx/' ? new Response(JSON.stringify({ error: '-26: txn-mempool-conflict' }), { status: 400 }) : body) });
      const result = await relaying.backend(checked ? { crossCheck: [serve(chain).client] } : {}).broadcast(spend.toHex()).catch((err: unknown) => err);
      expect(chain.mempool.has(spend.getId())).toBe(true);
      return { result, txid: spend.getId() };
    };
    expect((await attempt(false)).result).toMatchObject({ kind: 'rpc', rpcCode: -26 });
    const checked = await attempt(true);
    expect(checked.result).toBe(checked.txid);
  });

  it('holds where a transaction is to the other servers when it does not download blocks', async () => {
    const chain = new FakeChain({ network, premine: 4 });
    const pending = chain.pay(r0, 8000n);
    const tip = chain.tip;
    const witness = serve(chain);
    // A mempool payment shown in the tip block, a real block that does not hold it.
    const confirming = serve(chain, {
      current: (path, body) => (path === `api/v2/tx/${pending.getId()}` ? { ...(body as object), blockHeight: tip.height, blockHash: tip.hash, confirmations: 1 } : body),
    });
    expect(await confirming.backend({ verifyBlocks: false }).getTransaction(pending.getId())).toMatchObject({ block: { height: tip.height } });
    await expect(confirming.backend({ verifyBlocks: false, crossCheck: [witness.client] }).getTransaction(pending.getId())).rejects.toMatchObject({ code: 'CROSS_CHECK_FAILED' });
    // A confirmed payment moved to an older block in an address's history.
    chain.mine(1);
    const older = chain.blocks[2]!;
    const moving = serve(chain, {
      current: (path, body) => {
        if (!path.startsWith(`api/v2/address/${r0}`)) return body;
        const reply = body as { transactions?: { blockHash: string; blockHeight: number }[] };
        return { ...reply, transactions: reply.transactions?.map((tx) => ({ ...tx, blockHash: older.hash, blockHeight: older.height })) };
      },
    });
    expect((await moving.backend({ verifyBlocks: false }).getHistory(r0))[0]!.block).toMatchObject({ height: older.height });
    await expect(moving.backend({ verifyBlocks: false, crossCheck: [witness.client] }).getHistory(r0)).rejects.toMatchObject({ code: 'CROSS_CHECK_FAILED' });
    expect((await serve(chain).backend({ verifyBlocks: false, crossCheck: [witness.client] }).getHistory(r0))[0]!.block).toMatchObject({ height: chain.height, hash: chain.tip.hash });
  });

  it('reads no further than the lowest server, and fails when they are too far apart', async () => {
    const a = setup();
    const chainB = new FakeChain({ network, premine: 4 });
    const b = serve(chainB);
    a.chain.mine(3);
    chainB.mine(1);
    expect((await a.backend({ crossCheck: [b.client] }).getTip()).height).toBe(chainB.height);
    await expect(a.backend({ crossCheck: [b.client], crossCheckLag: 1 }).getTip()).rejects.toMatchObject({ code: 'CROSS_CHECK_FAILED' });
  });
});
