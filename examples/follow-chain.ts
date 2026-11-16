/**
 * A small indexer: follow the chain block by block, decode every
 * transaction, keep running totals, and undo the blocks a reorganization
 * removes.
 *
 * Runs offline against the simulated chain of pearljs/testing, which also
 * plays the part of the outside world here: it pays, mines and reorganizes.
 * Against pearld, pass a PearldClient to followChain and resolvePrevouts
 * where this passes chain.rpc; docs/explorer.md says which flags it needs.
 */
import { blockSubsidy, customNetwork, followChain, formatPearl, inspectTransaction, networks, parsePearl, payFromAccount, resolvePrevouts } from 'pearljs';
import type { Transaction } from 'pearljs';
import { SimulatedChain, testAccount, testAddress } from 'pearljs/testing';

const network = customNetwork(networks.regtest, { coinbaseMaturity: 3 });
const chain = new SimulatedChain({ network, premine: 5 });
const customer = testAccount();
const coin = chain.fund(customer.deriveAddress(0), parsePearl('9'));
const payment = payFromAccount(customer, {
  network,
  utxos: [{ ...coin, index: 0 }],
  recipients: [{ address: testAddress(1), amount: parsePearl('4') }],
  feeRate: 2500n,
  changeAddress: customer.deriveAddress(0, true),
});
chain.accept(payment.transaction);
chain.mine();

// The index: one row per block, newest last, and what each address has received.
interface Row {
  height: number;
  hash: string;
  fees: bigint;
  supply: bigint;
  received: Map<string, bigint>;
}
const rows: Row[] = [];
const known = new Map<string, Transaction>();

const follower = followChain(chain.rpc, { from: { height: 0 }, pollInterval: 10 });
for await (const event of follower) {
  if (event.type === 'connected') {
    const [coinbase, ...rest] = event.block.transactions;
    for (const tx of rest) known.set(tx.getId(), tx);
    const row: Row = { height: event.height, hash: event.hash, fees: 0n, supply: (rows[rows.length - 1]?.supply ?? 0n) + blockSubsidy(network, event.height), received: new Map() };
    for (const tx of rest) {
      const info = inspectTransaction(tx, await resolvePrevouts(tx, chain.rpc, { known }), network);
      row.fees += info.fee;
      for (const output of info.outputs) if (output.address !== null) row.received.set(output.address, (row.received.get(output.address) ?? 0n) + output.value);
    }
    const reward = inspectTransaction(coinbase!, [], network, { blockFees: row.fees }).coinbase!;
    // A miner may leave part of the reward unclaimed; that part never exists.
    row.supply -= reward.unclaimed ?? 0n;
    rows.push(row);
    console.log(`+ ${event.height} ${event.hash.slice(0, 16)} ${event.block.transactions.length} tx, fees ${row.fees}`);
  } else if (event.type === 'disconnected') {
    rows.pop();
    console.log(`- ${event.height} ${event.hash.slice(0, 16)}`);
  } else {
    const paid = rows.reduce((sum, row) => sum + (row.received.get(testAddress(1)) ?? 0n), 0n);
    console.log(`at the tip, height ${event.height}: supply ${formatPearl(rows[rows.length - 1]!.supply)} PRL, ${formatPearl(paid)} PRL received by ${testAddress(1).slice(0, 14)}`);
    // A real indexer stores this with its rows and passes it back as from: { cursor } after a restart.
    console.log('cursor', follower.cursor()!.height, follower.cursor()!.hash.slice(0, 16), `+ ${follower.cursor()!.ancestors!.length} ancestors`);
    if (event.height === 7) chain.reorg(2, { replace: [coin.txid] }); // the customer's funding is double-spent two blocks down
    if (event.height === 8) break;
  }
}
