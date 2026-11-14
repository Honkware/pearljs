/**
 * Find an account's coins on a node, pay an address and broadcast.
 *
 * Needs a running pearld started with --addrindex, and it sends a real
 * transaction on the network it is pointed at. Settings come from the
 * environment (see lib/env.ts), plus:
 *
 *   PEARL_MNEMONIC   the wallet's recovery phrase
 *   PAY_TO           the address to pay
 *   PAY_AMOUNT       in PRL, for example 1.5
 *
 *   npm run build && npx tsc -p tsconfig.examples.json
 *   node dist-examples/examples/send-payment.js
 */
import {
  deriveSigningAccountFromSeed,
  discoverAccount,
  feeRateToGrainPerVbyte,
  formatPearl,
  InsufficientFundsError,
  mnemonicToSeed,
  parsePearl,
  payFromAccount,
  PearldClient,
  pearldBackend,
} from 'pearljs';
import { dispatcher, network, pearld, required } from './lib/env.js';

const net = network();
const agent = dispatcher();
const node = new PearldClient({
  ...pearld(),
  ...(agent === undefined ? {} : { init: { dispatcher: agent } }),
  batch: true, // discovery asks about hundreds of addresses
});
const backend = pearldBackend(node, { network: net });
const account = deriveSigningAccountFromSeed(mnemonicToSeed(required('PEARL_MNEMONIC')), net);

try {
  const wallet = await discoverAccount(account, backend);
  console.log('confirmed  ', formatPearl(wallet.balance.confirmed), 'PRL');
  console.log('unconfirmed', formatPearl(wallet.balance.unconfirmed), 'PRL');
  console.log('immature   ', formatPearl(wallet.balance.immature), 'PRL');

  const feeRate = await backend.estimateFeeRate();
  console.log('fee rate   ', feeRateToGrainPerVbyte(feeRate), 'grain per vbyte');

  const payment = payFromAccount(account, {
    network: net,
    utxos: wallet.utxos,
    recipients: [{ address: required('PAY_TO'), amount: parsePearl(required('PAY_AMOUNT')) }],
    feeRate,
    changeAddress: account.deriveAddress(wallet.change.nextIndex, true),
  });
  console.log('fee        ', formatPearl(payment.fee), 'PRL for', payment.vsize, 'vbytes');

  const txid = await backend.broadcast(payment.hex);
  console.log('sent       ', txid);
} catch (err) {
  if (!(err instanceof InsufficientFundsError)) throw err;
  console.error(`not enough funds: ${formatPearl(err.missing)} PRL short`);
  process.exitCode = 1;
} finally {
  account.destroy();
  await agent?.close();
}
