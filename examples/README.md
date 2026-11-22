# Examples

Each file is one program that imports `pearljs` the way an application does. The first group needs no node, because those programs either describe their coins by hand or run against the simulated chain in `pearljs/testing`.

In a checkout, `npm run build` followed by `npm run examples` compiles all of them and runs the first group.

## Without a node

| Program                                          | What it shows                                                                    |
| ------------------------------------------------ | -------------------------------------------------------------------------------- |
| [derive-addresses.ts](derive-addresses.ts)       | Receive and change addresses from a mnemonic, and a watch-only account           |
| [build-payment.ts](build-payment.ts)             | A signed payment with change, then a send of everything that is left             |
| [inspect-transaction.ts](inspect-transaction.ts) | The fee, sizes, addresses and spend type of each input of a signed transaction   |
| [sign-message.ts](sign-message.ts)               | Message signatures that Oyster's `verifymessage` accepts                         |
| [wallet-lifecycle.ts](wallet-lifecycle.ts)       | An encrypted wallet that receives, sends, restarts and is restored from backups  |
| [recover-seed.ts](recover-seed.ts)               | Finding the coins of a phrase whose restored wallet shows zero                   |
| [invoice-demo.ts](invoice-demo.ts)               | Invoices through underpayment, a reorganization, expiry and a double spend       |
| [p2mr-spend.ts](p2mr-spend.ts)                   | A P2MR script tree, its address and a spend through one leaf                     |
| [multisig-leaf.ts](multisig-leaf.ts)             | A 2-of-3 multisig with a timelocked recovery leaf, signed by passing a PSBT      |
| [xmss-spend.ts](xmss-spend.ts)                   | An XMSS key, an output locked to it in a P2MR leaf, and the spend                |
| [debug-leaf.ts](debug-leaf.ts)                   | A tapscript leaf run one opcode at a time                                        |
| [parse-block.ts](parse-block.ts)                 | A parsed block, the checks that need no proof, and its consensus numbers         |
| [follow-chain.ts](follow-chain.ts)               | A small indexer that follows blocks and undoes the ones a reorganization removes |
| [pool-luck.ts](pool-luck.ts)                     | A mining pool's effort per round and its luck over a window of blocks            |

## With a pearld node

These four are compiled by `npm run examples` and run by hand. `send-payment.ts` sends a real transaction on the network it is pointed at, and `wallet-node.ts` does when `PAY_TO` is set, so start with regtest, which is the default.

| Program                                  | What it shows                                                  |
| ---------------------------------------- | -------------------------------------------------------------- |
| [send-payment.ts](send-payment.ts)       | Finding an account's coins, paying an address and broadcasting |
| [wallet-node.ts](wallet-node.ts)         | A wallet kept in a directory on disk and synced on every run   |
| [monitor-invoice.ts](monitor-invoice.ts) | An invoice followed until it is paid, expires or conflicts     |
| [watch-blocks.ts](watch-blocks.ts)       | Blocks printed as pearld connects and disconnects them         |

The connection settings come from the environment, so that no credential is written into a file:

| Variable          | Value                                                                 |
| ----------------- | --------------------------------------------------------------------- |
| `PEARL_NETWORK`   | `mainnet`, `testnet`, `testnet2`, `regtest` (the default) or `simnet` |
| `PEARLD_RPC_URL`  | Defaults to `https://127.0.0.1:` and the network's RPC port           |
| `PEARLD_RPC_USER` | pearld's `--rpcuser`                                                  |
| `PEARLD_RPC_PASS` | pearld's `--rpcpass`                                                  |
| `PEARLD_RPC_CERT` | Path to pearld's `rpc.cert`, to trust its self-signed certificate     |

The comment at the top of each program lists the other variables it reads. To run one:

```sh
npm run build && npx tsc -p tsconfig.examples.json
node dist-examples/examples/watch-blocks.js
```
