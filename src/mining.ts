// Mining support for pool operators and tool authors: block templates turned
// into blocks, the hashes that bind a miner's work to a header, the jackpot
// bounds a certificate's public data must meet, and pool statistics.
//
// A Pearl block's proof of work is a certificate. Its public data commits to
// the matrices a miner multiplied (hash A and hash B, keyed BLAKE3 Merkle
// roots), the mining configuration, and hash_jackpot, a BLAKE3 hash of one
// tile of the noisy product. The block is won when hash_jackpot, read as a
// little-endian 256-bit number, is at most the header's target scaled by the
// work one attempt costs. Everything here is cheap hashing and arithmetic;
// the zero-knowledge proof that hash_jackpot really came from that work is
// not verified.

/**
 * Mining: block templates into blocks, job keys, matrix commitments, noise
 * seeds, jackpot bounds by certificate version, the rank-penalty rule, and
 * pool effort and luck. The ZK proof is not verified.
 *
 * @module
 */

import { blake3 } from '@noble/hashes/blake3';
import { sha256 } from '@noble/hashes/sha2';
import { Transaction } from 'bitcoinjs-lib';
import { toOutputScript } from './address.js';
import {
  calculateMerkleRoot,
  certificateProofCommitment,
  certificateStatement,
  checkCertificateBinding,
} from './block.js';
import type { CertificateVersion, PearlBlock, PearlCertificate, V4Statement } from './block.js';
import { PUBLIC_DATA_MAX_SIZE_V4, PUBLIC_DATA_MIN_SIZE_V4, PUBLIC_DATA_SIZE_V1 } from './block.js';
import { BLOCK_HEADER_SIZE, blockHash, parseBlockHeader, serializeBlockHeader } from './blockheader.js';
import type { PearlBlockHeader } from './blockheader.js';
import { bitsToTarget, requiredCertVersion } from './consensus.js';
import { PearlError, PolicyError } from './errors.js';
import { concat, equalBytes, fromHex, toHex, uint32le } from './internal/bytes.js';
import { checkV4Statement } from './internal/v4-statement.js';
import type { PearlNetwork } from './networks.js';
import { checkSanity } from './policy.js';
import type { BlockTemplate } from './rpc.js';
import { encodeScriptNumber, scriptPush } from './script.js';

/** Bytes of a header without its proof commitment: what a miner's job key and pearl-gateway's jobs hash. */
export const INCOMPLETE_HEADER_SIZE = 76;
/** mining.CoinbaseFlags: the text pearld's own miner writes into its coinbases. */
export const PEARLD_COINBASE_TEXT = '/P2SH/pearld/';

// blockchain.WitnessMagicBytes and the zero witness nonce pearld's coinbases carry.
const WITNESS_MAGIC = Uint8Array.of(0x6a, 0x24, 0xaa, 0x21, 0xa9, 0xed);
const WITNESS_NONCE = new Uint8Array(32);
const TWO_64 = 1n << 64n;

/** One output of a coinbase: an output script and the grain it is paid. */
export interface CoinbaseOutput {
  readonly script: Uint8Array;
  /** In grain. */
  readonly value: bigint;
}

/** What goes into a coinbase transaction. */
export interface CoinbaseOptions {
  readonly height: number;
  /** Outputs before the witness commitment, which is always appended. */
  readonly outputs: readonly CoinbaseOutput[];
  /** The 32-byte witness commitment; see witnessCommitmentFor. */
  readonly witnessCommitment: Uint8Array;
  /** Pushed after the height as pearld's AddInt64 does; 0 unless given. 0 to 2^64 - 1, read as Go's int64 cast reads it. */
  readonly extraNonce?: bigint;
  /**
   * What follows the height and extra nonce in the script: a string is
   * pushed as UTF-8 data, as pearld pushes PEARLD_COINBASE_TEXT; bytes go in
   * as they are, as getblocktemplate's `coinbaseaux.flags` are meant to.
   * Nothing unless given.
   */
  readonly text?: string | Uint8Array;
}

function pushInt(value: bigint): Uint8Array {
  return scriptPush(encodeScriptNumber(value));
}

/**
 * The coinbase signature script pearld writes (standardCoinbaseScript): the
 * height, the extra nonce, then the text. Its length is not checked here;
 * coinbaseTransaction checks it.
 */
export function coinbaseScript(height: number, extraNonce = 0n, text?: string | Uint8Array): Uint8Array {
  if (!Number.isInteger(height) || height < 0 || height > 0x7fffffff) {
    throw new RangeError(`height must be 0 to ${0x7fffffff}, got ${height}`);
  }
  if (typeof extraNonce !== 'bigint' || extraNonce < 0n || extraNonce >= TWO_64) {
    throw new RangeError('extraNonce must be a bigint from 0 to 2^64 - 1');
  }
  // standardCoinbaseScript takes a uint64 and pushes int64(extraNonce).
  const nonce = extraNonce >= TWO_64 / 2n ? extraNonce - TWO_64 : extraNonce;
  const tail = text === undefined ? new Uint8Array(0) : typeof text === 'string' ? scriptPush(new TextEncoder().encode(text)) : text;
  return concat([pushInt(BigInt(height)), pushInt(nonce), tail]);
}

/**
 * The witness commitment pearld puts in a block's coinbase
 * (AddWitnessCommitment): double SHA-256 of the witness merkle root, the
 * coinbase's wtxid counted as zero, and the zero witness nonce. The coinbase
 * itself does not enter it, so the transactions after it are all it needs.
 */
export function witnessCommitmentFor(transactions: readonly Transaction[]): Uint8Array {
  const placeholder = new Transaction();
  const root = calculateMerkleRoot([placeholder, ...transactions], true);
  return sha256(sha256(concat([root, WITNESS_NONCE])));
}

/**
 * A coinbase transaction as pearld builds one: version 1, one input with the
 * coinbase script and sequence 0xffffffff, the outputs, then the witness
 * commitment output, and the zero witness nonce. Throws with pearld's
 * message when checkSanity would refuse it, a script outside 2 to 100 bytes
 * included.
 */
export function coinbaseTransaction(options: CoinbaseOptions): Transaction {
  const { witnessCommitment } = options;
  if (!(witnessCommitment instanceof Uint8Array) || witnessCommitment.length !== 32) {
    throw new TypeError('witnessCommitment must be 32 bytes');
  }
  const tx = new Transaction();
  tx.version = 1;
  tx.addInput(new Uint8Array(32), 0xffffffff, 0xffffffff, coinbaseScript(options.height, options.extraNonce ?? 0n, options.text));
  for (const output of options.outputs) tx.addOutput(output.script, output.value);
  tx.addOutput(concat([WITNESS_MAGIC, witnessCommitment]), 0n);
  tx.setWitness(0, [WITNESS_NONCE.slice()]);
  try {
    checkSanity(tx);
  } catch (error) {
    // checkSanity refuses every coinbase last, once its other checks have passed.
    if (!(error instanceof PolicyError && error.code === 'SANITY_COINBASE')) throw error;
  }
  return tx;
}

