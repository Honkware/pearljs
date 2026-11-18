// A chain held in memory for tests: blocks with real headers, a coinbase
// that commits to its witnesses, a UTXO set with undo data so blocks can be
// taken off again, and a mempool that admits what pearld's would
// (maybeAcceptTransaction in node/mempool/mempool.go), in pearld's order
// and with its messages. Nothing here talks to a network or proves a block.

import { fromOutputScript, toOutputScript } from '../address.js';
import type { FeeRate } from '../amount.js';
import { sumBalance } from '../backend.js';
import type { AddressHistoryEntry, SpendStatus, WalletBackend, WalletBalance, WalletUtxo, Watched } from '../backend.js';
import { blockVsize, calculateMerkleRoot, certificateProofCommitment, parseBlock } from '../block.js';
import type { PearlBlock } from '../block.js';
import { blockHash, blockHashHex } from '../blockheader.js';
import type { PearlBlockHeader } from '../blockheader.js';
import type { AddressPayment, BlockRef, ChainTransaction } from '../client.js';
import { blockSubsidy, requiredCertVersion } from '../consensus.js';
import { sha256 } from '../crypto.js';
import { PearlError, PearlRpcError, PolicyError } from '../errors.js';
import { buildBasicFilter, filterHeader } from '../gcs.js';
import type { CompactFilter } from '../gcs.js';
import { verifyTransaction } from '../interpreter.js';
import { concat, fromHex, toHex } from '../internal/bytes.js';
import { rpcError } from '../internal/rpc-wire.js';
import type { PearlSigningAccount } from '../keys.js';
import { deriveSigningAccountFromSeed } from '../keys.js';
import { mnemonicToSeed } from '../mnemonic.js';
import { networks } from '../networks.js';
import type { PearlNetwork } from '../networks.js';
import { DEFAULT_RELAY_FEE_RATE, checkSanity, checkStandard, feeForVsize } from '../policy.js';
import { checkPackageLimits, checkReplacement } from '../rbf.js';
import type { PearldRpc } from '../rpc.js';
import {
  LOCKTIME_THRESHOLD,
  SEQUENCE_LOCKTIME_DISABLED,
  SEQUENCE_LOCKTIME_GRANULARITY,
  SEQUENCE_LOCKTIME_IS_SECONDS,
  SEQUENCE_LOCKTIME_MASK,
  encodeScriptNumber,
  scriptPush,
} from '../script.js';
import { createPsbt, createTransaction, finalizePsbt, parseTransaction } from '../transaction.js';
import type { Transaction, TxOutput } from '../transaction.js';
import type { TransactionSource } from '../wallet.js';
import { GENESIS_BLOCKS } from './genesis.js';
import { FAUCET_MNEMONIC } from './keys.js';
import { simulatedRpc } from './rpc.js';
import { simulatedWebSocket } from './socket.js';
import type { SimulatedWebSocket } from './socket.js';

const key = (txid: string, vout: number): string => `${txid}:${vout}`;
const prevTxid = (input: Transaction['ins'][number]): string => toHex(Uint8Array.from(input.hash).reverse());
const outpointOf = (input: Transaction['ins'][number]): string => key(prevTxid(input), input.index);
const display = (hash: Uint8Array): string => toHex(Uint8Array.from(hash).reverse());

// The codes handleSendRawTransaction answers with.
const TX_ERROR = -25;
const TX_REJECTED = -26;
const TX_IN_CHAIN = -27;
const MEDIAN_TIME_BLOCKS = 11;
// The refusals of CheckTransactionStandard (node/mempool/policy.go), which the mempool words as "is not standard".
const STANDARDNESS = new Set(['POLICY_VERSION', 'POLICY_NOT_FINAL', 'POLICY_TX_TOO_LARGE', 'POLICY_SIGSCRIPT_SIZE', 'POLICY_SIGSCRIPT_NOT_PUSH_ONLY', 'POLICY_DUST', 'POLICY_MULTIPLE_NULLDATA']);
// The faucet's share of a coinbase is cut into this many coins, so many payments can be made before any waits on change.
const FAUCET_SPLIT = 4;
const FINAL_SEQUENCE = 0xffffffff;
const RBF_SEQUENCE = 0xfffffffd;
const WITNESS_MAGIC = Uint8Array.from([0x6a, 0x24, 0xaa, 0x21, 0xa9, 0xed]);
// A BIP86 key-path input: 41 bytes of outpoint, sequence and empty script, a 66-byte witness.
const KEY_PATH_INPUT_WEIGHT = 41 * 4 + 66;
const P2TR_OUTPUT_SIZE = 43;

/** What a simulated node says when it refuses a transaction or a request: pearld's code and text. */
export class SimulatedRefusal extends Error {
  override name = 'SimulatedRefusal';
  readonly rpcCode: number;

  constructor(rpcCode: number, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.rpcCode = rpcCode;
  }

  /** The text sendrawtransaction puts in its error for a transaction the mempool refused. */
  get clientMessage(): string {
    return this.rpcCode <= TX_ERROR && this.rpcCode >= TX_IN_CHAIN ? `TX rejected: ${this.message}` : this.message;
  }
}

/** An unspent output of the simulated chain. */
export interface SimulatedCoin extends TxOutput {
  /** Height of the block that holds it. */
  height: number;
  coinbase: boolean;
}

/** One block of a simulated chain. */
export interface SimulatedBlock {
  /** Display-order hex, as RPC shows it. */
  readonly hash: string;
  readonly height: number;
  /** Hash of the block before, display-order hex; all zeros for genesis. */
  readonly parent: string;
  /** The header's timestamp, Unix seconds. */
  readonly time: number;
  readonly block: PearlBlock;
  /** The block's transactions, coinbase first. */
  readonly txs: readonly Transaction[];
  /** What its transactions paid in fees, in grain. */
  readonly fees: bigint;
}

/** A transaction in the simulated mempool. */
export interface SimulatedMempoolEntry {
  readonly tx: Transaction;
  /** In grain. */
  readonly fee: bigint;
  readonly vsize: number;
  /** Simulated clock when it was accepted, Unix seconds. */
  readonly time: number;
  /** Chain height when it was accepted. */
  readonly height: number;
}

/** What a simulated chain tells its listeners, in the order things happen. */
export type SimulatedEvent =
  | { type: 'connected'; block: SimulatedBlock }
  | { type: 'disconnected'; block: SimulatedBlock }
  | { type: 'accepted'; entry: SimulatedMempoolEntry }
  /** A mempool transaction left without being mined: replaced, conflicted or dropped. */
  | { type: 'removed'; txid: string };

