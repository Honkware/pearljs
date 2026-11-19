// Mining commitment vectors from Pearl's zk-pow crate on master: the job key,
// matrix commitments (hash A and hash B), the V3 salted roots, the noise-seed
// chain, the jackpot hash, the public data codec, compact targets and the
// jackpot bounds with and without the rank penalty. Everything is computed by
// zk-pow's public API; nothing is reimplemented here. Build it from a
// directory holding this Cargo.toml and zk-pow's own Cargo.lock:
//
//   [package]
//   name = "pearljs-mining-vectors"
//   version = "0.0.0"
//   edition = "2024"
//   [[bin]]
//   name = "mining"
//   path = "/path/to/pearljs/vectors/mining/zkpow/main.rs"
//   [dependencies]
//   zk-pow = { path = "/path/to/pearl/zk-pow" }
//   pearl-blake3 = { path = "/path/to/pearl/pearl-blake3" }
//   primitive-types = "0.12.1"
//   serde_json = "1.0"
//   [workspace]
//
//   PEARL_COMMIT=<sha> cargo run --release --offline > /path/to/pearljs/vectors/mining/zkpow.json
use pearl_blake3::{MerkleTree, pad_to_chunk_boundary};
use primitive_types::U256;
use serde_json::{Value, json};
use zk_pow::api::proof::{
    IncompleteBlockHeader, MMAType, MiningConfiguration, MoEConfig, MoEParams, PeriodicPattern, PublicProofParams,
    SeedDerivation,
};
use zk_pow::api::proof_utils::{compute_hash_activations, compute_jackpot_hash, nbits_to_difficulty};
use zk_pow::api::sanity_checks::{
    check_jackpot_against_nbits, check_rank_penalty, extract_difficulty_bound, penalized_target_bound,
};
use zk_pow::api::seed::{bind_root_a, bind_root_b};

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn u256(value: U256) -> String {
    format!("{value:x}")
}

// A deterministic byte stream, rebuilt the same way by the TypeScript test.
fn stream(seed: u32, len: usize) -> Vec<u8> {
    let mut state = seed.wrapping_mul(2654435761).wrapping_add(1);
    (0..len)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            (state >> 24) as u8
        })
        .collect()
}

fn hash32(seed: u32) -> [u8; 32] {
    stream(seed, 32).try_into().unwrap()
}

fn header(seed: u32, nbits: u32) -> IncompleteBlockHeader {
    IncompleteBlockHeader {
        version: 0x2000_0000 | seed,
        prev_block: hash32(seed + 100),
        merkle_root: hash32(seed + 200),
        timestamp: 1_760_000_000 + seed,
        nbits,
    }
}

fn result(r: anyhow::Result<()>) -> Value {
    match r {
        Ok(()) => Value::Null,
        Err(e) => Value::String(format!("{e}")),
    }
}

fn config(k: u32, rank: u16, rows: &[u32], cols: &[u32], moe: Option<MoEConfig>) -> MiningConfiguration {
    MiningConfiguration {
        common_dim: k,
        rank,
        mma_type: MMAType::Int7xInt7ToInt32,
        rows_pattern: PeriodicPattern::from_list(rows).unwrap(),
        cols_pattern: PeriodicPattern::from_list(cols).unwrap(),
        moe,
    }
}

fn config_json(c: &MiningConfiguration) -> Value {
    json!({
        "hex": hex(&c.to_bytes()),
        "commonDim": c.common_dim,
        "rank": c.rank,
        "rows": c.rows_pattern.to_list(),
        "cols": c.cols_pattern.to_list(),
        "rowsPeriod": c.rows_pattern.period(),
        "colsPeriod": c.cols_pattern.period(),
        "experts": c.moe.map(|m| m.e),
        "topK": c.moe.map(|m| m.top_k),
        "dotProductLength": c.dot_product_length(),
    })
}