/** How blockSkeleton fills the parts of a block a template leaves to the miner. */
export interface SkeletonOptions {
  /** The network the template is for; addresses are read on it and the certificate version is checked against it. */
  readonly network: PearlNetwork;
  /** An address paid the whole `coinbasevalue`. Give this or `outputs`. */
  readonly payTo?: string;
  /** Coinbase outputs, worth at most `coinbasevalue` together. Give this or `payTo`. */
  readonly outputs?: readonly CoinbaseOutput[];
  /** 0 unless given; see CoinbaseOptions. */
  readonly extraNonce?: bigint;
  /** The coinbase text; the template's `coinbaseaux.flags` unless given. See CoinbaseOptions. */
  readonly text?: string | Uint8Array;
  /** The header time, Unix seconds; `curtime` unless given. Must lie within `mintime` and `maxtime` when the template gives them. */
  readonly time?: number;
}

/** A block without its certificate: everything a miner commits to, and what sealBlock needs to finish it. */
export interface BlockSkeleton {
  readonly height: number;
  /** The certificate version the block must carry, the template's `requiredcertversion`. */
  readonly certVersion: CertificateVersion;
  /** The header, its proof commitment zero until sealBlock sets it. */
  readonly header: PearlBlockHeader;
  /** Coinbase first, then the template's transactions in its order. */
  readonly transactions: readonly Transaction[];
  readonly witnessCommitment: Uint8Array;
  /** For a V4 template, the ancestors a proof may be keyed by, parent first; empty otherwise. */
  readonly ancestorHeaders: readonly PearlBlockHeader[];
}

function templateError(message: string): PearlError {
  return new PearlError('MINING_TEMPLATE_INVALID', message);
}

const display = (hash: Uint8Array): string => toHex(Uint8Array.from(hash).reverse());

/**
 * Turns a getblocktemplate result in `coinbasevalue` mode into a block
 * skeleton: a coinbase with the height, the extra nonce, the text, the
 * payouts and the witness commitment, the merkle root, and the header. It
 * checks what the template says against itself and throws
 * MINING_TEMPLATE_INVALID when the transactions do not hash to their ids,
 * the witness commitment or target disagree with what they are computed
 * from, the certificate version is not the network's for the height, or the
 * V4 ancestor headers do not chain to the previous block.
 */
export function blockSkeleton(template: BlockTemplate, options: SkeletonOptions): BlockSkeleton {
  const { network } = options;
  const value = template.coinbasevalue;
  if (value === undefined) throw templateError('the template has no coinbasevalue; ask for one with the coinbasevalue capability');
  const height = template.height;
  const certVersion = template.requiredcertversion as CertificateVersion;
  const want = requiredCertVersion(network, height);
  if (certVersion !== want) {
    throw templateError(`the template asks for certificate version ${template.requiredcertversion} at height ${height}, ${network.name} needs ${want}`);
  }
  if (!/^[0-9a-f]{1,8}$/i.test(template.bits)) throw templateError(`bits ${template.bits} are not compact bits`);
  const bits = Number.parseInt(template.bits, 16);
  if (template.target !== undefined && template.target !== bitsToTarget(bits).toString(16).padStart(64, '0')) {
    throw templateError(`target ${template.target} is not that of bits ${template.bits}`);
  }

  const transactions = template.transactions.map((entry, i) => {
    let tx: Transaction;
    try {
      tx = Transaction.fromHex(entry.data);
    } catch {
      throw templateError(`transaction ${i + 1} could not be decoded`);
    }
    if (tx.getId() !== entry.txid) throw templateError(`transaction ${i + 1} hashes to ${tx.getId()}, the template says ${entry.txid}`);
    const wtxid = display(tx.getHash(true));
    if (wtxid !== entry.hash) throw templateError(`transaction ${i + 1} has witness hash ${wtxid}, the template says ${entry.hash}`);
    return tx;
  });
  const witnessCommitment = witnessCommitmentFor(transactions);
  const given = template.default_witness_commitment;
  if (given !== undefined && given !== toHex(witnessCommitment)) {
    throw templateError(`default_witness_commitment ${given} is not ${toHex(witnessCommitment)}, computed from the transactions`);
  }

  if ((options.payTo === undefined) === (options.outputs === undefined)) throw new TypeError('give payTo or outputs');
  const outputs = options.outputs ?? [{ script: toOutputScript(options.payTo!, network), value }];
  const paid = outputs.reduce((sum, output) => sum + output.value, 0n);
  if (paid > value) throw new PearlError('AMOUNT_OUT_OF_RANGE', `the coinbase outputs pay ${paid} grain, the template allows ${value}`);
  const text = options.text ?? (template.coinbaseaux === undefined ? undefined : fromHex(template.coinbaseaux.flags));
  const coinbase = coinbaseTransaction({ height, outputs, witnessCommitment, extraNonce: options.extraNonce ?? 0n, ...(text === undefined ? {} : { text }) });

  const time = options.time ?? template.curtime;
  if ((template.mintime !== undefined && time < template.mintime) || (template.maxtime !== undefined && time > template.maxtime)) {
    throw new RangeError(`time ${time} is outside the template's ${template.mintime} to ${template.maxtime}`);
  }
  const all = [coinbase, ...transactions];
  const header: PearlBlockHeader = {
    version: template.version,
    prevBlock: fromHex(template.previousblockhash).reverse(),
    merkleRoot: calculateMerkleRoot(all),
    timestamp: time,
    bits,
    proofCommitment: new Uint8Array(32),
  };
  const ancestorHeaders = (template.ancestorheaders ?? []).map((hex, i) => {
    const bytes = fromHex(hex);
    if (bytes.length !== BLOCK_HEADER_SIZE) throw templateError(`ancestor header ${i} is ${bytes.length} bytes, not ${BLOCK_HEADER_SIZE}`);
    return parseBlockHeader(bytes);
  });
  let child = header;
  ancestorHeaders.forEach((ancestor, i) => {
    if (!equalBytes(child.prevBlock, blockHash(ancestor))) throw templateError(`ancestor header ${i} is not the parent of the one before it`);
    child = ancestor;
  });
  return { height, certVersion, header, transactions: all, witnessCommitment, ancestorHeaders };
}

/** The first 76 bytes of a header: everything but the proof commitment, the bytes a mining job is keyed by. */
export function incompleteHeader(header: PearlBlockHeader): Uint8Array {
  return serializeBlockHeader(header).slice(0, INCOMPLETE_HEADER_SIZE);
}

/** What a prover hands back for a skeleton: the certificate's public data and proof. */
export interface ProvenWork {
  readonly publicData: Uint8Array;
  readonly proof: Uint8Array;
  /** V4 only: the headers between the block and the ancestor the proof is keyed by, parent first. */
  readonly ancestorHeaders?: readonly PearlBlockHeader[];
}

