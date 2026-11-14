// BIP86 hierarchical-deterministic account support for Pearl. Watch-only
// accounts expose neutered depth-3 nodes. Signing accounts keep private nodes
// in closures and use the standard BIP86 tweak for Taproot key-path spends.
//
// Signing accounts wipe what they can: each child key is overwritten once
// its signature is made, and destroy overwrites the master and account keys.
// That covers the byte arrays pearljs and bip32 hold, not everything that
// ever existed. The seed belongs to the caller. Values computed on the way
// (HMAC outputs, the WASM signer's memory, any copy the engine made when it
// moved an object) wait for the garbage collector, which frees memory without
// clearing it, and a string such as a mnemonic cannot be overwritten at all.

/**
 * BIP86 accounts: watch-only accounts that derive addresses, and signing
 * accounts that also sign.
 *
 * @module
 */

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
  psbtSighashType,
  signP2mrInput,
  signP2mrScriptPathInput,
  signTaprootScriptPathInput,
} from './scriptpath.js';
import type {
  P2mrPsbtSignOptions,
  P2mrSignOptions,
  PsbtSighashOptions,
  TapscriptSigner,
} from './scriptpath.js';
import { equalBytes } from './internal/bytes.js';
import { PearlError, SigningError } from './errors.js';

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

/** Options for prepareInput: the child that holds the spent output, and its value. */
export interface PearlInputOptions {
  /** Address index of the child, 0 to 2147483647. */
  index: number;
  /** Whether the child is on the change chain. False unless given. */
  change?: boolean;
  /** Value of the spent output, in grain. */
  value: bigint;
  /**
   * Written into the PSBT input when it is not SIGHASH_DEFAULT. Signing with it
   * needs the same type in allowedSighashTypes.
   */
  sighashType?: number;
}

/** Which child signs, and optionally the auxiliary randomness to sign with. */
export interface PearlSignOptions {
  index: number;
  change?: boolean;
  /**
   * The 32 bytes of auxiliary randomness BIP340 mixes into the nonce. Fresh
   * random bytes are used when it is left out; pass a fixed value only to
   * get reproducible signatures in tests.
   */
  auxRand?: Uint8Array;
}

/** Options for signInput; allowedSighashTypes holds only SIGHASH_DEFAULT unless set. */
export interface PearlPsbtSignOptions extends PearlSignOptions, PsbtSighashOptions {}

/** trustPrevouts applies to P2MR inputs only. */
export interface PearlScriptPathSignOptions extends P2mrPsbtSignOptions {
  index: number;
  change?: boolean;
  /** Hash of the tap leaf to sign, from assembleScriptTree. */
  leafHash: Uint8Array;
  /** See PearlSignOptions.auxRand. */
  auxRand?: Uint8Array;
}

/**
 * Options for account.signP2mrInput: the child whose key the leaf pushes, plus
 * everything signP2mrInput takes.
 */
export interface PearlP2mrSignOptions extends P2mrSignOptions {
  index: number;
  change?: boolean;
  /** See PearlSignOptions.auxRand. */
  auxRand?: Uint8Array;
}

/**
 * A BIP86 account that retains private keys. Key-path spends sign with the
 * BIP86-tweaked child key; script-path spends sign with the untweaked child
 * key, which is the key derivePublicKey returns and a leaf script names.
 */
