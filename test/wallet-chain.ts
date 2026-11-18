// The simulated chain of pearljs/testing, with what the wallet tests add:
// fixed keys, a quick way to make the next broadcast fail, conflicts signed
// with the test wallet's own seed, and an ActivityScanner over the chain.

import { PearlWallet, createMemoryStore, createPsbt, createTransaction, deriveSigningAccountFromSeed, finalizePsbt, mnemonicToSeed, networks, toOutputScript } from '../src/index.js';
import type { ActivityScanner, AddressHistoryEntry, BlockRef, ChainTransaction, SpendStatus, Transaction, WalletStore, Watched } from '../src/index.js';
import { SimulatedChain } from '../src/testing.js';
import type { ReorgOptions } from '../src/testing.js';

const network = networks.regtest;
export const MNEMONIC = `${'abandon '.repeat(11)}about`;
export const PASSPHRASE = 'correct horse battery staple';
export const FAST_KDF = { N: 2 ** 10 };
/** An address no wallet in the tests owns. */
export const STRANGER = 'rprl1p8dhv8twyj9ezfvk62vvsfgw39s4dgl9t42y0549dc4d2947jj4cs30wfpz';
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const account = deriveSigningAccountFromSeed(mnemonicToSeed(MNEMONIC), network);

export class FakeChain extends SimulatedChain {
  /** Makes the next broadcast fail as a dropped connection would, not as a node refusal. */
  set failNextBroadcast(on: boolean) {
    if (on) this.failNext(1, { method: 'broadcast' });
  }

  // Conflicts for the test wallet's own sends, signed with the wallet's seed as a second device would.
  override doubleSpend(txid: string, options: { mine?: boolean; conflict?: Transaction } = {}): Transaction {
    const original = this.mempool.get(txid)?.tx;
    if (original === undefined || this.faucet.funded(original) || options.conflict !== undefined) return super.doubleSpend(txid, options);
    return super.doubleSpend(txid, { ...options, conflict: this.signedConflict(original) });
  }

  override reorg(depth: number, options: ReorgOptions = {}): BlockRef[] {
    const own = (options.replace ?? []).map((txid) => this.transaction(txid)?.tx).filter((tx): tx is Transaction => tx !== undefined && !this.faucet.funded(tx));
    const ids = new Set(own.map((tx) => tx.getId()));
    return super.reorg(depth, {
      ...options,
      replace: (options.replace ?? []).filter((txid) => !ids.has(txid)),
      include: [...own.map((tx) => this.signedConflict(tx)), ...(options.include ?? [])],
    });
  }

  /**
   * What a lying backend shows: transactions reported as in the mempool that
   * no node would accept, in place of any the chain holds under the same txid.
   */
  readonly shown = new Map<string, Transaction>();

  override async getHistory(watched: Watched): Promise<AddressHistoryEntry[]> {
    const entries = (await super.getHistory(watched)).filter((entry) => !this.shown.has(entry.txid));
    const script = hex(typeof watched === 'string' ? toOutputScript(watched, network) : watched);
    for (const [txid, tx] of this.shown) {
      const received = tx.outs.reduce((sum, out) => (hex(out.script) === script ? sum + out.value : sum), 0n);
      const spent = (this.prevouts(tx) ?? []).reduce((sum, out) => (hex(out.script) === script ? sum + out.value : sum), 0n);
      if (received > 0n || spent > 0n) entries.push({ txid, block: null, received, spent });
    }
    return entries;
  }

  override async getRawTransaction(txid: string): Promise<string | null> {
    return this.shown.get(txid)?.toHex() ?? super.getRawTransaction(txid);
  }

  override async getTransaction(txid: string): Promise<ChainTransaction | null> {
    return this.shown.has(txid) ? { txid, block: null } : super.getTransaction(txid);
  }

  override async getSpendStatus(outpoint: { txid: string; vout: number }): Promise<SpendStatus> {
    for (const [txid, tx] of this.shown) {
      if (tx.ins.some((input) => hex(Uint8Array.from(input.hash).reverse()) === outpoint.txid && input.index === outpoint.vout)) return { status: 'spent', spender: txid, confirmed: false };
    }
    return super.getSpendStatus(outpoint);
  }

  /** A transaction spending the same coins of the test wallet to a stranger. */
  signedConflict(original: Transaction): Transaction {
    const coins = this.prevouts(original)!;
    const tx = createTransaction(2);
    for (const input of original.ins) tx.addInput(input.hash, input.index);
    const total = coins.reduce((s, c) => s + c.value, 0n);
    tx.addOutput(toOutputScript(STRANGER, network), total - 5000n);
    return signWithTestWallet(tx, coins);
  }
}

/** Signs every input of a transaction spending coins of the test wallet's first account. */
export function signWithTestWallet(tx: Transaction, coins: readonly { script: Uint8Array; value: bigint }[]): Transaction {
  const psbt = createPsbt(tx);
  const children = coins.map((coin) => {
    for (const change of [false, true]) for (let index = 0; index < 60; index += 1) if (hex(toOutputScript(account.deriveAddress(index, change), network)) === hex(coin.script)) return { index, change };
    throw new Error('not a coin of the test wallet');
  });
  coins.forEach((coin, i) => account.prepareInput(psbt, i, { ...children[i]!, value: coin.value }));
  children.forEach((child, i) => account.signInput(psbt, i, child));
  return finalizePsbt(psbt);
}

/** Where the chain holds a transaction, as a wallet records it: height and hash. */
export async function blockOf(chain: FakeChain, txid: string): Promise<BlockRef | null> {
  const block = (await chain.getTransaction(txid))?.block ?? null;
  return block === null ? null : { height: block.height, hash: block.hash };
}

export async function newWallet(chain: FakeChain, options: { store?: WalletStore; gapLimit?: number } = {}): Promise<PearlWallet> {
  return PearlWallet.create({ store: options.store ?? createMemoryStore(), backend: chain, passphrase: PASSPHRASE, mnemonic: MNEMONIC, kdf: FAST_KDF, gapLimit: options.gapLimit ?? 10 });
}

/** The same chain as a backend that can answer for every address at once. */
export function withActivityScanner(chain: FakeChain): FakeChain & ActivityScanner {
  return Object.assign(chain, {
    async getActivitySince(watched: readonly Watched[], after: BlockRef) {
      chain.enter('getActivitySince');
      if (chain.blocks[after.height]?.hash !== after.hash) return null;
      const seen = new Map<string, BlockRef | null>();
      for (const item of watched) {
        for (const { tx, block } of chain.touching(typeof item === 'string' ? toOutputScript(item, network) : item)) {
          if (block === null || block.height > after.height) seen.set(tx.getId(), block === null ? null : { height: block.height, hash: block.hash });
        }
      }
      return [...seen].map(([txid, block]) => ({ txid, block }));
    },
  });
}
