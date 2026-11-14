// BIP86 hierarchical-deterministic account support for Pearl. Watch-only
// accounts expose neutered depth-3 nodes. Signing accounts keep private nodes
// in closures and use the standard BIP86 tweak for Taproot key-path spends.

import { BIP32Factory } from 'bip32';
import type { BIP32Interface } from 'bip32';
import { crypto as bitcoinCrypto, Transaction } from 'bitcoinjs-lib';
import type { Psbt } from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { MAX_GRAIN } from './amount.js';
import { fromOutputScript } from './address.js';
import type { PearlNetwork } from './networks.js';
import { signMessage } from './message.js';
import { p2tr } from './payments.js';
import { classifyOutputScript } from './script.js';
import {
  assertTaprootSighashType as assertSighashType,
  signP2mrInput,
  signP2mrScriptPathInput,
  signTaprootScriptPathInput,
} from './scriptpath.js';
import type { P2mrPsbtSignOptions, P2mrSignOptions } from './scriptpath.js';

export { mnemonicToSeed } from './mnemonic.js';

const bip32 = BIP32Factory(ecc);

/** BIP86 purpose field. */
const PURPOSE = 86;

/** Highest permitted non-hardened index; hardened indices start at 2^31. */
const MAX_NON_HARDENED_INDEX = 0x7fffffff;

/** BIP39 permits seeds between 128 and 512 bits. */
const MIN_SEED_BYTES = 16;
const MAX_SEED_BYTES = 64;

/** Subset of bitcoinjs network parameters that BIP32 serialisation needs. */
interface Bip32NetworkParams {
  wif: number;
  bip32: { public: number; private: number };
}

/**
 * Watch-only view of a BIP86 account.
 *
 * The underlying BIP32 node is always neutered and sits at depth 3
 * (m/86'/coinType'/account'), so no private key material is ever exposed
 * through this interface.
 */
export interface PearlAccount {
  /** Neutered BIP32 account node (depth 3, no private key). */
  readonly node: BIP32Interface;
  /**
   * Account derivation path, or null when the account was imported from an
   * extended public key whose origin path is unknown.
   */
  readonly path: string | null;
  /** Account-level extended public key encoded with the network HD version bytes. */
  extendedPublicKey(): string;
  /**
   * x-only internal (untweaked) public key at
   * m/86'/coinType'/account'/{0 or 1}/{index}.
   */
  derivePublicKey(index: number, change?: boolean): Uint8Array;
  /**
   * BIP86 taproot (p2tr) address at
   * m/86'/coinType'/account'/{0 or 1}/{index}.
   */
  deriveAddress(index: number, change?: boolean): string;
}

export interface PearlInputOptions {
  index: number;
  change?: boolean;
  value: bigint;
  sighashType?: number;
}

export interface PearlSignOptions {
  index: number;
  change?: boolean;
}

/** trustPrevouts applies to P2MR inputs only. */
export interface PearlScriptPathSignOptions extends P2mrPsbtSignOptions {
  index: number;
  change?: boolean;
  /** Hash of the tap leaf to sign, from assembleScriptTree. */
  leafHash: Uint8Array;
}

export interface PearlP2mrSignOptions extends P2mrSignOptions {
  index: number;
  change?: boolean;
}

/**
 * A BIP86 account that retains private keys. Key-path spends sign with the
 * BIP86-tweaked child key; script-path spends sign with the untweaked child
 * key, which is the key derivePublicKey returns and a leaf script names.
 */
export interface PearlSigningAccount {
  readonly path: string;
  watchOnlyAccount(): PearlAccount;
  derivePublicKey(index: number, change?: boolean): Uint8Array;
  deriveAddress(index: number, change?: boolean): string;
  prepareInput(psbt: Psbt, inputIndex: number, options: PearlInputOptions): void;
  signInput(psbt: Psbt, inputIndex: number, options: PearlSignOptions): void;
  /**
   * Signs a P2TR or P2MR script-path PSBT input; see
   * signTaprootScriptPathInput and signP2mrScriptPathInput.
   */
  signScriptPathInput(psbt: Psbt, inputIndex: number, options: PearlScriptPathSignOptions): void;
  /** Signs a P2MR input and sets its witness; see signP2mrInput. */
  signP2mrInput(tx: Transaction, inputIndex: number, options: PearlP2mrSignOptions): void;
  /** Signs a message for the child's P2TR address; see signMessage. */
  signMessage(message: string, options: PearlSignOptions): string;
}

function assertNonHardenedIndex(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > MAX_NON_HARDENED_INDEX) {
    throw new RangeError(
      `${label} must be an integer between 0 and ${MAX_NON_HARDENED_INDEX}; hardened indices are not permitted`,
    );
  }
}

