# Proof verifier reference

## Verdicts

The result of every verification is a `ProofVerdict`:

| Field | Value |
| --- | --- |
| `valid` | Whether the proof was accepted |
| `outcome` | `accepted`, `rejected`, or `error` where pearld would report a verification system error |
| `message` | The verifier's text |

A rejection carries the verifier's own text in full, `Proof Invalid` or `Jackpot condition not satisfied: hash does not meet difficulty target` for instance. pearld cuts the same text to 127 bytes and puts `proof rejected: ` before it.

For a V1 certificate the verdict on a valid proof is `V1 proof verified successfully`, and pearld puts `v1 proof rejected: ` before a rejection. With `bits` given, a V1 certificate gets `VerifyZKProofFFI`'s answer, `unsupported certificate version 1 for FFI verification`.

A plain proof's message is the FFI's, in full, and pearld keeps the first 127 bytes of it:

| Outcome | Message |
| --- | --- |
| Accepted | `accepted` |
| Rejected | `rejected: ...` or `deserialize: ...` |
| Error | `Null/empty input`, `header: ...` or `panic: ...` |

A failure to read, compile or load a file throws `PROOF_VERIFIER_UNAVAILABLE`. A verdict never does.

## Shares and plain proofs

`verifyProof(header, certificate, { bits })` judges a certificate against `bits`, which defaults to the header's own. A pool passes its share bits, as pearl-gateway does with the nbits override of `VerifyZKProofFFI`, so the same certificate can count as a share and as a block. Run the cheap jackpot check first and call the verifier only for shares that pass it:

```ts fragment
import type { PearlCertificate, PearlBlockHeader } from 'pearljs';
import { checkJackpot } from 'pearljs/mining';
import { verifyProof } from 'pearljs/verify-proof';

// A pool judging a share: the cheap checks first, the proof only if they pass.
async function acceptShare(header: PearlBlockHeader, certificate: PearlCertificate, shareBits: number): Promise<boolean> {
  checkJackpot(certificate, shareBits, { rankPenalty: true }); // throws JACKPOT_ABOVE_TARGET for a miss
  const verdict = await verifyProof(header, certificate, { bits: shareBits });
  return verdict.valid;
}
```

`verifyPlainProof(job, plainProof, { bits })` checks a plain proof a miner sent:

<!-- check-docs: declare const request: Extract<import('pearljs/gateway').GatewayRequest, { method: 'submitPlainProof' }>; declare const shareBits: number; -->
```ts fragment
import { verifyPlainProof } from 'pearljs/verify-proof';

// request: a submitPlainProof line a miner sent, from decodeGatewayRequest
const verdict = await verifyPlainProof(request.job, request.plainProof, { bits: shareBits });
if (!verdict.valid) console.log(`share refused: ${verdict.message}`);
```

When `bits` is omitted or 0, the header's own bits are used. A plain proof needs no circuit cache, so this check loads only the verifier.

The job is a `PlainProofJob`, which is a `MiningJob` or anything else with its `incompleteHeader` (the 76-byte header without its proof commitment) and its `certVersion`. The certificate version picks the format the proof is read in:

| `certVersion` | Plain proof format |
| --- | --- |
| 1 to 3 | pearl_mining's `PlainProof`, serialized by bincode with fixed-width integers |
| 4 | `PlainProofV4.to_bytes()` |

## Loading the files

