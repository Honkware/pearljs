// Message signing in the three formats a Pearl key signs in.
//
// 'oyster' is Oyster's signmessage and verifymessage
// (wallet/rpc/jsonrpc/bip322.go), which pools ask for. Oyster calls it BIP-322
// but uses its own layout: the message goes into an OP_RETURN output of the
// to_sign transaction instead of a tagged hash in to_spend, both transactions
// are version 2, and sequences are 0xffffffff. Messages are limited to 80
// bytes, the OP_RETURN data limit.
//
// 'bip322' is BIP-322's simple variant as the BIP specifies it: version 0
// transactions, sequence 0, OP_0 PUSH32[tagged message hash] in to_spend and a
// bare OP_RETURN in to_sign. Generic BIP-322 tools sign and verify this one.
//
// 'legacy' is pearld's signmessagewithprivkey (node/rpcserver.go): an ECDSA
// compact signature over the double SHA-256 of "Pearl Signed Message:\n" and
// the message. It names no address; a verifier recovers the key and compares
// its BIP86 key-path address.
//
// Only P2TR addresses sign, through a BIP86 key-path spend.
//
// A message is signed as its UTF-8 bytes. A JS string with a lone surrogate
// has no UTF-8 form: TextEncoder writes U+FFFD in its place, and so does the
// JSON decoder in front of Oyster, so "a\ud800", "a\udfff" and "a\ufffd"
// would all carry one signature. Such strings are refused here instead, for
// signing and for verifying; a caller that wants Oyster's reading passes
// message.toWellFormed().

/**
 * Message signing and verification in Oyster's format, BIP-322's simple
 * variant and pearld's legacy compact format.
 *
 * @module
 */

import { Transaction } from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { decodeAddress } from './address.js';
import type { PearlNetwork } from './networks.js';
import { OP_CODES, scriptPush, taggedHash, TAPROOT_ANNEX_TAG } from './script.js';
import { assertTaprootSighashType } from './internal/sighash.js';
import { serializeWitness } from './transaction.js';
import { hash256 } from './crypto.js';
import { concat, equalBytes, fromBase64, varInt } from './internal/bytes.js';
import { PearlError, SigningError } from './errors.js';

/** txscript.MaxDataCarrierSize: the most message bytes Oyster can sign. */
export const MAX_MESSAGE_LENGTH = 80;

/** A message signature format: Oyster's, BIP-322 simple, or pearld's legacy compact one. */
export type MessageFormat = 'oyster' | 'bip322' | 'legacy';

/** Every MessageFormat, in the order messageSignatureFormat tries them. */
export const MESSAGE_FORMATS: readonly MessageFormat[] = ['oyster', 'bip322', 'legacy'];

/** The header pearld's signmessagewithprivkey hashes in front of a message. */
export const LEGACY_MESSAGE_HEADER = 'Pearl Signed Message:\n';

const BIP322_TAG = 'BIP0322-signed-message';
// The prefix the current BIP-322 text puts in front of a simple signature.
// Signatures without it are what deployed tools write, and both are read.
const BIP322_SIMPLE_PREFIX = 'smp';
// wire.MaxWitnessItemsPerInput and txscript.MaxScriptSize bound the parse.
const MAX_WITNESS_ITEMS = 1003;
const MAX_WITNESS_ITEM_SIZE = 10000;

function messageBytes(message: string, limit = true): Uint8Array {
  if (typeof message !== 'string') {
    throw new TypeError('message must be a string');
  }
  // With the u flag a surrogate only matches when it is not half of a pair.
  if (/\p{Surrogate}/u.test(message)) {
    throw new PearlError('MESSAGE_INVALID', 'message has a lone surrogate, which has no UTF-8 encoding');
  }
  const bytes = new TextEncoder().encode(message);
  if (limit && bytes.length > MAX_MESSAGE_LENGTH) {
    throw new PearlError('MESSAGE_INVALID', `message is ${bytes.length} bytes, more than the ${MAX_MESSAGE_LENGTH} Oyster can sign`);
  }
  return bytes;
}

