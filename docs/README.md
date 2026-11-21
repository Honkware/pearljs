# pearljs documentation

New to pearljs? Begin with the first page under Start.

Each guide begins from a task, and its examples run as written. `npm run check:docs` executes the ones that need no node. Runnable programs are in [examples](https://github.com/Honkware/pearljs/tree/main/examples).

## Start

- [Getting started](start/getting-started.md)
- [Scope](start/scope.md): what pearljs covers and what it leaves to a node or the application
- [Choosing a backend](start/choosing-a-backend.md)
- [Frequently asked questions](start/faq.md): the errors and mix-ups that came up in testing

## Guides

### Wallets

- [Create a wallet and receive](guides/wallet-create.md)
- [Keep a wallet in sync](guides/wallet-sync.md)
- [Send from a wallet](guides/wallet-send.md)
- [Sign a wallet send elsewhere](guides/wallet-sign-elsewhere.md)
- [Restart, back up and restore a wallet](guides/wallet-restart-and-backup.md)
- [Hold XMSS keys in a wallet](guides/wallet-xmss-keys.md)
- [Restore an account and pay from it](guides/wallet-backends.md), without a `PearlWallet`
- [Keys, mnemonics and accounts](guides/keys-and-accounts.md)
- [Networks and addresses](guides/networks-and-addresses.md)
- [Recover a seed that shows zero](guides/recovery.md)
- [Sign and verify messages](guides/messages.md)

### Payments

- [Send a payment](guides/send-a-payment.md)
- [Build a payment for another signer](guides/payments.md)
- [Build a transaction by hand](guides/payments-by-hand.md)
- [Relay policy and fee bumping](guides/relay-policy-and-fee-bumping.md)
- [Accept payment with an invoice](guides/invoices.md)
- [Persist and watch many invoices](guides/invoices-many.md)

### Scripts and signing

- [Build and spend a P2MR output](guides/p2mr.md)
- [Sign a P2MR spend](guides/p2mr-sign.md)
- [Spend any other P2MR leaf](guides/p2mr-other-leaves.md)
- [Build a multisig vault with timelocks](guides/multisig-and-timelocks.md)
- [Build a hash timelock contract](guides/hash-timelocks.md)
- [Sign a PSBT on an offline machine](guides/psbt.md)
- [Collect signatures from co-signers](guides/psbt-co-signers.md)
- [Sign with a hardware or external signer](guides/psbt-hardware.md)
- [Spend from an XMSS key](guides/xmss-spend.md)
- [Keep XMSS index state](guides/xmss-store.md)
- [Write and read scripts](guides/scripts.md)
- [Check a spend with the script interpreter](guides/interpreter.md)

### Nodes and chain data

- [Connect to pearld and Oyster](guides/rpc.md)
- [Control timeouts, retries and batching](guides/rpc-transports.md)
- [Receive websocket notifications](guides/websocket.md)
- [Use compact block filters](guides/compact-filters.md)
- [Run a wallet over a Blockbook](guides/blockbook.md)
- [Use the Blockbook client](guides/blockbook-client.md)
- [Follow the chain](guides/explorer.md), for explorers and indexers
- [Decode transactions](guides/explorer-transactions.md)
- [Parse and check a block](guides/blocks-and-consensus.md)

### Mining and proofs

- [Build a block from a template](guides/mining.md), for pools and pearl-gateway
- [Verify a block's proof](guides/verify-proof.md)
- [Reproduce the verifier build](guides/verify-proof-build.md)

### Browsers and testing

- [Bundle pearljs for a browser](guides/browsers-and-bundlers.md)
- [Reach a node from a page](guides/browsers-and-bundlers-node-access.md)
- [Build a browser extension](guides/browsers-and-bundlers-extensions.md)
- [Test your application without a node](guides/testing.md), including code written against a node
- [Test against regtest](guides/testing-regtest.md)

## Concepts

- [Wallets](concepts/wallet.md): what a `PearlWallet` keeps, how it syncs and what its store protects
- [XMSS](concepts/xmss.md)
- [Security model](concepts/security.md)
- [Invoice states and payment rules](concepts/invoices-payment-rules.md)
- [Blockbook trust](concepts/blockbook-trust.md)
- [Filters and the filter scan](concepts/compact-filters-scan.md)
- [Keys in a page](concepts/browsers-and-bundlers-keys.md)
- [Certificates and block checks](concepts/blocks-and-consensus-certificates.md)
- [Pearl jobs and shares](concepts/mining-jobs.md)
- [Proof verification](concepts/verify-proof-checks.md)

## Reference

- [Errors](reference/errors.md)
- [Troubleshooting](reference/troubleshooting.md)
- [API reference](reference/api.md)

### Wallets, payments and scripts

- [Wallet backend reference](reference/wallet-backends-reference.md)
- [Wallet storage](reference/wallet-storage.md)
- [Prepared send reference](reference/wallet-sign-elsewhere-holds.md)
- [Network and address reference](reference/networks-and-addresses-tables.md)
- [Message signature reference](reference/messages-formats.md)
- [Fees and coin selection](reference/payments-fees-and-coins.md)
- [Transaction helpers reference](reference/payments-by-hand-helpers.md)
- [Relay policy reference](reference/relay-policy-rules.md)
- [Invoice storage and allocation reference](reference/invoices-many-options.md)
- [PSBT checks and compatibility](reference/psbt-checks.md)
- [Control blocks and script trees](reference/p2mr-control-blocks.md)
- [Timelock and multisig reference](reference/multisig-and-timelocks-locks.md)
- [Script encoding reference](reference/scripts-encoding.md)
- [Script interpreter rules](reference/interpreter-rules.md)

### Nodes, chain data and mining

- [RPC methods](reference/rpc-methods.md)
- [Pearl's RPC differences](reference/rpc-differences.md)
- [Websocket reference](reference/websocket-notifications.md)
- [Blockbook reference](reference/blockbook-api.md)
- [Filter backend reference](reference/compact-filters-calls.md)
- [Follower and inspection reference](reference/explorer-data.md)
- [Block limits and checks](reference/blocks-and-consensus-limits.md)
- [Consensus parameters](reference/blocks-and-consensus-parameters.md)
- [Mining checks](reference/mining-checks.md)
- [Proof verifier reference](reference/verify-proof-limits.md)

### Browsers and testing

- [Browser and bundler reference](reference/browsers-and-bundlers-modules.md)
- [Simulated chain reference](reference/testing-simulated-chain.md)

## Project

- [Known limits](project/limits.md)
- [Development](project/development.md): scripts, live tests, vectors and the verifier build, for contributors
- [Stability and versioning](project/stability.md)
- [Compatibility verification](project/verification.md): what each set of checks covers, and how to run it
- [Vectors](project/verification-vectors.md): comparisons with Pearl's Go and Rust code
- [Live regtest suite](project/verification-live.md)
- [Public networks](project/verification-networks.md): Pearl's Blockbook servers, testnet2 and mainnet
- [Browsers](project/verification-browsers.md): the headless browser tests
- [Recorded runs](project/verification-runs.md)
