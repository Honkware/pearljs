# Simulated chain reference

## Mempool checks

The mempool takes a transaction through the checks of pearld's, in pearld's order:

1. `checkSanity`.
2. Known and unspent inputs.
3. Coinbase maturity.
4. `checkStandard`, with the relay fee and lock time.
5. Relative lock times.
6. The replacement rules of `checkReplacement`.
7. The package limits of `checkPackageLimits`.
8. The script interpreter, on every input.

A refusal is the `PearlRpcError` a client of pearld gets, with pearld's code in `rpcCode` and its text in the message.

## Refusals

The chain's transactions and blocks are real. This test breaks a signature and watches the chain refuse it:

```ts run
import { PearlRpcError, parsePearl, parseTransaction, payFromAccount } from 'pearljs';
import { SimulatedChain, testAccount, testAddress } from 'pearljs/testing';

const chain = new SimulatedChain();
const account = testAccount();
const coin = chain.fund(account.deriveAddress(0), parsePearl('1')); // one confirmed coin, ready to spend
const payment = payFromAccount(account, {
  network: chain.network,
  utxos: [{ ...coin, index: 0 }],
  recipients: [{ address: testAddress(1), amount: 'max' }],
  feeRate: 2000n,
});

// The same transaction with something else where its signature was.
const forged = parseTransaction(payment.hex);
forged.setWitness(0, [new Uint8Array(64).fill(1)]);
try {
  chain.accept(forged);
} catch (err) {
  if (!(err instanceof PearlRpcError)) throw err;
  console.log(err.rpcCode, err.message.slice(0, 64)); // -26 sendrawtransaction: TX rejected: failed to validate input ...
}
console.log(chain.accept(payment.transaction) === payment.txid); // true
```

To test a double spend, such as a customer's payment being double-spent, let the chain sign it: it does so itself when the coins are the faucet's. For a transaction spending your own keys' coins, sign the conflicting transaction yourself and pass it as `conflict` to `doubleSpend` or in `include` to `reorg`.

## Blocks

Blocks have real headers that chain by hash, merkle roots, witness commitments and compact filters. Each carries a certificate of the version the height requires: V4 on regtest, keyed by the parent as pearld's miner keys it. `parseBlock`, `checkMerkleRoot`, `checkWitnessCommitment`, `checkCertificateBinding` and `checkCertificateRules` therefore pass on every block. Block 0 is the network's own genesis block.

Coinbase outputs mature after the network's 100 blocks, and a new chain starts with 125 blocks mined so the faucet has coins to spend.

## Coinbase maturity

A test about maturity runs quicker on a network with a short maturity:

```ts run
import { customNetwork, networks, parsePearl } from 'pearljs';
import { SimulatedChain, testAddress } from 'pearljs/testing';

const network = customNetwork(networks.regtest, { coinbaseMaturity: 3 });
const chain = new SimulatedChain({ network });
chain.mine(1, { coinbaseTo: testAddress(0), value: parsePearl('50') });
console.log(await chain.getBalance([testAddress(0)])); // { confirmed: 0n, unconfirmed: 0n, immature: 5000000000n }
chain.mine(2);
console.log((await chain.getBalance([testAddress(0)])).confirmed); // 5000000000n
```

`customNetwork(base, changes)` returns a new frozen network and leaves the base alone, because the exported networks can't be changed.

## Steps

| Step | Effect |
| --- | --- |
| `chain.pay(address, amount, { rbf, feeRate })` | The faucet pays into the mempool. Returns the transaction |
| `chain.fund(address, amount, { confirmations })` | `pay`, then `mine`. Returns the coin as `buildPayment` and `payFromAccount` take it |
| `chain.accept(tx)` | sendrawtransaction: into the mempool, or the node's refusal |
| `chain.check(tx)` | testmempoolaccept: the fee, vsize and what it would replace, or the refusal, with nothing changed |
| `chain.submit(tx, dryRun)` | What `accept` and `check` run, for code that answers RPC itself: it throws a `SimulatedRefusal` with pearld's code in `rpcCode` instead of a `PearlRpcError` |
| `chain.mine(count, { coinbaseTo, value, include, skipMempool })` | Mines blocks. `include` puts transactions straight into the first one: they must be valid, not standard |
| `chain.reorg(depth, { mine, keepInMempool, replace, include })` | Takes `depth` blocks off and mines a longer branch. Their transactions are mined again unless `keepInMempool`; `replace` double-spends faucet payments for good |
| `chain.invalidate(hash)`, `chain.reconsider(hash)` | pearld's invalidateblock and reconsiderblock: move between branches, or leave the chain shorter |
| `chain.doubleSpend(txid, { mine, conflict })` | Replaces a mempool transaction with one spending the same coins |
| `chain.drop(txid)` | The node forgets a mempool transaction and what spends it |
| `chain.setTime(seconds)`, `chain.advanceTime(seconds)` | Moves the clock that stamps blocks |
| `chain.failNext(count, { method, error })` | The next calls fail as a dropped connection does |
| `chain.feeRate = rate` | What fee estimates answer; `null` for a node that has none yet |

## Indexes and failing calls

| Option or field | Effect |
| --- | --- |
| `addrindex: false` | `searchrawtransactions` fails as pearld does without the address index |
| `txindex: false` | `getrawtransaction` finds mempool transactions only |
| `chain.calls` | Counts every call by method name |

Both options are given when making the chain, as in `new SimulatedChain({ addrindex: false })`. To test the paths for a dropped connection, `chain.failNext(3)` fails the next three calls, and its `method` option limits that to one method. With `chain.calls` a test can also check how many calls its code made:

