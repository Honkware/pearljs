# Test your application without a node

Tests of a wallet flow, an invoice monitor or an indexer need a chain that does what the test says, when it says. `pearljs/testing` provides one inside the test process: a simulated Pearl chain and node, with a faucet and fixed test keys. Code written against pearljs runs on it unchanged, so a flow is tested in milliseconds without a pearld. For the tests that should see a real node, `pearljs/testing-regtest` starts a pearld on regtest ([Test against regtest](testing-regtest.md)).

> **Warning:** Import both modules from test code only. Every key in the kit is public.

## Run a wallet on the simulated chain

A `SimulatedChain` is a chain with a faucet that pays whatever address a test names. It is itself a `WalletBackend`, a `ChainClient` and a `TransactionSource`, so a `PearlWallet`, `discoverAccount` or an `InvoiceMonitor` takes it directly. This test receives a payment, sends one, and then reorganizes the incoming payment away:

```ts run
import { PearlWallet, createMemoryStore, formatPearl, parsePearl } from 'pearljs';
import { SimulatedChain, testAddress } from 'pearljs/testing';

const chain = new SimulatedChain();
const wallet = await PearlWallet.create({
  store: createMemoryStore(),
  backend: chain,
  passphrase: 'a passphrase for the test',
  kdf: { N: 2 ** 10 }, // quick, for tests only
});

// Someone pays the wallet: first seen in the mempool, then in a block.
const address = await wallet.receiveAddress();
const payment = chain.pay(address, parsePearl('12'));
await wallet.sync();
console.log(formatPearl(wallet.balance().unconfirmed)); // 12
chain.mine();
await wallet.sync();
console.log(formatPearl(wallet.balance().confirmed)); // 12

// The wallet pays out. The chain checks the transaction as pearld would before taking it.
const sent = await wallet.send({ recipients: [{ address: testAddress(1), amount: parsePearl('5') }] });
console.log(chain.mempool.has(sent.txid)); // true
chain.mine();

// A reorganization two blocks deep in which the incoming payment is double-spent.
chain.reorg(2, { replace: [payment.getId()] });
await wallet.sync();
console.log(wallet.history().map((entry) => `${entry.direction} ${entry.status}`));
console.log(formatPearl(wallet.balance().total)); // 0: the payment is gone, and the send that spent it with it
```

`pay`, `mine` and `reorg` are synchronous and take effect at once, so the test never waits. A reorganization replaces the last blocks of the chain with a longer branch, and `replace` makes the faucet double-spend the listed payment on that branch. [Simulated chain reference](../reference/testing-simulated-chain.md#steps) lists every step a test can take.

The chain's mempool runs a transaction through pearld's checks in pearld's order, and a refusal is the same `PearlRpcError` a client of pearld gets ([Refusals](../reference/testing-simulated-chain.md#refusals)). A chain takes about a tenth of a second to make, so each test can have its own ([One chain per test](../reference/testing-simulated-chain.md#one-chain-per-test)). The kit depends on no test framework and on nothing from Node, so it runs under any test runner and in browser tests as well.

## Test code written against a node

Some code talks to pearld directly: an indexer that follows the chain, a service that makes its own RPC calls, or a client that listens for websocket notifications. Such code takes an `Rpc`, and `chain.rpc` is one. It offers pearld's typed methods and answers them with the fields, codes and messages pearld gives, so `pearldBackend`, `pearldTransactionSource`, `pearldChainClient`, `followChain` and your own calls run over it unchanged. This example reads a balance through a backend and then follows the chain while a reorganization arrives:

```ts run
import { followChain, parsePearl, pearldBackend } from 'pearljs';
import { SimulatedChain, testAddress } from 'pearljs/testing';

const chain = new SimulatedChain();
chain.fund(testAddress(0), parsePearl('2'));

const backend = pearldBackend(chain.rpc, { network: chain.network });
console.log((await backend.getBalance([testAddress(0)])).confirmed); // 200000000n
console.log(await chain.rpc.getBlockCount(), (await chain.rpc.getChainTips()).length); // 126 1

// An indexer under test: follow to the tip, then see a reorganization arrive.
const follower = followChain(chain.rpc, { from: { height: 125 }, pollInterval: 10 });
for await (const event of follower) {
  console.log(event.type, event.height);
  if (event.type === 'synced' && event.height === 126) chain.reorg(1);
  if (event.type === 'synced' && event.height === 127) break;
}
```

The chain can also turn off its indexes or fail calls to exercise your error paths ([Indexes and failing calls](../reference/testing-simulated-chain.md#indexes-and-failing-calls)), and `chain.WebSocket` serves a `PearlWsClient` with pearld's notifications ([Websocket notifications](../reference/testing-simulated-chain.md#websocket-notifications)).

## Look up more

[Simulated chain reference](../reference/testing-simulated-chain.md) has the mempool checks, the steps, coinbase maturity, the clock, the test keys and what the simulation leaves out.
