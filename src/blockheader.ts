// Pearl block headers are 108 bytes: the Bitcoin header layout with the
// 4-byte nonce replaced by a 32-byte proof commitment.

import { sha256 } from '@noble/hashes/sha2';

/** Serialized size of a Pearl block header in bytes. */
export const BLOCK_HEADER_SIZE = 108;

const HASH_SIZE = 32;
const UINT32_MAX = 0xffffffff;
const INT32_MIN = -0x80000000;
const INT32_MAX = 0x7fffffff;

export interface PearlBlockHeader {
  version: number;
  prevBlock: Uint8Array;
  merkleRoot: Uint8Array;
  timestamp: number;
  bits: number;
  proofCommitment: Uint8Array;
}

function assertInt32(value: number, label: string): void {
  if (!Number.isInteger(value) || value < INT32_MIN || value > INT32_MAX) {
    throw new RangeError(`${label} must be a signed 32-bit integer`);
  }
}

function assertUint32(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > UINT32_MAX) {
    throw new RangeError(`${label} must be an unsigned 32-bit integer`);
  }
}

function assertHash(value: Uint8Array, label: string): void {
  if (!(value instanceof Uint8Array)) {
    throw new TypeError(`${label} must be a Uint8Array`);
  }
  if (value.length !== HASH_SIZE) {
    throw new RangeError(`${label} must be ${HASH_SIZE} bytes, got ${value.length}`);
  }
}

/**
 * Serialize a block header to its 108-byte wire form. Scalar fields are
 * little-endian; the 32-byte hashes are written raw in internal order.
 */
export function serializeBlockHeader(header: PearlBlockHeader): Uint8Array {
  assertInt32(header.version, 'header version');
  assertUint32(header.timestamp, 'header timestamp');
  assertUint32(header.bits, 'header bits');
  assertHash(header.prevBlock, 'header prevBlock');
  assertHash(header.merkleRoot, 'header merkleRoot');
  assertHash(header.proofCommitment, 'header proofCommitment');

  const bytes = new Uint8Array(BLOCK_HEADER_SIZE);
  const view = new DataView(bytes.buffer);
  view.setInt32(0, header.version, true);
  bytes.set(header.prevBlock, 4);
  bytes.set(header.merkleRoot, 36);
  view.setUint32(68, header.timestamp, true);
  view.setUint32(72, header.bits, true);
  bytes.set(header.proofCommitment, 76);
  return bytes;
}

/**
 * Parse a block header from its 108-byte wire form. The returned hash fields
 * are copies, so mutating them or the input bytes cannot affect the other.
 */
export function parseBlockHeader(bytes: Uint8Array): PearlBlockHeader {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError('block header must be a Uint8Array');
  }
  if (bytes.length !== BLOCK_HEADER_SIZE) {
    throw new RangeError(
      `block header must be exactly ${BLOCK_HEADER_SIZE} bytes, got ${bytes.length}`,
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    version: view.getInt32(0, true),
    prevBlock: bytes.slice(4, 36),
    merkleRoot: bytes.slice(36, 68),
    timestamp: view.getUint32(68, true),
    bits: view.getUint32(72, true),
    proofCommitment: bytes.slice(76, 108),
  };
}

/**
 * Double-SHA256 of the serialized header, returned in internal (wire) byte
 * order, matching chainhash.Hash's underlying bytes.
 */
export function blockHash(header: PearlBlockHeader): Uint8Array {
  return sha256(sha256(serializeBlockHeader(header)));
}

/**
 * Block hash as display hex with the digest bytes reversed, matching
 * chainhash.Hash.String.
 */
export function blockHashHex(header: PearlBlockHeader): string {
  return Array.from(blockHash(header))
    .reverse()
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
