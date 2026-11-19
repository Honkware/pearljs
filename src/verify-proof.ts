// Full verification of a certificate's ZK proof, with the verifier pearld
// runs compiled to WebAssembly (wasm/ in the repository builds it). The
// checks before the proof are VerifyZKProofFFI's (node/zkpow/verify.go), in
// its order and with its messages; the proof is then judged by zk-pow's own
// code against the same circuit caches pearld embeds.
//
// Nothing loads at import. The first verification fetches the 3 MB module
// and the cache for its version (2.5 MB for V2 and V3, 2.6 MB for V4); the
// other version's cache loads only if it is needed.

/**
 * Proof verification: a V2, V3 or V4 certificate's ZK proof checked by
 * Pearl's verifier compiled to WebAssembly, in Node and in browsers, against
 * a block's bits or a pool's share bits.
 *
 * @module
 */

import type { PearlBlock, PearlCertificate } from './block.js';
import { certificateProofCommitment, PUBLIC_DATA_MAX_SIZE_V2 } from './block.js';
import type { PearlBlockHeader } from './blockheader.js';
import { blockHash, serializeBlockHeader } from './blockheader.js';
import { PearlError } from './errors.js';
import { concat, equalBytes, toHex } from './internal/bytes.js';

/** What the verifier made of a proof. */
export interface ProofVerdict {
  /** True when the proof verifies against the header and bits. */
  readonly valid: boolean;
  /**
   * `accepted`, `rejected`, or `error` when the verifier could not judge the
   * proof (pearld's "verification system error").
   */
  readonly outcome: 'accepted' | 'rejected' | 'error';
  /**
   * Pearl's text for the verdict: the verifier's own message, in full, or
   * the message pearld gives when a check before the verifier fails.
   */
  readonly message: string;
}

/** Files the verifier loads, by the name they have next to this module. */
export type ProofVerifierAsset = 'verifier.wasm' | 'v2-cache.bin' | 'v4-cache.bin';

export interface ProofVerifierOptions {
  /**
   * Where to read an asset from, for a page that serves them itself. By
   * default they are read from `verify-proof/` beside this module, with
   * `fetch` or, for a `file:` URL in Node, the file system.
   */
  readonly locate?: (asset: ProofVerifierAsset) => URL | string;
}

interface Exports {
  memory: WebAssembly.Memory;
  alloc(len: number): number;
  dealloc(ptr: number, len: number): void;
  init(): void;
  message_ptr(): number;
  message_len(): number;
  load_v2_cache(ptr: number, len: number): number;
  load_v4_cache(ptr: number, len: number): number;
  verify_v2(header: number, pd: number, pdLen: number, proof: number, proofLen: number, hasBits: number, bits: number, salted: number): number;
  verify_v4(headers: number, headersLen: number, pd: number, pdLen: number, proof: number, proofLen: number, bits: number): number;
}

interface Verifier {
  readonly exports: Exports;
  readonly loaded: Set<'v2' | 'v4'>;
  // Set when a call into the instance threw: its stack pointer and heap may be left mid-call.
  broken: boolean;
}

let locate: (asset: ProofVerifierAsset) => URL | string = (asset) => new URL(`./verify-proof/${asset}`, import.meta.url);
let compiled: Promise<WebAssembly.Module> | null = null;
let current: Promise<Verifier> | null = null;
// What current resolved to, so a failed call can drop it before anything else runs.
let live: Verifier | null = null;

type NodeFs = { readFile(path: URL): Promise<Uint8Array> };

async function read(asset: ProofVerifierAsset): Promise<Uint8Array<ArrayBuffer>> {
  const where = locate(asset);
  const url = typeof where === 'string' ? new URL(where, globalThis.location?.href) : where;
  try {
    if (url.protocol === 'file:') {
      // getBuiltinModule rather than an import, so bundlers never see node:fs.
      const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
      const fs = proc?.getBuiltinModule?.('node:fs/promises') as NodeFs | undefined;
      if (!fs) throw new Error('no file system to read a file: URL from');
      return new Uint8Array(await fs.readFile(url));
    }
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    throw new PearlError('PROOF_VERIFIER_UNAVAILABLE', `cannot load ${asset} from ${url.href}: ${(error as Error).message}`, { cause: error });
  }
}

