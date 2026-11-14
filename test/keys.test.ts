import { bech32m } from 'bech32';
import { BIP32Factory } from 'bip32';
import { initEccLib, payments } from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { describe, expect, it } from 'vitest';
import { decodeAddress } from '../src/address.js';
import { networks, type PearlNetwork } from '../src/networks.js';
import {
  accountPath,
  deriveAccountFromSeed,
  importWatchOnlyAccount,
} from '../src/keys.js';
import { mnemonicToSeed } from '../src/mnemonic.js';

const bip32 = BIP32Factory(ecc);
initEccLib(ecc);

// The official BIP86 vectors use coin type 0. Pearl regtest keeps the Pearl
// HRP and HD version bytes but is pinned to coin type 0 here so the official
// vectors apply byte-for-byte; no Pearl address expectation is invented, they
// are derived from the official vectors by re-encoding.
const vectorNetwork: PearlNetwork = {
  ...networks.regtest,
  coinType: 0,
};

// Official BIP86 test vectors (mnemonic "abandon ... about", no passphrase).
const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const SEED_HEX =
  '5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc19a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4';
const ACCOUNT_XPUB =
  'xpub6BgBgsespWvERF3LHQu6CnqdvfEvtMcQjYrcRzx53QJjSxarj2afYWcLteoGVky7D3UKDP9QyrLprQ3VCECoY49yfdDEHGCtMMj92pReUsQ';
const INTERNAL_KEY_0_0 =
  'cc8a4bc64d897bddc5fbc2f670f7a8ba0b386779106cf1223c6fc5d7cd6fc115';
const ADDRESS_0_0 = 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr';
const ADDRESS_0_1 = 'bc1p4qhjn9zdvkux4e44uhx8tc55attvtyu358kutcqkudyccelu0was9fqzwh';
const ADDRESS_1_0 = 'bc1p3qkhfews2uk44qtvauqyr2ttdsw7svhkl9nkm9s9c3x4ax5h60wqwruhk7';

// The official account xpub payload re-encoded with Pearl regtest HD public
// version bytes (vpub, 0x045f1cf6). Same 78-byte payload, different prefix.
const ACCOUNT_VPUB =
  'vpub5Y1f5YK3X9qGief6chKqncedaix317dQuKpAsDAJHPYyLkxQDiFYJPJ4rEt6VwfGPmEhiRxJ4Xdj5ppMkqNmwanmvwpP7SZuoubrFemtguh';

// Official BIP39 vector: the same mnemonic with passphrase "TREZOR".
const TREZOR_SEED_HEX =
  'c55257c360c07c72029aebc1b53c05ed0362ada38ead3e3e9efa3708e53495531f09a6987599d18264c1e1c92f2cf141630c7a3c4ab7c81b2f001698e7463b04';

const HARDENED_OFFSET = 0x80000000;