In Node the files are read from `dist/verify-proof/` beside the module. In a page they are fetched relative to the module, from `new URL('./verify-proof/<file>', import.meta.url)`, which Vite, webpack, Parcel and Next.js turn into emitted assets ([Bundle pearljs for a browser](../guides/browsers-and-bundlers.md#configure-your-bundler)). Where the bundler leaves that URL alone, as esbuild and Rollup do, or where the files are served from somewhere else, pass `locate` to say where they are:

```ts fragment
import { loadProofVerifier } from 'pearljs/verify-proof';

await loadProofVerifier([3, 4], { locate: (file) => `/static/pearl/${file}` });
```

`locate` applies to the files read by the call that passes it, and the verifier keeps reading any caches it needs later from the same place. Serve `.wasm` files as `application/wasm`.

The verifier hashes each file before using it, which needs WebCrypto, and browsers offer WebCrypto only on secure origins (HTTPS or localhost). Verification runs on the calling thread, so a page that verifies often should run it in a worker, and a server should use a worker thread per core.

## Size limits

| Limit | Value | Message |
| --- | --- | --- |
| Certificate proof, V2 to V4 | 62000 bytes | the verifier's, before anything is copied into the module |
| Public data, V2 to V4 | a length a certificate of its version can have | the verifier's, before anything is copied into the module |
| V4 public data | 4807 bytes | |
| V4 ancestor headers | three | the verifier's, before anything is copied into the module |
| V1 proof | 60000 bytes | `v1 proof rejected: legacy proof data too large: ...` |
| V1 public data | 164 bytes | `v1 proof requires 164 byte public_data, got ...` |
| Plain proof | `maxSize`, default `DEFAULT_MAX_PLAIN_PROOF_SIZE` (8 MiB) | `plain proof too large: ...` |

The 8 MiB default is the size the FFI's documentation suggests, and `maxSize: Infinity` lifts it.

A 26 KB plain proof declaring `k` = 2^26 would take 3.7 GiB. The dimensions are the first four fields of the bincode, so `verifyPlainProof` refuses these before the module sees the proof:

- `noise_rank` past 1024;
- `k` past 2^16;
- `m` or `n` past 2^24.

The refusal uses the sanity check's own words (`rejected: k must be <= 2^16 || k=...`), where the FFI rejects the same proof at an earlier step. No proof past these bounds is accepted.

## Files

The first verification reads the verifier and the circuit cache for its certificate version:

| File | For | Size | Gzipped |
| --- | --- | --- | --- |
| `verifier.wasm` | every version | 3.4 MB | 0.8 MB |
| `v1-cache.bin` | V1 | 2.5 MB | 1.3 MB |
| `v2-cache.bin` | V2 and V3 | 2.5 MB | 1.3 MB |
| `v4-cache.bin` | V4 | 2.6 MB | 1.6 MB |

## Memory

An instance's memory grows to what the largest proof so far needed:

- 48 MiB for mainnet block 139000's V3 proof, repeated or not;
- 29 MiB over 100 of four mainnet V1 proofs;
- 14 MiB after V4 certificates.

An instance left past 256 MiB after any call is replaced.

## Speed

One verification, the module and caches already loaded, for the certificates in `vectors/mining/proofs.json`, on an Apple M-series machine with other work running. Native is pearld's own library through `VerifyZKProofFFI`, on one thread and on all of them:

| Certificate | Native, 1 thread | Native, all threads | Node 22 | Chrome 157 |
| --- | --- | --- | --- | --- |
| V2 or V3 | 19 to 22 ms | 4 ms | 67 ms | 61 ms |
| V4 | 25 ms | 5 ms | 81 ms | 74 ms |

A plain proof from the vectors takes 0.3 ms for V2 or V3 and 11 ms for V4, in Node on an Apple M-series machine.

Loading the module and one cache takes 50 to 70 ms once the files are read.

## Building the verifier

### Outside the container

`wasm/build.sh` can also run directly against a fp8-scheme checkout, and it lists what it needs. `wasm/rust-toolchain.toml` pins the compiler at rustc 1.100.0. The build maps its own directories to fixed names (`/build`, `/cargo`, `/rustc`), so the module contains no path from the machine that built it.

The container fixes the platform because cargo hashes the host triple, and the real path of the build directory, into the names it gives each crate's symbols, and those names decide how the module's functions and data are laid out. A build on macOS, or in a linux/arm64 container, is therefore the same code laid out differently, and `verifyProof` would refuse it because its digest is not the pinned one. The host name does not enter the build: the two linux/amd64 container builds each ran under the host name Docker gave it and still matched.

### Pearl source

`wasm/pearl-source.txt` names the Pearl commit, 1dd75a52e073b4a67079c7b6758228d71865ccea of the fp8-scheme branch, together with a SHA-256 over the SHA-256 and path of every file the build copies from it. Those files are:

- zk-pow, plonky2 and pearl-blake3, without their `target`, `bindings` and `*.bin`;
- `LICENSE`.

`git archive` of that commit gives the same tree. To run only this comparison, without building:

```sh
PEARL_FP8=/path/to/pearl wasm/build.sh --check-source
```

`wasm/build.sh` refuses a `PEARL_FP8` whose copy gives another tree, and a git checkout at another commit or with local changes there. To build from a different commit on purpose, set `PEARL_COMMIT` to the commit the checkout holds. The build then runs and writes the new commit and hash into `pearl-source.txt`, and `build-in-container.sh` writes the file into its output directory, to be committed together with the new files.
