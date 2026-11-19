// V4 jackpot condition vectors from Pearl's fp8-scheme branch:
// zk_pow::v4::api::proof_utils::check_jackpot_difficulty, the check the V4
// verifier runs on a statement's hash_jackpot before the proof, against the
// block's bits or a pool's share bits. Build it as vectors/mining/zkpow/main.rs
// says, against an fp8-scheme checkout, with this file as the binary and only
// zk-pow, primitive-types and serde_json as dependencies:
//
//   PEARL_COMMIT=<sha> cargo run --release --offline > /path/to/pearljs/vectors/mining/fp8.json
use primitive_types::U256;
use serde_json::json;
use zk_pow::v4::api::proof_utils::{check_jackpot_difficulty, nbits_to_difficulty};

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn main() {
    let commit = std::env::var("PEARL_COMMIT").unwrap_or_default();
    let shapes: [(u32, u32, u32); 6] = [(16, 16, 1024), (16, 8, 4096), (32, 32, 65536), (1, 1, 1), (65536, 65536, 2), (3, 5, 7)];
    let mut checks = Vec::new();
    for bits in [0x1d00ffffu32, 0x1e01ffff, 0x1c0ffff0, 0x207fffff, 0x1d800000, 0] {
        for (h, w, k) in shapes {
            let target = nbits_to_difficulty(bits);
            let adjustment = h.checked_mul(w).and_then(|x| x.checked_mul(k)).unwrap_or(u32::MAX);
            let edge = if target > U256::MAX / adjustment { U256::MAX } else { target * adjustment };
            for value in [U256::zero(), edge.saturating_sub(U256::one()), edge, edge.saturating_add(U256::one()), U256::MAX] {
                let mut hash = [0u8; 32];
                value.to_little_endian(&mut hash);
                let error = check_jackpot_difficulty(&hash, bits, h, w, k).err().map(|e| format!("{e}"));
                checks.push(json!({ "bits": bits, "h": h, "w": w, "k": k, "jackpot": hex(&hash), "error": error }));
            }
        }
    }
    let out = json!({
        "source": "github.com/pearl-research-labs/pearl zk-pow (fp8-scheme)",
        "commit": commit,
        "jackpotChecks": checks,
    });
    println!("{}", serde_json::to_string_pretty(&out).unwrap());
}
