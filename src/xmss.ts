// XMSS signatures with Pearl's parameters, ported from the xmss-reference
// code that Pearl builds (xmss/external): SHAKE256 with n = 32, Winternitz
// w = 16, a single tree of height 5. Keys come from a 64-byte private seed and
// a 32-byte public seed, and signing is deterministic, so signatures match
// Pearl's byte for byte.
//
// XMSS is stateful: each index signs one message, ever. Reusing an index
// for a different message lets anyone forge signatures under the key.
// Pearl's library also returns an unverifiable signature at index 31 while
// reporting success, because the reference code wipes the key before using
// its last leaf; xmssSign refuses that index, leaving 31 signatures per key
// (XMSS_MAX_SIGNATURES), at indices 0 to 30 (XMSS_LAST_INDEX).

/**
 * XMSS signatures with Pearl's parameters: keys, signing, verification, and
 * signers that take one-time indices from a store.
 *
 * @module
 */

import { shake256 } from '@noble/hashes/sha3';
import { concat, equalBytes, toHex } from './internal/bytes.js';
import { SigningError, XmssError } from './errors.js';

/** Bytes in the private seed an XMSS key is generated from. */
export const XMSS_PRIVATE_SEED_LENGTH = 64;
/** Bytes in the public seed an XMSS key is generated from. */
export const XMSS_PUBLIC_SEED_LENGTH = 32;
/** Bytes in an XMSS public key: the 32-byte root, then the public seed. */
export const XMSS_PUBLIC_KEY_LENGTH = 64;
/** Bytes in an XMSS secret key as pearljs holds it, without an index. */
export const XMSS_SECRET_KEY_LENGTH = 128;
/** Bytes in a message XMSS signs: a 32-byte sighash. */
export const XMSS_MESSAGE_LENGTH = 32;
/** Bytes in an XMSS signature. The first four are its index, big-endian. */
export const XMSS_SIGNATURE_LENGTH = 2340;
/** Signatures one key can make: one for each index from 0 to XMSS_LAST_INDEX. */
export const XMSS_MAX_SIGNATURES = 31;
/**
 * The highest index that signs. The tree has a leaf for index 31 too, but
 * Pearl's library returns a signature that does not verify there; see the
 * note at the top.
 */
export const XMSS_LAST_INDEX = XMSS_MAX_SIGNATURES - 1;

const N = 32;
const PADDING_LEN = 32;
const WOTS_W = 16;
const WOTS_LOG_W = 4;
const WOTS_LEN1 = 64;
const WOTS_LEN2 = 3;
const WOTS_LEN = WOTS_LEN1 + WOTS_LEN2;
const TREE_HEIGHT = 5;
const INDEX_BYTES = 4;

const PADDING_F = 0;
const PADDING_H = 1;
const PADDING_HASH = 2;
const PADDING_PRF = 3;
const PADDING_PRF_KEYGEN = 4;

const ADDR_TYPE_OTS = 0;
const ADDR_TYPE_LTREE = 1;
const ADDR_TYPE_HASHTREE = 2;

/** An XMSS key pair. */
export interface XmssKeyPair {
  /** root || public seed */
  publicKey: Uint8Array;
  /** sk seed || sk prf || root || public seed, without the index Pearl's library prepends */
  secretKey: Uint8Array;
}

// Addresses are eight 32-bit words, mutated in place as in the C code: the
// last value written to a word carries into the next hash that uses it.
type Address = Uint32Array;

function newAddress(type: number): Address {
  const addr = new Uint32Array(8);
  addr[3] = type;
  return addr;
}

function setTreeAddr(addr: Address, tree: number): void {
  addr[1] = Math.floor(tree / 2 ** 32);
  addr[2] = tree >>> 0;
}

/** Big-endian encoding of a non-negative integer into length bytes (ull_to_bytes). */
function toBytes(value: number, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let rest = value;
  for (let i = length - 1; i >= 0 && rest > 0; i -= 1) {
    out[i] = rest % 256;
    rest = Math.floor(rest / 256);
  }
  return out;
}

function addrToBytes(addr: Address): Uint8Array {
  const out = new Uint8Array(32);
  const view = new DataView(out.buffer);
  addr.forEach((word, i) => view.setUint32(i * 4, word, false));
  return out;
}

function coreHash(data: Uint8Array): Uint8Array {
  return shake256(data, { dkLen: N });
}

