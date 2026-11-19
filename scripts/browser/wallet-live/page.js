// A wallet page for scripts/browser-wallet-live.mjs: a PearlWallet on the
// IndexedDB store, reading a regtest pearld through the harness's same-origin
// RPC proxy. The harness calls window.app.<name>(...) and gets back
// { value } or { error, code }.
import { PearlWallet, PearldClient, connectPearld, networks, openIndexedDbStore, parsePearl } from 'pearljs';

const network = networks.regtest;
const rpc = new PearldClient({ url: new URL('/rpc', globalThis.location.href).href });
const backend = connectPearld(rpc, { network, birthday: 0 });
const wallets = {};
const json = (value) => value === undefined ? null : JSON.parse(JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));

const api = {
  async create(slot, name, passphrase) {
    wallets[slot] = await PearlWallet.create({ store: await openIndexedDbStore(name), backend: await backend, passphrase, kdf: { N: 2 ** 14 } });
  },
  async open(slot, name, options = {}) {
    wallets[slot] = await PearlWallet.open({ store: await openIndexedDbStore(name, options), backend: await backend });
    return wallets[slot].locked;
  },
  openStore: async (name, options = {}) => {
    const store = await openIndexedDbStore(name, options);
    globalThis.__store = store;
  },
  storeCall: async (method, ...args) => globalThis.__store[method](...args),
  unlock: (slot, passphrase) => wallets[slot].unlock(passphrase),
  lock: (slot) => wallets[slot].lock(),
  locked: (slot) => wallets[slot].locked,
  receive: (slot) => wallets[slot].receiveAddress(),
  sync: (slot) => wallets[slot].sync(),
  balance: (slot) => wallets[slot].balance(),
  history: (slot) => wallets[slot].history().map((e) => ({ txid: e.txid, status: e.status, direction: e.direction, amount: e.amount })),
  send: async (slot, address, amount, from) => {
    const sent = await wallets[slot].send({ recipients: [{ address, amount: amount === 'max' ? 'max' : parsePearl(amount) }], ...(from ? { from } : {}) });
    return { txid: sent.txid, hex: sent.hex };
  },
  addXmssKey: (slot) => wallets[slot].addXmssKey({ label: 'vault' }),
  xmssKeys: (slot) => wallets[slot].xmssKeys(),
  close: (slot) => wallets[slot].close(),
  // Starts a send and does not wait for it, so the harness can kill the tab while it writes.
  sendInBackground(slot, address, amount) {
    globalThis.__background = api.send(slot, address, amount).then(
      (value) => ({ value }),
      (error) => ({ error: error.message, code: error.code }),
    );
  },
};

globalThis.app = new Proxy(api, {
  get: (target, name) => async (...args) => {
    try {
      return { value: json(await target[name](...args)) ?? null };
    } catch (error) {
      return { error: `${error.name}: ${error.message}`, code: error.code ?? null };
    }
  },
});
globalThis.appReady = true;
