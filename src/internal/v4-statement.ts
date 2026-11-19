// The rules zk-pow's PublicParams::try_new applies to a decoded V4 statement
// (src/v4/api/public_params.rs and layout.rs on Pearl's fp8-scheme branch),
// in its order and words. Pearl's verifier runs them as part of decoding, so
// they come before the ancestor headers and the jackpot.

import type { V4Statement } from '../block.js';
import { PearlError } from '../errors.js';

const MIN_K = 1024;
const MAX_K = 1 << 16;
const MAX_NUM_ROWS = 1 << 24;
const MAX_NUM_EXPERTS = 1024;
const JACKPOT_ENTRIES = 16;
const MIN_SUBTILE_ELEMS = 16;
const MAX_SUBTILE_ELEMS = 256;
const MIN_TILE_ROWS = 4;
const MIN_TILE_COLS = 16;
const MAX_TILE_ELEMS = 2048;
// prequant::BLOCK_SIZE: int8 values per BF16 scale.
const QUANT_BLOCK = 8n;
const MAX_BLAKE3_WITNESS_BLOCKS = (1n << 22n) / 64n;

function fail(message: string): never {
  throw new PearlError('CERTIFICATE_MALFORMED', message);
}

/** layout::check_lottery_layout. */
export function checkLotteryLayout(h: number, w: number): void {
  if (h < MIN_TILE_ROWS) fail(`h must be >= ${MIN_TILE_ROWS} || h=${h}`);
  if (w < MIN_TILE_COLS) fail(`w must be >= ${MIN_TILE_COLS} || w=${w}`);
  const elems = BigInt(h) * BigInt(w);
  if (elems > BigInt(MAX_TILE_ELEMS)) fail(`h*w must be <= ${MAX_TILE_ELEMS} || h=${h} w=${w}`);
  const tile = Number(elems);
  if (tile < JACKPOT_ENTRIES * MIN_SUBTILE_ELEMS) fail(`h*w must be >= ${JACKPOT_ENTRIES * MIN_SUBTILE_ELEMS} || h=${h} w=${w}`);
  if (tile % JACKPOT_ENTRIES !== 0) fail(`h*w must be a multiple of ${JACKPOT_ENTRIES} || h=${h} w=${w}`);
  const subtile = tile / JACKPOT_ENTRIES;
  if (subtile < MIN_SUBTILE_ELEMS || subtile > MAX_SUBTILE_ELEMS) fail(`subtile has ${subtile} elements, must be ${MIN_SUBTILE_ELEMS}..=${MAX_SUBTILE_ELEMS}`);
}

const chunkLen = (hashId: number): bigint => 128n << BigInt(hashId);

// blake_tree_block_bound: the compressions one tree's openings can cost.
function treeBlocks(rawBytes: bigint, hashId: number, opened: readonly (readonly [bigint, bigint])[]): bigint {
  const chunk = chunkLen(hashId);
  const ceil = (x: bigint): bigint => (x + chunk - 1n) / chunk;
  const total = ceil(rawBytes);
  if (total === 0n) fail('FP8 Blake3 tree must contain at least one chunk');
  const ranges = opened
    .filter(([start, end]) => start < end)
    .map(([start, end]) => [start / chunk, ceil(end)] as [bigint, bigint])
    .sort((x, y) => (x[0] !== y[0] ? (x[0] < y[0] ? -1 : 1) : x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0));
  const merged: [bigint, bigint][] = [];
  for (const [start, end] of ranges) {
    if (end > total) fail('FP8 Blake3 opening exceeds its tree');
    const last = merged[merged.length - 1];
    if (last !== undefined && start <= last[1]) last[1] = last[1] > end ? last[1] : end;
    else merged.push([start, end]);
  }
  const chunkBlocks = chunk / 64n;
  let depth = 0n;
  while (1n << depth < total) depth += 1n;
  return merged.reduce((sum, [start, end]) => sum + (end - start) * (chunkBlocks + 1n) + 2n * (depth + 1n), 0n);
}

function witnessBlocks(s: V4Statement): bigint {
  const k = BigInt(s.k);
  const scaleRow = 2n * (k / QUANT_BLOCK);
  const h = s.a.tileSize;
  const w = s.b.tileSize;
  const aRows = s.moe?.iA ?? Array.from({ length: h }, (_, i) => s.tileBases.a + i);
  const expertCol = s.moe === null ? 0 : Math.floor(s.b.numRows / s.experts) * s.moe.w;
  const bRows = Array.from({ length: w }, (_, i) => expertCol + s.tileBases.b + i);
  const m = BigInt(s.a.numRows);
  const n = BigInt(s.b.numRows);
  const spans = (rows: readonly number[], width: bigint) => rows.map((row) => [BigInt(row) * width, (BigInt(row) + 1n) * width] as const);
  let count = 3n;
  count += treeBlocks(m * k, s.a.hashId, spans(aRows, k));
  count += treeBlocks(n * k, s.b.hashId, spans(bRows, k));
  count += treeBlocks(m * scaleRow, s.a.hashId, spans(aRows, scaleRow));
  count += treeBlocks(n * scaleRow, s.b.hashId, spans(bRows, scaleRow));
  if (s.moe !== null) {
    count += treeBlocks(BigInt(s.moe.oLast) * 4n, s.moe.hashIdR, [[BigInt(s.moe.oWPrev) * 4n, BigInt(s.moe.oW) * 4n]]);
    const offsets = BigInt(s.experts) * 4n;
    count += treeBlocks(offsets, s.moe.hashIdO, [[0n, offsets]]);
  }
  return count;
}