/**
 * Finishes a skeleton into a block: the certificate of the skeleton's
 * version around the proven work, the header's proof commitment, and the
 * certificate's block hash, as pearld's miner seals a block. The binding is
 * then checked with checkCertificateBinding. The proof is not verified.
 */
export function sealBlock(skeleton: BlockSkeleton, work: ProvenWork): PearlBlock {
  const version = skeleton.certVersion;
  const certificate: PearlCertificate = { version, hash: new Uint8Array(32), publicData: work.publicData, proof: work.proof };
  if (version === 4) certificate.ancestorHeaders = [...(work.ancestorHeaders ?? [])];
  else if ((work.ancestorHeaders ?? []).length > 0) throw new TypeError(`a V${version} certificate carries no ancestor headers`);
  const header = { ...skeleton.header, proofCommitment: certificateProofCommitment(certificate) };
  certificate.hash = blockHash(header);
  const block: PearlBlock = { certificate, header, transactions: [...skeleton.transactions] };
  checkCertificateBinding(block);
  return block;
}

/** zk-pow's MiningConfiguration::SERIALIZED_SIZE. */
export const MINING_CONFIGURATION_SIZE = 52;
/** PublicProofParams::WIRE_SIZE: V2 and V3 public data of a dense proof. */
export const PUBLIC_DATA_SIZE = 164;
/** sanity_checks::PENALTY_BASE_RANK: the lowest noise rank the rank-penalty rule accepts. */
export const PENALTY_BASE_RANK = 128;
const MIN_MOE_WIRE_SIZE = 199;
const MAX_OUTER_INDICES = 128;
const MAX_NUM_EXPERTS = 1024;
const MAX_WIRE_SIZE = MIN_MOE_WIRE_SIZE + MAX_OUTER_INDICES * 4 + MAX_NUM_EXPERTS * 4;
const PATTERN_DIMS = 3;
const MAX_U256 = (1n << 256n) - 1n;

/**
 * What a V2 or V3 miner commits to before it mines (zk-pow's
 * MiningConfiguration): the common dimension k, the noise rank, and the rows
 * of A and columns of B that one jackpot tile hashes, as periodic index
 * patterns starting at 0.
 */
export interface MiningConfiguration {
  readonly commonDim: number;
  readonly rank: number;
  /** MMAType; 0, Int7xInt7ToInt32, is the only one. */
  readonly mmaType: number;
  /** Row offsets of a tile within A's pattern period. */
  readonly rows: readonly number[];
  /** Column offsets of a tile within B's pattern period. */
  readonly cols: readonly number[];
  /** Set for a Mixture-of-Experts (GROUPED_GEMM) job. */
  readonly moe: { readonly experts: number; readonly topK: number } | null;
}

type Shape = [number, number][];

function malformed(message: string): never {
  throw new PearlError('CERTIFICATE_MALFORMED', message);
}

// PeriodicPattern::from_bytes: (factor - 1, length - 1) per dimension.
function patternFromBytes(data: Uint8Array): Shape {
  const shape: Shape = [];
  let minStride = 1;
  let done = false;
  for (let i = 0; i < PATTERN_DIMS; i += 1) {
    const factor = 1 + data[2 * i]!;
    const length = 1 + data[2 * i + 1]!;
    if (length === 1 || done) {
      if (factor !== 1 || length !== 1) malformed('Using non-canonical representation');
      done = true;
    } else if (factor <= 1 && minStride !== 1) {
      malformed('A single stride must not be broken');
    }
    if (minStride > Math.floor((1 << 24) / (factor * length))) malformed('Pattern must have period <= 2^24');
    const stride = factor * minStride;
    shape.push([stride, length]);
    minStride = stride * length;
  }
  return shape;
}

function patternToBytes(shape: Shape): Uint8Array {
  const out = new Uint8Array(2 * PATTERN_DIMS);
  let minStride = 1;
  shape.forEach(([stride, length], i) => {
    out[2 * i] = stride / minStride - 1;
    out[2 * i + 1] = length - 1;
    minStride = stride * length;
  });
  return out;
}

function patternToList(shape: Shape): number[] {
  let list = [0];
  for (const [stride, length] of shape) {
    const next: number[] = [];
    for (let i = 0; i < length; i += 1) for (const r of list) next.push(r + i * stride);
    list = next;
  }
  return list;
}

// PeriodicPattern::from_list.
function patternFromList(pattern: readonly number[]): Shape {
  if (pattern.length === 0) malformed('Pattern cannot be empty');
  for (let i = 1; i < pattern.length; i += 1) {
    if (!(pattern[i - 1]! < pattern[i]!)) malformed('Pattern must be sorted and have no duplicates');
  }
  if (pattern[0] !== 0) malformed('Pattern must start at 0');
  let p = [...pattern];
  const shape: Shape = [];
  while (p.length > 1) {
    let found = false;
    for (let period = 1; period < p.length; period += 1) {
      if (p.length % period !== 0) continue;
      const s = p[period]!;
      let periodic = true;
      for (let i = 0; i < p.length - period; i += 1) {
        if (p[i]! + s !== p[i + period]) {
          periodic = false;
          break;
        }
      }
      if (periodic) {
        shape.push([s, p.length / period]);
        p = p.slice(0, period);
        found = true;
        break;
      }
    }
    if (!found) malformed('Pattern is not periodic');
  }
  shape.reverse();
  const last = shape[shape.length - 1];
  const period = last === undefined ? 1 : last[0] * last[1];
  while (shape.length < PATTERN_DIMS) shape.push([period, 1]);
  let valid: boolean;
  try {
    const restored = patternFromBytes(patternToBytes(shape));
    valid = restored.every(([s, l], i) => s === shape[i]![0] && l === shape[i]![1]);
  } catch {
    valid = false;
  }
  if (!valid) malformed('Constructed pattern is not valid');
  return shape;
}

function offsetIsValid(shape: Shape, offset: number): boolean {
  for (let i = shape.length - 1; i >= 0; i -= 1) {
    const [stride, length] = shape[i]!;
    offset %= stride * length;
    if (offset >= stride) return false;
  }
  return true;
}

/**
 * Reads the 52-byte mining configuration as zk-pow does, refusing in its
 * words what it refuses: a wrong length, an unknown MMAType, a
 * non-canonical pattern, nonzero reserved bytes, and top_k without experts.
 */
