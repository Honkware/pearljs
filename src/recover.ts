// Why a restored wallet shows less than the chain holds. Every derivation
// below is one some version of Pearl's wallet has used:
//
// - Oyster and the desktop wallet: a BIP39 English mnemonic, seed =
//   bip39.NewSeed(phrase, "") with no passphrase, BIP86 m/86'/coin'/0'/{0,1}/i,
//   coin 808276 on mainnet and 1 on every test network (InitKeyScopes,
//   wallet/waddrmgr/scoped_manager.go), restored with a recovery window of
//   250 (wallet/btcwallet.go) on account 0 only (externalKeyPath,
//   wallet/wallet/wallet.go). The desktop wallet collapses whitespace and
//   lowercases before it hands the phrase over (seed-input.ts).
// - Oyster's command line hashes the phrase as typed: --createfromfile takes
//   it trimmed, the --create prompt trimmed and lowercased
//   (wallet/walletsetup.go, wallet/internal/prompt/prompt.go). go-bip39
//   validates with strings.Fields, so a double space or a line break passes
//   and makes another seed.
// - A hex seed of 16 to 64 bytes, used as the BIP32 seed itself.
// - Accounts made with createnewaccount, m/86'/coin'/N', which a restore
//   never scans.
// - getnewaddress with pq=true, until pearl-research-labs/pearl#463: the
//   BIP86 key tweaked with a one-leaf tree <xmss_pubkey> OP_CHECKXMSSSIG,
//   the XMSS seeds HKDF-SHA256 of the key at m/222'/coin'/account'/b/i
//   (wallet/waddrmgr/xmss_keys.go before that change).

/**
 * Seed recovery diagnostics: which derivation of a seed holds coins, and why
 * a wallet restored from it might show less.
 *
 * @module
 */

import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha2';
import { pbkdf2 } from '@noble/hashes/pbkdf2';
import { sha512 } from '@noble/hashes/sha2';
import { wordlist } from '@scure/bip39/wordlists/english';
import { BIP32Factory } from 'bip32';
import * as ecc from 'tiny-secp256k1';
import { encodeAddress } from './address.js';
import { formatPearl } from './amount.js';
import type { WalletBackend, WalletBalance } from './backend.js';
import { sumBalance } from './backend.js';
import type { AccountDiscovery, DiscoveredAddress } from './discovery.js';
import { discoverAccount, OYSTER_RECOVERY_WINDOW } from './discovery.js';
import { PearlError } from './errors.js';
import type { KeyOrigin, PearlAccount } from './keys.js';
import { deriveAccountFromSeed, importWatchOnlyAccount } from './keys.js';
import { normalizeMnemonic, parseSeedInput } from './mnemonic.js';
import { customNetwork, networks } from './networks.js';
import type { PearlNetwork } from './networks.js';
import { xmssLeafScript } from './script.js';
import { assembleScriptTree, taprootOutputKey } from './scripttree.js';
import { xmssKeygen, XMSS_PRIVATE_SEED_LENGTH, XMSS_PUBLIC_SEED_LENGTH } from './xmss.js';
import { toHex } from './internal/bytes.js';

const bip32 = BIP32Factory(ecc);
const encoder = new TextEncoder();

/** The scan depth diagnoseSeed and diagnoseAccount use unless told otherwise. */
export const DEFAULT_RECOVERY_GAP = 1000;

/** Where a derivation variant comes from. */
export type DerivationSource =
  /** What Oyster and the desktop wallet derive from the phrase. */
  | 'oyster'
  /** The phrase exactly as typed into Oyster's command line, whitespace and all. */
  | 'as-typed'
  /** A hex seed, used as the BIP32 seed itself. */
  | 'hex'
  /** A seed given as bytes. */
  | 'seed'
  /** A BIP39 passphrase, which neither Oyster nor the desktop wallet asks for. */
  | 'passphrase'
  /** An extended public key given to diagnoseAccount. */
  | 'account-key';

/** One way of turning the input into addresses. */
export interface DerivationVariant {
  /** A stable name, such as "oyster m/86'/808276'/0'" or "pq m/86'/808276'/0'". */
  id: string;
  source: DerivationSource;
  /** m/86'/coin'/account', or null for an account key given without its origin. */
  accountPath: string | null;
  coinType: number | null;
  account: number | null;
  /** Oyster's pq=true addresses: the BIP86 key tweaked with a one-leaf XMSS tree. */
  pq: boolean;
  /** For a passphrase variant, the passphrase's index in `passphrases`; null otherwise. */
  passphraseIndex: number | null;
  /** Whether a wallet restored the way Oyster and the desktop wallet restore would scan this variant. */
  oysterScans: boolean;
}