export interface PearlSigningAccount {
  /** Account derivation path, m/86'/coinType'/account'. */
  readonly path: string;
  /** The same account without private keys. */
  watchOnlyAccount(): PearlAccount;
  /** x-only internal (untweaked) public key of a child; see PearlAccount.derivePublicKey. */
  derivePublicKey(index: number, change?: boolean): Uint8Array;
  /** BIP86 P2TR address of a child; see PearlAccount.deriveAddress. */
  deriveAddress(index: number, change?: boolean): string;
  /**
   * Adds the witness UTXO, internal key and BIP86 derivation record of a child's
   * output to a PSBT input. Prepare every input before signing any. Throws when
   * the value is not a bigint of grain within Pearl's bounds.
   */
  prepareInput(psbt: Psbt, inputIndex: number, options: PearlInputOptions): void;
  /**
   * Signs a BIP86 key-path PSBT input. The input's sighash type must be in
   * options.allowedSighashTypes.
   */
  signInput(psbt: Psbt, inputIndex: number, options: PearlPsbtSignOptions): void;
  /**
   * Signs a P2TR or P2MR script-path PSBT input; see
   * signTaprootScriptPathInput and signP2mrScriptPathInput.
   */
  signScriptPathInput(psbt: Psbt, inputIndex: number, options: PearlScriptPathSignOptions): void;
  /** Signs a P2MR input and sets its witness; see signP2mrInput. */
  signP2mrInput(tx: Transaction, inputIndex: number, options: PearlP2mrSignOptions): void;
  /** Signs a message for the child's P2TR address; see signMessage. */
  signMessage(message: string, options: PearlSignOptions): string;
  /**
   * Overwrites the master and account private keys with zeros. Every signing
   * method throws afterwards; the watch-only methods keep working. See the
   * note at the top of this module for what this cannot reach.
   */
  destroy(): void;
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
    throw new PearlError('EXTENDED_KEY_INVALID',
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
 *
 * account is the BIP86 account number, 0 unless given. Throws for a seed of
 * another length, an invalid network, or a hardened or negative account number.
 */
export function deriveAccountFromSeed(
  seed: Uint8Array,
  network: PearlNetwork,
  account = 0,
): PearlAccount {
  assertNetwork(network);
  assertSeed(seed);
  const path = accountPath(network, account);
  const master = bip32.fromSeed(seed, toBip32Params(network));
  const accountNode = master.derivePath(path);
  return toWatchOnlyAccount(accountNode, path, network);
}

function assertSeed(seed: Uint8Array): void {
  if (!(seed instanceof Uint8Array)) {
    throw new TypeError('seed must be a Uint8Array');
  }
  if (seed.length < MIN_SEED_BYTES || seed.length > MAX_SEED_BYTES) {
    throw new RangeError(
      `seed must be between ${MIN_SEED_BYTES} and ${MAX_SEED_BYTES} bytes (128 to 512 bits), got ${seed.length}`,
    );
  }
}

/**
 * A Schnorr signer for one private key. BIP340 recommends fresh auxiliary
 * randomness for every signature, as a defence against fault and
 * side-channel attacks on the nonce; bip32's own signSchnorr passes none, so
 * its signatures are fully deterministic.
 */
function schnorrSigner(
  privateKey: Uint8Array,
  publicKey: Uint8Array,
  auxRand: Uint8Array | undefined,
): TapscriptSigner & { sign(): never } {
  if (auxRand !== undefined && (!(auxRand instanceof Uint8Array) || auxRand.length !== 32)) {
    throw new Error('auxRand must be 32 bytes');
  }
  return {
    publicKey,
    // bitcoinjs signers must offer ECDSA too; Taproot never asks for it.
    sign(): never {
      throw new Error('BIP86 accounts only produce Schnorr signatures');
    },
    signSchnorr: (hash: Uint8Array) =>
      ecc.signSchnorr(hash, privateKey, auxRand ?? crypto.getRandomValues(new Uint8Array(32))),
  };
}

function assertInputIndex(psbt: Psbt, inputIndex: number): void {
  if (!Number.isInteger(inputIndex) || inputIndex < 0 || inputIndex >= psbt.inputCount) {
    throw new RangeError(`PSBT input index ${inputIndex} is out of range`);
  }
}

/**
 * Derive a BIP86 spending account. The watch-only account returned by
 * watchOnlyAccount never retains the private account node.
 *
 * Takes the same arguments as deriveAccountFromSeed and throws for the same
 * input. Call destroy on the result when signing is done.
 */
export function deriveSigningAccountFromSeed(
  seed: Uint8Array,
  network: PearlNetwork,
  account = 0,
): PearlSigningAccount {
  assertNetwork(network);
  assertSeed(seed);
  const path = accountPath(network, account);
  const master = bip32.fromSeed(seed, toBip32Params(network));
  const accountNode = master.derivePath(path);
  const watchOnly = toWatchOnlyAccount(accountNode, path, network);
  const masterFingerprint = Uint8Array.from(master.fingerprint);

  let destroyed = false;

  /** Runs use with the private child node, then overwrites the keys derived for it. */
  const withChild = <T>(index: number, change: boolean, use: (child: BIP32Interface) => T): T => {
    if (destroyed) throw new SigningError('SIGNER_DESTROYED', 'this signing account has been destroyed');
    assertNonHardenedIndex(index, 'Address index');
    const branch = accountNode.derive(change ? 1 : 0);
    const child = branch.derive(index);
    try {
      return use(child);
    } finally {
      branch.privateKey?.fill(0);
      child.privateKey?.fill(0);
    }
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
        throw new PearlError('AMOUNT_OUT_OF_RANGE', 'input value is outside Pearl amount bounds');
      }
      const sighashType = options.sighashType ?? Transaction.SIGHASH_DEFAULT;
      assertSighashType(sighashType);
      const change = options.change ?? false;
      const internalPubkey = watchOnly.derivePublicKey(options.index, change);
      const script = p2tr({ internalPubkey }).output;
      psbt.updateInput(inputIndex, {
        witnessUtxo: { script, value: options.value },
        tapInternalKey: Uint8Array.from(internalPubkey),
        tapBip32Derivation: [
          {
            pubkey: internalPubkey,
            masterFingerprint: Uint8Array.from(masterFingerprint),
            path: `${path}/${change ? 1 : 0}/${options.index}`,
            leafHashes: [],
          },
        ],
      });
      if (sighashType !== Transaction.SIGHASH_DEFAULT) {
        psbt.updateInput(inputIndex, { sighashType });
      }
    },
    signInput(psbt: Psbt, inputIndex: number, options: PearlPsbtSignOptions): void {
      assertInputIndex(psbt, inputIndex);
      const change = options.change ?? false;
      const internalPubkey = watchOnly.derivePublicKey(options.index, change);
      const input = psbt.data.inputs[inputIndex];
      if (input === undefined) {
        throw new RangeError(`PSBT input index ${inputIndex} is out of range`);
      }
      if (input.tapLeafScript !== undefined || input.tapMerkleRoot !== undefined) {
        throw new SigningError('INPUT_MISMATCH', 'BIP86 accounts sign Taproot key-path inputs only');
      }
      if (input.tapInternalKey !== undefined && !equalBytes(input.tapInternalKey, internalPubkey)) {
        throw new SigningError('INPUT_MISMATCH', 'PSBT Taproot internal key does not match the account child');
      }
      const expectedScript = p2tr({ internalPubkey }).output;
      if (
        input.witnessUtxo === undefined ||
        !equalBytes(input.witnessUtxo.script, expectedScript)
      ) {
        throw new SigningError('INPUT_MISMATCH', 'PSBT witness UTXO does not match the account child');
      }
      const sighashType = psbtSighashType(input.sighashType, inputIndex, options);
      if (input.tapInternalKey === undefined) {
        psbt.updateInput(inputIndex, { tapInternalKey: internalPubkey });
      }
      withChild(options.index, change, (child) => {
        // The BIP86 tweak, done here so the tweaked key can be overwritten after use.
        const privateKey = child.privateKey!;
        const evenKey = child.publicKey[0] === 0x03 ? ecc.privateNegate(privateKey) : privateKey;
        const tweakedKey = ecc.privateAdd(evenKey, bitcoinCrypto.taggedHash('TapTweak', internalPubkey));
        if (tweakedKey === null) {
          throw new PearlError('KEY_INVALID', 'taproot tweak produced an invalid key');
        }
        try {
          const signer = schnorrSigner(tweakedKey, expectedScript.slice(2), options.auxRand);
          psbt.signInput(inputIndex, signer, [sighashType]);
        } finally {
          tweakedKey.fill(0);
          if (evenKey !== privateKey) evenKey.fill(0);
        }
      });
      const valid = psbt.validateSignaturesOfInput(inputIndex, (pubkey, hash, signature) =>
        ecc.verifySchnorr(hash, pubkey, signature),
      );
      if (!valid) {
        throw new SigningError('SIGNATURE_INVALID', `invalid Taproot signature for PSBT input ${inputIndex}`);
      }
    },
    signScriptPathInput(
      psbt: Psbt,
      inputIndex: number,
      options: PearlScriptPathSignOptions,
    ): void {
      assertInputIndex(psbt, inputIndex);
      const prevScript = psbt.data.inputs[inputIndex]!.witnessUtxo?.script;
      withChild(options.index, options.change ?? false, (child) => {
        const signer = schnorrSigner(child.privateKey!, child.publicKey, options.auxRand);
        if (prevScript !== undefined && classifyOutputScript(prevScript) === 'p2mr') {
          signP2mrScriptPathInput(psbt, inputIndex, signer, options);
        } else {
          signTaprootScriptPathInput(psbt, inputIndex, signer, options);
        }
      });
    },
    signP2mrInput(tx: Transaction, inputIndex: number, options: PearlP2mrSignOptions): void {
      withChild(options.index, options.change ?? false, (child) =>
        signP2mrInput(tx, inputIndex, schnorrSigner(child.privateKey!, child.publicKey, options.auxRand), options),
      );
    },
    signMessage(message: string, options: PearlSignOptions): string {
      return withChild(options.index, options.change ?? false, (child) =>
        signMessage(child.privateKey!, message, options.auxRand === undefined ? {} : { auxRand: options.auxRand }),
      );
    },
    destroy(): void {
      destroyed = true;
      master.privateKey?.fill(0);
      accountNode.privateKey?.fill(0);
    },
  };
}

/**
 * Import a watch-only BIP86 account from an extended public key.
 *
 * The key must carry the network's HD public version bytes, sit at depth 3,
 * and must not contain private key material.
 *
 * Throws for an extended private key, a key whose version bytes belong to
 * another network, and a key at any other depth.
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
    throw new PearlError('EXTENDED_KEY_INVALID',
      `extended key is invalid or its version bytes do not match network "${network.name}"`,
    );
  }
  if (!node.isNeutered()) {
    throw new PearlError('EXTENDED_KEY_INVALID',
      'watch-only accounts cannot be imported from an extended private key',
    );
  }
  return toWatchOnlyAccount(node, null, network);
}