export function parseMiningConfiguration(bytes: Uint8Array): MiningConfiguration {
  if (bytes.length !== MINING_CONFIGURATION_SIZE) malformed(`Expected ${MINING_CONFIGURATION_SIZE} bytes, got ${bytes.length}`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const commonDim = view.getUint32(0, true);
  const rank = view.getUint16(4, true);
  const mmaType = view.getUint16(6, true);
  if (mmaType !== 0) malformed(`Invalid MMAType: ${mmaType}`);
  const rows = patternToList(patternFromBytes(bytes.subarray(8, 14)));
  const cols = patternToList(patternFromBytes(bytes.subarray(14, 20)));
  const experts = view.getUint16(20, true);
  const topK = view.getUint16(22, true);
  if (bytes.subarray(24, 52).some((b) => b !== 0)) malformed('Reserved trailer bytes must be zero');
  if (experts === 0 && topK !== 0) malformed('top_k must be 0 when e == 0 (non-MoE)');
  return { commonDim, rank, mmaType, rows, cols, moe: experts === 0 ? null : { experts, topK } };
}

/** Writes a mining configuration in its 52-byte form, building each pattern as PeriodicPattern::from_list does. */
export function serializeMiningConfiguration(config: MiningConfiguration): Uint8Array {
  const out = new Uint8Array(MINING_CONFIGURATION_SIZE);
  const view = new DataView(out.buffer);
  view.setUint32(0, config.commonDim, true);
  view.setUint16(4, config.rank, true);
  view.setUint16(6, config.mmaType, true);
  out.set(patternToBytes(patternFromList(config.rows)), 8);
  out.set(patternToBytes(patternFromList(config.cols)), 14);
  if (config.moe !== null) {
    if (config.moe.experts === 0) throw new RangeError('a MoE configuration needs experts');
    view.setUint16(20, config.moe.experts, true);
    view.setUint16(22, config.moe.topK, true);
  }
  return out;
}

/** The length of the inner product one tile entry sums: k rounded down to a multiple of the rank. */
export function dotProductLength(config: MiningConfiguration): number {
  if (config.rank === 0) throw new RangeError('rank must be nonzero');
  return config.commonDim - (config.commonDim % config.rank);
}

/** The MoE part of V2 or V3 public data. */
export interface MoePublicData {
  readonly expertIndex: number;
  /** Exclusive ends of each expert's slice of the routing, one per expert. */
  readonly routingOffsets: readonly number[];
  readonly hashRouting: Uint8Array;
  /** Positions in A of the tile's tokens. */
  readonly outerIndices: readonly number[];
}

/** V2 or V3 public data read field by field (zk-pow's PublicProofParams). */
export interface PublicData {
  readonly config: MiningConfiguration;
  /** The 52 bytes `config` was read from, as the job key hashes them. */
  readonly configBytes: Uint8Array;
  /** Commitment to A: its keyed Merkle root (see matrixCommitment). */
  readonly hashA: Uint8Array;
  /** Commitment to B transposed. */
  readonly hashB: Uint8Array;
  /** The winning tile's hash, compared with the target as a little-endian number. */
  readonly hashJackpot: Uint8Array;
  /** Rows of A. */
  readonly m: number;
  /** Columns of B (per expert in MoE). */
  readonly n: number;
  /** The tile's first row and column. */
  readonly tRows: number;
  readonly tCols: number;
  readonly moe: MoePublicData | null;
}

/** Whether a length is one V2 or V3 public data can have (PublicProofParams::is_valid_wire_size). */
export function isValidPublicDataSize(length: number): boolean {
  return length === PUBLIC_DATA_SIZE || (length >= MIN_MOE_WIRE_SIZE && length <= MAX_WIRE_SIZE);
}

/**
 * Reads V2 or V3 public data as zk-pow's from_wire_bytes does, with its
 * refusals in its words (CERTIFICATE_MALFORMED). Its structure rules are
 * checkPublicData.
 */
export function parsePublicData(bytes: Uint8Array): PublicData {
  if (bytes.length < PUBLIC_DATA_SIZE) malformed(`public_data too short: need at least ${PUBLIC_DATA_SIZE} bytes`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const configBytes = bytes.slice(0, MINING_CONFIGURATION_SIZE);
  const config = parseMiningConfiguration(configBytes);
  const hashA = bytes.slice(52, 84);
  const hashB = bytes.slice(84, 116);
  const hashJackpot = bytes.slice(116, 148);
  const [m, n, tRows, tCols] = [148, 152, 156, 160].map((at) => view.getUint32(at, true)) as [number, number, number, number];
  let moe: MoePublicData | null = null;
  if (bytes.length === PUBLIC_DATA_SIZE) {
    if (config.moe !== null) malformed('mining_config selects GROUPED_GEMM but public_data has no MoE tail');
  } else {
    if (config.moe === null) malformed('public_data has a MoE tail but mining_config is not GROUPED_GEMM');
    const experts = config.moe.experts;
    if (experts > MAX_NUM_EXPERTS) malformed(`number of experts ${experts} exceeds maximum ${MAX_NUM_EXPERTS}`);
    const need = MIN_MOE_WIRE_SIZE + 4 * experts;
    if (bytes.length < need) malformed(`MoE public_data truncated (need ${need} bytes after core)`);
    let at = PUBLIC_DATA_SIZE;
    const expertIndex = view.getUint16(at, true);
    at += 2;
    const routingOffsets = Array.from({ length: experts }, (_, i) => view.getUint32(at + 4 * i, true));
    at += 4 * experts;
    const hashRouting = bytes.slice(at, at + 32);
    const count = bytes[at + 32]!;
    at += 33;
    if (count > MAX_OUTER_INDICES) malformed(`outer_indices length ${count} exceeds max ${MAX_OUTER_INDICES}`);
    const expected = MIN_MOE_WIRE_SIZE + 4 * count + 4 * experts;
    if (bytes.length !== expected) malformed(`MoE public_data length mismatch: expected ${expected} bytes, got ${bytes.length}`);
    const outerIndices = Array.from({ length: count }, (_, i) => view.getUint32(at + 4 * i, true));
    moe = { expertIndex, routingOffsets, hashRouting, outerIndices };
  }
  const rowsShape = patternFromBytes(configBytes.subarray(8, 14));
  const colsShape = patternFromBytes(configBytes.subarray(14, 20));
  if (!offsetIsValid(rowsShape, tRows)) malformed('t_rows must be a valid offset for rows_pattern');
  if (!offsetIsValid(colsShape, tCols)) malformed('t_cols must be a valid offset for cols_pattern');
  if (!(tRows < m)) malformed(`t_rows=${tRows} must be < m=${m}`);
  if (!(tCols < n)) malformed(`t_cols=${tCols} must be < n=${n}`);
  return { config, configBytes, hashA, hashB, hashJackpot, m, n, tRows, tCols, moe };
}

const isPowerOfTwo = (x: number): boolean => x > 0 && (x & (x - 1)) === 0;

/**
 * The structure rules zk-pow's verifier applies to V2 and V3 public data
 * before the jackpot and the proof (public_params_sanity_check), in its
 * order and words: rank, k, tile shape, matrix sizes, the tile inside the
 * matrices and, for MoE, the experts, routing offsets and token indices.
 * Throws CERTIFICATE_MALFORMED.
 */
export function checkPublicData(data: PublicData): void {
  checkStructure(data, 2);
}

// public_params_sanity_check; V1's (zk-pow's v1 module) has no upper bound on the tile and no MoE.
function checkStructure(data: PublicData, version: 1 | 2): void {
  const { config, m, n, tRows, tCols } = data;
  const k = config.commonDim;
  const r = config.rank;
  const h = config.rows.length;
  const w = config.cols.length;
  if (!(isPowerOfTwo(r) && r >= 32 && r <= 1024)) malformed(`Rank must be 2^5..2^10 || r=${r}`);
  const dot = dotProductLength(config);
  const workerInput = (h + w) * dot;
  if (r % 16 !== 0) malformed(`r must be divisible by 16 || r=${r}`);
  if (k > 1 << 16) malformed(`k must be <= 2^16 || k=${k}`);
  if (k % 64 !== 0) malformed(`k must be divisible by 64 || k=${k}`);
  if (k > 4 * r * r) malformed(`k must be no more than 4r^2 || k=${k} r=${r}`);
  if (k < 16 * r) malformed(`k must be >= 16r || k=${k} r=${r}`);
  if (k < 1024) malformed(`k must be >= 1024 || k=${k}`);
  if (h % 2 !== 0 || w % 2 !== 0) malformed(`Inner hash tile dimensions must be divisible by 2 || h=${h} w=${w}`);
  if (h * w < 32) malformed(`Inner hash size must be >= 32 || h=${h} w=${w}`);
  if (version === 2 && h * w > 256) malformed(`Inner hash size must be <= 256 || h=${h} w=${w}`);
  if (dot % 8 !== 0) malformed(`dot_product_length must be divisible by DWORD_SIZE=8 || got ${dot}`);
  if (m > 1 << 24) malformed(`m must be <= 2^24 || m=${m}`);
  if (n > 1 << 24) malformed(`n must be <= 2^24 || n=${n}`);
  if (workerInput > 1 << 22) malformed(`Worker input supported up to 4 MiB, got ${workerInput} bytes`);
  const rmax = Math.max(...config.rows);
  const cmax = Math.max(...config.cols);
  if (!(tRows + rmax < m)) malformed(`t_rows=${tRows} + pattern max=${rmax} must be < m=${m}`);
  if (!(tCols + cmax < n)) malformed(`t_cols=${tCols} + pattern max=${cmax} must be < n=${n}`);
  if ((config.moe !== null) !== (data.moe !== null)) {
    malformed(`ensure_eq failed: mining_config.moe and public params moe must both be present or both absent || left = ${config.moe !== null}, right = ${data.moe !== null}`);
  }
  if (config.moe === null || data.moe === null) return;
  const { experts: e, topK } = config.moe;
  const moe = data.moe;
  const offsets = moe.routingOffsets;
  if (!(e > 0)) malformed('number of experts e must be > 0 in the MoE setting');
  if (!(topK > 0)) malformed('top_k must be > 0 in the MoE setting');
  if (e > MAX_NUM_EXPERTS) malformed(`number of experts ${e} exceeds maximum ${MAX_NUM_EXPERTS}`);
  if (e !== offsets.length) malformed('weight and routing offsets should have the same length, equal to the number of experts');
  if (!(topK < e)) malformed('top_k should be < number of experts');
  if (!(moe.expertIndex < e)) malformed('expert_idx should be < number of experts');
  const entries = m * topK;
  if (entries > 0xffffffff) malformed('m * top_k overflows u32');
  const last = offsets[offsets.length - 1]!;
  if (last !== entries) {
    malformed(`ensure_eq failed: The last routing offset should be equal to the total number of routing entries (m*top_k=${entries}) || left = ${last}, right = ${entries}`);
  }
  for (let i = 1; i < offsets.length; i += 1) {
    if (!(offsets[i - 1]! <= offsets[i]!)) malformed('The routing offsets must be monotonically non-decreasing');
  }
  for (let i = 1; i < offsets.length; i += 1) {
    if (!(offsets[i]! - offsets[i - 1]! <= m)) malformed('One expert holds at most all m tokens.');
  }
  if (!(offsets[0]! <= m)) malformed('The first routing offset should be <= m since expert 0 can hold at most m tokens');
  if (!(n * e <= 1 << 24)) malformed('Total number of columns across all experts must fit in 24 bits');
  const start = moe.expertIndex === 0 ? 0 : offsets[moe.expertIndex - 1]!;
  const nextStart = offsets[moe.expertIndex]!;
  for (const inner of config.rows.map((i) => i + tRows)) {
    const index = start + inner;
    if (!(index < entries)) {
      malformed(`routing index ${index} (expert offset ${start} + inner ${inner}) falls in the padding region (real routing entries ${entries})`);
    }
    if (!(index < nextStart)) {
      malformed(`routing index ${index} (expert offset ${start} + inner ${inner}) falls in the next expert's region (next expert offset ${nextStart})`);
    }
  }
  if (moe.outerIndices.length !== config.rows.length) malformed('outer_indices length must match a_inner_indices length');
  for (let i = 1; i < moe.outerIndices.length; i += 1) {
    if (!(moe.outerIndices[i - 1]! < moe.outerIndices[i]!)) malformed('outer_indices must be sorted with no duplicates');
  }
  for (const outer of moe.outerIndices) if (!(outer < m)) malformed('outer indices must be <= m');
}

const BLAKE3_CHUNK = 1024;
// blake3("pearl/cert-v3/noise-seed/A") and "/B", zk-pow's SEED_SALT_A and SEED_SALT_B.
const SEED_SALT_A = blake3(new TextEncoder().encode('pearl/cert-v3/noise-seed/A'));
const SEED_SALT_B = blake3(new TextEncoder().encode('pearl/cert-v3/noise-seed/B'));

function hash32(data: Uint8Array, key?: Uint8Array): Uint8Array {
  return key === undefined ? blake3(data) : blake3(data, { key });
}

function assert32(value: Uint8Array, label: string): void {
  if (!(value instanceof Uint8Array) || value.length !== 32) throw new TypeError(`${label} must be 32 bytes`);
}

/**
 * The job key a V2 or V3 miner's commitments are keyed by: BLAKE3 of the
 * 76-byte incomplete header and the 52-byte mining configuration. Both
 * matrix commitments and the noise seeds hang off it, so work done for one
 * header is worth nothing for another.
 */
export function jobKey(header: Uint8Array | PearlBlockHeader, config: Uint8Array | MiningConfiguration): Uint8Array {
  const head = header instanceof Uint8Array ? header : incompleteHeader(header);
  if (head.length !== INCOMPLETE_HEADER_SIZE) throw new RangeError(`an incomplete header is ${INCOMPLETE_HEADER_SIZE} bytes, got ${head.length}`);
  const conf = config instanceof Uint8Array ? config : serializeMiningConfiguration(config);
  if (conf.length !== MINING_CONFIGURATION_SIZE) throw new RangeError(`a mining configuration is ${MINING_CONFIGURATION_SIZE} bytes, got ${conf.length}`);
  return hash32(concat([head, conf]));
}

/**
 * Hash A or hash B: the root of the BLAKE3 Merkle tree pearl-blake3 builds
 * over a matrix's bytes, zero-padded to a multiple of 1024, keyed by the job
 * key. A is hashed row-major as int8; B is hashed transposed, so its columns
 * are the rows. pearl-blake3 pairs chunks layer by layer, which gives the
 * same root as one keyed BLAKE3 hash of the padded bytes.
 */
export function matrixCommitment(matrix: Uint8Array, key: Uint8Array): Uint8Array {
  assert32(key, 'key');
  if (matrix.length === 0) throw new RangeError('a matrix must not be empty');
  const padded = new Uint8Array(Math.ceil(matrix.length / BLAKE3_CHUNK) * BLAKE3_CHUNK);
  padded.set(matrix);
  return hash32(padded, key);
}

function bindRoot(root: Uint8Array, dim: number, salt: Uint8Array): Uint8Array {
  assert32(root, 'root');
  if (!Number.isInteger(dim) || dim < 0 || dim > 0xffffffff) throw new RangeError('dim must be a 32-bit unsigned integer');
  const message = new Uint8Array(64);
  message.set(root);
  message.set(uint32le(dim), 32);
  return hash32(message, salt);
}

/** V3's salted hash A (bind_root_a): commits the row count m before the seed chain. */
export function saltedRootA(hashA: Uint8Array, m: number): Uint8Array {
  return bindRoot(hashA, m, SEED_SALT_A);
}

/** V3's salted hash B (bind_root_b): commits the column count n before the seed chain. */
export function saltedRootB(hashB: Uint8Array, n: number): Uint8Array {
  return bindRoot(hashB, n, SEED_SALT_B);
}

/**
 * The MoE fold of the routing into A's side (compute_hash_activations):
 * BLAKE3(hashA || BLAKE3(hashRouting || offsets hash)), the offsets hashed as
 * little-endian u32s zero-padded to 1024 bytes under the job key.
 */
export function hashActivations(hashA: Uint8Array, hashRouting: Uint8Array, routingOffsets: readonly number[], key: Uint8Array): Uint8Array {
  assert32(hashA, 'hashA');
  assert32(hashRouting, 'hashRouting');
  const offsets = concat(routingOffsets.map((o) => uint32le(o)));
  const padded = new Uint8Array(Math.ceil(offsets.length / BLAKE3_CHUNK) * BLAKE3_CHUNK);
  padded.set(offsets);
  const hashOffsets = hash32(padded, key);
  return hash32(concat([hashA, hash32(concat([hashRouting, hashOffsets]))]));
}

/** What the noise-seed chain takes. */
export interface NoiseSeedInputs {
  readonly jobKey: Uint8Array;
  readonly hashA: Uint8Array;
  readonly hashB: Uint8Array;
  /** Rows of A and columns of B; read only when `salted`. */
  readonly m: number;
  readonly n: number;
  /** V3 salts both roots first (SeedDerivation::Salted); V2 does not. */
  readonly salted: boolean;
  readonly moe?: { readonly hashRouting: Uint8Array; readonly routingOffsets: readonly number[] } | null;
}

/**
 * The noise seeds (zk-pow's commitment_hash): seedB = BLAKE3(jobKey || B
 * root), seedA = BLAKE3(seedB || A root, MoE routing folded in). The noise a
 * miner adds to A and B comes from these, and seedA keys hash_jackpot, so
 * the noise cannot be chosen before the matrices are fixed.
 */
export function noiseSeeds(inputs: NoiseSeedInputs): { readonly a: Uint8Array; readonly b: Uint8Array } {
  assert32(inputs.jobKey, 'jobKey');
  let a = inputs.salted ? saltedRootA(inputs.hashA, inputs.m) : inputs.hashA;
  const b = inputs.salted ? saltedRootB(inputs.hashB, inputs.n) : inputs.hashB;
  assert32(a, 'hashA');
  assert32(b, 'hashB');
  if (inputs.moe) a = hashActivations(a, inputs.moe.hashRouting, inputs.moe.routingOffsets, inputs.jobKey);
  const seedB = hash32(concat([inputs.jobKey, b]));
  const seedA = hash32(concat([seedB, a]));
  return { a: seedA, b: seedB };
}

/**
 * The job key and noise seeds of a V2 or V3 certificate on a header, from
 * its public data alone: what the proof's public inputs bind to.
 */
export function certificateSeeds(certificate: PearlCertificate, header: PearlBlockHeader): { readonly jobKey: Uint8Array; readonly a: Uint8Array; readonly b: Uint8Array } {
  if (certificate.version !== 2 && certificate.version !== 3) throw new RangeError(`certificateSeeds reads V2 and V3 certificates, not V${certificate.version}`);
  const data = parsePublicData(certificate.publicData);
  const key = jobKey(header, data.configBytes);
  const seeds = noiseSeeds({
    jobKey: key, hashA: data.hashA, hashB: data.hashB, m: data.m, n: data.n, salted: certificate.version === 3,
    moe: data.moe === null ? null : { hashRouting: data.moe.hashRouting, routingOffsets: data.moe.routingOffsets },
  });
  return { jobKey: key, ...seeds };
}

/**
 * hash_jackpot from the 16 words the jackpot tile folds to
 * (compute_jackpot_hash): BLAKE3 of the words as little-endian u32s, keyed
 * by seedA.
 */
export function jackpotHash(words: readonly number[], seedA: Uint8Array): Uint8Array {
  assert32(seedA, 'seedA');
  if (words.length !== 16) throw new RangeError(`the jackpot is 16 words, got ${words.length}`);
  return hash32(concat(words.map((word) => uint32le(word))), seedA);
}

/**
 * The target zk-pow reads from compact bits (nbits_to_difficulty). It is
 * bitsToTarget for every bits a valid header has, but zero for a negative
 * or zero mantissa and for exponent 0, and wrapped to 256 bits.
 */
export function jackpotTarget(bits: number): bigint {
  if (!Number.isInteger(bits) || bits < 0 || bits > 0xffffffff) throw new RangeError(`bits must be an unsigned 32-bit integer, got ${bits}`);
  const exponent = bits >>> 24;
  const mantissa = bits & 0x00ffffff;
  if (mantissa === 0 || exponent === 0 || (mantissa & 0x00800000) !== 0) return 0n;
  const value = BigInt(mantissa);
  return exponent <= 3 ? value >> BigInt(8 * (3 - exponent)) : (value << BigInt(8 * (exponent - 3))) & MAX_U256;
}

function scale(base: bigint, factor: bigint): bigint {
  return base > MAX_U256 / factor ? MAX_U256 : base * factor;
}

function tileFactor(config: MiningConfiguration): bigint {
  return BigInt(config.rows.length * config.cols.length) * BigInt(dotProductLength(config));
}

/**
 * The bound a V2 or V3 hash_jackpot must not exceed (extract_difficulty_bound):
 * the target times the tile's entries times the dot product length, so one
 * attempt is worth the multiply-adds it took, saturating at 2^256 - 1.
 * Throws for a configuration whose dot product is empty, which Pearl's
 * verifier refuses before it gets here.
 */
export function jackpotBound(bits: number, config: MiningConfiguration): bigint {
  const factor = tileFactor(config);
  if (factor === 0n) throw new RangeError('the configuration does no work: its dot product length is 0');
  return scale(jackpotTarget(bits), factor);
}

function penalizedFactor(config: MiningConfiguration): bigint {
  return BigInt(config.rows.length * config.cols.length) * BigInt(Math.floor(dotProductLength(config) / config.rank)) * BigInt(PENALTY_BASE_RANK);
}

/**
 * The rank-penalized bound of a target (penalized_target_bound): the tile's
 * entries times dot length over rank times 128, so a rank above 128 makes
 * each attempt count for less. Null when the factor is 0 or the bound
 * overflows 256 bits, where Pearl tells a miner its target is unusable.
 */
export function rankPenalizedBound(target: bigint, config: MiningConfiguration): bigint | null {
  if (config.rank === 0) return null;
  const factor = penalizedFactor(config);
  if (factor === 0n || target > MAX_U256 / factor) return null;
  return target * factor;
}

/**
 * The bound a V4 statement's hash_jackpot must not exceed
 * (check_jackpot_difficulty): the target times h, w and k, the factor
 * computed in 32 bits and taken as 2^32 - 1 when it overflows, as Pearl's
 * does, and the bound saturating at 2^256 - 1.
 */
export function v4JackpotBound(bits: number, statement: Pick<V4Statement, 'a' | 'b' | 'k'>): bigint {
  const h = statement.a.tileSize;
  const w = statement.b.tileSize;
  const product = BigInt(h) * BigInt(w) * BigInt(statement.k);
  const hw = BigInt(h) * BigInt(w);
  const factor = hw > 0xffffffffn || product > 0xffffffffn ? 0xffffffffn : product;
  if (factor === 0n) throw new RangeError('the statement does no work: h, w or k is 0');
  return scale(jackpotTarget(bits), factor);
}

/** hash_jackpot as the number bounds compare it with: little-endian. */
export function jackpotValue(hashJackpot: Uint8Array): bigint {
  assert32(hashJackpot, 'hashJackpot');
  let value = 0n;
  for (let i = 31; i >= 0; i -= 1) value = (value << 8n) | BigInt(hashJackpot[i]!);
  return value;
}

function jackpotFailure(message: string): never {
  throw new PearlError('JACKPOT_ABOVE_TARGET', message);
}

/** How checkJackpot judges a certificate. */
export interface JackpotCheckOptions {
  /**
   * Also apply the rank-penalty rule (V2 and V3 only). checkBlockWork turns
   * it on from the network's rankPenalty height; a pool checking shares on a
   * chain past that height should too.
   */
  readonly rankPenalty?: boolean;
}

/**
 * The checks Pearl's verifier makes on a certificate's public data before
 * it verifies the proof, against `bits`: a block header's bits, or a pool's
 * share bits, which Pearl's verifier also accepts in their place. For V2 and
 * V3: the public data's length, layout and structure (parsePublicData,
 * checkPublicData), then hash_jackpot at most jackpotBound. For V1, which
 * mainnet carries below its MoE fork: the 164-byte layout with an all-zero
 * reserved tail and V1's structure rules, then the same bound. For V4: the
 * statement's length, layout (certificateStatement) and bounds, then
 * hash_jackpot at most v4JackpotBound. Throws JACKPOT_ABOVE_TARGET for a
 * jackpot over its bound and CERTIFICATE_MALFORMED for the rest, with
 * Pearl's messages, in its order. Passing means only that the proof is
 * worth verifying.
 */
export function checkJackpot(certificate: PearlCertificate, bits: number, options: JackpotCheckOptions = {}): void {
  const { version, publicData } = certificate;
  if (publicData.length === 0 && version !== 1) malformed('empty public data');
  if (version === 4) {
    if (publicData.length < PUBLIC_DATA_MIN_SIZE_V4 || publicData.length > PUBLIC_DATA_MAX_SIZE_V4) malformed(`invalid public_data_len ${publicData.length}`);
    const statement = certificateStatement(certificate)!;
    checkV4Statement(statement);
    if (jackpotValue(statement.hashJackpot) > v4JackpotBound(bits, statement)) {
      jackpotFailure('Jackpot condition not satisfied: hash does not meet difficulty target');
    }
    return;
  }
  if (version === 1) {
    checkJackpotV1(publicData, bits);
    return;
  }
  if (version !== 2 && version !== 3) malformed(`unknown certificate version ${version}`);
  if (!isValidPublicDataSize(publicData.length)) malformed(`invalid public_data_len ${publicData.length}`);
  const data = parsePublicData(publicData);
  checkPublicData(data);
  if (jackpotValue(data.hashJackpot) > jackpotBound(bits, data.config)) {
    jackpotFailure('Jackpot condition not satisfied: hash does not meet difficulty target');
  }
  if (options.rankPenalty === true) checkRankPenalty(bits, publicData);
}

// verify_zk_proof_v1's checks before the proof: the fixed length, v1's
// PublicProofParams::from_bytes (the 32 bytes after the patterns are all
// reserved) and its sanity check, then the same jackpot bound as V2.
function checkJackpotV1(publicData: Uint8Array, bits: number): void {
  if (publicData.length !== PUBLIC_DATA_SIZE_V1) malformed(`v1 proof requires ${PUBLIC_DATA_SIZE_V1} byte public_data, got ${publicData.length}`);
  const configBytes = publicData.slice(0, MINING_CONFIGURATION_SIZE);
  const config = parseMiningConfiguration(Uint8Array.from(configBytes).fill(0, 20));
  if (configBytes.subarray(20).some((b) => b !== 0)) malformed('Reserved field must be all zeros');
  const view = new DataView(publicData.buffer, publicData.byteOffset, publicData.byteLength);
  const [m, n, tRows, tCols] = [148, 152, 156, 160].map((at) => view.getUint32(at, true)) as [number, number, number, number];
  if (!offsetIsValid(patternFromBytes(configBytes.subarray(8, 14)), tRows)) malformed('t_rows must be a valid offset for rows_pattern');
  if (!offsetIsValid(patternFromBytes(configBytes.subarray(14, 20)), tCols)) malformed('t_cols must be a valid offset for cols_pattern');
  const hashJackpot = publicData.slice(116, 148);
  checkStructure({ config, configBytes, hashA: publicData.slice(52, 84), hashB: publicData.slice(84, 116), hashJackpot, m, n, tRows, tCols, moe: null }, 1);
  if (jackpotValue(hashJackpot) > jackpotBound(bits, config)) {
    jackpotFailure('Jackpot condition not satisfied: hash does not meet difficulty target');
  }
}

/**
 * The rank-penalty rule as pearld runs it (zkpow.CheckRankPenalty): a V2 or
 * V3 public data length, a readable configuration, a rank of at least 128,
 * and hash_jackpot at most the rank-penalized bound of the target. Messages
 * are pearld's, "rank penalty rule violated: ..." included. Throws
 * JACKPOT_ABOVE_TARGET when only the jackpot fails, BLOCK_CERTIFICATE_INVALID
 * otherwise.
 */
export function checkRankPenalty(bits: number, publicData: Uint8Array): void {
  const fail = (message: string, code: 'BLOCK_CERTIFICATE_INVALID' | 'JACKPOT_ABOVE_TARGET' = 'BLOCK_CERTIFICATE_INVALID'): never => {
    throw new PearlError(code, `rank penalty rule violated: ${message}`);
  };
  if (publicData.length === 0) throw new PearlError('BLOCK_CERTIFICATE_INVALID', 'empty public data');
  if (!isValidPublicDataSize(publicData.length)) fail(`invalid public_data_len ${publicData.length}`);
  let config: MiningConfiguration;
  try {
    config = parseMiningConfiguration(publicData.subarray(0, MINING_CONFIGURATION_SIZE));
  } catch (error) {
    return fail((error as Error).message);
  }
  if (config.rank < PENALTY_BASE_RANK) fail(`Rank must be >= ${PENALTY_BASE_RANK} || r=${config.rank}`);
  const factor = penalizedFactor(config);
  if (factor === 0n) {
    fail(`Degenerate mining configuration: h*w=${config.rows.length * config.cols.length} dot_product_length=${dotProductLength(config)}`);
  }
  if (jackpotValue(publicData.subarray(116, 148)) > scale(jackpotTarget(bits), factor)) {
    fail('Jackpot condition not satisfied: hash does not meet the rank-penalized difficulty target', 'JACKPOT_ABOVE_TARGET');
  }
}

/**
 * The work rules of a block at a height, without the proof: checkJackpot
 * against the header's bits, and from the network's rankPenalty height the
 * rank-penalty rule for V2 and V3, with the message CheckCertificateRules
 * gives. Run checkCertificateBinding and checkCertificateRules (consensus)
 * beside it; together they are everything pearld checks of a certificate
 * except the proof.
 */
export function checkBlockWork(block: PearlBlock, network: PearlNetwork, height: number): void {
  const { certificate, header } = block;
  if (certificate === null) throw new PearlError('BLOCK_CERTIFICATE_INVALID', 'block has no certificate');
  checkJackpot(certificate, header.bits);
  const fork = network.forkHeights.rankPenalty;
  if (certificate.version !== 4 && fork !== 0 && height >= fork) {
    try {
      checkRankPenalty(header.bits, certificate.publicData);
    } catch (error) {
      const e = error as PearlError;
      throw new PearlError(e.code, `certificate fails the rank penalty rule at height ${height} (fork active from height ${fork}): ${e.message}`);
    }
  }
}

const TWO_256 = 1n << 256n;

function ratio(numerator: bigint, denominator: bigint): number {
  if (denominator <= 0n) throw new RangeError('denominator must be positive');
  // Keep 64 significant bits of the quotient so neither side overflows a float.
  const shift = BigInt(Math.max(0, numerator.toString(2).length - 64, denominator.toString(2).length - 64));
  return Number(numerator >> shift) / Number(denominator >> shift);
}

/** The chance one attempt meets a bound: (bound + 1) / 2^256, the share of 256-bit hashes at or below it. */
export function jackpotProbability(bound: bigint): number {
  if (bound < 0n || bound > MAX_U256) throw new RangeError('a bound is 0 to 2^256 - 1');
  return ratio(bound + 1n, TWO_256);
}

/**
 * Blocks one share is worth: the chance an attempt meets the block bound
 * over the chance it meets the share bound. Bounds come from jackpotBound,
 * rankPenalizedBound or v4JackpotBound for the same configuration, so the
 * configuration's factor cancels unless a bound saturates.
 */
export function shareValue(shareBound: bigint, blockBound: bigint): number {
  if (blockBound > shareBound) throw new RangeError('a share bound is at least the block bound');
  return ratio(blockBound + 1n, shareBound + 1n);
}

/** Effort: blocks' worth of shares done, a sum of shareValue; 1 is a block's worth. */
export function effort(shares: readonly { readonly shareBound: bigint; readonly blockBound: bigint }[]): number {
  return shares.reduce((sum, share) => sum + shareValue(share.shareBound, share.blockBound), 0);
}

// Regularized lower incomplete gamma P(a, x): series below a + 1, continued fraction above.
function gammaP(a: number, x: number): number {
  if (x <= 0) return 0;
  const lnPrefix = a * Math.log(x) - x - logGamma(a);
  if (x < a + 1) {
    let sum = 1 / a;
    let term = sum;
    for (let n = 1; n < 10000; n += 1) {
      term *= x / (a + n);
      sum += term;
      if (Math.abs(term) < Math.abs(sum) * 1e-16) break;
    }
    return sum * Math.exp(lnPrefix);
  }
  const tiny = 1e-300;
  let b = x + 1 - a;
  let c = 1 / tiny;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 10000; i += 1) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < tiny) d = tiny;
    c = b + an / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 1e-16) break;
  }
  return 1 - Math.exp(lnPrefix) * h;
}

