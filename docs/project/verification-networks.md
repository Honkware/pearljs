# Public networks

pearljs also runs against Pearl's Blockbook servers, the testnet2 network and mainnet. The heights, timings and browser of each run are in [Recorded runs](verification-runs.md).

## Blockbook

`test/fixtures/blockbook/` holds replies recorded from Pearl's Blockbook servers on 2026-11-19: REST bodies verbatim, and websocket frames, notifications included.

| Server | Blockbook | pearld |
| --- | --- | --- |
| `https://blockbook.pearlresearch.ai` | 81f52f2 | 1.5.7 |
| `https://blockbook.testnet.pearlresearch.ai` | 6d736fc | 1.6.0-fp8-testnet1 |

`test/blockbook-fixtures.test.ts` reads them with `BlockbookClient` and `BlockbookWsClient`. It places a real coinbase in its block through `blockbookBackend` with every block check on, and holds the simulated server's fields and error texts to them. The simulated server's replies follow the response shapes of the fork's `api/types.go` and `server/ws_types.go` at commit 81f52f21.

To run the client and backend against a live server:

```sh
PEARL_BLOCKBOOK_URL=https://blockbook.pearlresearch.ai npx vitest run test/blockbook-live.test.ts
PEARL_BLOCKBOOK_URL=https://blockbook.testnet2.pearlnetwork.net PEARL_BLOCKBOOK_NETWORK=testnet2 npx vitest run test/blockbook-live.test.ts
```

`PEARL_BLOCKBOOK_ADDRESSES` adds a balance check of the addresses it lists.

### Blockbook results

- Every read method of both clients returned what its types say.
- Real mainnet blocks, and testnet2 blocks around each of its forks, FP8 included, passed the backend's block checks. Each had the certificate version its height requires, and the server's size and difficulty.
- The backend gave the server's coins, balance, history and spends for coinbase recipients, two P2MR addresses and a pool payout address's last ten blocks.
- Both servers derived 251 addresses on each chain for a gap of 250, every one the address pearljs derives at its path.
- The websocket-only backend synced a wallet to the right balance, sent, and saw the send confirm, from a page that made no REST request.

## Testnet2

`test/network/` runs pearljs against Pearl's public test network, testnet2. It goes through a pearld that syncs from the network's own peers, with blocks mined by other people.

`scripts/network/run.sh` runs it. Every suite is skipped unless `PEARL_TESTNET_RPC_URL` is set, and the run script sets it and the rest from a node folder:

```sh
# a testnet2 pearld with --txindex --addrindex --rejectnonstd, RPC on 127.0.0.1:44114,
# its rpc.cert and rpc.pass in $PEARL_TESTNET_DIR
node scripts/network/wallet.mjs create       # once; the wallet's first address is what the faucet pays
npm run build && scripts/network/run.sh      # every file; `run.sh relay` runs one
```

`scripts/network/dryrun.sh` runs the same files on a local regtest pearld that mines a block a minute.

### Unfunded files

- They compare `checkStandard` with the node's refusals in `testmempoolaccept` and `sendrawtransaction`, using a stranger's unspent output and a made-up signature.
- The refusals compared are a dust output, a SegWit v0 output, two OP_RETURN outputs, version 3, and a fee one grain under the relay floor.
- They check message signatures against pearld's `signmessagewithprivkey` and a testnet2 Oyster's `verifymessage`.
- They read the same history, coins and balance for P2TR and P2MR addresses others have used, through `pearldBackend`, `filterBackend` and `blockbookBackend` with `verifyBlocks`.

### Funded files

The funded files spend well under 1 PRL:

| Area | Checks |
| --- | --- |
| Sending | A send between two accounts, a payment at the relay floor bumped by replace-by-fee, a send-max, and a last send of everything back to the first address |
| Backends | The wallet against `searchrawtransactions` and `gettxout`, and one wallet through all three backends (Blockbook by xpub on a throwaway account) |
| Scripts | A P2MR tree's multi_a and CSV leaves, and P2TR and P2MR hash timelocks claimed and refunded |
| Keys | An XMSS key in a file index store and one in the wallet, a WIF sweep, and a PSBT signed in another process |
| Invoices | An invoice followed over the websocket, and one that expires |

### Chain checks

