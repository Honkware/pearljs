// Pearl uses hash256 for txids, block hashes and checksums, and hash160 for
// BIP32 key fingerprints.

/**
 * SHA-256, double SHA-256 and HASH160.
 *
 * @module
 */

import { ripemd160 } from '@noble/hashes/legacy';
import { sha256 as nobleSha256 } from '@noble/hashes/sha2';

export function sha256(data: Uint8Array): Uint8Array {
  return nobleSha256(data);
}

/** Double SHA-256, chainhash.DoubleHashB. */
export function hash256(data: Uint8Array): Uint8Array {
  return nobleSha256(nobleSha256(data));
}

/** RIPEMD-160 of SHA-256, btcutil.Hash160. */
export function hash160(data: Uint8Array): Uint8Array {
  return ripemd160(nobleSha256(data));
}
