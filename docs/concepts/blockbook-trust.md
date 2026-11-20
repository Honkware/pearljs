# Blockbook trust

A Blockbook is an indexer that answers questions about the chain, such as which transactions touched an address, from its own database. A wallet built with `blockbookBackend` reads the chain through such a server ([Run a wallet over a Blockbook](../guides/blockbook.md)), and when someone else runs the server, its operator decides what the answers say. pearljs treats each answer as a claim and checks what it can against the transactions and blocks themselves.

## Summary

A server can't change what a transaction says. The wallet reads every amount, address and input from the transaction's own bytes, so a server can't inflate a payment, redirect it to another address, or list a transaction under your address when the transaction doesn't touch it. With block checks on, which is the default, a server also can't claim that a real block holds a transaction that isn't in it, and it can't mark one of your coins as spent without producing the transaction that spends it.

What a server can do is leave things out. By hiding a payment you received or the spend of one of your coins, it makes the wallet show less than it holds or count a spent coin as unspent. Because the backend doesn't verify block proofs, a server can also make up a whole block holding a payment that never confirmed. The mempool, the fee estimate and the broadcast of your own transactions are the server's word as well.

Cross-checking against other Blockbooks, ideally run by other people, closes the gaps about confirmed transactions. With `crossCheck` and at least one honest server among them, a confirmed payment or spend can be neither hidden nor made up. The table shows which claims a dishonest server can still get past the wallet in each setup:

| A dishonest server can | Without `crossCheck` | With `crossCheck` |
| --- | --- | --- |
| Hide a confirmed payment or spend | yes | no |
| Show a confirmed payment in a block it made up | yes | no |
| Show a mempool transaction as confirmed, with `verifyBlocks: false` | yes | no |
| Hide or invent mempool transactions | yes | yes |
| Give a wrong fee estimate | yes | yes |
| Drop a broadcast it reports as sent, or relay one it reports as refused | yes | yes |

For anything that decides whether you were paid, run a pearld of your own ([Choosing a backend](../start/choosing-a-backend.md)).

## Checks

The backend makes the following checks of every server, with or without cross-checking.

Every transaction is read from its serialization, the raw bytes, and those bytes must hash to the txid that was asked for, or the query fails with `BACKEND_RESPONSE`. Blockbook also sends its own decoding of each transaction, with amounts, scripts, addresses and inputs, and the backend uses none of it. Since the txid is the hash of those bytes, a server can't alter what a transaction pays or spends without the hash failing to match.

When the server lists a transaction for an address, the backend confirms from the transactions themselves that it pays that address's script or spends an output that does. A listed transaction that does neither fails the query.

With `verifyBlocks`, which is on by default, the backend downloads each block that a transaction is placed in, once per block. The block must hash to the hash the server gave and hold the transaction under its merkle root, the hash in the block header that commits to every transaction in the block. It must also pass the witness commitment, certificate binding and bits checks that pearld makes before it verifies a proof. The time a wallet or an invoice sees for the block is then the one in its header, not the time the server reports.

An output counts as spent only when the backend has the spending transaction in hand. The server names the spender, the backend fetches it, checks that it hashes to its txid and that it spends the output, and places it in its block like any other transaction when it is in one. When the server marks an output spent without naming the spender, the answer is `unknown`, never spent.

Heights come from the server's tip, the latest block it reports, and never from the confirmation counts it puts in its replies.

## Limits of the checks

No check on a single server's replies can catch the four kinds of claim below.

The first is omission. A server can leave out a transaction, a spend or a whole address's history, and say that an address is unused. The wallet then shows less than it holds, or counts as unspent a coin that has been spent.