/** BIP-322's tagged hash of a message's UTF-8 bytes. */
export function bip322MessageHash(message: string): Uint8Array {
  return taggedHash(BIP322_TAG, messageBytes(message, false));
}

/** The double SHA-256 pearld's signmessagewithprivkey signs for a message. */
export function legacyMessageHash(message: string): Uint8Array {
  const header = new TextEncoder().encode(LEGACY_MESSAGE_HEADER);
  const bytes = messageBytes(message, false);
  return hash256(concat([varInt(header.length), header, varInt(bytes.length), bytes]));
}

/** BIP-322's to_spend and unsigned to_sign for an output script and a message. */
export function bip322Transactions(
  scriptPubKey: Uint8Array,
  message: string,
): { toSpend: Transaction; toSign: Transaction } {
  const toSpend = new Transaction();
  toSpend.version = 0;
  toSpend.addInput(new Uint8Array(32), 0xffffffff, 0, Uint8Array.from([OP_CODES.OP_0, 32, ...bip322MessageHash(message)]));
  toSpend.addOutput(Uint8Array.from(scriptPubKey), 0n);
  const toSign = new Transaction();
  toSign.version = 0;
  toSign.addInput(toSpend.getHash(), 0, 0);
  toSign.addOutput(Uint8Array.from([OP_CODES.OP_RETURN]), 0n);
  return { toSpend, toSign };
}

/** The to_sign transaction for a P2TR output script and a message, in the given format. */
function toSignTransaction(scriptPubKey: Uint8Array, message: string, format: 'oyster' | 'bip322'): Transaction {
  if (format === 'bip322') return bip322Transactions(scriptPubKey, message).toSign;
  return oysterToSign(scriptPubKey, messageBytes(message));
}

function oysterToSign(scriptPubKey: Uint8Array, message: Uint8Array): Transaction {
  const toSpend = new Transaction();
  toSpend.version = 2;
  toSpend.addInput(new Uint8Array(32), 0xffffffff, 0xffffffff);
  toSpend.addOutput(scriptPubKey, 0n);
  const toSign = new Transaction();
  toSign.version = 2;
  toSign.addInput(toSpend.getHash(), 0, 0xffffffff);
  toSign.addOutput(Uint8Array.from([OP_CODES.OP_RETURN, ...scriptPush(message)]), 0n);
  return toSign;
}

/**
 * Parses a witness stack the way Oyster's ParseWitnessStack does. It ignores
 * any bytes after the last item, so rejecting them here would refuse
 * signatures Oyster accepts; and it reads lengths with wire.ReadVarInt, which
 * refuses a length written in more bytes than it needs.
 */
function parseWitness(bytes: Uint8Array): Uint8Array[] {
  let offset = 0;
  const readVarInt = (): number => {
    const first = bytes[offset];
    if (first === undefined) throw new PearlError('SIGNATURE_MALFORMED', 'signature ends early');
    offset += 1;
    if (first < 0xfd) return first;
    const width = first === 0xfd ? 2 : first === 0xfe ? 4 : 8;
    if (offset + width > bytes.length) throw new PearlError('SIGNATURE_MALFORMED', 'signature ends early');
    let value = 0;
    for (let i = width - 1; i >= 0; i -= 1) value = value * 256 + bytes[offset + i]!;
    offset += width;
    // An 8-byte value loses its low bits as a number, never enough to cross 2^32.
    if (value < (width === 2 ? 0xfd : width === 4 ? 0x10000 : 0x100000000)) {
      throw new PearlError('SIGNATURE_MALFORMED', 'signature has a non-canonical varint');
    }
    return value;
  };
  const count = readVarInt();
  if (count > MAX_WITNESS_ITEMS) {
    throw new PearlError('SIGNATURE_MALFORMED', `too many witness items: ${count}, max ${MAX_WITNESS_ITEMS}`);
  }
  const items: Uint8Array[] = [];
  for (let i = 0; i < count; i += 1) {
    const length = readVarInt();
    if (length > MAX_WITNESS_ITEM_SIZE || offset + length > bytes.length) {
      throw new PearlError('SIGNATURE_MALFORMED', `witness item ${i} is too large or ends early`);
    }
    items.push(Uint8Array.from(bytes.subarray(offset, offset + length)));
    offset += length;
  }
  return items;
}

