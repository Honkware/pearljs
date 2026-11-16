// A wallet that remembers: accounts and the addresses handed out, the
// transactions that touch them, locked outputs, XMSS index state and an
// encrypted keystore, all in a WalletStore, kept in step with the chain
// through a WalletBackend.
//
// The stored truth is the set of transactions. Coins, balances and history
// are derived from it every time (wallet-ledger.ts), so a balance cannot
// disagree with the outputs it is made of. Every operation that changes
// state runs alone, in call order, and ends with one atomic batch; an
// operation that fails reloads the state from the store, so memory never
// holds what the store does not. The one write outside a batch is an XMSS
// index reservation, which must be durable before its signature exists. A
// sync does its network calls before it takes its turn (#speculate), so a
// long scan does not hold up a send.

/**
 * Wallet state over a backend and a store: accounts, addresses, sync,
 * reorgs, balance, history, send, fee bumping, sweeping and XMSS keys.
 *
 * @module
 */

import * as ecc from 'tiny-secp256k1';
import { encodeAddress, fromOutputScript, toOutputScript } from './address.js';
import type { WalletBackend, Watched } from './backend.js';
import { buildPayment, finalizePayment } from './builder.js';
import type { Payment, Recipient } from './builder.js';
import type { FeeRate } from './amount.js';
import type { BlockRef } from './client.js';
import { KeystoreError, PearlError, PearlRpcError, PolicyError, SigningError, StoreError, WalletError, XmssError } from './errors.js';
import { toHex } from './internal/bytes.js';
import { decodeBigint, decodeHex, encodeBigint } from './internal/store-ops.js';
import { InsufficientFundsError, confirmationsFromHeight } from './coinselect.js';
import type { CoinSelectionStrategy } from './coinselect.js';
import { deriveAccountFromSeed, deriveSigningAccountFromSeed, importWatchOnlyAccount } from './keys.js';
import type { PearlAccount, PearlSigningAccount } from './keys.js';
import { createKeystore, openKeystore } from './keystore.js';
import type { EncryptedKeystore, Keystore, KeystoreOptions, UnlockOptions } from './keystore.js';
import { generateMnemonic, mnemonicToSeed, validateMnemonic, normalizeMnemonic } from './mnemonic.js';
import type { PearlNetwork } from './networks.js';
import { p2mr } from './payments.js';
import { replacementFee, signalsReplacement } from './rbf.js';
import { PearldRpc, OysterRpc, isUnknownTransaction } from './rpc.js';
import type { Rpc } from './rpc.js';
import { taggedHash, xmssLeafScript } from './script.js';
import { DEFAULT_MAX_FEE_RATE, signXmssP2mrInput } from './scriptpath.js';
import { assembleScriptTree } from './scripttree.js';
import type { ScriptTree } from './scripttree.js';
import { sweepKey } from './sweep.js';
import { parseTransaction, Transaction } from './transaction.js';
import { decodeWif, keyPathAddress } from './wif.js';
import type { BlockDetails, PearlWsClient } from './ws.js';
import { createXmssSigner, xmssKeygen, XMSS_LAST_INDEX, XMSS_MAX_SIGNATURES, XMSS_SIGNATURE_LENGTH } from './xmss.js';
import type { XmssIndexStore } from './xmss.js';
import { createMemoryStore } from './store.js';
import type { JsonValue, StoreOperation, WalletStore } from './store.js';
import { computeHistory, computeLedger, outpointKey, prevTxid } from './wallet-ledger.js';
import type { CoinOwner, HistoryEntry, Ledger, LedgerOwnership, LedgerTransaction, TransactionStatus, WalletCoin, WalletStateBalance } from './wallet-ledger.js';
import { OYSTER_RECOVERY_WINDOW } from './discovery.js';

export type { CoinOwner, HistoryEntry, TransactionStatus, WalletCoin, WalletStateBalance } from './wallet-ledger.js';

/** The version of the stored records this pearljs writes. */
export const WALLET_SCHEMA_VERSION = 1;
/** Unused addresses watched past the last used one on every sync after the first. */
export const DEFAULT_LOOKAHEAD = 20;
/** Confirmed transactions this deep or shallower are checked against the chain when the tip moves. */
export const DEFAULT_REORG_DEPTH = 100;

const SCAN_BATCH = 25;
const CONCURRENCY = 8;
const XMSS_SEED_BYTES = 96;
const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** Where full transactions come from: the backend's interface only has txids. */
export interface TransactionSource {
  /** The serialized transaction, or null when the source does not know it. */
  getRawTransaction(txid: string): Promise<string | Uint8Array | null>;
}

/** Full transactions from pearld's getrawtransaction, which needs --txindex for confirmed ones (pearldBackend's --addrindex turns it on). */
export function pearldTransactionSource(rpc: Rpc): TransactionSource {
  const node = new PearldRpc(rpc);
  return {
    async getRawTransaction(txid) {
      try {
        return (await node.getRawTransaction(txid)).hex;
      } catch (err) {
        if (isUnknownTransaction(err)) return null;
        throw err;
      }
    },
  };
}

/** Full transactions from Oyster's gettransaction, falling back to its pearld for transactions that are not the wallet's own. */
export function oysterTransactionSource(rpc: Rpc): TransactionSource {
  const wallet = new OysterRpc(rpc);
  const node = pearldTransactionSource(rpc);
  return {
    async getRawTransaction(txid) {
      try {
        return (await wallet.getTransaction(txid)).hex;
      } catch (err) {
        if (!isUnknownTransaction(err)) throw err;
      }
      try {
        return await node.getRawTransaction(txid);
      } catch {
        return null;
      }
    },
  };
}

/** The part of PearlWsClient the wallet listens to. */
export type WalletNotifier = Pick<PearlWsClient, 'on' | 'watchBlocks' | 'notifyReceived'>;

/** What every wallet is opened with. */
export interface WalletConnection {
  store: WalletStore;
  backend: WalletBackend;
  transactions: TransactionSource;
  /** Milliseconds since the epoch; Date.now unless given. */
  now?: () => number;
}

/** Options for PearlWallet.create. */
export interface CreateWalletOptions extends WalletConnection {
  /** Encrypts the keystore. Needed unless the wallet is watch-only. */
  passphrase?: string | Uint8Array;
  /** A BIP39 phrase to use; a 24-word one is generated when neither this nor seed is given. */
  mnemonic?: string;
  /** The BIP39 passphrase (the "25th word"), if the mnemonic has one. */
  bip39Passphrase?: string;
  /** A raw 16 to 64 byte seed instead of a mnemonic. */
  seed?: Uint8Array;
  /** An account extended public key: a watch-only wallet with no keystore. */
  watchOnly?: string;
  /** Unused addresses in a row a restore scans before it stops; also the most unused receive addresses handed out in a row. OYSTER_RECOVERY_WINDOW unless given. */
  gapLimit?: number;
  /** DEFAULT_LOOKAHEAD unless given. */
  lookahead?: number;
  /** DEFAULT_REORG_DEPTH unless given. */
  reorgDepth?: number;
  /** scrypt cost for the keystore. */
  kdf?: KeystoreOptions['kdf'];
}

/** Brings stored records from an older schema version up to this one. */
export type WalletMigration = (context: { from: number; to: number; store: WalletStore }) => Promise<void>;

/** Options for PearlWallet.open. */
export interface OpenWalletOptions extends WalletConnection {
  /** Called when the store holds an older schema version, before anything is read. */
  migrate?: WalletMigration;
}

/** The non-secret state, as exportState returns it. Restore it with the keystore. */
export interface WalletBackup {
  format: 'pearljs-wallet-backup';
  version: 1;
  network: string;
  exportedAt: number;
  entries: Record<string, JsonValue>;
}

/** Options for PearlWallet.restore. */
export interface RestoreWalletOptions extends WalletConnection {
  keystore: EncryptedKeystore;
  passphrase: string | Uint8Array;
  /** The state exported earlier. Without it the wallet starts from its keys and the first sync scans the chain. */
  backup?: WalletBackup;
  /** BIP86 accounts to restore when there is no backup. [0] unless given. */
  accounts?: number[];
  gapLimit?: number;
}

/** Which of the wallet's outputs a send may spend. */
export type CoinSource = { account: string } | { imported: string } | { xmss: string } | 'all';

/** Options for send. */
export interface SendOptions {
  recipients: readonly Recipient[];
  /** Grain per 1000 vbytes; the backend's estimate unless given. */
  feeRate?: FeeRate;
  /** The highest fee rate this send may pay, in grain per 1000 vbytes. DEFAULT_MAX_FEE_RATE unless given; raise it to pay more on purpose. */
  maxFeeRate?: FeeRate;
  /** The first signing account unless given. 'all' spends any signing account, imported key or XMSS key. */
  from?: CoinSource;
  /** Confirmations a coin needs. 1 unless given, as Oyster's sends use. */
  minConfirmations?: number;
  /** Signal replace-by-fee, so bumpFee can replace the transaction. Off unless given, as in Oyster. */
  rbf?: boolean;
  strategy?: CoinSelectionStrategy<WalletCoin>;
  /** A note kept with the transaction. */
  label?: string;
}

/** What send, bumpFee and sweep return. Amounts in grain. */
export interface SendResult {
  txid: string;
  hex: string;
  fee: bigint;
  vsize: number;
  /** The change output's value, 0n when there is none. */
  change: bigint;
  changeAddress: string | null;
  inputs: { txid: string; vout: number; value: bigint }[];
  /** For bumpFee: the transaction this one replaces. */
  replaces?: string;
}

/** An account of the wallet. */
export interface WalletAccount {
  id: string;
  /** seed accounts sign through the keystore; xpub accounts are watch-only. */
  kind: 'seed' | 'xpub';
  /** The BIP86 account number, or null for an imported extended key. */
  number: number | null;
  xpub: string;
  label: string | null;
  nextReceiveIndex: number;
  nextChangeIndex: number;
}

/** An address the wallet handed out or saw paid. */
export interface WalletAddress {
  address: string;
  account: string;
  change: boolean;
  index: number;
  label: string | null;
  used: boolean;
}

/** An XMSS key the wallet holds. */
export interface WalletXmssKey {
  id: string;
  address: string;
  publicKey: string;
  label: string | null;
  /** The index the next signature takes. */
  nextIndex: number;
  remaining: number;
  /** Highest index seen in a signature on chain, or -1. */
  highestOnChain: number;
  /** Why the key refuses to sign until burnXmssIndices is called, or null. */
  frozen: 'restored' | 'behind' | null;
}

/** Events and what each carries. */
export interface WalletEvents {
  /** A transaction the wallet had not seen. */
  transaction: HistoryEntry;
  /** A transaction entered a block. */
  confirmation: { txid: string; block: BlockRef };
  /** A transaction stopped counting: conflicted, replaced, abandoned or orphaned. */
  conflict: { txid: string; status: TransactionStatus; by: string | null };
  /** Blocks the wallet had recorded left the chain; transactions from forkHeight up went back to pending. */
  reorg: { forkHeight: number; previousTip: BlockRef | null; tip: BlockRef };
  balance: WalletStateBalance;
  /** An XMSS key froze, or ran low. */
  xmss: { id: string; reason: 'behind' | 'low'; nextIndex: number; highestOnChain: number; remaining: number };
  /** A background sync or notification failed. */
  error: Error;
}

type Listener<T> = (value: T) => void;

/** A small typed event emitter. A listener that throws does not stop the others. */
export class WalletEmitter<E extends object> {
  #listeners = new Map<keyof E, Set<Listener<never>>>();

  on<K extends keyof E>(event: K, listener: (value: E[K]) => void): () => void {
    let set = this.#listeners.get(event);
    if (set === undefined) this.#listeners.set(event, (set = new Set()));
    set.add(listener as Listener<never>);
    return () => {
      set.delete(listener as Listener<never>);
    };
  }

