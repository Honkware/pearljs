// pearldBackend finds P2MR addresses by matching block filters, since
// pearld's address index holds Taproot only. One walk serves every P2MR
// address the backend knows: these tests count what it asks pearld for.

import { describe, expect, it } from 'vitest';
import { PearldClient, assembleScriptTree, checksigScript, fromOutputScript, p2mr, parsePearl, pearldBackend } from '../src/index.js';
import type { Rpc } from '../src/index.js';
import { FakeNode } from './filter-node.js';
import { FakeChain } from './wallet-chain.js';

const prl = (text: string): bigint => parsePearl(text);

function keyAddress(chain: FakeChain, fill: number): string {
  return fromOutputScript(p2mr({ merkleRoot: assembleScriptTree([checksigScript(new Uint8Array(32).fill(fill))]).root }).output, chain.network);
}

// pearld over the chain, keeping the height of every filter and the hash of every block asked for.
function recording(chain: FakeChain) {
  const node = new FakeNode(chain);
  const filters: number[] = [];
  const blocks: string[] = [];
  let onFilter: (() => void) | null = null;
  const rpc: Rpc = {
    call: <T>(method: string, params: readonly unknown[] = []): Promise<T> => {
      if (method === 'getcfilter') {
        filters.push(chain.blocks.findIndex((block) => block.hash === params[0]));
        onFilter?.();
      }
      if (method === 'getblock') blocks.push(params[0] as string);
      return node.call<T>(method, params);
    },
  };
  const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, i) => from + i);
  return { node, rpc, filters, blocks, range, take: () => filters.splice(0), whenFiltering: (run: () => void) => (onFilter = run) };
}

const sorted = (heights: readonly number[]): number[] => [...heights].sort((a, b) => a - b);
const received = async (backend: ReturnType<typeof pearldBackend>, address: string) => (await backend.getHistory(address)).map((entry) => [entry.block?.height ?? null, entry.received]);