function instantiate(): Promise<Verifier> {
  compiled ??= read('verifier.wasm')
    .then((bytes) => WebAssembly.compile(bytes))
    .catch((error: unknown) => {
      compiled = null;
      throw error instanceof PearlError ? error : new PearlError('PROOF_VERIFIER_UNAVAILABLE', `cannot compile verifier.wasm: ${(error as Error).message}`, { cause: error });
    });
  return compiled.then(async (module) => {
    // wasm-bindgen leaves one import, its throw helper, behind js-sys code the verifier never reaches.
    const imports: Record<string, Record<string, () => never>> = {};
    for (const { module: from, name } of WebAssembly.Module.imports(module)) {
      if (!name.includes('wbindgen_throw')) throw new PearlError('PROOF_VERIFIER_UNAVAILABLE', `verifier.wasm imports ${from}.${name}`);
      (imports[from] ??= {})[name] = () => {
        throw new Error('wasm-bindgen throw');
      };
    }
    const instance = await WebAssembly.instantiate(module, imports);
    const exports = instance.exports as unknown as Exports;
    exports.init();
    return { exports, loaded: new Set<'v2' | 'v4'>(), broken: false };
  });
}

function discard(verifier: Verifier): void {
  verifier.broken = true;
  if (live === verifier) {
    live = null;
    current = null;
  }
}

function message(exports: Exports): string {
  return new TextDecoder().decode(new Uint8Array(exports.memory.buffer, exports.message_ptr(), exports.message_len()));
}

// Copies each input into the module, runs f on the pointers and frees them.
function withBytes(exports: Exports, inputs: readonly Uint8Array[], f: (ptrs: number[]) => number): number {
  const ptrs = inputs.map((bytes) => {
    const ptr = exports.alloc(bytes.length);
    new Uint8Array(exports.memory.buffer, ptr, bytes.length).set(bytes);
    return ptr;
  });
  // After a trap the instance is dropped, so nothing is freed on that path.
  const result = f(ptrs);
  ptrs.forEach((ptr, i) => exports.dealloc(ptr, inputs[i]!.length));
  return result;
}

async function verifierFor(cache: 'v2' | 'v4'): Promise<Verifier> {
  for (;;) {
    const pending = (current ??= instantiate().then(
      (verifier) => (live = verifier),
      (error: unknown) => {
        current = null;
        throw error;
      },
    ));
    const verifier = await pending;
    if (!verifier.loaded.has(cache)) {
      const bytes = await read(cache === 'v2' ? 'v2-cache.bin' : 'v4-cache.bin');
      if (!verifier.loaded.has(cache) && !verifier.broken) {
        const { exports } = verifier;
        let code: number;
        try {
          code = withBytes(exports, [bytes], ([ptr]) => (cache === 'v2' ? exports.load_v2_cache(ptr!, bytes.length) : exports.load_v4_cache(ptr!, bytes.length)));
        } catch (error) {
          discard(verifier);
          throw new PearlError('PROOF_VERIFIER_UNAVAILABLE', `cannot load ${cache}-cache.bin: ${(error as Error).message}`, { cause: error });
        }
        if (code !== 0) throw new PearlError('PROOF_VERIFIER_UNAVAILABLE', message(exports));
        verifier.loaded.add(cache);
      }
    }
    // Another call may have broken the instance while this one waited.
    if (!verifier.broken) return verifier;
  }
}

/**
 * Load the verifier and the circuit caches for the given certificate
 * versions now rather than at the first verification. Optional: every
 * verification loads what it needs. `locate` applies to this and every
 * later load. Throws PROOF_VERIFIER_UNAVAILABLE when an asset cannot be
 * read or is not the one Pearl's verifier pins.
 */
export async function loadProofVerifier(versions: readonly (2 | 3 | 4)[] = [2, 3, 4], options: ProofVerifierOptions = {}): Promise<void> {
  if (options.locate) {
    locate = options.locate;
    if (current === null) compiled = null;
  }
  const caches = new Set(versions.map((v) => (v === 4 ? 'v4' : 'v2') as 'v2' | 'v4'));
  for (const cache of caches) await verifierFor(cache);
}

const rejected = (message: string): ProofVerdict => ({ valid: false, outcome: 'rejected', message });
const displayHash = (hash: Uint8Array): string => toHex(Uint8Array.from(hash).reverse());