/** A used address with what it holds now. */
export interface UsedAddress extends DiscoveredAddress {
  balance: WalletBalance;
}

/** What one variant holds. */
export interface VariantReport {
  variant: DerivationVariant;
  /**
   * The account's extended public key, for a watch-only wallet or another
   * diagnoseAccount, or null for pq addresses, which no extended key describes.
   */
  accountKey: string | null;
  /** The account key's origin, when known. */
  origin: KeyOrigin | null;
  receive: { used: UsedAddress[]; nextIndex: number };
  change: { used: UsedAddress[]; nextIndex: number };
  /**
   * The smallest gap limit that reaches every used address on both chains:
   * the longest run of unused addresses before a used one, plus one. Give a
   * wallet at least this as its gapLimit. 0 when nothing was used.
   */
  requiredGap: number;
  /** Unspent outputs of the used addresses, each naming its child, as payFromAccount takes them. */
  utxos: AccountDiscovery['utxos'];
  balance: WalletBalance;
}

/** A reason a restored wallet shows less than the chain holds. */
export type RecoveryReasonCode =
  /** Used addresses lie past Oyster's recovery window of unused addresses. */
  | 'BEYOND_RECOVERY_WINDOW'
  /** Coins sit on a derivation a restore does not scan. */
  | 'OTHER_DERIVATION'
  /** Coinbase outputs short of maturity are not spendable yet. */
  | 'IMMATURE_COINBASE'
  /** Payments are still in the mempool. */
  | 'UNCONFIRMED'
  /** The backend could not answer for a P2MR address. */
  | 'P2MR_NOT_SEEN'
  /** Addresses were used, and everything they held has been spent. */
  | 'SPENT'
  /** No address of any variant has ever been paid, and the P2MR addresses given hold nothing. */
  | 'NO_ACTIVITY';

/** One finding of a diagnosis, in plain words. */
export interface RecoveryReason {
  code: RecoveryReasonCode;
  message: string;
  /** The variant it concerns, by id. */
  variant?: string;
  /** The addresses it concerns. */
  addresses?: string[];
}

/** The result of diagnoseSeed and diagnoseAccount. */
export interface RecoveryReport {
  network: PearlNetwork['name'];
  gap: number;
  /** Every variant scanned, in the order tried. */
  variants: VariantReport[];
  /** The variant to restore from: the one holding the most, or the first with any address used; null when none has. */
  recommended: VariantReport | null;
  /** Everything the variants hold together. */
  balance: WalletBalance;
  reasons: RecoveryReason[];
}

/** Options for diagnoseSeed and diagnoseAccount. */
export interface RecoveryOptions {
  /** Consecutive unused addresses that end a chain's scan. Default DEFAULT_RECOVERY_GAP, four times Oyster's window. */
  gap?: number;
  /** Addresses asked about per backend round. Default 50. */
  batchSize?: number;
  /** Stops the scan between rounds. */
  signal?: AbortSignal;
  /** Called as each variant starts, for progress. */
  onVariant?: (variant: DerivationVariant) => void;
  /** P2MR addresses to check besides the derived ones, such as an XMSS key's. */
  p2mrAddresses?: readonly string[];
}

/** Options for diagnoseSeed. */
export interface SeedRecoveryOptions extends RecoveryOptions {
  /** Accounts to scan, from 0. Default 3: account 0, which a restore scans, and two made with createnewaccount. */
  accounts?: number;
  /** BIP39 passphrases to try besides the empty one. Neither Oyster nor the desktop wallet sets one; its wallet password is not one. */
  passphrases?: readonly string[];
  /** Also derive with the other Pearl coin type (1 on mainnet, 808276 elsewhere). Default true. */
  otherCoinType?: boolean;
  /**
   * Indices of Oyster's pq=true addresses to check on each chain of account
   * 0. Each costs an XMSS key generation, seconds apiece, so the default is 0.
   */
  pqAddresses?: number;
}