function prf(key: Uint8Array, input: Uint8Array): Uint8Array {
  return coreHash(concat([toBytes(PADDING_PRF, PADDING_LEN), key, input]));
}

function prfKeygen(key: Uint8Array, input: Uint8Array): Uint8Array {
  return coreHash(concat([toBytes(PADDING_PRF_KEYGEN, PADDING_LEN), key, input]));
}

function hashMessage(r: Uint8Array, root: Uint8Array, idx: number, message: Uint8Array): Uint8Array {
  return coreHash(concat([toBytes(PADDING_HASH, PADDING_LEN), r, root, toBytes(idx, N), message]));
}

function xor(a: Uint8Array, b: Uint8Array): Uint8Array {
  return a.map((byte, i) => byte ^ b[i]!);
}

function thashF(input: Uint8Array, pubSeed: Uint8Array, addr: Address): Uint8Array {
  addr[7] = 0;
  const key = prf(pubSeed, addrToBytes(addr));
  addr[7] = 1;
  const mask = prf(pubSeed, addrToBytes(addr));
  return coreHash(concat([toBytes(PADDING_F, PADDING_LEN), key, xor(input, mask)]));
}

function thashH(input: Uint8Array, pubSeed: Uint8Array, addr: Address): Uint8Array {
  addr[7] = 0;
  const key = prf(pubSeed, addrToBytes(addr));
  addr[7] = 1;
  const mask0 = prf(pubSeed, addrToBytes(addr));
  addr[7] = 2;
  const mask1 = prf(pubSeed, addrToBytes(addr));
  return coreHash(concat([toBytes(PADDING_H, PADDING_LEN), key, xor(input, concat([mask0, mask1]))]));
}

function expandSeed(skSeed: Uint8Array, pubSeed: Uint8Array, addr: Address): Uint8Array[] {
  addr[6] = 0;
  addr[7] = 0;
  const out: Uint8Array[] = [];
  for (let i = 0; i < WOTS_LEN; i += 1) {
    addr[5] = i;
    out.push(prfKeygen(skSeed, concat([pubSeed, addrToBytes(addr)])));
  }
  return out;
}

function genChain(
  input: Uint8Array,
  start: number,
  steps: number,
  pubSeed: Uint8Array,
  addr: Address,
): Uint8Array {
  let out = input;
  for (let i = start; i < start + steps && i < WOTS_W; i += 1) {
    addr[6] = i;
    out = thashF(out, pubSeed, addr);
  }
  return out;
}

function baseW(input: Uint8Array, outLen: number): number[] {
  const out: number[] = [];
  let inIndex = 0;
  let total = 0;
  let bits = 0;
  for (let consumed = 0; consumed < outLen; consumed += 1) {
    if (bits === 0) {
      total = input[inIndex]!;
      inIndex += 1;
      bits += 8;
    }
    bits -= WOTS_LOG_W;
    out.push((total >> bits) & (WOTS_W - 1));
  }
  return out;
}

function chainLengths(message: Uint8Array): number[] {
  const lengths = baseW(message, WOTS_LEN1);
  let csum = 0;
  for (const length of lengths) csum += WOTS_W - 1 - length;
  csum <<= 8 - ((WOTS_LEN2 * WOTS_LOG_W) % 8);
  const csumBytes = toBytes(csum, Math.ceil((WOTS_LEN2 * WOTS_LOG_W) / 8));
  return [...lengths, ...baseW(csumBytes, WOTS_LEN2)];
}

function wotsPkgen(skSeed: Uint8Array, pubSeed: Uint8Array, addr: Address): Uint8Array[] {
  const chains = expandSeed(skSeed, pubSeed, addr);
  return chains.map((chain, i) => {
    addr[5] = i;
    return genChain(chain, 0, WOTS_W - 1, pubSeed, addr);
  });
}

function wotsSign(message: Uint8Array, skSeed: Uint8Array, pubSeed: Uint8Array, addr: Address): Uint8Array[] {
  const lengths = chainLengths(message);
  const chains = expandSeed(skSeed, pubSeed, addr);
  return chains.map((chain, i) => {
    addr[5] = i;
    return genChain(chain, 0, lengths[i]!, pubSeed, addr);
  });
}

