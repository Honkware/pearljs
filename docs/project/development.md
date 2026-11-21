# Development

The scripts, tests and build steps behind pearljs, for anyone changing more than a few lines. [CONTRIBUTING.md](../../CONTRIBUTING.md) covers sending a change.

## Checks

```sh
npm ci
npm run check
```

`check` runs, in order:

1. lint
2. typecheck
3. the build
4. the tests
5. the offline examples
6. the check of the code in the docs

Run it before every commit. The XMSS tests take several seconds each.

Other scripts:

- `npm run verify:pack` packs the package and installs the tarball in a fresh temp project. It checks the file list and the links between the packed documents. It checks that Node loads the package as ESM and with `require()`, and that its types resolve under `nodenext` and `bundler`. It also checks tree shaking and runs publint and attw. It needs network access for `npm install` and `npx`. Set `PEARLJS_SKIP_LINT_TOOLS=1` to skip publint and attw.
- `npm run test:browser` bundles the packed package with Vite and tests it in headless browsers. It runs the Go vectors, the proof verifier, and the IndexedDB store with a wallet kept in it. `BROWSERS` picks the browsers from `chrome`, `firefox`, `firefox-private` and `safari`, and is Chrome alone unless given. `CHROME` and `FIREFOX` name a binary. A browser that is not installed, or Safari before `safaridriver --enable`, is reported as skipped. `-- --serve` builds and serves the page for a browser driven by hand.
- `npm run examples` compiles `examples/` and runs the programs that need no node. `check` runs it after the build, since the examples import `pearljs` by name and Node resolves that to `dist/`.
- `npm run check:docs` typechecks every TypeScript block in `README.md` and `docs/` against `src/` and executes the ones marked `run`. `--show` prints what they print.
- `npm run docs` builds the API reference into `docs/api/` with TypeDoc and fails on any warning. The directory is ignored by git.
- `npm run demo` runs the invoice example against an in-memory chain.

A new module in `src/` needs four things:

1. An `export * from './name.js'` line in `src/index.ts`, unless it is Node only, a test kit or `verify-proof`.
2. A matching `./name` entry in `exports` in `package.json`.
3. An entry point in `typedoc.json`.
4. A row in `docs/reference/api.md`.

`verify:pack` and `test/docs-api.test.ts` fail when they disagree.

Helpers shared between modules that are not part of the API go in `src/internal/`, which has no subpath. Modules with import-time effects other than setting up their own state would break `sideEffects: false`, so avoid them. `test/subpath-ecc.test.ts` bundles subpaths alone to catch one.

Three tests keep the API honest:

- `test/exports.test.ts` compares every subpath's exports with `test/fixtures/exports.json`. After a deliberate change, run `PEARLJS_UPDATE_EXPORTS=1 npm test -- test/exports.test.ts` and commit the diff.
- `test/errors.test.ts` checks that `docs/reference/errors.md` lists exactly the codes in `src/errors.ts`. Throw a `PearlError` with a code for anything a caller can act on, and keep keys, phrases and passwords out of messages.
- `test/properties.test.ts` runs seeded property tests, 300 cases each. `PEARLJS_PROPERTY_RUNS=20000` runs longer and `PEARLJS_PROPERTY_SEED` changes the cases.

## Tests against real servers

`npm run test:live` runs `test/live/` against a real pearld on regtest, and against Oyster when one is given. Build both from a Pearl checkout as [Verification](verification-live.md) describes, then:

```sh
PEARLD=/path/to/pearl/bin/pearld OYSTER=/path/to/pearl/bin/oyster npm run test:live
```

Without `PEARLD` the tests skip. Every regtest block carries a real ZK certificate, so a full run is slow ([how long](verification-live.md)). Run one file with `npx vitest run --config test/live/vitest.config.ts test/live/<file>`. `PEARLD=/path/to/pearld node scripts/browser-wallet-live.mjs` runs a wallet on the IndexedDB store in headless Chrome against the same kind of node.

