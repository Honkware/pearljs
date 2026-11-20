// zk-pow's PlainProof (zk-pow/src/v2/ffi/plain_proof.rs) as bincode writes it
// with fixed-width integers: m, n, k and noise_rank as u64, then the A and B
// openings. Only what the tests change is decoded: the dimensions and each
// side's declared total_leaves.

interface Wire {
  readonly bytes: Uint8Array;
  readonly view: DataView;
  // Byte offsets of the A and B openings' total_leaves fields.
  readonly totalLeaves: readonly [number, number];
}

function u64(view: DataView, at: number): number {
  const value = view.getBigUint64(at, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('length past 2^53');
  return Number(value);
}

// leaf_data, leaf_indices, total_leaves, root, siblings; then row_indices. Returns total_leaves' offset and the end.
function skipOpening(view: DataView, at: number): [number, number] {
  const leaves = u64(view, at);
  at += 8;
  for (let i = 0; i < leaves; i++) at += 8 + u64(view, at);
  at += 8 + 8 * u64(view, at);
  const total = at;
  at += 8 + 32;
  at += 8 + 32 * u64(view, at);
  at += 8 + 8 * u64(view, at);
  return [total, at];
}

function read(bytes: Uint8Array): Wire {
  const copy = Uint8Array.from(bytes);
  const view = new DataView(copy.buffer);
  const [a, end] = skipOpening(view, 32);
  const [b] = skipOpening(view, end);
  return { bytes: copy, view, totalLeaves: [a, b] };
}

/** The proof with its dimensions replaced and each side's total_leaves made to match them, so check_declared_tree_sizes passes. */
export function withDimensions(bytes: Uint8Array, dims: { m?: bigint; n?: bigint; k?: bigint; rank?: bigint }): Uint8Array {
  const wire = read(bytes);
  const { view } = wire;
  const m = dims.m ?? view.getBigUint64(0, true);
  const n = dims.n ?? view.getBigUint64(8, true);
  const k = dims.k ?? view.getBigUint64(16, true);
  view.setBigUint64(0, m, true);
  view.setBigUint64(8, n, true);
  view.setBigUint64(16, k, true);
  if (dims.rank !== undefined) view.setBigUint64(24, dims.rank, true);
  view.setBigUint64(wire.totalLeaves[0], (m * k + 1023n) / 1024n, true);
  view.setBigUint64(wire.totalLeaves[1], (n * k + 1023n) / 1024n, true);
  return wire.bytes;
}