function wotsPkFromSig(
  signature: Uint8Array[],
  message: Uint8Array,
  pubSeed: Uint8Array,
  addr: Address,
): Uint8Array[] {
  const lengths = chainLengths(message);
  return signature.map((chain, i) => {
    addr[5] = i;
    return genChain(chain, lengths[i]!, WOTS_W - 1 - lengths[i]!, pubSeed, addr);
  });
}

function lTree(wotsPk: Uint8Array[], pubSeed: Uint8Array, addr: Address): Uint8Array {
  const nodes = [...wotsPk];
  let l = WOTS_LEN;
  let height = 0;
  addr[5] = height;
  while (l > 1) {
    const parents = l >> 1;
    for (let i = 0; i < parents; i += 1) {
      addr[6] = i;
      nodes[i] = thashH(concat([nodes[2 * i]!, nodes[2 * i + 1]!]), pubSeed, addr);
    }
    if (l & 1) {
      nodes[l >> 1] = nodes[l - 1]!;
      l = (l >> 1) + 1;
    } else {
      l >>= 1;
    }
    height += 1;
    addr[5] = height;
  }
  return nodes[0]!;
}

function genLeaf(skSeed: Uint8Array, pubSeed: Uint8Array, ltreeAddr: Address, otsAddr: Address): Uint8Array {
  return lTree(wotsPkgen(skSeed, pubSeed, otsAddr), pubSeed, ltreeAddr);
}

/**
 * Every node of the tree, levels[0] being the 32 leaves and levels[5] the
 * root. Node addresses follow treehash in the reference code: a parent at
 * level L and index j hashes with tree height L - 1 and tree index j. Keeping
 * the levels lets a signer read authentication paths instead of rebuilding
 * the tree, which is almost all of the work in a signature.
 */
function buildTree(skSeed: Uint8Array, pubSeed: Uint8Array): Uint8Array[][] {
  const otsAddr = newAddress(ADDR_TYPE_OTS);
  const ltreeAddr = newAddress(ADDR_TYPE_LTREE);
  const nodeAddr = newAddress(ADDR_TYPE_HASHTREE);
  const leaves: Uint8Array[] = [];
  for (let idx = 0; idx < 1 << TREE_HEIGHT; idx += 1) {
    ltreeAddr[4] = idx;
    otsAddr[4] = idx;
    leaves.push(genLeaf(skSeed, pubSeed, ltreeAddr, otsAddr));
  }
  const levels = [leaves];
  for (let height = 1; height <= TREE_HEIGHT; height += 1) {
    const below = levels[height - 1]!;
    const level: Uint8Array[] = [];
    for (let j = 0; j < below.length / 2; j += 1) {
      nodeAddr[5] = height - 1;
      nodeAddr[6] = j;
      level.push(thashH(concat([below[2 * j]!, below[2 * j + 1]!]), pubSeed, nodeAddr));
    }
    levels.push(level);
  }
  return levels;
}

function authPath(levels: Uint8Array[][], leafIdx: number): Uint8Array[] {
  return Array.from({ length: TREE_HEIGHT }, (_, height) => levels[height]![(leafIdx >> height) ^ 1]!);
}

function computeRoot(
  leaf: Uint8Array,
  leafIdx: number,
  authPath: Uint8Array[],
  pubSeed: Uint8Array,
  addr: Address,
): Uint8Array {
  let idx = leafIdx;
  let buffer = idx & 1 ? concat([authPath[0]!, leaf]) : concat([leaf, authPath[0]!]);
  for (let i = 0; i < TREE_HEIGHT - 1; i += 1) {
    addr[5] = i;
    idx = Math.floor(idx / 2);
    addr[6] = idx;
    const node = thashH(buffer, pubSeed, addr);
    buffer = idx & 1 ? concat([authPath[i + 1]!, node]) : concat([node, authPath[i + 1]!]);
  }
  addr[5] = TREE_HEIGHT - 1;
  idx = Math.floor(idx / 2);
  addr[6] = idx;
  return thashH(buffer, pubSeed, addr);
}

function checkLength(bytes: Uint8Array, length: number, what: string): void {
  if (!(bytes instanceof Uint8Array) || bytes.length !== length) {
    throw new Error(`${what} must be ${length} bytes`);
  }
}

/**
 * Fresh seeds for xmssKeygen and createXmssSigner, from
 * crypto.getRandomValues. The private seed is the key: back it up with the
 * public seed, and never use one pair with two index stores.
 */
