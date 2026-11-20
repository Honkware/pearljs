// The proof verifier pearld runs, compiled to WebAssembly for pearljs/verify-proof.
//
// Each entry point mirrors one of zk-pow's Go FFI functions
// (zk-pow/bindings/go/src/v1.rs, v2/verify.rs and v4/verify.rs on Pearl's
// fp8-scheme branch): the same input checks in the same
// order, the same verifier call, the same return codes (0 accepted, 1
// rejected, 2 system error) and the same text, untruncated. The checks before
// the verifier call and split_v4_headers are copied from those files.
//
// The circuit caches are not embedded. The loader hands this module the bytes
// of the same v1_cache.bin, v2_cache.bin and v4_cache.bin pearld embeds, so a
// proof is judged by exactly the circuits pearld's verifier holds.
//
// The exports are a plain C ABI (alloc, dealloc, message_ptr, message_len and
// the functions below); wasm-bindgen only post-processes the module, for the
// js-sys code getrandom and web-time link in. No threads and no unwinding on
// wasm32-unknown-unknown: a panic traps, after the hook set by init has saved
// its message, and the loader drops the instance.

use std::cell::RefCell;
use std::sync::OnceLock;

use anyhow::{Result, ensure};
use zk_pow::v2::api::proof::{IncompleteBlockHeader, PublicProofParams, ZKProof};
use zk_pow::v2::api::seed::SeedDerivation;
use zk_pow::v2::api::verify;
use zk_pow::v2::circuit::circuit_utils::CircuitCache;
use zk_pow::v1::circuit::circuit_utils::CircuitCache as V1CircuitCache;
use zk_pow::v4::api::primitives::BlockHeader;
use zk_pow::v4::api::primitives::IncompleteBlockHeader as Fp8BlockHeader;
use zk_pow::v4::api::public_params::{PublicParams, STATE_WINDOW_DEPTH};
use zk_pow::v4::api::zk::Fp8VerifierCache;

// bindings/go/src/common.rs
const MAX_ZK_PROOF_SIZE: usize = 62000;
// zk-pow/src/v4/api/embedded_cache.rs pins the first 32 hex digits of the cache's BLAKE3.
const V4_CACHE_DIGEST: &str = "99c0f7da1c9814e94484f4031a3dfa34";

struct Caches {
    v1: OnceLock<V1CircuitCache>,
    v2: OnceLock<CircuitCache>,
    v4: OnceLock<Fp8VerifierCache>,
}

// wasm32-unknown-unknown without the atomics feature has one thread.
unsafe impl Sync for Caches {}

static CACHES: Caches = Caches { v1: OnceLock::new(), v2: OnceLock::new(), v4: OnceLock::new() };

thread_local! {
    static MESSAGE: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

fn set_message(message: &str) {
    MESSAGE.with(|m| *m.borrow_mut() = message.as_bytes().to_vec());
}

/// The last verdict's, load failure's or panic's text, as UTF-8 at
/// message_ptr, valid until the next call.
#[unsafe(no_mangle)]
pub extern "C" fn message_ptr() -> *const u8 {
    MESSAGE.with(|m| m.borrow().as_ptr())
}

#[unsafe(no_mangle)]
pub extern "C" fn message_len() -> usize {
    MESSAGE.with(|m| m.borrow().len())
}

#[unsafe(no_mangle)]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut buffer = Vec::<u8>::with_capacity(len.max(1));
    let ptr = buffer.as_mut_ptr();
    std::mem::forget(buffer);
    ptr
}

/// # Safety
/// `ptr` and `len` must come from one `alloc` call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    unsafe { drop(Vec::from_raw_parts(ptr, 0, len.max(1))) };
}

#[unsafe(no_mangle)]
pub extern "C" fn init() {
    std::panic::set_hook(Box::new(|info| {
        // The FFI reports a caught panic's payload, first line only, the same way.
        let payload = info
            .payload()
            .downcast_ref::<String>()
            .map(String::as_str)
            .or_else(|| info.payload().downcast_ref::<&str>().copied())
            .unwrap_or("Unknown panic");
        set_message(&format!("Internal panic: {}", payload.lines().next().unwrap_or(payload)));
    }));
}

unsafe fn slice<'a>(ptr: *const u8, len: usize) -> &'a [u8] {
    if len == 0 { &[] } else { unsafe { std::slice::from_raw_parts(ptr, len) } }
}

/// Loads v1_cache.bin. Returns 0, or 2 with the reason as the message.
///
/// # Safety
/// `ptr` must point to `len` readable bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn load_v1_cache(ptr: *const u8, len: usize) -> i32 {
    let data = unsafe { slice(ptr, len) };
    if CACHES.v1.get().is_some() {
        return 0;
    }
    // pearld's lazy_static panics on a cache that does not parse; the loader refuses it instead.
    match V1CircuitCache::from_bytes(data) {
        Ok(cache) if !cache.verifier_circuits_1.is_empty() && !cache.verifier_circuits_2.is_empty() => {
            let _ = CACHES.v1.set(cache);
            0
        }
        Ok(_) => {
            set_message("V1 circuit cache is empty");
            2
        }
        Err(e) => {
            set_message(&format!("V1 circuit cache is missing or corrupt; cannot verify V1 proofs: {e}"));
            2
        }
    }
}

