// A small pearljs wallet for one real payment, run by hand: it makes a
// wallet, shows where to fund it, and sends an amount you type after showing
// the fee and asking for a typed confirmation. Nothing here runs unattended.
//
//   node scripts/mainnet/send.mjs create                 a new wallet; prints the recovery phrase once
//   node scripts/mainnet/send.mjs address                the address to fund
//   node scripts/mainnet/send.mjs balance
//   node scripts/mainnet/send.mjs send <address> <PRL>   asks before it signs
//   node scripts/mainnet/send.mjs status <txid>          confirmations, read from the node
//
// It reads the chain through pearld's compact filters, so the node needs no
// address index. Variables:
//
//   PEARL_SEND_DIR       the wallet's folder (mode 700); required
//   PEARL_SEND_NETWORK   mainnet unless given
//   PEARLD_URL, PEARLD_CERT, PEARLD_USER, PEARLD_PASS
//                        the node to read; pearld's limited user is enough
//   PEARLD_SEND_USER, PEARLD_SEND_PASS
//                        the node's full user, for sendrawtransaction; the
//                        reading user when left out
//
// The passphrase is asked for and never stored. Build first: npm run build.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';
import { PearlWallet, PearldClient, filterBackend, formatPearl, networks, parsePearl } from 'pearljs';
import { createFileStore } from 'pearljs/store-file';
import { pearldFetch } from 'pearljs/tls-fetch';

const env = (name) => {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`${name} is not set`);
  return value;
};

const dir = env('PEARL_SEND_DIR');
const networkName = process.env.PEARL_SEND_NETWORK ?? 'mainnet';
const network = networks[networkName];
if (network === undefined) throw new Error(`unknown network ${networkName}`);
const birthdayFile = join(dir, 'birthday');

function client(user, pass) {
  const ca = readFileSync(env('PEARLD_CERT'), 'utf8');
  return new PearldClient({ url: env('PEARLD_URL'), username: user, password: pass, fetch: pearldFetch({ ca }), retry: true });
}

const reader = () => client(env('PEARLD_USER'), env('PEARLD_PASS'));
const sender = () => client(process.env.PEARLD_SEND_USER ?? env('PEARLD_USER'), process.env.PEARLD_SEND_PASS ?? env('PEARLD_PASS'));

// One reader for the whole run, so typed and piped answers are both read in order.
let rl;
let muted = false;
const lines = [];
const waiting = [];
function ask(question, { hidden = false } = {}) {
  if (rl === undefined) {
    rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY === true });
    // Typed characters are not echoed for a passphrase.
    const write = rl._writeToOutput.bind(rl);
    rl._writeToOutput = (text) => (muted ? undefined : write(text));
    rl.on('line', (line) => (waiting.length > 0 ? waiting.shift()(line) : lines.push(line)));
    rl.on('close', () => waiting.splice(0).forEach((resolve) => resolve('')));
  }
  process.stdout.write(question);
  muted = hidden;
  return new Promise((resolve) => {
    const done = (line) => {
      muted = false;
      if (hidden) process.stdout.write('\n');
      resolve(line);
    };
    if (lines.length > 0) done(lines.shift());
    else waiting.push(done);
  });
}

function backend(birthday) {
  return filterBackend(reader(), {
    network,
    birthday,
    store: createFileStore(join(dir, 'filters'), { create: !existsSync(join(dir, 'filters')) }),
    broadcast: sender(),
  });
}

async function open() {
  if (!existsSync(birthdayFile)) throw new Error(`no wallet in ${dir}; run create first`);
  return PearlWallet.open({ store: createFileStore(join(dir, 'store')), backend: backend(Number(readFileSync(birthdayFile, 'utf8'))) });
}

const command = process.argv[2];
if (command === 'create') {
  if (existsSync(birthdayFile)) throw new Error(`${dir} already holds a wallet`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const passphrase = await ask('New passphrase: ', { hidden: true });
  if (passphrase.length < 8) throw new Error('use a passphrase of at least 8 characters');
  if ((await ask('Again: ', { hidden: true })) !== passphrase) throw new Error('the passphrases differ');
  // The wallet is new, so nothing can have paid it before the node's tip.
  const birthday = await reader().getBlockCount();
  writeFileSync(birthdayFile, String(birthday), { mode: 0o600 });
  const wallet = await PearlWallet.create({ store: createFileStore(join(dir, 'store'), { create: true }), backend: backend(birthday), passphrase });
  console.log(`\nRecovery phrase, shown once. Write it down:\n\n  ${await wallet.mnemonic()}\n`);
  console.log(`Fund this ${networkName} address: ${await wallet.receiveAddress({ label: 'first' })}`);
  wallet.lock();
  await wallet.close();
} else if (command === 'address') {
  const wallet = await open();
  console.log(wallet.addresses({ account: '0' }).find((entry) => !entry.change && entry.index === 0).address);
  await wallet.close();
} else if (command === 'balance') {
  const wallet = await open();
  await wallet.sync();
  const { confirmed, unconfirmed } = wallet.balance();
  console.log(`height ${wallet.tip?.height}: ${formatPearl(confirmed, 'PRL')} confirmed, ${formatPearl(unconfirmed, 'PRL')} unconfirmed`);
  await wallet.close();
} else if (command === 'send') {
  const [address, text] = process.argv.slice(3);
  if (address === undefined || text === undefined) throw new Error('usage: send <address> <PRL>');
  const amount = parsePearl(text);
  const wallet = await open();
  try {
    await wallet.sync();
    const recipients = [{ address, amount }];
    // Chooses coins and a fee without signing or holding anything.
    const preview = await wallet.prepareSend({ recipients, hold: 0 });
    console.log(`\nNetwork  ${networkName}\nTo       ${address}\nAmount   ${formatPearl(amount, 'PRL')}\nFee      ${formatPearl(preview.fee, 'PRL')} (${preview.vsize} vbytes)`);
    console.log(`Balance  ${formatPearl(wallet.balance().confirmed, 'PRL')} confirmed\n`);
    console.log('A payment that confirms cannot be taken back.');
    if ((await ask(`Type the amount again to send it (${text}): `)) !== text) throw new Error('not sent');
    await wallet.unlock(await ask('Passphrase: ', { hidden: true }));
    const sent = await wallet.send({ recipients, label: 'scripts/mainnet/send.mjs' });
    wallet.lock();
    console.log(`\nsent ${sent.txid}\nfee ${formatPearl(sent.fee, 'PRL')}, ${sent.vsize} vbytes, change ${formatPearl(sent.change, 'PRL')}`);
    console.log(`check it with: node scripts/mainnet/send.mjs status ${sent.txid}`);
  } finally {
    await wallet.close();
  }
} else if (command === 'status') {
  const txid = process.argv[3];
  if (txid === undefined) throw new Error('usage: status <txid>');
  const wallet = await open();
  await wallet.sync();
  const entry = wallet.history({ limit: 10_000 }).find((item) => item.txid === txid);
  console.log(entry === undefined ? 'the wallet does not know that transaction' : `${entry.status}${entry.block === null ? '' : ` in block ${entry.block.height}, ${wallet.tip.height - entry.block.height + 1} confirmations`}`);
  await wallet.close();
} else {
  console.log('usage: send.mjs create | address | balance | send <address> <PRL> | status <txid>');
  process.exitCode = 1;
}
rl?.close();