export function generateXmssSeeds(): { privateSeed: Uint8Array; publicSeed: Uint8Array } {
  return {
    privateSeed: crypto.getRandomValues(new Uint8Array(XMSS_PRIVATE_SEED_LENGTH)),
    publicSeed: crypto.getRandomValues(new Uint8Array(XMSS_PUBLIC_SEED_LENGTH)),
  };
}

/**
 * Derive a key pair from seeds, as Pearl's xmss.Keygen does.
 *
 * privateSeed is 64 bytes and publicSeed 32. Throws for other lengths. Takes
 * about half a second.
 */
export function xmssKeygen(privateSeed: Uint8Array, publicSeed: Uint8Array): XmssKeyPair {
  return keyPairWithTree(privateSeed, publicSeed).pair;
}

function keyPairWithTree(
  privateSeed: Uint8Array,
  publicSeed: Uint8Array,
): { pair: XmssKeyPair; levels: Uint8Array[][] } {
  checkLength(privateSeed, XMSS_PRIVATE_SEED_LENGTH, 'XMSS private seed');
  checkLength(publicSeed, XMSS_PUBLIC_SEED_LENGTH, 'XMSS public seed');
  const levels = buildTree(privateSeed.subarray(0, N), publicSeed);
  const root = levels[TREE_HEIGHT]![0]!;
  return {
    pair: { publicKey: concat([root, publicSeed]), secretKey: concat([privateSeed, root, publicSeed]) },
    levels,
  };
}

/**
 * Sign a 32-byte message with the one-time leaf at index, 0 to XMSS_LAST_INDEX (30). The
 * caller must make sure no index is ever used twice for the same key. A
 * secret key whose root does not belong to its seeds is refused, and the
 * signature is verified before it is returned.
 *
 * Throws for an index outside 0 to 30, a message that is not 32 bytes and a
 * secret key that is not 128 bytes. Rebuilds the tree on every call;
 * createXmssSigner keeps it.
 */
export function xmssSign(secretKey: Uint8Array, index: number, message: Uint8Array): Uint8Array {
  checkLength(secretKey, XMSS_SECRET_KEY_LENGTH, 'XMSS secret key');
  const levels = buildTree(secretKey.subarray(0, N), secretKey.subarray(3 * N, 4 * N));
  if (!equalBytes(levels[TREE_HEIGHT]![0]!, secretKey.subarray(2 * N, 3 * N))) {
    throw new XmssError('XMSS_KEY_INVALID', 'XMSS secret key is inconsistent: its root does not match its seeds');
  }
  const signature = signWithTree(secretKey, levels, index, message);
  if (!xmssVerify(secretKey.subarray(2 * N), message, signature)) {
    throw new XmssError('XMSS_SIGNATURE_INVALID', 'XMSS signature failed verification');
  }
  return signature;
}

function signWithTree(
  secretKey: Uint8Array,
  levels: Uint8Array[][],
  index: number,
  message: Uint8Array,
): Uint8Array {
  checkLength(message, XMSS_MESSAGE_LENGTH, 'XMSS message');
  if (!Number.isInteger(index) || index < 0 || index > XMSS_LAST_INDEX) {
    throw new RangeError(`XMSS index must be an integer from 0 to ${XMSS_LAST_INDEX}`);
  }
  // Views, so no further copies of the secret halves are left behind.
  const skSeed = secretKey.subarray(0, N);
  const skPrf = secretKey.subarray(N, 2 * N);
  const root = secretKey.subarray(2 * N, 3 * N);
  const pubSeed = secretKey.subarray(3 * N, 4 * N);
  const r = prf(skPrf, toBytes(index, 32));
  const mhash = hashMessage(r, root, index, message);
  const otsAddr = newAddress(ADDR_TYPE_OTS);
  setTreeAddr(otsAddr, 0);
  otsAddr[4] = index;
  const wotsSig = wotsSign(mhash, skSeed, pubSeed, otsAddr);
  return concat([toBytes(index, INDEX_BYTES), r, ...wotsSig, ...authPath(levels, index)]);
}

/**
 * Verify a signature over a 32-byte message, as Pearl's xmss.Verify does.
 * Anything that is not bytes of the right length is false, never an error.
 */