  emit<K extends keyof E>(event: K, value: E[K]): void {
    for (const listener of [...(this.#listeners.get(event) ?? [])]) {
      try {
        (listener as Listener<E[K]>)(value);
      } catch {
        // A listener's failure is its own.
      }
    }
  }
}

interface AccountRecord {
  id: string;
  kind: 'seed' | 'xpub';
  number: number | null;
  xpub: string;
  label: string | null;
  receive: number;
  change: number;
}

interface AddressRecord {
  account: string;
  change: boolean;
  index: number;
  label: string | null;
  issuedAt: number;
}

interface XmssRecord {
  publicKey: string;
  address: string;
  next: number;
  label: string | null;
  frozen: 'restored' | 'behind' | null;
  seenOnChain: number;
  createdAt: number;
}

interface MetaRecord {
  format: 'pearljs-wallet';
  version: number;
  network: string;
  gapLimit: number;
  lookahead: number;
  reorgDepth: number;
  createdAt: number;
  /** Whether the first full scan has finished. */
  scanned: boolean;
}

interface TxEntry extends LedgerTransaction {
  /** False for a transaction of this wallet's whose broadcast has not been confirmed. */
  broadcast: boolean;
  /** The backend no longer knows this unconfirmed transaction. */
  missing: boolean;
  /** For this wallet's own sends: the change output's position, or -1. */
  changeOutput: number | null;
}

interface ChainCache {
  account: PearlAccount;
  addresses: [string[], string[]];
}

// A new transaction's history entry is worked out once, when the events are sent.
type PendingEvent = { [K in Exclude<keyof WalletEvents, 'transaction'>]: [K, WalletEvents[K]] }[Exclude<keyof WalletEvents, 'transaction'>] | ['transaction', string];

function checkPositive(value: number, what: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${what} must be a positive integer`);
  return value;
}

function checkRate(value: unknown, what: string): FeeRate {
  if (typeof value !== 'bigint' || value < 0n) throw new PearlError('FEE_RATE_INVALID', `${what} must be a non-negative bigint of grain per 1000 vbytes`);
  return value;
}

// The ceiling every wallet spend is held to: the fee is worked out here from
// the spent values and the outputs, not taken from whoever built the payment.
// Coin selection charges for Oyster's size estimate, which allows a weight
// unit more per signature than a Schnorr signature takes, so the limit is
// for that size and a payment built at exactly maxFeeRate passes.
function checkFeeCeiling(tx: Transaction, prevouts: readonly { value: bigint }[], vsize: number, maxFeeRate: FeeRate): void {
  const fee = prevouts.reduce((sum, prevout) => sum + prevout.value, 0n) - tx.outs.reduce((sum, output) => sum + output.value, 0n);
  if (prevouts.length !== tx.ins.length || fee < 0n) throw new SigningError('OUTPUTS_EXCEED_INPUTS', 'the transaction spends less than it pays');
  const charged = vsize + Math.ceil((tx.ins.length + 3) / 4);
  const limit = (BigInt(charged) * maxFeeRate + 999n) / 1000n;
  if (fee > limit) {
    throw new SigningError(
      'FEE_TOO_HIGH',
      `the transaction would pay a fee of ${fee} grain, above the ${limit} grain that maxFeeRate (${maxFeeRate} grain per 1000 vbytes) allows for ${vsize} vbytes; ` +
        'pass a lower feeRate, or raise maxFeeRate to pay it',
    );
  }
}

function asRecord<T>(value: JsonValue | undefined, what: string): T {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new StoreError('STORE_INVALID', `stored ${what} is not an object`);
  return value as unknown as T;
}

function txToJson(entry: TxEntry): JsonValue {
  return {
    hex: entry.tx.toHex(),
    block: entry.block === null ? null : { height: entry.block.height, hash: entry.block.hash },
    status: entry.status,
    seenAt: entry.seenAt,
    prevouts: entry.prevouts.map((prevout) => (prevout === null ? null : [toHex(prevout.script), encodeBigint(prevout.value)])),
    broadcast: entry.broadcast,
    missing: entry.missing,
    label: entry.label ?? null,
    by: entry.by ?? null,
    changeOutput: entry.changeOutput,
  };
}

function txFromJson(txid: string, value: JsonValue): TxEntry {
  const record = asRecord<{
    hex: string;
    block: { height: number; hash: string } | null;
    status: TxEntry['status'];
    seenAt: number;
    prevouts: ([string, string] | null)[];
    broadcast: boolean;
    missing: boolean;
    label: string | null;
    by: string | null;
    changeOutput: number | null;
  }>(value, `transaction ${txid}`);
  const tx = parseTransaction(record.hex);
  if (tx.getId() !== txid) throw new StoreError('STORE_INVALID', `stored transaction ${txid} has another txid`);
  return {
    txid,
    tx,
    block: record.block,
    status: record.status,
    seenAt: record.seenAt,
    prevouts: record.prevouts.map((prevout) =>
      prevout === null ? null : { script: decodeHex(prevout[0], 'prevout script'), value: decodeBigint(prevout[1], 'prevout value') },
    ),
    broadcast: record.broadcast,
    missing: record.missing,
    changeOutput: record.changeOutput,
    ...(record.label === null ? {} : { label: record.label }),
    ...(record.by === null ? {} : { by: record.by }),
  };
}

async function mapLimit<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      results[i] = await run(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

function xmssTree(publicKeyHex: string): ScriptTree {
  return assembleScriptTree([xmssLeafScript(decodeHex(publicKeyHex, 'XMSS public key'))]);
}

// The key-path signature of a single key, with the BIP86 tweak and fresh
// auxiliary randomness, as sweepKey makes it.
function signKeyPath(tx: Transaction, inputIndex: number, privateKey: Uint8Array, prevouts: readonly { script: Uint8Array; value: bigint }[]): void {
  const publicKey = ecc.pointFromScalar(privateKey, true);
  if (publicKey === null) throw new PearlError('KEY_INVALID', 'imported key is not a valid private key');
  const even = publicKey[0] === 0x03 ? ecc.privateNegate(privateKey) : Uint8Array.from(privateKey);
  const tweaked = ecc.privateAdd(even, taggedHash('TapTweak', publicKey.slice(1)));
  even.fill(0);
  if (tweaked === null) throw new PearlError('KEY_INVALID', 'taproot tweak produced an invalid key');
  try {
    const hash = tx.hashForWitnessV1(inputIndex, prevouts.map((p) => p.script), prevouts.map((p) => p.value), Transaction.SIGHASH_DEFAULT);
    const signature = ecc.signSchnorr(hash, tweaked, crypto.getRandomValues(new Uint8Array(32)));
    if (!ecc.verifySchnorr(hash, prevouts[inputIndex]!.script.subarray(2), signature)) throw new SigningError('SIGNATURE_INVALID', `invalid Taproot signature for input ${inputIndex}`);
    tx.setWitness(inputIndex, [signature]);
  } finally {
    tweaked.fill(0);
  }
}

// The index an XMSS witness signed with: the first four bytes of its first
// chunk, big-endian. Null for a witness of another shape.
function xmssWitnessIndex(witness: readonly Uint8Array[]): number | null {
  const chunk = witness[0];
  if (witness.length !== 7 || chunk === undefined || chunk.length !== XMSS_SIGNATURE_LENGTH / 5) return null;
  return new DataView(chunk.buffer, chunk.byteOffset, 4).getUint32(0);
}

// A backend and transaction source that answer each distinct query once
// and remember the answer, for the two runs of a sync. Broadcast and fee
// estimates are never remembered.
function memoized(backend: WalletBackend, source: TransactionSource): { backend: WalletBackend; source: TransactionSource } {
  const answers = new Map<string, Promise<unknown>>();
  const once = <T>(key: string, ask: () => Promise<T>): Promise<T> => {
    let answer = answers.get(key) as Promise<T> | undefined;
    if (answer === undefined) {
      answer = ask();
      answers.set(key, answer);
    }
    return answer;
  };
  const watchedKey = (watched: Watched): string => (typeof watched === 'string' ? watched : toHex(watched));
  const view: WalletBackend = {
    network: backend.network,
    getTip: () => once('tip', () => backend.getTip()),
    getAddressActivity: (address) => once(`activity:${address}`, () => backend.getAddressActivity(address)),
    getTransaction: (txid) => once(`tx:${txid}`, () => backend.getTransaction(txid)),
    getUtxos: (watched) => once(`utxos:${watched.map(watchedKey).sort().join(',')}`, () => backend.getUtxos(watched)),
    getBalance: (watched) => backend.getBalance(watched),
    getHistory: (watched) => once(`history:${watchedKey(watched)}`, () => backend.getHistory(watched)),
    broadcast: (tx) => backend.broadcast(tx),
    estimateFeeRate: (blocks) => backend.estimateFeeRate(blocks),
    getSpendStatus: (outpoint) => once(`spend:${outpoint.txid}:${outpoint.vout}`, () => backend.getSpendStatus(outpoint)),
  };
  const findUsed = backend.findUsed?.bind(backend);
  if (findUsed !== undefined) view.findUsed = (addresses) => once(`used:${addresses.join(',')}`, () => findUsed(addresses));
  return { backend: view, source: { getRawTransaction: (txid) => once(`raw:${txid}`, () => source.getRawTransaction(txid)) } };
}

/**
 * A wallet over a store and a backend. Make one with create, open or
 * restore; every method that changes state runs alone, in call order.
 */
export class PearlWallet {
  readonly network: PearlNetwork;
  readonly #store: WalletStore;
  // Swapped for a memoizing view while a sync applies what it fetched; see #speculate.
  #backend: WalletBackend;
  #source: TransactionSource;
  readonly #now: () => number;
  readonly #emitter = new WalletEmitter<WalletEvents>();

  #meta!: MetaRecord;
  #keystore: Keystore | null = null;
  #accounts = new Map<string, AccountRecord>();
  #chains = new Map<string, ChainCache>();
  #addresses = new Map<string, AddressRecord>();
  #imported = new Map<string, { address: string; label: string | null }>();
  #xmss = new Map<string, XmssRecord>();
  // Each XMSS record as the store last held it, which every write of one is conditional on.
  #xmssStored = new Map<string, JsonValue>();
  #txs = new Map<string, TxEntry>();
  #externalSpends = new Map<string, string | null>();
  #locks = new Map<string, number | null>();
  #tip: BlockRef | null = null;
  #owned = new Map<string, { owner: CoinOwner; address: string }>();
  #ops: StoreOperation[] = [];
  #queue: Promise<unknown> = Promise.resolve();
  #syncing: Promise<unknown> = Promise.resolve();
  #reserved = new Map<string, number>();
  #notifier: WalletNotifier | null = null;
  #stops: (() => void)[] = [];
  #closed = false;
  // Set when a failed operation could not reload the state: memory may hold what the store does not.
  #broken: unknown = null;

  private constructor(connection: WalletConnection) {
    this.#store = connection.store;
    this.#backend = connection.backend;
    this.#source = connection.transactions;
    this.#now = connection.now ?? Date.now;
    this.network = connection.backend.network;
  }

  /**
   * Makes a new wallet in an empty store: an encrypted keystore holding the
   * mnemonic (generated unless given) and its seed, and BIP86 account 0; or,
   * with watchOnly, one watch-only account and no keystore. The wallet is
   * returned unlocked. Nothing is synced yet.
   */
  static async create(options: CreateWalletOptions): Promise<PearlWallet> {
    const wallet = new PearlWallet(options);
    if ((await options.store.list('')).length > 0) throw new WalletError('WALLET_EXISTS', 'the store is not empty; open the wallet in it instead of creating one');
    const gapLimit = checkPositive(options.gapLimit ?? OYSTER_RECOVERY_WINDOW, 'gapLimit');
    const lookahead = checkPositive(options.lookahead ?? DEFAULT_LOOKAHEAD, 'lookahead');
    const reorgDepth = checkPositive(options.reorgDepth ?? DEFAULT_REORG_DEPTH, 'reorgDepth');
    wallet.#meta = {
      format: 'pearljs-wallet',
      version: WALLET_SCHEMA_VERSION,
      network: wallet.network.name,
      gapLimit,
      lookahead,
      reorgDepth,
      createdAt: wallet.#now(),
      scanned: false,
    };
    wallet.#put('meta', wallet.#meta as unknown as JsonValue);
    if (options.watchOnly !== undefined) {
      if (options.passphrase !== undefined || options.mnemonic !== undefined || options.seed !== undefined) {
        throw new WalletError('WALLET_WATCH_ONLY', 'a watch-only wallet takes an extended public key and no secrets');
      }
      const account = importWatchOnlyAccount(options.watchOnly, wallet.network);
      wallet.#addAccount({ id: 'watch-0', kind: 'xpub', number: null, xpub: account.extendedPublicKey(), label: null, receive: 0, change: 0 });
    } else {
      if (options.passphrase === undefined) throw new KeystoreError('KEYSTORE_INVALID', 'a wallet with keys needs a passphrase to encrypt them; pass watchOnly for a wallet without keys');
      if (options.mnemonic !== undefined && options.seed !== undefined) throw new PearlError('SEED_INVALID', 'give a mnemonic or a seed, not both');
      const keystore = await createKeystore(options.passphrase, options.kdf === undefined ? {} : { kdf: options.kdf });
      let seed: Uint8Array;
      if (options.seed !== undefined) {
        seed = Uint8Array.from(options.seed);
      } else {
        const mnemonic = normalizeMnemonic(options.mnemonic ?? generateMnemonic(24));
        if (!validateMnemonic(mnemonic)) throw new PearlError('MNEMONIC_INVALID', 'the mnemonic is not a valid BIP39 phrase');
        await keystore.addSecret('mnemonic', 'mnemonic', encoder.encode(mnemonic));
        seed = mnemonicToSeed(mnemonic, options.bip39Passphrase ?? '');
      }
      try {
        const account = deriveAccountFromSeed(seed, wallet.network, 0);
        await keystore.addSecret('seed', 'seed', seed);
        wallet.#addAccount({ id: '0', kind: 'seed', number: 0, xpub: account.extendedPublicKey(), label: null, receive: 0, change: 0 });
      } finally {
        seed.fill(0);
      }
      wallet.#keystore = keystore;
      wallet.#put('keystore', keystore.toJSON() as unknown as JsonValue);
    }
    await wallet.#flush();
    return wallet;
  }

  /** Opens the wallet in a store. The keystore starts locked. Throws when the store holds no wallet, or one of another network or a newer schema. */
  static async open(options: OpenWalletOptions): Promise<PearlWallet> {
    const wallet = new PearlWallet(options);
    const meta = await options.store.get('meta');
    if (meta === undefined) throw new WalletError('WALLET_NOT_FOUND', 'the store holds no wallet; create or restore one');
    const { version } = asRecord<MetaRecord>(meta, 'wallet metadata');
    if (!Number.isSafeInteger(version)) throw new StoreError('STORE_INVALID', 'stored wallet metadata has no schema version');
    if (version > WALLET_SCHEMA_VERSION) throw new WalletError('WALLET_SCHEMA', `the wallet was written by a newer pearljs (schema ${version}); this one reads schema ${WALLET_SCHEMA_VERSION}`);
    if (version < WALLET_SCHEMA_VERSION) {
      if (options.migrate === undefined) throw new WalletError('WALLET_SCHEMA', `the wallet has schema ${version} and needs migrating to ${WALLET_SCHEMA_VERSION}; pass migrate`);
      await options.migrate({ from: version, to: WALLET_SCHEMA_VERSION, store: options.store });
      const migrated = asRecord<MetaRecord>(await options.store.get('meta'), 'wallet metadata');
      await options.store.set('meta', { ...migrated, version: WALLET_SCHEMA_VERSION } as unknown as JsonValue);
    }
    await wallet.#load();
    return wallet;
  }

  /**
   * Restores a wallet into an empty store from its encrypted keystore and,
   * if there is one, a state backup. Every XMSS key comes back frozen: a
   * backup is older than the key's real index, so signing would repeat
   * indices until burnXmssIndices moves each key past every index it may
   * have used. Run sync afterwards; the first one scans with the gap limit.
   */
  static async restore(options: RestoreWalletOptions): Promise<PearlWallet> {
    if ((await options.store.list('')).length > 0) throw new WalletError('WALLET_EXISTS', 'the store is not empty; restore into an empty store');
    const keystore = openKeystore(options.keystore);
    await keystore.unlock(options.passphrase);
    const operations: StoreOperation[] = [{ type: 'set', key: 'keystore', value: keystore.toJSON() as unknown as JsonValue }];
    const network = options.backend.network;
    if (options.backup !== undefined) {
      const backup = options.backup;
      if (backup.format !== 'pearljs-wallet-backup' || backup.version !== 1) throw new WalletError('WALLET_BACKUP_INVALID', 'not a pearljs wallet backup');
      if (backup.network !== network.name) throw new WalletError('WALLET_WRONG_NETWORK', `the backup is for ${backup.network}, the backend for ${network.name}`);
      for (const [key, value] of Object.entries(backup.entries)) {
        if (key === 'keystore') continue;
        const restored = key.startsWith('xmss:') ? { ...asRecord<XmssRecord>(value, key), frozen: 'restored' } : value;
        operations.push({ type: 'set', key, value: restored as JsonValue });
      }
    } else {
      const now = (options.now ?? Date.now)();
      const meta: MetaRecord = {
        format: 'pearljs-wallet',
        version: WALLET_SCHEMA_VERSION,
        network: network.name,
        gapLimit: checkPositive(options.gapLimit ?? OYSTER_RECOVERY_WINDOW, 'gapLimit'),
        lookahead: DEFAULT_LOOKAHEAD,
        reorgDepth: DEFAULT_REORG_DEPTH,
        createdAt: now,
        scanned: false,
      };
      operations.push({ type: 'set', key: 'meta', value: meta as unknown as JsonValue });
      for (const number of options.accounts ?? [0]) {
        const xpub = await keystore.useSecret('seed', (seed) => deriveAccountFromSeed(seed, network, number).extendedPublicKey());
        const record: AccountRecord = { id: String(number), kind: 'seed', number, xpub, label: null, receive: 0, change: 0 };
        operations.push({ type: 'set', key: `account:${record.id}`, value: record as unknown as JsonValue });
      }
      for (const { id, kind } of keystore.secrets()) {
        if (kind === 'wif') {
          operations.push({ type: 'set', key: `imported:${id.slice(4)}`, value: { address: id.slice(4), label: null } });
        } else if (kind === 'xmss') {
          const publicKey = id.slice(5);
          const record: XmssRecord = {
            publicKey,
            address: encodeAddress({ version: 2, program: xmssTree(publicKey).root }, network),
            next: 0,
            label: null,
            frozen: 'restored',
            seenOnChain: -1,
            createdAt: now,
          };
          operations.push({ type: 'set', key: `xmss:${publicKey}`, value: record as unknown as JsonValue });
        }
      }
    }
    await options.store.batch(operations);
    const wallet = await PearlWallet.open(options);
    await wallet.#keystore!.unlock(options.passphrase);
    return wallet;
  }

  // ---- keystore

  /** Whether the wallet can sign: false for a watch-only wallet and while locked. */
  get locked(): boolean {
    return this.#keystore === null || this.#keystore.locked;
  }

  get watchOnly(): boolean {
    return this.#keystore === null;
  }

  /** Unlocks the keystore; with timeoutMs it locks itself again after that long. */
  async unlock(passphrase: string | Uint8Array, options: UnlockOptions = {}): Promise<void> {
    await this.#requireKeystore().unlock(passphrase, options);
  }

  lock(): void {
    this.#keystore?.lock();
  }

  /** Rewraps the keystore's data key under a new passphrase and stores it. */
  async changePassphrase(oldPassphrase: string | Uint8Array, newPassphrase: string | Uint8Array, options: Pick<KeystoreOptions, 'kdf'> = {}): Promise<void> {
    await this.#exclusive(async () => {
      const keystore = this.#requireKeystore();
      await keystore.changePassphrase(oldPassphrase, newPassphrase, options);
      this.#put('keystore', keystore.toJSON() as unknown as JsonValue);
      await this.#flush();
    });
  }

  /** The recovery phrase, for showing to the user once. Needs the wallet unlocked; null for a wallet made from a raw seed. */
  async mnemonic(): Promise<string | null> {
    const keystore = this.#requireKeystore();
    if (!keystore.has('mnemonic')) return null;
    return keystore.useSecret('mnemonic', (bytes) => decoder.decode(bytes));
  }

  /** The encrypted keystore, to back up apart from the state. */
  exportKeystore(): EncryptedKeystore {
    return this.#requireKeystore().toJSON();
  }

  // ---- accounts and addresses

  accounts(): WalletAccount[] {
    return [...this.#accounts.values()].map((record) => ({
      id: record.id,
      kind: record.kind,
      number: record.number,
      xpub: record.xpub,
      label: record.label,
      nextReceiveIndex: record.receive,
      nextChangeIndex: record.change,
    }));
  }

  /** Adds BIP86 account `number` of the wallet's seed. Needs the wallet unlocked. */
  async addAccount(number: number, options: { label?: string } = {}): Promise<WalletAccount> {
    return this.#exclusive(async () => {
      const id = String(number);
      if (this.#accounts.has(id)) throw new WalletError('WALLET_DUPLICATE', `account ${id} already exists`);
      const xpub = await this.#requireUnlocked().useSecret('seed', (seed) => deriveAccountFromSeed(seed, this.network, number).extendedPublicKey());
      this.#addAccount({ id, kind: 'seed', number, xpub, label: options.label ?? null, receive: 0, change: 0 });
      await this.#flush();
      return this.accounts().find((account) => account.id === id)!;
    });
  }

  /** Adds a watch-only account from its extended public key. */
  async addWatchOnlyAccount(xpub: string, options: { label?: string } = {}): Promise<WalletAccount> {
    return this.#exclusive(async () => {
      const account = importWatchOnlyAccount(xpub, this.network);
      if ([...this.#accounts.values()].some((record) => record.xpub === account.extendedPublicKey())) throw new WalletError('WALLET_DUPLICATE', 'that account is already in the wallet');
      let n = 0;
      while (this.#accounts.has(`watch-${n}`)) n += 1;
      const id = `watch-${n}`;
      this.#addAccount({ id, kind: 'xpub', number: null, xpub: account.extendedPublicKey(), label: options.label ?? null, receive: 0, change: 0 });
      await this.#flush();
      return this.accounts().find((item) => item.id === id)!;
    });
  }

  /**
   * Hands out the next receive address of an account and records it, with
   * its label. Every call gives a new address. Throws when the account
   * already has gapLimit unused addresses in a row, because a restore would
   * stop scanning before the next one.
   */
  async receiveAddress(options: { account?: string; label?: string } = {}): Promise<string> {
    return this.#exclusive(async () => {
      const record = this.#account(options.account);
      const used = this.#lastUsed(record.id, false);
      if (record.receive - (used + 1) >= this.#meta.gapLimit) {
        throw new WalletError(
          'WALLET_GAP_LIMIT',
          `account ${record.id} already has ${this.#meta.gapLimit} unused receive addresses in a row; ` +
            'a restore would not find payments past them. Reuse one of them (currentAddress) until one is paid',
        );
      }
      const address = this.#issue(record, false, options.label ?? null);
      await this.#flush();
      return address;
    });
  }

  /** The last receive address handed out if nothing has paid it yet, else a new one, as Oyster's CurrentAddress does (wallet/wallet/wallet.go:1810). */
  async currentAddress(options: { account?: string } = {}): Promise<string> {
    const record = this.#account(options.account);
    if (record.receive > 0) {
      const address = this.#derive(record.id, false, record.receive - 1);
      if (!this.#usedAddresses().has(address)) return address;
    }
    return this.receiveAddress(options);
  }

  /** Addresses handed out or paid, by account and index. */
  addresses(options: { account?: string } = {}): WalletAddress[] {
    const used = this.#usedAddresses();
    const list: WalletAddress[] = [];
    for (const record of this.#accounts.values()) {
      if (options.account !== undefined && record.id !== options.account) continue;
      for (const change of [false, true]) {
        const next = change ? record.change : record.receive;
        for (let index = 0; index < next; index += 1) {
          const address = this.#derive(record.id, change, index);
          list.push({ address, account: record.id, change, index, label: this.#addresses.get(address)?.label ?? null, used: used.has(address) });
        }
      }
    }
    return list;
  }

  async setLabel(address: string, label: string | null): Promise<void> {
    await this.#exclusive(async () => {
      const owned = this.#owned.get(toHex(toOutputScript(address, this.network)));
      if (owned === undefined || owned.owner.type !== 'account') throw new WalletError('WALLET_UNKNOWN', `${address} is not an account address of this wallet`);
      const { account, change, index } = owned.owner;
      const record = this.#addresses.get(address) ?? { account, change, index, label: null, issuedAt: this.#now() };
      this.#putAddress(address, { ...record, label });
      await this.#flush();
    });
  }

  async setTransactionLabel(txid: string, label: string | null): Promise<void> {
    await this.#exclusive(async () => {
      const entry = this.#txs.get(txid);
      if (entry === undefined) throw new WalletError('WALLET_UNKNOWN', `transaction ${txid} is not in the wallet`);
      if (label === null) delete entry.label;
      else entry.label = label;
      this.#putTx(entry);
      await this.#flush();
    });
  }

  /** Imports a WIF key: its key-path address is watched and its outputs spendable with from: { imported }. Needs the wallet unlocked. Returns the address, which is the key's id. */
  async importKey(wif: string, options: { label?: string } = {}): Promise<string> {
    return this.#exclusive(async () => {
      const keystore = this.#requireUnlocked();
      const { privateKey } = decodeWif(wif, this.network);
      const address = keyPathAddress(privateKey, this.network);
      privateKey.fill(0);
      if (this.#imported.has(address)) throw new WalletError('WALLET_DUPLICATE', `the key for ${address} is already imported`);
      await keystore.addSecret(`wif:${address}`, 'wif', encoder.encode(wif));
      this.#imported.set(address, { address, label: options.label ?? null });
      this.#own(toOutputScript(address, this.network), { type: 'imported', id: address }, address);
      this.#put(`imported:${address}`, { address, label: options.label ?? null });
      this.#put('keystore', keystore.toJSON() as unknown as JsonValue);
      await this.#flush();
      this.#notifyAddresses([address]);
      return address;
    });
  }

  // ---- XMSS

  /**
   * Adds an XMSS key, generated unless seeds are given. Seeds of a key that
   * has signed before need nextIndex: the wallet cannot know which indices
   * it used. Needs the wallet unlocked. Key generation takes about a second.
   */
  async addXmssKey(options: { label?: string; privateSeed?: Uint8Array; publicSeed?: Uint8Array; nextIndex?: number } = {}): Promise<WalletXmssKey> {
    return this.#exclusive(async () => {
      const keystore = this.#requireUnlocked();
      const given = options.privateSeed !== undefined || options.publicSeed !== undefined;
      if (given && (options.privateSeed === undefined || options.publicSeed === undefined)) throw new XmssError('XMSS_KEY_INVALID', 'give both XMSS seeds or neither');
      if (given && options.nextIndex === undefined) {
        throw new XmssError('XMSS_KEY_INVALID', 'an imported XMSS key needs nextIndex, the first index it has never signed with; the wallet cannot learn it');
      }
      const next = options.nextIndex ?? 0;
      if (!Number.isSafeInteger(next) || next < 0 || next > XMSS_MAX_SIGNATURES) throw new RangeError(`nextIndex must be between 0 and ${XMSS_MAX_SIGNATURES}`);
      const seeds = new Uint8Array(XMSS_SEED_BYTES);
      if (given) {
        seeds.set(options.privateSeed!, 0);
        seeds.set(options.publicSeed!, 64);
      } else {
        crypto.getRandomValues(seeds);
      }
      try {
        const pair = xmssKeygen(seeds.subarray(0, 64), seeds.subarray(64));
        pair.secretKey.fill(0);
        const publicKey = toHex(pair.publicKey);
        if (this.#xmss.has(publicKey)) throw new WalletError('WALLET_DUPLICATE', 'that XMSS key is already in the wallet');
        await keystore.addSecret(`xmss:${publicKey}`, 'xmss', seeds);
        const record: XmssRecord = {
          publicKey,
          address: encodeAddress({ version: 2, program: xmssTree(publicKey).root }, this.network),
          next,
          label: options.label ?? null,
          frozen: null,
          seenOnChain: -1,
          createdAt: this.#now(),
        };
        this.#putXmss(record);
        this.#put('keystore', keystore.toJSON() as unknown as JsonValue);
        await this.#flush();
        this.#notifyAddresses([record.address]);
        return this.#xmssView(record);
      } finally {
        seeds.fill(0);
      }
    });
  }

  xmssKeys(): WalletXmssKey[] {
    return [...this.#xmss.values()].map((record) => this.#xmssView(record));
  }

  /**
   * Moves an XMSS key's next index forward and unfreezes it. Never moves it
   * back. After a restore, pass an index past every one the key may have
   * used since the backup: past the highest seen on chain, and past any
   * signature made and not broadcast. Burning more costs signatures; burning
   * too few can lose the funds.
   */
  async burnXmssIndices(id: string, options: { nextIndex: number }): Promise<WalletXmssKey> {
    return this.#exclusive(async () => {
      const record = this.#xmss.get(id);
      if (record === undefined) throw new WalletError('WALLET_UNKNOWN', `no XMSS key ${id} in the wallet`);
      const { nextIndex } = options;
      if (!Number.isSafeInteger(nextIndex) || nextIndex > XMSS_MAX_SIGNATURES) throw new RangeError(`nextIndex must be an integer of at most ${XMSS_MAX_SIGNATURES}`);
      if (nextIndex < record.next) throw new XmssError('XMSS_INDEX_REUSE', `XMSS key ${id} is at index ${record.next}; an index never moves back`);
      if (nextIndex <= record.seenOnChain) throw new XmssError('XMSS_INDEX_REUSE', `XMSS key ${id} has signed with index ${record.seenOnChain} on chain; burn past it`);
      record.next = nextIndex;
      record.frozen = null;
      // Durable now, like a reservation.
      this.#putXmss(record);
      await this.#flush();
      return this.#xmssView(record);
    });
  }

  // ---- reading state

  /** Confirmed, unconfirmed, immature and locked grain, which add up to every unspent output. */
  balance(options: { account?: string } = {}): WalletStateBalance {
    const ledger = this.#ledger();
    if (options.account === undefined) return ledger.balance;
    return this.#sum(ledger.coins.filter((coin) => coin.owner.type === 'account' && coin.owner.account === options.account));
  }

  /** Every unspent output, locked ones included. */
  coins(): WalletCoin[] {
    return this.#ledger().coins;
  }

  /** Every recorded transaction, newest first. */
  history(): HistoryEntry[] {
    const ledger = this.#ledger();
    return computeHistory(this.#txs, ledger.status, this.#ownership(), this.#tip?.height ?? 0);
  }

  transaction(txid: string): (HistoryEntry & { hex: string; broadcast: boolean; missing: boolean }) | null {
    const entry = this.#txs.get(txid);
    if (entry === undefined) return null;
    const history = this.history().find((item) => item.txid === txid)!;
    return { ...history, hex: entry.tx.toHex(), broadcast: entry.broadcast, missing: entry.missing };
  }

  /** The block the wallet last synced to, or null before the first sync. */
  get tip(): BlockRef | null {
    return this.#tip;
  }

  on<K extends keyof WalletEvents>(event: K, listener: (value: WalletEvents[K]) => void): () => void {
    return this.#emitter.on(event, listener);
  }

  // ---- locks

  /** Keeps an output out of coin selection, until `until` (milliseconds since the epoch) or unlockOutpoint. Locks are stored. */
  async lockOutpoint(outpoint: { txid: string; vout: number }, options: { until?: number } = {}): Promise<void> {
    await this.#exclusive(async () => {
      const entry = this.#txs.get(outpoint.txid);
      const output = entry?.tx.outs[outpoint.vout];
      if (output === undefined || this.#ownerOf(output.script) === undefined) throw new WalletError('WALLET_UNKNOWN', `${outpoint.txid}:${outpoint.vout} is not an output of this wallet`);
      const key = outpointKey(outpoint.txid, outpoint.vout);
      this.#locks.set(key, options.until ?? null);
      this.#put(`lock:${key}`, { until: options.until ?? null });
      await this.#flush();
    });
  }

  async unlockOutpoint(outpoint: { txid: string; vout: number }): Promise<void> {
    await this.#exclusive(async () => {
      const key = outpointKey(outpoint.txid, outpoint.vout);
      this.#locks.delete(key);
      this.#del(`lock:${key}`);
      await this.#flush();
    });
  }

  lockedOutpoints(): { txid: string; vout: number; until: number | null }[] {
    const now = this.#now();
    return [...this.#locks]
      .filter(([, until]) => until === null || until > now)
      .map(([key, until]) => {
        const [txid, vout] = key.split(':');
        return { txid: txid!, vout: Number(vout), until };
      });
  }

  // ---- sync

  /**
   * Brings the wallet up to the chain: checks recorded blocks against it and
   * rolls back to the fork point if they left it, scans every account chain
   * (the whole gap limit on the first sync or with full, the lookahead
   * otherwise), fetches new transactions, finds spends the backend reports,
   * and settles pending transactions as confirmed, conflicted or missing.
   */
  async sync(options: { full?: boolean } = {}): Promise<void> {
    await this.#speculate((wallet, events) => wallet.#syncBody(events, options.full === true));
  }

  /** The cheap part of sync: the tip, reorgs and pending transactions, without scanning addresses. */
  async refresh(): Promise<void> {
    await this.#speculate(async (wallet, events) => {
      const tip = await wallet.#backend.getTip();
      await wallet.#reconcile(tip, events);
      await wallet.#checkPending(events);
      wallet.#setTip(tip);
    });
  }

  async #syncBody(events: PendingEvent[], full: boolean): Promise<void> {
    const tip = await this.#backend.getTip();
    await this.#reconcile(tip, events);
    const scanAll = full || !this.#meta.scanned;
    const seen = new Map<string, BlockRef | null>();
    for (const record of [...this.#accounts.values()]) {
      for (const change of [false, true]) await this.#scanChain(record, change, scanAll ? this.#meta.gapLimit : this.#meta.lookahead, seen);
    }
    const singles = [...this.#imported.keys(), ...[...this.#xmss.values()].map((record) => record.address)];
    await this.#collect(singles, seen);
    for (const [txid, block] of seen) {
      const entry = this.#txs.get(txid);
      if (entry !== undefined) this.#observe(entry, block, events);
      else await this.#fetchAndIngest(txid, block, events);
    }
    await this.#checkSpends(events);
    await this.#checkPending(events);
    this.#meta.scanned = true;
    this.#put('meta', this.#meta as unknown as JsonValue);
    this.#setTip(tip);
  }

  /**
   * Runs a sync without holding the operation lock through its network
   * calls. A scratch wallet opened from a copy of the store runs it first,
   * outside the lock, through a view of the backend that remembers every
   * answer. The real run then takes the lock and goes through the same
   * view, so the queries it repeats are answered from memory and it only
   * waits on the network for what changed in between (a send made
   * meanwhile, say). What it applies is still one operation ending in one
   * atomic batch, decided on the state as it is under the lock.
   */
  async #speculate(body: (wallet: PearlWallet, events: PendingEvent[]) => Promise<void>): Promise<void> {
    const run = this.#syncing.then(async () => {
      if (this.#closed) throw new WalletError('WALLET_CLOSED', 'this wallet is closed');
      const view = memoized(this.#backend, this.#source);
      const scratch = await PearlWallet.open({ store: createMemoryStore(await this.#store.list('')), backend: view.backend, transactions: view.source });
      scratch.#shareDerivations(this);
      await scratch.#exclusive((events) => body(scratch, events));
      // Derivations are deterministic, so what the scratch run derived is the real wallet's too.
      this.#shareDerivations(scratch);
      await this.#exclusive(async (events) => {
        const backend = this.#backend;
        const source = this.#source;
        this.#backend = view.backend;
        this.#source = view.source;
        try {
          await body(this, events);
        } finally {
          this.#backend = backend;
          this.#source = source;
        }
      });
    });
    this.#syncing = run.catch(() => undefined);
    return run;
  }

  // Takes over the longer of each derived address list, and the owned scripts that come with them.
  #shareDerivations(from: PearlWallet): void {
    for (const [id, chain] of from.#chains) {
      const mine = this.#chains.get(id);
      if (mine === undefined || mine.account.extendedPublicKey() !== chain.account.extendedPublicKey()) continue;
      for (const branch of [0, 1] as const) {
        if (chain.addresses[branch].length > mine.addresses[branch].length) mine.addresses[branch] = [...chain.addresses[branch]];
      }
    }
    for (const [script, owned] of from.#owned) if (!this.#owned.has(script)) this.#owned.set(script, owned);
  }

  /**
   * Forgets every transaction and scans the chain again from scratch with
   * the gap limit. Addresses, labels, locks and XMSS state are kept.
   */
  async rescan(): Promise<void> {
    await this.#exclusive(async () => {
      for (const txid of [...this.#txs.keys()]) {
        this.#txs.delete(txid);
        this.#del(`tx:${txid}`);
      }
      for (const key of [...this.#externalSpends.keys()]) this.#del(`spent:${key}`);
      this.#externalSpends.clear();
      this.#tip = null;
      this.#del('sync');
      this.#meta.scanned = false;
      this.#put('meta', this.#meta as unknown as JsonValue);
    });
    await this.sync({ full: true });
  }

  /**
   * Keeps the wallet in sync: a full sync every intervalMs (60 s unless
   * given) and, with a notifier such as a PearlWsClient, a refresh on every
   * block and the transactions pearld reports for the wallet's addresses as
   * they arrive. Failures are reported as error events. Returns a function
   * that stops it.
   */
  watch(options: { intervalMs?: number; notifier?: WalletNotifier } = {}): () => void {
    const report = (err: unknown): void => this.#emitter.emit('error', err instanceof Error ? err : new Error(String(err)));
    const timer = setInterval(() => this.sync().catch(report), options.intervalMs ?? 60_000);
    const stops: (() => void)[] = [() => clearInterval(timer)];
    const notifier = options.notifier;
    if (notifier !== undefined) {
      this.#notifier = notifier;
      const received = (notification: { transaction: string; block: BlockDetails | null }): void => {
        this.#notified(notification.transaction, notification.block).catch(report);
      };
      stops.push(notifier.on('recvtx', received));
      stops.push(notifier.on('redeemingtx', received));
      stops.push(notifier.watchBlocks({ onBlock: () => void this.refresh().catch(report), onError: report }));
      stops.push(
        notifier.on('connect', ({ reconnect }) => {
          if (!reconnect) return;
          this.#notifyAddresses(this.#watchedAddresses());
          this.sync().catch(report);
        }),
      );
      stops.push(() => {
        if (this.#notifier === notifier) this.#notifier = null;
      });
      this.#notifyAddresses(this.#watchedAddresses());
    }
    let stopped = false;
    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      for (const item of stops) item();
      this.#stops = this.#stops.filter((item) => item !== stop);
    };
    this.#stops.push(stop);
    return stop;
  }

  // ---- spending

  /**
   * Pays the recipients: selects coins as Oyster does, adds change to the
   * account's next change address, signs through the unlocked keystore,
   * checks the result against pearld's relay policy, records it, broadcasts
   * it and returns it. The transaction is recorded before it is broadcast,
   * so its coins are never selected twice; a broadcast the backend refuses
   * removes it again.
   */
  async send(options: SendOptions): Promise<SendResult> {
    return this.#exclusive(async (events) => {
      this.#requireUnlocked();
      const { feeRate, maxFeeRate } = await this.#feeRates(options);
      const minConfirmations = options.minConfirmations ?? 1;
      const coins = this.#spendable(options.from ?? { account: this.#firstSigningAccount().id });
      const changeAccount = this.#changeAccount(options.from);
      const changeIndex = changeAccount.change;
      const changeAddress = this.#derive(changeAccount.id, true, changeIndex);
      const payment = buildPayment<WalletCoin>({
        network: this.network,
        utxos: coins,
        recipients: options.recipients,
        feeRate,
        changeAddress,
        rbf: options.rbf === true,
        minConfirmations,
        coinbaseMaturity: this.network.coinbaseMaturity,
        ...(options.strategy === undefined ? {} : { strategy: options.strategy }),
      });
      if (payment.changeIndex >= 0) {
        changeAccount.change = changeIndex + 1;
        this.#putAccount(changeAccount);
        this.#extend(changeAccount.id, true);
      }
      return this.#signAndBroadcast(payment, { label: options.label, changeAddress: payment.changeIndex >= 0 ? changeAddress : null, maxFeeRate }, events);
    });
  }

  /**
   * Replaces an unconfirmed send of this wallet's that signalled
   * replace-by-fee with one paying feeRate: the same recipients, every
   * original input, and more inputs only if the change cannot cover the
   * fee. The fee is raised further if pearld's replacement rules need it.
   */
  async bumpFee(txid: string, options: { feeRate: FeeRate; maxFeeRate?: FeeRate }): Promise<SendResult> {
    return this.#exclusive(async (events) => {
      this.#requireUnlocked();
      const { maxFeeRate } = await this.#feeRates(options);
      const original = this.#txs.get(txid);
      const ledger = this.#ledger();
      if (original === undefined || ledger.status.get(txid) !== 'pending') throw new WalletError('WALLET_NOT_REPLACEABLE', `transaction ${txid} is not a pending transaction of this wallet`);
      if (original.changeOutput === null) throw new WalletError('WALLET_NOT_REPLACEABLE', `transaction ${txid} was not sent by this wallet`);
      if (!signalsReplacement(original.tx)) {
        throw new WalletError('WALLET_NOT_REPLACEABLE', `transaction ${txid} did not signal replace-by-fee; speed it up with a child that spends its change instead`);
      }
      for (const [outpoint, spender] of ledger.spentBy) {
        if (outpoint.startsWith(`${txid}:`)) throw new WalletError('WALLET_NOT_REPLACEABLE', `transaction ${spender} spends ${txid}; replacing ${txid} would evict it`);
      }
      const originals: WalletCoin[] = original.tx.ins.map((input, i) => {
        const prevout = original.prevouts[i];
        const owned = prevout === null || prevout === undefined ? undefined : this.#ownerOf(prevout.script);
        if (prevout === null || prevout === undefined || owned === undefined) throw new WalletError('WALLET_NOT_REPLACEABLE', `transaction ${txid} spends an output that is not this wallet's`);
        const parent = this.#txs.get(prevTxid(input));
        const confirmations = confirmationsFromHeight(parent?.block?.height, this.#tip?.height ?? 0);
        return {
          txid: prevTxid(input),
          vout: input.index,
          value: prevout.value,
          script: prevout.script,
          address: owned.address,
          owner: owned.owner,
          confirmations,
          coinbase: parent?.tx.isCoinbase() ?? false,
          height: parent?.block?.height ?? null,
          locked: false,
          ...this.#spendShape(owned.owner),
        };
      });
      const recipients: Recipient[] = original.tx.outs
        .map((output, i) => ({ output, i }))
        .filter(({ i }) => i !== original.changeOutput)
        .map(({ output }) => ({ script: Uint8Array.from(output.script), amount: output.value as bigint | 'max' }));
      let changeAddress: string | null = null;
      if (original.changeOutput >= 0) {
        changeAddress = this.#ownerOf(original.tx.outs[original.changeOutput]!.script)?.address ?? null;
      } else if (recipients.length === 1) {
        recipients[0]!.amount = 'max';
      } else {
        throw new WalletError('WALLET_NOT_REPLACEABLE', `transaction ${txid} has no change output to take the higher fee from`);
      }
      if (changeAddress === null && original.changeOutput >= 0) throw new WalletError('WALLET_NOT_REPLACEABLE', `the change of ${txid} is not this wallet's`);
      // pearld refuses a replacement that adds unconfirmed inputs, and the original's own outputs vanish with it.
      const others = this.#spendable(this.#sourceOf(originals[0]!.owner)).filter((coin) => coin.txid !== txid && coin.confirmations >= 1);
      const originalFee = original.prevouts.reduce((sum, p) => sum + p!.value, 0n) - original.tx.outs.reduce((sum, o) => sum + o.value, 0n);
      const originalVsize = original.tx.virtualSize();
      let feeRate = options.feeRate;
      let payment: Payment<WalletCoin> | undefined;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const base = {
          network: this.network,
          recipients,
          feeRate,
          rbf: true,
          minConfirmations: 0,
          coinbaseMaturity: this.network.coinbaseMaturity,
          ...(changeAddress === null ? {} : { changeAddress }),
        };
        try {
          payment = buildPayment<WalletCoin>({ ...base, utxos: originals, strategy: 'all' });
        } catch (err) {
          if (!(err instanceof InsufficientFundsError)) throw err;
          // Every original input first, so all of them are taken before any new one.
          payment = buildPayment<WalletCoin>({ ...base, utxos: [...originals, ...others], strategy: (coins) => [...coins] });
        }
        const needed = replacementFee([{ fee: originalFee, vsize: originalVsize }], payment.vsize);
        if (payment.fee >= needed) break;
        feeRate = (needed * 1000n + BigInt(payment.vsize) - 1n) / BigInt(payment.vsize) + 1n;
        payment = undefined;
      }
      if (payment === undefined) throw new WalletError('WALLET_NOT_REPLACEABLE', `could not reach the fee pearld needs to replace ${txid}`);
      const result = await this.#signAndBroadcast(payment, { label: original.label, changeAddress, replaces: original, maxFeeRate }, events);
      return { ...result, replaces: txid };
    });
  }

  /**
   * Moves everything held by a key outside the wallet, such as a paper
   * wallet's WIF, to a new receive address of the wallet. The key is used
   * once and not stored.
   */
  async sweep(options: { wif: string; feeRate?: FeeRate; maxFeeRate?: FeeRate; account?: string; label?: string }): Promise<SendResult> {
    return this.#exclusive(async (events) => {
      const { privateKey } = decodeWif(options.wif, this.network);
      try {
        const source = keyPathAddress(privateKey, this.network);
        const utxos = await this.#backend.getUtxos([source]);
        if (utxos.length === 0) throw new PearlError('INSUFFICIENT_FUNDS', `${source} holds nothing to sweep`);
        const { feeRate, maxFeeRate } = await this.#feeRates(options);
        const record = this.#account(options.account);
        const destination = this.#issue(record, false, options.label ?? 'sweep');
        const signed = sweepKey(privateKey, { network: this.network, utxos, destination, feeRate, minConfirmations: 0, coinbaseMaturity: this.network.coinbaseMaturity });
        checkFeeCeiling(signed.transaction, signed.prevouts, signed.vsize, maxFeeRate);
        const entry = this.#record(signed.transaction, signed.prevouts, { broadcast: false, changeOutput: null, label: options.label });
        await this.#flush();
        await this.#broadcast(entry, null);
        events.push(['transaction', entry.txid]);
        return {
          txid: signed.txid,
          hex: signed.hex,
          fee: signed.fee,
          vsize: signed.vsize,
          change: 0n,
          changeAddress: null,
          inputs: signed.inputs.map(({ txid, vout, value }) => ({ txid, vout, value })),
        };
      } finally {
        privateKey.fill(0);
      }
    });
  }

  /**
   * Gives up on a pending transaction that will not confirm: its inputs
   * become spendable again. If it confirms after all, the next sync takes
   * it back.
   */
  async abandon(txid: string): Promise<void> {
    await this.#exclusive(async (events) => {
      const entry = this.#txs.get(txid);
      if (entry === undefined || entry.status !== 'active' || entry.block !== null) throw new WalletError('WALLET_NOT_REPLACEABLE', `transaction ${txid} is not a pending transaction of this wallet`);
      entry.status = 'abandoned';
      this.#putTx(entry);
      events.push(['conflict', { txid, status: 'abandoned', by: null }]);
    });
  }

  /** Sends again every pending transaction the backend has lost or never acknowledged. Returns the txids it accepted. */
  async rebroadcast(): Promise<string[]> {
    return this.#exclusive(async () => {
      const sent: string[] = [];
      for (const entry of this.#txs.values()) {
        if (entry.status !== 'active' || entry.block !== null || (!entry.missing && entry.broadcast)) continue;
        try {
          await this.#backend.broadcast(entry.tx.toHex());
          entry.broadcast = true;
          entry.missing = false;
          this.#putTx(entry);
          sent.push(entry.txid);
        } catch {
          // Reported by the next sync, as conflicted or still missing.
        }
      }
      return sent;
    });
  }

  // ---- backup

  /** The non-secret state: accounts, addresses, labels, transactions, locks and XMSS indices. Keep it with exportKeystore. */
  async exportState(): Promise<WalletBackup> {
    return this.#exclusive(async () => {
      const entries: Record<string, JsonValue> = {};
      for (const [key, value] of await this.#store.list('')) if (key !== 'keystore') entries[key] = value;
      return { format: 'pearljs-wallet-backup', version: 1, network: this.network.name, exportedAt: this.#now(), entries };
    });
  }

  /** Stops watching, locks the keystore and closes the store. */
  async close(): Promise<void> {
    if (this.#closed) return;
    for (const stop of [...this.#stops]) stop();
    await this.#exclusive(async () => {
      this.#closed = true;
      this.#keystore?.lock();
      await this.#store.close();
    });
  }

  // ---- internals: state

  async #load(): Promise<void> {
    const entries = await this.#store.list('');
    const map = new Map(entries);
    this.#meta = asRecord<MetaRecord>(map.get('meta'), 'wallet metadata');
    if (this.#meta.format !== 'pearljs-wallet') throw new WalletError('WALLET_NOT_FOUND', 'the store does not hold a pearljs wallet');
    if (this.#meta.network !== this.network.name) throw new WalletError('WALLET_WRONG_NETWORK', `the wallet is for ${this.#meta.network}, the backend for ${this.network.name}`);
    const keystore = map.get('keystore');
    this.#keystore = keystore === undefined ? null : this.#keystore?.locked === false && JSON.stringify(this.#keystore.toJSON()) === JSON.stringify(keystore) ? this.#keystore : openKeystore(keystore);
    this.#accounts.clear();
    this.#chains.clear();
    this.#owned.clear();
    this.#addresses.clear();
    this.#imported.clear();
    this.#xmss.clear();
    this.#xmssStored.clear();
    this.#txs.clear();
    this.#externalSpends.clear();
    this.#locks.clear();
    const sync = map.get('sync');
    const tip = sync === undefined ? null : asRecord<BlockRef>(sync, 'sync tip');
    this.#tip = tip === null ? null : { height: tip.height, hash: tip.hash };
    for (const [key, value] of entries) {
      const name = key.slice(key.indexOf(':') + 1);
      if (key.startsWith('account:')) this.#addAccount(asRecord<AccountRecord>(value, key), false);
      else if (key.startsWith('address:')) this.#addresses.set(name, asRecord<AddressRecord>(value, key));
      else if (key.startsWith('imported:')) this.#imported.set(name, asRecord<{ address: string; label: string | null }>(value, key));
      else if (key.startsWith('xmss:')) {
        this.#xmss.set(name, asRecord<XmssRecord>(value, key));
        // A copy: the record above changes in memory before it is stored again.
        this.#xmssStored.set(name, structuredClone(value));
      }
      else if (key.startsWith('tx:')) this.#txs.set(name, txFromJson(name, value));
      else if (key.startsWith('spent:')) this.#externalSpends.set(name, asRecord<{ by: string | null }>(value, key).by);
      else if (key.startsWith('lock:')) this.#locks.set(name, asRecord<{ until: number | null }>(value, key).until);
    }
    for (const [address] of this.#imported) this.#own(toOutputScript(address, this.network), { type: 'imported', id: address }, address);
    for (const record of this.#xmss.values()) this.#own(toOutputScript(record.address, this.network), { type: 'xmss', id: record.publicKey }, record.address);
  }

  #put(key: string, value: JsonValue): void {
    this.#ops.push({ type: 'set', key, value });
  }

  #del(key: string): void {
    this.#ops.push({ type: 'delete', key });
  }

  #putTx(entry: TxEntry): void {
    this.#put(`tx:${entry.txid}`, txToJson(entry));
  }

  #putAccount(record: AccountRecord): void {
    this.#put(`account:${record.id}`, record as unknown as JsonValue);
  }

  #putAddress(address: string, record: AddressRecord): void {
    this.#addresses.set(address, record);
    this.#put(`address:${address}`, record as unknown as JsonValue);
  }

  #putXmss(record: XmssRecord): void {
    this.#xmss.set(record.publicKey, record);
    this.#own(toOutputScript(record.address, this.network), { type: 'xmss', id: record.publicKey }, record.address);
    this.#put(`xmss:${record.publicKey}`, record as unknown as JsonValue);
  }

  #setTip(tip: BlockRef): void {
    this.#tip = { height: tip.height, hash: tip.hash };
    this.#put('sync', { height: tip.height, hash: tip.hash, at: this.#now() });
  }

  async #flush(): Promise<void> {
    if (this.#ops.length === 0) return;
    // Later writes to one key replace earlier ones, so the batch holds each key once.
    const last = new Map<string, StoreOperation>();
    for (const op of this.#ops) last.set(op.key, op);
    this.#ops = [];
    const operations = [...last.values()];
    // An XMSS record is only ever written over the value this wallet last stored for it, so a
    // second writer of the store cannot have its index moved back, or move this wallet's.
    const guarded = operations.filter((op) => op.key.startsWith('xmss:'));
    if (guarded.length === 0) {
      await this.#store.batch(operations);
      return;
    }
    const expected = guarded.map((op) => ({ key: op.key, value: this.#xmssStored.get(op.key.slice(5)) }));
    const written = guarded.map((op) => structuredClone(op));
    if (!(await this.#store.compareAndSet(expected, operations))) {
      throw new XmssError('XMSS_INDEX_REUSE', 'the stored state of an XMSS key is not what this wallet last wrote: another writer is using the store. Nothing was written');
    }
    for (const op of written) {
      if (op.type === 'set') this.#xmssStored.set(op.key.slice(5), op.value);
      else this.#xmssStored.delete(op.key.slice(5));
    }
  }

  /**
   * Runs one state-changing operation at a time. Events it queues are sent
   * after its writes are stored, with a balance event if the balance moved.
   * On failure, the state is reloaded from the store.
   */
  async #exclusive<T>(run: (events: PendingEvent[]) => Promise<T>): Promise<T> {
    const result = this.#queue.then(async () => {
      if (this.#closed) throw new WalletError('WALLET_CLOSED', 'this wallet is closed');
      if (this.#broken !== null) throw this.#broken;
      const events: PendingEvent[] = [];
      const before = this.#ledger().balance;
      try {
        const value = await run(events);
        await this.#flush();
        const after = this.#ledger().balance;
        const history = events.some(([name]) => name === 'transaction') ? new Map(this.history().map((entry) => [entry.txid, entry])) : null;
        for (const [name, payload] of events) {
          if (name !== 'transaction') this.#emitter.emit(name, payload as never);
          else if (history?.has(payload)) this.#emitter.emit('transaction', history.get(payload)!);
        }
        if ((Object.keys(after) as (keyof WalletStateBalance)[]).some((key) => after[key] !== before[key])) this.#emitter.emit('balance', after);
        return value;
      } catch (err) {
        this.#ops = [];
        try {
          if (!this.#closed) await this.#load();
        } catch (reload) {
          // The store cannot be read back, so nothing more is done on what memory holds.
          this.#broken = reload;
        }
        throw err;
      }
    });
    this.#queue = result.catch(() => undefined);
    return result;
  }

  #requireKeystore(): Keystore {
    if (this.#keystore === null) throw new WalletError('WALLET_WATCH_ONLY', 'this wallet is watch-only and has no keystore');
    return this.#keystore;
  }

  #requireUnlocked(): Keystore {
    const keystore = this.#requireKeystore();
    if (keystore.locked) throw new WalletError('WALLET_LOCKED', 'the wallet is locked; unlock it with the passphrase first');
    return keystore;
  }

  // ---- internals: addresses

  #addAccount(record: AccountRecord, save = true): void {
    this.#accounts.set(record.id, record);
    const account = importWatchOnlyAccount(record.xpub, this.network);
    this.#chains.set(record.id, { account, addresses: [[], []] });
    if (save) this.#putAccount(record);
    this.#extend(record.id, false);
    this.#extend(record.id, true);
  }

  #account(id: string | undefined): AccountRecord {
    const record = id === undefined ? [...this.#accounts.values()][0] : this.#accounts.get(id);
    if (record === undefined) throw new WalletError('WALLET_UNKNOWN', id === undefined ? 'the wallet has no accounts' : `no account ${id} in the wallet`);
    return record;
  }

  #firstSigningAccount(): AccountRecord {
    const record = [...this.#accounts.values()].find((item) => item.kind === 'seed');
    if (record === undefined) throw new WalletError('WALLET_WATCH_ONLY', 'the wallet has no signing account');
    return record;
  }

  #changeAccount(from: CoinSource | undefined): AccountRecord {
    if (from !== undefined && from !== 'all' && 'account' in from) {
      const record = this.#account(from.account);
      if (record.kind !== 'seed') throw new WalletError('WALLET_WATCH_ONLY', `account ${record.id} is watch-only and cannot sign`);
      return record;
    }
    return this.#firstSigningAccount();
  }

  #derive(account: string, change: boolean, index: number): string {
    const chain = this.#chains.get(account)!;
    const list = chain.addresses[change ? 1 : 0];
    while (list.length <= index) {
      const i = list.length;
      const address = chain.account.deriveAddress(i, change);
      list.push(address);
      this.#own(toOutputScript(address, this.network), { type: 'account', account, change, index: i }, address);
    }
    return list[index]!;
  }

  // Derives (and so recognizes) every address up to the lookahead past the next index.
  #extend(account: string, change: boolean, window = this.#meta?.lookahead ?? DEFAULT_LOOKAHEAD): void {
    const record = this.#accounts.get(account)!;
    const next = change ? record.change : record.receive;
    this.#derive(account, change, next + window - 1);
  }

  #own(script: Uint8Array, owner: CoinOwner, address: string): void {
    this.#owned.set(toHex(script), { owner, address });
  }

  #ownerOf(script: Uint8Array): { owner: CoinOwner; address: string } | undefined {
    return this.#owned.get(toHex(script));
  }

  #issue(record: AccountRecord, change: boolean, label: string | null): string {
    const index = change ? record.change : record.receive;
    const address = this.#derive(record.id, change, index);
    if (change) record.change = index + 1;
    else record.receive = index + 1;
    this.#putAccount(record);
    this.#extend(record.id, change);
    this.#putAddress(address, { account: record.id, change, index, label, issuedAt: this.#now() });
    if (!change) this.#notifyAddresses([address]);
    return address;
  }

  #usedAddresses(): Set<string> {
    const used = new Set<string>();
    for (const entry of this.#txs.values()) {
      for (const output of entry.tx.outs) {
        const owned = this.#ownerOf(output.script);
        if (owned !== undefined) used.add(owned.address);
      }
    }
    return used;
  }

  #lastUsed(account: string, change: boolean): number {
    let last = -1;
    for (const entry of this.#txs.values()) {
      for (const output of entry.tx.outs) {
        const owner = this.#ownerOf(output.script)?.owner;
        if (owner?.type === 'account' && owner.account === account && owner.change === change) last = Math.max(last, owner.index);
      }
    }
    return last;
  }

  // A payment to an index at or past the next one moves the next index past it, as a restore would.
  #markUsed(tx: Transaction): void {
    for (const output of tx.outs) {
      const owner = this.#ownerOf(output.script)?.owner;
      if (owner?.type !== 'account') continue;
      const record = this.#accounts.get(owner.account)!;
      const next = owner.change ? record.change : record.receive;
      if (owner.index < next) continue;
      if (owner.change) record.change = owner.index + 1;
      else record.receive = owner.index + 1;
      this.#putAccount(record);
      this.#extend(record.id, owner.change);
    }
  }

  #watchedAddresses(): string[] {
    const list: string[] = [];
    for (const record of this.#accounts.values()) {
      for (const change of [false, true]) {
        const next = change ? record.change : record.receive;
        for (let i = 0; i < next + this.#meta.lookahead; i += 1) list.push(this.#derive(record.id, change, i));
      }
    }
    return [...list, ...this.#imported.keys(), ...[...this.#xmss.values()].map((record) => record.address)];
  }

  #notifyAddresses(addresses: string[]): void {
    const notifier = this.#notifier;
    if (notifier === null || addresses.length === 0) return;
    notifier.notifyReceived(addresses).catch((err: unknown) => this.#emitter.emit('error', err instanceof Error ? err : new Error(String(err))));
  }

  // ---- internals: ledger

  #ownership(): LedgerOwnership {
    return {
      owner: (script) => this.#ownerOf(script),
      address: (script) => {
        try {
          return fromOutputScript(script, this.network);
        } catch {
          return null;
        }
      },
    };
  }

  #ledger(): Ledger {
    return computeLedger(this.#txs, this.#ownership(), {
      tipHeight: this.#tip?.height ?? 0,
      coinbaseMaturity: this.network.coinbaseMaturity,
      externalSpends: new Set(this.#externalSpends.keys()),
      locks: this.#locks,
      now: this.#now(),
    });
  }

  #sum(coins: readonly WalletCoin[]): WalletStateBalance {
    const balance: WalletStateBalance = { confirmed: 0n, unconfirmed: 0n, immature: 0n, locked: 0n, total: 0n };
    for (const coin of coins) {
      if (coin.locked) balance.locked += coin.value;
      else if (coin.coinbase && coin.confirmations < this.network.coinbaseMaturity) balance.immature += coin.value;
      else if (coin.confirmations >= 1) balance.confirmed += coin.value;
      else balance.unconfirmed += coin.value;
      balance.total += coin.value;
    }
    return balance;
  }

  #spendShape(owner: CoinOwner): Pick<WalletCoin, 'spend'> {
    if (owner.type !== 'xmss') return {};
    return { spend: { type: 'scriptPath', tree: xmssTree(owner.id), leafIndex: 0, p2mr: true } };
  }

  #sourceOf(owner: CoinOwner): CoinSource {
    if (owner.type === 'account') return { account: owner.account };
    if (owner.type === 'imported') return { imported: owner.id };
    return { xmss: owner.id };
  }

  // Unlocked coins a source may spend, with what coin selection needs to price them.
  #spendable(from: CoinSource): WalletCoin[] {
    const accepts = (owner: CoinOwner): boolean => {
      if (owner.type === 'account' && this.#accounts.get(owner.account)?.kind !== 'seed') return false;
      if (owner.type === 'xmss' && this.#xmss.get(owner.id)?.frozen !== null) return false;
      if (from === 'all') return true;
      if ('account' in from) return owner.type === 'account' && owner.account === from.account;
      if ('imported' in from) return owner.type === 'imported' && owner.id === from.imported;
      return owner.type === 'xmss' && owner.id === from.xmss;
    };
    if (from !== 'all') {
      if ('account' in from) {
        const record = this.#account(from.account);
        if (record.kind !== 'seed') throw new WalletError('WALLET_WATCH_ONLY', `account ${record.id} is watch-only and cannot sign`);
      } else if ('imported' in from && !this.#imported.has(from.imported)) {
        throw new WalletError('WALLET_UNKNOWN', `no imported key ${from.imported} in the wallet`);
      } else if ('xmss' in from) {
        const record = this.#xmss.get(from.xmss);
        if (record === undefined) throw new WalletError('WALLET_UNKNOWN', `no XMSS key ${from.xmss} in the wallet`);
        this.#checkXmssUsable(record);
      }
    }
    return this.#ledger()
      .coins.filter((coin) => !coin.locked && accepts(coin.owner))
      .map((coin) => ({ ...coin, ...this.#spendShape(coin.owner) }));
  }

  #checkXmssUsable(record: XmssRecord): void {
    if (record.frozen === 'restored') {
      throw new XmssError(
        'XMSS_KEY_RESTORED',
        `XMSS key ${record.publicKey.slice(0, 16)} was restored from a backup and may have signed since it was taken; ` +
          'call burnXmssIndices with an index past every one it may have used before signing',
      );
    }
    if (record.frozen === 'behind') {
      throw new XmssError(
        'XMSS_KEY_BEHIND',
        `XMSS key ${record.publicKey.slice(0, 16)} has signed on chain with index ${record.seenOnChain}, at or past its stored next index; ` +
          'the wallet state is older than the key. Call burnXmssIndices past every index it may have used',
      );
    }
  }

  #xmssView(record: XmssRecord): WalletXmssKey {
    return {
      id: record.publicKey,
      address: record.address,
      publicKey: record.publicKey,
      label: record.label,
      nextIndex: record.next,
      remaining: Math.max(0, XMSS_MAX_SIGNATURES - record.next),
      highestOnChain: record.seenOnChain,
      frozen: record.frozen,
    };
  }

  // The index store an XMSS signer of this wallet reserves from. The advanced
  // record is written with compareAndSet over the record this wallet last
  // stored, so the store itself, not a read followed by a write, decides
  // that no other writer has moved the index; only then is the index
  // returned.
  #xmssIndexStore(): XmssIndexStore {
    const recordOf = (publicKey: Uint8Array): XmssRecord => {
      const record = this.#xmss.get(toHex(publicKey));
      if (record === undefined) throw new WalletError('WALLET_UNKNOWN', 'that XMSS key is not in the wallet');
      return record;
    };
    return {
      peek: (publicKey) => recordOf(publicKey).next,
      reserve: async (publicKey) => {
        const id = toHex(publicKey);
        const record = recordOf(publicKey);
        this.#checkXmssUsable(record);
        const index = record.next;
        // Index 30 is the last; past it nothing is recorded.
        if (index > XMSS_LAST_INDEX) throw new XmssError('XMSS_INDEX_EXHAUSTED', `this XMSS key has used all ${XMSS_MAX_SIGNATURES} of its signatures`);
        if (index <= record.seenOnChain || index <= (this.#reserved.get(id) ?? -1)) throw new XmssError('XMSS_INDEX_REUSE', `refusing to reuse XMSS index ${index}`);
        const advanced = { ...record, next: index + 1 } as unknown as JsonValue;
        const key = `xmss:${id}`;
        if (!(await this.#store.compareAndSet([{ key, value: this.#xmssStored.get(id) }], [{ type: 'set', key, value: advanced }]))) {
          throw new XmssError('XMSS_INDEX_REUSE', 'the stored XMSS index is not the one this wallet last wrote: another writer is using the store. Nothing was signed');
        }
        record.next = index + 1;
        this.#xmssStored.set(id, advanced);
        this.#reserved.set(id, index);
        return index;
      },
    };
  }

  // ---- internals: transactions

  #record(
    tx: Transaction,
    prevouts: LedgerTransaction['prevouts'],
    extra: { broadcast: boolean; changeOutput: number | null; label?: string | undefined; block?: BlockRef | null },
  ): TxEntry {
    const entry: TxEntry = {
      txid: tx.getId(),
      tx,
      block: extra.block ?? null,
      status: 'active',
      prevouts,
      seenAt: this.#now(),
      broadcast: extra.broadcast,
      missing: false,
      changeOutput: extra.changeOutput,
      ...(extra.label === undefined ? {} : { label: extra.label }),
    };
    this.#txs.set(entry.txid, entry);
    this.#markUsed(tx);
    this.#putTx(entry);
    return entry;
  }

  // An output of a recorded transaction that is the wallet's.
  #isOurOutput(txid: string, vout: number): boolean {
    const output = this.#txs.get(txid)?.tx.outs[vout];
    return output !== undefined && this.#ownerOf(output.script) !== undefined;
  }

  async #fetch(txid: string): Promise<Transaction | null> {
    const raw = await this.#source.getRawTransaction(txid);
    if (raw === null) return null;
    const tx = typeof raw === 'string' ? parseTransaction(raw) : Transaction.fromBuffer(raw);
    if (tx.getId() !== txid) throw new PearlError('BACKEND_RESPONSE', `the transaction source returned ${tx.getId()} for ${txid}`);
    return tx;
  }

  async #fetchAndIngest(txid: string, block: BlockRef | null, events: PendingEvent[]): Promise<TxEntry | null> {
    const tx = await this.#fetch(txid);
    return tx === null ? null : this.#ingest(tx, block, events);
  }

  /**
   * Records a transaction that pays or spends the wallet: the spent outputs'
   * scripts and values come from recorded transactions or the source, the
   * address indices move past what it pays, and any unconfirmed transaction
   * spending the same outputs is marked conflicted, as wtxmgr's
   * removeDoubleSpends does (wallet/wtxmgr/unconfirmed.go:68).
   */
  async #ingest(tx: Transaction, block: BlockRef | null, events: PendingEvent[]): Promise<TxEntry | null> {
    const txid = tx.getId();
    const relevant = tx.outs.some((output) => this.#ownerOf(output.script) !== undefined) || tx.ins.some((input) => this.#isOurOutput(prevTxid(input), input.index));
    if (!relevant) return null;
    const parents = new Map<string, Transaction | null>();
    const prevouts: LedgerTransaction['prevouts'] = [];
    if (!tx.isCoinbase()) {
      for (const input of tx.ins) {
        const parentId = prevTxid(input);
        let parent = this.#txs.get(parentId)?.tx ?? parents.get(parentId);
        if (parent === undefined) {
          parent = await this.#fetch(parentId).catch(() => null);
          parents.set(parentId, parent);
        }
        const output = parent?.outs[input.index];
        prevouts.push(output === undefined ? null : { script: Uint8Array.from(output.script), value: output.value });
      }
    }
    const entry = this.#record(tx, prevouts, { broadcast: true, changeOutput: null, block });
    this.#checkXmssWitnesses(entry, events);
    this.#settleConflicts(entry, events);
    events.push(['transaction', txid]);
    if (block !== null) events.push(['confirmation', { txid, block }]);
    return entry;
  }

  #checkXmssWitnesses(entry: TxEntry, events: PendingEvent[]): void {
    entry.prevouts.forEach((prevout, i) => {
      const owner = prevout === null ? undefined : this.#ownerOf(prevout.script)?.owner;
      if (owner?.type !== 'xmss') return;
      const index = xmssWitnessIndex(entry.tx.ins[i]!.witness);
      const record = this.#xmss.get(owner.id);
      if (index === null || record === undefined || index <= record.seenOnChain) return;
      record.seenOnChain = index;
      if (index >= record.next && record.frozen === null) {
        record.frozen = 'behind';
        events.push(['xmss', { id: record.publicKey, reason: 'behind', nextIndex: record.next, highestOnChain: index, remaining: XMSS_MAX_SIGNATURES - record.next }]);
      }
      this.#putXmss(record);
    });
  }

  // A transaction that is in a block, or that the backend has, wins over
  // every unconfirmed one spending the same outputs. `entry` is what the
  // backend has just reported, so when it is in a block and a recorded
  // transaction spending the same outputs is recorded in one too, the record
  // is the stale one: a chain holds only one of them.
  #settleConflicts(entry: TxEntry, events: PendingEvent[]): void {
    const spends = new Set(entry.tx.ins.map((input) => outpointKey(prevTxid(input), input.index)));
    for (const other of this.#txs.values()) {
      if (other === entry || other.status !== 'active') continue;
      if (!other.tx.ins.some((input) => spends.has(outpointKey(prevTxid(input), input.index)))) continue;
      const [loser, winner] = other.block === null || entry.block !== null ? [other, entry] : [entry, other];
      loser.status = 'conflicted';
      loser.by = winner.txid;
      loser.block = null;
      this.#putTx(loser);
      events.push(['conflict', { txid: loser.txid, status: 'conflicted', by: winner.txid }]);
    }
  }

  // What the backend says of a recorded transaction: in this block, or (null) in the mempool.
  #observe(entry: TxEntry, block: BlockRef | null, events: PendingEvent[]): void {
    const was = entry.block;
    let changed = entry.missing;
    entry.missing = false;
    if (block !== null) {
      if (entry.status !== 'active') {
        entry.status = 'active';
        delete entry.by;
        changed = true;
      }
      if (was === null || was.hash !== block.hash || was.height !== block.height) {
        entry.block = { height: block.height, hash: block.hash };
        events.push(['confirmation', { txid: entry.txid, block: entry.block }]);
        changed = true;
      }
      this.#settleConflicts(entry, events);
    } else {
      if (was !== null) {
        entry.block = null;
        changed = true;
      }
      // Back in the mempool, so active again unless an active transaction still spends its inputs.
      if (entry.status === 'conflicted' || entry.status === 'orphaned') {
        const spentBy = this.#ledger().spentBy;
        const clash = entry.tx.ins.some((input) => {
          const spender = spentBy.get(outpointKey(prevTxid(input), input.index));
          return spender !== undefined && spender !== entry.txid;
        });
        if (!clash) {
          entry.status = 'active';
          delete entry.by;
          changed = true;
        }
      }
    }
    if (changed) this.#putTx(entry);
  }

  async #collect(addresses: readonly string[], seen: Map<string, BlockRef | null>): Promise<Set<string>> {
    const used = new Set<string>();
    const histories = await mapLimit(addresses, CONCURRENCY, (address) => this.#backend.getHistory(address));
    histories.forEach((history, i) => {
      if (history.length > 0) used.add(addresses[i]!);
      for (const item of history) seen.set(item.txid, item.block);
    });
    return used;
  }

  // Scans one chain of an account from index 0 until `window` unused
  // addresses past the last used one, as discoverAccount does.
  async #scanChain(record: AccountRecord, change: boolean, window: number, seen: Map<string, BlockRef | null>): Promise<void> {
    let lastUsed = (change ? record.change : record.receive) - 1;
    for (let start = 0; start < lastUsed + 1 + window; ) {
      const count = Math.min(SCAN_BATCH, lastUsed + 1 + window - start);
      const batch = Array.from({ length: count }, (_, i) => this.#derive(record.id, change, start + i));
      const candidates = this.#backend.findUsed === undefined ? batch : await this.#backend.findUsed(batch);
      const used = await this.#collect(candidates, seen);
      batch.forEach((address, i) => {
        if (used.has(address)) lastUsed = Math.max(lastUsed, start + i);
      });
      start += count;
    }
    const next = lastUsed + 1;
    if (next > (change ? record.change : record.receive)) {
      if (change) record.change = next;
      else record.receive = next;
      this.#putAccount(record);
    }
    this.#extend(record.id, change);
  }

  // Outputs the ledger holds unspent that the backend no longer lists: find
  // the spender, so a spend made elsewhere (or one a backend leaves out of
  // history, as Oyster does) is not counted as money the wallet still has.
  async #checkSpends(events: PendingEvent[]): Promise<void> {
    const coins = this.#ledger().coins.filter((coin) => !(coin.coinbase && coin.confirmations < this.network.coinbaseMaturity));
    const marked = [...this.#externalSpends.keys()].map((key) => {
      const [txid, vout] = key.split(':');
      const output = this.#txs.get(txid!)?.tx.outs[Number(vout)];
      return { key, address: output === undefined ? undefined : this.#ownerOf(output.script)?.address };
    });
    const addresses = [...new Set([...coins.map((coin) => coin.address), ...marked.flatMap((item) => (item.address === undefined ? [] : [item.address]))])];
    if (addresses.length === 0) return;
    const listed = new Set((await this.#backend.getUtxos(addresses)).map((utxo) => outpointKey(utxo.txid, utxo.vout)));
    for (const { key } of marked) {
      if (!listed.has(key)) continue;
      this.#externalSpends.delete(key);
      this.#del(`spent:${key}`);
    }
    for (const coin of coins) {
      const key = outpointKey(coin.txid, coin.vout);
      if (listed.has(key)) continue;
      const status = await this.#backend.getSpendStatus({ txid: coin.txid, vout: coin.vout });
      if (status.status !== 'spent') continue;
      const spender = status.spender;
      if (spender !== undefined) {
        const known = this.#txs.get(spender);
        const where = await this.#backend.getTransaction(spender);
        if (known !== undefined) {
          // A spender the backend names and cannot find is no news about where it stands.
          if (where !== null) this.#observe(known, where.block, events);
          continue;
        }
        if ((await this.#fetchAndIngest(spender, where?.block ?? null, events)) !== null) continue;
      }
      this.#externalSpends.set(key, spender ?? null);
      this.#put(`spent:${key}`, { by: spender ?? null });
    }
  }

  // Each unconfirmed transaction: confirmed now, still in the mempool, or
  // gone; a gone one is conflicted when another transaction spends one of
  // its inputs, and missing otherwise.
  async #checkPending(events: PendingEvent[]): Promise<void> {
    for (const entry of [...this.#txs.values()]) {
      if (entry.status !== 'active' || entry.block !== null) continue;
      const found = await this.#backend.getTransaction(entry.txid);
      if (found !== null) {
        this.#observe(entry, found.block, events);
        continue;
      }
      let conflict: string | null | undefined;
      for (const input of entry.tx.ins) {
        if (entry.tx.isCoinbase()) break;
        const status = await this.#backend.getSpendStatus({ txid: prevTxid(input), vout: input.index });
        if (status.status === 'spent' && status.spender !== entry.txid) {
          conflict = status.spender ?? null;
          break;
        }
      }
      if (conflict === undefined) {
        if (!entry.missing) {
          entry.missing = true;
          this.#putTx(entry);
        }
        continue;
      }
      // Conflicted first, so a known rival that is only in the mempool finds its inputs free and becomes active again.
      entry.status = 'conflicted';
      if (conflict === null) delete entry.by;
      else entry.by = conflict;
      this.#putTx(entry);
      events.push(['conflict', { txid: entry.txid, status: 'conflicted', by: conflict }]);
      if (conflict === null) continue;
      const where = await this.#backend.getTransaction(conflict);
      const known = this.#txs.get(conflict);
      if (known === undefined) await this.#fetchAndIngest(conflict, where?.block ?? null, events);
      else if (where !== null) this.#observe(known, where.block, events);
    }
  }

  /**
   * When the tip moved, finds how far back the recorded blocks still stand.
   * Recorded blocks are walked from the highest down and every transaction
   * in each is looked up again. A block whose transactions the backend still
   * places in it anchors everything below it, since a block's hash commits
   * to its ancestors, so the walk goes on past reorgDepth below the last
   * synced tip only until it has met one such block. The window is measured
   * from the last synced tip, not the new one: blocks mined while the wallet
   * was away do not make an old reorg any shallower. A transaction the
   * backend no longer knows, or places elsewhere, is never left confirmed.
   *
   * The wallet then rolls back to the lowest block that did not stand, as
   * wtxmgr's rollback does (wallet/wtxmgr/tx.go:568): transactions from that
   * height up go back to pending, and coinbase transactions, which cannot
   * exist outside their block, become orphaned. The scan that follows
   * confirms again whatever the new chain holds.
   */
  async #reconcile(tip: BlockRef, events: PendingEvent[]): Promise<void> {
    const previous = this.#tip;
    if (previous !== null && previous.hash === tip.hash) return;
    const floor = previous === null ? Number.NEGATIVE_INFINITY : Math.min(previous.height, tip.height) - this.#meta.reorgDepth;
    const blocks = new Map<string, { height: number; hash: string; entries: TxEntry[] }>();
    for (const entry of this.#txs.values()) {
      if (entry.status !== 'active' || entry.block === null) continue;
      const key = `${entry.block.height}:${entry.block.hash}`;
      const block = blocks.get(key) ?? { height: entry.block.height, hash: entry.block.hash, entries: [] };
      block.entries.push(entry);
      blocks.set(key, block);
    }
    let fork = Number.POSITIVE_INFINITY;
    let anchored = false;
    for (const block of [...blocks.values()].sort((a, b) => b.height - a.height)) {
      if (anchored && block.height <= floor) break;
      let stands = block.height <= tip.height;
      if (stands) {
        const found = await mapLimit(block.entries, CONCURRENCY, (entry) => this.#backend.getTransaction(entry.txid));
        stands = found.every((item) => item !== null && item.block !== null && item.block.hash === block.hash && item.block.height === block.height);
      }
      if (stands) anchored = true;
      else fork = Math.min(fork, block.height);
    }
    if (fork === Number.POSITIVE_INFINITY) return;
    for (const entry of this.#txs.values()) {
      if (entry.status !== 'active' || entry.block === null || entry.block.height < fork) continue;
      if (entry.tx.isCoinbase()) {
        entry.status = 'orphaned';
        events.push(['conflict', { txid: entry.txid, status: 'orphaned', by: null }]);
      }
      entry.block = null;
      this.#putTx(entry);
    }
    events.push(['reorg', { forkHeight: fork, previousTip: previous, tip }]);
  }

  async #notified(hex: string, details: BlockDetails | null): Promise<void> {
    await this.#exclusive(async (events) => {
      const tx = parseTransaction(hex);
      const block = details === null ? null : { height: details.height, hash: details.hash };
      const entry = this.#txs.get(tx.getId());
      if (entry !== undefined) this.#observe(entry, block, events);
      else await this.#ingest(tx, block, events);
    });
  }

  // ---- internals: signing

  async #signAndBroadcast(
    payment: Payment<WalletCoin>,
    meta: { label?: string | undefined; changeAddress: string | null; replaces?: TxEntry; maxFeeRate: FeeRate },
    events: PendingEvent[],
  ): Promise<SendResult> {
    // Before any key is used: an XMSS signature spent on a refused payment is an index gone.
    checkFeeCeiling(payment.transaction, payment.prevouts, payment.vsize, meta.maxFeeRate);
    for (const [id, count] of this.#xmssInputCounts(payment.inputs)) {
      const record = this.#xmss.get(id)!;
      if (XMSS_MAX_SIGNATURES - record.next < count) throw new XmssError('XMSS_INDEX_EXHAUSTED', `XMSS key ${id.slice(0, 16)} has ${XMSS_MAX_SIGNATURES - record.next} signatures left, and this payment needs ${count}`);
    }
    const signed = await this.#sign(payment, meta.maxFeeRate);
    const final = finalizePayment(payment, { signed });
    const entry = this.#record(final.transaction, final.prevouts.map((p) => ({ script: Uint8Array.from(p.script), value: p.value })), {
      broadcast: false,
      changeOutput: final.changeIndex,
      label: meta.label,
    });
    const replaced = meta.replaces;
    if (replaced !== undefined) {
      replaced.status = 'replaced';
      replaced.by = entry.txid;
      this.#putTx(replaced);
    }
    // Stored before broadcast: a crash from here on leaves the coins spent, not free to be chosen again.
    await this.#flush();
    await this.#broadcast(entry, replaced ?? null);
    events.push(['transaction', entry.txid]);
    if (replaced !== undefined) events.push(['conflict', { txid: replaced.txid, status: 'replaced', by: entry.txid }]);
    for (const [id] of this.#xmssInputCounts(payment.inputs)) {
      const record = this.#xmss.get(id)!;
      const remaining = XMSS_MAX_SIGNATURES - record.next;
      if (remaining <= 3) events.push(['xmss', { id, reason: 'low', nextIndex: record.next, highestOnChain: record.seenOnChain, remaining }]);
    }
    return {
      txid: final.txid,
      hex: final.hex,
      fee: final.fee,
      vsize: final.vsize,
      change: final.change,
      changeAddress: meta.changeAddress,
      inputs: final.inputs.map(({ txid, vout, value }) => ({ txid, vout, value })),
    };
  }

  // A refusal from the node takes the transaction back out; any other
  // failure leaves it recorded as not yet broadcast, since it may have
  // reached the node, and rebroadcast or abandon settles it.
  async #broadcast(entry: TxEntry, replaced: TxEntry | null): Promise<void> {
    try {
      await this.#backend.broadcast(entry.tx.toHex());
    } catch (err) {
      // An error reply from the node, or a policy check a backend ran itself, is a refusal: the transaction is not in its mempool.
      if ((err instanceof PearlRpcError && err.code === 'RPC_ERROR') || err instanceof PolicyError) {
        this.#txs.delete(entry.txid);
        this.#del(`tx:${entry.txid}`);
        if (replaced !== null) {
          replaced.status = 'active';
          delete replaced.by;
          this.#putTx(replaced);
        }
        await this.#flush();
        throw new WalletError('WALLET_BROADCAST_REFUSED', `the node refused transaction ${entry.txid}: ${(err as Error).message}`, { cause: err });
      }
      throw new WalletError('WALLET_BROADCAST_UNCERTAIN', `broadcasting ${entry.txid} failed; it stays recorded as not broadcast, so call rebroadcast or abandon: ${(err as Error).message}`, { cause: err });
    }
    entry.broadcast = true;
    this.#putTx(entry);
  }

  // The rate to build with and the ceiling to hold the result to. A rate the
  // backend estimates is checked like any other answer of its: a value that
  // is not a positive rate, or one above the ceiling, is refused.
  async #feeRates(options: { feeRate?: FeeRate; maxFeeRate?: FeeRate }): Promise<{ feeRate: FeeRate; maxFeeRate: FeeRate }> {
    const maxFeeRate = checkRate(options.maxFeeRate ?? DEFAULT_MAX_FEE_RATE, 'maxFeeRate');
    if (options.feeRate !== undefined) {
      const feeRate = checkRate(options.feeRate, 'feeRate');
      if (feeRate > maxFeeRate) throw new SigningError('FEE_TOO_HIGH', `feeRate ${feeRate} is above maxFeeRate ${maxFeeRate} (grain per 1000 vbytes); raise maxFeeRate to pay it`);
      return { feeRate, maxFeeRate };
    }
    const estimate: unknown = await this.#backend.estimateFeeRate();
    if (typeof estimate !== 'bigint' || estimate <= 0n) throw new PearlError('BACKEND_RESPONSE', 'the backend estimated a fee rate that is not a positive bigint of grain per 1000 vbytes');
    if (estimate > maxFeeRate) {
      throw new SigningError(
        'FEE_TOO_HIGH',
        `the backend estimates a fee rate of ${estimate} grain per 1000 vbytes, above maxFeeRate ${maxFeeRate}; pass feeRate, or raise maxFeeRate to pay it`,
      );
    }
    return { feeRate: estimate, maxFeeRate };
  }

  #xmssInputCounts(inputs: readonly WalletCoin[]): Map<string, number> {
    const counts = new Map<string, number>();
    for (const coin of inputs) if (coin.owner.type === 'xmss') counts.set(coin.owner.id, (counts.get(coin.owner.id) ?? 0) + 1);
    return counts;
  }

  // Signs every input on one transaction: account inputs through a PSBT
  // whose key-path signatures are copied out, imported keys directly, and
  // XMSS inputs last, with the previous transactions the all-P2MR check
  // needs, which the wallet has recorded.
  async #sign(payment: Payment<WalletCoin>, maxFeeRate: FeeRate): Promise<Transaction> {
    const keystore = this.#requireUnlocked();
    const signed = payment.transaction.clone();
    const { psbt, inputs, prevouts } = payment;
    // Every input is prepared from the watch-only accounts before any key is decrypted.
    for (const [i, coin] of inputs.entries()) {
      const owner = coin.owner;
      if (owner.type === 'account') this.#chains.get(owner.account)!.account.prepareInput(psbt, i, { index: owner.index, change: owner.change, value: coin.value });
      else psbt.updateInput(i, { witnessUtxo: { script: coin.script, value: coin.value } });
    }
    const signers = new Map<string, PearlSigningAccount>();
    try {
      for (const [i, coin] of inputs.entries()) {
        const owner = coin.owner;
        if (owner.type !== 'account') continue;
        let signer = signers.get(owner.account);
        if (signer === undefined) {
          const record = this.#accounts.get(owner.account)!;
          if (record.kind !== 'seed' || record.number === null) throw new WalletError('WALLET_WATCH_ONLY', `account ${record.id} is watch-only and cannot sign`);
          signer = await keystore.useSecret('seed', (seed) => deriveSigningAccountFromSeed(seed, this.network, record.number!));
          signers.set(owner.account, signer);
          if (signer.watchOnlyAccount().extendedPublicKey() !== record.xpub) throw new KeystoreError('KEYSTORE_TAMPERED', `the keystore seed does not belong to account ${record.id}`);
        }
        // The child comes from the input's derivation, which prepareInput wrote.
        signer.signInput(psbt, i);
        const signature = psbt.data.inputs[i]?.tapKeySig;
        if (signature === undefined) throw new SigningError('SIGNATURES_MISSING', `input ${i} was not signed`);
        signed.setWitness(i, [Uint8Array.from(signature)]);
      }
    } finally {
      for (const signer of signers.values()) signer.destroy();
    }
    for (const [i, coin] of inputs.entries()) {
      const owner = coin.owner;
      if (owner.type !== 'imported') continue;
      await keystore.useSecret(`wif:${owner.id}`, (bytes) => {
        const { privateKey } = decodeWif(decoder.decode(bytes), this.network);
        try {
          signKeyPath(signed, i, privateKey, prevouts);
        } finally {
          privateKey.fill(0);
        }
      });
    }
    const previousTransactions = [...new Set(inputs.map((coin) => coin.txid))].map((txid) => this.#txs.get(txid)!.tx);
    for (const [id] of this.#xmssInputCounts(inputs)) {
      await keystore.useSecret(`xmss:${id}`, async (seeds) => {
        const privateSeed = seeds.slice(0, 64);
        const publicSeed = seeds.slice(64);
        const signer = createXmssSigner(privateSeed, publicSeed, this.#xmssIndexStore());
        privateSeed.fill(0);
        publicSeed.fill(0);
        try {
          if (toHex(signer.publicKey) !== id) throw new KeystoreError('KEYSTORE_TAMPERED', `the keystore seeds do not belong to XMSS key ${id.slice(0, 16)}`);
          const tree = xmssTree(id);
          for (const [i, coin] of inputs.entries()) {
            if (coin.owner.type !== 'xmss' || coin.owner.id !== id) continue;
            await signXmssP2mrInput(signed, i, signer, { prevouts, tree, leafIndex: 0, previousTransactions, maxFeeRate });
          }
        } finally {
          signer.destroy();
        }
      });
    }
    return signed;
  }
}

/** The P2MR output script of an XMSS public key alone in its tree, as the wallet's XMSS addresses use. */
export function xmssWalletScript(publicKey: Uint8Array): Uint8Array {
  return p2mr({ merkleRoot: assembleScriptTree([xmssLeafScript(publicKey)]).root }).output;
}
