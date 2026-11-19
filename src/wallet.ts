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
// sync does its network calls before it takes its turn (#speculate), on a
// copy of the state in memory, so a long scan does not hold up a send and a
// new block does not cost a read of the whole store.

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
import { mapLimit } from './internal/filter-scan.js';
import { decodeBigint, decodeHex, encodeBigint } from './internal/store-ops.js';
import { InsufficientFundsError, confirmationsFromHeight } from './coinselect.js';
import type { CoinSelectionStrategy } from './coinselect.js';
import { deriveAccountFromSeed, deriveSigningAccountFromSeed, importWatchOnlyAccount } from './keys.js';
import type { KeyOrigin, PearlAccount, PearlSigningAccount } from './keys.js';
import { createKeystore, openKeystore } from './keystore.js';
import { MAX_UNLOCK_TIMEOUT_MS } from './keystore.js';
import type { EncryptedKeystore, Keystore, KeystoreOptions, UnlockOptions } from './keystore.js';
import { generateMnemonic, mnemonicToSeed, validateMnemonic, normalizeMnemonic } from './mnemonic.js';
import type { PearlNetwork } from './networks.js';
import { replacementFee, signalsReplacement } from './rbf.js';
import { PearldRpc, OysterRpc, isUnknownTransaction } from './rpc.js';
import { verifyInput, verifyTransaction } from './interpreter.js';
import { checkStandard } from './policy.js';
import type { Rpc } from './rpc.js';
import { taggedHash, xmssLeafScript } from './script.js';
import { DEFAULT_MAX_FEE_RATE, signXmssP2mrInput } from './scriptpath.js';
import type { KeyPathSignerAsync } from './scriptpath.js';
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
import { computeHistory, computeLedger, outpointKey, prevTxid, spentFrom } from './wallet-ledger.js';
import type { CoinOwner, HistoryEntry, Ledger, LedgerOwnership, LedgerTransaction, TransactionStatus, WalletCoin, WalletStateBalance } from './wallet-ledger.js';
import { OYSTER_RECOVERY_WINDOW } from './discovery.js';

export type { CoinOwner, HistoryEntry, HistoryEntryJson, TransactionStatus, WalletBalanceJson, WalletCoin, WalletCoinJson, WalletStateBalance } from './wallet-ledger.js';
export { balanceFromJson, balanceToJson, coinFromJson, coinToJson, historyEntryFromJson, historyEntryToJson } from './wallet-ledger.js';

/** The version of the stored records this pearljs writes. */
export const WALLET_SCHEMA_VERSION = 1;
/** Unused addresses watched past the last used one on every sync after the first. */
export const DEFAULT_LOOKAHEAD = 20;
/** Confirmed transactions this deep or shallower are checked against the chain when the tip moves. */
export const DEFAULT_REORG_DEPTH = 100;
/** How long a wallet stays unlocked after create or restore unless told otherwise: five minutes. */
export const DEFAULT_CREATE_UNLOCK_MS = 300_000;

const SCAN_BATCH = 25;
/** Addresses one sync scans on one chain past the next index before it stops and reports the backend. */
export const DEFAULT_SCAN_LIMIT = 10_000;
/** How many syncs pass between two looks at an address that has been paid, holds nothing and has nothing pending. */
export const DEFAULT_QUIET_SYNC_INTERVAL = 10;
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

/**
 * A backend that can say what touched a set of addresses since a block, as
 * one that scans blocks or compact filters can. A wallet whose backend has
 * this asks it once per sync, in place of one history query per address.
 */
export interface ActivityScanner {
  /**
   * Every transaction that pays or spends from any of the watched addresses
   * and is in a block after `after` on the best chain, or in the mempool.
   * Null when it cannot answer from that block: `after` is not on its chain
   * any more, or lies before what it keeps. The wallet then asks address by
   * address.
   */
  getActivitySince(watched: readonly Watched[], after: BlockRef): Promise<{ txid: string; block: BlockRef | null }[] | null>;
}

/** What every wallet is opened with. */
export interface WalletConnection {
  store: WalletStore;
  backend: WalletBackend;
  /** Where full transactions come from. May be left out when the backend itself has getRawTransaction, as one object serving both roles does. */
  transactions?: TransactionSource;
  /** Milliseconds since the epoch; Date.now unless given. */
  now?: () => number;
  /**
   * How many syncs pass between two looks at an address that has been paid,
   * holds nothing and has nothing pending, when the backend has to be asked
   * address by address. DEFAULT_QUIET_SYNC_INTERVAL unless given; 1 asks
   * about every address in every sync.
   */
  quietSyncInterval?: number;
}

/** Options for watch. */
export interface WatchOptions {
  /** Milliseconds between full syncs; 60 seconds unless given. */
  pollInterval?: number;
  notifier?: WalletNotifier;
}

/** Options for sync. */
export interface SyncOptions {
  /** Scan the whole gap limit past the last used address and ask about every address, as the first sync does. */
  full?: boolean;
  /** Addresses to scan on one chain past its next index before giving the backend up. DEFAULT_SCAN_LIMIT unless given. */
  scanLimit?: number;
  /** Stops the sync while it is still asking the backend: it rejects with the signal's reason and changes nothing. */
  signal?: AbortSignal;
}

/** How far a sync has got, as the `sync` event reports it. */
export interface WalletSyncProgress {
  /** scanning: asking about addresses; fetching: taking in transactions; settling: spends and pending transactions; done: applied. */
  phase: 'scanning' | 'fetching' | 'settling' | 'done';
  /** Addresses asked about so far. */
  addresses: number;
  /** Transactions looked at so far. */
  transactions: number;
}

/** Which history entries to return. */
export interface HistoryOptions {
  /** Only transactions that pay or spend from this account. */
  account?: string;
  /** Only transactions that pay or spend from this address of the wallet. */
  address?: string;
  /** Entries to skip, newest first. 0 unless given. */
  offset?: number;
  /** The most entries to return. All unless given. */
  limit?: number;
}

/** The wallet at one version, for a UI to render from. The same object is returned until something changes. */
export interface WalletSnapshot {
  /** Counts every change to what the wallet holds or to whether it is locked or syncing. */
  readonly version: number;
  readonly tip: BlockRef | null;
  readonly balance: Readonly<WalletStateBalance>;
  readonly locked: boolean;
  readonly watchOnly: boolean;
  readonly syncing: boolean;
  /** Recorded transactions, and how many of them are pending. */
  readonly transactions: number;
  readonly pending: number;
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
  /** Where the watchOnly key comes from, [fingerprint/86'/coin'/account'], so the PSBTs the wallet prepares name the key a signer holds. */
  watchOnlyOrigin?: KeyOrigin;
  /**
   * How long the new wallet stays unlocked, in milliseconds. create returns
   * it unlocked, so that the recovery phrase can be shown, and it locks
   * itself after DEFAULT_CREATE_UNLOCK_MS unless this says otherwise: null
   * keeps it unlocked until lock(), 0 returns it locked.
   */
  unlockTimeout?: number | null;
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
  /** As for create: how long the restored wallet stays unlocked. */
  unlockTimeout?: number | null;
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
  /**
   * Signs the account coins in place of the keystore: a device or service
   * that holds the account's keys and answers key-path requests. With it a
   * send needs no unlocked keystore, and may spend a watch-only account's
   * coins, as long as it spends account coins only.
   */
  signer?: KeyPathSignerAsync;
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

/** How long prepareSend holds what it chose unless told otherwise: ten minutes. */
export const DEFAULT_PREPARE_HOLD_MS = 600_000;

/** Options for prepareSend: those of send, and how long to hold what it chooses. */
export interface PrepareSendOptions extends SendOptions {
  /**
   * How long the chosen coins and the change address are kept for
   * submitSigned, in milliseconds. DEFAULT_PREPARE_HOLD_MS unless given. 0
   * holds nothing: the result is a preview and cannot be submitted.
   */
  hold?: number;
}

/** A payment built and not signed, as prepareSend returns it. Amounts in grain. */
export interface PreparedSend {
  /** Names the hold, for cancelPrepared; null for a preview that holds nothing. */
  id: string | null;
  txid: string;
  /** The unsigned transaction as a base64 PSBT: every input with the output it spends and, for an account's coins, the key and derivation a signer needs. */
  psbt: string;
  /** The unsigned transaction, hex. */
  hex: string;
  fee: bigint;
  vsize: number;
  feeRate: FeeRate;
  /** The change output's value, 0n when there is none. */
  change: bigint;
  changeAddress: string | null;
  inputs: { txid: string; vout: number; value: bigint; address: string }[];
  /** Every output in order; `change` marks the wallet's own change. */
  outputs: { address: string | null; value: bigint; change: boolean }[];
  /** The transactions the inputs spend, hex, which a signer of P2MR inputs checks the spent values against. */
  previousTransactions: string[];
  /** When the hold ends, in milliseconds since the epoch; null for a preview. */
  expiresAt: number | null;
}

/** What a send would cost at one fee rate, as estimateSend returns it. */
export interface SendEstimate {
  feeRate: FeeRate;
  /** Null when the send cannot be built at this rate; `error` says why. */
  fee: bigint | null;
  vsize: number | null;
  inputs: number;
  change: bigint | null;
  error: Error | null;
}

/**
 * InsufficientFundsError from a wallet, with what the source holds and
 * could not spend. None of these amounts is part of `available`.
 */
export class WalletInsufficientFundsError extends InsufficientFundsError {
  override name = 'WalletInsufficientFundsError';
  /** Held by lockOutpoint or by a prepared send that has not been submitted, cancelled or expired. */
  readonly locked: bigint;
  /** Coinbase outputs short of maturity. */
  readonly immature: bigint;
  /** With fewer confirmations than the send asked for. */
  readonly unconfirmed: bigint;
  /** Held by an XMSS key that is frozen until burnXmssIndices. */
  readonly frozen: bigint;