export function xmssVerify(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  if (
    !(publicKey instanceof Uint8Array) ||
    !(message instanceof Uint8Array) ||
    !(signature instanceof Uint8Array) ||
    publicKey.length !== XMSS_PUBLIC_KEY_LENGTH ||
    message.length !== XMSS_MESSAGE_LENGTH ||
    signature.length !== XMSS_SIGNATURE_LENGTH
  ) {
    return false;
  }
  const pubRoot = publicKey.slice(0, N);
  const pubSeed = publicKey.slice(N, 2 * N);
  const idx = new DataView(signature.buffer, signature.byteOffset).getUint32(0, false);
  const r = signature.slice(INDEX_BYTES, INDEX_BYTES + N);
  const mhash = hashMessage(r, pubRoot, idx, message);
  const idxLeaf = idx & ((1 << TREE_HEIGHT) - 1);
  const tree = Math.floor(idx / 2 ** TREE_HEIGHT);
  const otsAddr = newAddress(ADDR_TYPE_OTS);
  const ltreeAddr = newAddress(ADDR_TYPE_LTREE);
  const nodeAddr = newAddress(ADDR_TYPE_HASHTREE);
  for (const addr of [otsAddr, ltreeAddr, nodeAddr]) setTreeAddr(addr, tree);
  otsAddr[4] = idxLeaf;
  let offset = INDEX_BYTES + N;
  const wotsSig: Uint8Array[] = [];
  for (let i = 0; i < WOTS_LEN; i += 1, offset += N) wotsSig.push(signature.slice(offset, offset + N));
  const authPath: Uint8Array[] = [];
  for (let i = 0; i < TREE_HEIGHT; i += 1, offset += N) authPath.push(signature.slice(offset, offset + N));
  const wotsPk = wotsPkFromSig(wotsSig, mhash, pubSeed, otsAddr);
  ltreeAddr[4] = idxLeaf;
  const leaf = lTree(wotsPk, pubSeed, ltreeAddr);
  const root = computeRoot(leaf, idxLeaf, authPath, pubSeed, nodeAddr);
  return root.every((byte, i) => byte === pubRoot[i]);
}

/**
 * Hands out one-time XMSS indices. reserve must return an index it has never
 * returned for this public key, and must persist that before returning: a
 * signature is only made after the index is recorded as used, so a crash can
 * waste an index but never reuse one.
 *
 * A key must have exactly one store, shared by everything that signs with
 * it. Two stores for one key, in one process or on two machines, each hand
 * out index 0, and a signer cannot see the other store. A store restored from
 * a backup repeats the indices used since the backup was taken.
 */
export interface XmssIndexStore {
  /**
   * Returns the next unused index for publicKey, having recorded it as used.
   * May be asynchronous. Once XMSS_LAST_INDEX has been handed out it should
   * throw and record nothing, as the stores here do.
   */
  reserve(publicKey: Uint8Array): number | Promise<number>;
  /** The index reserve would return next, without recording anything: how many signatures the key has made. */
  peek(publicKey: Uint8Array): number | Promise<number>;
}

/** An XMSS key that signs, taking each one-time index from its store. */
export interface XmssSigner {
  /** The 64-byte public key, as xmssLeafScript takes it. */
  readonly publicKey: Uint8Array;
  /**
   * Signs a 32-byte message with a freshly reserved index. Calls run one at
   * a time, in the order they were made.
   */
  sign(message: Uint8Array): Promise<Uint8Array>;
  /**
   * How many more signatures the key can make, from the store's count: 31
   * for a new key, 0 once it is used up.
   */
  remaining(): Promise<number>;
  /**
   * Overwrites the signer's copy of the secret key with zeros; sign rejects
   * afterwards. The seeds passed to createXmssSigner belong to the caller and
   * are not touched, and JavaScript cannot promise that no other copy exists:
   * values derived while signing wait for the garbage collector, which does
   * not wipe them, and the engine may have moved or paged out the bytes.
   */
  destroy(): void;
}

// Messages signed in this process, by public key and index. Signer objects
// for one key share it, so a second store that restarts at index 0 is caught
// when it would sign a different message. Signing the same message at the
// same index again yields the same signature and reveals nothing new.
const signedMessages = new Map<string, Map<number, string>>();

