// A scripted chain for invoice tests: blocks with header times, a mempool,
// reorgs and double spends, answering as a ChainClient would. Every call is
// counted so tests can bound what a refresh costs.

import type { AddressPayment, BlockRef, ChainClient, ChainTransaction } from '../src/client.js';

interface Block {
  ref: BlockRef;
  txids: string[];
}

interface Tx {
  outputs: Map<string, bigint>;
  /** When the transaction first reached the node. */
  seenAt: number;
}

export class ScriptedChain implements ChainClient {
  blocks: Block[] = [];
  readonly mempool = new Set<string>();
  readonly txs = new Map<string, Tx>();
  readonly calls = { getTip: 0, getAddressActivity: 0, getTransaction: 0 };
  /** Report each transaction's seenAt, as an indexer that keeps mempool arrival times does. */
  reportSeenAt = false;
  /** Report header times; a backend that cannot leaves them out. */
  reportTimes = true;
  #forks = 0;

  constructor(start = { height: 99, time: 900 }) {
    this.blocks.push({ ref: { height: start.height, hash: `h${start.height}`, time: start.time }, txids: [] });
  }

  get tip(): BlockRef {
    return this.blocks.at(-1)!.ref;
  }

  /** A transaction paying the given addresses enters the mempool at `at`. */
  broadcast(txid: string, outputs: Record<string, bigint>, at: number): void {
    this.txs.set(txid, { outputs: new Map(Object.entries(outputs)), seenAt: at });
    this.mempool.add(txid);
  }

  /** Mines a block with header time `time` holding the given mempool transactions, or all of them. */
  mine(time: number, txids: readonly string[] = [...this.mempool]): BlockRef {
    const height = this.tip.height + 1;
    const ref = { height, hash: `h${height}${this.#forks === 0 ? '' : `f${this.#forks}`}`, time };
    for (const txid of txids) this.mempool.delete(txid);
    this.blocks.push({ ref, txids: [...txids] });
    return ref;
  }

  /** A transaction mined straight into a new block, never in the mempool first. */
  mineDirect(txid: string, outputs: Record<string, bigint>, time: number): BlockRef {
    this.txs.set(txid, { outputs: new Map(Object.entries(outputs)), seenAt: time });
    return this.mine(time, [txid]);
  }

  /** Disconnects the top `depth` blocks; their transactions return to the mempool. */
  disconnect(depth: number): void {
    this.#forks++;
    for (let i = 0; i < depth && this.blocks.length > 1; i++) {
      for (const txid of this.blocks.pop()!.txids) this.mempool.add(txid);
    }
  }

  /** A transaction is double spent away: gone from the mempool and every block. */
  drop(txid: string): void {
    this.mempool.delete(txid);
    for (const block of this.blocks) block.txids = block.txids.filter((t) => t !== txid);
    this.txs.delete(txid);
  }

  /** Grains the chain view shows paid to an address, confirmed or not. */
  paidTo(address: string): bigint {
    let sum = 0n;
    for (const [txid, block] of this.#where()) if (block !== undefined || this.mempool.has(txid)) sum += this.txs.get(txid)!.outputs.get(address) ?? 0n;
    return sum;
  }

  #where(): Map<string, BlockRef | undefined> {
    const where = new Map<string, BlockRef | undefined>();
    for (const block of this.blocks) for (const txid of block.txids) where.set(txid, block.ref);
    for (const txid of this.mempool) where.set(txid, undefined);
    return where;
  }

  #ref(block: BlockRef | undefined): BlockRef | null {
    if (block === undefined) return null;
    return this.reportTimes ? block : { height: block.height, hash: block.hash };
  }

  getTip(): Promise<BlockRef> {
    this.calls.getTip++;
    return Promise.resolve(this.tip);
  }

  getAddressActivity(address: string): Promise<readonly AddressPayment[]> {
    this.calls.getAddressActivity++;
    const payments: AddressPayment[] = [];
    for (const [txid, block] of this.#where()) {
      const tx = this.txs.get(txid)!;
      const amount = tx.outputs.get(address);
      if (amount === undefined) continue;
      payments.push({ txid, amount, block: this.#ref(block), ...(this.reportSeenAt ? { seenAt: tx.seenAt } : {}) });
    }
    return Promise.resolve(payments);
  }

  getTransaction(txid: string): Promise<ChainTransaction | null> {
    this.calls.getTransaction++;
    const where = this.#where();
    return Promise.resolve(where.has(txid) ? { txid, block: this.#ref(where.get(txid)) } : null);
  }
}

/** A seeded generator, so a failing property case repeats. */
export function random(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
}
