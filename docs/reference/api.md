# API reference

Every exported function, type and constant has a reference page, generated from the doc comments in `src/` with TypeDoc. Each module has a row naming what it holds and the guide that covers it.

The reference has one page per subpath export of the package, under the same name: `amount` documents `pearljs/amount`, `rpc` documents `pearljs/rpc`, and so on. The `index` page is the main entry. It re-exports every module except these, which you import by name:

- The Node-only modules: `xmss-file-store`, `store-file`, `tls-fetch` and `testing-regtest`.
- The test kit, `testing`.
- `verify-proof`.

| Module | What is in it | Guide |
| --- | --- | --- |
| `networks` | The five network objects and their parameters | [Networks and addresses](../guides/networks-and-addresses.md) |
| `address` | Encode, decode and check addresses; address and output script conversion | [Networks and addresses](../guides/networks-and-addresses.md) |
| `amount` | Grain and PRL conversion, fee rate conversion | [Building and sending payments](payments-fees-and-coins.md#fee-units) |
| `mnemonic` | BIP39 phrases and seeds | [Keys, mnemonics and accounts](../guides/keys-and-accounts.md) |
| `keys` | BIP86 watch-only and signing accounts | [Keys, mnemonics and accounts](../guides/keys-and-accounts.md) |
| `wif` | Wallet import format and key-path addresses of single keys | [Keys, mnemonics and accounts](../guides/keys-and-accounts.md#use-single-keys) |
| `backend` | Wallet backends over pearld and Oyster | [Wallet backends and discovery](../guides/wallet-backends.md) |
| `backend-filters` | The wallet backend over compact block filters | [Compact filters](../guides/compact-filters.md#run-a-wallet-over-filters) |
| `blockbook`, `backend-blockbook` | The Blockbook REST and websocket clients, and the wallet backend over them | [Blockbook](../guides/blockbook.md) |
| `discovery` | `discoverAccount` | [Wallet backends and discovery](../guides/wallet-backends.md#discovery) |
| `wallet` | `PearlWallet`: accounts, sync, sending, XMSS keys | [Wallet state and storage](../concepts/wallet.md) |
| `keystore` | The encrypted keystore a wallet keeps its secrets in | [Wallet state and storage](../concepts/wallet.md) |
| `store`, `store-indexeddb` | The `WalletStore` interface, the memory store and the IndexedDB store | [Wallet state and storage](../concepts/wallet.md) |
| `store-file` | The file-backed wallet store, Node only | [Wallet state and storage](wallet-storage.md#stores) |
| `message` | Message signing and verification | [Messages](../guides/messages.md) |
| `builder` | `buildPayment`, `payFromAccount`, `finalizePayment`, `addInputByTxid` | [Send a payment](../guides/send-a-payment.md), [Build a payment for another signer](../guides/payments.md) |
| `coinselect` | Coin selection as Oyster does it | [Building and sending payments](payments-fees-and-coins.md#coin-selection) |
| `sweep` | Sweeping a single key | [Building and sending payments](../guides/payments-by-hand.md#sweep-a-single-key) |
| `inspect` | `inspectTransaction` | [Building and sending payments](../guides/payments-by-hand.md#read-a-transaction), [Following the chain](../guides/explorer-transactions.md#decode-every-transaction) |
| `payments` | P2TR, P2MR and OP_RETURN output scripts | [Networks and addresses](../guides/networks-and-addresses.md#make-an-address) |
| `policy` | Relay policy, dust, relay fee, size estimates | [Relay policy and fee bumping](../guides/relay-policy-and-fee-bumping.md) |
| `rbf` | Replacement rules, CPFP, package limits | [Relay policy and fee bumping](../guides/relay-policy-and-fee-bumping.md#replace-by-fee) |
| `recover` | Seed recovery diagnostics across every derivation Pearl's wallets used | [Recovering a seed that shows zero](../guides/recovery.md) |
| `client`, `invoice`, `invoice-watch` | The `ChainClient` interface, the invoice monitor and the invoice watcher | [Invoices](../guides/invoices.md) |
| `scripttree` | Script trees, control blocks, leaf commitments | [P2MR and script trees](../guides/p2mr.md) |
| `scriptpath` | Script-path signing for P2TR and P2MR, the tapscript sighash | [P2MR and script trees](../guides/p2mr.md) |
| `multia` | multi_a leaves | [Multisig and timelocks](../guides/multisig-and-timelocks.md) |
| `script` | Leaf builders, timelocks, sequences, classification, tagged hashes | [Scripts](../guides/scripts.md) |
| `scripttools` | Compile, decompile, disassembly, script numbers | [Scripts](../guides/scripts.md) |
| `crypto` | SHA-256, double SHA-256 and HASH160 | [Scripts](../guides/scripts.md#hashes) |
| `xmss` | XMSS keys, signatures, signers and the memory index store | [XMSS](../concepts/xmss.md) |
| `xmss-file-store` | The file-backed index store, Node only | [XMSS](../guides/xmss-store.md#use-the-file-store) |
| `transaction` | Transactions and PSBTs: parse, create, finalize | [PSBT workflows](../guides/psbt.md) |
| `interpreter` | A script interpreter that follows Pearl's engine | [Script interpreter](../guides/interpreter.md) |
| `rpc` | The pearld and Oyster clients, transports, errors | [Node and wallet RPC](../guides/rpc.md) |
| `ws` | The websocket client | [Websocket notifications](../guides/websocket.md) |
| `gcs` | Compact block filters | [Compact filters](../guides/compact-filters.md) |
| `follow` | `followChain`, `watchChain`, `resolvePrevouts`, `prevoutsFromSearch`, `fetchMempool` | [Following the chain](../guides/explorer.md) |
| `block`, `blockheader` | Blocks, certificates and headers | [Blocks, certificates and consensus data](../guides/blocks-and-consensus.md) |
| `consensus` | Certificate rules, difficulty, work, subsidy | [Blocks, certificates and consensus data](../guides/blocks-and-consensus.md) |
| `mining`, `gateway` | Block templates into blocks, work commitments, jackpot checks, pool statistics; pearl-gateway's miner protocol | [Mining and pools](../guides/mining.md) |
| `verify-proof` | A certificate's ZK proof and a miner's plain proof checked by Pearl's verifier in WebAssembly | [Verifying proofs](../guides/verify-proof.md) |
| `testing` | `SimulatedChain`, the faucet and the test keys | [Testing your application](../guides/testing.md) |
| `testing-regtest` | `startRegtest`, Node only | [Testing your application](../guides/testing-regtest.md) |
| `tls-fetch` | `pearldFetch`, a fetch that trusts a server's rpc.cert and keeps connections open, Node only | [Node and wallet RPC](../guides/rpc.md#trust-the-nodes-certificate) |
| `errors` | `PearlError`, its subclasses and the error codes | [Errors](errors.md) |

`Transaction` and `Psbt` are classes re-exported from the transaction library pearljs builds on, and the reference lists their own methods without descriptions. Prefer the pearljs functions that take them, such as `parseTransaction`, `addInputByTxid`, `addPearlOutput`, `parsePsbt`, `finalizePsbt` and `psbtOutputs`. The classes' own parsing, output and finalizing methods know nothing of Pearl's amounts, addresses or witness layouts.

## Build the reference

The pages are not checked in. Build them from a checkout:

```sh
npm ci
npm run docs
open docs/api/index.html
```

`npm run docs` fails on any warning, such as a doc comment that links to something that is not exported. It needs no git remote, since the pages carry no links to source files. The output directory, `docs/api/`, is ignored by git.

A test (`test/docs-api.test.ts`) fails when a subpath export has no entry point in typedoc.json or no row in the module table.
