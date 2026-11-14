// Full Pearl blocks: certificate, 108-byte header, then transactions.
//
// The certificate comes first on the wire and carries the proof of useful
// work. Its version picks the layout: V1 has 164 bytes of public data, V2
// and V3 a length-prefixed public data of up to 4807 bytes, and version 0
// means no certificate. This module parses and serializes blocks, computes
// merkle roots, witness commitments and vsize the way Pearl's node does, and
// checks that a certificate is bound to its header. It does not verify the
// zero-knowledge proof itself.

/**
 * Full Pearl blocks: certificate, header and transactions. Parsing,
 * serialization, Merkle roots, witness commitments and sizes. Proofs are not
 * verified.
 *
 * @module
 */

import { sha256 } from '@noble/hashes/sha2';
import { Transaction } from 'bitcoinjs-lib';
import {
  BLOCK_HEADER_SIZE,
  blockHash,
  parseBlockHeader,
  serializeBlockHeader,
} from './blockheader.js';
import type { PearlBlockHeader } from './blockheader.js';
import { concat, equalBytes, uint32le, varInt } from './internal/bytes.js';
import { PearlError } from './errors.js';

// wire.CertificateMaxSize, wire.MaxZKProofSize and the public data sizes.
/** wire.CertificateMaxSize: the most bytes a serialized certificate may have. */
export const CERTIFICATE_MAX_SIZE = 65000;
/** wire.MaxZKProofSize: the most bytes a certificate's proof may have. */
export const MAX_ZK_PROOF_SIZE = 60000;
/** Bytes of public data in a V1 certificate, exactly. */
export const PUBLIC_DATA_SIZE_V1 = 164;
/** The most bytes of public data in a V2 or V3 certificate. */
export const PUBLIC_DATA_MAX_SIZE_V2 = 4807;
// A V2 or V3 certificate with more public data than a dense one is MoE.
/** Bytes of public data in a dense V2 or V3 certificate; one with more is MoE. */
export const PUBLIC_DATA_SIZE_DENSE_V2 = 164;
// blockchain.MaxBlockVsize and WitnessScaleFactor.
/** blockchain.MaxBlockVsize: the largest block, in vbytes, certificate not counted. */
export const MAX_BLOCK_VSIZE = 1_000_000;
const WITNESS_SCALE_FACTOR = 4;
// wire.MaxBlockPayload / minTxPayload + 1.
const MAX_TX_PER_BLOCK = Math.floor(4_000_000 / 10) + 1;

const HASH_SIZE = 32;
// blockchain.WitnessMagicBytes: OP_RETURN, a 36-byte push, then aa21a9ed.
const WITNESS_MAGIC = Uint8Array.of(0x6a, 0x24, 0xaa, 0x21, 0xa9, 0xed);
const WITNESS_COMMITMENT_SCRIPT_LENGTH = 38;
const COINBASE_WITNESS_NONCE_LENGTH = 32;

/**
 * Certificate versions Pearl defines. Which one a block needs depends on its
 * height; see requiredCertVersion.
 */
export type CertificateVersion = 1 | 2 | 3;

/**
 * A block's proof-of-work certificate: a ZK proof and its public data. pearljs
 * parses it and checks its binding to the header; it does not verify the proof.
 */
export interface PearlCertificate {
  version: CertificateVersion;
  /** Hash of the block header this certificate proves, in internal order. */
  hash: Uint8Array;
  /** The proof's public inputs: 164 bytes for V1, up to 4807 for V2 and V3. */
  publicData: Uint8Array;
  /** The ZK proof, up to 60000 bytes. Not verified by pearljs. */
  proof: Uint8Array;
}

/** A full block: certificate, header and transactions, in wire order. */
export interface PearlBlock {
  /** null for a block encoded with certificate version 0. */
  certificate: PearlCertificate | null;
  header: PearlBlockHeader;
  transactions: Transaction[];
}

function doubleSha256(data: Uint8Array): Uint8Array {
  return sha256(sha256(data));
}

