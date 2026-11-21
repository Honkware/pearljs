# Stability and versioning

Some of pearljs is checked against Pearl's own code and a live pearld. Some is newer and still settling. The tables of most tested and newer areas show which parts to build on directly and which to wrap in code of your own. Read the [changelog](../../CHANGELOG.md) with it before you upgrade.

## Most tested areas

Each of these is compared with values Pearl's Go packages produce, and the live suite has pearld accept and mine what pearljs builds ([Compatibility verification](verification.md)). They follow Pearl closely, so the likeliest reason for one to change is a change in Pearl.

| Part | Includes |
| --- | --- |
| Protocol primitives | Networks, addresses, amounts, mnemonics, accounts, WIF, scripts and script trees |
| Signing | Key paths, script paths and XMSS leaves |
| PSBT | [PSBT workflows](../guides/psbt.md) |
| Clients | The pearld and Oyster clients, over HTTP and websocket |
| Relay policy and fee bumping | [Relay policy and fee bumping](../guides/relay-policy-and-fee-bumping.md) |
| Blocks and consensus data | `nextBlockBits` included |

## Newer areas

These are covered by unit tests, many of them on the simulated chain, but have seen less use. Their options, events and stored records are more likely to change.

| Part | Notes |
| --- | --- |
| `PearlWallet`, the keystore and the three stores | The wallet also runs against pearld and Oyster in the live suite. |
| XMSS key births, which a wallet passes to a backend through `setAddressBirths` | |
| `filterBackend` and `connectPearld` | Both also run against pearld in the live suite, as the limited user and on a node without indexes. |
| The chain follower, `pearljs/follow` | It also runs against pearld in the live suite, through reorganizations. |
| The invoice watcher (`watchInvoices`) and `InvoiceIndexAllocator` | |
| The test kit, `pearljs/testing` and `pearljs/testing-regtest` | |
| V4 certificates and the `fp8` fork heights | They follow Pearl's fp8-scheme branch, a pre-release (1.6.0-fp8-testnet1). What that branch changes, pearljs will. |
| The script interpreter, as a check before broadcasting | It agrees with Pearl's engine on every generated spend it is tested against. pearld's verdict on a transaction still decides. |
| The Blockbook clients and `blockbookBackend`, including `useXpub` and the websocket-only mode | They are held to replies recorded from Pearl's servers, and an opt-in test runs them against those servers. |
| `pearljs/mining`, `pearljs/gateway` and `pearljs/verify-proof`, V1 certificates and `verifyPlainProof` included | The verifier is built from the fp8-scheme branch and changes with it. |
| `pearljs/recover` | |
| The message formats other than Oyster's | |
| The hash timelock leaves | |
| Keystore sessions | |
| `pearldFetch` and the worker build of secp256k1 | |

What these modules store carries a format version. A wallet store has `WALLET_SCHEMA_VERSION`, and a keystore, an invoice record and the allocator's state each have `version`. A newer pearljs that changes one says so in the changelog. A wallet refuses a store from a newer schema (`WALLET_SCHEMA`) instead of misreading it.

## Breaking changes while the version is 0.x

The intent is that a release which breaks code written against the one before raises the minor version, from 0.1 to 0.2, and that a patch release, 0.1.1, does not. npm's `^0.1.0` range stays within 0.1.x, so it picks up patches only.

Every breaking change gets a line in [CHANGELOG.md](../../CHANGELOG.md) that says what to change in your code. Error codes count as part of the interface and change only that way. Error messages may gain detail in any release ([Errors](../reference/errors.md)).

## Node and packaging

pearljs needs Node.js 20.19 or newer on the 20 line, or 22.12 or newer (`"engines": { "node": "^20.19.0 || >=22.12.0" }`). In a browser it needs a bundler that loads WebAssembly ([Browsers and bundlers](../guides/browsers-and-bundlers.md)).

It is ESM only, with no CommonJS build. Those Node versions load it with `require()` too. Each module is its own subpath export, and TypeScript resolves them under `moduleResolution` `node16`, `nodenext` or `bundler`.

Three suites pass on macOS (Apple silicon, Node 22) and on Windows 11 (x64, Node 24): `npm run check`, the live suite against a regtest pearld and Oyster, and the browser tests. On Windows the browser tests pass in Chrome, Firefox and Edge.

On Windows the file stores wait up to a quarter of a second for a lock file another process has open before reporting the store as locked.

## Meaning of verified

When these guides say something is verified, or checked against Pearl, they mean one of two things:

- A test compares pearljs's result with the result Pearl's Go code gives for the same input.
- The live suite had a real pearld (and, where it says so, Oyster) on regtest accept what pearljs built.

[Compatibility verification](verification.md) lists exactly what each covers and what neither reaches. It is not an audit.