  constructor(cause: InsufficientFundsError, held: { locked: bigint; immature: bigint; unconfirmed: bigint; frozen: bigint }) {
    super(cause.available, cause.required, cause.fee);
    this.locked = held.locked;
    this.immature = held.immature;
    this.unconfirmed = held.unconfirmed;
    this.frozen = held.frozen;
    const parts = (['locked', 'immature', 'unconfirmed', 'frozen'] as const).filter((part) => held[part] > 0n).map((part) => `${held[part]} grain ${part}`);
    this.message = cause.message + (parts.length > 0 ? `; the wallet also holds ${parts.join(', ')}, which this send could not spend` : '');
  }
}

/** What rebroadcast did with each pending transaction it sent again. */
export interface RebroadcastResult {
  /** Transactions the backend took, or already had. */
  accepted: string[];
  /** Transactions the backend refused; they stay pending until a sync settles them or abandon gives them up. */
  refused: { txid: string; error: Error }[];
  /** Transactions whose broadcast failed without an answer; they may have arrived. */
  failed: { txid: string; error: Error }[];
}

/** An account of the wallet. */
export interface WalletAccount {
  id: string;
  /** seed accounts sign through the keystore; xpub accounts are watch-only. */
  kind: 'seed' | 'xpub';
  /** The BIP86 account number, or null for an imported extended key. */
  number: number | null;
  xpub: string;
  /** The master fingerprint (8 hex characters) and path the key derives from, or null for an extended key added without them. */
  origin: { masterFingerprint: string; path: string } | null;
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
  /** A sync got further. Sent as it happens, while the sync is still asking the backend. */
  sync: WalletSyncProgress;
}

type Listener<T> = (value: T) => void;

/** A small typed event emitter. A listener that throws does not stop the others. */
class WalletEmitter<E extends object> {
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
  origin?: { masterFingerprint: string; path: string } | null;
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
  /** False from a restore until a sync has finished since, so the signatures the chain holds are known before the key is unfrozen. */
  synced?: boolean;
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
  /** Accounts ("account:" and the id) and keys' addresses added since the last sync, whose history before it no sync has asked for. */
  unscanned?: string[];
}

interface TxEntry extends LedgerTransaction {
  /** False for a transaction of this wallet's whose broadcast has not been confirmed. */
  broadcast: boolean;
  /** The backend no longer knows this unconfirmed transaction. */
  missing: boolean;
  /** For this wallet's own sends: the change output's position, or -1. */
  changeOutput: number | null;
  /** For this wallet's own sends: the output of the recipient that was sent the maximum, or -1 when every recipient was sent an amount. */
  maxOutput: number | null;
}

// Whose keys sign a payment being built: the keystore's, a signer's elsewhere (send with a signer,
// prepareSend), or nobody's yet (estimateSend).
type SpendMode = 'keystore' | 'elsewhere' | 'estimate';

// A payment prepareSend built and is holding coins for.
interface PreparedRecord {
  id: string;
  tx: Transaction;
  prevouts: { script: Uint8Array; value: bigint }[];
  /** "txid:vout" of each input. */
  inputs: string[];
  /** The change address's account and index on its change chain, held with the coins. */
  changeAccount: string | null;
  changeIndex: number | null;
  changeOutput: number;
  maxOutput: number;
  label: string | null;
  maxFeeRate: FeeRate;
  expiresAt: number;
}

function preparedToJson(record: PreparedRecord): JsonValue {
  return {
    hex: record.tx.toHex(),
    prevouts: record.prevouts.map((prevout) => [toHex(prevout.script), encodeBigint(prevout.value)]),
    changeAccount: record.changeAccount,
    changeIndex: record.changeIndex,
    changeOutput: record.changeOutput,
    maxOutput: record.maxOutput,
    label: record.label,
    maxFeeRate: encodeBigint(record.maxFeeRate),
    expiresAt: record.expiresAt,
  };
}

function preparedFromJson(id: string, value: JsonValue): PreparedRecord {
  const record = asRecord<{ hex: string; prevouts: [string, string][]; changeAccount: string | null; changeIndex: number | null; changeOutput: number; maxOutput: number; label: string | null; maxFeeRate: string; expiresAt: number }>(value, `prepared send ${id}`);
  const tx = parseTransaction(record.hex);
  if (!Array.isArray(record.prevouts) || record.prevouts.length !== tx.ins.length || !Number.isFinite(record.expiresAt)) throw invalid(`prepared send ${id}`);
  return {
    id,
    tx,
    prevouts: record.prevouts.map((prevout) => ({ script: decodeHex(prevout[0], 'prevout script'), value: decodeBigint(prevout[1], 'prevout value') })),
    inputs: tx.ins.map((input) => outpointKey(prevTxid(input), input.index)),
    changeAccount: record.changeAccount,
    changeIndex: record.changeIndex,
    changeOutput: record.changeOutput,
    maxOutput: record.maxOutput,
    label: record.label,
    maxFeeRate: decodeBigint(record.maxFeeRate, 'fee ceiling'),
    expiresAt: record.expiresAt,
  };
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

// What a failed broadcast says about where the transaction is. pearld
// answers a transaction it already holds with an error, "already have
// transaction in mempool" under the rejection code or -27 for one in a block
// (node/mempool/mempool.go:1389, node/rpcserver.go:3585-3592): the node has
// it, which is what a broadcast is for. A rule rejection (-26), bytes it
// cannot decode (-22) and an orphan (-25) leave the transaction out of the
// mempool. Anything else, another error code included, says nothing certain.
function broadcastOutcome(err: unknown): 'held' | 'refused' | 'unknown' {
  if (err instanceof PolicyError) return 'refused';
  if (!(err instanceof PearlRpcError) || err.code !== 'RPC_ERROR') return 'unknown';
  const text = err.message.toLowerCase();
  if (err.rpcCode === -27 || text.includes('already have transaction') || text.includes('transaction already exists')) return 'held';
  if (err.rpcCode === -26 || err.rpcCode === -22 || (err.rpcCode === -25 && text.includes('orphan transaction'))) return 'refused';
  return 'unknown';
}

function asRecord<T>(value: JsonValue | undefined, what: string): T {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new StoreError('STORE_INVALID', `stored ${what} is not an object`);
  return value as unknown as T;
}

function invalid(what: string): StoreError {
  return new StoreError('STORE_INVALID', `stored ${what} is not valid`);
}

const isIndex = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

function originOf(account: PearlAccount): { masterFingerprint: string; path: string } | null {
  return account.masterFingerprint === null || account.path === null ? null : { masterFingerprint: account.masterFingerprint, path: account.path };
}

function unlockTimeout(options: { unlockTimeout?: number | null }): number | null {
  const value = options.unlockTimeout;
  if (value === undefined) return DEFAULT_CREATE_UNLOCK_MS;
  if (value !== null && value !== 0) checkPositive(value, 'unlockTimeout');
  return value;
}

const TAMPERED_IDENTITY =
  "the wallet's accounts and keys are not the ones its keystore authenticated: an account's extended public key, an imported address or an XMSS key " +
  'was changed, added or removed in the store, or the keystore is not the one this state belongs to';

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
    maxOutput: entry.maxOutput,
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
    maxOutput?: number | null;
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
    maxOutput: record.maxOutput ?? null,
    ...(record.label === null ? {} : { label: record.label }),
    ...(record.by === null ? {} : { by: record.by }),
  };
}

