// Plain proofs for statements whose committed matrices pass 2^32 bytes, for
// vectors/mining/plain/main.go. A verifier reads only the opened rows and the
// Merkle siblings around them, so here every row the tile does not open holds
// one fixed row (zeros, or unit scales for V4's scale planes): the trees are
// built chunk by chunk without holding the matrices, each chunk hashed at its
// own counter as MerkleTree::with_chunk_len hashes it, and the proof opens the
// chunks of the tile's rows as get_multileaf_proof does.
//
// Trees of 2^39 and 2^40 bytes (Pearl's bounds allow 2^24 rows of 2^16
// bytes) are past hashing here, so the proofs named "stand-in siblings" open
// the same chunks but carry arbitrary CVs for the unopened subtrees, with the
// root those reconstruct to: a verifier cannot tell them from mined ones and
// accepts them, though no matrix behind them is known.
//
// Each proof is judged by zk-pow's own verify_plain_proof before it is
// written; one that misses its jackpot gets new values in the opened rows.
// Build it beside mine.rs, with
//
//   pearl-blake3 = { path = "/path/to/pearl/pearl-blake3" }
//   rayon = "1"
//   [[bin]]
//   name = "large"
//   path = "/path/to/pearljs/vectors/mining/plain/large.rs"
//
// added to that Cargo.toml, and run it as
//
//   cargo run --release --offline --bin large > plain-large-proofs.json
use std::collections::{BTreeMap, BTreeSet};

use bincode::Options;
use pearl_blake3::{Blake3Hasher, MerkleProof, blake3_digest};
use rand_chacha::ChaCha20Rng;
use rand_chacha::rand_core::{RngCore, SeedableRng};
use rayon::prelude::*;
use serde_json::json;
use zk_pow::v2::api::proof::{IncompleteBlockHeader, MMAType, MiningConfiguration, PeriodicPattern, SeedDerivation};
use zk_pow::v2::ffi::plain_proof::{MatrixMerkleProof, PlainProof};
use zk_pow::v4::api::plain_proof::PlainProofV4;
use zk_pow::v4::api::prequant::BLOCK_SIZE;
use zk_pow::v4::api::primitives::{BlockHeader, IncompleteBlockHeader as Fp8Header, Sides};
use zk_pow::v4::api::public_params::{CommonParams, Device, HashId, JobParams, OperandParams, Quant};

type Digest = [u8; 32];

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

// A row-major matrix of `rows` rows of `row_len` bytes: `base` everywhere but in `filled`.
struct Sparse {
    rows: usize,
    row_len: usize,
    chunk_len: usize,
    base: Vec<u8>,
    filled: BTreeMap<usize, Vec<u8>>,
}

impl Sparse {
    fn chunk(&self, i: usize) -> Vec<u8> {
        let (start, end) = (i * self.chunk_len, ((i + 1) * self.chunk_len).min(self.rows * self.row_len));
        let mut out = vec![0u8; self.chunk_len];
        for row in start / self.row_len..end.div_ceil(self.row_len) {
            let data = self.filled.get(&row).unwrap_or(&self.base);
            let (row_start, row_end) = (row * self.row_len, (row + 1) * self.row_len);
            let (lo, hi) = (row_start.max(start), row_end.min(end));
            out[lo - start..hi - start].copy_from_slice(&data[lo - row_start..hi - row_start]);
        }
        out
    }

    // MerkleTree::with_chunk_len's layers, then get_multileaf_proof for the chunks holding `opened`.
    fn proof(&self, key: Digest, opened: &[usize]) -> MatrixMerkleProof {
        let hasher = Blake3Hasher::with_key(key);
        let leaves = (self.rows * self.row_len).div_ceil(self.chunk_len);
        let mut layers: Vec<Vec<Digest>> =
            vec![(0..leaves).into_par_iter().map(|i| hasher.chunk_cv(&self.chunk(i), i as u64)).collect()];
        while layers.last().unwrap().len() > 2 {
            let next = layers
                .last()
                .unwrap()
                .par_chunks(2)
                .map(|p| if p.len() == 2 { hasher.parent_cv(&p[0], &p[1]) } else { p[0] })
                .collect();
            layers.push(next);
        }
        let last = layers.last().unwrap();
        let root = hasher.root_cv(&last[0], &last[1]);
        self.opening(opened, root, |level, i| layers[level][i])
    }