/**
 * Verify a certificate's ZK proof for a header, as pearld's
 * VerifyZKProofFFI does: the certificate must name the header's hash and
 * match its proof commitment, then the proof is judged against `bits`, the
 * header's own unless a pool's share bits are given. V2 and V3 proofs are
 * judged with V2's and V3's noise seeds, V4 proofs with the certificate's
 * ancestor headers. A V1 certificate is rejected with pearld's message.
 *
 * Resolves to the verdict; it rejects only with PROOF_VERIFIER_UNAVAILABLE
 * when the verifier cannot be loaded, and with RangeError for bits that are
 * not a uint32. When the module traps or the engine throws inside it, the
 * verdict is `error` and the instance is discarded; the next call loads a
 * fresh one.
 */
export async function verifyProof(header: PearlBlockHeader, certificate: PearlCertificate, options: { readonly bits?: number } = {}): Promise<ProofVerdict> {
  const { bits } = options;
  if (bits !== undefined && (!Number.isInteger(bits) || bits < 0 || bits > 0xffffffff)) throw new RangeError('bits must be a uint32');
  const headerBytes = serializeBlockHeader(header);
  const hash = blockHash(header);
  if (!equalBytes(certificate.hash, hash)) {
    return rejected(`block hash mismatch: certificate has ${displayHash(certificate.hash)}, header has ${displayHash(hash)}`);
  }
  const commitment = certificateProofCommitment(certificate);
  if (!equalBytes(header.proofCommitment, commitment)) {
    return rejected(`proof commitment mismatch: header has ${displayHash(header.proofCommitment)}, certificate has ${displayHash(commitment)}`);
  }
  const { version, publicData, proof } = certificate;
  if (publicData.length === 0) return rejected('empty public data');
  if (version === 4 && publicData.length > PUBLIC_DATA_MAX_SIZE_V2) {
    return rejected(`fp8 public data too large: ${publicData.length} bytes (max ${PUBLIC_DATA_MAX_SIZE_V2})`);
  }
  if (proof.length === 0) return rejected('empty proof data');
  if (version !== 2 && version !== 3 && version !== 4) return rejected(`unsupported certificate version ${version} for FFI verification`);

  let verifier = await verifierFor(version === 4 ? 'v4' : 'v2');
  while (verifier.broken) verifier = await verifierFor(version === 4 ? 'v4' : 'v2');
  const { exports } = verifier;
  let code: number;
  try {
    code =
      version === 4
        ? withBytes(exports, [concat([headerBytes, ...(certificate.ancestorHeaders ?? []).map(serializeBlockHeader)]), publicData, proof], ([h, pd, p]) =>
            exports.verify_v4(h!, headerBytes.length + 108 * (certificate.ancestorHeaders?.length ?? 0), pd!, publicData.length, p!, proof.length, bits ?? header.bits),
          )
        : withBytes(exports, [headerBytes.subarray(0, 76), publicData, proof], ([h, pd, p]) =>
            exports.verify_v2(h!, pd!, publicData.length, p!, proof.length, bits === undefined ? 0 : 1, bits ?? 0, version === 3 ? 1 : 0),
          );
  } catch (error) {
    // A trap, or the engine giving up inside the module (stack overflow, out of memory),
    // leaves the instance mid-call. Drop it before any other call can reach it.
    discard(verifier);
    if (error instanceof WebAssembly.RuntimeError) {
      // A panic's hook saved its message before the trap.
      const text = message(exports);
      return { valid: false, outcome: 'error', message: text.startsWith('Internal panic: ') ? text : `Internal panic: ${error.message}` };
    }
    const { name, message: text } = error instanceof Error ? error : new Error(String(error));
    return { valid: false, outcome: 'error', message: `Internal error: ${name}: ${text}` };
  }
  const text = message(exports);
  if (code === 0) return { valid: true, outcome: 'accepted', message: text };
  return { valid: false, outcome: code === 1 ? 'rejected' : 'error', message: text };
}

/**
 * verifyProof for a block's own header and certificate. A block without a
 * certificate is rejected.
 */
export function verifyBlockProof(block: PearlBlock, options: { readonly bits?: number } = {}): Promise<ProofVerdict> {
  if (block.certificate === null) return Promise.resolve(rejected('block has no certificate'));
  return verifyProof(block.header, block.certificate, options);
}