function decodeBase64(text: string, lineBreaks = false): Uint8Array {
  if (typeof text !== 'string') {
    throw new TypeError('signature must be a base64 string');
  }
  // Oyster decodes with Go's base64.StdEncoding, which skips CR and LF
  // anywhere and refuses every other character outside the alphabet.
  if (lineBreaks) text = text.replace(/[\r\n]/g, '');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) {
    throw new PearlError('SIGNATURE_MALFORMED', 'signature is not valid base64');
  }
  return fromBase64(text);
}

/** Options for signMessage. */
export interface SignMessageOptions {
  /**
   * The 32 bytes of auxiliary randomness BIP340 mixes into the nonce. Fresh
   * random bytes are used when it is left out; pass a fixed value only to
   * get reproducible signatures in tests. Legacy signatures are
   * deterministic (RFC 6979) and do not use it.
   */
  auxRand?: Uint8Array;
  /** The format to sign in. Default 'oyster', the one Oyster's verifymessage and the pools that use it accept. */
  format?: MessageFormat;
}

/** Options for verifyMessage. */
export interface VerifyMessageOptions {
  /** The format the signature must be in, or 'any' for any of them. Default 'oyster'. */
  format?: MessageFormat | 'any';
  /**
   * Accept a key-path signature with any Taproot sighash type, as Oyster's
   * verifymessage does. Off by default: with SIGHASH_NONE an Oyster-format
   * signature commits to no output, so it verifies for every message.
   */
  anySighashType?: boolean;
}

// BIP340 recommends fresh auxiliary randomness for every signature, as a
// defence against fault and side-channel attacks on the nonce. Without it
// tiny-secp256k1 signs with 32 zero bytes.
function auxRandOf(options: SignMessageOptions): Uint8Array {
  if (options.auxRand === undefined) return crypto.getRandomValues(new Uint8Array(32));
  if (!(options.auxRand instanceof Uint8Array) || options.auxRand.length !== 32) {
    throw new Error('auxRand must be 32 bytes');
  }
  return options.auxRand;
}

function formatOf(format: unknown, allowAny: boolean): MessageFormat | 'any' {
  if (format === undefined) return 'oyster';
  if ((MESSAGE_FORMATS as readonly unknown[]).includes(format) || (allowAny && format === 'any')) {
    return format as MessageFormat | 'any';
  }
  throw new TypeError(`unknown message format: ${String(format)}`);
}

function publicKeyOf(privateKey: Uint8Array): Uint8Array {
  if (!(privateKey instanceof Uint8Array)) {
    throw new PearlError('KEY_INVALID', 'invalid private key');
  }
  const publicKey = ecc.isPrivate(privateKey) ? ecc.pointFromScalar(privateKey, true) : null;
  if (publicKey === null) {
    throw new PearlError('KEY_INVALID', 'invalid private key');
  }
  return publicKey;
}

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

/**
 * Signs a message for the BIP86 P2TR address of privateKey and returns the
 * base64 signature. The default format is Oyster's signmessage; `format`
 * picks BIP-322's simple variant or pearld's legacy compact signature.
 * Schnorr signatures differ from call to call unless auxRand is fixed; every
 * one verifies.
 *
 * Throws for an Oyster-format message over MAX_MESSAGE_LENGTH bytes of UTF-8,
 * a string with a lone surrogate, and an invalid private key.
 */