The second is made-up blocks. The backend checks every block it downloads except the block's proof, so a server can invent a block holding a transaction that never confirmed, or keep showing a block that a reorganization took away. A client that verifies each block's proof as it fetches it closes this gap ([Verify a block's proof](../guides/verify-proof.md)).

The third is the mempool, fees and broadcast. Mempool transactions are whatever the server says they are, and a fee estimate is the server's own. The server can drop a broadcast it reports as sent, or relay one it reports as refused.

The last applies only with `verifyBlocks: false`. Nothing local then checks that a block holds a transaction placed in it, and a block's time is the server's. Without `crossCheck`, the server can show a mempool transaction as confirmed in any real block, or make a coinbase look mature by placing it in an older block. With `crossCheck`, each placement is held to the cross-check servers instead: each one is asked where it places the transaction. That costs one request per server for each transaction placed, in place of one block download for each block.

Because a server can lose or misreport a broadcast, `PearlWallet` never frees the coins of a send on the server's word. A refusal becomes `WALLET_BROADCAST_UNCERTAIN` and the send stays recorded. A send that the server loses stays pending, with its coins taken, until a transaction in a block is shown to spend one of its inputs or the application abandons it ([Send from a wallet](../guides/wallet-send.md)).

## Cross-checking

Cross-checking gives the backend other Blockbook servers to compare against the first one. With `crossCheck`, the backend reads the chain only up to the lowest of the servers' tips, and the tips must be within `crossCheckLag` blocks of each other (6 by default). Every server must then agree with the others on three things:

| Compared | Where |
| --- | --- |
| The block hash | At the height the backend reads up to |
| The block hash, and without `verifyBlocks` the placement of the transaction itself | At every height a transaction is placed at |
| The confirmed transactions of the address | For every address the backend reads, up to that height |

Agreement also works in the other direction, for things the first server might hide. Before the backend calls a transaction unknown or an output unspent, it asks every cross-check server, and it takes a transaction that any of them has, or a spend that any of them names and the backend can check.

This is enough because a block hash commits to every block before it. When at least one of the servers is honest, the agreed block at the agreed height is on that server's chain, and the backend reads that chain, so a confirmed payment or spend can be neither hidden nor made up. A transaction in a block above the height read to counts as unconfirmed until every server has it.

A server that can't be asked, or that disagrees, fails the query with `CROSS_CHECK_FAILED`, and the wallet keeps what its last sync gave it.

Cross-checking covers confirmed transactions only. The mempool and fee estimates still come from the first server, and broadcasts go to it alone. `findUsed` takes any server's word that an address was used, including an account-key hint's, because a wrong yes only widens a scan.

## Queries

The wallet asks a backend the same questions whichever backend it uses, and `blockbookBackend(client, options)` answers them from address histories. The checks are applied as each answer is put together.

An address's history takes two queries. The first reads the address's confirmed transactions up to the tip, 1000 to a page, with `details=txslight`, and the second reads its transactions after the tip, which are the mempool's. The two are kept apart because Blockbook puts the mempool in front of the first page and cuts that page to the page size, which drops confirmed transactions off it. The backend then fetches each transaction once with `getTransaction` and keeps it by txid.

From those transactions the backend works out coins, balances and history in the same way that `pearldBackend` works them out from pearld's address index. An output belongs to an address when its script is the address's script, and it is spent when a transaction in the address's history spends it, a mempool transaction included.

The table lists how each wallet call is answered:

| Call | Answer |
| --- | --- |
| `getUtxos`, `getBalance`, `getHistory`, `getAddressActivity` | Worked out from the address histories as described above |
| `getActivitySince(watched, after)` | Asks each address for its transactions after `after` and for the mempool's, once per sync. Answers `null` when `after` is no longer on the server's chain |
| `getSpendStatus` | Reads the output's transaction and applies the spender rule from [Checks](#checks). An output the server marks as spent without naming the spender is `unknown`. A mempool spend is looked for among the address's mempool transactions |
| `getTransaction` | Answers `null` only when no server has the transaction. With `crossCheck`, each cross-check server is asked before the first server's "not found" is accepted, because a wallet frees coins on that answer |
| `broadcast` | Checks that the txid the server reports is the transaction's own. Passes on a refusal from the server, unless a cross-check server already has the transaction, which then counts as sent |
| `estimateFeeRate` | The server's estimate, never below `minFeeRate`, and `minFeeRate` itself while pearld has no estimate |
| `findUsed` | Counts an address as used when any server counts a transaction for it |

The backend doesn't set `broadcastRefusalsFinal`, so `PearlWallet` keeps a send that the server calls refused. `minFeeRate` defaults to `DEFAULT_RELAY_FEE_RATE`, pearld's default relay fee, because Blockbook doesn't report its pearld's setting. Wallet sends still refuse an estimate above their `maxFeeRate`.

Blockbook pages through only so much of an address's history. The backend refuses an address with more confirmed transactions than Blockbook pages through, or with 1000 or more in the mempool, which is more than one page lists, and the query fails with `BACKEND_UNSUPPORTED`.

With `useXpub`, which is off by default, discovery and `getActivitySince` ask about a wallet's BIP86 accounts by their account keys instead.

## Account-key hints

An account key here is a BIP86 account's extended public key, from which a server can derive every address of the account. With `useXpub`, the backend sends that key with Blockbook's xpub query, once per account, in place of one query per address.

Discovery, the first scan of an account, asks `GET /api/v2/xpub/{xpub}?details=tokens&tokens=derived&gap={gapLimit}`. The server derives the account's addresses and lists each one with its path and confirmed transaction count. When the reply counts mempool transactions, the backend asks once more with `details=txids` to get them. A later sync asks with `details=txslight&from={height after the last sync}` for the account's transactions since then, 100 to a page, with the same tokens, and for the mempool's in the same way when there are any.

The backend uses the reply only as a hint about which indices are used, and holds it to the following rules.

An index counts only when the address the server gives at its path is the one the account derives there. The backend derives each address itself, so a server that gives any other address, or the same path twice, fails the query with `BACKEND_RESPONSE`.

An address that the hint calls used still has its history read address by address, as it would without the hint. A wrong "used" therefore costs a few queries and changes nothing. A transaction in the account's history is read from its serialization, must pay or spend from a watched address of the account, and is placed in its block with every block check, as for an address's history. One that touches only addresses the wallet doesn't watch yet is left out, just as the per-address queries leave it out.

The hint vouches only for the indices the server derived without a gap in them. The server chooses its own gap, at most 10,000 on Pearl's fork, counted from the last confirmed use. Where it stops short of the wallet's `gapLimit` past the last used address, the backend asks about the rest of the chain address by address. A server that won't answer the xpub query at all, with HTTP 400 or 500, is asked address by address throughout.

The hint doesn't change what one server can hide. A server can leave a used address out of the hint, just as it can leave out an address's history.

With `crossCheck`, every server is asked the same xpub query. An index that any server's hint calls used counts as used, and an index that some server didn't derive is asked of all of them address by address. The account's confirmed transactions since the last sync must be the same on every server, or the query fails with `CROSS_CHECK_FAILED`.

[Ask by account key](../guides/blockbook.md#ask-by-account-key) covers what sending an account key to a server reveals.

## Websocket-only mode

A backend built over a `BlockbookWsClient` makes every query over the websocket. Blockbook's websocket serves no raw block, so this mode keeps the checks that need only transactions and gives up the ones that need a block.

These checks hold as in the REST mode:

- Every transaction is read from its serialization, which must hash to the txid asked for, and no amount, script or address the server decodes is used.
- A transaction listed for an address must pay its script or spend an output that does.
- An output counts as spent only with its spender in hand, fetched, hashing to its txid and spending the output.
- Heights come from the server's tip, and every `crossCheck` comparison still applies: the block at the height read to, the block at every height a transaction is placed at, each placement, and every address's confirmed transactions.

Finding the spender takes an extra step here. A server without the extended index, as Pearl's testnet server is, marks an output spent without naming the spender. The backend then looks for the spender among the confirmed transactions of the output's address, which every server must list alike under `crossCheck`. A mempool spender is looked for among the address's mempool transactions, as over REST.

The mode gives up three things. The first is block verification. No block is downloaded, so nothing local checks that a block holds a transaction placed in it, or checks its merkle root, witness commitment, certificate binding or bits, and a block's time is the server's. This is the same as the REST mode's `verifyBlocks: false`, and without `crossCheck` the server can show a mempool transaction as confirmed in any real block, or make a coinbase look mature by placing it in an older block.

The second is the initial-sync check. The websocket's `getInfo` doesn't say whether the server is still indexing, so a server part way through its first sync is read as if it were complete.

The third is the fee estimate. Pearl's servers answer the websocket's `estimateFee` with "EstimateSmartFee: not supported", so `estimateFeeRate` returns `minFeeRate`.