```ts run
import { PearlRpcError } from 'pearljs';
import { SimulatedChain } from 'pearljs/testing';

const chain = new SimulatedChain();
chain.failNext(1, { method: 'getblockcount' });
const outcome = await chain.rpc.getBlockCount().catch((err: unknown) => err);
console.log(outcome instanceof PearlRpcError && outcome.code); // RPC_NETWORK
console.log(await chain.rpc.getBlockCount(), chain.calls.get('getblockcount')); // 125 2
```

## Websocket notifications

`chain.WebSocket` is a WebSocket constructor to pass to `PearlWsClient`. The client behind it receives pearld's notifications for what the chain does:

- `blockconnected` and `blockdisconnected`;
- filtered blocks;
- `txaccepted`, and `relevanttxaccepted` for a loaded filter;
- `recvtx` and `redeemingtx`;
- the two rescans.

This example subscribes to blocks and transactions, pays, mines and reorganizes, and then simulates a node restart:

```ts run
import { PearlWsClient, parsePearl } from 'pearljs';
import type { BlockEvent } from 'pearljs';
import { SimulatedChain, testAddress } from 'pearljs/testing';

const chain = new SimulatedChain();
const ws = new PearlWsClient({ url: 'ws://simulated.invalid', WebSocket: chain.WebSocket });
const blocks: BlockEvent[] = [];
ws.watchBlocks({ onBlock: (event) => blocks.push(event) });
ws.watchTransactions({ onTransaction: (tx) => console.log('in the mempool:', tx.txid.length, tx.amount > 0n) }); // amount is every output, change included
await ws.getBlockCount(); // the subscriptions are in place once a call has been answered

chain.pay(testAddress(0), parsePearl('1'));
chain.mine();
chain.reorg(1);
await ws.getBlockCount();
console.log(blocks.map((event) => `${event.type} ${event.height}`)); // connected 126, disconnected 126, connected 126, connected 127

chain.WebSocket.dropAll(); // the node restarts: a client with reconnect on comes back and resubscribes
await ws.close();
```

- The subscriptions are in place once the client has had a call answered, which is why the example awaits `getBlockCount` before paying.
- `chain.WebSocket.dropAll()` closes every connection, as a node restart would, and a client with reconnect on comes back and subscribes again.

## Clock

- The chain has its own clock and never reads the machine's.
- Blocks are stamped one target spacing (194 seconds) apart from the genesis block's time, so a test produces the same block hashes on every run.
- Pearl's timestamp rule holds: a block's time is at least a second after its parent's.
- Time locks compare against the median of the last eleven, so six blocks must pass before a jump of the clock is felt.
- To test a time lock or an expiry, move the clock with `advanceTime`:

```ts run
import { SimulatedChain } from 'pearljs/testing';

const chain = new SimulatedChain();
const before = chain.medianTimePast();
chain.advanceTime(3600);
chain.mine(6);
console.log(chain.medianTimePast() - before >= 3600); // true
// Give the same clock to code that takes one: PearlWallet's `now`, an InvoiceMonitor's timestamps.
const now = (): number => chain.time * 1000;
console.log(new Date(now()).getUTCFullYear() >= 2026); // true
```

## One chain per test

A chain takes about a tenth of a second to make with the default 125 blocks, and less on a network with a short maturity, so each test can have its own and none depends on another's state:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PearlWallet, createMemoryStore, parsePearl } from 'pearljs';
import { SimulatedChain, testMnemonic } from 'pearljs/testing';

test('a deposit is credited after six confirmations and taken back when it is reorganized away', async () => {
  const chain = new SimulatedChain();
  const wallet = await PearlWallet.create({ store: createMemoryStore(), backend: chain, mnemonic: testMnemonic(1), passphrase: 'test', kdf: { N: 2 ** 10 } });
  const deposit = chain.pay(await wallet.receiveAddress(), parsePearl('3'));
  chain.mine(6);
  await wallet.sync();
  const [entry] = wallet.history();
  assert.equal(entry?.txid, deposit.getId());
  assert.equal(entry?.status, 'confirmed');
  assert.equal(entry?.confirmations, 6);

  chain.reorg(6, { replace: [deposit.getId()] });
  await wallet.sync();
  assert.equal(wallet.balance().total, 0n);
});
```

## Keys and the faucet

| Helper | Gives |
| --- | --- |
| `testAccount(n, network?, mnemonic?)` | BIP86 signing account `n` of `TEST_MNEMONIC`, on regtest unless told otherwise |
| `testMnemonic(n)` | A valid 12-word phrase for each `n` |
| `testKey(n)`, `testAddress(n, network?)` | A private key for each `n`, and its key-path address |
| `testXmssSeeds(n)` | The two seeds `xmssKeygen` takes |
| `chain.faucet` | The account of `FAUCET_MNEMONIC` the chain mines to: `address`, `balance()`, and `build(recipients)` for a signed transaction that is not sent yet |

All of them return the same values on every run and every machine. The faucet's coinbases are cut into four coins each, so it makes about a hundred payments between blocks before it has to spend its own unconfirmed change, and it says so when it runs dry.

## Limits of the simulation

It is a test double for the node's interface, not a node.

- The proof in each block's certificate is a placeholder that nothing verifies.
- The difficulty never moves from the network's limit.
- There are no peers: nothing propagates, arrives late or is orphaned unless a test says so.
- Fee estimates are a number you set.
- Its RPC answers the methods a wallet, a backend, a follower and an explorer call, and "Method not found" for the rest.

A test that depends on any of that belongs on regtest ([Test against regtest](../guides/testing-regtest.md)).