/// verify_zk_proof_v1. `header` is the 76-byte incomplete header in wire
/// order. Returns 0 accepted, 1 rejected, 2 system error.
///
/// # Safety
/// `header` must point to 76 readable bytes, the others to their lengths.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn verify_v1(
    header: *const u8,
    public_data: *const u8,
    public_data_len: usize,
    proof: *const u8,
    proof_len: usize,
) -> i32 {
    let (header, public_data, proof) = unsafe {
        (slice(header, IncompleteBlockHeader::SERIALIZED_SIZE), slice(public_data, public_data_len), slice(proof, proof_len))
    };
    let Some(cache) = CACHES.v1.get() else {
        set_message("V1 circuit cache is not loaded");
        return 2;
    };
    if proof.is_empty() {
        set_message("Null or empty proof blob");
        return 1;
    }
    if proof.len() > MAX_ZK_PROOF_SIZE {
        set_message("ZK Proof too large");
        return 1;
    }
    let expected_len = zk_pow::v1::api::proof::PublicProofParams::PUBLICDATA_SIZE;
    if public_data.len() != expected_len {
        set_message(&format!("v1 proof requires {} byte public_data, got {}", expected_len, public_data.len()));
        return 1;
    }
    // The FFI is handed the C header struct and serializes it: the same 76 bytes.
    let header = match IncompleteBlockHeader::from_bytes(header) {
        Ok(h) => h.to_bytes(),
        Err(e) => {
            set_message(&e.to_string());
            return 2;
        }
    };
    match zk_pow::v1::verify_v1(&header, public_data, proof, cache, None) {
        Ok(()) => {
            set_message("V1 proof verified successfully");
            0
        }
        Err(e) => {
            set_message(&format!("{}", e));
            1
        }
    }
}

/// Loads v2_cache.bin. Returns 0, or 2 with the reason as the message.
///
/// # Safety
/// `ptr` must point to `len` readable bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn load_v2_cache(ptr: *const u8, len: usize) -> i32 {
    let data = unsafe { slice(ptr, len) };
    if CACHES.v2.get().is_some() {
        return 0;
    }
    match CircuitCache::from_bytes(data) {
        Ok(cache) if !cache.verifier_circuits_1.is_empty() && !cache.verifier_circuits_2.is_empty() => {
            let _ = CACHES.v2.set(cache);
            0
        }
        Ok(_) => {
            set_message("V2 circuit cache is empty");
            2
        }
        Err(e) => {
            set_message(&format!("V2 circuit cache is missing or corrupt: {e}"));
            2
        }
    }
}

/// Loads v4_cache.bin after checking the digest zk-pow pins. Returns 0 or 2.
///
/// # Safety
/// `ptr` must point to `len` readable bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn load_v4_cache(ptr: *const u8, len: usize) -> i32 {
    let data = unsafe { slice(ptr, len) };
    if CACHES.v4.get().is_some() {
        return 0;
    }
    if &blake3::hash(data).to_hex().as_str()[..32] != V4_CACHE_DIGEST {
        set_message("V4 verifier cache digest mismatch");
        return 2;
    }
    match Fp8VerifierCache::from_bytes(data) {
        Ok(cache) if cache.contains_all_devices() => {
            let _ = CACHES.v4.set(cache);
            0
        }
        Ok(_) => {
            set_message("fp8 verifier cache must contain exactly the H100 and B200 setups");
            2
        }
        Err(e) => {
            set_message(&format!("fp8 verifier cache is missing or corrupt: {e}"));
            2
        }
    }
}

/// verify_zk_proof_v2 and _v3, with or without _with_nbits: `salted` picks
/// V3's seed derivation. `header` is the 76-byte incomplete header in wire
/// order. Returns 0 accepted, 1 rejected, 2 system error.
///
/// # Safety
/// `header` must point to 76 readable bytes, the others to their lengths.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn verify_v2(
    header: *const u8,
    public_data: *const u8,
    public_data_len: usize,
    proof: *const u8,
    proof_len: usize,
    has_nbits: u32,
    nbits: u32,
    salted: u32,
) -> i32 {
    let (header, public_data, proof) = unsafe {
        (slice(header, IncompleteBlockHeader::SERIALIZED_SIZE), slice(public_data, public_data_len), slice(proof, proof_len))
    };
    let Some(cache) = CACHES.v2.get() else {
        set_message("V2 circuit cache is not loaded");
        return 2;
    };
    let header = match IncompleteBlockHeader::from_bytes(header) {
        Ok(h) => h,
        Err(e) => {
            set_message(&e.to_string());
            return 2;
        }
    };
    if proof.is_empty() {
        set_message("Null or empty proof blob");
        return 1;
    }
    if proof.len() > MAX_ZK_PROOF_SIZE {
        set_message("ZK Proof too large");
        return 1;
    }
    if !PublicProofParams::is_valid_wire_size(public_data.len()) {
        set_message(&format!("invalid public_data_len {}", public_data.len()));
        return 1;
    }
    let derivation = if salted != 0 { SeedDerivation::Salted } else { SeedDerivation::Legacy };
    let (params, zk_proof) = match ZKProof::deserialize(header, derivation, public_data, proof) {
        Ok(r) => r,
        Err(e) => {
            set_message(&format!("{e}"));
            return 1;
        }
    };
    let nbits = if has_nbits != 0 { Some(nbits) } else { None };
    match verify::verify_block_cached_circuits_only(&params, &zk_proof, cache, nbits) {
        Ok(()) => {
            set_message("Proof verified successfully");
            0
        }
        Err(e) => {
            set_message(&format!("{e}"));
            1
        }
    }
}