/** Options for a SimulatedChain. */
export interface SimulatedChainOptions {
  /** regtest unless given. A customNetwork with a short coinbaseMaturity keeps tests quick to set up. */
  network?: PearlNetwork;
  /**
   * Blocks mined to the faucet before the test starts. The default is the
   * network's coinbase maturity plus 25, which leaves the faucet about a
   * hundred coins it can spend at once.
   */
  premine?: number;
  /**
   * Timestamp of the first block after genesis, Unix seconds; one block
   * spacing after the genesis block's unless given. The clock never reads
   * the machine's, so a test sees the same block times and hashes on every run.
   */
  time?: number;
  /** pearld's --minrelaytxfee, in grain per 1000 vbytes. */
  relayFeeRate?: FeeRate;
  /** pearld's --rejectreplacement. */
  rejectReplacement?: boolean;
  /** Run without --txindex: getrawtransaction then knows mempool transactions only. Turns the address index off too. */
  txindex?: boolean;
  /** Run without --addrindex: searchrawtransactions fails, as does a pearldBackend over `rpc`. */
  addrindex?: boolean;
}

/** Options for mine. */
export interface MineOptions {
  /** Pay `value` of the first block's coinbase here; the rest goes to the faucet. */
  coinbaseTo?: string;
  /** In grain; everything the coinbase may claim unless given. */
  value?: bigint;
  /** Transactions to put in the first block without passing them through the mempool: they must be valid, not standard. */
  include?: readonly Transaction[];
  /** Leave the mempool out of the blocks. */
  skipMempool?: boolean;
}

/** Options for reorg. */
export interface ReorgOptions {
  /** Blocks to mine on the new branch. One more than were taken off unless given; 0 leaves the chain shorter. */
  mine?: number;
  /** Keep the transactions of the blocks taken off in the mempool, out of the new blocks. */
  keepInMempool?: boolean;
  /**
   * Txids of faucet payments to double-spend on the new branch: for each, a
   * transaction spending the same coins back to the faucet is mined, so the
   * payment and everything spending from it is gone for good.
   */
  replace?: readonly string[];
  /** Transactions to mine in the first new block, such as a conflict signed with your own keys. */
  include?: readonly Transaction[];
}

/** What the faucet builds its transactions with. */
export interface FaucetOptions {
  /** Signal replace-by-fee. */
  rbf?: boolean;
  /** Grain per 1000 vbytes; the chain's feeRate unless given. */
  feeRate?: FeeRate;
}

/** The account every simulated chain mines to and pays from. */
export interface Faucet {
  /** Where coinbases and change go. */
  readonly address: string;
  readonly script: Uint8Array;
  /** Grain the faucet could spend right now. */
  balance(): bigint;
  /** Whether every input of the transaction spends a faucet coin, so the chain can sign a conflict for it. */
  funded(tx: Transaction): boolean;
  /**
   * A signed transaction paying each recipient, not yet sent anywhere. Pass
   * it to `accept`, or to `mine` as `include` when it is not standard (a
   * dust output). Its coins stay set aside until it or a conflict is mined.
   */
  build(recipients: readonly { address?: string; script?: Uint8Array; amount: bigint }[], options?: FaucetOptions): Transaction;
}

interface Block extends SimulatedBlock {
  /** The coins the block spent, to put back when it is taken off. */
  undo: Map<string, SimulatedCoin>;
  /** Set once the block has been asked for its filter. */
  filter?: { filter: CompactFilter; header: Uint8Array };
}

function invalid(message: string): PearlError {
  return new PearlError('SIMULATION_INVALID', message);
}

function isFinal(tx: Transaction, height: number, medianTimePast: number): boolean {
  if (tx.locktime === 0) return true;
  if (tx.locktime < (tx.locktime < LOCKTIME_THRESHOLD ? height : medianTimePast)) return true;
  return tx.ins.every((input) => input.sequence === FINAL_SEQUENCE);
}

/**
 * A simulated Pearl chain and node for tests. It is a WalletBackend, a
 * ChainClient and a TransactionSource itself; `rpc` answers pearld's
 * methods for everything written against a node, and `WebSocket` is a
 * constructor a PearlWsClient connects to it with.
 *
 * Transactions are real: the mempool applies checkSanity, checkStandard,
 * coinbase maturity, lock times, the replacement and package rules and the
 * script interpreter, and refuses with pearld's code and text. Blocks have
 * real headers, merkle roots, witness commitments and compact filters. What
 * is not modeled: the proof in a block's certificate is a placeholder that
 * nothing verifies, the difficulty never moves from the network's limit, and
 * there are no peers, so nothing propagates, arrives late or gets orphaned
 * unless a test says so.
 */
export class SimulatedChain implements WalletBackend, TransactionSource {
  readonly network: PearlNetwork;
  readonly faucet: Faucet;
  /** pearld's RPC over this chain: pass it to pearldBackend, pearldTransactionSource, followChain or anything else that takes an Rpc. */
  readonly rpc: PearldRpc;
  /** A WebSocket constructor for PearlWsClient: `new PearlWsClient({ url: 'ws://simulated', WebSocket: chain.WebSocket })`. */
  readonly WebSocket: SimulatedWebSocket;
  /** What estimateFeeRate and estimatefee answer, in grain per 1000 vbytes; null for a node with no estimate yet. */
  feeRate: FeeRate | null = 2000n;
  readonly relayFeeRate: FeeRate;
  readonly rejectReplacement: boolean;
  readonly txindex: boolean;
  readonly addrindex: boolean;
  /** How many times each backend method and RPC method was called, by name. */
  readonly calls = new Map<string, number>();

  readonly #account: PearlSigningAccount;
  readonly #active: Block[] = [];
  readonly #known = new Map<string, Block>();
  readonly #invalid = new Set<string>();
  readonly #coins = new Map<string, SimulatedCoin>();
  readonly #confirmed = new Map<string, { tx: Transaction; block: Block }>();
  readonly #spent = new Map<string, string>();
  #pool = new Map<string, SimulatedMempoolEntry>();
  #poolSpent = new Map<string, string>();
  readonly #reserved = new Map<string, string>();
  readonly #listeners = new Set<(event: SimulatedEvent) => void>();
  #failures: { left: number; method: string | undefined; error: ((method: string) => Error) | undefined }[] = [];
  #touching: Map<string, { tx: Transaction; block: Block | null }[]> | null = null;
  #time: number;
  #nonce = 0;

