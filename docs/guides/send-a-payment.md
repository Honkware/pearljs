# Send a payment

This guide sends PRL from an account to an address: find the account's coins, build and sign a transaction, and broadcast it through a pearld node.

## Prerequisites

- A pearld node you can reach, started with `--addrindex` so it can look up coins by address. [Node and wallet RPC](rpc.md) covers the connection and its TLS certificate.
- The recovery phrase of an account that holds some PRL.

## Find the account's coins

As in Bitcoin, a Pearl account has no balance stored on chain. It owns a set of unspent outputs, the coins that earlier payments left at its addresses, and a payment spends some of them.

`discoverAccount` scans the account's addresses the way Pearl's own wallet does when it restores, and returns those coins along with the next unused receive and change positions:

```ts
import { readFileSync } from 'node:fs';
import { pearldFetch } from 'pearljs/tls-fetch';
import {
  PEARLD_RPC_PORTS,
  PearldClient,
  deriveSigningAccountFromSeed,
  discoverAccount,
  formatPearl,
  mnemonicToSeed,
  networks,
  parsePearl,
  payFromAccount,
  pearldBackend,
} from 'pearljs';

const network = networks.testnet2;
const node = new PearldClient({
  url: `https://127.0.0.1:${PEARLD_RPC_PORTS.testnet2}`,
  username: process.env.PEARLD_RPC_USER ?? '',
  password: process.env.PEARLD_RPC_PASS ?? '',
  fetch: pearldFetch({ ca: readFileSync(process.env.PEARLD_RPC_CERT ?? 'rpc.cert', 'utf8') }),
});
const backend = pearldBackend(node, { network });

const account = deriveSigningAccountFromSeed(mnemonicToSeed(process.env.PEARL_MNEMONIC ?? ''), network);
const found = await discoverAccount(account, backend);
console.log('spendable', formatPearl(found.balance.confirmed), 'PRL');
```

`backend` is what reads the chain, in this case through your own node. The phrase comes from the environment so that it never sits in your source.

## Build and sign the transaction

`payFromAccount` chooses which coins to spend, adds a change output for whatever is left over, and signs each input with the key that holds it:

```ts continues
const payment = payFromAccount(account, {
  network,
  utxos: found.utxos,
  recipients: [{ address: process.env.PAY_TO ?? '', amount: parsePearl('1.5') }],
  feeRate: await backend.estimateFeeRate(),
  changeAddress: account.deriveAddress(found.change.nextIndex, true),
});
console.log('fee', formatPearl(payment.fee), 'PRL for', payment.vsize, 'vbytes');
```

`amount` is in grain, the smallest unit (one PRL is 100,000,000 grain), and `parsePearl` converts a decimal string. `feeRate` is in grain per 1000 vbytes, and `estimateFeeRate` asks the node for a rate that will relay. `changeAddress` is where the leftover goes, so use the account's next change address and the next scan finds it again.

The transaction is signed at this point but hasn't left your machine. `payment` holds it along with its `txid`, `fee` and `vsize`, so this is where to show the fee to a user before going further. If the coins don't cover the amount and the fee, `payFromAccount` throws an `InsufficientFundsError` whose `missing` field says how much is short.

## Broadcast it

Hand the signed transaction to the node:

```ts continues
const txid = await backend.broadcast(payment.hex);
console.log('sent', txid);
account.destroy();
```

The node checks the transaction once more and relays it to the network. If it refuses, `broadcast` throws with the node's reason, and [Troubleshooting](../reference/troubleshooting.md#building-payments) lists the common ones. `account.destroy()` wipes the keys from memory once you're done signing.

## Send everything

To empty the account, give one recipient `amount: 'max'`. It receives everything the fee leaves, so there is no change output and `changeAddress` isn't needed:

```ts continues
const sweep = payFromAccount(account, {
  network,
  utxos: found.utxos,
  recipients: [{ address: process.env.PAY_TO ?? '', amount: 'max' }],
  feeRate: await backend.estimateFeeRate(),
});
```

## Let the fee be raised later

Pass `rbf: true` to mark the transaction as replaceable, which lets you send it again with a higher fee if it is slow to confirm. It is off by default because Pearl's own wallet never sets it. [Relay policy and fee bumping](relay-policy-and-fee-bumping.md) shows the replacement.

## Complete example

This program runs the same steps from start to finish. It uses `SimulatedChain` from `pearljs/testing` in place of a node, so you can try it before you have one, and with a real node `chain` is the `pearldBackend` from the first step.

```ts run
import { deriveSigningAccountFromSeed, discoverAccount, formatPearl, mnemonicToSeed, parsePearl, payFromAccount } from 'pearljs';
import { SimulatedChain, testAddress } from 'pearljs/testing';

const chain = new SimulatedChain();
const phrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const account = deriveSigningAccountFromSeed(mnemonicToSeed(phrase), chain.network);

// Someone pays the account 2 PRL, and a block confirms it.
chain.pay(account.deriveAddress(0), parsePearl('2'));
chain.mine();

const found = await discoverAccount(account, chain);
const payment = payFromAccount(account, {
  network: chain.network,
  utxos: found.utxos,
  recipients: [{ address: testAddress(1), amount: parsePearl('1.5') }],
  feeRate: await chain.estimateFeeRate(),
  changeAddress: account.deriveAddress(found.change.nextIndex, true),
});
const txid = await chain.broadcast(payment.hex);
console.log('sent', txid);
console.log('fee', formatPearl(payment.fee), 'PRL, change', formatPearl(payment.change), 'PRL');
account.destroy();
```

## Next steps

- [Send from a wallet](wallet-send.md) keeps track of coins and change for you across restarts.
- [Fees and coin selection](../reference/payments-fees-and-coins.md) has the fee units, the fee ceiling and how coins are chosen.
- [PSBT workflows](psbt.md) signs the same payment on another machine or a hardware device.