interface Candidate {
  variant: DerivationVariant;
  account: Pick<PearlAccount, 'deriveAddress'>;
  accountKey: string | null;
  origin: KeyOrigin | null;
}

function positive(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
  return value;
}

/** The phrase as Oyster's command line would hash it, or null when go-bip39 would refuse it. */
function asTyped(raw: string): string[] {
  const trimmed = raw.trim();
  // go-bip39 splits with strings.Fields and looks words up case-sensitively.
  const fieldsValid = (text: string): boolean => {
    const words = text.split(/\s+/);
    return [12, 15, 18, 21, 24].includes(words.length) && words.every((word) => wordlist.includes(word));
  };
  return [trimmed, trimmed.toLowerCase()].filter((text, i, all) => all.indexOf(text) === i && fieldsValid(text));
}

function bip39Seed(phrase: string, passphrase: string): Uint8Array {
  return pbkdf2(sha512, encoder.encode(phrase.normalize('NFKD')), encoder.encode(`mnemonic${passphrase}`.normalize('NFKD')), { c: 2048, dkLen: 64 });
}

function variantId(prefix: string, path: string): string {
  return `${prefix} ${path}`;
}

function seedCandidates(
  seed: Uint8Array,
  source: DerivationSource,
  passphraseIndex: number | null,
  network: PearlNetwork,
  options: Required<Pick<SeedRecoveryOptions, 'accounts' | 'otherCoinType' | 'pqAddresses'>>,
): Candidate[] {
  // The passphrase itself never goes into an id, only where it sits in the caller's list.
  const label = passphraseIndex === null ? source : `${source}[${passphraseIndex}]`;
  const coinTypes = [network.coinType];
  if (options.otherCoinType) {
    const other = network.coinType === networks.mainnet.coinType ? networks.testnet.coinType : networks.mainnet.coinType;
    coinTypes.push(other);
  }
  const out: Candidate[] = [];
  const fingerprint = toHex(bip32.fromSeed(seed).fingerprint);
  for (const coinType of coinTypes) {
    const derivation = coinType === network.coinType ? network : customNetwork(network, { coinType });
    for (let number = 0; number < options.accounts; number += 1) {
      const account = deriveAccountFromSeed(seed, derivation, number);
      const path = `m/86'/${coinType}'/${number}'`;
      out.push({
        variant: {
          id: variantId(label, path),
          source,
          accountPath: path,
          coinType,
          account: number,
          pq: false,
          passphraseIndex,
          oysterScans: source !== 'as-typed' && source !== 'passphrase' && coinType === network.coinType && number === 0,
        },
        account,
        accountKey: account.extendedPublicKey(),
        origin: { masterFingerprint: fingerprint, path },
      });
    }
  }
  if (options.pqAddresses > 0) {
    out.push(pqCandidate(seed, source, label, network));
  }
  return out;
}

/** The address Oyster's getnewaddress gave with pq=true for this seed's child. */
export function oysterPqAddress(seed: Uint8Array, network: PearlNetwork, index: number, change = false, account = 0): string {
  const master = bip32.fromSeed(seed);
  const tail = `${account}'/${change ? 1 : 0}/${index}`;
  const pqNode = master.derivePath(`m/222'/${network.coinType}'/${tail}`);
  const xmssSeeds = hkdf(sha256, pqNode.privateKey!, undefined, encoder.encode('XMSS-SEED-EXPANSION'), XMSS_PRIVATE_SEED_LENGTH + XMSS_PUBLIC_SEED_LENGTH);
  const { publicKey, secretKey } = xmssKeygen(xmssSeeds.subarray(0, XMSS_PRIVATE_SEED_LENGTH), xmssSeeds.subarray(XMSS_PRIVATE_SEED_LENGTH));
  secretKey.fill(0);
  xmssSeeds.fill(0);
  const internal = master.derivePath(`m/86'/${network.coinType}'/${tail}`).publicKey.subarray(1);
  const { outputKey } = taprootOutputKey(internal, assembleScriptTree([xmssLeafScript(publicKey)]).root);
  return encodeAddress({ version: 1, program: outputKey }, network);
}