export function signMessage(privateKey: Uint8Array, message: string, options: SignMessageOptions = {}): string {
  const format = formatOf(options.format, false);
  messageBytes(message, format === 'oyster');
  const publicKey = publicKeyOf(privateKey);
  if (format === 'legacy') {
    const hash = legacyMessageHash(message);
    const { signature, recoveryId } = ecc.signRecoverable(hash, privateKey);
    // 27 plus the recovery id, plus 4 for a compressed key, as ecdsa.SignCompact writes it.
    return toBase64(Uint8Array.from([27 + 4 + recoveryId, ...signature]));
  }
  const internalKey = publicKey.slice(1);
  const tweak = taggedHash('TapTweak', internalKey);
  const evenKey = publicKey[0] === 0x03 ? ecc.privateNegate(privateKey) : privateKey;
  const tweakedKey = ecc.privateAdd(evenKey, tweak);
  const outputKey = ecc.xOnlyPointAddTweak(internalKey, tweak);
  if (tweakedKey === null || outputKey === null) {
    throw new PearlError('KEY_INVALID', 'taproot tweak produced an invalid key');
  }
  const scriptPubKey = Uint8Array.from([OP_CODES.OP_1, 32, ...outputKey.xOnlyPubkey]);
  const hash = toSignTransaction(scriptPubKey, message, format as 'oyster' | 'bip322').hashForWitnessV1(
    0,
    [scriptPubKey],
    [0n],
    Transaction.SIGHASH_DEFAULT,
  );
  let signature: Uint8Array;
  try {
    signature = ecc.signSchnorr(hash, tweakedKey, auxRandOf(options));
  } finally {
    // The derived keys are this function's own copies; privateKey is the caller's.
    tweakedKey.fill(0);
    if (evenKey !== privateKey) evenKey.fill(0);
  }
  if (!ecc.verifySchnorr(hash, outputKey.xOnlyPubkey, signature)) {
    throw new SigningError('SIGNATURE_INVALID', 'message signature failed verification');
  }
  return toBase64(serializeWitness([signature]));
}

function verifyWitness(program: Uint8Array, signature: string, message: string, format: 'oyster' | 'bip322', anySighashType: boolean): boolean {
  let witness: Uint8Array[];
  try {
    messageBytes(message, format === 'oyster');
    const text = format === 'bip322' && signature.startsWith(BIP322_SIMPLE_PREFIX) ? signature.slice(3) : signature;
    witness = parseWitness(decodeBase64(text, format === 'oyster'));
  } catch (err) {
    if (err instanceof PearlError) return false;
    throw err;
  }
  let stack = witness;
  let annex: Uint8Array | undefined;
  const last = witness[witness.length - 1];
  if (witness.length >= 2 && last !== undefined && last[0] === TAPROOT_ANNEX_TAG) {
    annex = last;
    stack = witness.slice(0, -1);
  }
  if (stack.length !== 1) return false;
  const sig = stack[0]!;
  let hashType = Transaction.SIGHASH_DEFAULT;
  if (sig.length === 65) {
    hashType = sig[64]!;
    if (hashType === Transaction.SIGHASH_DEFAULT) return false;
    if (!anySighashType && hashType !== Transaction.SIGHASH_ALL) return false;
    try {
      assertTaprootSighashType(hashType);
    } catch {
      return false;
    }
  } else if (sig.length !== 64) {
    return false;
  }
  const scriptPubKey = Uint8Array.from([OP_CODES.OP_1, 32, ...program]);
  const hash = toSignTransaction(scriptPubKey, message, format).hashForWitnessV1(0, [scriptPubKey], [0n], hashType, undefined, annex);
  if (!ecc.isXOnlyPoint(program)) return false;
  return ecc.verifySchnorr(hash, program, sig.subarray(0, 64));
}

