// blockbookBackend with useXpub, over the simulated Blockbook's xpub query:
// what a first and a later sync cost against one query per address, that
// the wallet ends where the per-address path leaves it, and that a hint
// that lies is caught or costs no more than an omission already could.

import { describe, expect, it } from 'vitest';
import {
  BlockbookClient,
  PearlWallet,
  addInputByTxid,
  blockbookBackend,
  createMemoryStore,
  createTransaction,
  customNetwork,
  deriveAccountFromSeed,
  discoverAccount,
  mnemonicToSeed,
  networks,
  toOutputScript,
  type BlockbookBackendOptions,
} from '../src/index.js';
import { simulatedBlockbook } from '../src/testing.js';
import { FakeChain, MNEMONIC, STRANGER, signWithTestWallet } from './wallet-chain.js';

const network = customNetwork(networks.regtest, { coinbaseMaturity: 2 });
const account = deriveAccountFromSeed(mnemonicToSeed(MNEMONIC), network);
const XPUB = account.extendedPublicKey();
const receive = (index: number) => account.deriveAddress(index);
const change = (index: number) => account.deriveAddress(index, true);

type Token = { name: string; path: string; transfers: number };
type Reply = { tokens?: Token[]; transactions?: { txid: string; blockHash?: string }[]; unconfirmedTxs: number };

// A server over the chain whose xpub replies `edit` may change, and whose xpub queries `ask` may rewrite first.
function serve(chain: FakeChain, hooks: { edit?: (reply: Reply) => void; ask?: (url: URL) => void; refuse?: boolean } = {}) {
  const server = simulatedBlockbook(chain);
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const xpub = url.pathname.startsWith('/api/v2/xpub/');
    if (xpub && hooks.refuse === true) return new Response('{"error":"Internal server error"}', { status: 500 });
    if (xpub) hooks.ask?.(url);
    const reply = await server.fetch(url, init);
    if (!xpub || hooks.edit === undefined || !reply.ok) return reply;
    const body = (await reply.json()) as Reply;
    hooks.edit(body);
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof globalThis.fetch;
  const client = new BlockbookClient({ url: server.url, network, fetch });
  return { server, client, backend: (options: BlockbookBackendOptions = {}) => blockbookBackend(client, options) };
}

// Receive 0, 1 and 4 paid and confirmed, receive 0 spent to change 0, change 0 spent to change 1 and receive 9 paid in
// the mempool: a gap on the receive chain, use of the change chain, and an address used only in the mempool.
function scenario(): FakeChain {
  const chain = new FakeChain({ network, premine: 4 });
  const first = chain.pay(receive(0), 150000000n);
  chain.pay(receive(1), 20000000n);
  chain.pay(receive(4), 30000000n);
  chain.mine(1);
  const spend = createTransaction(2);
  addInputByTxid(spend, first.getId(), 0);
  spend.addOutput(toOutputScript(change(0), network), 100000000n);
  spend.addOutput(toOutputScript(STRANGER, network), 49990000n);
  const signed = signWithTestWallet(spend, chain.prevouts(spend)!);
  chain.mine(1, { include: [signed] });
  const again = createTransaction(2);
  addInputByTxid(again, signed.getId(), 0);
  again.addOutput(toOutputScript(change(1), network), 60000000n);
  again.addOutput(toOutputScript(STRANGER, network), 39990000n);
  chain.mine(1, { include: [signWithTestWallet(again, chain.prevouts(again)!)] });
  chain.pay(receive(9), 7000000n);
  return chain;
}

const open = (backend: ReturnType<typeof blockbookBackend>, gapLimit = 250) => PearlWallet.create({ store: createMemoryStore(), backend, watchOnly: XPUB, gapLimit, now: () => 1_800_000_000_000 });
const stateOf = (wallet: PearlWallet) => ({ balance: wallet.balance(), coins: wallet.coins(), history: wallet.history(), accounts: wallet.accounts(), addresses: wallet.addresses().length });
const kinds = (requests: readonly string[]) => {
  const count: Record<string, number> = {};
  for (const path of requests) {
    const key = /^api\/v2\/([a-z-]+)\//.exec(path)?.[1] ?? 'status';
    count[key] = (count[key] ?? 0) + 1;
  }
  return count;
};