class Reader {
  offset = 0;
  private readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    // A plain view, so take() copies even for a Node Buffer, whose slice()
    // shares memory and whose .buffer can be a pool other data lives in.
    this.bytes = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  take(length: number): Uint8Array {
    if (this.offset + length > this.bytes.length) {
      throw new PearlError('BLOCK_MALFORMED', 'unexpected end of block data');
    }
    const out = this.bytes.slice(this.offset, this.offset + length);
    this.offset += length;
    return out;
  }

  uint32(): number {
    return new DataView(this.take(4).buffer).getUint32(0, true);
  }

  varInt(): number {
    const first = this.take(1)[0]!;
    if (first < 0xfd) return first;
    if (first === 0xfd) return new DataView(this.take(2).buffer).getUint16(0, true);
    if (first === 0xfe) return this.uint32();
    const wide = new DataView(this.take(8).buffer).getBigUint64(0, true);
    if (wide > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new PearlError('BLOCK_MALFORMED', 'transaction count does not fit in a number');
    }
    return Number(wide);
  }

  remaining(): Uint8Array {
    return this.bytes.subarray(this.offset);
  }
}

function readCertificate(reader: Reader): PearlCertificate | null {
  const version = reader.uint32();
  if (version === 0) return null;
  if (version !== 1 && version !== 2 && version !== 3) {
    throw new PearlError('CERTIFICATE_MALFORMED', `unsupported certificate version: ${version}`);
  }
  const start = reader.offset;
  const hash = reader.take(HASH_SIZE);
  let publicData: Uint8Array;
  if (version === 1) {
    publicData = reader.take(PUBLIC_DATA_SIZE_V1);
  } else {
    const length = reader.uint32();
    if (length > PUBLIC_DATA_MAX_SIZE_V2) {
      throw new PearlError('CERTIFICATE_MALFORMED', `public_data_len ${length} exceeds max ${PUBLIC_DATA_MAX_SIZE_V2}`);
    }
    publicData = reader.take(length);
  }
  const proofLength = reader.uint32();
  if (proofLength > MAX_ZK_PROOF_SIZE) {
    throw new PearlError('CERTIFICATE_MALFORMED', `proof data too large: ${proofLength} bytes (max ${MAX_ZK_PROOF_SIZE})`);
  }
  const proof = reader.take(proofLength);
  // Pearl reads the certificate body through a CertificateMaxSize limit.
  if (reader.offset - start > CERTIFICATE_MAX_SIZE) {
    throw new PearlError('CERTIFICATE_MALFORMED', `certificate body exceeds ${CERTIFICATE_MAX_SIZE} bytes`);
  }
  return { version, hash, publicData, proof };
}

/** Serialize a certificate with its version prefix; null encodes version 0. */
export function serializeCertificate(certificate: PearlCertificate | null): Uint8Array {
  if (certificate === null) return uint32le(0);
  const { version, hash, publicData, proof } = certificate;
  if (hash.length !== HASH_SIZE) {
    throw new PearlError('CERTIFICATE_MALFORMED', `certificate hash must be ${HASH_SIZE} bytes, got ${hash.length}`);
  }
  let body: Uint8Array[];
  if (version === 1) {
    if (publicData.length !== PUBLIC_DATA_SIZE_V1) {
      throw new PearlError('CERTIFICATE_MALFORMED', `V1 public data must be ${PUBLIC_DATA_SIZE_V1} bytes, got ${publicData.length}`);
    }
    body = [hash, publicData];
  } else if (version === 2 || version === 3) {
    if (publicData.length > PUBLIC_DATA_MAX_SIZE_V2) {
      throw new PearlError('CERTIFICATE_MALFORMED', `public data of ${publicData.length} bytes exceeds max ${PUBLIC_DATA_MAX_SIZE_V2}`);
    }
    body = [hash, uint32le(publicData.length), publicData];
  } else {
    throw new PearlError('CERTIFICATE_MALFORMED', `unsupported certificate version: ${String(version)}`);
  }
  const out = concat([uint32le(version), ...body, uint32le(proof.length), proof]);
  if (out.length > CERTIFICATE_MAX_SIZE) {
    throw new PearlError('CERTIFICATE_MALFORMED', `certificate too large: ${out.length} bytes (max ${CERTIFICATE_MAX_SIZE})`);
  }
  return out;
}