// The outpoints a transaction spends; none for a coinbase.
function inputKeys(tx: Transaction): string[] {
  if (tx.isCoinbase()) return [];
  const from = spentFrom(tx);
  return tx.ins.map((input, i) => outpointKey(from[i]!, input.index));
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
  const since = (backend as Partial<ActivityScanner>).getActivitySince?.bind(backend);
  if (since !== undefined) {
    (view as WalletBackend & ActivityScanner).getActivitySince = (watched, after) => once(`since:${after.hash}:${watched.map(watchedKey).join(',')}`, () => since(watched, after));
  }
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
  // The recorded transactions spending each outpoint, in the order they were recorded: built when
  // first needed, extended as transactions are recorded, dropped when one is forgotten.
  #spendIndex: Map<string, string[]> | null = null;
  #externalSpends = new Map<string, string | null>();
  #locks = new Map<string, number | null>();
  #prepared = new Map<string, PreparedRecord>();
  #tip: BlockRef | null = null;
  // The highest block the wallet knows of: its synced tip, or the block of a transaction it was
  // told of since. Confirmations count from here, so a payment announced in a new block is
  // confirmed when its confirmation event fires, before the next refresh moves the tip.
  #height = 0;
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
  // The tag the keystore made over #identity(), as stored under `auth`.
  #auth: JsonValue | undefined;
  // The identity that tag was last checked against, or made for, in this process; null until then.
  #verified: string | null = null;
  readonly #quietInterval: number;
  // Syncs this wallet has run since it was opened; the first asks about every address.
  #rounds = 0;
  // Set on the copy a sync runs on first: where to stop, and where its progress goes.
  #signal: AbortSignal | undefined;
  #report: ((progress: WalletSyncProgress) => void) | null = null;
  #progress = { addresses: 0, transactions: 0 };
  #version = 0;
  #snapshot: WalletSnapshot | null = null;
  #subscribers = new Set<() => void>();
  #syncs = 0;
  #wrote = false;
  #watched = new WeakSet<Keystore>();

  private constructor(connection: WalletConnection) {
    this.#store = connection.store;
    this.#backend = connection.backend;
    const both = connection.backend as WalletBackend & Partial<TransactionSource>;
    const source = connection.transactions ?? (typeof both.getRawTransaction === 'function' ? { getRawTransaction: (txid: string) => both.getRawTransaction!(txid) } : undefined);
    if (source === undefined) throw new TypeError('a wallet needs transactions, a source of full transactions, unless its backend has getRawTransaction');
    this.#source = source;
    this.#now = connection.now ?? Date.now;
    this.#quietInterval = checkPositive(connection.quietSyncInterval ?? DEFAULT_QUIET_SYNC_INTERVAL, 'quietSyncInterval');
    this.network = connection.backend.network;
  }

  /**
   * Makes a new wallet in an empty store: an encrypted keystore holding the
   * mnemonic (generated unless given) and its seed, and BIP86 account 0; or,
   * with watchOnly, one watch-only account and no keystore. A wallet with
   * keys is returned unlocked, so the phrase can be read, and locks itself
   * after unlockTimeout. Nothing is synced yet.
   */
  static async create(options: CreateWalletOptions): Promise<PearlWallet> {
    const wallet = new PearlWallet(options);
    if ((await options.store.list('')).length > 0) throw new WalletError('WALLET_EXISTS', 'the store is not empty; open the wallet in it instead of creating one');
    const gapLimit = checkPositive(options.gapLimit ?? OYSTER_RECOVERY_WINDOW, 'gapLimit');
    const lookahead = checkPositive(options.lookahead ?? DEFAULT_LOOKAHEAD, 'lookahead');
    const reorgDepth = checkPositive(options.reorgDepth ?? DEFAULT_REORG_DEPTH, 'reorgDepth');
    const timeout = unlockTimeout(options);
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
      const account = importWatchOnlyAccount(options.watchOnly, wallet.network, options.watchOnlyOrigin);
      wallet.#addAccount({ id: 'watch-0', kind: 'xpub', number: null, xpub: account.extendedPublicKey(), origin: originOf(account), label: null, receive: 0, change: 0 });
    } else {
      if (options.watchOnlyOrigin !== undefined) throw new WalletError('WALLET_WATCH_ONLY', 'watchOnlyOrigin goes with watchOnly');
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
        wallet.#addAccount({ id: '0', kind: 'seed', number: 0, xpub: account.extendedPublicKey(), origin: originOf(account), label: null, receive: 0, change: 0 });
      } finally {
        seed.fill(0);
      }
      wallet.#keystore = keystore;
      wallet.#watchKeystore();
      wallet.#put('keystore', keystore.toJSON() as unknown as JsonValue);
      await wallet.#seal();
      if (timeout === 0) keystore.lock();
      else if (timeout !== null) keystore.lockAfter(timeout);
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
   * if there is one, a state backup. Everything is checked before anything
   * is written: the backup's records are read as a wallet reads them, and
   * its accounts and keys must be the ones the keystore authenticated when
   * the backup was made (WALLET_BACKUP_INVALID otherwise), so a failed
   * restore leaves the store empty. Every XMSS key comes back frozen: a
   * backup is older than the key's real index, so signing would repeat
   * indices until burnXmssIndices moves each key past every index it may
   * have used. Run sync afterwards; the first one scans with the gap limit.
   */
  static async restore(options: RestoreWalletOptions): Promise<PearlWallet> {
    if ((await options.store.list('')).length > 0) throw new WalletError('WALLET_EXISTS', 'the store is not empty; restore into an empty store');
    const timeout = unlockTimeout(options);
    const network = options.backend.network;
    const now = (options.now ?? Date.now)();
    const keystore = openKeystore(options.keystore);
    const entries = new Map<string, JsonValue>([['keystore', keystore.toJSON() as unknown as JsonValue]]);
    const backup = options.backup;
    if (backup !== undefined) {
      if (backup === null || typeof backup !== 'object' || backup.format !== 'pearljs-wallet-backup' || backup.version !== 1) throw new WalletError('WALLET_BACKUP_INVALID', 'not a pearljs wallet backup');
      if (backup.network !== network.name) throw new WalletError('WALLET_WRONG_NETWORK', `the backup is for ${backup.network}, the backend for ${network.name}`);
      if (backup.entries === null || typeof backup.entries !== 'object' || Array.isArray(backup.entries)) throw new WalletError('WALLET_BACKUP_INVALID', 'the wallet backup has no entries');
      for (const [key, value] of Object.entries(backup.entries)) if (key !== 'keystore') entries.set(key, value);
    } else {
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
      entries.set('meta', meta as unknown as JsonValue);
    }
    // A wallet over a copy in memory does the reading and checking; the store is written once, at the end.
    const scratchStore = createMemoryStore(entries);
    let scratch: PearlWallet;
    try {
      scratch = await PearlWallet.open({ ...options, store: scratchStore });
    } catch (err) {
      if (backup === undefined || (err instanceof WalletError && err.code !== 'WALLET_NOT_FOUND')) throw err;
      throw new WalletError('WALLET_BACKUP_INVALID', `the wallet backup cannot be read as a wallet: ${(err as Error).message}`, { cause: err });
    }
    const unlocked = scratch.#keystore!;
    await unlocked.unlock(options.passphrase);
    try {
      await scratch.#exclusive(async () => {
        if (backup !== undefined) {
          try {
            await scratch.#authenticate();
          } catch (err) {
            throw new WalletError('WALLET_BACKUP_INVALID', `the wallet backup does not belong to this keystore as it is: ${(err as Error).message}`, { cause: err });
          }
        } else {
          for (const number of options.accounts ?? [0]) {
            const account = await unlocked.useSecret('seed', (seed) => deriveAccountFromSeed(seed, network, number));
            scratch.#addAccount({ id: String(number), kind: 'seed', number, xpub: account.extendedPublicKey(), origin: originOf(account), label: null, receive: 0, change: 0 });
          }
          for (const { id, kind } of unlocked.secrets()) {
            if (kind === 'wif') {
              const address = id.slice(4);
              scratch.#imported.set(address, { address, label: null });
              scratch.#put(`imported:${address}`, { address, label: null });
            } else if (kind === 'xmss') {
              const publicKey = id.slice(5);
              scratch.#putXmss({ publicKey, address: encodeAddress({ version: 2, program: xmssTree(publicKey).root }, network), next: 0, label: null, frozen: null, seenOnChain: -1, createdAt: now });
            }
          }
          await scratch.#seal();
        }
        for (const record of scratch.#xmss.values()) scratch.#putXmss({ ...record, frozen: 'restored', synced: false });
      });
    } finally {
      unlocked.lock();
    }
    await options.store.batch((await scratchStore.list('')).map(([key, value]) => ({ type: 'set', key, value })));
    const wallet = await PearlWallet.open(options);
    if (timeout !== 0) await wallet.unlock(options.passphrase, timeout === null ? {} : { timeout });
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

  /**
   * Unlocks the keystore; with timeout it locks itself again after that
   * long. Before it resolves, the wallet's accounts, imported addresses and
   * XMSS keys are checked against the tag the keystore made over them, and
   * the keystore against the keys the wallet holds: KEYSTORE_TAMPERED, and
   * the wallet stays locked, if the store was changed behind the wallet.
   */
  async unlock(passphrase: string | Uint8Array, options: UnlockOptions = {}): Promise<void> {
    const keystore = this.#requireKeystore();
    await keystore.unlock(passphrase, options);
    // In turn with the wallet's operations, so it checks a state none of them is half way through changing.
    await this.#enqueue(async () => (keystore.locked ? undefined : this.#authenticate()));
    this.#changed();
  }

  lock(): void {
    this.#keystore?.lock();
  }

  /**
   * Changes the passphrase: the keystore makes a new data key, encrypts
   * every secret again under it and wraps it under the new passphrase, and
   * the wallet's accounts and keys are authenticated again under the new
   * key, all stored in one write. Needs the wallet unlocked. A copy of the
   * store made before the change still opens with the old passphrase; what
   * is added afterwards does not.
   */
  async changePassphrase(oldPassphrase: string | Uint8Array, newPassphrase: string | Uint8Array, options: Pick<KeystoreOptions, 'kdf'> = {}): Promise<void> {
    await this.#exclusive(async () => {
      const keystore = await this.#unlocked();
      await keystore.changePassphrase(oldPassphrase, newPassphrase, options);
      this.#put('keystore', keystore.toJSON() as unknown as JsonValue);
      await this.#seal();
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
      origin: record.origin ?? null,
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
      const account = await (await this.#unlocked()).useSecret('seed', (seed) => deriveAccountFromSeed(seed, this.network, number));
      this.#addAccount({ id, kind: 'seed', number, xpub: account.extendedPublicKey(), origin: originOf(account), label: options.label ?? null, receive: 0, change: 0 });
      this.#markUnscanned(`account:${id}`);
      await this.#seal();
      await this.#flush();
      return this.accounts().find((account) => account.id === id)!;
    });
  }

  /**
   * Adds a watch-only account from its extended public key, with the origin
   * a signer that holds the key expects in a PSBT if it is given. A wallet
   * with a keystore must be unlocked, because the account joins the records
   * the keystore authenticates.
   */
  async addWatchOnlyAccount(xpub: string, options: { label?: string; origin?: KeyOrigin } = {}): Promise<WalletAccount> {
    return this.#exclusive(async () => {
      if (this.#keystore !== null) await this.#unlocked();
      const account = importWatchOnlyAccount(xpub, this.network, options.origin);
      if ([...this.#accounts.values()].some((record) => record.xpub === account.extendedPublicKey())) throw new WalletError('WALLET_DUPLICATE', 'that account is already in the wallet');
      let n = 0;
      while (this.#accounts.has(`watch-${n}`)) n += 1;
      const id = `watch-${n}`;
      this.#addAccount({ id, kind: 'xpub', number: null, xpub: account.extendedPublicKey(), origin: originOf(account), label: options.label ?? null, receive: 0, change: 0 });
      this.#markUnscanned(`account:${id}`);
      await this.#seal();
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
      const keystore = await this.#unlocked();
      const { privateKey } = decodeWif(wif, this.network);
      const address = keyPathAddress(privateKey, this.network);
      privateKey.fill(0);
      if (this.#imported.has(address)) throw new WalletError('WALLET_DUPLICATE', `the key for ${address} is already imported`);
      await keystore.addSecret(`wif:${address}`, 'wif', encoder.encode(wif));
      this.#imported.set(address, { address, label: options.label ?? null });
      this.#own(toOutputScript(address, this.network), { type: 'imported', id: address }, address);
      this.#put(`imported:${address}`, { address, label: options.label ?? null });
      this.#markUnscanned(address);
      this.#put('keystore', keystore.toJSON() as unknown as JsonValue);
      await this.#seal();
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
    return this.#exclusive(async (events) => {
      const keystore = await this.#unlocked();
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
        this.#markUnscanned(record.address);
        // A transaction already recorded, paying the wallet, may carry a signature of this key.
        for (const entry of this.#txs.values()) this.#checkXmssWitnesses(entry, events);
        this.#put('keystore', keystore.toJSON() as unknown as JsonValue);
        await this.#seal();
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
   * back, and never to an index at or below one seen in a signature. After a
   * restore the wallet must have synced first, so that the signatures the
   * chain holds are known; then pass an index past every one the key may
   * have used since the backup: past the highest seen on chain, and past any
   * signature made and not broadcast. Burning more costs signatures; burning
   * too few can lose the funds.
   *
   * An index equal to the stored next one burns nothing, and is refused
   * unless nothingSigned says that the key has made no signature beyond the
   * ones this wallet state knows of. Only you can know that.
   */
  async burnXmssIndices(id: string, options: { nextIndex: number; nothingSigned?: boolean }): Promise<WalletXmssKey> {
    return this.#exclusive(async () => {
      const record = this.#xmss.get(id);
      if (record === undefined) throw new WalletError('WALLET_UNKNOWN', `no XMSS key ${id} in the wallet`);
      const { nextIndex } = options;
      if (!Number.isSafeInteger(nextIndex) || nextIndex > XMSS_MAX_SIGNATURES) throw new RangeError(`nextIndex must be an integer of at most ${XMSS_MAX_SIGNATURES}`);
      if (record.frozen === 'restored' && record.synced === false) {
        throw new XmssError('XMSS_KEY_RESTORED', `XMSS key ${id.slice(0, 16)} was restored and the wallet has not synced since; sync first, so the indices its signatures on chain used are known`);
      }
      if (nextIndex < record.next) throw new XmssError('XMSS_INDEX_REUSE', `XMSS key ${id} is at index ${record.next}; an index never moves back`);
      if (nextIndex <= record.seenOnChain) throw new XmssError('XMSS_INDEX_REUSE', `XMSS key ${id} has signed with index ${record.seenOnChain} on chain; burn past it`);
      if (nextIndex === record.next && options.nothingSigned !== true) {
        throw new XmssError(
          'XMSS_INDEX_REUSE',
          `index ${nextIndex} is where XMSS key ${id.slice(0, 16)} already stands, so this burns nothing; pass an index past every signature the key may have made, ` +
            'or nothingSigned: true if it has made none beyond those this wallet knows of',
        );
      }
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

  /**
   * Recorded transactions, newest first: all of them, or those of one
   * account or address, a page at a time with offset and limit.
   */
  history(options: HistoryOptions = {}): HistoryEntry[] {
    const all = this.#history(options);
    const offset = options.offset ?? 0;
    if (!isIndex(offset) || (options.limit !== undefined && !isIndex(options.limit))) throw new RangeError('offset and limit must be non-negative integers');
    return options.limit === undefined ? all.slice(offset) : all.slice(offset, offset + options.limit);
  }

  /** How many transactions history would return for the same account or address, for paging. */
  historyCount(options: Pick<HistoryOptions, 'account' | 'address'> = {}): number {
    return this.#history(options).length;
  }

  #history(filter: Pick<HistoryOptions, 'account' | 'address'>): HistoryEntry[] {
    const ledger = this.#ledger();
    const entries = computeHistory(this.#txs, ledger.status, this.#ownership(), this.#height);
    if (filter.account === undefined && filter.address === undefined) return entries;
    if (filter.account !== undefined) this.#account(filter.account);
    const accountOf = new Map<string, string>();
    for (const { owner, address } of this.#owned.values()) if (owner.type === 'account') accountOf.set(address, owner.account);
    return entries.filter(
      (entry) =>
        (filter.address === undefined || entry.addresses.includes(filter.address)) &&
        (filter.account === undefined || entry.addresses.some((address) => accountOf.get(address) === filter.account)),
    );
  }

  transaction(txid: string): (HistoryEntry & { hex: string; broadcast: boolean; missing: boolean }) | null {
    const entry = this.#txs.get(txid);
    if (entry === undefined) return null;
    const [history] = computeHistory(new Map([[txid, entry]]), this.#ledger().status, this.#ownership(), this.#height);
    return { ...history!, hex: entry.tx.toHex(), broadcast: entry.broadcast, missing: entry.missing };
  }

  /**
   * A number that goes up whenever what the wallet holds changes, or
   * whether it is locked or syncing. Equal versions mean equal snapshots.
   */
  get version(): number {
    return this.#version;
  }

  /** The wallet as it is now. The same frozen object is returned until the version changes, as a store for a UI framework has to. */
  getSnapshot(): WalletSnapshot {
    if (this.#snapshot === null) {
      const ledger = this.#ledger();
      let pending = 0;
      for (const status of ledger.status.values()) if (status === 'pending') pending += 1;
      this.#snapshot = Object.freeze({
        version: this.#version,
        tip: this.#tip === null ? null : Object.freeze({ ...this.#tip }),
        balance: Object.freeze({ ...ledger.balance }),
        locked: this.locked,
        watchOnly: this.watchOnly,
        syncing: this.#syncs > 0,
        transactions: this.#txs.size,
        pending,
      });
    }
    return this.#snapshot;
  }

  /** Calls listener after every change of version. Returns a function that removes it. */
  subscribe(listener: () => void): () => void {
    this.#subscribers.add(listener);
    return () => {
      this.#subscribers.delete(listener);
    };
  }

  #changed(): void {
    this.#version += 1;
    this.#snapshot = null;
    for (const listener of [...this.#subscribers]) {
      try {
        listener();
      } catch {
        // A listener's failure is its own.
      }
    }
  }

  // A lock by timeout happens outside every operation, and is a change a UI must hear of.
  #watchKeystore(): void {
    const keystore = this.#keystore;
    if (keystore === null || this.#watched.has(keystore)) return;
    this.#watched.add(keystore);
    keystore.onLock(() => {
      if (this.#keystore === keystore) this.#changed();
    });
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
   * rolls back to the fork point if they left it, asks the backend what has
   * touched the wallet's addresses, fetches new transactions, finds spends
   * the backend reports, and settles pending transactions as confirmed,
   * conflicted or missing.
   *
   * A backend with getActivitySince (ActivityScanner) is asked once, for
   * everything since the last synced tip. Any other is asked address by
   * address: every address on the first sync after the wallet is opened
   * and with full, and otherwise every address that is unused, holds a
   * coin, has a pending transaction or lies within the lookahead, plus
   * each of the rest once every quietSyncInterval syncs. The first sync of
   * a wallet's life, and full, scan the whole gap limit past the last used
   * address; the others the lookahead. A scan that runs scanLimit addresses
   * past the account's next index without reaching the gap is given up as
   * a backend answering wrongly (BACKEND_RESPONSE).
   *
   * `sync` events report progress, and signal stops a sync that is still
   * asking: it rejects with the signal's reason and the wallet is as it was.
   */
  async sync(options: SyncOptions = {}): Promise<void> {
    const scanLimit = checkPositive(options.scanLimit ?? DEFAULT_SCAN_LIMIT, 'scanLimit');
    await this.#speculate((wallet, events) => wallet.#syncBody(events, options.full === true, scanLimit), options.signal);
  }

  /** The cheap part of sync: the tip, reorgs and pending transactions, without scanning addresses. */
  async refresh(options: Pick<SyncOptions, 'signal'> = {}): Promise<void> {
    await this.#speculate(async (wallet, events) => {
      const tip = await wallet.#backend.getTip();
      await wallet.#reconcile(tip, events);
      wallet.#tell('settling');
      await wallet.#checkPending(events);
      wallet.#setTip(tip);
    }, options.signal);
  }

  async #syncBody(events: PendingEvent[], full: boolean, scanLimit: number): Promise<void> {
    const previous = this.#tip;
    const tip = await this.#backend.getTip();
    const rolledBack = await this.#reconcile(tip, events);
    const scanAll = full || !this.#meta.scanned;
    const seen = new Map<string, BlockRef | null>();
    this.#tell('scanning');
    // Blocks the wallet recorded left the chain, or there is no earlier tip: nothing to ask "since" from.
    const since = scanAll || rolledBack || previous === null ? false : await this.#scanSince(previous, seen, events, scanLimit);
    if (!since) {
      const quiet = scanAll || this.#rounds === 0 || this.#quietInterval === 1 ? null : this.#quietAddresses();
      for (const record of [...this.#accounts.values()]) {
        for (const change of [false, true]) await this.#scanChain(record, change, scanAll ? this.#meta.gapLimit : this.#meta.lookahead, seen, scanLimit, quiet);
      }
      const singles = [...this.#imported.keys(), ...[...this.#xmss.values()].map((record) => record.address)];
      await this.#collect(singles, seen);
    }
    this.#tell('fetching');
    for (const [txid, block] of seen) {
      const entry = this.#txs.get(txid);
      if (entry !== undefined) this.#observe(entry, block, events);
      else await this.#fetchAndIngest(txid, block, events);
      this.#progress.transactions += 1;
      this.#tell('fetching');
    }
    this.#tell('settling');
    await this.#checkSpends(events);
    await this.#checkPending(events);
    for (const record of this.#xmss.values()) {
      if (record.synced !== false) continue;
      record.synced = true;
      this.#putXmss(record);
    }
    if (this.#meta.unscanned !== undefined) {
      delete this.#meta.unscanned;
      this.#put('meta', this.#meta as unknown as JsonValue);
    }
    this.#rounds += 1;
    if (!this.#meta.scanned) {
      this.#meta.scanned = true;
      this.#put('meta', this.#meta as unknown as JsonValue);
    }
    this.#setTip(tip);
  }

  // One question for everything since the last synced tip, where the backend can answer it. Taking
  // the answers in moves the address indices, which brings addresses into the window that were not
  // asked about; nothing is known of those, so each is asked for its whole history, until none is new.
  async #scanSince(previous: BlockRef, seen: Map<string, BlockRef | null>, events: PendingEvent[], scanLimit: number): Promise<boolean> {
    const scanner = this.#backend as WalletBackend & Partial<ActivityScanner>;
    if (typeof scanner.getActivitySince !== 'function') return false;
    const asked = new Set<string>();
    const limit = this.#watchedAddresses().length + 2 * this.#accounts.size * scanLimit;
    // Accounts and keys added since the last sync have no history the backend was asked for: their whole history comes from the second round on.
    const unscanned = this.#unscannedAddresses();
    for (let round = 0; ; round += 1) {
      const fresh = this.#watchedAddresses().filter((address) => !asked.has(address) && (round > 0 || !unscanned.has(address)));
      if (fresh.length === 0) return true;
      if (asked.size + fresh.length > limit) throw new PearlError('BACKEND_RESPONSE', `the backend reports addresses in use ${scanLimit} past the next index with no gap; if the wallet really has that many, sync with a higher scanLimit`);
      for (const address of fresh) asked.add(address);
      if (round === 0) {
        this.#signal?.throwIfAborted();
        const activity = await scanner.getActivitySince(fresh, previous);
        if (activity === null) return false;
        for (const item of activity) seen.set(item.txid, item.block);
        this.#progress.addresses += fresh.length;
        this.#tell('scanning');
      } else {
        await this.#collect(fresh, seen);
      }
      for (const [txid, block] of seen) {
        const entry = this.#txs.get(txid);
        if (entry !== undefined) this.#observe(entry, block, events);
        else await this.#fetchAndIngest(txid, block, events);
      }
    }
  }

  // Addresses that have been paid, hold nothing now and have nothing pending: the ones a sync may leave for their turn.
  #quietAddresses(): Set<string> {
    const quiet = this.#usedAddresses();
    const ledger = this.#ledger();
    for (const coin of ledger.coins) quiet.delete(coin.address);
    for (const [txid, entry] of this.#txs) {
      if (ledger.status.get(txid) !== 'pending') continue;
      for (const script of [...entry.tx.outs.map((output) => output.script), ...entry.prevouts.flatMap((prevout) => (prevout === null ? [] : [prevout.script]))]) {
        const owned = this.#ownerOf(script);
        if (owned !== undefined) quiet.delete(owned.address);
      }
    }
    return quiet;
  }

  #tell(phase: WalletSyncProgress['phase']): void {
    this.#report?.({ phase, ...this.#progress });
  }

  /**
   * Runs a sync without holding the operation lock through its network
   * calls. A copy of the state in memory runs it first, outside the lock,
   * through a view of the backend that remembers every answer. The real
   * run then takes the lock and goes through the same view, so the queries
   * it repeats are answered from memory and it only waits on the network
   * for what changed in between (a send made meanwhile, say). What it
   * applies is still one operation ending in one atomic batch, decided on
   * the state as it is under the lock. The copy is what a signal stops and
   * what reports progress; once the real run has begun it finishes.
   */
  async #speculate(body: (wallet: PearlWallet, events: PendingEvent[]) => Promise<void>, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const run = this.#syncing.then(async () => {
      if (this.#closed) throw new WalletError('WALLET_CLOSED', 'this wallet is closed');
      signal?.throwIfAborted();
      const view = memoized(this.#backend, this.#source);
      // Copied in turn with the wallet's operations, so not of a state one of them is half way through changing.
      const scratch = await this.#enqueue(async () => this.#fork(view, signal));
      this.#syncs += 1;
      this.#changed();
      try {
        await scratch.#exclusive((events) => body(scratch, events));
        signal?.throwIfAborted();
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
        this.#emitter.emit('sync', { phase: 'done', ...scratch.#progress });
      } finally {
        this.#syncs -= 1;
        this.#changed();
      }
    });
    this.#syncing = run.catch(() => undefined);
    return run;
  }

  // A wallet over the same state, copied in memory, with nowhere to store anything: what a sync
  // runs on first. Transactions and derived addresses are shared, since neither is ever changed
  // in place; the records a sync does change are copied.
  #fork(view: { backend: WalletBackend; source: TransactionSource }, signal: AbortSignal | undefined): PearlWallet {
    const nowhere: WalletStore = {
      get: async () => undefined,
      set: async () => undefined,
      delete: async () => undefined,
      list: async () => [],
      batch: async () => undefined,
      compareAndSet: async () => true,
      close: async () => undefined,
    };
    const copy = new PearlWallet({ store: nowhere, backend: view.backend, transactions: view.source, now: this.#now, quietSyncInterval: this.#quietInterval });
    copy.#meta = { ...this.#meta };
    copy.#accounts = new Map([...this.#accounts].map(([id, record]) => [id, { ...record }]));
    copy.#chains = this.#chains;
    copy.#owned = this.#owned;
    copy.#addresses = new Map(this.#addresses);
    copy.#imported = new Map(this.#imported);
    copy.#xmss = new Map([...this.#xmss].map(([id, record]) => [id, { ...record }]));
    copy.#txs = new Map([...this.#txs].map(([txid, entry]) => [txid, { ...entry }]));
    copy.#externalSpends = new Map(this.#externalSpends);
    copy.#locks = new Map(this.#locks);
    copy.#prepared = new Map(this.#prepared);
    copy.#tip = this.#tip;
    copy.#height = this.#height;
    copy.#rounds = this.#rounds;
    copy.#signal = signal;
    copy.#report = (progress) => this.#emitter.emit('sync', progress);
    return copy;
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
      this.#spendIndex = null;
      for (const key of [...this.#externalSpends.keys()]) this.#del(`spent:${key}`);
      this.#externalSpends.clear();
      this.#tip = null;
      this.#height = 0;
      this.#del('sync');
      this.#meta.scanned = false;
      this.#put('meta', this.#meta as unknown as JsonValue);
    });
    await this.sync({ full: true });
  }

  /**
   * Keeps the wallet in sync: a full sync every pollInterval (60 s unless
   * given) and, with a notifier such as a PearlWsClient, a refresh on every
   * block and the transactions pearld reports for the wallet's addresses as
   * they arrive. Failures are reported as error events. Returns a function
   * that stops it.
   */
  watch(options: WatchOptions = {}): () => void {
    const report = (err: unknown): void => this.#emitter.emit('error', err instanceof Error ? err : new Error(String(err)));
    const timer = setInterval(() => this.sync().catch(report), options.pollInterval ?? 60_000);
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
      const external = options.signer !== undefined;
      if (!external) await this.#unlocked();
      const { feeRate, maxFeeRate } = await this.#feeRates(options);
      const { payment, changeAccount, changeIndex, changeAddress } = this.#build(options, feeRate, external ? 'elsewhere' : 'keystore');
      if (payment.changeIndex >= 0) {
        changeAccount.change = changeIndex + 1;
        this.#putAccount(changeAccount);
        this.#extend(changeAccount.id, true);
      }
      const maxOutput = options.recipients.findIndex((recipient) => recipient.amount === 'max');
      return this.#signAndBroadcast(payment, { label: options.label, changeAddress: payment.changeIndex >= 0 ? changeAddress : null, maxFeeRate, maxOutput, signer: options.signer }, events);
    });
  }

  /**
   * What a send would cost at each of several fee rates: the fee, size,
   * number of inputs and change, or why it cannot be built at that rate.
   * Reads the wallet as it is, asks nobody, and holds nothing, so a UI can
   * call it on every keystroke.
   */
  estimateSend(options: SendOptions, feeRates: readonly FeeRate[]): SendEstimate[] {
    const maxFeeRate = checkRate(options.maxFeeRate ?? DEFAULT_MAX_FEE_RATE, 'maxFeeRate');
    return feeRates.map((feeRate) => {
      try {
        if (checkRate(feeRate, 'feeRate') > maxFeeRate) throw new SigningError('FEE_TOO_HIGH', `feeRate ${feeRate} is above maxFeeRate ${maxFeeRate} (grain per 1000 vbytes); raise maxFeeRate to pay it`);
        const { payment } = this.#build(options, feeRate, options.signer === undefined ? 'estimate' : 'elsewhere');
        checkFeeCeiling(payment.transaction, payment.prevouts, payment.vsize, maxFeeRate);
        return { feeRate, fee: payment.fee, vsize: payment.vsize, inputs: payment.inputs.length, change: payment.change, error: null };
      } catch (err) {
        return { feeRate, fee: null, vsize: null, inputs: 0, change: null, error: err instanceof Error ? err : new Error(String(err)) };
      }
    });
  }

  /** The change address the next send from an account would use. Nothing is recorded: it is the same until a send or a prepared send takes it. */
  peekChangeAddress(options: { account?: string } = {}): string {
    const record = options.account === undefined ? this.#changeAccount(undefined, true) : this.#account(options.account);
    return this.#derive(record.id, true, this.#freeChangeIndex(record));
  }

  /**
   * Builds a payment for a signer that is not this wallet: a hardware
   * device, a cold machine, the holder of a watch-only account's keys. It
   * selects coins as send does, from a watch-only account too, and account
   * coins only (WALLET_WATCH_ONLY for an XMSS or imported key), and returns
   * the unsigned transaction as a PSBT with its fee, size, inputs and
   * change. Nothing is signed, recorded as sent or broadcast, and the
   * wallet need not be unlocked.
   *
   * The chosen coins and the change address are held for hold, out of
   * reach of other sends, until submitSigned takes the signed transaction,
   * cancelPrepared releases them, or the hold runs out. The hold is stored,
   * so it outlives a restart. With hold 0 nothing is held.
   */
  async prepareSend(options: PrepareSendOptions): Promise<PreparedSend> {
    return this.#exclusive(async () => {
      const hold = options.hold ?? DEFAULT_PREPARE_HOLD_MS;
      if (!Number.isSafeInteger(hold) || hold < 0) throw new RangeError('hold must be a non-negative integer of milliseconds');
      const { feeRate, maxFeeRate } = await this.#feeRates(options);
      this.#prunePrepared();
      const { payment, changeAccount, changeIndex, changeAddress } = this.#build(options, feeRate, 'elsewhere');
      checkFeeCeiling(payment.transaction, payment.prevouts, payment.vsize, maxFeeRate);
      const { psbt, inputs } = payment;
      for (const [i, coin] of inputs.entries()) {
        const owner = coin.owner;
        if (owner.type === 'account') this.#chains.get(owner.account)!.account.prepareInput(psbt, i, { index: owner.index, change: owner.change, value: coin.value });
        else psbt.updateInput(i, { witnessUtxo: { script: coin.script, value: coin.value } });
      }
      const hasChange = payment.changeIndex >= 0;
      let id: string | null = null;
      let expiresAt: number | null = null;
      if (hold > 0) {
        id = toHex(crypto.getRandomValues(new Uint8Array(16)));
        expiresAt = this.#now() + hold;
        const record: PreparedRecord = {
          id,
          tx: payment.transaction,
          prevouts: payment.prevouts.map((prevout) => ({ script: Uint8Array.from(prevout.script), value: prevout.value })),
          inputs: inputs.map((coin) => outpointKey(coin.txid, coin.vout)),
          changeAccount: hasChange ? changeAccount.id : null,
          changeIndex: hasChange ? changeIndex : null,
          changeOutput: payment.changeIndex,
          maxOutput: options.recipients.findIndex((recipient) => recipient.amount === 'max'),
          label: options.label ?? null,
          maxFeeRate,
          expiresAt,
        };
        this.#prepared.set(id, record);
        this.#put(`prepared:${id}`, preparedToJson(record));
        // The coins come back by themselves when the hold ends, which a UI has to hear of.
        const timer = setTimeout(() => this.#changed(), Math.min(hold, MAX_UNLOCK_TIMEOUT_MS));
        (timer as { unref?: () => void }).unref?.();
      }
      const ownership = this.#ownership();
      return {
        id,
        txid: payment.transaction.getId(),
        psbt: psbt.toBase64(),
        hex: payment.transaction.toHex(),
        fee: payment.fee,
        vsize: payment.vsize,
        feeRate,
        change: payment.change,
        changeAddress: hasChange ? changeAddress : null,
        inputs: inputs.map(({ txid, vout, value, address }) => ({ txid, vout, value, address })),
        outputs: payment.transaction.outs.map((output, i) => ({ address: ownership.address(Uint8Array.from(output.script)), value: output.value, change: i === payment.changeIndex })),
        previousTransactions: [...new Set(inputs.map((coin) => coin.txid))].map((txid) => this.#txs.get(txid)!.tx.toHex()),
        expiresAt,
      };
    });
  }

  /**
   * Takes the signed form of a transaction prepareSend built and is still
   * holding, checks it, records it as a pending send and broadcasts it, as
   * send does with one it signed itself. The transaction must be the
   * prepared one (the same inputs, outputs, sequences and lock time), every
   * input must carry a witness that the script engine accepts for the
   * output it spends, and it must pass pearld's relay policy and the fee
   * ceiling it was prepared under. An XMSS signature of the wallet's must be
   * at an index the wallet has not handed out (XMSS_INDEX_REUSE), and the
   * key's next index is stored past it before the transaction is recorded.
   * WALLET_NOT_PREPARED when it is not a
   * held prepared send, or its coins are no longer the wallet's to spend.
   */
  async submitSigned(signed: Transaction | string | Uint8Array, options: { label?: string } = {}): Promise<SendResult> {
    return this.#exclusive(async (events) => {
      const tx = typeof signed === 'string' ? parseTransaction(signed) : signed instanceof Uint8Array ? Transaction.fromBuffer(signed) : signed.clone();
      const txid = tx.getId();
      const now = this.#now();
      const prepared = [...this.#prepared.values()].find((record) => record.tx.getId() === txid);
      if (prepared === undefined || prepared.expiresAt <= now) {
        throw new WalletError(
          'WALLET_NOT_PREPARED',
          prepared === undefined
            ? `transaction ${txid} is not one this wallet prepared and holds: it was never prepared here, was cancelled, or was changed after it was prepared`
            : `the hold on prepared transaction ${txid} ran out; prepare it again`,
        );
      }
      // The txid covers everything but the witnesses, so what remains to check is the signatures.
      const coins = new Set(this.#ledger().coins.map((coin) => outpointKey(coin.txid, coin.vout)));
      if (!prepared.inputs.every((key) => coins.has(key))) {
        this.#prepared.delete(prepared.id);
        this.#del(`prepared:${prepared.id}`);
        await this.#flush();
        throw new WalletError('WALLET_NOT_PREPARED', `an output that prepared transaction ${txid} spends is no longer the wallet's to spend; prepare it again`);
      }
      const unsigned = tx.ins.findIndex((input) => input.witness.length === 0);
      if (unsigned >= 0) throw new SigningError('SIGNATURES_MISSING', `input ${unsigned} of transaction ${txid} is not signed`);
      const verdict = verifyTransaction(tx, prepared.prevouts);
      if (!verdict.ok) throw new SigningError('SIGNATURE_INVALID', `input ${verdict.inputIndex} of transaction ${txid} does not verify: ${verdict.message}`);
      checkStandard(tx, { prevouts: prepared.prevouts });
      checkFeeCeiling(tx, prepared.prevouts, tx.virtualSize(), prepared.maxFeeRate);
      await this.#claimXmssIndices(tx, prepared.prevouts);
      const entry = this.#record(tx, prepared.prevouts, { broadcast: false, changeOutput: prepared.changeOutput, maxOutput: prepared.maxOutput, label: options.label ?? prepared.label ?? undefined });
      this.#prepared.delete(prepared.id);
      this.#del(`prepared:${prepared.id}`);
      // Stored before broadcast, as a send is.
      await this.#flush();
      await this.#broadcast(entry, null);
      events.push(['transaction', entry.txid]);
      const change = prepared.changeOutput >= 0 ? tx.outs[prepared.changeOutput]! : undefined;
      return {
        txid,
        hex: tx.toHex(),
        fee: prepared.prevouts.reduce((sum, prevout) => sum + prevout.value, 0n) - tx.outs.reduce((sum, output) => sum + output.value, 0n),
        vsize: tx.virtualSize(),
        change: change?.value ?? 0n,
        changeAddress: change === undefined ? null : (this.#ownerOf(change.script)?.address ?? null),
        inputs: tx.ins.map((input, i) => ({ txid: prevTxid(input), vout: input.index, value: prepared.prevouts[i]!.value })),
      };
    });
  }

  /**
   * Releases what a prepared send holds. Returns false when there is no such
   * hold any more. WALLET_TRANSACTION_KNOWN, and the hold stays, when the
   * signer has broadcast it and the backend holds it.
   */
  async cancelPrepared(id: string): Promise<boolean> {
    return this.#exclusive(async () => {
      this.#prunePrepared();
      const record = this.#prepared.get(id);
      if (record === undefined) return false;
      const txid = record.tx.getId();
      if ((await this.#backend.getTransaction(txid)) !== null) {
        throw new WalletError('WALLET_TRANSACTION_KNOWN', `prepared transaction ${txid} was broadcast and the backend holds it, so its coins stay held; the next sync records it`);
      }
      this.#prepared.delete(id);
      this.#del(`prepared:${id}`);
      return true;
    });
  }

  /** The prepared sends still held, with what each holds and until when. */
  preparedSends(): { id: string; txid: string; inputs: { txid: string; vout: number }[]; expiresAt: number }[] {
    const now = this.#now();
    return [...this.#prepared.values()]
      .filter((record) => record.expiresAt > now)
      .map((record) => ({ id: record.id, txid: record.tx.getId(), inputs: record.tx.ins.map((input) => ({ txid: prevTxid(input), vout: input.index })), expiresAt: record.expiresAt }));
  }

  // Forgets holds that have run out. They stopped holding anything when they did; this only tidies the store.
  #prunePrepared(): void {
    const now = this.#now();
    for (const [id, record] of this.#prepared) {
      if (record.expiresAt > now) continue;
      this.#prepared.delete(id);
      this.#del(`prepared:${id}`);
    }
  }

  /**
   * Replaces an unconfirmed send of this wallet's that signalled
   * replace-by-fee with one paying feeRate: the same recipients, every
   * original input, and more inputs only if the change cannot cover the
   * fee. The fee is raised further if pearld's replacement rules need it.
   * No recipient that was sent an amount is ever paid less: the higher fee
   * comes out of the change, out of the recipient that was sent the maximum,
   * or, when the original had neither, out of another confirmed coin, with
   * what is left of it as new change.
   */
  async bumpFee(txid: string, options: { feeRate: FeeRate; maxFeeRate?: FeeRate; signer?: KeyPathSignerAsync }): Promise<SendResult> {
    return this.#exclusive(async (events) => {
      const external = options.signer !== undefined;
      if (!external) await this.#unlocked();
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
        const confirmations = confirmationsFromHeight(parent?.block?.height, this.#height);
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
      let newChange: AccountRecord | null = null;
      if (original.changeOutput >= 0) {
        changeAddress = this.#ownerOf(original.tx.outs[original.changeOutput]!.script)?.address ?? null;
        if (changeAddress === null) throw new WalletError('WALLET_NOT_REPLACEABLE', `the change of ${txid} is not this wallet's`);
      } else if (original.maxOutput !== null && original.maxOutput >= 0 && recipients[original.maxOutput] !== undefined) {
        // The recipient that was sent everything is sent everything again, less the higher fee.
        recipients[original.maxOutput]!.amount = 'max';
      } else {
        // Every recipient was promised an amount, so the fee needs a new input and what that leaves is change.
        const owner = originals[0]!.owner;
        newChange = this.#changeAccount(owner.type === 'account' ? { account: owner.account } : undefined, external);
        changeAddress = this.#derive(newChange.id, true, newChange.change);
      }
      // pearld refuses a replacement that adds unconfirmed inputs, and the original's own outputs vanish with it.
      const others = this.#spendable(this.#sourceOf(originals[0]!.owner), external ? 'elsewhere' : 'keystore').filter((coin) => coin.txid !== txid && coin.confirmations >= 1);
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
          try {
            // Every original input first, so all of them are taken before any new one.
            payment = buildPayment<WalletCoin>({ ...base, utxos: [...originals, ...others], strategy: (coins) => [...coins] });
          } catch (again) {
            if (!(again instanceof InsufficientFundsError) || newChange === null) throw again;
            throw new WalletError('WALLET_NOT_REPLACEABLE', `transaction ${txid} has no change to take a higher fee from, and the wallet has no other confirmed coin to pay it with; its recipients are not paid less`, { cause: again });
          }
        }
        const needed = replacementFee([{ fee: originalFee, vsize: originalVsize }], payment.vsize);
        if (payment.fee >= needed) break;
        feeRate = (needed * 1000n + BigInt(payment.vsize) - 1n) / BigInt(payment.vsize) + 1n;
        payment = undefined;
      }
      if (payment === undefined) throw new WalletError('WALLET_NOT_REPLACEABLE', `could not reach the fee pearld needs to replace ${txid}`);
      if (payment.changeIndex < 0) changeAddress = null;
      else if (newChange !== null) {
        newChange.change += 1;
        this.#putAccount(newChange);
        this.#extend(newChange.id, true);
      }
      const result = await this.#signAndBroadcast(payment, { label: original.label, changeAddress, replaces: original, maxFeeRate, maxOutput: original.maxOutput ?? -1, signer: options.signer }, events);
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
        const spend = { network: this.network, utxos, destination, feeRate, minConfirmations: 0, coinbaseMaturity: this.network.coinbaseMaturity };
        // Held to the ceiling before the key signs: sweepKey builds this same payment.
        const unsigned = buildPayment({ ...spend, recipients: [{ address: destination, amount: 'max' }] });
        checkFeeCeiling(unsigned.transaction, unsigned.prevouts, unsigned.vsize, maxFeeRate);
        const signed = sweepKey(privateKey, spend);
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
   * become spendable again. WALLET_TRANSACTION_KNOWN, and nothing is freed,
   * while the backend holds it in its mempool or a block. If it is seen
   * there later, the wallet counts it again.
   */
  async abandon(txid: string): Promise<void> {
    await this.#exclusive(async (events) => {
      const entry = this.#txs.get(txid);
      if (entry === undefined || entry.status !== 'active' || entry.block !== null) throw new WalletError('WALLET_NOT_REPLACEABLE', `transaction ${txid} is not a pending transaction of this wallet`);
      const found = await this.#backend.getTransaction(txid);
      if (found !== null) {
        this.#observe(entry, found.block, events);
        throw new WalletError('WALLET_TRANSACTION_KNOWN', `transaction ${txid} is ${found.block === null ? "in the backend's mempool" : `in block ${found.block.hash}`} and may still confirm, so its coins stay spent`);
      }
      entry.status = 'abandoned';
      this.#putTx(entry);
      events.push(['conflict', { txid, status: 'abandoned', by: null }]);
    });
  }

  /**
   * Sends again every pending transaction the backend has lost or never
   * acknowledged, and says what became of each. One the backend already has
   * counts as accepted and is not sent again.
   */
  async rebroadcast(): Promise<RebroadcastResult> {
    return this.#exclusive(async () => {
      const result: RebroadcastResult = { accepted: [], refused: [], failed: [] };
      for (const entry of this.#txs.values()) {
        if (entry.status !== 'active' || entry.block !== null || (!entry.missing && entry.broadcast)) continue;
        let outcome: 'held' | 'refused' | 'unknown' = 'held';
        let error = new Error('broadcast failed');
        try {
          await this.#backend.broadcast(entry.tx.toHex());
        } catch (err) {
          outcome = broadcastOutcome(err);
          error = err instanceof Error ? err : new Error(String(err));
        }
        if (outcome === 'held') {
          entry.broadcast = true;
          entry.missing = false;
          this.#putTx(entry);
          result.accepted.push(entry.txid);
        } else {
          (outcome === 'refused' ? result.refused : result.failed).push({ txid: entry.txid, error });
        }
      }
      return result;
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
    this.#auth = map.get('auth');
    this.#keystore = keystore === undefined ? null : this.#keystore?.locked === false && JSON.stringify(this.#keystore.toJSON()) === JSON.stringify(keystore) ? this.#keystore : openKeystore(keystore);
    this.#watchKeystore();
    this.#accounts.clear();
    // New maps, not cleared ones: a sync in flight still reads the old.
    this.#chains = new Map();
    this.#owned = new Map();
    this.#addresses.clear();
    this.#imported.clear();
    this.#xmss.clear();
    this.#xmssStored.clear();
    this.#txs.clear();
    this.#spendIndex = null;
    this.#externalSpends.clear();
    this.#locks.clear();
    this.#prepared.clear();
    const sync = map.get('sync');
    const tip = sync === undefined ? null : asRecord<BlockRef>(sync, 'sync tip');
    this.#tip = tip === null ? null : { height: tip.height, hash: tip.hash };
    for (const [key, value] of entries) {
      const name = key.slice(key.indexOf(':') + 1);
      if (key.startsWith('account:')) {
        const record = asRecord<AccountRecord>(value, key);
        if (record.id !== name || (record.kind !== 'seed' && record.kind !== 'xpub') || typeof record.xpub !== 'string' || !isIndex(record.receive) || !isIndex(record.change)) throw invalid(key);
        if (record.kind === 'seed' ? !isIndex(record.number) : record.number !== null) throw invalid(key);
        try {
          this.#addAccount(record, false);
        } catch (err) {
          throw new StoreError('STORE_INVALID', `stored ${key} does not hold an account key for ${this.network.name}`, { cause: err });
        }
      } else if (key.startsWith('address:')) this.#addresses.set(name, asRecord<AddressRecord>(value, key));
      else if (key.startsWith('imported:')) {
        const record = asRecord<{ address: string; label: string | null }>(value, key);
        if (record.address !== name) throw invalid(key);
        this.#imported.set(name, record);
      } else if (key.startsWith('xmss:')) {
        const record = asRecord<XmssRecord>(value, key);
        // The address is the key's own: one put in its place would send the key's payments elsewhere.
        if (record.publicKey !== name || !/^[0-9a-f]{128}$/.test(name) || !isIndex(record.next) || record.address !== encodeAddress({ version: 2, program: xmssTree(name).root }, this.network)) throw invalid(key);
        this.#xmss.set(name, record);
        // A copy: the record above changes in memory before it is stored again.
        this.#xmssStored.set(name, structuredClone(value));
      }
      else if (key.startsWith('tx:')) this.#txs.set(name, txFromJson(name, value));
      else if (key.startsWith('spent:')) this.#externalSpends.set(name, asRecord<{ by: string | null }>(value, key).by);
      else if (key.startsWith('lock:')) this.#locks.set(name, asRecord<{ until: number | null }>(value, key).until);
      else if (key.startsWith('prepared:')) this.#prepared.set(name, preparedFromJson(name, value));
    }
    for (const [address] of this.#imported) this.#own(toOutputScript(address, this.network), { type: 'imported', id: address }, address);
    for (const record of this.#xmss.values()) this.#own(toOutputScript(record.address, this.network), { type: 'xmss', id: record.publicKey }, record.address);
    this.#height = this.#tip?.height ?? 0;
    for (const entry of this.#txs.values()) if (entry.status === 'active' && entry.block !== null) this.#height = Math.max(this.#height, entry.block.height);
    // Once checked in this process, the accounts and keys are held to what was checked, locked or not.
    if (this.#verified !== null && this.#identity() !== this.#verified) throw new KeystoreError('KEYSTORE_TAMPERED', TAMPERED_IDENTITY);
  }

  // The records the keystore authenticates: which keys the wallet's addresses come from.
  #identity(): string {
    const accounts = [...this.#accounts.values()]
      .map((record) => [record.id, record.kind, record.number, record.xpub, record.origin?.masterFingerprint ?? null, record.origin?.path ?? null])
      .sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : 1));
    return JSON.stringify({ network: this.network.name, accounts, imported: [...this.#imported.keys()].sort(), xmss: [...this.#xmss.keys()].sort() });
  }

  // Tags the accounts and keys as they now are, after an operation changed them; stored with its batch.
  async #seal(): Promise<void> {
    // A watch-only wallet has no key to tag with.
    if (this.#keystore === null) return;
    const keystore = this.#requireUnlocked();
    const identity = this.#identity();
    const tag = await keystore.authenticate('wallet', identity);
    this.#auth = { nonce: tag.nonce, tag: tag.ciphertext };
    this.#put('auth', this.#auth);
    this.#verified = identity;
  }

  // Checks the accounts and keys against the keystore's tag, and that the keystore still holds a secret for each key.
  async #authenticate(): Promise<void> {
    const keystore = this.#requireUnlocked();
    const identity = this.#identity();
    const whole =
      [...this.#imported.keys()].every((address) => keystore.has(`wif:${address}`)) &&
      [...this.#xmss.keys()].every((id) => keystore.has(`xmss:${id}`)) &&
      ([...this.#accounts.values()].every((record) => record.kind !== 'seed') || keystore.has('seed'));
    const stored = this.#auth as { nonce?: JsonValue; tag?: JsonValue } | null | undefined;
    const tag = stored === null || typeof stored !== 'object' ? undefined : { nonce: stored.nonce, ciphertext: stored.tag };
    if (!whole || !(await keystore.verify('wallet', identity, tag))) {
      keystore.lock();
      throw new KeystoreError('KEYSTORE_TAMPERED', TAMPERED_IDENTITY);
    }
    this.#verified = identity;
  }

  // The unlocked keystore, with the wallet's accounts and keys checked against it if they have not been since the state was last read.
  async #unlocked(): Promise<Keystore> {
    const keystore = this.#requireUnlocked();
    if (this.#verified === null) await this.#authenticate();
    return keystore;
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
    this.#height = tip.height;
    this.#put('sync', { height: tip.height, hash: tip.hash, at: this.#now() });
  }

  async #flush(): Promise<void> {
    if (this.#ops.length === 0) return;
    this.#wrote = true;
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
    return this.#enqueue(async () => {
      if (this.#closed) throw new WalletError('WALLET_CLOSED', 'this wallet is closed');
      if (this.#broken !== null) throw this.#broken;
      const events: PendingEvent[] = [];
      const before = this.#ledger().balance;
      const verified = this.#verified;
      this.#wrote = false;
      try {
        const value = await run(events);
        await this.#flush();
        if (this.#wrote || events.length > 0) this.#changed();
        const after = this.#ledger().balance;
        const history = events.some(([name]) => name === 'transaction') ? new Map(this.#history({}).map((entry) => [entry.txid, entry])) : null;
        for (const [name, payload] of events) {
          if (name !== 'transaction') this.#emitter.emit(name, payload as never);
          else if (history?.has(payload)) this.#emitter.emit('transaction', history.get(payload)!);
        }
        if ((Object.keys(after) as (keyof WalletStateBalance)[]).some((key) => after[key] !== before[key])) this.#emitter.emit('balance', after);
        return value;
      } catch (err) {
        this.#ops = [];
        // What a failed operation tagged was never stored.
        this.#verified = verified;
        try {
          if (!this.#closed) await this.#load();
        } catch (reload) {
          // The store cannot be read back, so nothing more is done on what memory holds.
          this.#broken = reload;
        }
        this.#changed();
        throw err;
      }
    });
  }

  // Runs after every operation already waiting, and before any that comes later.
  #enqueue<T>(run: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(run);
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
    const account = importWatchOnlyAccount(record.xpub, this.network, record.origin ?? undefined);
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

  #changeAccount(from: CoinSource | undefined, external = false): AccountRecord {
    if (from !== undefined && from !== 'all' && 'account' in from) {
      const record = this.#account(from.account);
      if (record.kind !== 'seed' && !external) throw new WalletError('WALLET_WATCH_ONLY', `account ${record.id} is watch-only and cannot sign`);
      return record;
    }
    return external && ![...this.#accounts.values()].some((item) => item.kind === 'seed') ? this.#account(undefined) : this.#firstSigningAccount();
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

  #markUnscanned(item: string): void {
    this.#meta.unscanned = [...(this.#meta.unscanned ?? []), item];
    this.#put('meta', this.#meta as unknown as JsonValue);
  }

  #unscannedAddresses(): Set<string> {
    const addresses = new Set<string>();
    for (const item of this.#meta.unscanned ?? []) {
      if (!item.startsWith('account:')) {
        addresses.add(item);
        continue;
      }
      const record = this.#accounts.get(item.slice('account:'.length));
      if (record === undefined) continue;
      for (const change of [false, true]) {
        const next = change ? record.change : record.receive;
        for (let i = 0; i < next + this.#meta.lookahead; i += 1) addresses.add(this.#derive(record.id, change, i));
      }
    }
    return addresses;
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
      tipHeight: this.#height,
      coinbaseMaturity: this.network.coinbaseMaturity,
      externalSpends: new Set(this.#externalSpends.keys()),
      locks: this.#heldOutpoints(),
      now: this.#now(),
    });
  }

  // The locks, and with them the coins of every prepared send that is still held, until its hold ends.
  #heldOutpoints(): ReadonlyMap<string, number | null> {
    if (this.#prepared.size === 0) return this.#locks;
    const now = this.#now();
    const held = new Map(this.#locks);
    for (const record of this.#prepared.values()) {
      if (record.expiresAt <= now) continue;
      for (const key of record.inputs) {
        const until = held.get(key);
        if (until === undefined || (until !== null && until < record.expiresAt)) held.set(key, record.expiresAt);
      }
    }
    return held;
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

  #from(from: CoinSource, owner: CoinOwner): boolean {
    if (from === 'all') return true;
    if ('account' in from) return owner.type === 'account' && owner.account === from.account;
    if ('imported' in from) return owner.type === 'imported' && owner.id === from.imported;
    return owner.type === 'xmss' && owner.id === from.xmss;
  }

  // Unlocked coins a source may spend, with what coin selection needs to price them. A payment
  // signed elsewhere (a signer, or prepareSend) may spend a watch-only account's coins too, and
  // account coins only: an XMSS index has to be reserved here before anything signs over it, and
  // imported keys sign from the keystore. An estimate looks at every coin.
  #spendable(from: CoinSource, mode: SpendMode): WalletCoin[] {
    const anyAccount = mode !== 'keystore';
    const accepts = (owner: CoinOwner): boolean => {
      if (owner.type === 'account' && !anyAccount && this.#accounts.get(owner.account)?.kind !== 'seed') return false;
      if (owner.type !== 'account' && mode === 'elsewhere') return false;
      if (owner.type === 'xmss' && this.#xmss.get(owner.id)?.frozen !== null) return false;
      return this.#from(from, owner);
    };
    if (from !== 'all') {
      if (mode === 'elsewhere' && !('account' in from)) throw new WalletError('WALLET_WATCH_ONLY', 'a send signed elsewhere spends account coins only; imported and XMSS keys sign from the keystore');
      if ('account' in from) {
        const record = this.#account(from.account);
        if (record.kind !== 'seed' && !anyAccount) throw new WalletError('WALLET_WATCH_ONLY', `account ${record.id} is watch-only and cannot sign`);
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

  // The first index of an account's change chain that no prepared send is holding.
  #freeChangeIndex(record: AccountRecord): number {
    const now = this.#now();
    const held = new Set<number>();
    for (const prepared of this.#prepared.values()) if (prepared.expiresAt > now && prepared.changeAccount === record.id && prepared.changeIndex !== null) held.add(prepared.changeIndex);
    let index = record.change;
    while (held.has(index)) index += 1;
    return index;
  }

  // Chooses coins and builds the unsigned payment, for this wallet's keys or, with external, for a
  // signer elsewhere. Nothing is recorded. A shortfall is reported with what the source holds and
  // could not spend.
  #build(options: SendOptions, feeRate: FeeRate, mode: SpendMode): { payment: Payment<WalletCoin>; changeAccount: AccountRecord; changeIndex: number; changeAddress: string } {
    const external = mode !== 'keystore';
    const minConfirmations = options.minConfirmations ?? 1;
    const from = options.from ?? { account: (external ? this.#account(undefined) : this.#firstSigningAccount()).id };
    const coins = this.#spendable(from, mode);
    const changeAccount = this.#changeAccount(from, external);
    const changeIndex = this.#freeChangeIndex(changeAccount);
    const changeAddress = this.#derive(changeAccount.id, true, changeIndex);
    try {
      const payment = buildPayment<WalletCoin>({
        network: this.network,
        utxos: coins,
        recipients: options.recipients,
        feeRate,
        // From the account, so the PSBT's change output carries its derivation and a signer elsewhere can prove the change is its own.
        changeFrom: { account: this.#chains.get(changeAccount.id)!.account, index: changeIndex },
        rbf: options.rbf === true,
        minConfirmations,
        coinbaseMaturity: this.network.coinbaseMaturity,
        ...(options.strategy === undefined ? {} : { strategy: options.strategy }),
      });
      return { payment, changeAccount, changeIndex, changeAddress };
    } catch (err) {
      if (!(err instanceof InsufficientFundsError)) throw err;
      const held = { locked: 0n, immature: 0n, unconfirmed: 0n, frozen: 0n };
      for (const coin of this.#ledger().coins) {
        if (!this.#from(from, coin.owner)) continue;
        if (coin.owner.type === 'account' && !external && this.#accounts.get(coin.owner.account)?.kind !== 'seed') continue;
        if (coin.owner.type !== 'account' && mode === 'elsewhere') continue;
        if (coin.owner.type === 'xmss' && this.#xmss.get(coin.owner.id)?.frozen !== null) held.frozen += coin.value;
        else if (coin.locked) held.locked += coin.value;
        else if (coin.coinbase && coin.confirmations < this.network.coinbaseMaturity) held.immature += coin.value;
        else if (coin.confirmations < minConfirmations) held.unconfirmed += coin.value;
      }
      throw new WalletInsufficientFundsError(err, held);
    }
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
        await this.#advanceXmss(record, index, 'Nothing was signed');
        return index;
      },
    };
  }

  // Stores the key's next index as one past `index`, with compareAndSet over
  // the record this wallet last stored, before anything uses the index.
  async #advanceXmss(record: XmssRecord, index: number, outcome: string): Promise<void> {
    const id = record.publicKey;
    const advanced = { ...record, next: index + 1 } as unknown as JsonValue;
    const key = `xmss:${id}`;
    if (!(await this.#store.compareAndSet([{ key, value: this.#xmssStored.get(id) }], [{ type: 'set', key, value: advanced }]))) {
      throw new XmssError('XMSS_INDEX_REUSE', `the stored XMSS index is not the one this wallet last wrote: another writer is using the store. ${outcome}`);
    }
    record.next = index + 1;
    this.#xmssStored.set(id, advanced);
    this.#reserved.set(id, index);
  }

  // A transaction signed elsewhere may carry XMSS signatures of the wallet's
  // keys only at indices the wallet has not handed out; each key's next
  // index is moved past them, durably, before the transaction is recorded.
  async #claimXmssIndices(tx: Transaction, prevouts: readonly { script: Uint8Array; value: bigint }[]): Promise<void> {
    const highest = new Map<string, number>();
    for (const [i, prevout] of prevouts.entries()) {
      const owner = this.#ownerOf(prevout.script)?.owner;
      if (owner?.type !== 'xmss') continue;
      const record = this.#xmss.get(owner.id)!;
      this.#checkXmssUsable(record);
      const index = xmssWitnessIndex(tx.ins[i]!.witness);
      if (index === null || index > XMSS_LAST_INDEX) throw new SigningError('SIGNATURE_INVALID', `input ${i} of transaction ${tx.getId()} carries no XMSS signature index`);
      if (index < record.next || index <= record.seenOnChain || index <= (this.#reserved.get(owner.id) ?? -1) || index <= (highest.get(owner.id) ?? -1)) {
        throw new XmssError('XMSS_INDEX_REUSE', `input ${i} of transaction ${tx.getId()} is signed with XMSS index ${index}, which this wallet has already handed out; refusing to record or broadcast it`);
      }
      highest.set(owner.id, index);
    }
    for (const [id, index] of highest) await this.#advanceXmss(this.#xmss.get(id)!, index, 'The transaction was not recorded');
  }

  // ---- internals: transactions

  #record(
    tx: Transaction,
    prevouts: LedgerTransaction['prevouts'],
    extra: { broadcast: boolean; changeOutput: number | null; maxOutput?: number; label?: string | undefined; block?: BlockRef | null },
  ): TxEntry {
    const block = extra.block ?? null;
    const entry: TxEntry = {
      txid: tx.getId(),
      tx,
      // Height and hash only, as the store keeps it: some backends report the block's time too.
      block: block === null ? null : { height: block.height, hash: block.hash },
      status: 'active',
      prevouts,
      seenAt: this.#now(),
      broadcast: extra.broadcast,
      missing: false,
      changeOutput: extra.changeOutput,
      maxOutput: extra.maxOutput ?? null,
      ...(extra.label === undefined ? {} : { label: extra.label }),
    };
    const fresh = !this.#txs.has(entry.txid);
    this.#txs.set(entry.txid, entry);
    if (fresh && this.#spendIndex !== null) for (const key of inputKeys(tx)) this.#spendIndex.set(key, [...(this.#spendIndex.get(key) ?? []), entry.txid]);
    this.#markUsed(tx);
    this.#putTx(entry);
    return entry;
  }

  #spenders(): Map<string, string[]> {
    if (this.#spendIndex === null) {
      const index = new Map<string, string[]>();
      for (const [txid, entry] of this.#txs) for (const key of inputKeys(entry.tx)) index.set(key, [...(index.get(key) ?? []), txid]);
      this.#spendIndex = index;
    }
    return this.#spendIndex;
  }

  // An output of a recorded transaction that is the wallet's.
  #isOurOutput(txid: string, vout: number): boolean {
    const output = this.#txs.get(txid)?.tx.outs[vout];
    return output !== undefined && this.#ownerOf(output.script) !== undefined;
  }

  async #fetch(txid: string): Promise<Transaction | null> {
    this.#signal?.throwIfAborted();
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
    if (block !== null) this.#height = Math.max(this.#height, block.height);
    this.#checkXmssWitnesses(entry, events);
    this.#settleConflicts(entry, events);
    events.push(['transaction', txid]);
    if (block !== null) events.push(['confirmation', { txid, block }]);
    return entry;
  }

  // The index of each XMSS signature in a transaction that spends the
  // wallet's XMSS outputs. A backend's word is not enough to freeze a key or
  // to say an index is used: the input is run through the script engine
  // with the wallet's own record of what it spends, and only a signature
  // that verifies under the key counts. One that does is proof the index
  // was used, in a block or not, and is never forgotten.
  #checkXmssWitnesses(entry: TxEntry, events: PendingEvent[]): void {
    if (entry.prevouts.length !== entry.tx.ins.length || entry.prevouts.some((prevout) => prevout === null)) return;
    const prevouts = entry.prevouts as { script: Uint8Array; value: bigint }[];
    prevouts.forEach((prevout, i) => {
      const owner = this.#ownerOf(prevout.script)?.owner;
      if (owner?.type !== 'xmss') return;
      const index = xmssWitnessIndex(entry.tx.ins[i]!.witness);
      const record = this.#xmss.get(owner.id);
      if (index === null || index > XMSS_LAST_INDEX || record === undefined || index <= record.seenOnChain) return;
      if (!verifyInput(entry.tx, i, prevouts).ok) return;
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
    // inputKeys gives a coinbase none: every coinbase has the same null input, which spends nothing.
    const index = this.#spenders();
    const rivals = new Set<string>();
    for (const key of inputKeys(entry.tx)) for (const txid of index.get(key) ?? []) if (txid !== entry.txid) rivals.add(txid);
    for (const txid of rivals) {
      const other = this.#txs.get(txid);
      if (other === undefined || other === entry || other.status !== 'active') continue;
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
        this.#height = Math.max(this.#height, block.height);
        events.push(['confirmation', { txid: entry.txid, block: entry.block }]);
        changed = true;
        // A send of this wallet's own was never taken in from the backend, so its signatures are counted when it confirms.
        this.#checkXmssWitnesses(entry, events);
      }
      this.#settleConflicts(entry, events);
    } else {
      if (was !== null) {
        entry.block = null;
        changed = true;
      }
      // Back in the mempool, so active again unless an active transaction still spends its inputs.
      if (entry.status === 'conflicted' || entry.status === 'orphaned' || entry.status === 'abandoned') {
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
    this.#signal?.throwIfAborted();
    const histories = await mapLimit(addresses, CONCURRENCY, (address) => this.#backend.getHistory(address));
    this.#progress.addresses += addresses.length;
    this.#tell('scanning');
    histories.forEach((history, i) => {
      if (history.length > 0) used.add(addresses[i]!);
      for (const item of history) seen.set(item.txid, item.block);
    });
    return used;
  }

  // Scans one chain of an account from index 0 until `window` unused
  // addresses past the last used one, as discoverAccount does.
  async #scanChain(record: AccountRecord, change: boolean, window: number, seen: Map<string, BlockRef | null>, scanLimit: number, quiet: ReadonlySet<string> | null): Promise<void> {
    const known = change ? record.change : record.receive;
    let lastUsed = known - 1;
    for (let start = 0; start < lastUsed + 1 + window; ) {
      // A backend that calls every address used would keep this going for ever.
      if (start >= known + scanLimit) {
        throw new PearlError(
          'BACKEND_RESPONSE',
          `the backend reports addresses in use ${scanLimit} past index ${known} of account ${record.id} with no gap of ${window}; ` +
            'if the account really has that many, sync with a higher scanLimit',
        );
      }
      const count = Math.min(SCAN_BATCH, lastUsed + 1 + window - start);
      const batch = new Map<string, number>();
      for (let index = start; index < start + count; index += 1) {
        const address = this.#derive(record.id, change, index);
        // An address that was paid, holds nothing and has nothing pending is asked about in its turn, not every time.
        if (quiet !== null && index < known - this.#meta.lookahead && quiet.has(address) && (index + this.#rounds) % this.#quietInterval !== 0) continue;
        batch.set(address, index);
      }
      const candidates = this.#backend.findUsed === undefined || batch.size === 0 ? [...batch.keys()] : await this.#backend.findUsed([...batch.keys()]);
      for (const address of await this.#collect(candidates, seen)) lastUsed = Math.max(lastUsed, batch.get(address) ?? -1);
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
    let spentBy: Map<string, string> | undefined;
    for (const entry of [...this.#txs.values()]) {
      if (entry.status === 'abandoned') {
        // One whose inputs nothing else of the wallet's spends can still reach a block, and counts again once seen.
        spentBy ??= this.#ledger().spentBy;
        if (entry.tx.ins.some((input) => spentBy!.has(outpointKey(prevTxid(input), input.index)))) continue;
        this.#signal?.throwIfAborted();
        const found = await this.#backend.getTransaction(entry.txid);
        if (found !== null) this.#observe(entry, found.block, events);
        continue;
      }
      if (entry.status !== 'active' || entry.block !== null) continue;
      this.#signal?.throwIfAborted();
      const found = await this.#backend.getTransaction(entry.txid);
      if (found !== null) {
        this.#observe(entry, found.block, events);
        continue;
      }
      let conflict: string | null | undefined;
      // The wallet's own outputs among its inputs that something else has spent, and what the backend says spent them.
      const taken: [string, string | null][] = [];
      for (const input of entry.tx.ins) {
        if (entry.tx.isCoinbase()) break;
        const status = await this.#backend.getSpendStatus({ txid: prevTxid(input), vout: input.index });
        if (status.status !== 'spent' || status.spender === entry.txid) continue;
        conflict ??= status.spender ?? null;
        if (this.#isOurOutput(prevTxid(input), input.index)) taken.push([outpointKey(prevTxid(input), input.index), status.spender ?? null]);
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
      if (conflict !== null) {
        const where = await this.#backend.getTransaction(conflict);
        const known = this.#txs.get(conflict);
        if (known === undefined) await this.#fetchAndIngest(conflict, where?.block ?? null, events);
        else if (where !== null) this.#observe(known, where.block, events);
      }
      // A coin whose spender the wallet could not record is spent all the same: without this it would
      // go back to the balance when its own spend was conflicted, until a full sync asked about it.
      for (const [key, spender] of taken) {
        if ((spender !== null && this.#txs.get(spender)?.status === 'active') || this.#externalSpends.has(key)) continue;
        this.#externalSpends.set(key, spender);
        this.#put(`spent:${key}`, { by: spender });
      }
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
  async #reconcile(tip: BlockRef, events: PendingEvent[]): Promise<boolean> {
    const previous = this.#tip;
    if (previous !== null && previous.hash === tip.hash) return false;
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
    if (fork === Number.POSITIVE_INFINITY) return false;
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
    return true;
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
    meta: { label?: string | undefined; changeAddress: string | null; replaces?: TxEntry; maxFeeRate: FeeRate; maxOutput: number; signer?: KeyPathSignerAsync | undefined },
    events: PendingEvent[],
  ): Promise<SendResult> {
    // Before any key is used: an XMSS signature spent on a refused payment is an index gone.
    checkFeeCeiling(payment.transaction, payment.prevouts, payment.vsize, meta.maxFeeRate);
    for (const [id, count] of this.#xmssInputCounts(payment.inputs)) {
      const record = this.#xmss.get(id)!;
      if (XMSS_MAX_SIGNATURES - record.next < count) throw new XmssError('XMSS_INDEX_EXHAUSTED', `XMSS key ${id.slice(0, 16)} has ${XMSS_MAX_SIGNATURES - record.next} signatures left, and this payment needs ${count}`);
    }
    const signed = await this.#sign(payment, meta.maxFeeRate, meta.signer);
    const final = finalizePayment(payment, { signed });
    const entry = this.#record(final.transaction, final.prevouts.map((p) => ({ script: Uint8Array.from(p.script), value: p.value })), {
      broadcast: false,
      changeOutput: final.changeIndex,
      maxOutput: meta.maxOutput,
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

  // A refusal from the node takes the transaction back out. A node that
  // says it already has the transaction has it. Any other failure leaves it
  // recorded as not yet broadcast, since it may have reached the node, and
  // rebroadcast or abandon settles it.
  async #broadcast(entry: TxEntry, replaced: TxEntry | null): Promise<void> {
    try {
      await this.#backend.broadcast(entry.tx.toHex());
    } catch (err) {
      const outcome = broadcastOutcome(err);
      if (outcome === 'refused') {
        this.#txs.delete(entry.txid);
        this.#spendIndex = null;
        this.#del(`tx:${entry.txid}`);
        if (replaced !== null) {
          replaced.status = 'active';
          delete replaced.by;
          this.#putTx(replaced);
        }
        await this.#flush();
        throw new WalletError('WALLET_BROADCAST_REFUSED', `the node refused transaction ${entry.txid}: ${(err as Error).message}`, { cause: err });
      }
      if (outcome === 'unknown') {
        throw new WalletError('WALLET_BROADCAST_UNCERTAIN', `broadcasting ${entry.txid} failed and it may have reached the node; it stays recorded as not broadcast. Call refresh to see whether the backend has it, then rebroadcast; abandon only frees its coins once the backend holds it in neither its mempool nor a block: ${(err as Error).message}`, { cause: err });
      }
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
  async #sign(payment: Payment<WalletCoin>, maxFeeRate: FeeRate, external?: KeyPathSignerAsync): Promise<Transaction> {
    const signed = payment.transaction.clone();
    const { psbt, inputs, prevouts } = payment;
    // Every input is prepared from the watch-only accounts before any key is decrypted.
    for (const [i, coin] of inputs.entries()) {
      const owner = coin.owner;
      if (owner.type === 'account') this.#chains.get(owner.account)!.account.prepareInput(psbt, i, { index: owner.index, change: owner.change, value: coin.value });
      else psbt.updateInput(i, { witnessUtxo: { script: coin.script, value: coin.value } });
    }
    const copySignature = (i: number): void => {
      const signature = psbt.data.inputs[i]?.tapKeySig;
      if (signature === undefined) throw new SigningError('SIGNATURES_MISSING', `input ${i} was not signed`);
      signed.setWitness(i, [Uint8Array.from(signature)]);
    };
    if (external !== undefined) {
      // The keys are elsewhere: each account input is signed by whoever holds them, asked through the
      // account, which checks the request against the input first and the signature against the output after.
      for (const [i, coin] of inputs.entries()) {
        if (coin.owner.type !== 'account') throw new WalletError('WALLET_WATCH_ONLY', 'a send with a signer spends account coins only; imported and XMSS keys sign from the keystore');
        await this.#chains.get(coin.owner.account)!.account.signInputAsync(psbt, i, external);
        copySignature(i);
      }
      return signed;
    }
    const keystore = this.#requireUnlocked();
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
        copySignature(i);
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
