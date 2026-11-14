// BIP39 helpers that read seeds the way Pearl's wallet does. Pure JS with no
// Buffer or secp256k1 dependency, so this module is safe in any browser.

/**
 * BIP39 recovery phrases and seeds, read the way Pearl's wallet reads them.
 *
 * @module
 */

import {
  entropyToMnemonic as scureEntropyToMnemonic,
  generateMnemonic as scureGenerateMnemonic,
  mnemonicToEntropy as scureMnemonicToEntropy,
  mnemonicToSeedSync,
  validateMnemonic as scureValidateMnemonic,
} from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';

/** Word counts BIP39 allows, for 128 to 256 bits of entropy. */
export const MNEMONIC_WORD_COUNTS = [12, 15, 18, 21, 24] as const;
/** A word count generateMnemonic accepts: 12, 15, 18, 21 or 24. */
export type MnemonicWordCount = (typeof MNEMONIC_WORD_COUNTS)[number];

/** Seed lengths Pearl's wallet accepts as raw hex (hdkeychain Min/MaxSeedBytes). */
export const MIN_HEX_SEED_BYTES = 16;
/** The longest raw hex seed Pearl's wallet accepts, in bytes. */
export const MAX_HEX_SEED_BYTES = 64;

/** Trim, lowercase and collapse whitespace runs, as the desktop wallet does before validating. */
export function normalizeMnemonic(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** True when the phrase is a valid English BIP39 mnemonic after normalization. */
export function validateMnemonic(mnemonic: string): boolean {
  return scureValidateMnemonic(normalizeMnemonic(mnemonic), wordlist);
}

/**
 * Generate a new English mnemonic from the platform's random source. Pearl's
 * wallet makes 12 words (128 bits), which is the default.
 */
export function generateMnemonic(wordCount: MnemonicWordCount = 12): string {
  if (!MNEMONIC_WORD_COUNTS.includes(wordCount)) {
    throw new RangeError('mnemonic word count must be 12, 15, 18, 21 or 24');
  }
  return scureGenerateMnemonic(wordlist, (wordCount / 3) * 32);
}

/** Encode 16 to 32 bytes of entropy (a multiple of 4) as a mnemonic. */
export function entropyToMnemonic(entropy: Uint8Array): string {
  if (entropy.length < 16 || entropy.length > 32 || entropy.length % 4 !== 0) {
    throw new RangeError('entropy must be 16 to 32 bytes in steps of 4');
  }
  return scureEntropyToMnemonic(entropy, wordlist);
}

/** Recover the entropy of a valid mnemonic. */
export function mnemonicToEntropy(mnemonic: string): Uint8Array {
  const phrase = normalizeMnemonic(mnemonic);
  if (!scureValidateMnemonic(phrase, wordlist)) {
    throw new Error('invalid BIP39 mnemonic');
  }
  return scureMnemonicToEntropy(phrase, wordlist);
}

/**
 * Validate a BIP39 mnemonic and convert it to a 64-byte seed. The phrase is
 * normalized first, so the seed is the one Pearl's wallet derives from the same
 * words however they were pasted. The passphrase is used as given and is empty
 * by default, as in Pearl's wallet.
 *
 * Throws if a word is not in the English wordlist or the checksum is invalid.
 */
export function mnemonicToSeed(mnemonic: string, passphrase = ''): Uint8Array {
  const phrase = normalizeMnemonic(mnemonic);
  if (!scureValidateMnemonic(phrase, wordlist)) {
    throw new Error('invalid BIP39 mnemonic');
  }
  return mnemonicToSeedSync(phrase, passphrase);
}

/**
 * What parseSeedInput made of its input: a seed from a mnemonic, a raw hex seed,
 * or the reason it is neither.
 */
export type ParsedSeedInput =
  | { kind: 'mnemonic'; seed: Uint8Array; wordCount: number }
  | { kind: 'hex'; seed: Uint8Array }
  | { kind: 'invalid'; reason: string };

/**
 * Read user input the way Pearl's wallet reads an existing seed: a BIP39
 * mnemonic, or failing that a 16 to 64 byte hex seed (an optional 0x prefix is
 * dropped). A hex seed is used as is and ignores the passphrase.
 */
export function parseSeedInput(raw: string, passphrase = ''): ParsedSeedInput {
  const text = normalizeMnemonic(raw);
  if (text === '') {
    return { kind: 'invalid', reason: 'seed is empty' };
  }
  if (scureValidateMnemonic(text, wordlist)) {
    return {
      kind: 'mnemonic',
      seed: mnemonicToSeedSync(text, passphrase),
      wordCount: text.split(' ').length,
    };
  }
  const hex = text.replace(/^0x/, '');
  if (/^[0-9a-f]+$/.test(hex)) {
    if (hex.length % 2 !== 0) {
      return { kind: 'invalid', reason: 'hex seed must have an even number of characters' };
    }
    const length = hex.length / 2;
    if (length < MIN_HEX_SEED_BYTES || length > MAX_HEX_SEED_BYTES) {
      return {
        kind: 'invalid',
        reason: `hex seed must be ${MIN_HEX_SEED_BYTES} to ${MAX_HEX_SEED_BYTES} bytes`,
      };
    }
    const seed = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      seed[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return { kind: 'hex', seed };
  }
  if (/\s/.test(text)) {
    const words = text.split(' ');
    const unknown = words.find((w) => !wordlist.includes(w));
    if (unknown !== undefined) {
      return { kind: 'invalid', reason: `"${unknown}" is not a BIP39 word` };
    }
    if (!(MNEMONIC_WORD_COUNTS as readonly number[]).includes(words.length)) {
      return {
        kind: 'invalid',
        reason: `mnemonic must be 12, 15, 18, 21 or 24 words, got ${words.length}`,
      };
    }
    return { kind: 'invalid', reason: 'mnemonic checksum is invalid' };
  }
  return { kind: 'invalid', reason: 'enter a BIP39 mnemonic or a hex seed' };
}

/** Like parseSeedInput but returns the seed and throws on invalid input. */
export function seedFromInput(raw: string, passphrase = ''): Uint8Array {
  const parsed = parseSeedInput(raw, passphrase);
  if (parsed.kind === 'invalid') {
    throw new Error(`invalid seed: ${parsed.reason}`);
  }
  return parsed.seed;
}
