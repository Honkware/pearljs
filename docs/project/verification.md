# Compatibility verification

pearljs is checked against Pearl's own code and against running Pearl software. Each check below names the command that runs it and the page that records its results.

| Checked against | Record |
| --- | --- |
| Vectors that Pearl's Go and Rust code generate, from the master branch and the fp8-scheme branch | [Vectors](verification-vectors.md) |
| A live pearld and Oyster on regtest | [Live regtest suite](verification-live.md) |
| Replies recorded from Pearl's Blockbook servers, and the servers themselves | [Public networks](verification-networks.md#blockbook) |
| Pearl's public test network, testnet2 | [Public networks](verification-networks.md#testnet2) |
| Mainnet, through a mainnet pearld and the public Blockbook | [Public networks](verification-networks.md#mainnet) |
| Headless browsers, and builds from each bundler | [Browsers](verification-browsers.md) |

Dated runs, with their versions and counts, are in [Recorded runs](verification-runs.md).

## Pearl's Go and Rust code

`vectors/generate.go` produces expected values through Pearl's Go packages, and the TypeScript tests compare pearljs against them. Other generators run pearld's RPC handlers, its websocket notification manager, its difficulty code, its compact filter packages, zk-pow's Rust decoder and Pearl's proof verifier. The FP8 vectors come from the fp8-scheme branch.

The tests that read the vectors run with the rest of the unit tests:

```sh
npm test
```

[Vectors](verification-vectors.md) has the generators, the commands that regenerate each file, and what each comparison covers.

## A live pearld and Oyster

`npm run test:live` runs the tests in `test/live/` against a real pearld on regtest, and against Oyster when one is given. The suite builds nothing. It needs pearld and Oyster binaries built from a Pearl checkout:

```sh
PEARLD=/path/to/pearl/bin/pearld OYSTER=/path/to/pearl/bin/oyster npm run test:live
```

[Live regtest suite](verification-live.md) has the build steps, the harness, the order of the files and what the checks showed.

## Pearl's Blockbook servers

`test/fixtures/blockbook/` holds replies recorded from Pearl's Blockbook servers, and `test/blockbook-fixtures.test.ts` reads them as part of `npm test`. The client and backend also run against a live server:

```sh
PEARL_BLOCKBOOK_URL=https://blockbook.pearlresearch.ai npx vitest run test/blockbook-live.test.ts
```

## Testnet2

`test/network/` runs pearljs against Pearl's public test network through a pearld that syncs from the network's own peers. `scripts/network/run.sh` runs it from a node folder, and `scripts/network/check-chain.mjs` follows and checks the chain from block 1.

```sh
npm run build && scripts/network/run.sh
```

## Mainnet

`scripts/mainnet/` checks pearljs against a mainnet pearld and the public Blockbook. The node is used read-only, through a limited RPC user.

```sh
scripts/mainnet/run.sh walk.mjs
npx vitest run --config test/mainnet-blocks/vitest.config.ts
```

[Public networks](verification-networks.md) has the other scripts, the environment they need and what each run checks.

The funded files of `test/network/` have also been run on mainnet with real PRL, on a node with the transaction and address indexes ([Funded run](verification-networks.md#funded-run)).

## Browsers and bundlers

`npm run test:browser` bundles the packed package with Vite and runs it in headless Chrome, Firefox and Safari. Each bundler configuration in [Browsers and bundlers](../guides/browsers-and-bundlers.md#configure-your-bundler) was also built from the packed tarball into a test page.

```sh
npm run test:browser
```

[Browsers](verification-browsers.md) has the options and the checks.

## Not covered

The vectors and the live tests do not cover the following. The larger gaps, such as the missing audit, are in [Known limits](limits.md).

Chains and nodes:

- Mainnet or testnet chain parameters.
- P2P relay between nodes of anything but blocks.
- `estimatefee` under real fee competition.
- `rescanprogress`, which pearld sends from a ten-second ticker that no rescan of a regtest chain reaches.
- Anything on a pearld configured differently from the harness: other relay fees, other package limits, pruning.

Proofs and certificates:

- Proofs beyond those pearld mined on regtest and the vectors of [the proof verifier](verification-vectors.md#proof-verifier).
- Certificate versions 1 and 2 and the dense-only rule, since regtest requires version 3 (master) or 4 (fp8-scheme) from the first block.
- A V4 certificate keyed deeper than the parent or carrying an MoE statement, outside the vectors and testnet2's blocks. pearld's own miner never makes one.

Policy and the mempool:

- Non-standard inputs, which cannot exist on Pearl because consensus refuses the outputs.
- The transaction-too-big-for-a-block, no-input and no-output messages of `checkSanity`. The mempool reaches them only after other checks have refused the transaction.
- A block template under a full block, where ordering would decide what is left out.
- The interpreter on transactions that reach a node some other way than through the suite's client, such as Oyster's own sends.

Wallets and Oyster:

- The `random` coin selection strategy against Oyster, whose RPC always selects largest first (wallet/rpc/jsonrpc/methods.go:1364).
- XMSS spends through PSBT, for which Pearl defines no field.
- Oyster spending P2MR outputs, which it cannot hold. No RPC imports a script, so its key-path pricing of P2MR inputs is never reached.
- Oyster handling PSBTs.
- The wallet's `sweep`, sends from imported keys, and its IndexedDB store, against a node.
- `submitSigned` taking an XMSS signature, which no prepared send can hold, since payments signed elsewhere spend account coins only.
- `crossCheck` with more than one endpoint.
- A `PearlWallet` over an Oyster in SPV mode, which cannot broadcast for it.
- The filter scan for P2MR addresses on a chain longer than a regtest run's.

## Next steps

- [Stability and versioning](stability.md)
- [Troubleshooting](../reference/troubleshooting.md#pearld-and-oyster-behaviour), for the node behaviours the live tests found