  constructor(options: SimulatedChainOptions = {}) {
    this.network = options.network ?? networks.regtest;
    this.relayFeeRate = options.relayFeeRate ?? DEFAULT_RELAY_FEE_RATE;
    this.rejectReplacement = options.rejectReplacement === true;
    this.txindex = options.txindex !== false;
    this.addrindex = this.txindex && options.addrindex !== false;
    this.#account = deriveSigningAccountFromSeed(mnemonicToSeed(FAUCET_MNEMONIC), this.network);
    const address = this.#account.deriveAddress(0);
    this.faucet = {
      address,
      script: toOutputScript(address, this.network),
      balance: () => this.#faucetCoins().reduce((sum, coin) => sum + coin.value, 0n),
      funded: (tx) => tx.ins.every((input) => toHex(this.output(prevTxid(input), input.index)?.script ?? new Uint8Array(0)) === toHex(this.faucet.script)),
      build: (recipients, faucetOptions) => this.#faucetBuild(recipients, faucetOptions ?? {}),
    };
    this.rpc = simulatedRpc(this);
    this.WebSocket = simulatedWebSocket(this);

    const genesis = parseBlock(fromHex(GENESIS_BLOCKS[this.network.name]));
    const first: Block = {
      hash: blockHashHex(genesis.header),
      height: 0,
      parent: '00'.repeat(32),
      time: genesis.header.timestamp,
      block: genesis,
      txs: genesis.transactions,
      fees: 0n,
      undo: new Map(),
    };
    // As on a real chain, the genesis coinbase is known but its outputs are not spendable.
    this.#known.set(first.hash, first);
    this.#active.push(first);
    this.#confirmed.set(genesis.transactions[0]!.getId(), { tx: genesis.transactions[0]!, block: first });
    this.#time = options.time ?? first.time + this.network.targetSpacing;
    const premine = options.premine ?? this.network.coinbaseMaturity + 25;
    if (!Number.isInteger(premine) || premine < 0) throw new RangeError('premine must be a number of blocks');
    if (premine > 0) this.mine(premine);
  }

  // ---- what the chain looks like

  /** Height of the tip. */
  get height(): number {
    return this.#active.length - 1;
  }

  get tip(): SimulatedBlock {
    return this.#active[this.#active.length - 1]!;
  }

  /** The best chain from genesis, by height. */
  get blocks(): readonly SimulatedBlock[] {
    return this.#active;
  }

  /** The mempool by txid, in the order transactions were accepted. */
  get mempool(): ReadonlyMap<string, SimulatedMempoolEntry> {
    return this.#pool;
  }

  /** The simulated clock, Unix seconds: the timestamp the next block gets. */
  get time(): number {
    return this.#time;
  }

  /** A block by hash, on the best chain or off it. */
  block(hash: string): SimulatedBlock | null {
    return this.#known.get(hash) ?? null;
  }

  /** Whether a block is on the best chain. */
  isActive(block: SimulatedBlock): boolean {
    return this.#active[block.height] === block;
  }

