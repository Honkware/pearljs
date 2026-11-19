// Full Pearl blocks: certificate, 108-byte header, then transactions.
//
// The certificate comes first on the wire and carries the proof of useful
// work. Its version picks the layout: V1 has 164 bytes of public data, V2
// and V3 a length-prefixed public data of up to 4807 bytes, V4 (FP8) up to
// 832 bytes followed by up to three ancestor headers, and version 0 means no
// certificate. This module parses and serializes blocks, computes merkle
// roots, witness commitments and vsize the way Pearl's node does, and checks
// that a certificate is bound to its header and, for V4, to its ancestors.
// It does not verify the zero-knowledge proof itself.

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
import { concat, equalBytes, toHex, uint32le, varInt } from './internal/bytes.js';
import { PearlError } from './errors.js';
import { checkLotteryLayout, checkV4Statement } from './internal/v4-statement.js';

// wire.CertificateMaxSize, wire.MaxZKProofSize and the public data sizes.
/** wire.CertificateMaxSize: the most bytes a serialized certificate may have, version included. */
export const CERTIFICATE_MAX_SIZE = 65000;
/** wire.MaxZKProofSize: the most bytes a certificate's proof may have on the wire. */
export const MAX_ZK_PROOF_SIZE = 62000;
/**
 * The proof limit before FP8 (wire.MaxZKProofSize in Pearl 1.5), which Pearl's
 * verifier still applies to V1, V2 and V3 proofs.
 */
export const LEGACY_MAX_ZK_PROOF_SIZE = 60000;
/** Bytes of public data in a V1 certificate, exactly. */
export const PUBLIC_DATA_SIZE_V1 = 164;
/** The most bytes of public data in a V2 or V3 certificate. */
export const PUBLIC_DATA_MAX_SIZE_V2 = 4807;
// A V2 or V3 certificate with more public data than a dense one is MoE.
/** Bytes of public data in a dense V2 or V3 certificate; one with more is MoE. */
export const PUBLIC_DATA_SIZE_DENSE_V2 = 164;
/** wire.PublicDataMaxSizeV4: the most bytes of public data in a V4 certificate. */
export const PUBLIC_DATA_MAX_SIZE_V4 = 832;
/** The fewest bytes of V4 public data Pearl's verifier accepts: a dense statement (PublicParams::WIRE_SIZE). */
export const PUBLIC_DATA_MIN_SIZE_V4 = 240;
/** wire.MaxCertificateV4AncestorHeaders: headers a V4 certificate may carry between its block and the proof's ancestor. */
export const MAX_CERTIFICATE_V4_ANCESTOR_HEADERS = 3;
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
export type CertificateVersion = 1 | 2 | 3 | 4;

/**
 * A block's proof-of-work certificate: a ZK proof and its public data. pearljs
 * parses it and checks its binding to the header; it does not verify the proof.
 */
export interface PearlCertificate {
  version: CertificateVersion;
  /** Hash of the block header this certificate proves, in internal order. */
  hash: Uint8Array;
  /**
   * The proof's public inputs: 164 bytes for V1, up to 4807 for V2 and V3,
   * up to 832 for V4, whose first 108 bytes are the header of the ancestor
   * the proof was keyed by (see certificateAncestorHeader).
   */
  publicData: Uint8Array;
  /** The ZK proof, up to 62000 bytes (60000 for V1 to V3). Not verified by pearljs. */
  proof: Uint8Array;
  /**
   * V4 only: the full headers between this block and the proof's ancestor,
   * parent first, at most three. Empty when the ancestor is the parent. They
   * are outside the proof commitment; parseBlock sets it for V4 only.
   */
  ancestorHeaders?: PearlBlockHeader[];
}

/**
 * How a block or certificate is decoded and encoded. `fp8: false` follows a
 * pearld without the FP8 fork code (Pearl 1.5): version 4 is unsupported,
 * proofs are capped at 60000 bytes and the limits read as that release words
 * them. The default follows Pearl's fp8-scheme branch (1.6), which accepts
 * every block the older code does.
 */
export interface BlockCodecOptions {
  readonly fp8?: boolean;
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