describe('the P2MR filter walk of pearldBackend', () => {
  it('asks for each block filter once for addresses with different starts', async () => {
    const chain = new FakeChain();
    const [a, b, c] = [1, 2, 3].map((fill) => keyAddress(chain, fill)) as [string, string, string];
    chain.mine(5);
    const bornB = chain.height + 1;
    chain.pay(a, prl('1'));
    chain.pay(b, prl('2'));
    chain.mine(5);
    const bornC = chain.height + 1;
    chain.pay(c, prl('3'));
    chain.mine();
    const node = recording(chain);
    const backend = pearldBackend(node.rpc, { network: chain.network, scanFrom: 2 });
    backend.setAddressBirths!(new Map([[b, { height: bornB }], [c, { height: bornC }]]));
    const utxos = await backend.getUtxos([a, b, c]);
    expect(utxos.map((utxo) => [utxo.address, utxo.value]).sort()).toEqual([[a, prl('1')], [b, prl('2')], [c, prl('3')]].sort());
    expect(sorted(node.filters)).toEqual(node.range(2, chain.height));
  });

  it('asks for each block filter once for more addresses than it queries at a time', async () => {
    const chain = new FakeChain();
    const addresses = [1, 2, 3, 4, 5].map((fill) => keyAddress(chain, fill));
    for (const address of addresses) chain.pay(address, prl('1'));
    chain.mine();
    const node = recording(chain);
    const backend = pearldBackend(node.rpc, { network: chain.network, concurrency: 2 });
    expect(await backend.getUtxos(addresses)).toHaveLength(5);
    expect(sorted(node.filters)).toEqual(node.range(0, chain.height));
  });

  it('fetches a block that pays two addresses once', async () => {
    const chain = new FakeChain();
    const [a, b] = [1, 2].map((fill) => keyAddress(chain, fill)) as [string, string];
    chain.pay(a, prl('1'));
    chain.pay(b, prl('2'));
    const [paid] = chain.mine();
    const node = recording(chain);
    const backend = pearldBackend(node.rpc, { network: chain.network });
    expect(await backend.getBalance([a, b])).toMatchObject({ confirmed: prl('3') });
    expect(node.blocks.filter((hash) => hash === paid!.hash)).toHaveLength(1);
  });

  it('scans an address asked about after a walk over only its own uncovered range, and finds its payment in a block walked for another', async () => {
    const chain = new FakeChain();
    const [a, b] = [1, 2].map((fill) => keyAddress(chain, fill)) as [string, string];
    const bornB = chain.height - 10;
    chain.pay(b, prl('2'));
    const [paidB] = chain.mine();
    chain.pay(a, prl('1'));
    chain.mine();
    const node = recording(chain);
    const backend = pearldBackend(node.rpc, { network: chain.network });
    expect(await received(backend, a)).toEqual([[chain.height, prl('1')]]);
    const walked = chain.height;
    expect(sorted(node.take())).toEqual(node.range(0, walked));
    chain.mine(3);
    backend.setAddressBirths!(new Map([[b, { height: bornB }]]));
    const [forA, forB] = await Promise.all([received(backend, a), received(backend, b)]);
    expect(forA).toEqual([[walked, prl('1')]]);
    expect(forB).toEqual([[paidB!.height, prl('2')]]);
    // b's blocks up to where a's scan stood, then the new blocks once for both.
    expect(sorted(node.take())).toEqual(node.range(bornB, chain.height));
    expect(await received(backend, b)).toEqual([[paidB!.height, prl('2')]]);
    expect(node.filters).toEqual([]);
  });

  it('starts every address over after a reorganization under the last block walked', async () => {
    const chain = new FakeChain();
    const [a, b] = [1, 2].map((fill) => keyAddress(chain, fill)) as [string, string];
    const toA = chain.pay(a, prl('1'));
    chain.pay(b, prl('2'));
    chain.mine(3);
    const node = recording(chain);
    const backend = pearldBackend(node.rpc, { network: chain.network });
    await Promise.all([received(backend, a), received(backend, b)]);
    node.take();
    // The new branch drops a's payment for a conflict and confirms b's again.
    chain.reorg(4, { replace: [toA.getId()] });
    const [forA, forB] = await Promise.all([received(backend, a), received(backend, b)]);
    expect(forA).toEqual([]);
    expect(forB).toEqual([[chain.height - 4, prl('2')]]);
    expect(sorted(node.take())).toEqual(node.range(0, chain.height));
  });

  it('shares one walk among concurrent getHistory calls, and carries along an address given a birth', async () => {
    const chain = new FakeChain();
    const [a, b, c, d] = [1, 2, 3, 4].map((fill) => keyAddress(chain, fill)) as [string, string, string, string];
    for (const [address, amount] of [[a, '1'], [b, '2'], [c, '3'], [d, '4']] as const) {
      chain.pay(address, prl(amount));
      chain.mine();
    }
    const node = recording(chain);
    const backend = pearldBackend(node.rpc, { network: chain.network });
    backend.setAddressBirths!(new Map([[d, null]]));
    const histories = await Promise.all([a, b, c].map((address) => received(backend, address)));
    expect(histories).toEqual([1, 2, 3].map((i) => [[chain.height - 4 + i, prl(String(i))]]));
    expect(sorted(node.take())).toEqual(node.range(0, chain.height));
    expect(await received(backend, d)).toEqual([[chain.height, prl('4')]]);
    expect(node.filters).toEqual([]);
  });

  it('walks the filters of eight blocks a round trip through a batching client', async () => {
    const chain = new FakeChain();
    const address = keyAddress(chain, 1);
    chain.pay(address, prl('1'));
    chain.mine();
    const node = new FakeNode(chain);
    let posts = 0;
    const client = new PearldClient({
      batch: true,
      transport: {
        origin: 'fake',
        async send(body: string) {
          posts += 1;
          type Call = { id: number; method: string; params: unknown[] };
          const parsed = JSON.parse(body) as Call | Call[];
          const answer = async ({ id, method, params }: Call) => ({ result: await node.call(method, params), error: null, id });
          return wire(Array.isArray(parsed) ? await Promise.all(parsed.map(answer)) : await answer(parsed));
        },
      },
    });
    expect(await pearldBackend(client, { network: chain.network }).getHistory(address)).toHaveLength(1);
    // One for every eight blocks, and the tip, the first hashes, the paying block, the mempool and its transactions, and the height of the payment.
    expect(posts).toBeLessThanOrEqual(Math.ceil((chain.height + 1) / 8) + 6);
  });
});

// A reply as pearld writes it: amounts in PRL with eight decimals.
function wire(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => (typeof item === 'bigint' ? `amount:${item}` : item)).replace(/"amount:(\d+)"/g, (_match, grains: string) => {
    const digits = grains.padStart(9, '0');
    return `${digits.slice(0, -8)}.${digits.slice(-8)}`;
  });
}