describe('blockbookBackend with useXpub', () => {
  it('syncs a new wallet in a few dozen requests where one query an address takes over five hundred, and ends in the same state', async () => {
    const chain = scenario();
    const plain = serve(chain);
    const perAddress = await open(plain.backend());
    await perAddress.sync();
    const firstBefore = plain.server.requests.length;
    plain.server.requests.length = 0;
    await perAddress.sync();
    const laterBefore = plain.server.requests.length;

    const hinted = serve(chain);
    const wallet = await open(hinted.backend({ useXpub: true }));
    await wallet.sync();
    const firstAfter = hinted.server.requests.length;
    expect(kinds(hinted.server.requests).xpub).toBe(2);
    const first = [...hinted.server.requests];
    hinted.server.requests.length = 0;
    await wallet.sync();
    const laterAfter = hinted.server.requests.length;

    expect(stateOf(wallet)).toEqual(stateOf(perAddress));
    expect(wallet.balance().total).toBe(30000000n + 20000000n + 60000000n + 7000000n);
    expect(firstBefore).toBeGreaterThan(500);
    // Receive 9 is used only in the mempool, which the server's gap does not count from, so receive 255 to 259 are
    // asked address by address.
    expect(first.filter((path) => path.endsWith('details=basic'))).toHaveLength(5);
    expect(firstAfter).toBeLessThanOrEqual(50);
    expect(laterBefore).toBeGreaterThan(45);
    expect(laterAfter).toBeLessThanOrEqual(15);
  });

  it('takes in a block and a mempool transaction after the last sync as the per-address queries do, in a fraction of the requests', async () => {
    const chain = scenario();
    const plain = serve(chain);
    const perAddress = await open(plain.backend());
    const hinted = serve(chain);
    const wallet = await open(hinted.backend({ useXpub: true }));
    await perAddress.sync();
    await wallet.sync();
    chain.mine(1);
    chain.pay(change(1), 1000000n);
    chain.pay(receive(12), 2000000n);
    chain.mine(1);
    chain.pay(receive(3), 3000000n);
    plain.server.requests.length = 0;
    hinted.server.requests.length = 0;
    await perAddress.sync();
    await wallet.sync();
    expect(stateOf(wallet)).toEqual(stateOf(perAddress));
    expect(wallet.balance().unconfirmed).toBe(3000000n);
    // The rest are the tip, transactions and blocks, coins' addresses and the addresses the new indices bring into view.
    expect(plain.server.requests.length).toBeGreaterThan(140);
    expect(hinted.server.requests.length).toBeLessThanOrEqual(55);
  });

  it('never sends the account key unless asked to', async () => {
    const chain = scenario();
    const { server, backend } = serve(chain);
    const wallet = await open(backend());
    await wallet.sync();
    chain.mine(1);
    await wallet.sync();
    expect(server.requests.filter((path) => path.includes('xpub'))).toEqual([]);
  });

  it('asks address by address past what a server with a smaller gap derived, and finds funds there', async () => {
    const chain = scenario();
    chain.pay(receive(40), 5000000n);
    chain.mine(1);
    const perAddress = await open(serve(chain).backend(), 50);
    await perAddress.sync();
    // A server that derives no more than 5 unused addresses past the last used, whatever it is asked for.
    const small = serve(chain, { ask: (url) => url.searchParams.set('gap', String(Math.min(Number(url.searchParams.get('gap')), 5))) });
    const wallet = await open(small.backend({ useXpub: true }), 50);
    await wallet.sync();
    expect(stateOf(wallet)).toEqual(stateOf(perAddress));
    expect(wallet.balance().total).toBe(perAddress.balance().total);
    expect(perAddress.addresses().some((item) => item.address === receive(40))).toBe(true);
    // The server derives receive 0 to 14 (5 past receive 9) and change 0 to 8 (at least to the receive chain's last
    // used index, as xpubScanAddresses does); the rest of each chain's scan, receive 15 to 90 and change 9 to 51, is
    // asked one address at a time.
    const basic = small.server.requests.filter((path) => path.endsWith('details=basic')).length;
    expect(basic).toBe(76 + 43);
  });

  it('takes the server\'s word that an index is used no further than the history that address has', async () => {
    const chain = scenario();
    const perAddress = await open(serve(chain).backend());
    await perAddress.sync();
    const lying = serve(chain, {
      edit: (reply) => {
        for (const token of reply.tokens ?? []) if (/\/0\/(2|3|30)$/.test(token.path)) token.transfers = 1;
      },
    });
    const wallet = await open(lying.backend({ useXpub: true }));
    await wallet.sync();
    expect(stateOf(wallet)).toEqual(stateOf(perAddress));
    // Read as the hint said: receive 2, 3 and 30 had their histories read, and no index the server derived was asked about by itself.
    for (const index of [2, 3, 30]) expect(lying.server.requests).toContain(`api/v2/address/${receive(index)}?pageSize=1000&from=8&details=txids`);
    expect(lying.server.requests.filter((path) => path.endsWith('details=basic'))).toHaveLength(5);
  });

  it('misses an address the hint leaves out, as a server leaving out its history would, unless a cross-check server lists it', async () => {
    const chain = scenario();
    const perAddress = await open(serve(chain).backend());
    await perAddress.sync();
    const hiding = (reply: Reply) => {
      for (const token of reply.tokens ?? []) if (token.path.endsWith('/0/4')) token.transfers = 0;
    };
    const alone = await open(serve(chain, { edit: hiding }).backend({ useXpub: true }));
    await alone.sync();
    expect(alone.balance().total).toBe(perAddress.balance().total - 30000000n);

    const checked = await open(serve(chain, { edit: hiding }).backend({ useXpub: true, crossCheck: [serve(chain).client] }));
    await checked.sync();
    expect(stateOf(checked)).toEqual(stateOf(perAddress));
  });

  it('refuses a hint whose address at a path is not the one the account derives there', async () => {
    const chain = scenario();
    const swapped = serve(chain, {
      edit: (reply) => {
        const [a, b] = [reply.tokens?.find((token) => token.path.endsWith('/0/1')), reply.tokens?.find((token) => token.path.endsWith('/0/2'))];
        if (a !== undefined && b !== undefined) [a.path, b.path] = [b.path, a.path];
      },
    });
    await expect((await open(swapped.backend({ useXpub: true }))).sync()).rejects.toMatchObject({ code: 'BACKEND_RESPONSE', message: expect.stringMatching(/derives .* at m\/86'\/1'\/0'\/0\/1, where the account has/) });

    const stranger = serve(chain, {
      edit: (reply) => {
        const token = reply.tokens?.find((item) => item.path.endsWith('/1/0'));
        if (token !== undefined) token.name = STRANGER;
      },
    });
    await expect((await open(stranger.backend({ useXpub: true }))).sync()).rejects.toMatchObject({ code: 'BACKEND_RESPONSE', message: expect.stringContaining(`derives ${STRANGER}`) });

    const twice = serve(chain, {
      edit: (reply) => {
        if (reply.tokens !== undefined) reply.tokens.push({ ...reply.tokens[0]! });
      },
    });
    await expect((await open(twice.backend({ useXpub: true }))).sync()).rejects.toThrow(/lists two addresses at m\/86'\/1'\/0'\/0\/0/);
  });

  it('holds what the account\'s history lists after the last sync to the blocks and to the cross-check servers', async () => {
    const chain = scenario();
    const hooks: { edit?: (reply: Reply) => void } = {};
    const wallet = await open(serve(chain, hooks).backend({ useXpub: true }));
    const witness = serve(chain, hooks);
    const checked = await open(serve(chain).backend({ useXpub: true, crossCheck: [witness.client] }));
    await wallet.sync();
    await checked.sync();
    const paid = chain.pay(receive(2), 4000000n);
    chain.mine(1);

    hooks.edit = (reply) => {
      for (const tx of reply.transactions ?? []) if (tx.txid === paid.getId()) tx.blockHash = chain.blocks[2]!.hash;
    };
    await expect(wallet.sync()).rejects.toMatchObject({ code: 'BACKEND_RESPONSE' });
    hooks.edit = (reply) => {
      if (reply.transactions !== undefined) reply.transactions = reply.transactions.filter((tx) => tx.txid !== paid.getId());
    };
    // The block also confirms the mempool payment to receive 9.
    await expect(checked.sync()).rejects.toMatchObject({ code: 'CROSS_CHECK_FAILED', message: expect.stringMatching(/^cross-check server 1 lists 1 confirmed transactions for an account from height \d+ to \d+, where the server lists 2$/) });
    delete hooks.edit;
    await wallet.sync();
    await checked.sync();
    expect(wallet.balance().total).toBe(117000000n + 4000000n);
    expect(stateOf(checked)).toEqual(stateOf(wallet));
  });

  it('asks address by address when the server will not answer the xpub query', async () => {
    const chain = scenario();
    const perAddress = await open(serve(chain).backend());
    await perAddress.sync();
    const refusing = serve(chain, { refuse: true });
    const wallet = await open(refusing.backend({ useXpub: true }));
    await wallet.sync();
    expect(stateOf(wallet)).toEqual(stateOf(perAddress));
  });

  it('discovers an account by its key in one query and finds what the per-address scan finds', async () => {
    const chain = scenario();
    const plain = serve(chain);
    const hinted = serve(chain);
    const expected = await discoverAccount(account, plain.backend());
    const found = await discoverAccount(account, hinted.backend({ useXpub: true }));
    expect(found).toEqual(expected);
    expect(found.receive.nextIndex).toBe(10);
    expect(found.change.nextIndex).toBe(2);
    expect(kinds(hinted.server.requests)).toMatchObject({ xpub: 2 });
    // The server's gap counts from receive 4, the last confirmed use; receive 9 is used in the mempool only.
    expect(hinted.server.requests.filter((path) => path.endsWith('details=basic'))).toEqual([255, 256, 257, 258, 259].map((index) => `api/v2/address/${receive(index)}?details=basic`));
  });
});
