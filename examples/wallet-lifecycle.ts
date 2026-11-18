/**
 * A wallet's life against a simulated chain: create it encrypted, receive,
 * confirm, send, restart from its store, and restore from its backups.
 *
 * The chain is pearljs/testing's SimulatedChain, a chain and node held in
 * memory that checks every transaction as pearld's mempool does. Against
 * pearld, replace it with connectPearld as docs/wallet.md shows, and the
 * in-memory store with createFileStore from pearljs/store-file.
 */
import { PearlWallet, createMemoryStore, formatPearl, parsePearl } from 'pearljs';
import { SimulatedChain } from 'pearljs/testing';

const chain = new SimulatedChain();
const store = createMemoryStore();
const passphrase = 'example passphrase, use a long one';
// N = 2^12 keeps the example quick; leave kdf out for the default, N = 2^18.
// The chain is the wallet's backend and its source of full transactions at once.
const wallet = await PearlWallet.create({ store, backend: chain, passphrase, kdf: { N: 2 ** 12 } });
const show = (label: string, w: PearlWallet): void => {
  const b = w.balance();
  console.log(`${label}: confirmed ${formatPearl(b.confirmed)}, unconfirmed ${formatPearl(b.unconfirmed)} PRL`);
};

const address = await wallet.receiveAddress({ label: 'first deposit' });
console.log('receive at', address);
chain.pay(address, parsePearl('12'));
await wallet.sync();
show('payment seen', wallet);
chain.mine();
await wallet.sync();
show('payment confirmed', wallet);

const sent = await wallet.send({ recipients: [{ address: 'rprl1p8dhv8twyj9ezfvk62vvsfgw39s4dgl9t42y0549dc4d2947jj4cs30wfpz', amount: parsePearl('5') }], label: 'first payment' });
console.log('sent', sent.txid.slice(0, 16), 'fee', formatPearl(sent.fee), 'change', formatPearl(sent.change));
show('after send', wallet);
chain.mine();
await wallet.sync();
for (const entry of wallet.history()) console.log(' ', entry.status, entry.direction, formatPearl(entry.amount), entry.label ?? '');

const keystore = wallet.exportKeystore();
const backup = await wallet.exportState();
wallet.lock();

// A restart: everything comes back from the store, locked.
const reopened = await PearlWallet.open({ store, backend: chain });
show(`reopened (locked: ${reopened.locked})`, reopened);

// A restore on a new machine, from the two backups.
const restored = await PearlWallet.restore({ store: createMemoryStore(), backend: chain, keystore, backup, passphrase });
await restored.sync();
show('restored', restored);
console.log('labels kept:', restored.addresses().map((a) => a.label).filter((label) => label !== null));
