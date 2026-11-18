// A second process for wallet-processes.test.ts, bundled and started by it:
// opens the wallet store named in its environment, with the lock options the
// environment gives, unlocks it and then does what each line on stdin asks,
// answering each with one line of JSON. Amounts cross as decimal strings.
//
//   {"op":"send","address":"...","amount":"1000000","from":{"xmss":"..."}}   -> {"txid":"..."}
//   {"op":"sync"}                                                           -> {"balance":"..."}
//
// A failure is answered {"error":{"name","code","message"}}; opening fails the
// same way and the process then exits.

import { createInterface } from 'node:readline';
import { Agent } from 'undici';
import { PearlWallet, PearldClient, networks, pearldBackend } from '../src/index.js';
import type { CoinSource } from '../src/index.js';
import { createFileStore } from '../src/store-file.js';

const { WALLET_PATH, WALLET_PASS, LOCK, NODE_URL, NODE_USER, NODE_PASS, NODE_CA } = process.env;
const answer = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};
const failed = (err: unknown): void => {
  const { name, code, message } = err as { name?: string; code?: string; message?: string };
  answer({ error: { name, code, message } });
};

const node = new PearldClient({
  url: NODE_URL!,
  username: NODE_USER!,
  password: NODE_PASS!,
  init: { dispatcher: new Agent({ connect: { ca: NODE_CA! } }) },
});
let wallet: PearlWallet;
try {
  const lock = LOCK === 'stale' ? { breakStaleLock: true } : LOCK === 'break' ? { breakLock: true } : {};
  wallet = await PearlWallet.open({ store: createFileStore(WALLET_PATH!, lock), backend: pearldBackend(node, { network: networks.regtest }) });
  await wallet.unlock(WALLET_PASS!);
  answer({ open: process.pid });
} catch (err) {
  failed(err);
  process.exit(1);
}

for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line) as { op: string; address?: string; amount?: string; from?: CoinSource };
  try {
    if (request.op === 'send') {
      const sent = await wallet.send({ recipients: [{ address: request.address!, amount: BigInt(request.amount!) }], feeRate: 2000n, ...(request.from === undefined ? {} : { from: request.from }) });
      answer({ txid: sent.txid });
    } else if (request.op === 'sync') {
      await wallet.sync();
      answer({ balance: String(wallet.balance().total) });
    } else {
      answer({ error: { name: 'Error', message: `unknown op ${request.op}` } });
    }
  } catch (err) {
    failed(err);
  }
}
