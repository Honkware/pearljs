// bitcoinjs keeps the curve library it was given in module state, and its
// Taproot code (p2tr, and the PSBT signing and validation that tweak a key)
// throws without one. pearljs is marked side-effect free, so a bundler may
// drop a module-level initEccLib call along with a module nobody imports
// from. Each function that reaches that code calls ensureEcc instead.

import { initEccLib } from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';

/** Gives bitcoinjs its curve library. The first call verifies it; later ones return at once. */
export function ensureEcc(): void {
  initEccLib(ecc);
}
