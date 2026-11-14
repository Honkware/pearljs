// Message signing compatible with Pearl's wallet (Oyster's signmessage and
// verifymessage, wallet/rpc/jsonrpc/bip322.go).
//
// Oyster calls this BIP-322 but uses its own layout: the message goes into an
// OP_RETURN output of the to_sign transaction instead of a tagged hash in
// to_spend, both transactions are version 2, and sequences are 0xffffffff.
// Signatures are therefore not interchangeable with standard BIP-322 tools.
// Messages are limited to 80 bytes (the OP_RETURN data limit) and only P2TR
// addresses sign, through a BIP86 key-path spend.

import { Transaction } from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { decodeAddress } from './address.js';
import type { PearlNetwork } from './networks.js';
import { OP_CODES, scriptPush, taggedHash } from './script.js';
import { assertTaprootSighashType } from './scriptpath.js';
import { serializeWitness } from './transaction.js';

/** txscript.MaxDataCarrierSize: the most message bytes Oyster can sign. */
export const MAX_MESSAGE_LENGTH = 80;
// wire.MaxWitnessItemsPerInput and txscript.MaxScriptSize bound the parse.
const MAX_WITNESS_ITEMS = 1003;
const MAX_WITNESS_ITEM_SIZE = 10000;
const TAPROOT_ANNEX_TAG = 0x50;

function messageBytes(message: string): Uint8Array {
  const bytes = new TextEncoder().encode(message);
  if (bytes.length > MAX_MESSAGE_LENGTH) {
    throw new Error(`message is ${bytes.length} bytes, more than the ${MAX_MESSAGE_LENGTH} Oyster can sign`);
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
 * Parses a witness stack the way Oyster's ParseWitnessStack does, which
 * ignores any bytes after the last item; rejecting them here would refuse
 * signatures Oyster accepts.
 */
function parseWitness(bytes: Uint8Array): Uint8Array[] {
  let offset = 0;
  const readVarInt = (): number => {
    const first = bytes[offset];
    if (first === undefined) throw new Error('signature ends early');
    offset += 1;
    if (first < 0xfd) return first;
    const width = first === 0xfd ? 2 : first === 0xfe ? 4 : 8;
    if (offset + width > bytes.length) throw new Error('signature ends early');
    let value = 0;
    for (let i = width - 1; i >= 0; i -= 1) value = value * 256 + bytes[offset + i]!;
    offset += width;
    return value;
  };
  const count = readVarInt();
  if (count > MAX_WITNESS_ITEMS) {
    throw new Error(`too many witness items: ${count}, max ${MAX_WITNESS_ITEMS}`);
  }
  const items: Uint8Array[] = [];
  for (let i = 0; i < count; i += 1) {
    const length = readVarInt();
    if (length > MAX_WITNESS_ITEM_SIZE || offset + length > bytes.length) {
      throw new Error(`witness item ${i} is too large or ends early`);
    }
    items.push(bytes.slice(offset, offset + length));
    offset += length;
  }
  return items;
}

function decodeBase64(text: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) {
    throw new Error('signature is not valid base64');
  }
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}

/**
 * Signs a message for the BIP86 P2TR address of privateKey, as Oyster's
 * signmessage does, and returns the base64 signature.
 */
export function signMessage(privateKey: Uint8Array, message: string): string {
  const bytes = messageBytes(message);
  const publicKey = ecc.isPrivate(privateKey) ? ecc.pointFromScalar(privateKey, true) : null;
  if (publicKey === null) {
    throw new Error('invalid private key');
  }
  const internalKey = publicKey.slice(1);
  const tweak = taggedHash('TapTweak', internalKey);
  const evenKey = publicKey[0] === 0x03 ? ecc.privateNegate(privateKey) : privateKey;
  const tweakedKey = ecc.privateAdd(evenKey, tweak);
  const outputKey = ecc.xOnlyPointAddTweak(internalKey, tweak);
  if (tweakedKey === null || outputKey === null) {
    throw new Error('taproot tweak produced an invalid key');
  }
  const scriptPubKey = Uint8Array.from([OP_CODES.OP_1, 32, ...outputKey.xOnlyPubkey]);
  const hash = toSignTransaction(scriptPubKey, bytes).hashForWitnessV1(
    0,
    [scriptPubKey],
    [0n],
    Transaction.SIGHASH_DEFAULT,
  );
  const signature = ecc.signSchnorr(hash, tweakedKey);
  return btoa(String.fromCharCode(...serializeWitness([signature])));
}

/**
 * Verifies a message signature against a P2TR address, as Oyster's
 * verifymessage does for key-path signatures. Script-path signatures, which
 * Oyster's full script engine could accept, are reported as unsupported
 * instead of invalid.
 */
export function verifyMessage(
  address: string,
  signature: string,
  message: string,
  network: PearlNetwork,
): boolean {
  const { version, program } = decodeAddress(address, network);
  if (version !== 1) {
    throw new Error('only Taproot addresses are supported for message verification');
  }
  const bytes = messageBytes(message);
  const witness = parseWitness(decodeBase64(signature));
  let stack = witness;
  let annex: Uint8Array | undefined;
  const last = witness[witness.length - 1];
  if (witness.length >= 2 && last !== undefined && last[0] === TAPROOT_ANNEX_TAG) {
    annex = last;
    stack = witness.slice(0, -1);
  }
  if (stack.length === 0) return false;
  if (stack.length > 1) {
    throw new Error('script-path message signatures are not supported');
  }
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
  return ecc.verifySchnorr(hash, program, sig.slice(0, 64));
}