  /** wire.ReadVarInt, which refuses a value written in more bytes than it needs. */
  varInt(): number {
    const value = this.varIntBig();
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new PearlError('BLOCK_MALFORMED', 'transaction count does not fit in a number');
    }
    return Number(value);
  }

  varIntBig(): bigint {
    const first = this.take(1)[0]!;
    if (first < 0xfd) return BigInt(first);
    const [value, min] =
      first === 0xfd
        ? [BigInt(new DataView(this.take(2).buffer).getUint16(0, true)), 0xfdn]
        : first === 0xfe
          ? [BigInt(this.uint32()), 0x10000n]
          : [new DataView(this.take(8).buffer).getBigUint64(0, true), 0x100000000n];
    if (value < min) {
      throw new PearlError(
        'BLOCK_MALFORMED',
        `non-canonical varint ${value.toString(16)} - discriminant ${first.toString(16)} encodes a value that fits in fewer bytes`,
      );
    }
    return value;
  }

  remaining(): Uint8Array {
    return this.bytes.subarray(this.offset);
  }
}

// The limits each wire generation reads a certificate with, and how it words them.
function blobLimit(fp8: boolean, field: string, length: number, max: number, legacy: string): void {
  if (length > max) throw new PearlError('CERTIFICATE_MALFORMED', fp8 ? `${field}_len ${length} exceeds max ${max}` : legacy);
}

function readCertificate(reader: Reader, fp8: boolean): PearlCertificate | null {
  const version = reader.uint32();
  if (version === 0) return null;
  if (version !== 1 && version !== 2 && version !== 3 && !(fp8 && version === 4)) {
    throw new PearlError('CERTIFICATE_MALFORMED', `unsupported certificate version: ${version}`);
  }
  const maxProof = fp8 ? MAX_ZK_PROOF_SIZE : LEGACY_MAX_ZK_PROOF_SIZE;
  // Pearl 1.6 reads the body through CertificateMaxSize less the version, 1.5 through all of it.
  const maxBody = fp8 ? CERTIFICATE_MAX_SIZE - 4 : CERTIFICATE_MAX_SIZE;
  const start = reader.offset;
  const hash = reader.take(HASH_SIZE);
  let publicData: Uint8Array;
  if (version === 1) {
    publicData = reader.take(PUBLIC_DATA_SIZE_V1);
  } else {
    const length = reader.uint32();
    const [field, max] = version === 4 ? ['fp8 public_data', PUBLIC_DATA_MAX_SIZE_V4] : ['public_data', PUBLIC_DATA_MAX_SIZE_V2];
    blobLimit(true, field, length, max, '');
    publicData = reader.take(length);
  }
  const proofLength = reader.uint32();
  blobLimit(fp8, version === 4 ? 'fp8 proof_data' : 'proof_data', proofLength, maxProof,
    `proof data too large: ${proofLength} bytes (max ${maxProof})`);
  const proof = reader.take(proofLength);
  let ancestorHeaders: PearlBlockHeader[] | undefined;
  if (version === 4) {
    const count = reader.varIntBig();
    if (count > BigInt(MAX_CERTIFICATE_V4_ANCESTOR_HEADERS)) {
      throw new PearlError('CERTIFICATE_MALFORMED', `too many v4 ancestor headers: ${count} (max ${MAX_CERTIFICATE_V4_ANCESTOR_HEADERS})`);
    }
    ancestorHeaders = Array.from({ length: Number(count) }, () => parseBlockHeader(reader.take(BLOCK_HEADER_SIZE)));
  }
  if (reader.offset - start > maxBody) {
    throw new PearlError('CERTIFICATE_MALFORMED', `certificate body exceeds ${maxBody} bytes`);
  }
  return ancestorHeaders === undefined ? { version, hash, publicData, proof } : { version, hash, publicData, proof, ancestorHeaders };
}