`test/blockbook-live.test.ts` is part of `npm test` and skips unless `PEARL_BLOCKBOOK_URL` names a Blockbook. `PEARL_BLOCKBOOK_NETWORK` and `PEARL_BLOCKBOOK_ADDRESSES` are described in [Verification](verification-networks.md#blockbook).

`test/network/` runs against Pearl's public testnet2 through a pearld of your own, and spends real testnet coins. `scripts/network/run.sh` runs it. `scripts/network/dryrun.sh` runs the same files on a local regtest node ([Verification](verification-networks.md#testnet2)).

`scripts/mainnet/` reads a mainnet pearld of your own and Pearl's public Blockbook and changes nothing ([Verification](verification-networks.md#mainnet)). `test/mainnet-blocks/` holds the mainnet blocks and coinbase scripts an earlier pearljs got wrong and runs without a node: `npx vitest run --config test/mainnet-blocks/vitest.config.ts`.

## Regenerating vectors

Every expected value comes from Pearl's code, a run, or a pinned upstream vector. Do not edit the JSON by hand. Each generator's header says how to run it, from which Pearl checkout and with which build tags. Most need Go 1.26.10, and the XMSS ones Pearl's XMSS library and the `xmss` tag.

| Generator | Writes | From |
| --- | --- | --- |
| `vectors/generate.go` | `vectors/pearl-go.json` | Pearl's Go packages on master |
| `vectors/rpcfixtures_test.go`, `vectors/wsfixtures_test.go` | RPC replies and websocket frames in `test/fixtures/` | pearld's own handlers and notification manager, joined through a build overlay |
| `vectors/recoverywalk_test.go` | `test/fixtures/oyster-recovery-walk.json` | Oyster's own recovery, joined to its wallet package through a build overlay |
| `vectors/gcs/generate.go` | `vectors/gcs.json` | Pearl's gcs and builder packages |
| `vectors/difficulty_test.go` | `vectors/difficulty.json` | `calcNextRequiredDifficulty`, joined to package blockchain through a build overlay |
| `vectors/interpreter/generate.go` | `vectors/interpreter/vectors.json.gz` | `txscript.NewEngine`; `sweep.sh` runs a larger random sweep |
| `vectors/fp8/generate.go`, `vectors/fp8/statement/main.rs` | `vectors/fp8.json`, `vectors/fp8-statements.json` | the fp8-scheme branch's Go code and zk-pow's V4 decoder |
| `vectors/mining/` | `zkpow.json`, `fp8.json`, `node.json`, `proofs.json`, `proofs-differential.json`, `proofs-v1.json`, `plain.json`, `plain-large.json`, `gateway.json`, `gateway-fp8.json`, `stats.json` | zk-pow on both branches, pearld's mining package, `zkpow.VerifyZKProofFFI` and `zkpow.VerifyCertificate`, zk-pow's plain-proof FFI, pearl-gateway's own client and server, and SciPy for the luck intervals |

The commands are also in [Verification](verification.md) and in the closing section of the guide each set of vectors belongs to.

## Rebuilding the proof verifier

`src/verify-proof/` holds `verifier.wasm`, the three circuit caches and `LICENSES.txt`. `src/internal/verify-proof-digests.ts` holds the SHA-256 of the module and the caches.

`wasm/pearl-source.txt` names the Pearl commit and the tree of the source the committed files come from. `wasm/rust-toolchain.toml` pins the compiler (rustc 1.100.0).

To rebuild them:

1. Check out Pearl's fp8-scheme branch at the commit `wasm/pearl-source.txt` names. The build refuses other source unless `PEARL_COMMIT` names it.
2. Read the header of `wasm/build.sh`, which lists what the build needs. It applies the patches in `wasm/patches/` to a copy of the checkout.
3. Run `PEARL_FP8=/path/to/pearl wasm/build-in-container.sh OUT`. It builds in the pinned linux/amd64 container of `wasm/Dockerfile`, where two builds gave the same `verifier.wasm`.
4. Take the files from the container's output. The committed files are the ones this container builds. A build on another host platform is the same code with another digest ([Reproducing the build](../guides/verify-proof-build.md)).
5. Commit the files and the digests together. The verifier refuses a file whose digest is not the pinned one.

`PEARL_FP8=/path/to/pearl wasm/build.sh` also rebuilds all of them, on the host's own platform.

## Documentation

Pages are sorted by kind under `docs/`: `start` for first steps, `guides` for one task each, `concepts` for explanation, `reference` for tables and formats, and `project` for how the SDK is tested. `docs/README.md` is the index and lists every page once.

A guide follows its task in the order a reader does it and is written around a working example. Options, limits and edge cases go on a reference page, and the guide links there. A fact has one home, and other pages link to it. Dates, timings and run counts from testing go in the verification pages under `docs/project/`, not in a guide.

Code blocks are checked. A block fenced as `ts` must typecheck. Add `run` after `ts` when the block needs no node, and it is executed too. Keep the comments that show output in step with what `npm run check:docs -- --show` prints. `ts continues` joins a block to the one before it, `ts fragment` wraps statements in a function, and a `<!-- check-docs: declare const x: T; -->` comment above a block declares names it takes from its surroundings. The header of `scripts/check-docs.mjs` has the details.

Every number, default, flag and limit in the docs comes from the code or from Pearl's source. Fee rates are grain per 1000 vbytes everywhere; say so wherever a parameter's name suggests otherwise.

An example in `examples/` that needs a node says so in its header with a line starting `Needs a running`, which is how `npm run examples` knows to compile it without running it. It reads the URL and credentials from the environment.

Every exported symbol has a doc comment that states its contract in one sentence. `npm run docs` builds the reference from them.
