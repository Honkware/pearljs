// V4 statement vectors: zk_pow::v4::api::public_params::PublicParams::from_bytes,
// Pearl's own decoder of V4 public data, run over its two mined fixtures and
// edits of them. Pearl's Go code does not decode the statement, so this is
// the only source for the field layout. Build it against an fp8-scheme
// checkout whose zk-pow builds (see "Building zk-pow" in the verification
// guide), from a directory holding this Cargo.toml:
//
//   [package]
//   name = "pearljs-fp8-statements"
//   version = "0.0.0"
//   edition = "2024"
//   [[bin]]
//   name = "statements"
//   path = "/path/to/pearljs/vectors/fp8/statement/main.rs"
//   [dependencies]
//   zk-pow = { path = "/path/to/pearl/zk-pow", default-features = false }
//   [workspace]
//
// with zk-pow's own Cargo.lock copied beside it, then
//
//   PEARL_COMMIT=<sha> cargo run --release --offline -- /path/to/pearl/node/zkpow/testdata \
//     > /path/to/pearljs/vectors/fp8-statements.json
use std::fs;

use zk_pow::v4::api::public_params::PublicParams;

// The fixture layout zkpow/fp8_test.go reads: header(76) | u32 len | public data | ...
fn fixture_public(dir: &str, device: &str) -> Vec<u8> {
    let raw = fs::read(format!("{dir}/fp8_zk_proof_{device}.bin")).expect("fixture");
    let len = u32::from_le_bytes(raw[76..80].try_into().unwrap()) as usize;
    raw[80..80 + len].to_vec()
}

fn quote(text: &str) -> String {
    let mut out = String::from("\"");
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn main() {
    let dir = std::env::args().nth(1).expect("testdata directory");
    let h100 = fixture_public(&dir, "h100");
    let b200 = fixture_public(&dir, "b200");
    let edit = |base: &[u8], f: &dyn Fn(&mut Vec<u8>)| {
        let mut v = base.to_vec();
        f(&mut v);
        v
    };
    // Offsets in a dense statement: ancestor header 0..108, k 108, r 112,
    // quant 114, device 115, n 116, hash_idB 120, w 121, e 125, H_B 127,
    // m 159, hash_idA 163, h 164, H_A 168, tA 200, tB 204, J 208..240.
    let h = u32::from_le_bytes(h100[164..168].try_into().unwrap()) as usize;
    let moe_tail = |e: u16, tail: usize| {
        move |v: &mut Vec<u8>| {
            v[125..127].copy_from_slice(&e.to_le_bytes());
            v.splice(168..168, [0u8, 1u8]);
            v.extend(std::iter::repeat_n(0u8, tail));
        }
    };
    let cases: Vec<(&str, Vec<u8>)> = vec![
        ("fixture-h100", h100.clone()),
        ("fixture-b200", b200.clone()),
        ("device-b200-on-h100", edit(&h100, &|v| v[115] = 1)),
        ("device-2", edit(&h100, &|v| v[115] = 2)),
        ("device-255", edit(&h100, &|v| v[115] = 255)),
        ("quant-1", edit(&h100, &|v| v[114] = 1)),
        ("hash-id-b-4", edit(&h100, &|v| v[120] = 4)),
        ("hash-id-a-3", edit(&h100, &|v| v[163] = 3)),
        ("hash-id-a-7", edit(&h100, &|v| v[163] = 7)),
        ("k-zero", edit(&h100, &|v| v[108..112].copy_from_slice(&0u32.to_le_bytes()))),
        ("rank-16", edit(&h100, &|v| v[112..114].copy_from_slice(&16u16.to_le_bytes()))),
        ("tile-bases-moved", edit(&h100, &|v| v[200..204].copy_from_slice(&32u32.to_le_bytes()))),
        ("truncated", h100[..239].to_vec()),
        ("trailing-byte", edit(&h100, &|v| v.push(0))),
        ("header-only", h100[..108].to_vec()),
        ("empty", vec![]),
        ("experts-without-tail", edit(&h100, &|v| v[125..127].copy_from_slice(&1u16.to_le_bytes()))),
        ("moe-tail-short", edit(&h100, &moe_tail(2, 2 + 12 + 64 + 4 * h - 1))),
        ("moe-tail-whole", edit(&h100, &moe_tail(2, 2 + 12 + 64 + 4 * h))),
        ("moe-tail-long", edit(&h100, &moe_tail(2, 2 + 12 + 64 + 4 * h + 1))),
    ];
    let commit = std::env::var("PEARL_COMMIT").expect("PEARL_COMMIT names the fp8-scheme commit");
    let mut out = format!(
        "{{\n  \"source\": \"zk_pow::v4::api::public_params::PublicParams::from_bytes\",\n  \"commit\": {},\n  \"statements\": [\n",
        quote(&commit)
    );
    for (i, (name, data)) in cases.iter().enumerate() {
        let (debug, error) = match PublicParams::from_bytes(data) {
            Ok(params) => (format!("{params:?}"), String::new()),
            Err(err) => (String::new(), format!("{err:#}")),
        };
        out.push_str(&format!(
            "    {{ \"name\": {}, \"hex\": {}, \"debug\": {}, \"error\": {} }}{}\n",
            quote(name), quote(&hex(data)), quote(&debug), quote(&error),
            if i + 1 < cases.len() { "," } else { "" }
        ));
    }
    out.push_str("  ]\n}\n");
    print!("{out}");
}