    // The stand-in: each sibling an arbitrary CV, the root what they reconstruct to.
    fn stand_in(&self, key: Digest, opened: &[usize]) -> MatrixMerkleProof {
        let mut matrix = self.opening(opened, [0; 32], |level, i| {
            blake3_digest(&[(level as u64).to_le_bytes(), (i as u64).to_le_bytes()].concat(), Some(key))
        });
        matrix.proof.root = matrix.proof.compute_root(key).unwrap();
        matrix
    }

    fn opening(&self, opened: &[usize], root: Digest, node: impl Fn(usize, usize) -> Digest) -> MatrixMerkleProof {
        let leaves = (self.rows * self.row_len).div_ceil(self.chunk_len);
        let leaf_indices =
            pearl_blake3::MerkleTree::compute_leaf_indices_from_rows(opened, (self.rows, self.row_len), self.chunk_len)
                .unwrap();
        let mut siblings = vec![];
        let mut current: BTreeSet<usize> = leaf_indices.iter().copied().collect();
        let mut level_len = leaves;
        let mut level = 0;
        while level_len > 1 && !current.is_empty() {
            for &i in &current {
                if i % 2 == 1 {
                    if !current.contains(&(i - 1)) {
                        siblings.push(node(level, i - 1));
                    }
                } else if !current.contains(&(i + 1)) && i + 1 < level_len {
                    siblings.push(node(level, i + 1));
                }
            }
            current = current.iter().map(|&i| i / 2).collect();
            level_len = level_len.div_ceil(2);
            level += 1;
        }
        MatrixMerkleProof {
            proof: MerkleProof {
                leaf_data: leaf_indices.iter().map(|&i| self.chunk(i)).collect(),
                leaf_indices,
                total_leaves: leaves,
                root,
                siblings,
            },
            row_indices: opened.to_vec(),
        }
    }
}

// The last tile of `pattern` that fits in `dim`.
fn last_tile(pattern: &PeriodicPattern, dim: usize) -> Vec<usize> {
    let max = pattern.max() as usize;
    let offset = (0..dim - max).rev().find(|&t| pattern.offset_is_valid(t as u32)).unwrap();
    pattern.indices_with_offset(offset as u32).into_iter().map(|i| i as usize).collect()
}

// Values in [-64, 64], as try_mine_one draws them.
fn int7_rows(rng: &mut ChaCha20Rng, rows: &[usize], k: usize) -> BTreeMap<usize, Vec<u8>> {
    rows.iter().map(|&r| (r, (0..k).map(|_| ((rng.next_u32() % 129) as i32 - 64) as i8 as u8).collect())).collect()
}

