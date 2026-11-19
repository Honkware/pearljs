// A rehearsal of the funded tests on a local regtest pearld, so that they are
// known to work before test coins are spent on them. The node is the one
// dryrun.sh starts; this script submits the cached regtest setup chain (its
// coinbases pay account 0 of the live suite's miner phrase), pays the
// rehearsal wallet's first address from the mature coinbase, and then, with
// `mine`, mines one block every PEARL_DRYRUN_BLOCK_SECONDS (60) to stand in
// for the network's miners.
//
//   node scripts/testnet/dryrun.mjs setup <setup-blocks.json>
//   node scripts/testnet/dryrun.mjs mine
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { deriveSigningAccountFromSeed, discoverAccount, mnemonicToSeed, networks, payFromAccount, pearldBackend } from 'pearljs';
import { client } from './node.mjs';

const network = networks.regtest;
const miner = deriveSigningAccountFromSeed(mnemonicToSeed('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'), network);
const rpc = client({ timeout: 600_000 });

if (process.argv[2] === 'setup') {
  const blocks = JSON.parse(readFileSync(process.argv[3], 'utf8'));
  for (const block of blocks.slice(await rpc.getBlockCount())) await rpc.call('submitblock', [block]);
  console.log('height', await rpc.getBlockCount());
  const backend = pearldBackend(rpc, { network });
  const found = await discoverAccount(miner, backend);
  const payment = payFromAccount(miner, {
    network,
    utxos: found.utxos,
    recipients: [{ address: process.argv[4], amount: 1_000_000_000n }],
    feeRate: 1000n,
    changeAddress: miner.deriveAddress(found.change.nextIndex, true),
  });
  console.log('funded', await backend.broadcast(payment.hex));
  // Confirm it at once, so the funded tests find coins when they start.
  await rpc.call('generate', [1]);
} else if (process.argv[2] === 'mine') {
  const seconds = Number(process.env.PEARL_DRYRUN_BLOCK_SECONDS ?? 60);
  for (;;) {
    const [hash] = await rpc.call('generate', [1]);
    console.log(new Date().toISOString(), await rpc.getBlockCount(), hash);
    await sleep(seconds * 1000);
  }
}