- `scripts/network/check-chain.mjs` follows the node with `followChain` from block 1.
- It checks every block's merkle root, witness commitment, certificate binding and `checkCertificateRules`.
- It runs `verifyBlockProof` on every 500th block and the 20 around the FP8 fork.
- It keeps following, and records any block a reorganization takes back.
- `test/network/proofs.test.ts` holds testnet2 blocks 73396, 94500 and 101914, three of the 254 blocks described under [Recorded runs](verification-runs.md#earlier-versions). `verifyBlockProof` accepts all 254, as pearld does.

## Mainnet

`scripts/mainnet/` checks pearljs against a mainnet pearld and the public Blockbook. The node is used read-only, through a limited RPC user, with at most two requests in flight across the scripts. The Blockbook gets 300 requests at most.

Each script runs with the node's password taken from `$PEARL_WORK_DIR/mainnet/secrets.env` by `scripts/mainnet/run.sh`, and writes under `$PEARL_WORK_DIR/mainnet-walk/`:

```sh
scripts/mainnet/run.sh walk.mjs              # every block from genesis, resumable
node scripts/mainnet/summary.mjs             # counts and script usage from the walk
PEARL_RPC_INFLIGHT=1 scripts/mainnet/run.sh proofs.mjs
PEARL_RPC_SLOTS=1 scripts/mainnet/run.sh backends.mjs
PEARL_RPC_SLOT_FIRST=1 scripts/mainnet/run.sh follow.mjs --minutes 130
npx vitest run --config test/mainnet-blocks/vitest.config.ts
```

The last command runs `test/mainnet-blocks/`, the mainnet cases described under [Recorded runs](verification-runs.md#earlier-versions).

### Blocks

- Every block parsed and serialized byte for byte, and hashed to the node's hash.
- Every block carried the node's merkle root, sizes, bits and difficulty.
- Every block carried its witness commitment, its certificate binding and the certificate version its height requires.
- Every header's bits equalled `nextBlockBits` of its parent, and every timestamp came at least a second after its parent's.
- `checkBlockWork` passed every block, V1 to V3.

### Transactions

- Every transaction parsed, round-tripped and hashed to the node's txid.
- Every coinbase paid exactly `blockSubsidy` plus the block's fees.
- `verifyTransaction` accepted every input of the chain, XMSS, multi_a and annexes among them.
- `checkStandard` called no mined transaction non-standard.
- `estimateVsize` gave the exact vsize of every one but the two that carry an annex, which the walk does not pass to it.

### Backends and following

- `filterBackend` over the node's compact filters gave the coins and balance the chain holds for each address checked. They include a pool payout address, coinbase recipients, P2MR addresses and small users.
- `blockbookBackend` agreed with it on coins, balance and history for most of those addresses.
- `pearldBackend`, whose P2MR lookups need only the filter index, agreed for the P2MR addresses.
- `followChain` with a `PearlWsClient` subscription announced each new block once, connected it once, and ended on the node's best chain.

### Proofs

- `verifyBlockProof` accepted the proof of every 200th block, the 50 blocks on each side of both forks and the latest 200, in one process.
- It accepted the V1 proof of every block from 1 to 71934, read from the node's block files.

### Funded run

The funded files of `test/network/` also run on mainnet, with real PRL. They need a mainnet pearld with `--txindex --addrindex --rejectnonstd` and a wallet made by `scripts/network/wallet.mjs`:

```sh
export PEARL_TESTNET_DIR=/path/to/the/node/folder PEARL_TESTNET_NETWORK=mainnet
export PEARL_TESTNET_RPC_URL=https://127.0.0.1:44117 PEARL_TESTNET_BLOCKBOOK=off
node scripts/network/wallet.mjs create       # once; fund the address it prints
scripts/network/run.sh
node scripts/network/return.mjs <address>    # sends what is left to an address of yours
```

The wallet's phrase is kept in a file beside it so the run needs nobody at the keyboard. Fund it with no more than the run needs. `scripts/mainnet/send.mjs` is a wallet for the funding payment whose passphrase is typed and never stored.

On mainnet the files did what they do on testnet2, in blocks mined by the network:

| Area | Checks |
| --- | --- |
| Policy | `checkStandard` gave the node's refusal for a dust output, a SegWit v0 output, two OP_RETURN outputs, version 3 and a fee one grain under the relay floor |
| Sending | A send between two accounts, a payment at the relay floor bumped by replace-by-fee, two send-max payments, and a last send of everything back to the first address |
| Backends | The wallet against `searchrawtransactions` and `gettxout`, and `pearldBackend` against `filterBackend` on the wallet and on addresses others have used |
| Scripts | A P2MR tree's multi_a and CSV leaves, and P2TR and P2MR hash timelocks claimed and refunded |
| Keys | An XMSS key in a file index store and one in the wallet, a WIF sweep, and a PSBT signed in another process |
| Invoices | An invoice followed over the websocket from awaiting to confirmed, and one that expires |
| Messages | A legacy signature equal to the one pearld's `signmessagewithprivkey` makes for a mainnet key |

The funded run left out the Blockbook comparisons and Oyster's `verifymessage`. The Blockbook comparison on addresses others have used ran afterwards with `PEARL_TESTNET_BLOCKBOOK` set to the mainnet server. [Recorded runs](verification-runs.md#mainnet-funded-run-2026-11-21) has the counts.