function pqCandidate(seed: Uint8Array, source: DerivationSource, label: string, network: PearlNetwork): Candidate {
  const path = `m/86'/${network.coinType}'/0'`;
  const cache = new Map<string, string>();
  return {
    variant: { id: variantId(`${label} pq`, path), source, accountPath: path, coinType: network.coinType, account: 0, pq: true, passphraseIndex: null, oysterScans: false },
    account: {
      deriveAddress(index: number, change = false): string {
        const key = `${change ? 1 : 0}/${index}`;
        let address = cache.get(key);
        if (address === undefined) {
          address = oysterPqAddress(seed, network, index, change);
          cache.set(key, address);
        }
        return address;
      },
    },
    accountKey: null,
    origin: null,
  };
}

async function scan(
  candidate: Candidate,
  backend: Pick<WalletBackend, 'getAddressActivity' | 'getUtxos' | 'network' | 'findUsed'>,
  gap: number,
  batchSize: number,
  signal: AbortSignal | undefined,
): Promise<VariantReport> {
  const found: AccountDiscovery = await discoverAccount(candidate.account, backend, { gap, batchSize, ...(signal === undefined ? {} : { signal }) });
  const maturity = backend.network.coinbaseMaturity;
  const withBalance = (child: DiscoveredAddress): UsedAddress => ({
    ...child,
    balance: sumBalance(found.utxos.filter((utxo) => utxo.address === child.address), maturity),
  });
  return {
    variant: candidate.variant,
    accountKey: candidate.accountKey,
    origin: candidate.origin,
    receive: { used: found.receive.used.map(withBalance), nextIndex: found.receive.nextIndex },
    change: { used: found.change.used.map(withBalance), nextIndex: found.change.nextIndex },
    utxos: found.utxos,
    balance: found.balance,
    requiredGap: Math.max(gapNeeded(found.receive.used), gapNeeded(found.change.used)),
  };
}

function gapNeeded(used: readonly DiscoveredAddress[]): number {
  let previous = -1;
  let widest = 0;
  for (const child of used) {
    widest = Math.max(widest, child.index - previous);
    previous = child.index;
  }
  return widest;
}

/** The pq variant checks a fixed range, since each address costs an XMSS key. */
async function scanRange(
  candidate: Candidate,
  backend: Pick<WalletBackend, 'getAddressActivity' | 'getUtxos' | 'network' | 'findUsed'>,
  count: number,
  signal: AbortSignal | undefined,
): Promise<VariantReport> {
  return scan(candidate, backend, count, count, signal);
}

const total = (balance: WalletBalance): bigint => balance.confirmed + balance.unconfirmed + balance.immature;

function addBalances(balances: readonly WalletBalance[]): WalletBalance {
  return balances.reduce(
    (sum, b) => ({ confirmed: sum.confirmed + b.confirmed, unconfirmed: sum.unconfirmed + b.unconfirmed, immature: sum.immature + b.immature }),
    { confirmed: 0n, unconfirmed: 0n, immature: 0n },
  );
}

/** Indices a restore with Oyster's recovery window does not reach. */
function beyondWindow(used: readonly UsedAddress[]): UsedAddress[] {
  let lastFound = -1;
  const missed: UsedAddress[] = [];
  for (const child of used) {
    if (child.index - lastFound <= OYSTER_RECOVERY_WINDOW) lastFound = child.index;
    else missed.push(child);
  }
  return missed;
}

function describe(variant: DerivationVariant): string {
  if (variant.pq) return `Oyster's pq=true addresses (${variant.accountPath}), which current Oyster no longer derives`;
  switch (variant.source) {
    case 'as-typed':
      return `the phrase exactly as it was typed into Oyster's command line (${variant.accountPath}); the desktop wallet tidies the spacing and gets another seed`;
    case 'passphrase':
      return `a BIP39 passphrase (${variant.accountPath}), which Oyster and the desktop wallet never set`;
    default:
      if (variant.account !== null && variant.account > 0) return `account ${variant.account} (${variant.accountPath}), which a restore never scans`;
      return `coin type ${variant.coinType} (${variant.accountPath}), which this network's wallet does not use`;
  }
}