// Lanczos approximation, g = 7, n = 9.
const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
  12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

function logGamma(x: number): number {
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const z = x - 1;
  let sum = LANCZOS[0]!;
  for (let i = 1; i < 9; i += 1) sum += LANCZOS[i]! / (z + i);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(sum);
}

/** The p-quantile of a gamma distribution with this shape and scale 1: half the chi-square quantile with 2 * shape degrees of freedom. */
export function gammaQuantile(p: number, shape: number): number {
  if (!(p > 0 && p < 1)) throw new RangeError('p must be strictly between 0 and 1');
  if (!(shape > 0)) throw new RangeError('shape must be positive');
  let low = 0;
  let high = Math.max(1, shape);
  while (gammaP(shape, high) < p) high *= 2;
  for (let i = 0; i < 200 && high - low > 1e-14 * high; i += 1) {
    const mid = (low + high) / 2;
    if (gammaP(shape, mid) < p) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

/** Luck over a window, with a confidence interval. */
export interface Luck {
  /** Blocks found over blocks expected: above 1 is lucky. */
  readonly luck: number;
  /** The interval's ends for the true rate over the expected one, at the confidence asked for. */
  readonly low: number;
  readonly high: number;
}

/**
 * Luck over a window: `found` blocks against `expected` blocks' worth of
 * effort, with the exact Poisson (Garwood) interval for the ratio of the
 * true rate to the expected one. Count the open round's effort in
 * `expected`, or a window that ends on a block reads lucky.
 */
export function luck(found: number, expected: number, confidence = 0.95): Luck {
  if (!Number.isInteger(found) || found < 0) throw new RangeError('found must be a whole number of blocks');
  if (!(expected > 0)) throw new RangeError('expected must be positive');
  if (!(confidence > 0 && confidence < 1)) throw new RangeError('confidence must be strictly between 0 and 1');
  const tail = (1 - confidence) / 2;
  const low = found === 0 ? 0 : gammaQuantile(tail, found) / expected;
  const high = gammaQuantile(1 - tail, found + 1) / expected;
  return { luck: found / expected, low, high };
}
