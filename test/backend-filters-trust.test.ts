// What filterBackend accepts from a node that lies, over the scripted node
// of test/filter-node.ts: a block hash of the node's choosing served with
// the honest filter bytes, which hides a payment or, with a ground header,
// shows one that never existed; a block served under a real hash with other
// witnesses or another certificate; an anchor no other node has; a
// cross-check endpoint that is behind, unreachable or on another chain; and
// the node's word on a transaction the scan did not find.

import { describe, expect, it } from 'vitest';
import {
  blockHash,
  calculateMerkleRoot,
  createTransaction,
  customNetwork,
  deriveSigningAccountFromSeed,
  filterBackend,
  filterKey,
  matchAnyFilter,
  mnemonicToSeed,
  networks,
  parseTransaction,
  toOutputScript,
  type FilterBackend,
  type PearlBlock,
  type PearlBlockHeader,
} from '../src/index.js';
import { FakeNode } from './filter-node.js';
import { FakeChain, MNEMONIC, STRANGER } from './wallet-chain.js';

const network = customNetwork(networks.regtest, { coinbaseMaturity: 2 });
const account = deriveSigningAccountFromSeed(mnemonicToSeed(MNEMONIC), network);
const r0 = account.deriveAddress(0);
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
const display = (hash: Uint8Array): string => hex(Uint8Array.from(hash).reverse());

function setup() {
  const chain = new FakeChain({ network, premine: 4 });
  return { chain, node: new FakeNode(chain) };
}

const backendFor = (node: FakeNode, extra: Partial<Parameters<typeof filterBackend>[1]> = {}): FilterBackend =>
  filterBackend(node, { network, birthday: 3, maxAge: 0, batchSize: 4, watch: [r0], ...extra });

// The block with another header, its certificate bound to it as a miner's would be.
function reheader(block: PearlBlock, edit: Partial<PearlBlockHeader>): PearlBlock {
  const header = { ...block.header, ...edit };
  return { ...block, header, certificate: { ...block.certificate!, hash: blockHash(header) } };
}

const rejection = (promise: Promise<unknown>): Promise<unknown> => promise.then(() => null, (err: unknown) => err);