fn main() {
    let commit = std::env::var("PEARL_COMMIT").unwrap_or_default();
    let dense = config(4096, 128, &[0, 8, 64, 72], &[0, 1, 8, 9, 32, 33, 40, 41], None);
    let rank256 = config(65536, 256, &[0, 8, 64, 72], &[0, 1, 8, 9, 32, 33, 40, 41], None);
    let wide = config(2048, 64, &[0, 1, 2, 3, 4, 5, 6, 7], &[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], None);
    let degenerate = config(64, 128, &[0, 8, 64, 72], &[0, 1, 8, 9, 32, 33, 40, 41], None);
    let moe = config(4096, 128, &[0, 8], &[0, 1, 8, 9], Some(MoEConfig { e: 4, top_k: 2 }));
    let configs = [&dense, &rank256, &wide, &degenerate, &moe];

    // Pattern and configuration bytes, accepted and refused.
    let mut config_bytes: Vec<(String, Vec<u8>)> = configs.iter().map(|c| ("valid".to_string(), c.to_bytes().to_vec())).collect();
    let mut edit = |name: &str, at: usize, value: u8| {
        let mut bytes = dense.to_bytes().to_vec();
        bytes[at] = value;
        config_bytes.push((name.to_string(), bytes));
    };
    edit("mma type 1", 6, 1);
    edit("non-canonical rows pattern", 10, 0);
    edit("broken stride", 8, 0);
    edit("reserved byte set", 40, 1);
    edit("top_k without experts", 22, 1);
    edit("period over 2^24", 9, 255);
    let configs_out: Vec<Value> = config_bytes
        .iter()
        .map(|(name, bytes)| match MiningConfiguration::from_bytes(bytes) {
            Ok(c) => {
                let mut v = config_json(&c);
                v["name"] = json!(name);
                v
            }
            Err(e) => json!({ "name": name, "hex": hex(bytes), "error": format!("{e}") }),
        })
        .collect();

    // PeriodicPattern::from_list, accepted and refused.
    let lists: [&[u32]; 10] = [&[0], &[0, 1, 2, 3], &[0, 8, 64, 72], &[0, 1, 8, 9, 32, 33, 40, 41], &[0, 5, 10], &[], &[1, 2], &[0, 2, 1], &[0, 1, 3], &[0, 0]];
    let patterns: Vec<Value> = lists
        .iter()
        .map(|list| match PeriodicPattern::from_list(list) {
            Ok(p) => json!({ "list": list, "bytes": hex(&p.to_bytes()), "size": p.size(), "max": p.max(), "period": p.period(),
                             "validOffsets": (0..p.period() * 2).filter(|&o| p.offset_is_valid(o)).collect::<Vec<u32>>() }),
            Err(e) => json!({ "list": list, "error": format!("{e}") }),
        })
        .collect();

    // Job keys.
    let headers = [header(1, 0x1d00ffff), header(2, 0x207fffff), header(3, 0x1c0ffff0)];
    let job_keys: Vec<Value> = headers
        .iter()
        .flat_map(|h| configs.iter().map(move |c| (h, c)))
        .map(|(h, c)| {
            let p = PublicProofParams::new_dummy(*h, SeedDerivation::Legacy, **c, 256, 512, 0, 0);
            json!({ "header": hex(&h.to_bytes()), "config": hex(&c.to_bytes()), "jobKey": hex(&p.job_key()) })
        })
        .collect();

    // Matrix commitments: Merkle roots over the data padded to 1024-byte chunks.
    let matrix_roots: Vec<Value> = [1usize, 64, 1024, 1025, 2048, 3000, 5 * 1024, 7 * 1024 + 1, 16 * 1024, 33 * 1024 - 7]
        .iter()
        .enumerate()
        .map(|(i, &len)| {
            let key = hash32(500 + i as u32);
            let data = stream(600 + i as u32, len);
            let root = MerkleTree::new(&pad_to_chunk_boundary(&data), key).root();
            json!({ "seed": 600 + i as u32, "length": len, "key": hex(&key), "root": hex(&root) })
        })
        .collect();

    let bind: Vec<Value> = [0u32, 1, 256, 512, 1 << 24, u32::MAX]
        .iter()
        .enumerate()
        .map(|(i, &dim)| {
            let root = hash32(700 + i as u32);
            json!({ "root": hex(&root), "dim": dim, "a": hex(&bind_root_a(&root, dim)), "b": hex(&bind_root_b(&root, dim)) })
        })
        .collect();

    let activations: Vec<Value> = [vec![3u32, 5, 9, 12], vec![0, 0, 7, 7], vec![1u32; 300]]
        .iter()
        .enumerate()
        .map(|(i, offsets)| {
            let (a, r, k) = (hash32(800 + i as u32), hash32(810 + i as u32), hash32(820 + i as u32));
            json!({ "hashA": hex(&a), "hashRouting": hex(&r), "offsets": offsets, "jobKey": hex(&k),
                    "activations": hex(&compute_hash_activations(&a, &r, offsets, &k)) })
        })
        .collect();

    // Public data: dense and MoE, under both seed derivations, with the seed chain.
    let mut publics: Vec<(String, IncompleteBlockHeader, Vec<u8>)> = Vec::new();
    for (i, c) in [&dense, &rank256, &wide].iter().enumerate() {
        let mut p = PublicProofParams::new(headers[i], SeedDerivation::Legacy, **c, hash32(900 + i as u32), hash32(910 + i as u32), hash32(920 + i as u32), 256, 512, 8 * i as u32, 0);
        p.t_rows = if i == 2 { 8 } else { 0 };
        publics.push((format!("dense {i}"), headers[i], p.to_wire_bytes().unwrap()));
    }
    let mut moe_params = PublicProofParams::new(headers[0], SeedDerivation::Legacy, moe, hash32(930), hash32(931), hash32(932), 64, 32, 0, 0);
    moe_params.moe = Some(MoEParams { expert_idx: 1, routing_offsets: vec![30, 64, 100, 128], hash_routing: hash32(933), outer_indices: vec![3, 9] });
    publics.push(("moe".to_string(), headers[0], moe_params.to_wire_bytes().unwrap()));
    let base = publics[0].2.clone();
    let mut bad = |name: &str, f: &dyn Fn(&mut Vec<u8>)| {
        let mut bytes = base.clone();
        f(&mut bytes);
        publics.push((name.to_string(), headers[0], bytes));
    };
    bad("t_rows not a pattern offset", &|b| b[156] = 1);
    bad("t_rows past m", &|b| b[156..160].copy_from_slice(&512u32.to_le_bytes()));
    bad("MoE tail on a dense config", &|b| b.extend_from_slice(&[0u8; 40]));
    bad("short", &|b| b.truncate(163));
    let moe_base = publics[3].2.clone();
    let mut bad_moe = |name: &str, f: &dyn Fn(&mut Vec<u8>)| {
        let mut bytes = moe_base.clone();
        f(&mut bytes);
        publics.push((name.to_string(), headers[0], bytes));
    };
    bad_moe("MoE length mismatch", &|b| b.push(0));
    bad_moe("MoE truncated", &|b| b.truncate(200));
    bad_moe("too many outer indices", &|b| b[164 + 2 + 16 + 32] = 129);

    let public_out: Vec<Value> = publics
        .iter()
        .flat_map(|(name, h, bytes)| [SeedDerivation::Legacy, SeedDerivation::Salted].map(|d| (name.clone(), *h, bytes.clone(), d)))
        .map(|(name, h, bytes, d)| {
            let salted = d == SeedDerivation::Salted;
            match PublicProofParams::from_wire_bytes(h, d, &bytes) {
                Ok(p) => {
                    let job_key = p.job_key();
                    let (seed_b, seed_a) = p.commitment_hash(job_key);
                    json!({
                        "name": name, "salted": salted, "header": hex(&h.to_bytes()), "hex": hex(&bytes),
                        "config": hex(&p.mining_config.to_bytes()),
                        "hashA": hex(&p.hash_a), "hashB": hex(&p.hash_b), "hashJackpot": hex(&p.hash_jackpot),
                        "m": p.m, "n": p.n, "tRows": p.t_rows, "tCols": p.t_cols,
                        "moe": p.moe.as_ref().map(|m| json!({
                            "expertIndex": m.expert_idx, "routingOffsets": m.routing_offsets,
                            "hashRouting": hex(&m.hash_routing), "outerIndices": m.outer_indices,
                        })),
                        "jobKey": hex(&job_key), "seedB": hex(&seed_b), "seedA": hex(&seed_a),
                    })
                }
                Err(e) => json!({ "name": name, "salted": salted, "header": hex(&h.to_bytes()), "hex": hex(&bytes), "error": format!("{e}") }),
            }
        })
        .collect();

    // public_params_sanity_check, the structure rules the verifier applies before the jackpot.
    let dense_rows: &[u32] = &[0, 8, 64, 72];
    let dense_cols: &[u32] = &[0, 1, 8, 9, 32, 33, 40, 41];
    let seq = |n: u32| (0..n).collect::<Vec<u32>>();
    let mut variants: Vec<(String, PublicProofParams)> = Vec::new();
    let mut variant = |name: &str, k: u32, rank: u16, rows: &[u32], cols: &[u32], m: u32, n: u32, t_rows: u32| {
        let c = config(k, rank, rows, cols, None);
        let p = PublicProofParams::new(headers[0], SeedDerivation::Salted, c, hash32(1200), hash32(1201), hash32(1202), m, n, t_rows, 0);
        variants.push((name.to_string(), p));
    };
    variant("base", 4096, 128, dense_rows, dense_cols, 256, 512, 0);
    variant("rank 48", 4096, 48, dense_rows, dense_cols, 256, 512, 0);
    variant("rank 16", 4096, 16, dense_rows, dense_cols, 256, 512, 0);
    variant("rank 2048", 65536, 2048, dense_rows, dense_cols, 256, 512, 0);
    variant("k not a multiple of 64", 4100, 128, dense_rows, dense_cols, 256, 512, 0);
    variant("k over 2^16", 65600, 1024, dense_rows, dense_cols, 256, 512, 0);
    variant("k under 16r", 8192, 1024, dense_rows, dense_cols, 256, 512, 0);
    variant("k over 4r^2", 4160, 32, dense_rows, dense_cols, 256, 512, 0);
    variant("k under 1024", 512, 32, dense_rows, dense_cols, 256, 512, 0);
    variant("odd tile height", 4096, 128, &[0, 1, 2], dense_cols, 256, 512, 0);
    variant("tile under 32", 4096, 128, &[0, 1], &seq(8), 256, 512, 0);
    variant("tile over 256", 4096, 128, &seq(16), &seq(32), 256, 512, 0);
    variant("worker input over 4 MiB", 65536, 256, &[0, 1], &seq(128), 256, 512, 0);
    variant("m over 2^24", 4096, 128, dense_rows, dense_cols, (1 << 24) + 1, 512, 0);
    variant("n over 2^24", 4096, 128, dense_rows, dense_cols, 256, (1 << 24) + 1, 0);
    variant("rows past m", 4096, 128, dense_rows, dense_cols, 72, 512, 0);
    variant("rows offset past m", 4096, 128, dense_rows, dense_cols, 200, 512, 128);
    let moe_variant = |name: &str, e: u16, top_k: u16, m: u32, expert: u16, offsets: Vec<u32>, outer: Vec<u32>, t_rows: u32| {
        let c = config(4096, 128, &[0, 8], &[0, 1, 8, 9, 32, 33, 40, 41, 64, 65, 72, 73, 96, 97, 104, 105], Some(MoEConfig { e, top_k }));
        let mut p = PublicProofParams::new(headers[0], SeedDerivation::Salted, c, hash32(1210), hash32(1211), hash32(1212), m, 128, t_rows, 0);
        p.moe = Some(MoEParams { expert_idx: expert, routing_offsets: offsets, hash_routing: hash32(1213), outer_indices: outer });
        (name.to_string(), p)
    };
    variants.push(moe_variant("moe base", 4, 2, 64, 1, vec![30, 64, 100, 128], vec![3, 9], 0));
    variants.push(moe_variant("top_k not under e", 2, 2, 64, 1, vec![64, 128], vec![3, 9], 0));
    variants.push(moe_variant("expert out of range", 4, 2, 64, 4, vec![30, 64, 100, 128], vec![3, 9], 0));
    variants.push(moe_variant("last offset wrong", 4, 2, 64, 1, vec![30, 64, 100, 127], vec![3, 9], 0));
    variants.push(moe_variant("offsets decrease", 4, 2, 64, 1, vec![30, 20, 100, 128], vec![3, 9], 0));
    variants.push(moe_variant("expert over m", 4, 2, 64, 1, vec![0, 64, 129, 128], vec![3, 9], 0));
    variants.push(moe_variant("first offset over m", 4, 2, 64, 1, vec![65, 70, 100, 128], vec![3, 9], 0));
    variants.push(moe_variant("index in next expert", 4, 2, 64, 1, vec![30, 35, 100, 128], vec![3, 9], 0));
    variants.push(moe_variant("outer indices unsorted", 4, 2, 64, 1, vec![30, 64, 100, 128], vec![9, 3], 0));
    variants.push(moe_variant("outer index past m", 4, 2, 64, 1, vec![30, 64, 100, 128], vec![3, 64], 0));
    variants.push(moe_variant("outer count wrong", 4, 2, 64, 1, vec![30, 64, 100, 128], vec![3], 0));
    variants.push(moe_variant("columns over 2^24", 4, 2, 64, 1, vec![30, 64, 100, 128], vec![3, 9], 0));
    if let Some((_, p)) = variants.last_mut() {
        p.n = (1 << 22) + 1;
    }
    let sanity: Vec<Value> = variants
        .iter()
        .map(|(name, p)| {
            let bytes = p.to_wire_bytes().unwrap();
            let parsed = PublicProofParams::from_wire_bytes(p.block_header, SeedDerivation::Salted, &bytes).map(|_| ());
            json!({ "name": name, "hex": hex(&bytes), "parse": result(parsed), "error": result(p.sanity_check()) })
        })
        .collect();

    let jackpots: Vec<Value> = (0..4u32)
        .map(|i| {
            let words: [u32; 16] = std::array::from_fn(|j| u32::from_le_bytes(stream(1000 + i * 16 + j as u32, 4).try_into().unwrap()));
            let seed = hash32(1100 + i);
            json!({ "words": words, "seedA": hex(&seed), "hash": hex(&compute_jackpot_hash(&words, seed)) })
        })
        .collect();

    let all_bits = [
        0x1d00ffffu32, 0x207fffff, 0x1e01ffff, 0x1b0404cb, 0x03123456, 0x02123456, 0x01120000, 0x00123456, 0x04923456,
        0x1d800000, 0x22000001, 0x21010000, 0x2100ffff, 0xff7fffff, 0x01000000, 0,
    ];
    let targets: Vec<Value> = all_bits.iter().map(|&b| json!({ "bits": b, "target": u256(nbits_to_difficulty(b)) })).collect();

    let bounds: Vec<Value> = all_bits
        .iter()
        .flat_map(|&b| configs.iter().map(move |c| (b, c)))
        .map(|(b, c)| {
            let target = nbits_to_difficulty(b);
            json!({
                "bits": b, "config": hex(&c.to_bytes()),
                // extract_difficulty_bound divides by zero for a degenerate configuration,
                // which the verifier's sanity check refuses before it gets there.
                "bound": (c.dot_product_length() > 0).then(|| u256(extract_difficulty_bound(b, c))),
                "penalized": penalized_target_bound(target, c).map(u256),
            })
        })
        .collect();

    // The rank-penalty rule and the plain jackpot condition around their bounds.
    let mut rank_checks = Vec::new();
    let mut jackpot_checks = Vec::new();
    for &b in &[0x1d00ffffu32, 0x1e01ffff, 0x1c0ffff0, 0x207fffff] {
        for c in configs {
            let plain = c.dot_product_length() > 0;
            let edges = [
                if plain { extract_difficulty_bound(b, c) } else { U256::MAX },
                penalized_target_bound(nbits_to_difficulty(b), c).unwrap_or(U256::MAX),
            ];
            for edge in edges {
                for value in [edge.saturating_sub(U256::one()), edge, edge.saturating_add(U256::one()), U256::MAX, U256::zero()] {
                    let mut jackpot = [0u8; 32];
                    value.to_little_endian(&mut jackpot);
                    rank_checks.push(json!({ "bits": b, "config": hex(&c.to_bytes()), "jackpot": hex(&jackpot),
                                             "error": result(check_rank_penalty(c, &jackpot, b)) }));
                    if !plain {
                        continue;
                    }
                    let p = PublicProofParams::new(header(9, b), SeedDerivation::Legacy, *c, [0; 32], [0; 32], jackpot, 256, 512, 0, 0);
                    jackpot_checks.push(json!({ "bits": b, "config": hex(&c.to_bytes()), "jackpot": hex(&jackpot),
                                                "error": result(check_jackpot_against_nbits(&p, None)) }));
                }
            }
        }
    }
    let low_rank = config(4096, 64, &[0, 8, 64, 72], &[0, 1, 8, 9, 32, 33, 40, 41], None);
    rank_checks.push(json!({ "bits": 0x1d00ffffu32, "config": hex(&low_rank.to_bytes()), "jackpot": hex(&[0u8; 32]),
                             "error": result(check_rank_penalty(&low_rank, &[0u8; 32], 0x1d00ffff)) }));

    let out = json!({
        "source": "github.com/pearl-research-labs/pearl zk-pow (master)",
        "commit": commit,
        "patterns": patterns,
        "configs": configs_out,
        "jobKeys": job_keys,
        "matrixRoots": matrix_roots,
        "bindRoots": bind,
        "hashActivations": activations,
        "publicData": public_out,
        "sanity": sanity,
        "jackpotHashes": jackpots,
        "targets": targets,
        "bounds": bounds,
        "rankPenalty": rank_checks,
        "jackpotChecks": jackpot_checks,
    });
    println!("{}", serde_json::to_string_pretty(&out).unwrap());
}
