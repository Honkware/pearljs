// The miner's side of gateway.test.ts for V4 jobs: mines a PlainProofV4 for a
// job's 76-byte header, keyed by its parent's 108-byte header, with zk-pow's
// own CPU miner on Pearl's fp8-scheme branch, and prints it in hex.
//
//   gateway-mine-v4 <incomplete header, hex> <parent header, hex>
//
// Build it from a directory holding this Cargo.toml and zk-pow's own
// Cargo.lock, and point PEARL_GATEWAY_MINER_V4 at the binary:
//
//   [package]
//   name = "gateway-mine-v4"
//   version = "0.0.0"
//   edition = "2024"
//   [[bin]]
//   name = "gateway-mine-v4"
//   path = "/path/to/pearljs/test/live/gateway-mine-v4.rs"
//   [dependencies]
//   zk-pow = { path = "/path/to/pearl/zk-pow", default-features = false }
//   [workspace]
use zk_pow::v4::api::primitives::{BlockHeader, IncompleteBlockHeader};
use zk_pow::v4::api::public_params::Device;

fn bytes(text: &str) -> Vec<u8> {
    (0..text.len()).step_by(2).map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap()).collect()
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let (header, parent) = (bytes(&args[1]), bytes(&args[2]));
    let header = IncompleteBlockHeader::from_bytes(&header).unwrap();
    let parent = BlockHeader::from_bytes(&parent).unwrap();
    let plain = zk_pow::v4::api::mine::mine(&header, &parent, Device::H100).unwrap();
    println!("{}", plain.to_bytes().unwrap().iter().map(|b| format!("{b:02x}")).collect::<String>());
}
