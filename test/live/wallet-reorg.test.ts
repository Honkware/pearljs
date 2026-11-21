// Reorganizations that happen while a wallet's process is not running. A
// wallet in a file store records a confirmed payment and is closed; pearld
// then invalidates the payment's block, the payer spends the same coin
// elsewhere, and a new branch is mined. Reopened, the wallet must roll the
// payment back and see it conflicted, both when the fork lies inside
// reorgDepth and when it lies far below it. Runs after reorg.test.ts: it
// moves the suite's node to another branch.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { deriveSigningAccountFromSeed, mnemonicToSeed, payFromAccount, PearlWallet, toOutputScript } from '../../src/index.js';
import { createFileStore } from '../../src/store-file.js';
import { describeLive, FEE_RATE, fund, live, mine, network, pearld } from './chain.js';
import { connection, nodeBackend, outsider, PASSPHRASE, QUICK_KDF, recordEvents } from './wallets.js';

const payer = deriveSigningAccountFromSeed(mnemonicToSeed('vocal slight cargo mobile fortune slam seed solar swear cross twice diagram'), network);
const { elsewhere } = outsider(13);
let payerIndex = 0;

/** Pays address from outside the wallet with a transaction that signals replacement, and returns it with a spend of the same coin elsewhere. */
async function payReplaceably(address: string, amount: bigint): Promise<{ payment: string; conflict: { hex: string; txid: string } }> {
  const index = payerIndex++;
  const value = amount + 2_000_000n;
  const funding = await fund([{ script: toOutputScript(payer.deriveAddress(index), network), value }]);
  const utxos = [{ txid: funding.getId(), vout: 0, value, script: funding.outs[0]!.script, confirmations: 1, index }];
  const payment = payFromAccount(payer, { network, utxos, recipients: [{ address, amount }], feeRate: FEE_RATE, rbf: true, changeAddress: payer.deriveAddress(index, true) });
  const conflict = payFromAccount(payer, { network, utxos, recipients: [{ address: elsewhere(index), amount: 'max' }], feeRate: 20_000n });
  await pearld.sendRawTransaction(payment.hex);
  return { payment: payment.txid, conflict: { hex: conflict.hex, txid: conflict.txid } };
}

async function offlineReorg(reorgDepth: number, buried: number, name: string): Promise<void> {
  const dir = join(live?.dir ?? '.', 'wallet-reorg');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  let wallet = await PearlWallet.create({ ...connection(createFileStore(path, { create: true })), passphrase: PASSPHRASE, unlockTimeout: null, kdf: QUICK_KDF, reorgDepth });
  const kept = await wallet.receiveAddress();
  const lost = await wallet.receiveAddress();
  await fund([{ script: toOutputScript(kept, network), value: 3_000_000n }]);
  const { payment, conflict } = await payReplaceably(lost, 5_000_000n);
  const [paidIn] = await mine(1);
  const height = await pearld.getBlockCount();
  if (buried > 0) await mine(buried);
  await wallet.sync();
  expect(wallet.transaction(payment)).toMatchObject({ status: 'confirmed', block: { height, hash: paidIn } });
  expect(wallet.balance().confirmed).toBe(8_000_000n);
  const before = await pearld.getBestBlockHash();
  await wallet.close();

  // While the wallet is closed: the block goes, the payment returns to the mempool and is replaced, and a longer branch is mined.
  await pearld.invalidateBlock(paidIn!);
  expect(await pearld.getBlockCount()).toBe(height - 1);
  expect(await pearld.getRawMempool()).toContain(payment);
  expect(await pearld.sendRawTransaction(conflict.hex)).toBe(conflict.txid);
  const branch = await mine(buried + 2);
  expect(await pearld.getRawTransaction(conflict.txid)).toMatchObject({ blockhash: branch[0] });
  // Reconsidered, the old branch is valid again but shorter, so the node stays where it is.
  await pearld.reconsiderBlock(paidIn!);
  expect(await pearld.getBestBlockHash()).toBe(branch.at(-1));
  expect((await pearld.getChainTips()).map((tip) => tip.hash)).toEqual(expect.arrayContaining([before, branch.at(-1)]));

  wallet = await PearlWallet.open(connection(createFileStore(path)));
  const reorgs = recordEvents(wallet, 'reorg');
  const conflicts = recordEvents(wallet, 'conflict');
  await wallet.sync();
  expect(reorgs.seen).toMatchObject([{ forkHeight: height, tip: { height: height + buried + 1, hash: branch.at(-1) } }]);
  expect(wallet.transaction(payment)).toMatchObject({ status: 'conflicted', by: conflict.txid, block: null });
  expect(conflicts.seen).toContainEqual({ txid: payment, status: 'conflicted', by: conflict.txid });
  expect(wallet.balance()).toMatchObject({ confirmed: 3_000_000n, unconfirmed: 0n, total: 3_000_000n });
  expect(wallet.balance()).toMatchObject(await nodeBackend.getBalance([kept, lost]));
  expect(wallet.tip).toEqual({ height: height + buried + 1, hash: branch.at(-1) });
  await wallet.close();
}

describeLive('reorganizations while the wallet is closed', () => {
  it('rolls back a payment double-spent in a reorg inside reorgDepth', async () => {
    await offlineReorg(10, 2, 'inside');
  });

  it('rolls back a payment double-spent in a reorg far deeper than reorgDepth', async () => {
    await offlineReorg(2, 9, 'beyond');
  });
});