function seedFromHex(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

/** Re-encodes a bech32m address with a different human-readable part. */
function reencodeHrp(address: string, hrp: string): string {
  return bech32m.encode(hrp, bech32m.decode(address).words);
}

/** Maps Pearl network params to the subset BIP32 serialisation needs. */
function bip32Params(network: PearlNetwork): {
  wif: number;
  bip32: { public: number; private: number };
} {
  return {
    wif: network.wif,
    bip32: { public: network.hdPublicKeyId, private: network.hdPrivateKeyId },
  };
}

const seed = seedFromHex(SEED_HEX);

describe('accountPath', () => {
  it('builds the BIP86 path for the default account', () => {
    expect(accountPath(networks.mainnet)).toBe("m/86'/808276'/0'");
    expect(accountPath(networks.regtest)).toBe("m/86'/1'/0'");
    expect(accountPath(vectorNetwork)).toBe("m/86'/0'/0'");
  });

  it('builds the BIP86 path for an explicit account', () => {
    expect(accountPath(networks.regtest, 3)).toBe("m/86'/1'/3'");
  });

  it('rejects invalid or hardened account numbers', () => {
    expect(() => accountPath(networks.regtest, -1)).toThrow(RangeError);
    expect(() => accountPath(networks.regtest, HARDENED_OFFSET)).toThrow(RangeError);
    expect(() => accountPath(networks.regtest, 1.5)).toThrow(RangeError);
    expect(() => accountPath(networks.regtest, Number.NaN)).toThrow(RangeError);
  });
});

describe('mnemonicToSeed', () => {
  it('matches the official BIP86 seed vector', () => {
    const result = mnemonicToSeed(MNEMONIC);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBe(64);
    expect(toHex(result)).toBe(SEED_HEX);
  });

  it('matches the official BIP39 passphrase vector', () => {
    expect(toHex(mnemonicToSeed(MNEMONIC, 'TREZOR'))).toBe(TREZOR_SEED_HEX);
  });

  it('rejects an invalid mnemonic', () => {
    expect(() => mnemonicToSeed('abandon abandon abandon')).toThrow(
      /invalid BIP39 mnemonic/,
    );
    expect(() => mnemonicToSeed(`${MNEMONIC} extra`)).toThrow(
      /invalid BIP39 mnemonic/,
    );
  });
});

describe('deriveAccountFromSeed', () => {
  it('derives a neutered depth-3 account node at the BIP86 path', () => {
    const account = deriveAccountFromSeed(seed, vectorNetwork);
    expect(account.node.depth).toBe(3);
    expect(account.node.isNeutered()).toBe(true);
    expect(account.node.privateKey).toBeUndefined();
    expect(account.path).toBe("m/86'/0'/0'");
  });

  it('matches the official account key with Pearl HD version bytes', () => {
    const account = deriveAccountFromSeed(seed, vectorNetwork);
    expect(account.extendedPublicKey()).toBe(ACCOUNT_VPUB);
    expect(account.extendedPublicKey().startsWith('vpub')).toBe(true);
  });

  it('matches the official BIP86 internal key and addresses', () => {
    const account = deriveAccountFromSeed(seed, vectorNetwork);
    expect(toHex(account.derivePublicKey(0))).toBe(INTERNAL_KEY_0_0);
    expect(account.derivePublicKey(0).length).toBe(32);
    // Pearl addresses are the official bech32m payloads under the Pearl HRP.
    expect(account.deriveAddress(0)).toBe(reencodeHrp(ADDRESS_0_0, 'rprl'));
    expect(account.deriveAddress(1)).toBe(reencodeHrp(ADDRESS_0_1, 'rprl'));
    expect(account.deriveAddress(0, true)).toBe(reencodeHrp(ADDRESS_1_0, 'rprl'));
  });

  it('applies the standard BIP86 tweak, verified independently', () => {
    const account = deriveAccountFromSeed(seed, vectorNetwork);
    const internalPubkey = account.derivePublicKey(0);
    const expected = payments.p2tr({ internalPubkey: Buffer.from(internalPubkey) });
    if (expected.output === undefined) {
      throw new Error('independent p2tr computation produced no output script');
    }
    const decoded = decodeAddress(account.deriveAddress(0), vectorNetwork);
    expect(decoded.version).toBe(1);
    expect(toHex(decoded.program)).toBe(toHex(expected.output.subarray(2)));
  });

  it('derives distinct accounts per account index', () => {
    const account1 = deriveAccountFromSeed(seed, vectorNetwork, 1);
    expect(account1.path).toBe("m/86'/0'/1'");
    expect(account1.extendedPublicKey().startsWith('vpub')).toBe(true);
    expect(toHex(account1.derivePublicKey(0))).not.toBe(INTERNAL_KEY_0_0);
  });

  it('encodes mainnet keys and addresses with mainnet parameters', () => {
    const account = deriveAccountFromSeed(seed, networks.mainnet);
    expect(account.extendedPublicKey().startsWith('zpub')).toBe(true);
    expect(account.deriveAddress(0).startsWith('prl1p')).toBe(true);
  });

  it('rejects seeds outside the BIP39 length bounds', () => {
    expect(() => deriveAccountFromSeed(new Uint8Array(15), vectorNetwork)).toThrow(
      RangeError,
    );
    expect(() => deriveAccountFromSeed(new Uint8Array(65), vectorNetwork)).toThrow(
      RangeError,
    );
    expect(() =>
      deriveAccountFromSeed(new Uint8Array(16), vectorNetwork),
    ).not.toThrow();
    expect(() =>
      deriveAccountFromSeed(new Uint8Array(64), vectorNetwork),
    ).not.toThrow();
  });

  it('rejects hardened or invalid address indices', () => {
    const account = deriveAccountFromSeed(seed, vectorNetwork);
    for (const index of [-1, HARDENED_OFFSET, HARDENED_OFFSET + 1, 1.5, Number.NaN]) {
      expect(() => account.deriveAddress(index)).toThrow(RangeError);
      expect(() => account.derivePublicKey(index)).toThrow(RangeError);
    }
    expect(() => account.deriveAddress(HARDENED_OFFSET - 1)).not.toThrow();
  });
});

describe('importWatchOnlyAccount', () => {
  const master = bip32.fromSeed(seed, bip32Params(vectorNetwork));
  const accountVprv = master.derivePath("m/86'/0'/0'").toBase58();
  const rootVpub = master.neutered().toBase58();
  const depth4Vpub = master
    .derivePath("m/86'/0'/0'/0")
    .neutered()
    .toBase58();

  it('imports the official account key under Pearl version bytes', () => {
    const account = importWatchOnlyAccount(ACCOUNT_VPUB, vectorNetwork);
    expect(account.node.depth).toBe(3);
    expect(account.node.isNeutered()).toBe(true);
    expect(account.node.privateKey).toBeUndefined();
    expect(account.path).toBeNull();
    expect(account.extendedPublicKey()).toBe(ACCOUNT_VPUB);
    expect(toHex(account.derivePublicKey(0))).toBe(INTERNAL_KEY_0_0);
    expect(account.deriveAddress(0)).toBe(reencodeHrp(ADDRESS_0_0, 'rprl'));
    expect(account.deriveAddress(0, true)).toBe(reencodeHrp(ADDRESS_1_0, 'rprl'));
  });

  it('rejects extended private keys', () => {
    expect(() => importWatchOnlyAccount(accountVprv, vectorNetwork)).toThrow(
      /extended private key/,
    );
  });

  it('rejects keys from the wrong network', () => {
    // Bitcoin xpub version bytes are not valid on any Pearl network.
    expect(() => importWatchOnlyAccount(ACCOUNT_XPUB, vectorNetwork)).toThrow(
      /version bytes/,
    );
    // Regtest vpub is not valid on mainnet (zpub) either.
    expect(() => importWatchOnlyAccount(ACCOUNT_VPUB, networks.mainnet)).toThrow(
      /version bytes/,
    );
  });

  it('rejects keys that are not at account depth 3', () => {
    expect(() => importWatchOnlyAccount(rootVpub, vectorNetwork)).toThrow(
      /depth 3/,
    );
    expect(() => importWatchOnlyAccount(depth4Vpub, vectorNetwork)).toThrow(
      /depth 3/,
    );
  });

  it('rejects malformed keys', () => {
    expect(() => importWatchOnlyAccount('not-a-vpub', vectorNetwork)).toThrow();
    expect(() => importWatchOnlyAccount('', vectorNetwork)).toThrow();
  });

  it('produces addresses identical to seed-derived accounts', () => {
    const fromSeed = deriveAccountFromSeed(seed, vectorNetwork);
    const imported = importWatchOnlyAccount(ACCOUNT_VPUB, vectorNetwork);
    for (const change of [false, true]) {
      for (const index of [0, 1, 5]) {
        expect(imported.deriveAddress(index, change)).toBe(
          fromSeed.deriveAddress(index, change),
        );
        expect(toHex(imported.derivePublicKey(index, change))).toBe(
          toHex(fromSeed.derivePublicKey(index, change)),
        );
      }
    }
  });
});
