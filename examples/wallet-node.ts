/**
 * Keep a wallet in a directory on disk and bring it up to a node: create it on the first
 * run, then on every run sync, print what it holds and where to pay it, and
 * pay an address if asked.
 *
 * Needs a running pearld, with --addrindex or its filter index. Settings come from the
 * environment (see lib/env.ts), plus:
 *
 *   WALLET_FILE         the directory the wallet lives in, for example ./regtest-wallet
 *   WALLET_PASSPHRASE   encrypts its keys
 *   PEARL_MNEMONIC      on the first run only: restore this phrase instead of making a new one
 *   PAY_TO, PAY_AMOUNT  optional: send PAY_AMOUNT PRL to PAY_TO, a real transaction
 *
 *   npm run build && npx tsc -p tsconfig.examples.json
 *   node dist-examples/examples/wallet-node.js
 */
import { existsSync } from 'node:fs';
import { PearlWallet, PearldClient, connectPearld, formatPearl, parsePearl } from 'pearljs';
import { createFileStore } from 'pearljs/store-file';
import { dispatcher, network, pearld, required } from './lib/env.js';

const agent = dispatcher();
const node = new PearldClient({ ...pearld(), ...(agent === undefined ? {} : { init: { dispatcher: agent } }), batch: true });
const path = required('WALLET_FILE');
const passphrase = required('WALLET_PASSPHRASE');
const fresh = !existsSync(path);
const connection = {
  store: createFileStore(path, { create: fresh }),
  // The backend is also the wallet's source of full transactions.
  backend: await connectPearld(node, { network: network(), birthday: 0 }),
};

const wallet = fresh
  ? await PearlWallet.create({ ...connection, passphrase, ...(process.env.PEARL_MNEMONIC === undefined ? {} : { mnemonic: process.env.PEARL_MNEMONIC }) })
  : await PearlWallet.open(connection);
if (fresh && process.env.PEARL_MNEMONIC === undefined) console.log('new wallet; write down its phrase:', await wallet.mnemonic());

try {
  await wallet.sync();
  const balance = wallet.balance();
  console.log('tip        ', wallet.tip?.height);
  console.log('confirmed  ', formatPearl(balance.confirmed), 'PRL');
  console.log('unconfirmed', formatPearl(balance.unconfirmed), 'PRL');
  console.log('immature   ', formatPearl(balance.immature), 'PRL');
  for (const entry of wallet.history().slice(0, 10)) {
    console.log(' ', entry.status.padEnd(10), entry.direction.padEnd(8), formatPearl(entry.amount).padStart(16), entry.txid);
  }
  console.log('pay to     ', await wallet.currentAddress());

  if (process.env.PAY_TO !== undefined) {
    await wallet.unlock(passphrase, { timeout: 60_000 });
    const sent = await wallet.send({ recipients: [{ address: process.env.PAY_TO, amount: parsePearl(required('PAY_AMOUNT')) }], rbf: true });
    console.log('sent       ', sent.txid, 'fee', formatPearl(sent.fee), 'PRL');
  }
} finally {
  await wallet.close();
}