function assertNetwork(network: PearlNetwork): void {
  if (
    network === null ||
    typeof network !== 'object' ||
    typeof network.name !== 'string' ||
    typeof network.bech32Hrp !== 'string' ||
    typeof network.wif !== 'number' ||
    typeof network.hdPublicKeyId !== 'number' ||
    typeof network.hdPrivateKeyId !== 'number'
  ) {
    throw new TypeError('a valid PearlNetwork is required');
  }
  assertNonHardenedIndex(network.coinType, 'Coin type');
}

function toBip32Params(network: PearlNetwork): Bip32NetworkParams {
  return {
    wif: network.wif,
    bip32: {
      public: network.hdPublicKeyId,
      private: network.hdPrivateKeyId,
    },
  };
}

/**
 * BIP86 account derivation path m/86'/coinType'/account' for a network.
 */
export function accountPath(network: PearlNetwork, account = 0): string {
  assertNetwork(network);
  assertNonHardenedIndex(account, 'Account');
  return `m/${PURPOSE}'/${network.coinType}'/${account}'`;
}

function toWatchOnlyAccount(
  node: BIP32Interface,
  path: string | null,
  network: PearlNetwork,
): PearlAccount {
  const accountNode = node.neutered();
  if (accountNode.depth !== 3) {
    throw new Error(
      `account node must sit at depth 3 (m/86'/coinType'/account'), got depth ${accountNode.depth}`,
    );
  }

  const deriveChild = (index: number, change: boolean): BIP32Interface => {
    assertNonHardenedIndex(index, 'Address index');
    return accountNode.derive(change ? 1 : 0).derive(index);
  };

  const internalPublicKey = (child: BIP32Interface): Uint8Array =>
    child.publicKey.slice(1, 33);

  return {
    node: accountNode,
    path,
    extendedPublicKey(): string {
      return accountNode.toBase58();
    },
    derivePublicKey(index: number, change = false): Uint8Array {
      return internalPublicKey(deriveChild(index, change));
    },
    deriveAddress(index: number, change = false): string {
      const internalPubkey = internalPublicKey(deriveChild(index, change));
      return fromOutputScript(p2tr({ internalPubkey }).output, network);
    },
  };
}

/**
 * Derive a watch-only BIP86 account from a raw seed.
 *
 * The seed must be 16 to 64 bytes (128 to 512 bits) per BIP39. The returned
 * account node is neutered; private key material never leaves this function.
 */
export function deriveAccountFromSeed(
  seed: Uint8Array,
  network: PearlNetwork,
  account = 0,
): PearlAccount {
  assertNetwork(network);
  if (seed.length < MIN_SEED_BYTES || seed.length > MAX_SEED_BYTES) {
    throw new RangeError(
      `seed must be between ${MIN_SEED_BYTES} and ${MAX_SEED_BYTES} bytes (128 to 512 bits), got ${seed.length}`,
    );
  }
  const path = accountPath(network, account);
  const master = bip32.fromSeed(seed, toBip32Params(network));
  const accountNode = master.derivePath(path);
  return toWatchOnlyAccount(accountNode, path, network);
}