/**
 * Parse a full block. Every transaction must be canonically encoded and the
 * data must end exactly after the last one.
 *
 * Throws when a certificate breaks Pearl's size limits, a transaction is not
 * canonical, or bytes follow the last transaction. The proof is not verified.
 */
export function parseBlock(bytes: Uint8Array): PearlBlock {
  const reader = new Reader(bytes);
  const certificate = readCertificate(reader);
  const header = parseBlockHeader(reader.take(BLOCK_HEADER_SIZE));
  const count = reader.varInt();
  if (count > MAX_TX_PER_BLOCK) {
    throw new PearlError('BLOCK_MALFORMED', `too many transactions to fit into a block [count ${count}, max ${MAX_TX_PER_BLOCK}]`);
  }
  const transactions: Transaction[] = [];
  for (let i = 0; i < count; i += 1) {
    const rest = reader.remaining();
    let tx: Transaction;
    try {
      tx = Transaction.fromBuffer(rest, true);
    } catch {
      throw new PearlError('BLOCK_MALFORMED', `transaction ${i} could not be decoded`);
    }
    const encoded = tx.toBuffer();
    // bitcoinjs re-encodes from the parsed fields, so comparing catches any
    // input it would have read differently from Pearl.
    if (!equalBytes(encoded, rest.subarray(0, encoded.length))) {
      throw new PearlError('BLOCK_MALFORMED', `transaction ${i} is not canonically encoded`);
    }
    reader.take(encoded.length);
    transactions.push(tx);
  }
  if (reader.remaining().length !== 0) {
    throw new PearlError('BLOCK_MALFORMED', `${reader.remaining().length} unexpected bytes after the last transaction`);
  }
  return { certificate, header, transactions };
}

/** Serialize a block with witness data, the encoding Pearl stores and relays. */
export function serializeBlock(block: PearlBlock): Uint8Array {
  return concat([
    serializeCertificate(block.certificate),
    serializeBlockHeader(block.header),
    varInt(block.transactions.length),
    ...block.transactions.map((tx) => tx.toBuffer()),
  ]);
}

/** Double-SHA256 of the version and public data, as the header commits to it. */
export function certificateProofCommitment(certificate: PearlCertificate): Uint8Array {
  return doubleSha256(concat([uint32le(certificate.version), certificate.publicData]));
}

/** Whether a certificate carries more public data than a dense V2 proof. */
export function isMoECertificate(certificate: PearlCertificate): boolean {
  return certificate.version !== 1 && certificate.publicData.length > PUBLIC_DATA_SIZE_DENSE_V2;
}

/**
 * Checks the binding Pearl requires before verifying a proof: the
 * certificate's hash equal to the header hash, the header's proof commitment
 * equal to the certificate's, and a non-empty proof. Genesis blocks are
 * hardcoded and fail these checks.
 */
export function checkCertificateBinding(block: PearlBlock): void {
  const { certificate, header } = block;
  if (certificate === null) {
    throw new PearlError('BLOCK_CERTIFICATE_INVALID', 'block has no certificate');
  }
  if (!equalBytes(certificate.hash, blockHash(header))) {
    throw new PearlError('BLOCK_CERTIFICATE_INVALID', 'block hash mismatch between certificate and header');
  }
  if (!equalBytes(header.proofCommitment, certificateProofCommitment(certificate))) {
    throw new PearlError('BLOCK_CERTIFICATE_INVALID', 'proof commitment mismatch between header and certificate');
  }
  if (certificate.proof.length === 0) {
    throw new PearlError('BLOCK_CERTIFICATE_INVALID', 'empty proof data');
  }
}

function merkleRoot(hashes: Uint8Array[]): Uint8Array {
  if (hashes.length === 0) {
    throw new Error('a merkle root needs at least one transaction');
  }
  let level = hashes;
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      const right = level[i + 1] ?? left;
      next.push(doubleSha256(concat([left, right])));
    }
    level = next;
  }
  return level[0]!;
}

/**
 * Merkle root over txids, or over wtxids with the coinbase's set to zero
 * when witness is true, in internal byte order.
 */
