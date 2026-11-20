# Pearl's RPC differences

pearld and Oyster descend from btcd and btcwallet. Below are the places where they differ from those two, and from Bitcoin Core, as the pearljs clients show it.

## Sending and fees

- Oyster's `sendtoaddress` and `sendmany` require a fee rate; `sendToAddress` and `sendMany` take it in grain/kvB.
- Oyster builds version 1 transactions and prices them on its own size estimate, a grain or two over the rate asked for.
- pearld has `estimatefee` but no `estimatesmartfee`. `estimatefee` answers 0 until pearld has seen transactions confirm, and with an error on a node that has connected fewer than three blocks. Floor the estimate at the relay fee; a wallet backend's `estimateFeeRate` does.
- `sendrawtransaction` ignores its fee limit, so `sendRawTransaction` sends none.
- `testmempoolaccept` refuses to run without a maximum fee rate, so the client sends 0, which pearld reads as its default of 0.1 PRL/kvB. It leaves `allowed` out when it is false; the client fills it in.
- `getmempoolinfo` has no fee fields and adds `cap`.
- Oyster's `settxfee` and `keypoolrefill` accept their arguments and change nothing.
- Oyster's `getinfo` writes `paytxfee` as a bare count of grain, the one amount it does not write in PRL.

## Blocks and mining

- `getblock` at verbosity 2 puts its transactions under `rawtx`, not `tx`.
- `submitblock` answers a block it refuses with the string `rejected: ...` as a successful result; `submitBlock` throws it as a `PearlRpcError` with code -25.
- `getblocktemplate` adds `requiredcertversion`, the certificate version the next block must carry. On a pearld with the FP8 fork it adds `ancestorheaders`, the full headers of up to four most recent blocks, parent first, that a V4 proof may be keyed by.
- `generate` works on regtest and simnet only, and proves every block, which takes seconds each.
- `invalidateblock` and `reconsiderblock` answer a hash pearld does not know with code -32600, "Invalid request: malformed", the code pearld gives any failure that is not an RPC error.
- pearld drops `gethashespersec`.

## Transactions and outputs

- `gettxspendingprevout` looks in the mempool only.
- `gettxout` keeps reporting a confirmed output that a mempool transaction spends.
- `searchrawtransactions` lists confirmed transactions in block order, then the mempool's in an order that changes from call to call, without block fields. It needs `--addrindex`.
- `getrawtransaction` finds confirmed transactions only with `--txindex`.
- pearld writes output values as exact decimals.

## The wallet

- Oyster's `listunspent` leaves out immature coinbase outputs and locked ones, and takes no address filter.
- Oyster's lists show nothing for change the wallet pays itself.
- Oyster's `getinfo`, `listsinceblock` and `signrawtransaction` need its RPC connection to a pearld, and so does everything it passes through.
- pearld drops `verifymessage`; Oyster still verifies messages.
- Neither server has PSBT or descriptor methods.
- `signmessagewithprivkey` makes a legacy ECDSA compact signature with pearld's message header, not the BIP-322-style signature Oyster's `signmessage` makes.

## Peers

- `getpeerinfo` reports ping times in microseconds.