function buildReport(network: PearlNetwork, gap: number, variants: VariantReport[], p2mr: { unseen: string[]; balance: WalletBalance }): RecoveryReport {
  const reasons: RecoveryReason[] = [];
  const used = (report: VariantReport): number => report.receive.used.length + report.change.used.length;
  const active = variants.filter((report) => used(report) > 0);
  for (const report of active) {
    const { variant } = report;
    if (variant.oysterScans) {
      const missed = [...beyondWindow(report.receive.used), ...beyondWindow(report.change.used)];
      if (missed.length > 0) {
        const held = total(addBalances(missed.map((child) => child.balance)));
        reasons.push({
          code: 'BEYOND_RECOVERY_WINDOW',
          message: `${missed.length} used address(es) lie more than ${OYSTER_RECOVERY_WINDOW} unused addresses past the last one before them, so a restore with Oyster's recovery window stops short of them; they hold ${formatPearl(held)} PRL`,
          variant: variant.id,
          addresses: missed.map((child) => child.address),
        });
      }
    } else {
      reasons.push({
        code: 'OTHER_DERIVATION',
        message: `${formatPearl(total(report.balance))} PRL sits on ${describe(variant)}`,
        variant: variant.id,
        addresses: [...report.receive.used, ...report.change.used].map((child) => child.address),
      });
    }
  }
  const balance = addBalances([...variants.map((report) => report.balance), p2mr.balance]);
  if (balance.immature > 0n) {
    reasons.push({ code: 'IMMATURE_COINBASE', message: `${formatPearl(balance.immature)} PRL of coinbase outputs needs ${network.coinbaseMaturity} confirmations before it counts as spendable` });
  }
  if (balance.unconfirmed > 0n) {
    reasons.push({ code: 'UNCONFIRMED', message: `${formatPearl(balance.unconfirmed)} PRL is in the mempool and not yet in a block` });
  }
  if (p2mr.unseen.length > 0) {
    reasons.push({ code: 'P2MR_NOT_SEEN', message: `the backend could not answer for ${p2mr.unseen.length} P2MR address(es); pearld's address index holds Taproot addresses only, so use a backend that scans block filters`, addresses: p2mr.unseen });
  }
  if (active.length > 0 && total(balance) === 0n) {
    reasons.push({ code: 'SPENT', message: 'addresses of this seed were paid, and everything they held has since been spent' });
  }
  if (active.length === 0 && total(p2mr.balance) === 0n) {
    reasons.push({
      code: 'NO_ACTIVITY',
      message: `no address of any variant has been paid within ${gap} addresses; check the phrase and network, and that the backend has caught up with the chain`,
    });
  }
  const recommended =
    [...active].sort((a, b) => (total(b.balance) > total(a.balance) ? 1 : total(b.balance) < total(a.balance) ? -1 : 0))[0] ?? null;
  return { network: network.name, gap, variants, recommended, balance, reasons };
}

async function checkP2mr(backend: Pick<WalletBackend, 'getBalance'>, addresses: readonly string[]): Promise<{ unseen: string[]; balance: WalletBalance }> {
  const unseen: string[] = [];
  const balances: WalletBalance[] = [];
  for (const address of addresses) {
    try {
      balances.push(await backend.getBalance([address]));
    } catch (err) {
      if (!(err instanceof PearlError)) throw err;
      unseen.push(address);
    }
  }
  return { unseen, balance: addBalances(balances) };
}

async function run(
  candidates: readonly Candidate[],
  backend: Pick<WalletBackend, 'getAddressActivity' | 'getUtxos' | 'getBalance' | 'network' | 'findUsed'>,
  options: RecoveryOptions & { pqAddresses?: number },
): Promise<RecoveryReport> {
  const gap = positive(options.gap ?? DEFAULT_RECOVERY_GAP, 'gap');
  const batchSize = positive(options.batchSize ?? 50, 'batchSize');
  const reports: VariantReport[] = [];
  for (const candidate of candidates) {
    options.signal?.throwIfAborted();
    options.onVariant?.(candidate.variant);
    reports.push(
      candidate.variant.pq
        ? await scanRange(candidate, backend, options.pqAddresses ?? 0, options.signal)
        : await scan(candidate, backend, gap, batchSize, options.signal),
    );
  }
  const p2mr = await checkP2mr(backend, options.p2mrAddresses ?? []);
  return buildReport(backend.network, gap, reports, p2mr);
}