fn mine_v2(seed: u64, header: IncompleteBlockHeader, m: usize, n: usize, k: usize, derivation: SeedDerivation, stand_in: bool) -> Vec<u8> {
    let config = MiningConfiguration {
        common_dim: k as u32,
        rank: 128,
        mma_type: MMAType::Int7xInt7ToInt32,
        rows_pattern: PeriodicPattern::from_list(&[0, 8, 64, 72]).unwrap(),
        cols_pattern: PeriodicPattern::from_list(&[0, 1, 8, 9, 32, 33, 40, 41]).unwrap(),
        moe: None,
    };
    // mine.rs's compute_job_key.
    let job_key = blake3_digest(&[&header.to_bytes()[..], &config.to_bytes()[..]].concat(), None);
    let a_rows = last_tile(&config.rows_pattern, m);
    let b_cols = last_tile(&config.cols_pattern, n);
    let mut rng = ChaCha20Rng::seed_from_u64(seed);
    for _ in 0..20 {
        let open = |rows, filled, opened: &[usize]| {
            let sparse = Sparse { rows, row_len: k, chunk_len: 1024, base: vec![0; k], filled };
            if stand_in { sparse.stand_in(job_key, opened) } else { sparse.proof(job_key, opened) }
        };
        let a = open(m, int7_rows(&mut rng, &a_rows, k), &a_rows);
        let bt = open(n, int7_rows(&mut rng, &b_cols, k), &b_cols);
        let pp = PlainProof { m, n, k, noise_rank: 128, a, bt, moe: None };
        match zk_pow::v2::api::verify::verify_plain_proof(&header, &pp, None, derivation) {
            Ok(()) => return bincode::options().with_fixint_encoding().serialize(&pp).unwrap(),
            Err(e) => eprintln!("m={m} n={n} k={k}: {e}"),
        }
    }
    panic!("no proof in 20 attempts");
}

// zk-pow's v4::api::mine::mine with m and n rows, opening the last tile of 16.
#[allow(clippy::too_many_arguments)]
fn mine_v4(seed: u64, header: &Fp8Header, parent: &BlockHeader, device: Device, m: usize, n: usize, k: usize, hash_ids: Sides<HashId>, stand_in: bool) -> Vec<u8> {
    const TILE: usize = 16;
    let operand = |rows: usize, hash_id| OperandParams { num_rows: rows as u32, hash_id, tile_size: TILE as u32 };
    let job = JobParams {
        ancestor_header: *parent,
        common: CommonParams { k: k as u32, r: 32, quant: Quant::Fp8E4M3Prequant, device },
        operands: Sides { a: operand(m, hash_ids.a), b: operand(n, hash_ids.b) },
        moe: None,
    };
    // transcript.rs's key_a and key_b.
    let keys = Sides {
        a: blake3_digest(&header.to_bytes(), Some(blake3_digest(b"pearl/v4/FP8/key-A", None))),
        b: blake3_digest(&parent.to_bytes(), Some(blake3_digest(b"pearl/v4/FP8/key-B", None))),
    };
    let tiles = Sides { a: ((m - TILE)..m).collect::<Vec<_>>(), b: ((n - TILE)..n).collect::<Vec<_>>() };
    let unit_scales: Vec<u8> = (0..k / BLOCK_SIZE).flat_map(|_| 0x3f80u16.to_le_bytes()).collect();
    let plane = |rows, row_len, hash_id: HashId, base: &[u8], filled, key, opened: &[usize]| {
        let sparse = Sparse { rows, row_len, chunk_len: hash_id.chunk_len(), base: base.to_vec(), filled };
        if stand_in { sparse.stand_in(key, opened) } else { sparse.proof(key, opened) }
    };
    let scale_plane = |rows, hash_id, key, opened: &[usize]| plane(rows, unit_scales.len(), hash_id, &unit_scales, BTreeMap::new(), key, opened);
    let scales = Sides {
        a: scale_plane(m, hash_ids.a, keys.a, &tiles.a),
        b: scale_plane(n, hash_ids.b, keys.b, &tiles.b),
    };
    let mut rng = ChaCha20Rng::seed_from_u64(seed);
    // mine.rs's centered triangular distribution.
    let mut values = |rows: &[usize]| -> BTreeMap<usize, Vec<u8>> {
        rows.iter()
            .map(|&r| {
                let row = (0..k)
                    .map(|_| {
                        let x = rng.next_u32();
                        ((x & 127) as i16 + ((x >> 16) & 127) as i16 - 127) as i8 as u8
                    })
                    .collect();
                (r, row)
            })
            .collect()
    };
    for _ in 0..50 {
        let proof = PlainProofV4 {
            job: job.clone(),
            ancestor_chain: vec![],
            values: Sides {
                a: plane(m, k, hash_ids.a, &vec![0; k], values(&tiles.a), keys.a, &tiles.a),
                b: plane(n, k, hash_ids.b, &vec![0; k], values(&tiles.b), keys.b, &tiles.b),
            },
            scales: scales.clone(),
            moe_witness: None,
        };
        match zk_pow::v4::api::verify::verify_plain_proof(header, &proof, None) {
            Ok(()) => return proof.to_bytes().unwrap(),
            Err(e) => eprintln!("V4 m={m} n={n}: {e:#}"),
        }
    }
    panic!("no proof in 50 attempts");
}

