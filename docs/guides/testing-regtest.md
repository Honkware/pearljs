# Test against regtest

The simulated chain covers most tests, but some depend on what only a real node has, such as a verified proof in every block, real fee estimates or an Oyster wallet ([Limits of the simulation](../reference/testing-simulated-chain.md#limits-of-the-simulation)). `pearljs/testing-regtest` starts a real pearld on regtest from a test, and Oyster with it when asked. It uses binaries you already have, a pearld binary for the node and an oyster binary to start Oyster.

## Start the node

`startRegtest` starts pearld on regtest in a temporary directory, with the same flags pearljs's own live tests use:

- both indexes on;
- standardness enforced as on mainnet;
- every listener on 127.0.0.1;
- RPC over TLS, with the certificate pearld generates.

Given an oyster binary, it also starts Oyster with a wallet created from a test mnemonic and connected to that pearld:

```ts
import { parsePearl, pearldBackend } from 'pearljs';
import { testAddress } from 'pearljs/testing';
import { startRegtest } from 'pearljs/testing-regtest';

const regtest = await startRegtest({ pearld: process.env.PEARLD ?? 'pearld', oyster: process.env.OYSTER });
try {
  // Blocks carry a real proof on regtest and take seconds each: 101 for the first spendable coinbase.
  await regtest.mine(101);
  const backend = pearldBackend(regtest.node, { network: regtest.network });
  console.log(await backend.getBalance([regtest.miningAddress]));
  if (regtest.oyster !== null) {
    await regtest.oyster.client.walletPassphrase(regtest.oyster.passphrase, 60);
    console.log(await regtest.oyster.client.getNewAddress());
  }
  console.log(testAddress(0), parsePearl('1'));
} finally {
  await regtest.stop(); // stops Oyster, then pearld, and removes the directory
}
```

Coinbases go to the simulated chain's faucet address unless `miningAddress` says otherwise, so `testAccount` and the faucet mnemonic can spend on both the simulated chain and regtest.

## Make more clients

`regtest.node` is a `PearldClient` that already trusts the node's certificate. To make more clients, use `regtest.endpoint`, which holds the URL, the credentials and the certificate: pass them as `new PearldClient({ ...login, fetch: trustingFetch(ca) })` with the `trustingFetch` the module exports, or to a websocket library that takes a CA. `regtest.limited` holds pearld's limited RPC user, for testing what a page or another read-only client can do.

## Save mining time

Mining is the slow part, because every regtest block carries a real proof. To avoid mining the same chain on every run, pass `dir` to keep the chain between runs, or save the blocks once with `getBlockHex` and feed them back with `submitblock`, which needs no proving.

A test written against `chain.rpc` runs against `regtest.node` with only the setup changed. That makes a good split between the two: the simulation for every case, and regtest for the cases that must hold on the real node.

[Live regtest suite](../project/verification-live.md) describes pearljs's own tests against regtest.
