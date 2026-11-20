// Plain proofs for vectors/mining/plain/main.go, mined with zk-pow's own CPU
// miners on Pearl's fp8-scheme branch: try_mine_one and try_mine_one_moe
// (the miners zk-pow's FFI tests use) for certificate versions 1 to 3,
// serialized as a miner submits them, and v4::api::mine::mine for PlainProofV4;
// with zk-pow's two committed plain-proof fixtures and the headers its tests
// mine them on. Build it from a directory holding this Cargo.toml and zk-pow's
// own Cargo.lock:
//
//   [package]
//   name = "pearljs-plain-proofs"
//   version = "0.0.0"
//   edition = "2024"
//   [[bin]]
//   name = "plain"
//   path = "/path/to/pearljs/vectors/mining/plain/mine.rs"
//   [dependencies]
//   zk-pow = { path = "/path/to/pearl/zk-pow", default-features = false }
//   bincode = "1.3.3"
//   rand_chacha = "0.9"
//   serde_json = "1.0"
//   [workspace]
//
//   cargo run --release --offline -- /path/to/pearl/zk-pow > plain-proofs.json
use bincode::Options;
use rand_chacha::rand_core::SeedableRng;
use serde_json::json;
use zk_pow::v2::api::proof::{IncompleteBlockHeader, MMAType, MiningConfiguration, MoEConfig, PeriodicPattern, SeedDerivation};
use zk_pow::v2::mine::{try_mine_one, try_mine_one_moe};
use zk_pow::v4::api::primitives::{BlockHeader, IncompleteBlockHeader as Fp8Header};
use zk_pow::v4::api::public_params::Device;

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn header(prev: u8, merkle: [u8; 32], nbits: u32) -> IncompleteBlockHeader {
    IncompleteBlockHeader { version: 0, prev_block: [prev; 32], merkle_root: merkle, timestamp: 0x66666666, nbits }
}

fn config(moe: Option<MoEConfig>) -> MiningConfiguration {
    MiningConfiguration {
        common_dim: 2048,
        rank: 128,
        mma_type: MMAType::Int7xInt7ToInt32,
        rows_pattern: PeriodicPattern::from_list(&[0, 8, 64, 72]).unwrap(),
        cols_pattern: PeriodicPattern::from_list(&[0, 1, 8, 9, 32, 33, 40, 41]).unwrap(),
        moe,
    }
}

// The proof as a miner submits it: bincode with fixed-width integers (the inverse of deserialize_compat).
fn mine(seed: u64, h: IncompleteBlockHeader, moe: Option<MoEConfig>, derivation: SeedDerivation) -> Vec<u8> {
    let mut rng = rand_chacha::ChaCha20Rng::seed_from_u64(seed);
    for _ in 0..1000 {
        let found = if moe.is_some() {
            try_mine_one_moe(&mut rng, 1024, 128, 2048, h, config(moe), None, false, derivation).unwrap()
        } else {
            try_mine_one(&mut rng, 1024, 128, 2048, h, config(moe), None, false, derivation).unwrap()
        };
        if let Some(pp) = found {
            return bincode::options().with_fixint_encoding().serialize(&pp).unwrap();
        }
    }
    panic!("no proof in 1000 attempts");
}

fn main() {
    let zk_pow = std::env::args().nth(1).expect("path to zk-pow");
    let easy = 0x207FFFFF;
    let mut out = vec![];
    let mut add = |name: &str, h: &IncompleteBlockHeader, cert: u32, proof: Vec<u8>| {
        out.push(json!({ "name": name, "header": hex(&h.to_bytes()), "certVersion": cert, "proof": hex(&proof) }));
    };
    let h = header(1, *b"0123456789abcdef0123456789abcdef", easy);
    add("V2 dense", &h, 2, mine(1, h, None, SeedDerivation::Legacy));
    let h = header(2, *b"0123456789abcdef0123456789abcdef", easy);
    add("V3 dense", &h, 3, mine(2, h, None, SeedDerivation::Salted));
    let h = header(3, *b"0123456789abcdef0123456789abcdef", easy);
    add("V2 MoE", &h, 2, mine(3, h, Some(MoEConfig { e: 4, top_k: 2 }), SeedDerivation::Legacy));

    // tests/e2e_fixture_test.rs: v2_header() and moe_v2_header().
    let read = |p: &str| std::fs::read(format!("{zk_pow}/{p}")).unwrap();
    add("zk-pow fixture", &header(1, [2; 32], 0x1D2FFFFF), 2, read("src/v2/fixtures/v2_plain_proof.bin"));
    let moe_bits = {
        let src = String::from_utf8(read("tests/e2e_fixture_test.rs")).unwrap();
        let line = src.lines().find(|l| l.starts_with("const MOE_NBITS: u32 = ")).unwrap();
        u32::from_str_radix(line.trim_start_matches("const MOE_NBITS: u32 = 0x").trim_end_matches(';'), 16).unwrap()
    };
    add("zk-pow MoE fixture", &header(0, *b"0123456789abcdef0123456789abcdef", moe_bits), 2, read("src/v2/fixtures/v2_plain_proof_moe.bin"));

    for (i, device) in [Device::H100, Device::B200].into_iter().enumerate() {
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
        h.merkle_root[0] = 3 + i as u8;
        let plain = zk_pow::v4::api::mine::mine(&h, &parent, device).unwrap();
        out.push(json!({ "name": format!("V4 {device:?}"), "header": hex(&h.to_bytes()), "certVersion": 4, "proof": hex(&plain.to_bytes().unwrap()) }));
    }
    println!("{}", serde_json::to_string_pretty(&out).unwrap());
}
