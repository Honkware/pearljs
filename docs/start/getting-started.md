# Getting started

This page installs pearljs and takes it as far as a first payment. It shows the units amounts are written in, signs a payment without a node, and then sends a payment through a pearld node.

## Install

```sh
npm install pearljs
```

pearljs runs on Node.js 20.19 or newer, or 22.12 or newer. It is an ES module package, so load it with `import`, or with `require()` on those Node versions, which load ES modules without a flag. TypeScript finds its types when `moduleResolution` is `node16`, `nodenext` or `bundler`, and the legacy `node10` setting doesn't see them. To use it in a browser, see [Browsers and bundlers](../guides/browsers-and-bundlers.md).

Everything is exported from `pearljs`. Each module is also available as its own subpath, such as `pearljs/amount` or `pearljs/rpc`, which is mostly useful when bundling for a browser.

## Amounts and fee rates

Amounts are `bigint` values in grain, the smallest unit, and one PRL is 100,000,000 grain (`GRAIN_PER_PEARL`). `parsePearl` turns decimal PRL text into grain and `formatPearl` turns grain back into text:

```ts run
import { feeRateFromGrainPerVbyte, formatPearl, parsePearl } from 'pearljs';

console.log(parsePearl('1.5')); // 150000000n
console.log(formatPearl(150000000n)); // "1.5"
console.log(feeRateFromGrainPerVbyte('2')); // 2000n grain/kvB
```

Exchanges list the coin as PEARL, while Pearl's own node and wallet call the unit PRL, as these guides do. `parsePearl` accepts either name after the number (`"1.5 PRL"`, `"1.5 PEARL"`), and `formatPearl(grain, 'PEARL')` writes the name after the number.

Fee rates are `bigint` values too, counted in grain per 1000 vbytes and written grain/kvB in these guides. A rate of 1000 grain/kvB is one grain per vbyte, which is also the lowest rate pearld relays by default. `feeRateFromGrainPerVbyte`, in the last line above, converts from the per-vbyte figure that wallet interfaces usually show.

## Sign a payment

This program derives an account from a recovery phrase and signs a payment from it. It runs without a node because it describes the one coin it spends by hand:

```ts run
import {
  deriveSigningAccountFromSeed,
  formatPearl,
  mnemonicToSeed,
  networks,
  parsePearl,
  payFromAccount,
  toOutputScript,
  type AccountUtxo,
} from 'pearljs';

const network = networks.testnet2;
const phrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const account = deriveSigningAccountFromSeed(mnemonicToSeed(phrase), network);

const receive = account.deriveAddress(0); // m/86'/1'/0'/0/0
console.log('receive at', receive);

// One unspent output paying that address: 2 PRL, 12 confirmations.
const utxos: AccountUtxo[] = [
  {
    txid: '6f1e3c0b5d1a4c0e9b7a2d4f8c6e0a1b3d5f7092a4c6e8f0b1d3f507192b4d6f',
    vout: 1,
    value: parsePearl('2'),
    script: toOutputScript(receive, network),
    confirmations: 12,
    index: 0,
  },
];

const payment = payFromAccount(account, {
  network,
  utxos,
  recipients: [{ address: account.deriveAddress(1), amount: parsePearl('0.5') }],
  feeRate: 2000n, // grain/kvB
  changeAddress: account.deriveAddress(0, true),
});

console.log('txid', payment.txid);
console.log('fee', formatPearl(payment.fee), 'PRL for', payment.vsize, 'vbytes');
console.log('change', formatPearl(payment.change), 'PRL');
console.log('hex', payment.hex); // what sendrawtransaction takes
account.destroy();
```

The phrase is the public BIP39 test phrase, and the coin in `utxos` exists on no chain, so this transaction is only for looking at. Each `AccountUtxo` says where the coin is (`txid` and `vout`), its value and script, how many confirmations it has, and `index`, the child key whose address holds it.

`payFromAccount` chooses which coins to spend, adds a change output at `changeAddress`, and signs each input with the child key named by its `index`. It then checks the transaction against pearld's relay rules, so a payment that breaks one fails here instead of at the node. The result carries the signed transaction as `hex`, which is what pearld's `sendrawtransaction` takes, together with its `txid`, `fee`, `vsize` and `change`. `account.destroy()` wipes the keys from memory once signing is done.

## Send it through a node

With a pearld node, the coins come from the chain instead of a list written by hand. Start pearld with `--addrindex` so it can look up coins by address. It serves RPC over TLS with a self-signed certificate, `rpc.cert` in its data directory, and `pearldFetch` from `pearljs/tls-fetch` is a Node fetch that trusts that certificate and keeps its connections open:

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
  batch: true,
});
const backend = pearldBackend(node, { network });
const account = deriveSigningAccountFromSeed(mnemonicToSeed(process.env.PEARL_MNEMONIC ?? ''), network);

const wallet = await discoverAccount(account, backend);
console.log('spendable', formatPearl(wallet.balance.confirmed), 'PRL');
console.log('next receive address', account.deriveAddress(wallet.receive.nextIndex));

const payment = payFromAccount(account, {
  network,
  utxos: wallet.utxos,
  recipients: [{ address: process.env.PAY_TO ?? '', amount: parsePearl('1.5') }],
  feeRate: await backend.estimateFeeRate(),
  changeAddress: account.deriveAddress(wallet.change.nextIndex, true),
});
console.log('sent', await backend.broadcast(payment.hex));
account.destroy();
```

`pearldBackend` reads the chain through the node, and `batch: true` lets the client send the calls made together as one request. `discoverAccount` scans the account's addresses the way Pearl's own wallet does when it restores, and returns the coins it finds along with the next unused receive and change positions. `broadcast` sends the signed transaction and returns its txid.

The recovery phrase and the RPC password come from environment variables so that they stay out of the source. Keep real recovery phrases out of source files, URLs, logs and browser storage as well.

## Next steps

The [examples](../../examples) directory has a runnable program for each of these steps, and `npm run examples` in a checkout runs the ones that need no node.

| To do this | Read |
| --- | --- |
| Send a payment step by step | [Send a payment](../guides/send-a-payment.md) |
| Keep coins, addresses and keys in an encrypted wallet | [Create a wallet and receive](../guides/wallet-create.md) |
| Pick a network, check and decode addresses | [Networks and addresses](../guides/networks-and-addresses.md) |
| Handle mnemonics, accounts and single keys | [Keys, mnemonics and accounts](../guides/keys-and-accounts.md) |
| Control coin selection, change and fees | [Fees and coin selection](../reference/payments-fees-and-coins.md) |
| Raise the fee of a payment that is slow to confirm | [Relay policy and fee bumping](../guides/relay-policy-and-fee-bumping.md) |
| Build a payment for a device or another machine to sign | [Build a payment for another signer](../guides/payments.md) |
| Use script trees and P2MR outputs | [P2MR](../guides/p2mr.md) |
| Use post-quantum XMSS keys | [XMSS](../concepts/xmss.md) |
| Talk to pearld or Oyster | [Node and wallet RPC](../guides/rpc.md) |
| Know what pearljs does and does not protect | [Security model](../concepts/security.md) |
| Look up an error | [Troubleshooting](../reference/troubleshooting.md) |
