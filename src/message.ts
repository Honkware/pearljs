// Message signing compatible with Pearl's wallet (Oyster's signmessage and
// verifymessage, wallet/rpc/jsonrpc/bip322.go).
//
// Oyster calls this BIP-322 but uses its own layout: the message goes into an
// OP_RETURN output of the to_sign transaction instead of a tagged hash in
// to_spend, both transactions are version 2, and sequences are 0xffffffff.
// Signatures are therefore not interchangeable with standard BIP-322 tools.
// Messages are limited to 80 bytes (the OP_RETURN data limit) and only P2TR
// addresses sign, through a BIP86 key-path spend.
//
// A message is signed as its UTF-8 bytes. A JS string with a lone surrogate
// has no UTF-8 form: TextEncoder writes U+FFFD in its place, and so does the
// JSON decoder in front of Oyster, so "a\ud800", "a\udfff" and "a\ufffd"
// would all carry one signature. Such strings are refused here instead, for
// signing and for verifying; a caller that wants Oyster's reading passes
// message.toWellFormed().

/**
 * Message signing and verification in the format of Pearl's wallet (Oyster's
 * signmessage and verifymessage).
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
import { fromBase64 } from './internal/bytes.js';
import { PearlError, SigningError } from './errors.js';

/** txscript.MaxDataCarrierSize: the most message bytes Oyster can sign. */
export const MAX_MESSAGE_LENGTH = 80;
// wire.MaxWitnessItemsPerInput and txscript.MaxScriptSize bound the parse.
const MAX_WITNESS_ITEMS = 1003;
const MAX_WITNESS_ITEM_SIZE = 10000;

function messageBytes(message: string): Uint8Array {
  if (typeof message !== 'string') {
    throw new TypeError('message must be a string');
  }
  // With the u flag a surrogate only matches when it is not half of a pair.
  if (/\p{Surrogate}/u.test(message)) {
    throw new PearlError('MESSAGE_INVALID', 'message has a lone surrogate, which has no UTF-8 encoding');
  }
  const bytes = new TextEncoder().encode(message);
  if (bytes.length > MAX_MESSAGE_LENGTH) {
    throw new PearlError('MESSAGE_INVALID', `message is ${bytes.length} bytes, more than the ${MAX_MESSAGE_LENGTH} Oyster can sign`);
  }
  return bytes;
}

/** The to_sign transaction for a P2TR output script and a message. */
function toSignTransaction(scriptPubKey: Uint8Array, message: Uint8Array): Transaction {
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

function decodeBase64(text: string): Uint8Array {
  if (typeof text !== 'string') {
    throw new TypeError('signature must be a base64 string');
  }
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
   * get reproducible signatures in tests.
   */
  auxRand?: Uint8Array;
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

/**
 * Signs a message for the BIP86 P2TR address of privateKey, as Oyster's
 * signmessage does, and returns the base64 signature. Signatures differ from
 * call to call unless auxRand is fixed; every one verifies.
 *
 * Throws for a message over MAX_MESSAGE_LENGTH bytes of UTF-8, a string with a
 * lone surrogate, and an invalid private key.
 */
export function signMessage(privateKey: Uint8Array, message: string, options: SignMessageOptions = {}): string {
  const bytes = messageBytes(message);
  if (!(privateKey instanceof Uint8Array)) {
    throw new PearlError('KEY_INVALID', 'invalid private key');
  }
  const publicKey = ecc.isPrivate(privateKey) ? ecc.pointFromScalar(privateKey, true) : null;
  if (publicKey === null) {
    throw new PearlError('KEY_INVALID', 'invalid private key');
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
  const hash = toSignTransaction(scriptPubKey, bytes).hashForWitnessV1(
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
  return btoa(String.fromCharCode(...serializeWitness([signature])));
}

/**
 * Verifies a message signature against a P2TR address, as Oyster's
 * verifymessage does for key-path signatures.
 *
 * The rule: the answer is false for anything that is not a valid key-path
 * signature of that message for that address on that network, whatever the
 * reason. That covers an address that does not decode, is for another network
 * or is P2MR, a signature that is not base64 or not a witness stack, a message
 * that could not have been signed (over 80 bytes, a lone surrogate), an
 * address whose program is not a point on the curve, and a script-path
 * signature, which Oyster's script engine could accept and pearljs does not
 * evaluate. It throws only for a mistake in the calling code: a TypeError
 * when address, signature or message is not a string, or network is not a
 * PearlNetwork.
 */
export function verifyMessage(
  address: string,
  signature: string,
  message: string,
  network: PearlNetwork,
): boolean {
  if (typeof address !== 'string') throw new TypeError('address must be a string');
  if (network === null || typeof network !== 'object' || typeof network.bech32Hrp !== 'string') {
    throw new TypeError('a valid PearlNetwork is required');
  }
  let program: Uint8Array;
  let bytes: Uint8Array;
  let witness: Uint8Array[];
  try {
    const decoded = decodeAddress(address, network);
    if (decoded.version !== 1) return false;
    program = decoded.program;
    bytes = messageBytes(message);
    witness = parseWitness(decodeBase64(signature));
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
    try {
      assertTaprootSighashType(hashType);
    } catch {
      return false;
    }
  } else if (sig.length !== 64) {
    return false;
  }
  const scriptPubKey = Uint8Array.from([OP_CODES.OP_1, 32, ...program]);
  const hash = toSignTransaction(scriptPubKey, bytes).hashForWitnessV1(0, [scriptPubKey], [0n], hashType, undefined, annex);
  if (!ecc.isXOnlyPoint(program)) return false;
  return ecc.verifySchnorr(hash, program, sig.subarray(0, 64));
}
