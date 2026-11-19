// The testnet2 wallet the public-network tests spend from, kept in
// <dir>/wallet/: the file store in store/, and secrets.json (mode 600) with
// the mnemonic pearljs generated and the keystore passphrase.
//
//   node scripts/testnet/wallet.mjs create    makes it, once
//   node scripts/testnet/wallet.mjs address   prints account 0's first receive address
//   node scripts/testnet/wallet.mjs balance   syncs and prints the balance in grain
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { PearlWallet, networks, pearldBackend } from 'pearljs';
import { createFileStore } from 'pearljs/store-file';
import { client, nodeDir } from './node.mjs';

const dir = join(nodeDir, 'wallet');
const secretsFile = join(dir, 'secrets.json');
const network = networks[process.env.PEARL_TESTNET_NETWORK ?? 'testnet2'];

export function secrets() {
  return JSON.parse(readFileSync(secretsFile, 'utf8'));
}

export async function openWallet() {
  const rpc = client();
  return PearlWallet.open({ store: createFileStore(join(dir, 'store'), { breakStaleLock: true }), backend: pearldBackend(rpc, { network }) });
}

const command = process.argv[1]?.endsWith('wallet.mjs') ? process.argv[2] : undefined;
if (command === 'create') {
  if (existsSync(secretsFile)) throw new Error(`${secretsFile} exists; the wallet is made once`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const passphrase = randomBytes(24).toString('hex');
  const wallet = await PearlWallet.create({
    store: createFileStore(join(dir, 'store'), { create: true }),
    backend: pearldBackend(client(), { network }),
    passphrase,
    unlockTimeout: null,
  });
  writeFileSync(secretsFile, JSON.stringify({ mnemonic: await wallet.mnemonic(), passphrase }), { mode: 0o600 });
  chmodSync(secretsFile, 0o600);
  wallet.lock();
  await wallet.close();
  console.log(`created; secrets in ${secretsFile}`);
} else if (command === 'address') {
  const wallet = await openWallet();
  const first = wallet.addresses({ account: '0' }).find((entry) => !entry.change && entry.index === 0);
  console.log(first?.address ?? (await wallet.receiveAddress({ label: 'faucet' })));
  await wallet.close();
} else if (command === 'balance') {
  const wallet = await openWallet();
  await wallet.sync();
  console.log(wallet.tip, wallet.balance());
  await wallet.close();
}