export function calculateMerkleRoot(transactions: readonly Transaction[], witness = false): Uint8Array {
  return merkleRoot(
    transactions.map((tx, index) =>
      witness ? (index === 0 ? new Uint8Array(HASH_SIZE) : tx.getHash(true)) : tx.getHash(),
    ),
  );
}

/** Whether the header's merkle root matches the block's transactions. */
export function checkMerkleRoot(block: PearlBlock): boolean {
  return block.transactions.length > 0 && equalBytes(block.header.merkleRoot, calculateMerkleRoot(block.transactions));
}

function isCoinbase(tx: Transaction): boolean {
  const input = tx.ins[0];
  return (
    tx.ins.length === 1 &&
    input !== undefined &&
    input.index === 0xffffffff &&
    input.hash.every((byte) => byte === 0)
  );
}

/** The 32-byte witness commitment in the coinbase, or null when it has none. */
export function witnessCommitment(block: PearlBlock): Uint8Array | null {
  const coinbase = block.transactions[0];
  if (coinbase === undefined || !isCoinbase(coinbase)) return null;
  for (let i = coinbase.outs.length - 1; i >= 0; i -= 1) {
    const script = coinbase.outs[i]!.script;
    if (
      script.length >= WITNESS_COMMITMENT_SCRIPT_LENGTH &&
      equalBytes(script.subarray(0, WITNESS_MAGIC.length), WITNESS_MAGIC)
    ) {
      return script.slice(WITNESS_MAGIC.length, WITNESS_COMMITMENT_SCRIPT_LENGTH);
    }
  }
  return null;
}

/** Checks the witness commitment with the rules of ValidateWitnessCommitment. */
export function checkWitnessCommitment(block: PearlBlock): void {
  const coinbase = block.transactions[0];
  if (coinbase === undefined) {
    throw new PearlError('BLOCK_WITNESS_COMMITMENT_INVALID', 'cannot validate witness commitment of block without transactions');
  }
  if (coinbase.ins.length === 0) {
    throw new PearlError('BLOCK_WITNESS_COMMITMENT_INVALID', 'transaction has no inputs');
  }
  const commitment = witnessCommitment(block);
  if (commitment === null) {
    if (block.transactions.some((tx) => tx.hasWitnesses())) {
      throw new PearlError('BLOCK_WITNESS_COMMITMENT_INVALID', 'block contains transaction with witness data, yet no witness commitment present');
    }
    return;
  }
  const witness = coinbase.ins[0]!.witness;
  if (witness.length !== 1) {
    throw new PearlError('BLOCK_WITNESS_COMMITMENT_INVALID', `the coinbase transaction has ${witness.length} items in its witness stack when only one is allowed`);
  }
  const nonce = witness[0]!;
  if (nonce.length !== COINBASE_WITNESS_NONCE_LENGTH) {
    throw new PearlError('BLOCK_WITNESS_COMMITMENT_INVALID', `the coinbase transaction witness nonce has ${nonce.length} bytes when it must be ${COINBASE_WITNESS_NONCE_LENGTH} bytes`);
  }
  const computed = doubleSha256(concat([calculateMerkleRoot(block.transactions, true), nonce]));
  if (!equalBytes(computed, commitment)) {
    throw new PearlError('BLOCK_WITNESS_COMMITMENT_INVALID', 'witness commitment does not match');
  }
}

/** Serialized size in bytes, certificate and witnesses included. */
export function blockSize(block: PearlBlock): number {
  return serializeBlock(block).length;
}

/** Header, transaction count and stripped transactions: no certificate, no witnesses. */
export function blockStrippedSize(block: PearlBlock): number {
  return (
    BLOCK_HEADER_SIZE +
    varInt(block.transactions.length).length +
    block.transactions.reduce((sum, tx) => sum + tx.byteLength(false), 0)
  );
}

/**
 * Pearl's block vsize: stripped size plus witness bytes divided by four,
 * rounded up. The certificate is not counted.
 */
export function blockVsize(block: PearlBlock): number {
  const witnessSize = block.transactions.reduce(
    (sum, tx) => sum + tx.byteLength(true) - tx.byteLength(false),
    0,
  );
  return blockStrippedSize(block) + Math.ceil(witnessSize / WITNESS_SCALE_FACTOR);
}
