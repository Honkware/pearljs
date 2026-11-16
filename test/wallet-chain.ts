// A scripted chain for wallet tests: a WalletBackend and TransactionSource
// over blocks and a mempool held in memory, with steps a test can take (pay
// an address, mine, reorg, double-spend, drop from the mempool). It checks
// no scripts or signatures, only that outputs exist and are spent once, and
// it applies pearld's replacement rule in its simplest form: a mempool
// conflict is evicted when it signalled replacement and the newcomer pays
// more.

import {
  PearlRpcError,
  PearlWallet,
  createMemoryStore,
  addInputByTxid,
  createTransaction,
  fromOutputScript,
  networks,
  parseTransaction,
  signalsReplacement,
  sumBalance,
  toOutputScript,
} from '../src/index.js';
import type {
  ActivityScanner,
  AddressHistoryEntry,
  AddressPayment,
  BlockRef,
  SpendStatus,
  Transaction,
  TransactionSource,
  WalletBackend,
  WalletStore,
  WalletUtxo,
  Watched,
} from '../src/index.js';

const network = networks.regtest;
const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const prevTxid = (input: Transaction['ins'][number]): string => hex(Uint8Array.from(input.hash).reverse());
const key = (txid: string, vout: number): string => `${txid}:${vout}`;

export const MNEMONIC = `${'abandon '.repeat(11)}about`;
export const PASSPHRASE = 'correct horse battery staple';
export const FAST_KDF = { N: 2 ** 10 };
export async function newWallet(chain: FakeChain, options: { store?: WalletStore; gapLimit?: number } = {}): Promise<PearlWallet> {
  return PearlWallet.create({
    store: options.store ?? createMemoryStore(),
    backend: chain,
    transactions: chain,
    passphrase: PASSPHRASE,
    mnemonic: MNEMONIC,
    kdf: FAST_KDF,
    gapLimit: options.gapLimit ?? 10,
  });
}

/** An address no wallet in the tests owns. */
export const STRANGER = 'rprl1p8dhv8twyj9ezfvk62vvsfgw39s4dgl9t42y0549dc4d2947jj4cs30wfpz';

interface Block {
  hash: string;
  height: number;
  txs: Transaction[];
}

export class FakeChain implements WalletBackend, TransactionSource {
  readonly network = network;
  blocks: Block[] = [];
  mempool = new Map<string, Transaction>();
  feeRate = 2000n;
  /** Make the next broadcast fail as a dropped connection would, not as a node refusal. */
  failNextBroadcast = false;
  calls = new Map<string, number>();
  #counter = 0;

  constructor() {
    this.mine(1);
  }

  get height(): number {
    return this.blocks.length - 1;
  }

  // ---- steps