fn main() {
    let easy = 0x207FFFFF;
    let mut out = vec![];
    let header = |prev: u8| IncompleteBlockHeader {
        version: 0,
        prev_block: [prev; 32],
        merkle_root: *b"0123456789abcdef0123456789abcdef",
        timestamp: 0x66666666,
        nbits: easy,
    };
    for (name, prev, cert, derivation, m, n, k, stand_in) in [
        ("V2 dense, A of 2^32 + 2^18 bytes", 4u8, 2u32, SeedDerivation::Legacy, (1 << 21) + 128, 128, 2048, false),
        ("V3 dense, B of 2^33 + 2^18 bytes", 5, 3, SeedDerivation::Salted, 1024, (1 << 22) + 128, 2048, false),
        ("V3 dense, A and B of 2^32 + 2^20 bytes", 6, 3, SeedDerivation::Salted, (1 << 19) + 128, (1 << 19) + 128, 8192, false),
        ("V3 dense, A and B of 2^40 bytes, stand-in siblings", 10, 3, SeedDerivation::Salted, 1 << 24, 1 << 24, 1 << 16, true),
    ] {
        let h = header(prev);
        let proof = mine_v2(prev as u64, h, m, n, k, derivation, stand_in);
        eprintln!("{name}: {} bytes", proof.len());
        out.push(json!({ "name": name, "header": hex(&h.to_bytes()), "certVersion": cert, "proof": hex(&proof) }));
    }

    // mine.rs's V4 headers, on other merkle roots.
    let ids = |a, b| Sides { a, b };
    for (i, (name, device, m, n, k, hash_ids, stand_in)) in [
        ("V4 H100, A of 2^32 + 2^14 bytes in 1024-byte leaves", Device::H100, (1 << 22) + 16, 16, 1024, ids(HashId::Blake3Chunk1024, HashId::Blake3Chunk1024), false),
        ("V4 B200, B of 2^32 + 2^14 bytes in 256-byte leaves", Device::B200, 16, (1 << 22) + 16, 1024, ids(HashId::Blake3Chunk128, HashId::Blake3Chunk256), false),
        // 2^32 leaves of 128 bytes: a leaf count bincode refuses as a usize on 32-bit targets.
        ("V4 H100, A and B of 2^39 bytes in 128-byte leaves, stand-in siblings", Device::H100, 1 << 24, 1 << 24, 1 << 15, ids(HashId::Blake3Chunk128, HashId::Blake3Chunk128), true),
    ]
    .into_iter()
    .enumerate()
    {
        let mut incomplete = Fp8Header::zero();
        incomplete.version = 1;
        incomplete.nbits = easy;
        incomplete.timestamp = 1_760_000_200 + i as u32;
        let parent = BlockHeader { incomplete, proof_commitment: [0; 32] };
        let mut h = Fp8Header::zero();
        h.version = 1;
        h.prev_block = parent.block_hash();
        h.nbits = easy;
        h.timestamp = incomplete.timestamp + 60;
        h.merkle_root[0] = 7 + i as u8;
        let proof = mine_v4(7 + i as u64, &h, &parent, device, m, n, k, hash_ids, stand_in);
        eprintln!("{name}: {} bytes", proof.len());
        out.push(json!({ "name": name, "header": hex(&h.to_bytes()), "certVersion": 4, "proof": hex(&proof) }));
    }
    println!("{}", serde_json::to_string_pretty(&out).unwrap());
}