/**
 * Scans every derivation Pearl's wallets have used for a recovery phrase, a
 * hex seed or seed bytes, deeper than a restore does, and reports what each
 * holds and why a restored wallet might show less. Only addresses go to the
 * backend; the seed and keys stay in this process, and nothing is written.
 *
 * A phrase is tried as Oyster and the desktop wallet read it, and, when it
 * differs, exactly as typed, as Oyster's command line hashes it. Each seed is
 * tried on `accounts` accounts with the network's coin type and the other
 * Pearl one, with each passphrase in `passphrases`, and with `pqAddresses`
 * of Oyster's pq=true addresses.
 *
 * Throws SEED_INVALID for input that is neither a valid phrase nor a hex
 * seed, and rejects with what the backend rejects with.
 */
export async function diagnoseSeed(
  input: string | Uint8Array,
  backend: Pick<WalletBackend, 'getAddressActivity' | 'getUtxos' | 'getBalance' | 'network' | 'findUsed'>,
  options: SeedRecoveryOptions = {},
): Promise<RecoveryReport> {
  const network = backend.network;
  const settings = {
    accounts: positive(options.accounts ?? 3, 'accounts'),
    otherCoinType: options.otherCoinType ?? true,
    pqAddresses: options.pqAddresses ?? 0,
  };
  if (!Number.isInteger(settings.pqAddresses) || settings.pqAddresses < 0) throw new RangeError('pqAddresses must be a non-negative integer');
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  const add = (seed: Uint8Array, source: DerivationSource, pq: boolean, passphraseIndex: number | null = null): void => {
    const key = toHex(seed);
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(...seedCandidates(seed, source, passphraseIndex, network, { ...settings, pqAddresses: pq ? settings.pqAddresses : 0 }));
  };
  if (input instanceof Uint8Array) {
    add(Uint8Array.from(input), 'seed', true);
  } else if (typeof input === 'string') {
    const parsed = parseSeedInput(input);
    if (parsed.kind === 'invalid') {
      const reason = parsed.reason.endsWith('is not a BIP39 word') ? 'a word is not in the BIP39 list' : parsed.reason;
      throw new PearlError('SEED_INVALID', `invalid seed: ${reason}`);
    }
    if (parsed.kind === 'hex') {
      add(parsed.seed, 'hex', true);
    } else {
      add(parsed.seed, 'oyster', true);
      for (const typed of asTyped(input)) add(bip39Seed(typed, ''), 'as-typed', false);
      for (const [i, passphrase] of (options.passphrases ?? []).entries()) {
        if (passphrase !== '') add(bip39Seed(normalizeMnemonic(input), passphrase), 'passphrase', false, i);
      }
    }
  } else {
    throw new TypeError('input must be a recovery phrase, a hex seed or seed bytes');
  }
  return run(candidates, backend, { ...options, pqAddresses: settings.pqAddresses });
}

/**
 * The keyless check: scans one account, given as its extended public key (or
 * as an account object), to a deep gap on both chains, and reports what it
 * holds and why a restored wallet might show less. Pass the key's origin to
 * have it carried into the report.
 *
 * Throws what importWatchOnlyAccount throws for the key, and rejects with
 * what the backend rejects with.
 */
export async function diagnoseAccount(
  account: string | Pick<PearlAccount, 'deriveAddress' | 'extendedPublicKey' | 'path' | 'masterFingerprint'>,
  backend: Pick<WalletBackend, 'getAddressActivity' | 'getUtxos' | 'getBalance' | 'network' | 'findUsed'>,
  options: RecoveryOptions & { origin?: KeyOrigin } = {},
): Promise<RecoveryReport> {
  const imported = typeof account === 'string' ? importWatchOnlyAccount(account, backend.network, options.origin) : account;
  const path = imported.path;
  const match = path === null ? null : /^m\/86'\/(\d+)'\/(\d+)'$/.exec(path);
  const coinType = match === null ? null : Number(match[1]);
  const number = match === null ? null : Number(match[2]);
  const origin = path === null || imported.masterFingerprint === null ? null : { masterFingerprint: imported.masterFingerprint, path };
  return run(
    [
      {
        variant: {
          id: variantId('account', path ?? imported.extendedPublicKey().slice(0, 16)),
          source: 'account-key',
          accountPath: path,
          coinType,
          account: number,
          pq: false,
          passphraseIndex: null,
          // A key without its origin is taken to be the account a restore scans.
          oysterScans: path === null || (coinType === backend.network.coinType && number === 0),
        },
        account: imported,
        accountKey: imported.extendedPublicKey(),
        origin,
      },
    ],
    backend,
    options,
  );
}
