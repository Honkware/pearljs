# Restore an account and pay from it

An application that holds a recovery phrase but no `PearlWallet`, such as a script that empties an old account, can find the account's coins and pay from them in one pass. `discoverAccount` restores the account through a wallet backend, and the payment is made from the coins it finds. [Send a payment](send-a-payment.md) walks through the same payment step by step, and [Create a wallet and receive](wallet-create.md) covers a wallet that keeps its state between runs.

## Choose a backend

A wallet backend is the object that reads the chain for an account: which of its addresses have been used, what it can spend, what fee rate will relay, and how to broadcast. pearljs has three that talk to Pearl's own software:

| Backend | Server needs | Notes |
| --- | --- | --- |
| `pearldBackend` | pearld with `--addrindex` | Answers for any address at once; pearld's limited RPC user can make every read |
| `filterBackend` | pearld with its compact filter index, which is on by default | Scans blocks from a birthday and keeps what it found in a store; the limited user can make every read ([Use compact block filters](compact-filters.md)) |
| `oysterBackend` | an Oyster wallet that holds the keys | Knows only the wallet's own addresses |

`probePearld` says which of the first two a pearld can serve, and `connectPearld` picks one for you ([Connecting to a node](../reference/wallet-backends-reference.md#connecting-to-a-node)). [Choosing a backend](../start/choosing-a-backend.md) compares these with `blockbookBackend` and the test chains, and [Wallet backend reference](../reference/wallet-backends-reference.md) lists what a backend answers and how the pearld and Oyster backends behave.

## Restore and pay

`discoverAccount` scans the account's addresses and returns its coins, which `payFromAccount` then spends:

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
  payFromAccount,
  pearldBackend,
} from 'pearljs';

const network = networks.regtest;
const account = deriveSigningAccountFromSeed(mnemonicToSeed(process.env.PEARL_MNEMONIC ?? ''), network);
const node = new PearldClient({
  url: `https://127.0.0.1:${PEARLD_RPC_PORTS.regtest}`,
  username: process.env.PEARLD_RPC_USER ?? '',
  password: process.env.PEARLD_RPC_PASS ?? '',
  fetch: pearldFetch({ ca: readFileSync('/path/to/pearld/rpc.cert', 'utf8') }),
  batch: true,
});
const backend = pearldBackend(node, { network }); // pearld with --addrindex

const found = await discoverAccount(account, backend);
console.log('confirmed', formatPearl(found.balance.confirmed), 'pending', formatPearl(found.balance.unconfirmed));
console.log('receive at', account.deriveAddress(found.receive.nextIndex));

const payment = payFromAccount(account, {
  network,
  utxos: found.utxos,
  recipients: [{ address: process.env.PAY_TO ?? '', amount: 150000000n }],
  feeRate: await backend.estimateFeeRate(),
  changeAddress: account.deriveAddress(found.change.nextIndex, true),
});
console.log('sent', await backend.broadcast(payment.hex), 'fee', formatPearl(payment.fee));
account.destroy();
```

`discoverAccount` scans the account's receive and change chains. For each chain it returns the used addresses and the next unused index, and for the account as a whole it returns the balance and the unspent outputs, with `index` and `change` filled in the way `payFromAccount` takes them. It only derives addresses, so a watch-only account works as well as a signing one.

## Discovery

A chain's scan ends after `gap` unused addresses in a row. The default is 250 (`OYSTER_RECOVERY_WINDOW`), the recovery window Oyster restores with, where BIP44 wallets use 20. A wallet that handed out 21 addresses before one of them was paid is restored in full by Oyster, and would lose that payment under a gap of 20, so pass `gap: 20` only for a wallet known never to have left such a hole.

Discovery is a snapshot of the moment it ran. To see later payments, run it again, or keep `nextIndex` and watch new addresses yourself. `nextIndex` only moves when an address is paid, so persist the last index handed out to avoid giving the same address to two payers.

[Discovery](../reference/wallet-backends-reference.md#discovery) has an example of the two gaps and what a scan costs.

## Pay with no backend

`payFromAccount` ([Send a payment](send-a-payment.md)) needs no backend, because it takes a plain list of outputs, and `PearldClient.sendRawTransaction` broadcasts the result, so a service that already tracks its own deposits can build the list from its database and skip discovery.
