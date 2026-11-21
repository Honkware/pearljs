// A second process for the wallet tests, bundled and started by
// wallet-state.test.ts: opens the wallet file named in its environment,
// starts a full sync against the node, writes a dot for every address
// history it fetches, and never exits by itself. The test kills it mid-sync.

import { PearlWallet, PearldClient, networks, pearldBackend, pearldTransactionSource } from '../../src/index.js';
import { createFileStore } from '../../src/store-file.js';
import { trustingAgent } from './context.js';

const { WALLET_PATH, NODE_URL, NODE_USER, NODE_PASS, NODE_CA } = process.env;
const node = new PearldClient({
  url: NODE_URL!,
  username: NODE_USER!,
  password: NODE_PASS!,
  init: { dispatcher: trustingAgent(NODE_CA!) },
});
const backend = pearldBackend(node, { network: networks.regtest });
const wallet = await PearlWallet.open({
  store: createFileStore(WALLET_PATH!),
  backend: {
    ...backend,
    async getHistory(watched) {
      process.stdout.write('.');
      return backend.getHistory(watched);
    },
  },
  transactions: pearldTransactionSource(node),
});
process.stdout.write(`open ${wallet.balance().total}\n`);
await wallet.sync({ full: true });
process.stdout.write('synced\n');
setInterval(() => {}, 1000);
