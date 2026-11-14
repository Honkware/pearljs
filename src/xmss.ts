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
// its last leaf; xmssSign refuses that index, leaving 31 signatures per key.

import { shake256 } from '@noble/hashes/sha3';

export const XMSS_PRIVATE_SEED_LENGTH = 64;
export const XMSS_PUBLIC_SEED_LENGTH = 32;
export const XMSS_PUBLIC_KEY_LENGTH = 64;
export const XMSS_SECRET_KEY_LENGTH = 128;
export const XMSS_MESSAGE_LENGTH = 32;
export const XMSS_SIGNATURE_LENGTH = 2340;
/** Indices 0 to 30 produce valid signatures; see the note at the top. */
export const XMSS_MAX_SIGNATURES = 31;

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

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
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

/** Root of the tree and the authentication path for leafIdx (treehash). */
function treehash(
  skSeed: Uint8Array,
  pubSeed: Uint8Array,
  leafIdx: number,
  subtreeAddr: Address,
): { root: Uint8Array; authPath: Uint8Array[] } {
  const otsAddr = newAddress(ADDR_TYPE_OTS);
  const ltreeAddr = newAddress(ADDR_TYPE_LTREE);
  const nodeAddr = newAddress(ADDR_TYPE_HASHTREE);
  for (const addr of [otsAddr, ltreeAddr, nodeAddr]) {
    addr[0] = subtreeAddr[0]!;
    addr[1] = subtreeAddr[1]!;
    addr[2] = subtreeAddr[2]!;
  }
  const stack: Uint8Array[] = [];
  const heights: number[] = [];
  const authPath: Uint8Array[] = new Array<Uint8Array>(TREE_HEIGHT).fill(new Uint8Array(N));
  for (let idx = 0; idx < 1 << TREE_HEIGHT; idx += 1) {
    ltreeAddr[4] = idx;
    otsAddr[4] = idx;
    stack.push(genLeaf(skSeed, pubSeed, ltreeAddr, otsAddr));
    heights.push(0);
    if ((leafIdx ^ 1) === idx) {
      authPath[0] = stack[stack.length - 1]!;
    }
    while (stack.length >= 2 && heights[heights.length - 1] === heights[heights.length - 2]) {
      const height = heights[heights.length - 1]!;
      const treeIdx = idx >> (height + 1);
      nodeAddr[5] = height;
      nodeAddr[6] = treeIdx;
      const right = stack.pop()!;
      const left = stack.pop()!;
      heights.pop();
      stack.push(thashH(concat([left, right]), pubSeed, nodeAddr));
      heights[heights.length - 1] = height + 1;
      if (((leafIdx >> (height + 1)) ^ 1) === treeIdx) {
        authPath[height + 1] = stack[stack.length - 1]!;
      }
    }
  }
  return { root: stack[0]!, authPath };
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

/** Derive a key pair from seeds, as Pearl's xmss.Keygen does. */
export function xmssKeygen(privateSeed: Uint8Array, publicSeed: Uint8Array): XmssKeyPair {
  checkLength(privateSeed, XMSS_PRIVATE_SEED_LENGTH, 'XMSS private seed');
  checkLength(publicSeed, XMSS_PUBLIC_SEED_LENGTH, 'XMSS public seed');
  const skSeed = privateSeed.slice(0, N);
  const { root } = treehash(skSeed, publicSeed, 0, newAddress(0));
  return {
    publicKey: concat([root, publicSeed]),
    secretKey: concat([privateSeed, root, publicSeed]),
  };
}

/**
 * Sign a 32-byte message with the one-time leaf at msgUid (0 to 30). The
 * caller must make sure no index is ever used twice for the same key.
 */
export function xmssSign(secretKey: Uint8Array, msgUid: number, message: Uint8Array): Uint8Array {
  checkLength(secretKey, XMSS_SECRET_KEY_LENGTH, 'XMSS secret key');
  checkLength(message, XMSS_MESSAGE_LENGTH, 'XMSS message');
  if (!Number.isInteger(msgUid) || msgUid < 0 || msgUid >= XMSS_MAX_SIGNATURES) {
    throw new RangeError(`XMSS index must be an integer from 0 to ${XMSS_MAX_SIGNATURES - 1}`);
  }
  const skSeed = secretKey.slice(0, N);
  const skPrf = secretKey.slice(N, 2 * N);
  const root = secretKey.slice(2 * N, 3 * N);
  const pubSeed = secretKey.slice(3 * N, 4 * N);
  const r = prf(skPrf, toBytes(msgUid, 32));
  const mhash = hashMessage(r, root, msgUid, message);
  const otsAddr = newAddress(ADDR_TYPE_OTS);
  setTreeAddr(otsAddr, 0);
  otsAddr[4] = msgUid;
  const wotsSig = wotsSign(mhash, skSeed, pubSeed, otsAddr);
  const { authPath } = treehash(skSeed, pubSeed, msgUid, otsAddr);
  return concat([toBytes(msgUid, INDEX_BYTES), r, ...wotsSig, ...authPath]);
}

/** Verify a signature over a 32-byte message, as Pearl's xmss.Verify does. */
export function xmssVerify(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  if (
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
 */
export interface XmssIndexStore {
  reserve(publicKey: Uint8Array): number | Promise<number>;
}

export interface XmssSigner {
  readonly publicKey: Uint8Array;
  /** Signs a 32-byte message with a freshly reserved index. */
  sign(message: Uint8Array): Promise<Uint8Array>;
}

/**
 * An XMSS signer over raw seeds. Each signature takes an index from store,
 * and is verified before it is returned.
 */
export function createXmssSigner(
  privateSeed: Uint8Array,
  publicSeed: Uint8Array,
  store: XmssIndexStore,
): XmssSigner {
  const { publicKey, secretKey } = xmssKeygen(privateSeed, publicSeed);
  return {
    publicKey,
    async sign(message: Uint8Array): Promise<Uint8Array> {
      checkLength(message, XMSS_MESSAGE_LENGTH, 'XMSS message');
      const index = await store.reserve(publicKey);
      if (!Number.isInteger(index) || index < 0) {
        throw new Error(`XMSS index store returned ${String(index)}`);
      }
      if (index >= XMSS_MAX_SIGNATURES) {
        throw new Error(`this XMSS key has used all ${XMSS_MAX_SIGNATURES} of its signatures`);
      }
      const signature = xmssSign(secretKey, index, message);
      if (!xmssVerify(publicKey, message, signature)) {
        throw new Error('XMSS signature failed verification');
      }
      return signature;
    },
  };
}

/**
 * Index store that only lives in memory. State is lost on restart, which
 * would reuse indices, so it is for tests and short-lived tools only.
 */
export function createMemoryXmssIndexStore(): XmssIndexStore {
  const next = new Map<string, number>();
  return {
    reserve(publicKey: Uint8Array): number {
      const key = Array.from(publicKey, (byte) => byte.toString(16).padStart(2, '0')).join('');
      const index = next.get(key) ?? 0;
      next.set(key, index + 1);
      return index;
    },
  };
}
