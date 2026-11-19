# Transaction helpers reference

## Helpers

These functions sit beside the `Transaction` and `Psbt` classes and cover the places where the classes' own methods are easy to get wrong:

| Function | Does |
| --- | --- |
| `addInputByTxid` | Adds an input to a `Transaction` or a `Psbt` by the txid as explorers and RPC show it. The classes' own `addInput` takes the txid bytes reversed, which is the usual way to spend the wrong output |
| `addPearlOutput` | Adds an output by address and checks the amount, which the classes' `addOutput` does not |
| `parseTransaction`, `serializeTransaction` | Read and write a transaction as hex |
| `transactionId`, `witnessTransactionId` | Return the txid and the wtxid |
| `serializeWitness` | Writes a witness stack in its serialized form |

## Sweeping

`sweepWif` and `sweepKey` spend every output of a key's key-path address into one output:

```ts run
import { encodeWif, formatPearl, keyPathAddress, networks, parsePearl, sweepWif, toOutputScript, type Utxo } from 'pearljs';

const network = networks.regtest;
const privateKey = new Uint8Array(32).fill(7);
const wif = encodeWif(privateKey, network); // in practice, from dumpprivkey or a paper backup
const script = toOutputScript(keyPathAddress(privateKey, network), network);

const utxos: Utxo[] = [
  { txid: 'aa'.repeat(32), vout: 0, value: parsePearl('0.3'), script, confirmations: 10 },
  { txid: 'bb'.repeat(32), vout: 2, value: parsePearl('0.2'), script, confirmations: 4 },
];
const destination = 'rprl1p8dhv8twyj9ezfvk62vvsfgw39s4dgl9t42y0549dc4d2947jj4cs30wfpz';

const swept = sweepWif(wif, { network, utxos, destination, feeRate: 1000n });
console.log(swept.txid, formatPearl(swept.transaction.outs[0]!.value), 'PRL swept, fee', swept.fee, 'grain');
```

This does what Oyster's `sweepaccount` tool does for its imported account, except for the fee. `sweepaccount` charges for 9 vbytes more than its transaction has, because it passes the size of a whole output where a script size is expected, while pearljs charges for the real size.

## Reading transactions

`inspectTransaction` reads a transaction against the outputs it spends, given in input order. For the transaction as a whole it reports:

- the fee, and the fee rate in grain/kvB, rounded down;
- the size, weight and vsize;
- whether any input signals replace-by-fee;
- the address of each output on the network.

For each input it says whether the witness is a key-path signature or a script path. For a script path it gives the kind, P2TR or P2MR, along with the leaf script, its hash and its control block, and says whether that control block opens the spent output. It also names the leaf as `<key> OP_CHECKSIG`, a multi_a leaf with its keys and threshold, an XMSS leaf, or something else.

```ts run
import {
  deriveSigningAccountFromSeed,
  inspectTransaction,
  mnemonicToSeed,
  networks,
  parsePearl,
  parseTransaction,
  payFromAccount,
  toOutputScript,
} from 'pearljs';

const network = networks.regtest;
const phrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const account = deriveSigningAccountFromSeed(mnemonicToSeed(phrase), network);
const payment = payFromAccount(account, {
  network,
  utxos: [
    { txid: '11'.repeat(32), vout: 0, value: parsePearl('1'), script: toOutputScript(account.deriveAddress(0), network), confirmations: 6, index: 0 },
  ],
  recipients: [{ address: account.deriveAddress(1), amount: parsePearl('0.25') }],
  feeRate: 1500n, // grain/kvB
  changeAddress: account.deriveAddress(0, true),
  rbf: true,
});

// A transaction from anywhere, as hex, and the outputs it spends in input order.
const info = inspectTransaction(parseTransaction(payment.hex), payment.prevouts, network);
console.log(info.txid, info.fee, info.feeRate, info.vsize, info.rbf);
for (const input of info.inputs) {
  const { spend } = input;
  console.log(input.address, spend.type === 'scriptPath' ? `${spend.p2mr ? 'P2MR' : 'P2TR'} ${spend.leaf} leaf` : spend.type);
}
for (const output of info.outputs) console.log(output.address ?? output.type, output.value);
```

`inspectTransaction` describes the witness without verifying signatures. An input with no witness is reported as `unsigned`, and one whose spent output is not P2TR or P2MR, or whose witness cannot spend it, is reported as `unknown`.

## Reading a coinbase

A coinbase, the transaction that pays a block's reward, spends nothing, so pass it an empty list of spent outputs. Its one input is reported as `coinbase` and its fee as 0n. The result's `coinbase` field holds the BIP 34 height from its script, the reward its outputs pay and the witness commitment. If you also pass the block's other fees as `blockFees`, it holds the subsidy and whatever the miner left unclaimed. The txid and wtxid are the coinbase's own, as pearld shows them.

```ts run
import { inspectTransaction } from 'pearljs';
import { SimulatedChain } from 'pearljs/testing';

const chain = new SimulatedChain({ premine: 3 });
const [coinbase] = chain.tip.txs;
const info = inspectTransaction(coinbase!, [], chain.network, { blockFees: chain.tip.fees });
console.log(info.coinbase!.height, info.coinbase!.reward, info.coinbase!.unclaimed); // 3, the subsidy, 0n
```