/** Serialize a certificate with its version prefix; null encodes version 0. */
export function serializeCertificate(certificate: PearlCertificate | null, options: BlockCodecOptions = {}): Uint8Array {
  if (certificate === null) return uint32le(0);
  const fp8 = options.fp8 ?? true;
  const { version, hash, publicData, proof } = certificate;
  const ancestors = certificate.ancestorHeaders ?? [];
  if (hash.length !== HASH_SIZE) {
    throw new PearlError('CERTIFICATE_MALFORMED', `certificate hash must be ${HASH_SIZE} bytes, got ${hash.length}`);
  }
  if (version !== 4 && ancestors.length > 0) {
    throw new PearlError('CERTIFICATE_MALFORMED', `a V${version} certificate carries no ancestor headers`);
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
  } else if (version === 4 && fp8) {
    body = [hash, uint32le(publicData.length), publicData];
  } else {
    throw new PearlError('CERTIFICATE_MALFORMED', `unsupported certificate version: ${String(version)}`);
  }
  const tail = version === 4 ? [varInt(ancestors.length), ...ancestors.map((header) => serializeBlockHeader(header))] : [];
  const out = concat([uint32le(version), ...body, uint32le(proof.length), proof, ...tail]);
  // MsgCertificate checks the whole size before the certificate checks its fields.
  if (out.length > CERTIFICATE_MAX_SIZE) {
    throw new PearlError('CERTIFICATE_MALFORMED', `certificate too large: ${out.length} bytes (max ${CERTIFICATE_MAX_SIZE})`);
  }
  if (version === 4) {
    if (ancestors.length > MAX_CERTIFICATE_V4_ANCESTOR_HEADERS) {
      throw new PearlError('CERTIFICATE_MALFORMED', `too many v4 ancestor headers: ${ancestors.length} (max ${MAX_CERTIFICATE_V4_ANCESTOR_HEADERS})`);
    }
    blobLimit(true, 'fp8 public_data', publicData.length, PUBLIC_DATA_MAX_SIZE_V4, '');
    blobLimit(true, 'fp8 proof_data', proof.length, MAX_ZK_PROOF_SIZE, '');
  } else if (fp8) {
    blobLimit(true, 'proof_data', proof.length, MAX_ZK_PROOF_SIZE, '');
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
export function parseBlock(bytes: Uint8Array, options: BlockCodecOptions = {}): PearlBlock {
  const reader = new Reader(bytes);
  const certificate = readCertificate(reader, options.fp8 ?? true);
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
export function serializeBlock(block: PearlBlock, options: BlockCodecOptions = {}): Uint8Array {
  return concat([
    serializeCertificate(block.certificate, options),
    serializeBlockHeader(block.header),
    varInt(block.transactions.length),
    ...block.transactions.map((tx) => tx.toBuffer()),
  ]);
}

/** Double-SHA256 of the version and public data, as the header commits to it. V4 ancestor headers are outside it. */
export function certificateProofCommitment(certificate: PearlCertificate): Uint8Array {
  return doubleSha256(concat([uint32le(certificate.version), certificate.publicData]));
}

/**
 * Whether a V2 or V3 certificate carries more public data than a dense
 * proof. Pearl keeps V1 and V4 outside this classification, so the dense-only
 * rule never applies to them.
 */
export function isMoECertificate(certificate: PearlCertificate): boolean {
  return (certificate.version === 2 || certificate.version === 3) && certificate.publicData.length > PUBLIC_DATA_SIZE_DENSE_V2;
}

/**
 * The header of the ancestor a V4 proof was keyed by (σ_d), the first 108
 * bytes of its public data, or null for another version or public data too
 * short to hold one.
 */
export function certificateAncestorHeader(certificate: PearlCertificate): PearlBlockHeader | null {
  if (certificate.version !== 4 || certificate.publicData.length < BLOCK_HEADER_SIZE) return null;
  return parseBlockHeader(certificate.publicData.subarray(0, BLOCK_HEADER_SIZE));
}

/** Names of zk-pow's V4 Device discriminants, by value: the GPU whose matmul datapath a proof reproduces. */
export const V4_DEVICE_NAMES: readonly string[] = ['H100', 'B200'];

/** One operand of a V4 statement: A has `m` rows in tiles of `h`, B `n` rows in tiles of `w`. */
export interface V4Operand {
  numRows: number;
  /** HashId discriminant: the keyed BLAKE3 chunk size, 0 to 3 for 128 to 1024 bytes. */
  hashId: number;
  tileSize: number;
}

/** The MoE part of a V4 statement, present when `experts` is not 0. */
export interface V4MoeStatement {
  hashIdR: number;
  hashIdO: number;
  /** The winner expert. */
  w: number;
  oWPrev: number;
  oW: number;
  oLast: number;
  hashRouting: Uint8Array;
  hashOffsets: Uint8Array;
  /** I_A, one row index per row of A's tile. */
  iA: number[];
}

/**
 * A V4 certificate's public data read field by field as zk-pow's
 * PublicParams::from_bytes reads it, with its names. Values are as written;
 * the bounds and cross-field rules Pearl's verifier also applies are not
 * checked.
 */
export interface V4Statement {
  /** σ_d, the ancestor the proof is keyed by. */
  ancestorHeader: PearlBlockHeader;
  /** The common matmul dimension. */
  k: number;
  /** The noise rank. */
  r: number;
  /** Quant discriminant; 0 is Fp8E4M3Prequant, the only one defined. */
  quant: number;
  /** Device discriminant, 0 or 1; its name is V4_DEVICE_NAMES[device]. */
  device: number;
  a: V4Operand;
  b: V4Operand;
  /** Expert count, 0 for a dense job. */
  experts: number;
  hashA: Uint8Array;
  hashB: Uint8Array;
  tileBases: { a: number; b: number };
  hashJackpot: Uint8Array;
  moe: V4MoeStatement | null;
}

/**
 * Reads a V4 certificate's public data into its statement, refusing what
 * zk-pow's decoder refuses for its shape, in its words: a short or long
 * encoding and a Quant, Device or HashId value it does not define. Null for
 * a certificate of another version.
 */
export function certificateStatement(certificate: PearlCertificate): V4Statement | null {
  if (certificate.version !== 4) return null;
  const data = certificate.publicData;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let at = 0;
  const fail = (message: string): never => {
    throw new PearlError('CERTIFICATE_MALFORMED', message);
  };
  const take = (n: number): number => {
    if (data.length - at < n) fail('truncated fp8 public_data');
    at += n;
    return at - n;
  };
  const u8 = (): number => data[take(1)]!;
  const u16 = (): number => view.getUint16(take(2), true);
  const u32 = (): number => view.getUint32(take(4), true);
  const hash = (): Uint8Array => data.slice(take(32), at);
  const hashId = (): number => {
    const value = u8();
    return value <= 3 ? value : fail(`unknown HashId discriminant: ${value}`);
  };
  const operand = (): V4Operand => ({ numRows: u32(), hashId: hashId(), tileSize: u32() });

  const ancestorHeader = parseBlockHeader(data.slice(take(BLOCK_HEADER_SIZE), at));
  const k = u32();
  const r = u16();
  const quant = u8();
  if (quant !== 0) fail(`unknown Quant discriminant: ${quant}`);
  const device = u8();
  if (device >= V4_DEVICE_NAMES.length) fail(`unsupported Device discriminant: ${device}`);
  const b = operand();
  const experts = u16();
  const hashB = hash();
  const a = operand();
  const moeHashIds = experts === 0 ? null : [hashId(), hashId()] as const;
  const hashA = hash();
  const tileBases = { a: u32(), b: u32() };
  const hashJackpot = hash();
  let moe: V4MoeStatement | null = null;
  if (moeHashIds !== null) {
    const w = u16();
    const [oWPrev, oW, oLast] = [u32(), u32(), u32()];
    const [hashRouting, hashOffsets] = [hash(), hash()];
    // I_A has no length of its own: it holds one index per row of A's tile, whose shape is checked first.
    checkLotteryLayout(a.tileSize, b.tileSize);
    if (data.length - at < a.tileSize * 4) fail('truncated fp8 public_data');
    const iA = Array.from({ length: a.tileSize }, () => u32());
    moe = { hashIdR: moeHashIds[0], hashIdO: moeHashIds[1], w, oWPrev, oW, oLast, hashRouting, hashOffsets, iA };
  }
  if (at !== data.length) fail('trailing bytes in fp8 public_data');
  return { ancestorHeader, k, r, quant, device, a, b, experts, hashA, hashB, tileBases, hashJackpot, moe };
}

// The checks verify_zk_proof_v4 makes before the proof, in its order and
// words: the sizes, the statement decoded with its bounds, then
// JobParams::check_ancestry.
function checkV4Ancestry(certificate: PearlCertificate, header: PearlBlockHeader): void {
  const fail = (message: string): never => {
    throw new PearlError('BLOCK_CERTIFICATE_INVALID', message);
  };
  const { publicData, proof } = certificate;
  const ancestors = certificate.ancestorHeaders ?? [];
  if (ancestors.length > MAX_CERTIFICATE_V4_ANCESTOR_HEADERS) fail(`invalid v4 headers length ${(ancestors.length + 1) * BLOCK_HEADER_SIZE}`);
  if (proof.length > MAX_ZK_PROOF_SIZE) fail('FP8 proof too large');
  if (publicData.length < PUBLIC_DATA_MIN_SIZE_V4 || publicData.length > PUBLIC_DATA_MAX_SIZE_V4) {
    fail(`invalid public_data_len ${publicData.length}`);
  }
  checkV4Statement(certificateStatement(certificate)!);
  let child = header;
  [...ancestors, certificateAncestorHeader(certificate)!].forEach((parent, i) => {
    if (!equalBytes(child.prevBlock, blockHash(parent))) fail(`v4 ancestor header at depth ${i + 1} does not connect`);
    child = parent;
  });
}

/**
 * Checks the binding Pearl requires before verifying a proof, in its order:
 * a V1 to V3 proof within the 60000 bytes those versions keep, the
 * certificate's hash equal to the header hash, the header's proof commitment
 * equal to the certificate's, and public data and proof that are not empty.
 * For V4 it then checks what Pearl's verifier checks before the proof: a
 * public data length a statement can have, a statement that decodes and
 * meets Pearl's bounds (CERTIFICATE_MALFORMED otherwise), and ancestor
 * headers that chain the block, parent first, to the ancestor header in the
 * public data. Genesis blocks are hardcoded and fail these checks.
 */
export function checkCertificateBinding(block: PearlBlock): void {
  const { certificate, header } = block;
  if (certificate === null) {
    throw new PearlError('BLOCK_CERTIFICATE_INVALID', 'block has no certificate');
  }
  if (certificate.version !== 4 && certificate.proof.length > LEGACY_MAX_ZK_PROOF_SIZE) {
    throw new PearlError('BLOCK_CERTIFICATE_INVALID',
      `v${certificate.version} proof rejected: legacy proof data too large: ${certificate.proof.length} bytes (max ${LEGACY_MAX_ZK_PROOF_SIZE})`);
  }
  const display = (hash: Uint8Array): string => toHex(Uint8Array.from(hash).reverse());
  const hash = blockHash(header);
  if (!equalBytes(certificate.hash, hash)) {
    throw new PearlError('BLOCK_CERTIFICATE_INVALID', `block hash mismatch: certificate has ${display(certificate.hash)}, header has ${display(hash)}`);
  }
  const commitment = certificateProofCommitment(certificate);
  if (!equalBytes(header.proofCommitment, commitment)) {
    throw new PearlError('BLOCK_CERTIFICATE_INVALID',
      `proof commitment mismatch: header has ${display(header.proofCommitment)}, certificate has ${display(commitment)}`);
  }
  if (certificate.publicData.length === 0) {
    throw new PearlError('BLOCK_CERTIFICATE_INVALID', 'empty public data');
  }
  if (certificate.proof.length === 0) {
    throw new PearlError('BLOCK_CERTIFICATE_INVALID', 'empty proof data');
  }
  if (certificate.version === 4) checkV4Ancestry(certificate, header);
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

/**
 * Throws BLOCK_MERKLE_ROOT_MISMATCH, with pearld's message, unless the
 * header's merkle root is that of the block's transactions.
 */
export function checkMerkleRoot(block: PearlBlock): void {
  const calculated = calculateMerkleRoot(block.transactions);
  if (!equalBytes(block.header.merkleRoot, calculated)) {
    const display = (hash: Uint8Array): string => toHex(Uint8Array.from(hash).reverse());
    throw new PearlError(
      'BLOCK_MERKLE_ROOT_MISMATCH',
      `block merkle root is invalid - block header indicates ${display(block.header.merkleRoot)}, but calculated value is ${display(calculated)}`,
    );
  }
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
