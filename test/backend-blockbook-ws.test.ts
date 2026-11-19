// blockbookBackend over Blockbook's websocket alone, as a page must use
// Pearl's servers, which send no CORS headers on REST: the same answers as
// over the chain itself with no REST request made, verifyBlocks refused,
// spends found with and without the extended index, the fee floor, and
// cross-checks between websocket servers.

import { describe, expect, it } from 'vitest';
import {
  BlockbookClient,
  BlockbookWsClient,
  PearlWallet,
  addInputByTxid,
  blockbookBackend,
  createMemoryStore,
  createTransaction,
  customNetwork,
  deriveSigningAccountFromSeed,
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

let servers = 0;
// A websocket client for the chain's simulated Blockbook, under a host of its own.
function serve(chain: FakeChain, options: { extendedIndex?: boolean } = {}) {
  const server = simulatedBlockbook(chain, options);
  const ws = new BlockbookWsClient({ url: `wss://blockbook-ws-${++servers}.example/websocket`, network, WebSocket: server.WebSocket, keepAlive: 0 });
  const backend = (more: BlockbookBackendOptions = {}) => blockbookBackend(ws, { verifyBlocks: false, ...more });
  return { server, ws, backend };
}

const sorted = <T extends { txid: string; vout?: number }>(items: T[]) => [...items].sort((a, b) => `${a.txid}:${a.vout ?? 0}`.localeCompare(`${b.txid}:${b.vout ?? 0}`));
const historyOf = (entries: { txid: string; received: bigint; spent?: bigint; block: { height: number; hash: string } | null }[]) =>
  sorted(entries.map(({ txid, received, spent, block }) => ({ txid, received, spent, block: block === null ? null : `${block.height}:${block.hash}` })));

// r0 paid, then spent to change and a stranger; the vault and r1 paid; r2 given a coinbase.
function stocked(options: { extendedIndex?: boolean } = {}) {
  const chain = new FakeChain({ network, premine: 4 });
  const paid = chain.pay(r0, 150000000n);
  chain.mine(1, { coinbaseTo: r2 });
  chain.pay(vault, 70000000n);
  chain.pay(r1, 5000000n);
  chain.mine(2);
  const tx = createTransaction(2);
  addInputByTxid(tx, paid.getId(), 0);
  tx.addOutput(toOutputScript(c0, network), 100000000n);
  tx.addOutput(toOutputScript(STRANGER, network), 49990000n);
  const spend = signWithTestWallet(tx, chain.prevouts(tx)!);
  return { chain, paid, spend, ...serve(chain, options) };
}

describe('blockbookBackend over the websocket alone', () => {
  it('refuses to claim it verifies blocks', () => {
    const { ws } = serve(new FakeChain({ network, premine: 1 }));
    expect(() => blockbookBackend(ws)).toThrow(/serves no raw blocks.*verifyBlocks: false/);
    expect(() => blockbookBackend(ws, { verifyBlocks: true })).toThrow(TypeError);
  });

  it('finds coins, balance, history and spends of P2TR and P2MR addresses as the chain holds them, with no REST request', async () => {
    const { chain, paid, spend, server, backend } = stocked();
    await chain.broadcast(spend.toHex());
    const blockbook = backend();
    expect(sorted(await blockbook.getUtxos(mine))).toEqual(sorted(await chain.getUtxos(mine)));
    expect(await blockbook.getBalance(mine)).toEqual(await chain.getBalance(mine));
    for (const address of mine) expect(historyOf(await blockbook.getHistory(address))).toEqual(historyOf(await chain.getHistory(address)));
    expect(await blockbook.getSpendStatus({ txid: paid.getId(), vout: 0 })).toEqual({ status: 'spent', spender: spend.getId(), confirmed: false });
    expect(await blockbook.getTip()).toEqual(await chain.getTip());
    chain.mine(1);
    expect(await blockbook.getSpendStatus({ txid: paid.getId(), vout: 0 })).toEqual({ status: 'spent', spender: spend.getId(), confirmed: true });
    expect(await blockbook.getSpendStatus({ txid: spend.getId(), vout: 0 })).toEqual({ status: 'unspent', confirmations: 1 });
    expect(await blockbook.getSpendStatus({ txid: '11'.repeat(32), vout: 0 })).toEqual({ status: 'unknown' });
    expect(await blockbook.getTransaction(spend.getId())).toEqual(await chain.getTransaction(spend.getId()));
    expect(await blockbook.findUsed([r0, r1, vault, account.deriveAddress(7)])).toEqual([r0, r1, vault]);
    expect(server.requests).toEqual([]);
  });

  it('finds a confirmed spender in the address history when the server has no extended index to name it', async () => {
    const { chain, paid, spend, backend } = stocked({ extendedIndex: false });
    await chain.broadcast(spend.toHex());
    chain.mine(1);
    const reply = await serve(chain, { extendedIndex: false }).ws.getTransaction(paid.getId());
    expect(reply.vout[0]).toMatchObject({ spent: true });
    expect(reply.vout[0]).not.toHaveProperty('spentTxId');
    expect(await backend().getSpendStatus({ txid: paid.getId(), vout: 0 })).toEqual({ status: 'spent', spender: spend.getId(), confirmed: true });
  });

  it('syncs a wallet, sends from it and sees the send confirm, with no REST request', async () => {
    const { chain, server, backend } = stocked();
    const wallet = await PearlWallet.create({ store: createMemoryStore(), backend: backend(), passphrase: PASSPHRASE, mnemonic: MNEMONIC, kdf: FAST_KDF, gapLimit: 10 });
    const twin = await PearlWallet.create({ store: createMemoryStore(), backend: chain, passphrase: PASSPHRASE, mnemonic: MNEMONIC, kdf: FAST_KDF, gapLimit: 10 });
    await wallet.sync();
    await twin.sync();
    expect(wallet.balance()).toEqual(twin.balance());
    const sent = await wallet.send({ recipients: [{ address: STRANGER, amount: 30000000n }] });
    expect(chain.mempool.has(sent.txid)).toBe(true);
    chain.mine(1);
    await wallet.sync();
    await twin.sync();
    expect(wallet.balance()).toEqual(twin.balance());
    expect(wallet.history().find((entry) => entry.txid === sent.txid)).toMatchObject({ status: 'confirmed' });
    expect(server.requests).toEqual([]);
    await wallet.close();
    await twin.close();
  });

  it('falls back to the fee floor, since a Pearl server refuses the websocket\'s estimateFee', async () => {
    const { backend } = stocked();
    expect(await backend({ minFeeRate: 3000n }).estimateFeeRate(6)).toBe(3000n);
  });

  it('agrees with websocket and REST servers on the same chain, and fails against one on another', async () => {
    const { chain, backend } = stocked();
    const rest = simulatedBlockbook(chain);
    const restClient = new BlockbookClient({ url: 'https://blockbook-rest.example/', network, fetch: rest.fetch });
    const agreeing = backend({ crossCheck: [serve(chain).ws, restClient] });
    expect(sorted(await agreeing.getUtxos(mine))).toEqual(sorted(await chain.getUtxos(mine)));

    // Built the same way, then one block apart: another chain at the height read to.
    const other = new FakeChain({ network, premine: 4 });
    other.pay(r0, 150000000n);
    other.mine(1, { coinbaseTo: r2 });
    other.pay(vault, 70000000n);
    other.mine(2, { coinbaseTo: r1 });
    await expect(backend({ crossCheck: [serve(other).ws] }).getUtxos(mine)).rejects.toMatchObject({ code: 'CROSS_CHECK_FAILED' });
  });

  it('refuses the server itself as a cross-check server', () => {
    const { ws } = serve(new FakeChain({ network, premine: 1 }));
    expect(() => blockbookBackend(ws, { verifyBlocks: false, crossCheck: [ws] })).toThrow(/twice/);
  });
});
