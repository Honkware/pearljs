// Private keys in wallet import format, as Oyster's dumpprivkey writes them and
// importprivkey reads them (btcutil/wif.go): base58 of the network's WIF
// byte, the 32-byte key, 0x01 for a compressed key, and the first 4 bytes
// of a double SHA-256 checksum. Oyster gives an imported key its BIP86
// key-path P2TR address, which keyPathAddress returns.

/**
 * Wallet import format as Oyster reads and writes it, and the address of a
 * single key.
 *
 * @module
 */

import { sha256 } from '@noble/hashes/sha2';
import * as ecc from 'tiny-secp256k1';
import { encodeAddress } from './address.js';
import type { PearlNetwork } from './networks.js';
import { taprootOutputKey } from './scripttree.js';
import { PearlError } from './errors.js';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const COMPRESS_MAGIC = 0x01;
// 38 bytes take at most 52 base58 characters, and every extra character adds
// a byte, so a longer string is the wrong length whatever it holds.
const MAX_WIF_LENGTH = 52;

/** A private key read from wallet import format. */
export interface DecodedWif {
  /** The 32-byte private key. The caller owns it and should overwrite it when done. */
  privateKey: Uint8Array;
  /** Whether the WIF marks the key as compressed; dumpprivkey always does. */
  compressed: boolean;
}

function base58Encode(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);
  let out = '';
  while (value > 0n) {
    out = ALPHABET[Number(value % 58n)]! + out;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = '1' + out;
  }
  return out;
}

/** base58.Decode returns nothing for a string with characters outside the alphabet. */
function base58Decode(text: string): Uint8Array {
  let value = 0n;
  for (const char of text) {
    const digit = ALPHABET.indexOf(char);
    if (digit < 0) return new Uint8Array(0);
    value = value * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (value > 0n) {
    bytes.unshift(Number(value % 256n));
    value /= 256n;
  }
  let zeros = 0;
  while (text[zeros] === '1') zeros += 1;
  return Uint8Array.from([...new Array<number>(zeros).fill(0), ...bytes]);
}

function checksum(payload: Uint8Array): Uint8Array {
  return sha256(sha256(payload)).slice(0, 4);
}

/**
 * Encodes a private key as WIF for a network; compressed matches dumpprivkey.
 *
 * Throws `invalid private key` for bytes that are not a valid secp256k1
 * private key.
 */
export function encodeWif(privateKey: Uint8Array, network: PearlNetwork, compressed = true): string {
  if (!ecc.isPrivate(privateKey)) {
    throw new PearlError('KEY_INVALID', 'invalid private key');
  }
  const payload = Uint8Array.from([network.wif, ...privateKey, ...(compressed ? [COMPRESS_MAGIC] : [])]);
  return base58Encode(Uint8Array.from([...payload, ...checksum(payload)]));
}

/**
 * Decodes a WIF with the checks of btcutil.DecodeWIF, then refuses a key for
 * another network, as importprivkey does. The private key is returned to the
 * caller, who owns it; pearljs keeps no copy.
 *
 * Throws with btcutil's message for a malformed WIF or a bad checksum, and `key
 * is not intended for <network>` for another network's key.
 */
export function decodeWif(wif: string, network: PearlNetwork): DecodedWif {
  if (typeof wif !== 'string') {
    throw new TypeError('WIF must be a string');
  }
  if (network === null || typeof network !== 'object' || typeof network.wif !== 'number') {
    throw new TypeError('a valid PearlNetwork is required');
  }
  // Checked before decoding, which is quadratic in the length.
  if (wif.length > MAX_WIF_LENGTH) {
    throw new PearlError('WIF_MALFORMED', 'malformed private key');
  }
  const decoded = base58Decode(wif);
  let compressed: boolean;
  if (decoded.length === 1 + 32 + 1 + 4) {
    if (decoded[33] !== COMPRESS_MAGIC) throw new PearlError('WIF_MALFORMED', 'malformed private key');
    compressed = true;
  } else if (decoded.length === 1 + 32 + 4) {
    compressed = false;
  } else {
    throw new PearlError('WIF_MALFORMED', 'malformed private key');
  }
  const payload = decoded.slice(0, decoded.length - 4);
  const expected = checksum(payload);
  if (!expected.every((byte, i) => byte === decoded[decoded.length - 4 + i])) {
    throw new PearlError('WIF_BAD_CHECKSUM', 'checksum mismatch');
  }
  const privateKey = decoded.slice(1, 33);
  if (!ecc.isPrivate(privateKey)) {
    throw new PearlError('WIF_MALFORMED', 'malformed private key');
  }
  if (decoded[0] !== network.wif) {
    throw new PearlError('WIF_WRONG_NETWORK', `key is not intended for ${network.name}`);
  }
  return { privateKey, compressed };
}

/**
 * The BIP86 key-path P2TR address of a private key: the address Oyster
 * assigns on importprivkey and the one signMessage signs for.
 */
export function keyPathAddress(privateKey: Uint8Array, network: PearlNetwork): string {
  const publicKey = ecc.isPrivate(privateKey) ? ecc.pointFromScalar(privateKey, true) : null;
  if (publicKey === null) {
    throw new PearlError('KEY_INVALID', 'invalid private key');
  }
  const { outputKey } = taprootOutputKey(publicKey.slice(1));
  return encodeAddress({ version: 1, program: outputKey }, network);
}