/**
 * The bounds and cross-field rules of a decoded V4 statement: k and the
 * rank, the operands' row counts, the expert count, the lottery tile's
 * shape, the MoE projection, the tile inside its matrices and the BLAKE3
 * witness budget. Throws CERTIFICATE_MALFORMED with Pearl's message.
 */
export function checkV4Statement(s: V4Statement): void {
  const { k, r, a, b } = s;
  if (r !== 32) fail(`Rank must be exactly 32 || r=${r}`);
  if (k % 32 !== 0) fail(`k must be divisible by 32 || k=${k}`);
  if (k < MIN_K) fail(`k must be >= ${MIN_K} || k=${k}`);
  if (k > MAX_K) fail(`k must be <= ${MAX_K} || k=${k}`);
  for (const operand of [b, a]) {
    if (operand.numRows < 1) fail(`num_rows must be >= 1 || num_rows=${operand.numRows}`);
    if (operand.numRows > MAX_NUM_ROWS) fail(`num_rows must be <= 2^24 || num_rows=${operand.numRows}`);
  }
  if (s.experts > MAX_NUM_EXPERTS) fail(`experts must be in 1..=${MAX_NUM_EXPERTS} || e=${s.experts}`);
  checkLotteryLayout(a.tileSize, b.tileSize);
  const tA = s.tileBases.a;
  const tB = s.tileBases.b;
  let bRowBound = b.numRows;
  const moe = s.moe;
  if (moe !== null) {
    if (!(moe.w < s.experts)) fail(`winner expert must satisfy 0 <= w < e || w=${moe.w} e=${s.experts}`);
    if (moe.iA.length !== a.tileSize) fail(`I_A length must equal h || |I_A|=${moe.iA.length} h=${a.tileSize}`);
    for (let i = 1; i < moe.iA.length; i += 1) if (!(moe.iA[i - 1]! < moe.iA[i]!)) fail('I_A must be strictly increasing');
    if (!moe.iA.every((i) => i < a.numRows)) fail(`I_A must be a subset of [0, m) || m=${a.numRows}`);
    if (!(moe.oWPrev <= moe.oW)) fail(`O_{w-1} must be <= O_w || O_{w-1}=${moe.oWPrev} O_w=${moe.oW}`);
    if (!(moe.oW <= moe.oLast)) fail(`O_w must be <= O_{e-1} || O_w=${moe.oW} O_{e-1}=${moe.oLast}`);
    if (moe.w === 0 && moe.oWPrev !== 0) fail(`O_{w-1} must be 0 when w=0 || O_{w-1}=${moe.oWPrev}`);
    if (moe.w === s.experts - 1 && moe.oW !== moe.oLast) fail(`O_w must equal O_{e-1} when w=e-1 || O_w=${moe.oW} O_{e-1}=${moe.oLast}`);
    const sw = moe.oW - moe.oWPrev;
    if (!(sw <= a.numRows)) fail(`O_w - O_{w-1} must be <= m || s_w=${sw} m=${a.numRows}`);
    if (!(moe.oLast <= 1 << 29)) fail(`O_{e-1} must be <= 2^29 || O_{e-1}=${moe.oLast}`);
    const aHi = tA + a.tileSize - 1;
    if (aHi > 0xffffffff) fail('tA + tile max overflows u32');
    if (!(aHi < sw)) fail(`tA=${tA} + tile max=${a.tileSize - 1} must be < |R[w]|=${sw} (U_A subset of [0, s_w))`);
    if (b.numRows % s.experts !== 0) fail(`n must be divisible by e || n=${b.numRows} e=${s.experts}`);
    bRowBound = Math.floor(b.numRows / s.experts);
  }
  if (tA % a.tileSize !== 0) fail(`tA=${tA} must be a multiple of the A-side tile size ${a.tileSize}`);
  if (tB % b.tileSize !== 0) fail(`tB=${tB} must be a multiple of the B-side tile size ${b.tileSize}`);
  if (!(tA + a.tileSize <= a.numRows)) fail(`tA=${tA} + tile size=${a.tileSize} must be <= m=${a.numRows}`);
  if (!(tB + b.tileSize <= bRowBound)) fail(`tB=${tB} + tile size=${b.tileSize} must be <= ${bRowBound} (per-expert B rows)`);
  if (witnessBlocks(s) > MAX_BLAKE3_WITNESS_BLOCKS) fail('FP8 Blake3 witness exceeds 2^22 bytes');
}