  /** A payment from outside the wallet, into the mempool. */
  pay(address: string, value: bigint, options: { rbf?: boolean } = {}): Transaction {
    const tx = createTransaction(2);
    addInputByTxid(tx, this.#fresh(), 0, options.rbf === true ? 0xfffffffd : 0xffffffff);
    tx.addOutput(toOutputScript(address, network), value);
    tx.setWitness(0, [new Uint8Array(64)]);
    this.#accept(tx, true);
    return tx;
  }

  /** Mines blocks, the mempool going into the first one, in order; a coinbase pays coinbaseTo if given. */
  mine(count = 1, options: { coinbaseTo?: string; value?: bigint; include?: Transaction[]; skipMempool?: boolean } = {}): BlockRef[] {
    const refs: BlockRef[] = [];
    for (let i = 0; i < count; i += 1) {
      const height = this.blocks.length;
      const coinbase = createTransaction(1);
      coinbase.addInput(new Uint8Array(32), 0xffffffff, 0xffffffff, Uint8Array.from([3, height & 0xff, (height >> 8) & 0xff, this.#counter++ & 0xff]));
      coinbase.addOutput(toOutputScript(options.coinbaseTo ?? STRANGER, network), options.value ?? 50_0000_0000n);
      const txs = [coinbase];
      if (i === 0) {
        for (const tx of options.include ?? []) txs.push(tx);
        if (options.skipMempool !== true) {
          txs.push(...this.mempool.values());
          this.mempool.clear();
        }
      }
      const block = { hash: this.#hash(), height, txs };
      this.blocks.push(block);
      refs.push({ height, hash: block.hash });
    }
    return refs;
  }

  /**
   * Takes the top `depth` blocks off and mines `depth + 1` new ones. Their
   * transactions go back to the mempool and into the first new block (or stay
   * in the mempool with keepInMempool), except those in `replace`: for each, a transaction spending the same
   * outputs to a stranger is mined instead, so it and its descendants vanish.
   */
  reorg(depth: number, options: { replace?: string[]; mine?: number; keepInMempool?: boolean } = {}): void {
    const removed = this.blocks.splice(this.blocks.length - depth, depth);
    const returning = removed.flatMap((block) => block.txs.filter((tx) => !tx.isCoinbase()));
    const pool = [...returning, ...this.mempool.values()];
    this.mempool.clear();
    const replacements: Transaction[] = [];
    for (const txid of options.replace ?? []) {
      const original = pool.find((tx) => tx.getId() === txid);
      if (original === undefined) throw new Error(`no transaction ${txid} to replace`);
      replacements.push(this.#conflicting(original));
    }
    const dropped = new Set(options.replace ?? []);
    for (const tx of pool) {
      if (tx.ins.some((input) => dropped.has(prevTxid(input))) || dropped.has(tx.getId())) {
        dropped.add(tx.getId());
        continue;
      }
      this.mempool.set(tx.getId(), tx);
    }
    this.mine(options.mine ?? depth + 1, { include: replacements, skipMempool: options.keepInMempool === true });
  }

  /** Spends the inputs of a transaction to a stranger instead, evicting it, and mines that unless mine is false. */
  doubleSpend(txid: string, options: { mine?: boolean } = {}): Transaction {
    const original = this.mempool.get(txid);
    if (original === undefined) throw new Error(`${txid} is not in the mempool`);
    const conflict = this.#conflicting(original);
    this.#evict(txid);
    this.mempool.set(conflict.getId(), conflict);
    if (options.mine !== false) this.mine(1);
    return conflict;
  }

  /** Forgets a mempool transaction and its descendants, as an evicting node would. */
  drop(txid: string): void {
    this.#evict(txid);
  }

  // ---- WalletBackend

  async getTip(): Promise<BlockRef> {
    this.#count('getTip');
    const top = this.blocks[this.blocks.length - 1]!;
    return { height: top.height, hash: top.hash };
  }

  async getTransaction(txid: string): Promise<{ txid: string; block: BlockRef | null } | null> {
    this.#count('getTransaction');
    const found = this.#find(txid);
    return found === null ? null : { txid, block: found.block };
  }

  async getRawTransaction(txid: string): Promise<string | null> {
    this.#count('getRawTransaction');
    return this.#find(txid)?.tx.toHex() ?? null;
  }

  async getAddressActivity(address: string): Promise<AddressPayment[]> {
    const script = hex(toOutputScript(address, network));
    return this.#all()
      .map(({ tx, block }) => ({
        txid: tx.getId(),
        amount: tx.outs.filter((out) => hex(out.script) === script).reduce((sum, out) => sum + out.value, 0n),
        block,
      }))
      .filter((payment) => payment.amount > 0n);
  }

  async getHistory(watched: Watched): Promise<AddressHistoryEntry[]> {
    this.#count('getHistory');
    const script = hex(typeof watched === 'string' ? toOutputScript(watched, network) : watched);
    const outputs = new Map<string, bigint>();
    for (const { tx } of this.#all()) {
      tx.outs.forEach((out, vout) => {
        if (hex(out.script) === script) outputs.set(key(tx.getId(), vout), out.value);
      });
    }
    const history: AddressHistoryEntry[] = [];
    for (const { tx, block } of this.#all()) {
      const received = tx.outs.filter((out) => hex(out.script) === script).reduce((sum, out) => sum + out.value, 0n);
      const spent = tx.ins.reduce((sum, input) => sum + (outputs.get(key(prevTxid(input), input.index)) ?? 0n), 0n);
      if (received > 0n || spent > 0n) history.push({ txid: tx.getId(), block, received, spent });
    }
    return history;
  }

  async getUtxos(watched: readonly Watched[]): Promise<WalletUtxo[]> {
    this.#count('getUtxos');
    const scripts = new Set(watched.map((item) => hex(typeof item === 'string' ? toOutputScript(item, network) : item)));
    const spent = this.#spentBy();
    const utxos: WalletUtxo[] = [];
    for (const { tx, block } of this.#all()) {
      tx.outs.forEach((out, vout) => {
        const script = Uint8Array.from(out.script);
        if (!scripts.has(hex(script)) || spent.has(key(tx.getId(), vout))) return;
        utxos.push({
          txid: tx.getId(),
          vout,
          value: out.value,
          script,
          address: fromOutputScript(script, network),
          confirmations: block === null ? 0 : this.height - block.height + 1,
          coinbase: tx.isCoinbase(),
        });
      });
    }
    return utxos;
  }

  async getBalance(watched: readonly Watched[]) {
    return sumBalance(await this.getUtxos(watched), network.coinbaseMaturity);
  }

  async broadcast(raw: string | Uint8Array): Promise<string> {
    this.#count('broadcast');
    if (this.failNextBroadcast) {
      this.failNextBroadcast = false;
      throw new PearlRpcError('network', 'sendrawtransaction', 'connection reset');
    }
    const tx = typeof raw === 'string' ? parseTransaction(raw) : parseTransaction(hex(raw));
    this.#accept(tx, false);
    return tx.getId();
  }

  async estimateFeeRate(): Promise<bigint> {
    return this.feeRate;
  }

  async getSpendStatus(outpoint: { txid: string; vout: number }): Promise<SpendStatus> {
    this.#count('getSpendStatus');
    for (const { tx, block } of this.#all()) {
      if (tx.ins.some((input) => prevTxid(input) === outpoint.txid && input.index === outpoint.vout)) {
        return { status: 'spent', spender: tx.getId(), confirmed: block !== null };
      }
    }
    const found = this.#find(outpoint.txid);
    if (found === null || found.tx.outs[outpoint.vout] === undefined) return { status: 'unknown' };
    return { status: 'unspent', confirmations: found.block === null ? 0 : this.height - found.block.height + 1 };
  }

  /**
   * What an ActivityScanner answers: the transactions in blocks after `after`, and in the mempool,
   * that pay or spend from the watched addresses; null when `after` is not on this chain. A wallet
   * uses it only when it is installed as getActivitySince, which withActivityScanner does.
   */
  async activitySince(watched: readonly Watched[], after: BlockRef): Promise<{ txid: string; block: BlockRef | null }[] | null> {
    this.#count('getActivitySince');
    if (this.blocks[after.height]?.hash !== after.hash) return null;
    const scripts = new Set(watched.map((item) => hex(typeof item === 'string' ? toOutputScript(item, network) : item)));
    const paying = new Set<string>();
    for (const { tx } of this.#all()) tx.outs.forEach((out, vout) => void (scripts.has(hex(out.script)) && paying.add(key(tx.getId(), vout))));
    return this.#all()
      .filter(({ block }) => block === null || block.height > after.height)
      .filter(({ tx }) => tx.outs.some((out) => scripts.has(hex(out.script))) || tx.ins.some((input) => paying.has(key(prevTxid(input), input.index))))
      .map(({ tx, block }) => ({ txid: tx.getId(), block }));
  }

  // ---- internals

  #count(name: string): void {
    this.calls.set(name, (this.calls.get(name) ?? 0) + 1);
  }

  #fresh(): string {
    this.#counter += 1;
    return this.#counter.toString(16).padStart(8, '0').repeat(8);
  }

  #hash(): string {
    this.#counter += 1;
    return `b10c${this.#counter.toString(16).padStart(60, '0')}`;
  }

  #all(): { tx: Transaction; block: BlockRef | null }[] {
    const list: { tx: Transaction; block: BlockRef | null }[] = [];
    for (const block of this.blocks) for (const tx of block.txs) list.push({ tx, block: { height: block.height, hash: block.hash } });
    for (const tx of this.mempool.values()) list.push({ tx, block: null });
    return list;
  }

  #find(txid: string): { tx: Transaction; block: BlockRef | null } | null {
    return this.#all().find(({ tx }) => tx.getId() === txid) ?? null;
  }

  #spentBy(): Map<string, string> {
    const spent = new Map<string, string>();
    for (const { tx } of this.#all()) for (const input of tx.ins) spent.set(key(prevTxid(input), input.index), tx.getId());
    return spent;
  }

  #fee(tx: Transaction): bigint {
    let total = 0n;
    for (const input of tx.ins) {
      const parent = this.#find(prevTxid(input));
      total += parent?.tx.outs[input.index]?.value ?? 0n;
    }
    return total - tx.outs.reduce((sum, out) => sum + out.value, 0n);
  }

  #accept(tx: Transaction, external: boolean): void {
    const txid = tx.getId();
    const known = this.#find(txid);
    if (known !== null) {
      if (external) return;
      // pearld's answers for a transaction it already holds (node/mempool/mempool.go:1389, node/rpcserver.go:3585).
      if (known.block === null) throw new PearlRpcError('rpc', 'sendrawtransaction', `TX rejected: already have transaction in mempool ${txid}`, { rpcCode: -26 });
      throw new PearlRpcError('rpc', 'sendrawtransaction', 'TX rejected: transaction already exists in blockchain', { rpcCode: -27 });
    }
    const spent = this.#spentBy();
    const evict = new Set<string>();
    for (const input of tx.ins) {
      const parentId = prevTxid(input);
      const parent = this.#find(parentId);
      if (parent === null) {
        if (external) continue;
        throw new PearlRpcError('rpc', 'sendrawtransaction', `TX rejected: orphan transaction ${txid} references outputs of unknown or fully-spent transaction ${parentId}`, { rpcCode: -25 });
      }
      if (parent.tx.outs[input.index] === undefined) throw new PearlRpcError('rpc', 'sendrawtransaction', `TX rejected: orphan transaction ${txid} references an output that does not exist`, { rpcCode: -25 });
      const spender = spent.get(key(parentId, input.index));
      if (spender === undefined) continue;
      const other = this.mempool.get(spender);
      if (other === undefined) throw new PearlRpcError('rpc', 'sendrawtransaction', `output already spent: ${parentId}:${input.index}`, { rpcCode: -26 });
      if (!signalsReplacement(other) || this.#fee(tx) <= this.#fee(other)) {
        throw new PearlRpcError('rpc', 'sendrawtransaction', `output already spent in mempool: ${parentId}:${input.index}`, { rpcCode: -26 });
      }
      evict.add(spender);
    }
    for (const id of evict) this.#evict(id);
    this.mempool.set(txid, tx);
  }

  #evict(txid: string): void {
    if (!this.mempool.delete(txid)) return;
    for (const [id, tx] of [...this.mempool]) if (tx.ins.some((input) => prevTxid(input) === txid)) this.#evict(id);
  }

  // Spends the same outputs to a stranger, paying a little more fee than the original.
  #conflicting(original: Transaction): Transaction {
    const tx = createTransaction(2);
    for (const input of original.ins) addInputByTxid(tx, prevTxid(input), input.index);
    const total = original.outs.reduce((sum, out) => sum + out.value, 0n);
    tx.addOutput(toOutputScript(STRANGER, network), total - 1000n > 0n ? total - 1000n : total);
    tx.ins.forEach((_, i) => tx.setWitness(i, [new Uint8Array(64).fill(9)]));
    return tx;
  }
}

/** The same chain as a backend that can answer for every address at once. */
export function withActivityScanner(chain: FakeChain): FakeChain & ActivityScanner {
  return Object.assign(chain, { getActivitySince: chain.activitySince.bind(chain) });
}
