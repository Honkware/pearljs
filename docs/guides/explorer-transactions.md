# Decode transactions

Once a program follows the chain ([Follow the chain](explorer.md)), it usually needs to know what each transaction did: who paid whom, how much, and at what fee. Some also keep chain-wide totals such as the supply.

## Decode every transaction

`inspectTransaction` decodes a transaction into its inputs, outputs, fee and fee rate. To work out the fee and where each input's coins came from, it needs the outputs that the transaction spends, its prevouts, and pearld's `getrawtransaction` doesn't return them. `resolvePrevouts(tx, rpc)` reads each parent transaction once and returns the prevouts in input order. Give it a `known` map and it looks there before asking the node, and adds whatever it fetched. Seed the map with a block's own transactions and the parents inside the block cost nothing.

A coinbase spends nothing, so it takes an empty list ([Coinbase fields](../reference/explorer-data.md#coinbase-fields)). This program decodes the block that holds a payment and prints each transaction:

```ts run
import { customNetwork, followChain, formatPearl, inspectTransaction, networks, parsePearl, payFromAccount, resolvePrevouts } from 'pearljs';
import type { InspectedTransaction, Transaction } from 'pearljs';
import { SimulatedChain, testAccount, testAddress } from 'pearljs/testing';

const network = customNetwork(networks.regtest, { coinbaseMaturity: 2 });
const chain = new SimulatedChain({ network, premine: 4 });
const account = testAccount();
const coin = chain.fund(account.deriveAddress(0), parsePearl('7'));
chain.accept(payFromAccount(account, { network, utxos: [{ ...coin, index: 0 }], recipients: [{ address: testAddress(1), amount: parsePearl('2') }], feeRate: 3000n, changeAddress: account.deriveAddress(0, true) }).transaction);
chain.mine();

const known = new Map<string, Transaction>();
for await (const event of followChain(chain.rpc, { from: { height: 5 }, stopAtTip: true })) {
  if (event.type !== 'connected') continue;
  const [coinbase, ...rest] = event.block.transactions;
  for (const tx of rest) known.set(tx.getId(), tx);
  const decoded: InspectedTransaction[] = [];
  for (const tx of rest) decoded.push(inspectTransaction(tx, await resolvePrevouts(tx, chain.rpc, { known }), network));
  const fees = decoded.reduce((sum, tx) => sum + tx.fee, 0n);
  const reward = inspectTransaction(coinbase!, [], network, { blockFees: fees }).coinbase!;

  console.log(`block ${event.height}: reward ${formatPearl(reward.reward)} PRL, fees ${fees} grain, unclaimed ${reward.unclaimed}`);
  for (const tx of decoded) {
    console.log(' ', tx.txid.slice(0, 12), `${tx.feeRate} grain/kvB`, tx.rbf ? 'replaceable' : 'final');
    for (const input of tx.inputs) console.log('    from', input.address, formatPearl(input.value), input.spend.type);
    for (const output of tx.outputs) console.log('    to  ', output.address ?? output.type, formatPearl(output.value));
  }
}
```

`input.spend.type` says how each input was spent, and [Spend types](../reference/explorer-data.md#spend-types) lists the values. For an XMSS spend, `xmssIndex` is the one-time index the signature was made with. Two spends of the same key with the same index expose the key, so an explorer that shows the index lets anyone spot a wallet that has gone wrong.

`resolvePrevouts` throws `PREVOUT_NOT_FOUND` when the node has no such parent, and a `MissingIndexError` when the parent is confirmed and pearld runs without `--txindex`.

## Look up more

[Follower and inspection reference](../reference/explorer-data.md) covers the other things an explorer reads:

- [an address's transactions](../reference/explorer-data.md#address-transactions), through `searchRawTransactions` and `prevoutsFromSearch`;
- [the mempool](../reference/explorer-data.md#mempool), through `fetchMempool`;
- [running totals](../reference/explorer-data.md#running-totals) such as the supply, the difficulty and the total work.
