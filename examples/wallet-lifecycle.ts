/**
 * A wallet's life against a simulated chain: create it encrypted, receive,
 * confirm, send, restart from its store, and restore from its backups.
 *
 * The chain is an in-memory simulation with no node behind it; it checks
 * no signatures. Against pearld, replace it with pearldBackend and
 * pearldTransactionSource as docs/wallet.md shows, and the in-memory store
 * with createFileStore from pearljs/store-file.
 */
import {
  PearlWallet,
  addInputByTxid,
  createMemoryStore,
  createTransaction,
  formatPearl,
  fromOutputScript,
  networks,
  parsePearl,
  parseTransaction,
  sumBalance,
  toOutputScript,
} from 'pearljs';
import type { BlockRef, SpendStatus, Transaction, TransactionSource, WalletBackend, WalletUtxo, Watched } from 'pearljs';

const network = networks.regtest;
const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const parentOf = (input: Transaction['ins'][number]): string => hex(Uint8Array.from(input.hash).reverse());
const scriptOf = (watched: Watched): string => hex(typeof watched === 'string' ? toOutputScript(watched, network) : watched);

/** In-memory simulated chain; not a node integration. */
class SimulatedChain implements WalletBackend, TransactionSource {
  readonly network = network;
  readonly blocks: { ref: BlockRef; txs: Transaction[] }[] = [{ ref: { height: 0, hash: 'sim-0' }, txs: [] }];
  readonly mempool: Transaction[] = [];
  #payments = 0;

  pay(address: string, amount: bigint): void {
    const tx = createTransaction(2);
    addInputByTxid(tx, (++this.#payments).toString(16).padStart(64, 'f'), 0);
    tx.addOutput(toOutputScript(address, network), amount);
    this.mempool.push(tx);
  }

  mine(): void {
    const height = this.blocks.length;
    this.blocks.push({ ref: { height, hash: `sim-${height}` }, txs: this.mempool.splice(0) });
  }

  #all(): { tx: Transaction; block: BlockRef | null }[] {
    return [...this.blocks.flatMap(({ ref, txs }) => txs.map((tx) => ({ tx, block: ref }))), ...this.mempool.map((tx) => ({ tx, block: null }))];
  }

  async getTip() {
    return this.blocks[this.blocks.length - 1]!.ref;
  }
  async getTransaction(txid: string) {
    const found = this.#all().find(({ tx }) => tx.getId() === txid);
    return found === undefined ? null : { txid, block: found.block };
  }
  async getRawTransaction(txid: string) {
    return this.#all().find(({ tx }) => tx.getId() === txid)?.tx.toHex() ?? null;
  }
  async getAddressActivity(address: string) {
    return (await this.getHistory(address)).map(({ txid, block, received }) => ({ txid, block, amount: received }));
  }
  async getHistory(watched: Watched) {
    const script = scriptOf(watched);
    const ours = new Set(this.#all().flatMap(({ tx }) => tx.outs.flatMap((out, i) => (hex(out.script) === script ? [`${tx.getId()}:${i}`] : []))));
    return this.#all()
      .map(({ tx, block }) => ({
        txid: tx.getId(),
        block,
        received: tx.outs.filter((out) => hex(out.script) === script).reduce((sum, out) => sum + out.value, 0n),
        touches: tx.ins.some((input) => ours.has(`${parentOf(input)}:${input.index}`)),
      }))
      .filter((entry) => entry.received > 0n || entry.touches)
      .map(({ txid, block, received }) => ({ txid, block, received }));
  }
  async getUtxos(watched: readonly Watched[]) {
    const scripts = new Set(watched.map(scriptOf));
    const spent = new Set(this.#all().flatMap(({ tx }) => tx.ins.map((input) => `${parentOf(input)}:${input.index}`)));
    const tip = (await this.getTip()).height;
    const utxos: WalletUtxo[] = [];
    for (const { tx, block } of this.#all()) {
      tx.outs.forEach((out, vout) => {
        if (!scripts.has(hex(out.script)) || spent.has(`${tx.getId()}:${vout}`)) return;
        const script = Uint8Array.from(out.script);
        utxos.push({ txid: tx.getId(), vout, value: out.value, script, address: fromOutputScript(script, network), confirmations: block === null ? 0 : tip - block.height + 1, coinbase: false });
      });
    }
    return utxos;
  }
  async getBalance(watched: readonly Watched[]) {
    return sumBalance(await this.getUtxos(watched), network.coinbaseMaturity);
  }
  async broadcast(raw: string | Uint8Array) {
    const tx = parseTransaction(typeof raw === 'string' ? raw : hex(raw));
    this.mempool.push(tx);
    return tx.getId();
  }
  async estimateFeeRate() {
    return 2000n;
  }
  async getSpendStatus(outpoint: { txid: string; vout: number }): Promise<SpendStatus> {
    const spender = this.#all().find(({ tx }) => tx.ins.some((input) => parentOf(input) === outpoint.txid && input.index === outpoint.vout));
    return spender === undefined ? { status: 'unspent', confirmations: 0 } : { status: 'spent', spender: spender.tx.getId(), confirmed: spender.block !== null };
  }
}

const chain = new SimulatedChain();
const store = createMemoryStore();
const passphrase = 'example passphrase, use a long one';
// N = 2^12 keeps the example quick; leave kdf out for the default, N = 2^18.
const wallet = await PearlWallet.create({ store, backend: chain, transactions: chain, passphrase, kdf: { N: 2 ** 12 } });
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
const reopened = await PearlWallet.open({ store, backend: chain, transactions: chain });
show(`reopened (locked: ${reopened.locked})`, reopened);

// A restore on a new machine, from the two backups.
const restored = await PearlWallet.restore({ store: createMemoryStore(), backend: chain, transactions: chain, keystore, backup, passphrase });
await restored.sync();
show('restored', restored);
console.log('labels kept:', restored.addresses().map((a) => a.label).filter((label) => label !== null));
