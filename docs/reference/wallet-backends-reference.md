# Wallet backend reference

## Methods

| Method | Returns |
| --- | --- |
| `getUtxos(watched)` | Unspent outputs paying any of the addresses or output scripts, in the shape `buildPayment` and `payFromAccount` take, with `confirmations` and `coinbase`. Unconfirmed and immature ones are included; outputs a mempool transaction already spends are left out |
| `getBalance(watched)` | `confirmed`, `unconfirmed` and `immature` grain |
| `getHistory(watched)` | The transactions paying or spending from one address, confirmed first, with `received` and, where the backend can tell, `spent` |
| `broadcast(tx)` | Sends a signed transaction, hex or bytes, and returns its txid |
| `broadcastRefusalsFinal` | `true` when a refusal from `broadcast` proves the transaction reached no mempool. `pearldBackend` and `oysterBackend` set it; `blockbookBackend` and `filterBackend` do not, since a server that is not yours can relay a transaction and still answer that it refused it, and `PearlWallet` then keeps the send ([Handle a failed broadcast](../guides/wallet-send.md#handle-a-failed-broadcast)) |
| `estimateFeeRate(blocks?)` | A rate in grain/kvB, never under the relay fee |
| `getSpendStatus({ txid, vout })` | `unspent` with confirmations, `spent` with the spender when known, or `unknown` |
| `getTip`, `getAddressActivity`, `getTransaction` | The `ChainClient` methods, so the same object drives `InvoiceMonitor` ([Invoices](../guides/invoices.md)) |

`confirmed` counts outputs in a block, coinbase outputs once mature. `unconfirmed` counts outputs of mempool transactions, the wallet's own change included. `immature` counts coinbase outputs short of 100 confirmations. `sumBalance` computes the same split from any list of outputs.

## Optional methods

Every query is by address or script, so an indexer of your own can implement the interface.

Implement `findUsed(addresses, accounts?)` as well when your source can answer for many addresses at once. Discovery uses it and falls back to `getAddressActivity`. The second argument names the account key each address derives from, for a source that can look up a whole account, and may be ignored.

`setAddressBirths(births)` is optional too, for a source that scans blocks and can start later for some addresses ([Address births](#address-births)).

## Connecting to a node

`connectPearld` probes the node and returns the backend that suits it, `pearldBackend` when the node keeps the address index and `filterBackend` when it keeps only filters:

```ts fragment
import { PearlWallet, PearldClient, connectPearld, createMemoryStore, networks } from 'pearljs';

const node = new PearldClient({ url: 'https://127.0.0.1:44107', username: 'user', password: 'pass', batch: true });
const chain = await connectPearld(node, { network: networks.mainnet, birthday: 31200 });
console.log(chain.kind, chain.capabilities.limited);
const wallet = await PearlWallet.open({ store: createMemoryStore(), backend: chain });
```

The result says which backend it chose in `kind`, and what the probe found in `capabilities`. `birthday` is the height where `filterBackend` starts scanning, and where `pearldBackend` starts the filter scan it uses for P2MR addresses.

Three interfaces describe what reads the chain. A `ChainClient` is what the invoice monitor reads, a `WalletBackend` adds what a wallet reads and sends, and a `PearlWallet` also needs a source of full transactions. Every backend returns a `WalletChain`, a `WalletBackend` that also has `getRawTransaction`, so one object fills all three places. A wallet given it as `backend` needs no separate `transactions` option, as in the last line above.

## Discovery

```ts run
import { deriveAccountFromSeed, discoverAccount, formatPearl, mnemonicToSeed, parsePearl } from 'pearljs';
import { SimulatedChain } from 'pearljs/testing';

const chain = new SimulatedChain();
const phrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const account = deriveAccountFromSeed(mnemonicToSeed(phrase), chain.network);
chain.pay(account.deriveAddress(30), parsePearl('3')); // the 31st address handed out
chain.mine();

const oyster = await discoverAccount(account, chain);
const bip44 = await discoverAccount(account, chain, { gap: 20 });
console.log(formatPearl(oyster.balance.confirmed), formatPearl(bip44.balance.confirmed)); // 3 0
```

A used address is one that has been paid, whether or not the payment has confirmed. Over pearld, checking an address takes one `searchrawtransactions` call, so even an empty account costs at least 500 of them, 250 on each chain. A client made with `batch: true` sends them in a handful of requests, and without it discovery makes each one separately, 8 at a time. `batchSize` sets how many addresses are checked in each round (25 by default), and `signal` stops the scan between rounds. `scanLimit` caps how far one chain is scanned, 10,000 addresses unless given, and a chain whose used addresses and gap reach past it rejects with `BACKEND_RESPONSE`.

## Cross-checking

`pearldBackend` and `oysterBackend` take their server's word for what the chain holds. `filterBackend` given `crossCheck` endpoints holds its node to theirs instead: a sync fails with `CROSS_CHECK_FAILED` when the endpoints don't confirm what it would read, or when they trail the node by more than `crossCheckLag` blocks.

## pearld backend

`pearldBackend(client, { network })` works over a `PearldClient`, a `PearlWsClient` or anything else with `call`. It reads pearld's address index, so pearld must run with `--addrindex`, which turns `--txindex` on. Without them the address queries fail with a `MissingIndexError` whose `index` names the missing one.

```ts
import { MissingIndexError, type WalletBackend } from 'pearljs';

async function balanceOf(backend: WalletBackend, address: string): Promise<bigint> {
  try {
    return (await backend.getBalance([address])).confirmed;
  } catch (err) {
    if (err instanceof MissingIndexError) console.error(`restart pearld with --${err.index}`);
    throw err;
  }
}
```

The unspent outputs are worked out from `searchrawtransactions` alone. Every transaction touching an address is in its list, mempool ones included, so an output is unspent when no input in the lists refers to it. That takes out outputs the mempool has already spent, which `gettxout` would still report.

`getSpendStatus` asks `gettxspendingprevout` for a mempool spender first, then `gettxout`. For an output that is gone it uses the two indexes to tell one a block spent, and by which transaction, from one that never existed. When pearld refuses `gettxspendingprevout`, as it does to its limited user, the backend stops asking. It finds a mempool spender in the address's transactions instead, which include the mempool.

pearld's address index holds Taproot addresses only. `searchrawtransactions` takes a P2MR address and then fails with `address type is not supported by the address index`. So for a P2MR address, such as an XMSS key's, the backend matches the compact filter of every block (`getcfilter`) against the address's script. It reads the blocks that match, then looks through the mempool. It needs pearld's filter index, which is on unless pearld runs with `--nocfilters`.

The lists for several addresses are separate requests, so a block arriving in between can make them disagree until the next call.

| Option | Default | Sets |
| --- | --- | --- |
| `pageSize` | 100 | the transactions per `searchrawtransactions` request |
| `concurrency` | 8 | the addresses queried at once and the blocks of the P2MR walk fetched at once |
| `scanFrom` | 0 | where the P2MR walk starts |
| `broadcast` | none | another endpoint for `sendrawtransaction` |

The cost grows with history. An address with thousands of transactions is read in full on every call. For a busy deposit address, keep your own record of what you have seen and use the backend to catch up.

### P2MR walk

All the P2MR addresses the backend has been asked about share one walk of the chain from `scanFrom` (0 by default; pass the height the first was made at). Each block's filter is fetched once, with three requests a block (`getblockhash`, `getblockheader`, `getcfilter`), however many addresses there are. The filter is matched against every address whose scan has reached that block. A block that matches is fetched once with `getblock`. A client made with `batch: true` sends the requests of `concurrency` blocks in one round trip. `getHistory` of an address paid once on a 122-block chain takes 21.

An address asked about for the first time is walked alone from its start up to where the others stand, then with them. Later queries go on from the last block walked. They start over for each address whose last block has left the chain. The walk holds the filters of at most 1000 blocks at a time.

The scan checks that the headers it walks link into one chain. A reorganization in the middle of a scan therefore fails it with `BLOCK_HEADER_INVALID`, so two chains are never mixed. Like everything else this backend reports, the blocks and filters are the node's word. The scan lives in the backend object, so keep one backend for the life of the program.

### Address births

A backend can start later for one address than for the rest. `setAddressBirths(births)` is an optional `WalletBackend` method. It takes a map from address to an `AddressBirth`, or to `null`, which forgets a birth given earlier. An `AddressBirth` has `height`, the lowest height that can hold a payment to the address, and `parent`, the hash of the block below it.

`pearldBackend` scans such an address from the later of `scanFrom` and its birth, as long as the block `parent` names is still at `height - 1` on the best chain. When it is not, or when the chain is shorter than that, the scan starts at `scanFrom`. A branch without that block can pay the address anywhere after its fork.

A birth without `parent` is taken as given. A birth moved below where a scan began starts that scan again. An address named in `setAddressBirths`, with a birth or `null`, joins the walk at the next query for any address.

`PearlWallet` passes the births of its XMSS keys at the start of every sync ([Births](../concepts/xmss.md#births)). So a key it generated is scanned from the block after the tip it had synced to, in every new process too.

`filterBackend` and `blockbookBackend` have no such method. `filterBackend` reads each block's filter once for every watched script from its one `birthday`, and Blockbook indexes P2MR addresses itself. A backend without the method is asked about every address from the start of its scan.

### Limited user

pearld's limited RPC user (`--rpclimituser`) may call only the methods in `rpcLimited`, `node/rpcserver.go:261-301`, which pearljs exports as `PEARLD_LIMITED_METHODS`. Anything else is answered with "limited user not authorized for this method", code -32603 over HTTP (`node/rpcserver.go:4369-4373`) and -32602 on the websocket (`node/rpcwebsocket.go:1333-1339`). `isLimitedUserRefusal(err)` recognizes the answer.

| Backend call | pearld methods | Limited user |
| --- | --- | --- |
| `getTip` | `getbestblock` | yes |
| `getUtxos`, `getBalance`, `getHistory`, `getAddressActivity` | `searchrawtransactions`, `getblockheader`; for P2MR addresses `getblockhash`, `getblockheader`, `getcfilter`, `getblock`, `getrawmempool`, `getrawtransaction` | yes |
| `getTransaction` | `getrawtransaction`, `getblockheader` | yes |
| `estimateFeeRate` | `estimatefee`, `getinfo` | yes |
| `getSpendStatus` | `gettxspendingprevout`, `gettxout`, `getrawtransaction`, `searchrawtransactions` | all but `gettxspendingprevout`, which the backend then does without |
| `broadcast` | `sendrawtransaction` | no: an `UnsupportedMethodError` (`BACKEND_UNSUPPORTED`) with `method` set, unless the `broadcast` option names another endpoint |

So the limited user serves every read. A broadcast goes through an endpoint with full credentials or a proxy that forwards `sendrawtransaction`, given as `pearldBackend(rpc, { network, broadcast })`. [Browsers and bundlers](../guides/browsers-and-bundlers-node-access.md) has a worked configuration.

`probePearld(rpc)` finds out what a set of credentials allows with eight calls that change nothing, and which indexes the node keeps:

```ts fragment
import { PearldClient, probePearld } from 'pearljs';

const capabilities = await probePearld(new PearldClient({ url: 'https://127.0.0.1:44107', username: 'page', password: 'limited' }));
// { limited: true, broadcast: false, mempoolSpends: false, mempool: true,
//   addrIndex: true, txIndex: true, cfIndex: true, backend: 'pearld' }
console.log(capabilities);
```

## Oyster backend

`oysterBackend(client, { network })` answers from Oyster's own wallet. It uses `listunspent` filtered to the addresses asked for, with coinbase outputs marked from the transaction list. The immature ones, which `listunspent` holds back, are added to the balance from there.

It knows only the wallet's addresses and only what Oyster has processed, which can trail the node. Outputs locked with `lockunspent` are not listed, so they count in no balance. `spent` is never filled in.

Oyster lists no receive for change it pays itself, only the send. For such a transaction `getHistory` and `getAddressActivity` read what the address was paid from the transaction (`gettransaction`), so a wallet scanning its change addresses finds its change.

Broadcast, fee estimates and the spend status of outputs the wallet does not hold go through Oyster to its pearld. In SPV mode, as Pearl's desktop wallet runs it, there is none:

- `broadcast` fails with a message saying to send with `sendMany`;
- the fee rate is Oyster's default of 1000 grain/kvB (`OYSTER_DEFAULT_FEE_RATE`);
- such outputs are `unknown`.

Oyster watches only the addresses it has derived itself. A `PearlWallet` on the same seed that sends through this backend pays its change to the next address of the change chain, which Oyster may not have derived yet. Oyster then does not see that output, though the wallet does. Ask Oyster for the address first with `getRawChangeAddress` until it returns the one the wallet will use, and take receive addresses from `getNewAddress`.

With Oyster the wallet's keys live in Oyster, so the usual way to pay is `OysterClient.sendMany`, not `payFromAccount`. The backend is for reading what the wallet holds, and for driving an invoice monitor from a wallet without a node.