// Mirrors ecdsa.RecoverCompact: a 65-byte signature whose first byte is 27
// to 34, the recovery id in its low two bits and 4 added for a compressed key.
// The key is compared by its BIP86 key-path output key, which does not
// depend on how the key was serialized.
function verifyLegacy(program: Uint8Array, signature: string, message: string): boolean {
  let bytes: Uint8Array;
  let hash: Uint8Array;
  try {
    bytes = decodeBase64(signature);
    hash = legacyMessageHash(message);
  } catch (err) {
    if (err instanceof PearlError) return false;
    throw err;
  }
  if (bytes.length !== 65 || bytes[0]! < 27 || bytes[0]! > 34) return false;
  const recoveryId = (bytes[0]! - 27) & 3;
  let publicKey: Uint8Array | null;
  try {
    publicKey = ecc.recover(hash, bytes.subarray(1), recoveryId as 0 | 1 | 2 | 3, true);
  } catch {
    return false;
  }
  if (publicKey === null) return false;
  const internalKey = publicKey.subarray(1);
  const outputKey = ecc.xOnlyPointAddTweak(internalKey, taggedHash('TapTweak', internalKey));
  return outputKey !== null && equalBytes(outputKey.xOnlyPubkey, program);
}

/**
 * Verifies a message signature against a P2TR address. The default format is
 * Oyster's, as its verifymessage checks key-path signatures; `format` picks
 * another, or 'any' accepts a signature valid in any of them.
 *
 * The rule: the answer is false for anything that is not a valid signature
 * of that message for that address on that network in the format asked for,
 * whatever the reason. That covers an address that does not decode, is for
 * another network or is P2MR, a signature that is not base64 or not a
 * witness stack, a message that could not have been signed (an Oyster
 * message over 80 bytes, a lone surrogate), an address whose program is not
 * a point on the curve, a script-path signature, which Oyster's script
 * engine could accept and pearljs does not evaluate, and a signature with a
 * sighash type other than SIGHASH_DEFAULT or SIGHASH_ALL unless
 * `anySighashType` is set. It throws only for a
 * mistake in the calling code: a TypeError when address, signature or
 * message is not a string, network is not a PearlNetwork, or the format is
 * unknown.
 */
export function verifyMessage(
  address: string,
  signature: string,
  message: string,
  network: PearlNetwork,
  options: VerifyMessageOptions = {},
): boolean {
  const format = formatOf(options.format, true);
  const anySighashType = options.anySighashType === true;
  if (format === 'any') return MESSAGE_FORMATS.some((each) => verifyIn(each, address, signature, message, network, anySighashType));
  return verifyIn(format, address, signature, message, network, anySighashType);
}

function verifyIn(format: MessageFormat, address: string, signature: string, message: string, network: PearlNetwork, anySighashType = false): boolean {
  if (typeof address !== 'string') throw new TypeError('address must be a string');
  if (typeof signature !== 'string') throw new TypeError('signature must be a base64 string');
  if (typeof message !== 'string') throw new TypeError('message must be a string');
  if (network === null || typeof network !== 'object' || typeof network.bech32Hrp !== 'string') {
    throw new TypeError('a valid PearlNetwork is required');
  }
  let program: Uint8Array;
  try {
    const decoded = decodeAddress(address, network);
    if (decoded.version !== 1) return false;
    program = decoded.program;
  } catch (err) {
    if (err instanceof PearlError) return false;
    throw err;
  }
  return format === 'legacy' ? verifyLegacy(program, signature, message) : verifyWitness(program, signature, message, format, anySighashType);
}

/**
 * The format in which signature is a valid signature of message for the P2TR
 * address, or undefined when it is valid in none. No signature is valid in
 * two formats: each signs a different hash.
 */
export function messageSignatureFormat(
  address: string,
  signature: string,
  message: string,
  network: PearlNetwork,
): MessageFormat | undefined {
  return MESSAGE_FORMATS.find((format) => verifyIn(format, address, signature, message, network));
}