/**
 * An XMSS signer over raw seeds. Each signature takes an index from store,
 * and is verified before it is returned.
 *
 * The signer does not rely on the store alone: sign calls are serialized, so
 * a store that reads, waits and writes cannot hand two calls one index; an
 * index that is not above the last one this signer used is refused; and no
 * signer in this process signs a second message at an index another signer
 * for the same key already used. None of this reaches across processes or
 * restarts, which is the store's job.
 *
 * privateSeed is 64 bytes and publicSeed 32; throws for other lengths. sign
 * rejects once the key has used its 31 indices, when the store hands out an
 * index that is not new, and after destroy.
 */
export function createXmssSigner(
  privateSeed: Uint8Array,
  publicSeed: Uint8Array,
  store: XmssIndexStore,
): XmssSigner {
  // The tree is kept, so each signature only computes its WOTS chains.
  const {
    pair: { publicKey, secretKey },
    levels,
  } = keyPairWithTree(privateSeed, publicSeed);
  const keyHex = toHex(publicKey);
  let lastIndex = -1;
  let destroyed = false;
  let queue: Promise<unknown> = Promise.resolve();

  const signNext = async (message: Uint8Array): Promise<Uint8Array> => {
    if (destroyed) throw new SigningError('SIGNER_DESTROYED', 'this XMSS signer has been destroyed');
    const index = await store.reserve(Uint8Array.from(publicKey));
    if (!Number.isInteger(index) || index < 0) {
      throw new XmssError('XMSS_STORE_INVALID', `XMSS index store returned ${String(index)}`);
    }
    if (index > XMSS_LAST_INDEX) throw exhausted();
    if (index <= lastIndex) {
      throw new XmssError('XMSS_INDEX_REUSE',
        `XMSS index store returned index ${index} after index ${lastIndex}; refusing to reuse a one-time index`,
      );
    }
    if (destroyed) throw new SigningError('SIGNER_DESTROYED', 'this XMSS signer has been destroyed');
    const messageHex = toHex(message);
    let signed = signedMessages.get(keyHex);
    if (signed === undefined) {
      signed = new Map();
      signedMessages.set(keyHex, signed);
    }
    const earlier = signed.get(index);
    if (earlier !== undefined && earlier !== messageHex) {
      throw new XmssError('XMSS_INDEX_REUSE',
        `XMSS index ${index} already signed a different message for this key; ` +
          'a key must have exactly one index store',
      );
    }
    // Recorded before signing: an index is spent even if signing fails.
    lastIndex = index;
    signed.set(index, messageHex);
    const signature = signWithTree(secretKey, levels, index, message);
    if (!xmssVerify(publicKey, message, signature)) {
      throw new XmssError('XMSS_SIGNATURE_INVALID', 'XMSS signature failed verification');
    }
    return signature;
  };

  return {
    // A copy: the signer's own key must not change when a caller's does.
    publicKey: Uint8Array.from(publicKey),
    async sign(message: Uint8Array): Promise<Uint8Array> {
      checkLength(message, XMSS_MESSAGE_LENGTH, 'XMSS message');
      const copy = Uint8Array.from(message);
      const result = queue.then(() => signNext(copy));
      queue = result.catch(() => undefined);
      return result;
    },
    async remaining(): Promise<number> {
      const used = await store.peek(Uint8Array.from(publicKey));
      if (!Number.isInteger(used) || used < 0) {
        throw new XmssError('XMSS_STORE_INVALID', `XMSS index store returned ${String(used)}`);
      }
      return Math.max(0, XMSS_MAX_SIGNATURES - used);
    },
    destroy(): void {
      destroyed = true;
      secretKey.fill(0);
    },
  };
}

function exhausted(): XmssError {
  return new XmssError('XMSS_INDEX_EXHAUSTED', `this XMSS key has used all ${XMSS_MAX_SIGNATURES} of its signatures`);
}

/**
 * Index store that only lives in memory. State is lost on restart, which
 * would reuse indices, so it is for tests and short-lived tools only. For a
 * store that survives restarts under Node, see createFileXmssIndexStore in
 * xmss-file-store.
 */
export function createMemoryXmssIndexStore(): XmssIndexStore {
  const next = new Map<string, number>();
  return {
    reserve(publicKey: Uint8Array): number {
      const key = toHex(publicKey);
      const index = next.get(key) ?? 0;
      if (index > XMSS_LAST_INDEX) throw exhausted();
      next.set(key, index + 1);
      return index;
    },
    peek: (publicKey: Uint8Array): number => next.get(toHex(publicKey)) ?? 0,
  };
}