  /** Whether invalidate has marked the block or one under it. */
  isInvalid(block: SimulatedBlock): boolean {
    for (let at: Block | undefined = this.#known.get(block.hash); at !== undefined; at = this.#known.get(at.parent)) {
      if (this.#invalid.has(at.hash)) return true;
    }
    return false;
  }

  /** The last block of every branch the chain knows, the best chain's first. */
  chainTips(): SimulatedBlock[] {
    const parents = new Set([...this.#known.values()].map((block) => block.parent));
    const tips = [...this.#known.values()].filter((block) => !parents.has(block.hash) && block !== this.tip);
    return [this.tip, ...tips];
  }

  /** Median timestamp of the eleven blocks ending at a height, the tip unless given. */
  medianTimePast(height = this.height): number {
    const times = this.#active.slice(Math.max(0, height - MEDIAN_TIME_BLOCKS + 1), height + 1).map((block) => block.time);
    return times.sort((a, b) => a - b)[Math.floor(times.length / 2)]!;
  }

  /** A transaction on the best chain or in the mempool, with its block. */
  transaction(txid: string): { tx: Transaction; block: SimulatedBlock | null } | null {
    const pooled = this.#pool.get(txid);
    if (pooled !== undefined) return { tx: pooled.tx, block: null };
    return this.#confirmed.get(txid) ?? null;
  }

  /** An output of a transaction on the best chain or in the mempool, spent or not. */
  output(txid: string, vout: number): TxOutput | null {
    const out = this.transaction(txid)?.tx.outs[vout];
    return out === undefined ? null : { script: Uint8Array.from(out.script), value: out.value };
  }

  /** The outputs a transaction spends, in input order, or null when one is unknown. Empty for a coinbase. */
  prevouts(tx: Transaction): TxOutput[] | null {
    if (tx.isCoinbase()) return [];
    const outs = tx.ins.map((input) => this.output(prevTxid(input), input.index));
    return outs.every((out) => out !== null) ? (outs as TxOutput[]) : null;
  }

  /** An unspent output in a block of the best chain; a mempool spend does not remove it. */
  coin(txid: string, vout: number): SimulatedCoin | null {
    return this.#coins.get(key(txid, vout)) ?? null;
  }

  /** The transaction spending an output, on the best chain or in the mempool. */
  spender(txid: string, vout: number): { txid: string; confirmed: boolean } | null {
    const mined = this.#spent.get(key(txid, vout));
    if (mined !== undefined) return { txid: mined, confirmed: true };
    const pooled = this.#poolSpent.get(key(txid, vout));
    return pooled === undefined ? null : { txid: pooled, confirmed: false };
  }

  /** Every transaction paying or spending from a script, confirmed ones first in chain order. */
  touching(script: Uint8Array): { tx: Transaction; block: SimulatedBlock | null }[] {
    if (this.#touching === null) {
      const index = new Map<string, { tx: Transaction; block: Block | null }[]>();
      const add = (tx: Transaction, block: Block | null): void => {
        const scripts = new Set(tx.outs.map((out) => toHex(out.script)));
        if (!tx.isCoinbase()) for (const input of tx.ins) scripts.add(toHex(this.output(prevTxid(input), input.index)?.script ?? new Uint8Array(0)));
        for (const hex of scripts) {
          const list = index.get(hex);
          if (list === undefined) index.set(hex, [{ tx, block }]);
          else list.push({ tx, block });
        }
      };
      for (const block of this.#active) for (const tx of block.txs) add(tx, block);
      for (const { tx } of this.#pool.values()) add(tx, null);
      this.#touching = index;
    }
    return this.#touching.get(toHex(script)) ?? [];
  }

  /** The block's basic compact filter and its filter header, as pearld's filter index holds them. */
  filter(block: SimulatedBlock): { filter: CompactFilter; header: Uint8Array } {
    const chain: Block[] = [];
    for (let at = this.#known.get(block.hash); at !== undefined && at.filter === undefined; at = this.#known.get(at.parent)) chain.push(at);
    for (const at of chain.reverse()) {
      const filter = buildBasicFilter(at.block, [...at.undo.values()].map((coin) => coin.script));
      at.filter = { filter, header: filterHeader(filter, this.#known.get(at.parent)?.filter?.header ?? new Uint8Array(32)) };
    }
    return this.#known.get(block.hash)!.filter!;
  }

  /** Calls the listener for every block connected or disconnected and every mempool change, as they happen. Returns a function that stops it. */
  subscribe(listener: (event: SimulatedEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  // ---- steps a test takes

  /** Sets the simulated clock, which stamps the next block. A block's time is still at least a second after its parent's. */
  setTime(seconds: number): void {
    if (!Number.isInteger(seconds) || seconds < 0 || seconds > 0xffffffff) throw new RangeError('time must be Unix seconds');
    this.#time = seconds;
  }

  /** Moves the simulated clock forward. */
  advanceTime(seconds: number): void {
    this.setTime(this.#time + seconds);
  }

  /**
   * Makes the next `count` calls fail before they reach the chain, as a
   * dropped connection does: a PearlRpcError of kind "network" unless `error`
   * makes another. `method` limits it to one backend method ("broadcast")
   * or RPC method ("getblock").
   */
  failNext(count = 1, options: { method?: string; error?: (method: string) => Error } = {}): void {
    this.#failures.push({ left: count, method: options.method, error: options.error });
  }

  /** A payment from the faucet into the mempool. Returns the transaction. */
  pay(address: string, amount: bigint, options: FaucetOptions = {}): Transaction {
    const tx = this.faucet.build([{ address, amount }], options);
    this.accept(tx);
    return tx;
  }

  /**
   * Pays an address from the faucet and mines the payment, one block deep
   * unless `confirmations` says otherwise. Returns the coin, ready to hand to
   * buildPayment or selectCoins.
   */
  fund(address: string, amount: bigint, options: { confirmations?: number } = {}): WalletUtxo {
    const confirmations = options.confirmations ?? 1;
    if (!Number.isInteger(confirmations) || confirmations < 1) throw new RangeError('confirmations must be at least 1; use pay for an unconfirmed payment');
    const tx = this.pay(address, amount);
    this.mine(confirmations);
    const script = toOutputScript(address, this.network);
    return { txid: tx.getId(), vout: 0, value: amount, script, address, confirmations, coinbase: false };
  }

  /**
   * Puts a transaction in the mempool as sendrawtransaction would, and
   * returns its txid. Throws the PearlRpcError a client of pearld would get,
   * with pearld's code in `rpcCode`.
   */
  accept(tx: Transaction | string | Uint8Array): string {
    return this.#asClient('sendrawtransaction', () => this.submit(tx)).txid;
  }

  /** What the mempool would say to a transaction, without adding it: its fee, vsize and what it would replace, or the error `accept` would throw. */
  check(tx: Transaction | string | Uint8Array): { txid: string; fee: bigint; vsize: number; evicts: string[] } {
    return this.#asClient('testmempoolaccept', () => this.submit(tx, true));
  }

  /** `accept` and `check` for the RPC layer: throws the SimulatedRefusal itself. */
  submit(raw: Transaction | string | Uint8Array, dryRun = false): { txid: string; fee: bigint; vsize: number; evicts: string[] } {
    let tx: Transaction;
    try {
      tx = typeof raw === 'string' ? parseTransaction(raw) : raw instanceof Uint8Array ? parseTransaction(toHex(raw)) : raw;
    } catch (err) {
      throw new SimulatedRefusal(-22, `TX decode failed: ${(err as Error).message}`, { cause: err });
    }
    const { entry, evicts } = this.#admissible(tx);
    if (!dryRun) {
      for (const txid of evicts) this.#evict(txid);
      this.#insert(entry);
      this.#emit({ type: 'accepted', entry });
    }
    return { txid: tx.getId(), fee: entry.fee, vsize: entry.vsize, evicts };
  }

  /**
   * Mines blocks to the faucet. The first takes `include` and then the
   * mempool, in the order it was accepted. Throws when a transaction in
   * `include` breaks a consensus rule.
   */
  mine(count = 1, options: MineOptions = {}): BlockRef[] {
    if (!Number.isInteger(count) || count < 0) throw new RangeError('count must be a number of blocks');
    const refs: BlockRef[] = [];
    for (let i = 0; i < count; i += 1) {
      const block = this.#assemble(i === 0 ? options : options.skipMempool === true ? { skipMempool: true } : {});
      this.#connect(block);
      this.#refill([]);
      this.#emit({ type: 'connected', block });
      refs.push({ height: block.height, hash: block.hash });
    }
    return refs;
  }

  /**
   * Takes the top `depth` blocks off and mines a longer branch in their
   * place. The transactions of the blocks taken off return to the mempool,
   * if they are still valid, and are mined again in the first new block.
   * The old branch stays known as a fork, as getchaintips shows it.
   */
  reorg(depth: number, options: ReorgOptions = {}): BlockRef[] {
    if (!Number.isInteger(depth) || depth < 1 || depth > this.height) throw invalid(`cannot take ${depth} blocks off a chain of height ${this.height}`);
    const replaced = new Set(options.replace ?? []);
    const conflicts: Transaction[] = [];
    for (const txid of replaced) {
      const original = this.transaction(txid);
      if (original === null) throw invalid(`no transaction ${txid} to replace`);
      // One that spends from another being replaced goes when that one does, and has nothing left to conflict over.
      if (!original.tx.ins.some((input) => this.#descends(prevTxid(input), replaced))) conflicts.push(this.#conflicting(original.tx));
    }
    const returning = this.#rewind(this.height - depth);
    // What a conflict double-spends must not get back in ahead of it.
    const gone = new Set(conflicts.flatMap((tx) => tx.ins.map(outpointOf)));
    this.#refill(returning.filter((tx) => !tx.ins.some((input) => gone.has(outpointOf(input)))));
    for (const [txid, entry] of this.#pool) if (entry.tx.ins.some((input) => gone.has(outpointOf(input)))) this.#evict(txid);
    return this.mine(options.mine ?? depth + 1, {
      include: [...conflicts, ...(options.include ?? [])],
      ...(options.keepInMempool === true ? { skipMempool: true } : {}),
    });
  }

  /**
   * pearld's invalidateblock: marks a block invalid and moves the best chain
   * off it, to the longest branch left. Its transactions return to the
   * mempool.
   */
  invalidate(hash: string): void {
    const block = this.#known.get(hash);
    if (block === undefined) throw invalid(`no block ${hash}`);
    if (block.height === 0) throw invalid('the genesis block cannot be invalidated');
    this.#invalid.add(hash);
    this.#activateBest();
  }

  /** pearld's reconsiderblock: clears the mark from a block and those under and over it, and moves to its branch when that is now the longest. */
  reconsider(hash: string): void {
    const block = this.#known.get(hash);
    if (block === undefined) throw invalid(`no block ${hash}`);
    for (let at: Block | undefined = block; at !== undefined; at = this.#known.get(at.parent)) this.#invalid.delete(at.hash);
    for (const marked of [...this.#invalid]) {
      for (let at = this.#known.get(marked); at !== undefined; at = this.#known.get(at.parent)) {
        if (at === block) this.#invalid.delete(marked);
      }
    }
    this.#activateBest();
  }

  /**
   * Spends the inputs of a mempool transaction elsewhere, which removes it
   * and everything spending from it, and mines that unless `mine` is false.
   * The chain signs the conflict itself for a faucet payment; for a
   * transaction of your own, pass a `conflict` signed with your keys.
   */
  doubleSpend(txid: string, options: { mine?: boolean; conflict?: Transaction } = {}): Transaction {
    const original = this.#pool.get(txid);
    if (original === undefined) throw invalid(`${txid} is not in the mempool`);
    const conflict = options.conflict ?? this.#conflicting(original.tx);
    const spent = new Set(original.tx.ins.map(outpointOf));
    if (!conflict.ins.some((input) => spent.has(outpointOf(input)))) throw invalid('the conflict spends none of the inputs of the transaction it should replace');
    this.#evict(txid);
    if (options.mine === false) this.accept(conflict);
    else this.mine(1, { include: [conflict] });
    return conflict;
  }

  /** Forgets a mempool transaction and everything spending from it, as a node that evicted it has. */
  drop(txid: string): void {
    if (!this.#pool.has(txid)) throw invalid(`${txid} is not in the mempool`);
    this.#evict(txid);
  }

  // ---- WalletBackend, ChainClient and TransactionSource

  async getTip(): Promise<BlockRef> {
    this.enter('getTip');
    return { height: this.height, hash: this.tip.hash };
  }

  async getTransaction(txid: string): Promise<ChainTransaction | null> {
    this.enter('getTransaction');
    const found = this.transaction(txid);
    return found === null ? null : { txid, block: found.block === null ? null : { height: found.block.height, hash: found.block.hash, time: found.block.time } };
  }

  async getRawTransaction(txid: string): Promise<string | null> {
    this.enter('getRawTransaction');
    return this.transaction(txid)?.tx.toHex() ?? null;
  }

  async getAddressActivity(address: string): Promise<AddressPayment[]> {
    this.enter('getAddressActivity');
    const hex = toHex(this.#scriptOf(address));
    // A chain view gives the block's header time, as pearldChainClient does, so invoices can judge expiry by it.
    return this.touching(this.#scriptOf(address)).flatMap(({ tx, block }) => {
      const amount = tx.outs.reduce((sum, out) => (toHex(out.script) === hex ? sum + out.value : sum), 0n);
      if (amount === 0n) return [];
      return [{ txid: tx.getId(), block: block === null ? null : { height: block.height, hash: block.hash, time: block.time }, amount }];
    });
  }

  async getHistory(watched: Watched): Promise<AddressHistoryEntry[]> {
    this.enter('getHistory');
    return this.#history(watched);
  }

  async getUtxos(watched: readonly Watched[]): Promise<WalletUtxo[]> {
    this.enter('getUtxos');
    return this.#utxos(watched);
  }

  async getBalance(watched: readonly Watched[]): Promise<WalletBalance> {
    this.enter('getBalance');
    return sumBalance(this.#utxos(watched), this.network.coinbaseMaturity);
  }

  async broadcast(tx: string | Uint8Array): Promise<string> {
    this.enter('broadcast');
    return this.accept(tx);
  }

  async estimateFeeRate(): Promise<FeeRate> {
    this.enter('estimateFeeRate');
    return this.feeRate !== null && this.feeRate > this.relayFeeRate ? this.feeRate : this.relayFeeRate;
  }

  async getSpendStatus(outpoint: { txid: string; vout: number }): Promise<SpendStatus> {
    this.enter('getSpendStatus');
    const spender = this.spender(outpoint.txid, outpoint.vout);
    if (spender !== null) return { status: 'spent', spender: spender.txid, confirmed: spender.confirmed };
    const found = this.transaction(outpoint.txid);
    if (found === null || found.tx.outs[outpoint.vout] === undefined) return { status: 'unknown' };
    return { status: 'unspent', confirmations: this.#confirmations(found.block) };
  }

  /** Counts a call and fails it when failNext said so. The RPC and websocket layers go through here too. */
  enter(method: string): void {
    this.calls.set(method, (this.calls.get(method) ?? 0) + 1);
    const failure = this.#failures.find((item) => item.method === undefined || item.method === method);
    if (failure === undefined) return;
    failure.left -= 1;
    this.#failures = this.#failures.filter((item) => item.left > 0);
    throw failure.error?.(method) ?? new PearlRpcError('network', method, 'the simulated node dropped the connection');
  }

  // ---- internals

  #asClient<T>(method: string, run: () => T): T {
    try {
      return run();
    } catch (err) {
      if (!(err instanceof SimulatedRefusal)) throw err;
      throw rpcError(method, { code: err.rpcCode, message: err.clientMessage });
    }
  }

  #emit(event: SimulatedEvent): void {
    for (const listener of [...this.#listeners]) listener(event);
  }

  #confirmations(block: SimulatedBlock | null): number {
    return block === null ? 0 : this.height - block.height + 1;
  }

  #scriptOf(watched: Watched): Uint8Array {
    return typeof watched === 'string' ? toOutputScript(watched, this.network) : watched;
  }

  #history(watched: Watched): AddressHistoryEntry[] {
    const script = this.#scriptOf(watched);
    const hex = toHex(script);
    return this.touching(script).map(({ tx, block }) => {
      const received = tx.outs.reduce((sum, out) => (toHex(out.script) === hex ? sum + out.value : sum), 0n);
      let spent = 0n;
      if (!tx.isCoinbase()) {
        for (const input of tx.ins) {
          const out = this.output(prevTxid(input), input.index);
          if (out !== null && toHex(out.script) === hex) spent += out.value;
        }
      }
      return { txid: tx.getId(), block: block === null ? null : { height: block.height, hash: block.hash }, received, spent };
    });
  }

  #utxos(watched: readonly Watched[]): WalletUtxo[] {
    const utxos: WalletUtxo[] = [];
    for (const hex of new Set(watched.map((item) => toHex(this.#scriptOf(item))))) {
      const script = fromHex(hex);
      for (const { tx, block } of this.touching(script)) {
        const txid = tx.getId();
        tx.outs.forEach((out, vout) => {
          if (toHex(out.script) !== hex || this.spender(txid, vout) !== null) return;
          utxos.push({
            txid,
            vout,
            value: out.value,
            script: Uint8Array.from(script),
            address: fromOutputScript(script, this.network),
            confirmations: this.#confirmations(block),
            coinbase: tx.isCoinbase(),
          });
        });
      }
    }
    return utxos;
  }

  // The coin an input spends as the mempool sees it: a confirmed one, or the output of a mempool transaction.
  #poolCoin(input: Transaction['ins'][number]): SimulatedCoin | null {
    const confirmed = this.#coins.get(outpointOf(input));
    if (confirmed !== undefined) return confirmed;
    const out = this.#pool.get(prevTxid(input))?.tx.outs[input.index];
    // utxoView marks a mempool output with this height (mining.UnminedHeight).
    return out === undefined ? null : { script: out.script, value: out.value, height: 0x7fffffff, coinbase: false };
  }

  // CheckTransactionInputs' maturity rule and the sequence locks, for a transaction entering a block at `height`.
  // The maturity rule is a chain rule, -25 from the mempool too; the mempool's sequence-lock refusal is its own, -26.
  #checkChainRules(tx: Transaction, coins: readonly SimulatedCoin[], height: number, code: number): void {
    coins.forEach((coin, i) => {
      if (!coin.coinbase) return;
      const since = height - coin.height;
      if (since < this.network.coinbaseMaturity) {
        throw new SimulatedRefusal(
          TX_ERROR,
          `tried to spend coinbase transaction output ${outpointOf(tx.ins[i]!)} from height ${coin.height} at height ${height} before required maturity of ${this.network.coinbaseMaturity} blocks`,
        );
      }
    });
    if (tx.version < 2) return;
    // calcSequenceLock and SequenceLockActive in blockchain/chain.go.
    let minHeight = -1;
    let minTime = -1;
    tx.ins.forEach((input, i) => {
      if ((input.sequence & SEQUENCE_LOCKTIME_DISABLED) !== 0) return;
      const coinHeight = Math.min(coins[i]!.height, height);
      const lock = input.sequence & SEQUENCE_LOCKTIME_MASK;
      if ((input.sequence & SEQUENCE_LOCKTIME_IS_SECONDS) !== 0) {
        minTime = Math.max(minTime, this.medianTimePast(Math.max(0, coinHeight - 1)) + lock * 2 ** SEQUENCE_LOCKTIME_GRANULARITY - 1);
      } else {
        minHeight = Math.max(minHeight, coinHeight + lock - 1);
      }
    });
    if (minHeight >= height || minTime >= this.medianTimePast(height - 1)) {
      throw new SimulatedRefusal(code, "transaction's sequence locks on inputs not met");
    }
  }

  // ValidateTransactionScripts' refusal, a chain rule error (-25), worded as blockchain/scriptval.go words it:
  // the engine's description, which is empty for a failed key-path signature, then the input's witness and scripts.
  #runScripts(tx: Transaction, prevouts: readonly TxOutput[]): void {
    const result = verifyTransaction(tx, prevouts);
    if (!result.ok) {
      const input = tx.ins[result.inputIndex]!;
      const witness = `[${input.witness.map((item) => toHex(item)).join(' ')}]`;
      throw new SimulatedRefusal(
        TX_ERROR,
        `failed to validate input ${tx.getId()}:${result.inputIndex} which references output ${outpointOf(input)} - ${result.message} ` +
          `(input witness ${witness}, input script bytes ${toHex(input.script)}, prev output script bytes ${toHex(prevouts[result.inputIndex]!.script)})`,
      );
    }
  }

  // maybeAcceptTransaction: what the mempool would hold for the transaction, and what it would evict for it.
  #admissible(tx: Transaction): { entry: SimulatedMempoolEntry; evicts: string[] } {
    const txid = tx.getId();
    const height = this.height + 1;
    try {
      if (this.#pool.has(txid)) throw new SimulatedRefusal(TX_REJECTED, `already have transaction in mempool ${txid}`);
      checkSanity(tx);
      if (tx.isCoinbase()) throw new SimulatedRefusal(TX_REJECTED, `transaction is an individual coinbase ${txid}`);
      if (tx.outs.some((_, vout) => this.#coins.has(key(txid, vout)))) throw new SimulatedRefusal(TX_IN_CHAIN, 'transaction already exists in blockchain');
      const coins = tx.ins.map((input) => {
        const coin = this.#poolCoin(input);
        if (coin === null) {
          throw new SimulatedRefusal(TX_ERROR, `orphan transaction ${txid} references outputs of unknown or fully-spent transaction ${prevTxid(input)}`);
        }
        return coin;
      });
      checkStandard(tx, { prevouts: coins, height, medianTimePast: this.medianTimePast(), relayFeeRate: this.relayFeeRate });
      this.#checkChainRules(tx, coins, height, TX_REJECTED);
      const fee = coins.reduce((sum, coin) => sum + coin.value, 0n) - tx.outs.reduce((sum, out) => sum + out.value, 0n);
      const evicts = checkReplacement(tx, fee, this.#pool, { relayFeeRate: this.relayFeeRate, rejectReplacement: this.rejectReplacement });
      checkPackageLimits(tx, this.#pool, { replaced: evicts });
      this.#runScripts(tx, coins);
      return { entry: { tx, fee, vsize: tx.virtualSize(), time: this.#time, height: this.height }, evicts };
    } catch (err) {
      if (err instanceof PolicyError) {
        // CheckTransactionSanity and CheckTransactionInputs are chain rules, -25; but for the lone coinbase the rest are the mempool's, -26.
        const code = err.code.startsWith('SANITY_') && err.code !== 'SANITY_COINBASE' ? TX_ERROR : TX_REJECTED;
        // validateStandardness (node/mempool/mempool.go:1636) names the transaction in front of what CheckTransactionStandard and checkInputsStandard say.
        const message = STANDARDNESS.has(err.code)
          ? `transaction ${txid} is not standard: ${err.message}`
          : err.code === 'POLICY_NONSTANDARD_INPUT'
            ? `transaction ${txid} has a non-standard input: ${err.message}`
            : err.message;
        throw new SimulatedRefusal(code, message, { cause: err });
      }
      throw err;
    }
  }

  #insert(entry: SimulatedMempoolEntry): void {
    const txid = entry.tx.getId();
    this.#pool.set(txid, entry);
    for (const input of entry.tx.ins) {
      this.#poolSpent.set(outpointOf(input), txid);
      this.#reserved.delete(outpointOf(input));
    }
    this.#touching = null;
  }

  #evict(txid: string): void {
    const entry = this.#pool.get(txid);
    if (entry === undefined) return;
    this.#pool.delete(txid);
    for (const input of entry.tx.ins) this.#poolSpent.delete(outpointOf(input));
    this.#touching = null;
    for (const [other, { tx }] of [...this.#pool]) if (tx.ins.some((input) => prevTxid(input) === txid)) this.#evict(other);
    this.#emit({ type: 'removed', txid });
  }

  // Whether a transaction is one of `txids` or spends, however far down, from one of them.
  #descends(txid: string, txids: ReadonlySet<string>): boolean {
    if (txids.has(txid)) return true;
    const tx = this.transaction(txid)?.tx;
    return tx !== undefined && !tx.isCoinbase() && tx.ins.some((input) => this.#descends(prevTxid(input), txids));
  }

  // Puts the mempool together again after the chain changed under it: `returning` first, then what it held, each kept only if it is still acceptable.
  #refill(returning: readonly Transaction[]): void {
    const before = this.#pool;
    this.#pool = new Map();
    this.#poolSpent = new Map();
    this.#touching = null;
    for (const tx of [...returning, ...[...before.values()].map((entry) => entry.tx)]) {
      const txid = tx.getId();
      if (this.#pool.has(txid)) continue;
      try {
        const { entry, evicts } = this.#admissible(tx);
        if (evicts.length > 0) throw new SimulatedRefusal(TX_REJECTED, 'conflicts with a transaction that came back first');
        this.#insert(before.get(txid) ?? entry);
      } catch (err) {
        if (!(err instanceof SimulatedRefusal)) throw err;
      }
    }
    for (const txid of before.keys()) if (!this.#pool.has(txid) && !this.#confirmed.has(txid)) this.#emit({ type: 'removed', txid });
  }

  // A block on the tip holding `include` and, unless skipped, the mempool.
  #assemble(options: MineOptions): Block {
    const parent = this.tip;
    const height = parent.height + 1;
    // Pearl's rule: at least a second after the parent (blockchain.MinTimestampDeltaSeconds).
    const time = Math.max(this.#time, parent.time + 1);
    const view = new Map<string, SimulatedCoin | null>();
    const lookup = (input: Transaction['ins'][number]): SimulatedCoin | null => {
      const at = outpointOf(input);
      return view.has(at) ? view.get(at)! : (this.#coins.get(at) ?? null);
    };
    const txs: Transaction[] = [];
    const taken = new Set<string>();
    let fees = 0n;
    let vsize = 0;
    const take = (tx: Transaction, checked: boolean): void => {
      const txid = tx.getId();
      if (!checked) {
        if (tx.isCoinbase()) throw new SimulatedRefusal(TX_ERROR, `transaction ${txid} is a coinbase`);
        try {
          checkSanity(tx);
        } catch (err) {
          throw new SimulatedRefusal(TX_ERROR, (err as Error).message, { cause: err });
        }
      }
      if (taken.has(txid)) return;
      const coins = tx.ins.map((input) => {
        // A parent still in the mempool goes into the block ahead of what spends it.
        const parent = this.#pool.get(prevTxid(input));
        if (parent !== undefined && !taken.has(prevTxid(input)) && options.skipMempool !== true) take(parent.tx, true);
        const coin = lookup(input);
        if (coin === null) {
          throw new SimulatedRefusal(TX_ERROR, `output ${outpointOf(input)} referenced from transaction ${txid} either does not exist or has already been spent`);
        }
        return coin;
      });
      const fee = coins.reduce((sum, coin) => sum + coin.value, 0n) - tx.outs.reduce((sum, out) => sum + out.value, 0n);
      if (fee < 0n) throw new SimulatedRefusal(TX_ERROR, `total value of all transaction inputs for transaction ${txid} is less than the amount spent`);
      if (!isFinal(tx, height, this.medianTimePast())) throw new SimulatedRefusal(TX_ERROR, `block contains unfinalized transaction ${txid}`);
      this.#checkChainRules(tx, coins, height, TX_ERROR);
      if (!checked) this.#runScripts(tx, coins);
      for (const input of tx.ins) view.set(outpointOf(input), null);
      tx.outs.forEach((out, vout) => view.set(key(txid, vout), { script: out.script, value: out.value, height, coinbase: false }));
      txs.push(tx);
      taken.add(txid);
      fees += fee;
      vsize += tx.virtualSize();
    };
    for (const tx of options.include ?? []) {
      try {
        take(tx, false);
      } catch (err) {
        if (!(err instanceof SimulatedRefusal)) throw err;
        throw invalid(`cannot mine ${tx.getId()}: ${err.message}`);
      }
    }
    if (options.skipMempool !== true) {
      for (const { tx } of this.#pool.values()) {
        // Room is left for the coinbase, as pearld's block template leaves it.
        if (vsize + tx.virtualSize() > 990_000) break;
        try {
          take(tx, true);
        } catch (err) {
          // It conflicts with something in `include`, or waits on a transaction that does.
          if (!(err instanceof SimulatedRefusal)) throw err;
        }
      }
    }

    const reward = blockSubsidy(this.network, height) + fees;
    const coinbase = createTransaction(1);
    this.#nonce += 1;
    // The height (BIP 34), then a counter that keeps coinbases of two branches at one height apart.
    const tag = concat([scriptPush(encodeScriptNumber(BigInt(height))), scriptPush(encodeScriptNumber(BigInt(this.#nonce))), scriptPush(new TextEncoder().encode('pearljs'))]);
    coinbase.addInput(new Uint8Array(32), 0xffffffff, FINAL_SEQUENCE, tag);
    let left = reward;
    if (options.coinbaseTo !== undefined) {
      const value = options.value ?? reward;
      if (value > reward) throw invalid(`a coinbase at height ${height} may claim ${reward} grain, not ${value}`);
      coinbase.addOutput(toOutputScript(options.coinbaseTo, this.network), value);
      left -= value;
    }
    for (let i = FAUCET_SPLIT; i >= 1 && left > 0n; i -= 1) {
      const share = left / BigInt(i);
      coinbase.addOutput(this.faucet.script, share);
      left -= share;
    }
    coinbase.setWitness(0, [new Uint8Array(32)]);
    // The commitment covers the wtxids of the others, so it can be written before the coinbase is complete.
    const witnessRoot = calculateMerkleRoot([coinbase, ...txs], true);
    coinbase.addOutput(concat([WITNESS_MAGIC, sha256(sha256(concat([witnessRoot, new Uint8Array(32)])))]), 0n);
    const transactions = [coinbase, ...txs];

    const version = requiredCertVersion(this.network, height);
    // A stand-in for the proof's public data: the right size, tied to this block, and nothing a verifier would accept.
    const seed = sha256(concat([fromHex(parent.hash), new TextEncoder().encode(`pearljs simulated block ${height}`)]));
    const publicData = concat(Array.from({ length: 6 }, (_, i) => sha256(concat([seed, Uint8Array.of(i)])))).slice(0, 164);
    const header: PearlBlockHeader = {
      version: 0x20000000,
      prevBlock: Uint8Array.from(fromHex(parent.hash)).reverse(),
      merkleRoot: calculateMerkleRoot(transactions),
      timestamp: time,
      bits: this.network.powLimitBits,
      proofCommitment: certificateProofCommitment({ version, hash: new Uint8Array(32), publicData, proof: new Uint8Array(0) }),
    };
    const certificate = { version, hash: blockHash(header), publicData, proof: new TextEncoder().encode('pearljs simulated proof') };
    const block: PearlBlock = { certificate, header, transactions };
    if (blockVsize(block) > 1_000_000) throw invalid('the block is over the size limit');
    return { hash: display(certificate.hash), height, parent: parent.hash, time, block, txs: transactions, fees, undo: new Map() };
  }

  // Puts a block on the tip. Its transactions were checked when it was assembled, on this parent.
  #connect(block: Block): void {
    this.#known.set(block.hash, block);
    this.#active.push(block);
    block.undo.clear();
    for (const tx of block.txs) {
      const txid = tx.getId();
      if (!tx.isCoinbase()) {
        for (const input of tx.ins) {
          const at = outpointOf(input);
          block.undo.set(at, this.#coins.get(at)!);
          this.#coins.delete(at);
          this.#spent.set(at, txid);
          this.#reserved.delete(at);
        }
      }
      tx.outs.forEach((out, vout) => this.#coins.set(key(txid, vout), { script: out.script, value: out.value, height: block.height, coinbase: tx.isCoinbase() }));
      this.#confirmed.set(txid, { tx, block });
      const pooled = this.#pool.get(txid);
      if (pooled !== undefined) {
        this.#pool.delete(txid);
        for (const input of tx.ins) this.#poolSpent.delete(outpointOf(input));
      }
    }
    this.#touching = null;
    // The clock moves on by the network's block spacing unless a test has set it further ahead.
    this.#time = Math.max(this.#time, block.time + this.network.targetSpacing);
  }

  // Takes the tip off and returns its transactions, coinbase left out.
  #disconnect(): Transaction[] {
    const block = this.#active.pop()!;
    // Spent coins go back first: one made and spent inside this block is among them, and must not outlive it.
    for (const [at, coin] of block.undo) this.#coins.set(at, coin);
    for (const tx of block.txs) {
      const txid = tx.getId();
      tx.outs.forEach((_, vout) => this.#coins.delete(key(txid, vout)));
      this.#confirmed.delete(txid);
      if (!tx.isCoinbase()) for (const input of tx.ins) this.#spent.delete(outpointOf(input));
    }
    this.#touching = null;
    this.#emit({ type: 'disconnected', block });
    return block.txs.filter((tx) => !tx.isCoinbase());
  }

  // Takes blocks off down to a height; returns their transactions, oldest first.
  #rewind(height: number): Transaction[] {
    const returning: Transaction[] = [];
    while (this.height > height) returning.unshift(...this.#disconnect());
    return returning;
  }

  // Moves the best chain to the longest branch that is not invalid, staying put on a tie.
  #activateBest(): void {
    let best: Block = this.#active[0]!;
    for (const block of [...this.#active, ...this.#known.values()]) {
      if (block.height > best.height && !this.isInvalid(block)) best = block;
    }
    if (best === this.tip) return;
    const path: Block[] = [];
    let at = best;
    while (this.#active[at.height] !== at) {
      path.unshift(at);
      at = this.#known.get(at.parent)!;
    }
    const returning = this.#rewind(at.height);
    const connected: Block[] = [];
    for (const block of path) {
      // The coins it spends are there again: the chain under it is the one it was assembled on.
      this.#connect(block);
      connected.push(block);
    }
    this.#refill(returning);
    for (const block of connected) this.#emit({ type: 'connected', block });
  }

  // ---- the faucet

  // The faucet's spendable coins: mature confirmed ones oldest first, then its unconfirmed change.
  #faucetCoins(): (SimulatedCoin & { txid: string; vout: number })[] {
    const coins: (SimulatedCoin & { txid: string; vout: number })[] = [];
    const height = this.height + 1;
    for (const { tx, block } of this.touching(this.faucet.script)) {
      const txid = tx.getId();
      tx.outs.forEach((out, vout) => {
        const at = key(txid, vout);
        if (toHex(out.script) !== toHex(this.faucet.script) || this.spender(txid, vout) !== null || this.#reserved.has(at)) return;
        if (block !== null && tx.isCoinbase() && height - block.height < this.network.coinbaseMaturity) return;
        coins.push({ txid, vout, script: this.faucet.script, value: out.value, height: block?.height ?? 0x7fffffff, coinbase: tx.isCoinbase() });
      });
    }
    return coins.sort((a, b) => a.height - b.height);
  }

  #faucetSign(tx: Transaction, coins: readonly TxOutput[]): Transaction {
    const psbt = createPsbt(tx);
    coins.forEach((coin, i) => this.#account.prepareInput(psbt, i, { index: 0, value: coin.value }));
    // Fixed auxiliary randomness, so the same test builds the same witnesses and block hashes on every run.
    coins.forEach((_, i) => this.#account.signInput(psbt, i, { index: 0, auxRand: new Uint8Array(32) }));
    return finalizePsbt(psbt);
  }

  #faucetBuild(recipients: readonly { address?: string; script?: Uint8Array; amount: bigint }[], options: FaucetOptions): Transaction {
    if (recipients.length === 0) throw invalid('the faucet needs someone to pay');
    const tx = createTransaction(2);
    let needed = 0n;
    for (const recipient of recipients) {
      const script = recipient.script ?? (recipient.address === undefined ? undefined : toOutputScript(recipient.address, this.network));
      if (script === undefined) throw invalid('a faucet recipient needs an address or a script');
      if (typeof recipient.amount !== 'bigint' || recipient.amount < 0n) throw invalid('a faucet payment is a bigint number of grain');
      tx.addOutput(script, recipient.amount);
      needed += recipient.amount;
    }
    const feeRate = options.feeRate ?? this.feeRate ?? this.relayFeeRate;
    const used: (SimulatedCoin & { txid: string; vout: number })[] = [];
    let total = 0n;
    let fee = 0n;
    for (const coin of this.#faucetCoins()) {
      used.push(coin);
      total += coin.value;
      // Priced with a change output, which a faucet coin always leaves.
      const weight = (tx.byteLength(false) + P2TR_OUTPUT_SIZE) * 4 + 2 + used.length * KEY_PATH_INPUT_WEIGHT;
      fee = feeForVsize(Math.ceil(weight / 4), feeRate);
      if (total >= needed + fee) break;
    }
    if (total < needed + fee) {
      throw invalid(`the faucet holds ${total} spendable grain and was asked for ${needed}; mine blocks to mature more of its coinbases`);
    }
    for (const coin of used) tx.addInput(Uint8Array.from(fromHex(coin.txid)).reverse(), coin.vout, options.rbf === true ? RBF_SEQUENCE : FINAL_SEQUENCE);
    if (total - needed - fee > 0n) tx.addOutput(this.faucet.script, total - needed - fee);
    const signed = this.#faucetSign(tx, used);
    for (const coin of used) this.#reserved.set(key(coin.txid, coin.vout), signed.getId());
    return signed;
  }

  // Spends the same faucet coins back to the faucet, for a little more fee than the original paid.
  #conflicting(original: Transaction): Transaction {
    if (!this.faucet.funded(original)) {
      throw invalid(`the chain can only double-spend faucet payments; ${original.getId()} spends other coins, so sign the conflict yourself and pass it`);
    }
    const coins = this.prevouts(original)!;
    const total = coins.reduce((sum, coin) => sum + coin.value, 0n);
    const paid = total - original.outs.reduce((sum, out) => sum + out.value, 0n);
    const tx = createTransaction(2);
    for (const input of original.ins) tx.addInput(input.hash, input.index, FINAL_SEQUENCE);
    const weight = (10 + P2TR_OUTPUT_SIZE) * 4 + 2 + coins.length * KEY_PATH_INPUT_WEIGHT;
    // Enough for pearld's replacement rules, should the conflict go through a mempool.
    tx.addOutput(this.faucet.script, total - paid - feeForVsize(Math.ceil(weight / 4), this.relayFeeRate) - 1000n);
    return this.#faucetSign(tx, coins);
  }
}