describe('filterBackend and a node that lies', () => {
  it('refuses a block hash the headers do not link, which would hide a payment under the honest filter', async () => {
    const { chain, node } = setup();
    chain.pay(r0, 9000n);
    chain.mine(4);
    const real = node.blocks()[5]!.block;
    node.forged.set(5, { block: reheader(real, { timestamp: real.header.timestamp + 1 }) });
    expect(await rejection(backendFor(node, { crossCheck: [new FakeNode(chain), new FakeNode(chain)] }).sync())).toMatchObject({ code: 'BLOCK_HEADER_INVALID' });
    // As the last block of a round the link is to the next round, and the endpoints catch it first.
    const lastOfRound = backendFor(node, { batchSize: 3, crossCheck: [new FakeNode(chain)] });
    expect(await rejection(lastOfRound.sync())).toMatchObject({ code: 'CROSS_CHECK_FAILED', message: expect.stringContaining('cross-check endpoint 1 has block') });
    expect((await backendFor(new FakeNode(chain)).getBalance([r0])).confirmed).toBe(9000n);
  });

  it('shows a ground block at the tip when nothing cross-checks it, and refuses it when one honest endpoint does', async () => {
    const { chain, node } = setup();
    chain.mine(4);
    const tip = node.blocks().at(-1)!;
    // Many watched scripts make the grind short: the honest filter only has to match one of them under the forged key.
    const decoys = Array.from({ length: 3000 }, (_, i) => Uint8Array.of(0x51, 0x20, ...new Uint8Array(28), i >> 8, i & 0xff, 1, 2));
    const coinbase = createTransaction(1);
    coinbase.addInput(new Uint8Array(32), 0xffffffff, 0xffffffff, Uint8Array.of(1, tip.height));
    coinbase.addOutput(toOutputScript(STRANGER, network), 1n);
    const forgedPayment = createTransaction(2);
    forgedPayment.addInput(new Uint8Array(32).fill(7), 0);
    forgedPayment.addOutput(toOutputScript(r0, network), 1000n * 100_000_000n);
    const transactions = [coinbase, forgedPayment];
    let forged = reheader({ ...tip.block, transactions }, { merkleRoot: calculateMerkleRoot(transactions) });
    for (let t = tip.block.header.timestamp; !matchAnyFilter(tip.filter, filterKey(display(blockHash(forged.header))), decoys); t += 1) {
      forged = reheader(forged, { timestamp: t });
    }
    node.forged.set(tip.height, { block: forged });

    const alone = backendFor(node, { watch: [r0, ...decoys], batchSize: 10 });
    expect(await alone.getBalance([r0])).toEqual({ confirmed: 100_000_000_000n, unconfirmed: 0n, immature: 0n });
    const checked = backendFor(node, { watch: [r0, ...decoys], batchSize: 10, crossCheck: [new FakeNode(chain)] });
    expect(await rejection(checked.getBalance([r0]))).toMatchObject({ code: 'CROSS_CHECK_FAILED' });
  });

  it('refuses a block served under its real hash with other witnesses or another certificate', async () => {
    for (const change of ['witness', 'certificate'] as const) {
      const { chain, node } = setup();
      chain.pay(r0, 9000n);
      chain.mine(1);
      const real = node.blocks()[5]!;
      const transactions = real.block.transactions.map((tx) => parseTransaction(tx.toHex()));
      if (change === 'witness') transactions[1]!.setWitness(0, [new Uint8Array(64).fill(9)]);
      const certificate = change === 'certificate' ? { ...real.block.certificate!, publicData: new Uint8Array(164).fill(1) } : real.block.certificate;
      node.servedBlocks.set(real.hash, { ...real.block, transactions, certificate });
      expect(await rejection(backendFor(node).sync())).toMatchObject({ code: change === 'witness' ? 'BLOCK_WITNESS_COMMITMENT_INVALID' : 'BLOCK_CERTIFICATE_INVALID' });
    }
  });

  it('refuses an anchor the cross-check endpoints do not have', async () => {
    const { chain, node } = setup();
    const real = node.blocks()[4]!.block;
    node.forged.set(4, { block: reheader(real, { timestamp: real.header.timestamp + 1 }), ownFilter: true });
    const backend = backendFor(node, { birthday: 5, crossCheck: [new FakeNode(chain)] });
    expect(await rejection(backend.sync())).toMatchObject({ code: 'CROSS_CHECK_FAILED', message: expect.stringContaining('at height 4') });
  });

  it('scans only as far as a cross-check endpoint that is behind, and fails when the tips are too far apart', async () => {
    const { chain, node } = setup();
    chain.mine(12);
    const late = new FakeNode(chain);
    late.behind = 3;
    const backend = backendFor(node, { crossCheck: [late] });
    expect(await backend.sync()).toMatchObject({ height: 13 });
    late.behind = 0;
    expect(await backend.sync()).toMatchObject({ height: 16 });

    late.behind = 7;
    expect(await rejection(backendFor(node, { crossCheck: [late] }).sync())).toMatchObject({ code: 'CROSS_CHECK_FAILED', message: expect.stringContaining('crossCheckLag (6)') });
    // A node keeping the last blocks from the wallet is held to the same bound.
    late.behind = 0;
    node.behind = 3;
    expect(await rejection(backendFor(node, { crossCheck: [late], crossCheckLag: 2 }).sync())).toMatchObject({ code: 'CROSS_CHECK_FAILED' });
    expect(() => backendFor(node, { crossCheckLag: -1 })).toThrow(RangeError);
  });

  it('fails the sync when a cross-check endpoint follows another chain or cannot be reached', async () => {
    const { chain, node } = setup();
    chain.mine(4);
    const other = new FakeNode(chain);
    const real = other.blocks()[8]!.block;
    other.forged.set(8, { block: reheader(real, { timestamp: real.header.timestamp + 1 }), ownFilter: true });
    expect(await rejection(backendFor(node, { crossCheck: [new FakeNode(chain), other] }).sync())).toMatchObject({
      code: 'CROSS_CHECK_FAILED',
      message: expect.stringContaining('cross-check endpoint 2 has block'),
    });
    const down = new FakeNode(chain);
    down.down = true;
    expect(await rejection(backendFor(node, { crossCheck: [down] }).sync())).toMatchObject({ code: 'CROSS_CHECK_FAILED', message: expect.stringContaining('could not be asked') });
  });

  it('takes the node\'s word that a transaction is confirmed only for a block the scan confirmed and that holds it', async () => {
    const { chain, node } = setup();
    const elsewhere = chain.pay(STRANGER, 5000n);
    chain.mine(2);
    const loose = chain.pay(STRANGER, 6000n);
    const backend = backendFor(node);
    expect(await backend.getTransaction(elsewhere.getId())).toMatchObject({ block: { height: 5 } });
    node.misplaced.set(loose.getId(), 6);
    expect(await backend.getTransaction(loose.getId())).toBeNull();
  });

  it('refuses a raw transaction other than the one asked for', async () => {
    const { chain, node } = setup();
    const one = chain.pay(STRANGER, 5000n);
    const two = chain.pay(STRANGER, 6000n);
    const backend = backendFor(node);
    await backend.sync();
    const swapped = { ...node, call: async <T,>(method: string, params: readonly unknown[] = []): Promise<T> => node.call<T>(method, method === 'getrawtransaction' && params[0] === one.getId() ? [two.getId(), ...params.slice(1)] : params) };
    expect(await rejection(filterBackend(swapped, { network, birthday: 3, maxAge: 0 }).getRawTransaction(one.getId()))).toMatchObject({ code: 'BACKEND_RESPONSE' });
  });
});