fn valid_v4_headers_len(len: usize) -> bool {
    (BlockHeader::SERIALIZED_SIZE..=STATE_WINDOW_DEPTH * BlockHeader::SERIALIZED_SIZE).contains(&len)
        && len.is_multiple_of(BlockHeader::SERIALIZED_SIZE)
}

fn split_v4_headers(headers: &[u8]) -> Result<(Fp8BlockHeader, Vec<BlockHeader>)> {
    ensure!(valid_v4_headers_len(headers.len()), "invalid v4 headers length {}", headers.len());
    let (proposed, chain) = headers.split_at(BlockHeader::SERIALIZED_SIZE);
    Ok((
        Fp8BlockHeader::from_bytes(&proposed[..Fp8BlockHeader::SERIALIZED_SIZE])?,
        BlockHeader::chain_from_bytes(chain)?,
    ))
}

/// verify_zk_proof_v4: `headers` is the block's 108-byte header followed by
/// the certificate's ancestor headers, parent first.
///
/// # Safety
/// Each pointer must point to its length in readable bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn verify_v4(
    headers: *const u8,
    headers_len: usize,
    public_data: *const u8,
    public_data_len: usize,
    proof: *const u8,
    proof_len: usize,
    nbits: u32,
) -> i32 {
    let (headers, public_data, proof) =
        unsafe { (slice(headers, headers_len), slice(public_data, public_data_len), slice(proof, proof_len)) };
    let Some(cache) = CACHES.v4.get() else {
        set_message("V4 verifier cache is not loaded");
        return 2;
    };
    if !valid_v4_headers_len(headers.len()) {
        set_message(&format!("invalid v4 headers length {}", headers.len()));
        return 1;
    }
    if proof.is_empty() {
        set_message("Null or empty proof blob");
        return 1;
    }
    if proof.len() > MAX_ZK_PROOF_SIZE {
        set_message("FP8 proof too large");
        return 1;
    }
    if !PublicParams::is_valid_wire_size(public_data.len()) {
        set_message(&format!("invalid public_data_len {}", public_data.len()));
        return 1;
    }
    let (header, chain) = match split_v4_headers(headers) {
        Ok(split) => split,
        Err(e) => {
            set_message(&e.to_string());
            return 1;
        }
    };
    match cache.verify_share(&header, &chain, public_data, proof, nbits) {
        Ok(()) => {
            set_message("Proof verified successfully");
            0
        }
        Err(e) => {
            set_message(&format!("{e}"));
            1
        }
    }
}

/// For measurement only (feature measure-setup, never shipped): compiles the
/// setups build_cache writes, V2's circuits when `v4` is 0 and V4's otherwise,
/// and returns the serialized cache's length, or -1 with the reason as the message.
#[cfg(feature = "measure-setup")]
#[unsafe(no_mangle)]
pub extern "C" fn build_setup(v4: u32) -> i64 {
    use zk_pow::v2::circuit::pearl_circuit::{PearlRecursion, RecursionCircuit};
    use zk_pow::v4::api::public_params::Device;
    use zk_pow::v4::api::zk::{Fp8Verifier, sample_dense_statement_for_device};
    let bytes = if v4 == 0 {
        let mut cache = CircuitCache::default();
        PearlRecursion::fill_verifier_cache(&mut cache);
        cache.to_bytes()
    } else {
        let mut cache = Fp8VerifierCache::default();
        Device::ALL
            .into_iter()
            .try_for_each(|device| {
                let params = sample_dense_statement_for_device(device)?;
                let verifier = Fp8Verifier::generate(&params, &Fp8BlockHeader::zero(), &mut Default::default())?;
                cache.insert(device, verifier);
                Ok::<(), anyhow::Error>(())
            })
            .and_then(|()| cache.to_bytes())
    };
    match bytes {
        Ok(b) => b.len() as i64,
        Err(e) => {
            set_message(&e.to_string());
            -1
        }
    }
}