function assertInputIndex(psbt: Psbt, inputIndex: number): void {
  if (!Number.isInteger(inputIndex) || inputIndex < 0 || inputIndex >= psbt.inputCount) {
    throw new RangeError(`PSBT input index ${inputIndex} is out of range`);
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

/**
 * Derive a BIP86 spending account. The watch-only account returned by
 * watchOnlyAccount never retains the private account node.
 */
export function deriveSigningAccountFromSeed(
  seed: Uint8Array,
  network: PearlNetwork,
  account = 0,
): PearlSigningAccount {
  assertNetwork(network);
  if (seed.length < MIN_SEED_BYTES || seed.length > MAX_SEED_BYTES) {
    throw new RangeError(
      `seed must be between ${MIN_SEED_BYTES} and ${MAX_SEED_BYTES} bytes (128 to 512 bits), got ${seed.length}`,
    );
  }
  const path = accountPath(network, account);
  const master = bip32.fromSeed(seed, toBip32Params(network));
  const accountNode = master.derivePath(path);
  const watchOnly = toWatchOnlyAccount(accountNode, path, network);
  const masterFingerprint = Uint8Array.from(master.fingerprint);

  const deriveChild = (index: number, change: boolean): BIP32Interface => {
    assertNonHardenedIndex(index, 'Address index');
    return accountNode.derive(change ? 1 : 0).derive(index);
  };

  return {
    path,
    watchOnlyAccount(): PearlAccount {
      return watchOnly;
    },
    derivePublicKey(index: number, change = false): Uint8Array {
      return watchOnly.derivePublicKey(index, change);
    },
    deriveAddress(index: number, change = false): string {
      return watchOnly.deriveAddress(index, change);
    },
    prepareInput(psbt: Psbt, inputIndex: number, options: PearlInputOptions): void {
      assertInputIndex(psbt, inputIndex);
      if (typeof options.value !== 'bigint') {
        throw new TypeError('input value must be a bigint of grains');
      }
      if (options.value < 0n || options.value > MAX_GRAIN) {
        throw new Error('input value is outside Pearl amount bounds');
      }
      const sighashType = options.sighashType ?? Transaction.SIGHASH_DEFAULT;
      assertSighashType(sighashType);
      const change = options.change ?? false;
      const internalPubkey = watchOnly.derivePublicKey(options.index, change);
      const script = p2tr({ internalPubkey }).output;
      psbt.updateInput(inputIndex, {
        witnessUtxo: { script, value: options.value },
        tapInternalKey: internalPubkey,
        tapBip32Derivation: [
          {
            pubkey: internalPubkey,
            masterFingerprint,
            path: `${path}/${change ? 1 : 0}/${options.index}`,
            leafHashes: [],
          },
        ],
      });
      if (sighashType !== Transaction.SIGHASH_DEFAULT) {
        psbt.updateInput(inputIndex, { sighashType });
      }
    },
    signInput(psbt: Psbt, inputIndex: number, options: PearlSignOptions): void {
      assertInputIndex(psbt, inputIndex);
      const change = options.change ?? false;
      const child = deriveChild(options.index, change);
      const internalPubkey = child.publicKey.slice(1, 33);
      const input = psbt.data.inputs[inputIndex];
      if (input === undefined) {
        throw new RangeError(`PSBT input index ${inputIndex} is out of range`);
      }
      if (input.tapLeafScript !== undefined || input.tapMerkleRoot !== undefined) {
        throw new Error('BIP86 accounts sign Taproot key-path inputs only');
      }
      if (input.tapInternalKey !== undefined && !equalBytes(input.tapInternalKey, internalPubkey)) {
        throw new Error('PSBT Taproot internal key does not match the account child');
      }
      const expectedScript = p2tr({ internalPubkey }).output;
      if (
        input.witnessUtxo === undefined ||
        !equalBytes(input.witnessUtxo.script, expectedScript)
      ) {
        throw new Error('PSBT witness UTXO does not match the account child');
      }
      const sighashType = input.sighashType ?? Transaction.SIGHASH_DEFAULT;
      assertSighashType(sighashType);
      if (input.tapInternalKey === undefined) {
        psbt.updateInput(inputIndex, { tapInternalKey: internalPubkey });
      }
      const signer = child.tweak(bitcoinCrypto.taggedHash('TapTweak', internalPubkey));
      psbt.signInput(inputIndex, signer, [sighashType]);
      const valid = psbt.validateSignaturesOfInput(inputIndex, (pubkey, hash, signature) =>
        ecc.verifySchnorr(hash, pubkey, signature),
      );
      if (!valid) {
        throw new Error(`invalid Taproot signature for PSBT input ${inputIndex}`);
      }
    },
    signScriptPathInput(
      psbt: Psbt,
      inputIndex: number,
      options: PearlScriptPathSignOptions,
    ): void {
      assertInputIndex(psbt, inputIndex);
      const child = deriveChild(options.index, options.change ?? false);
      const prevScript = psbt.data.inputs[inputIndex]!.witnessUtxo?.script;
      if (prevScript !== undefined && classifyOutputScript(prevScript) === 'p2mr') {
        signP2mrScriptPathInput(psbt, inputIndex, child, options.leafHash, options);
      } else {
        signTaprootScriptPathInput(psbt, inputIndex, child, options.leafHash);
      }
    },
    signP2mrInput(tx: Transaction, inputIndex: number, options: PearlP2mrSignOptions): void {
      const child = deriveChild(options.index, options.change ?? false);
      signP2mrInput(tx, inputIndex, child, options);
    },
    signMessage(message: string, options: PearlSignOptions): string {
      const child = deriveChild(options.index, options.change ?? false);
      return signMessage(child.privateKey!, message);
    },
  };
}

/**
 * Import a watch-only BIP86 account from an extended public key.
 *
 * The key must carry the network's HD public version bytes, sit at depth 3,
 * and must not contain private key material.
 */
export function importWatchOnlyAccount(
  extendedKey: string,
  network: PearlNetwork,
): PearlAccount {
  assertNetwork(network);
  let node: BIP32Interface;
  try {
    node = bip32.fromBase58(extendedKey, toBip32Params(network));
  } catch {
    throw new Error(
      `extended key is invalid or its version bytes do not match network "${network.name}"`,
    );
  }
  if (!node.isNeutered()) {
    throw new Error(
      'watch-only accounts cannot be imported from an extended private key',
    );
  }
  return toWatchOnlyAccount(node, null, network);
}
