// Sends everything the test wallet holds, in any account or key, to one
// address: how a funded run hands its coins back to whoever paid for it.
//
//   node scripts/network/return.mjs <address>
import { formatPearl } from 'pearljs';
import { client } from './node.mjs';
import { openWallet, secrets } from './wallet.mjs';

const to = process.argv[2];
if (to === undefined) throw new Error('usage: return.mjs <address>');
const wallet = await openWallet();
try {
  await wallet.unlock(secrets().passphrase);
  // A test that failed between prepareSend and submitSigned leaves coins held.
  for (const prepared of wallet.preparedSends()) await wallet.cancelPrepared(prepared.id);
  await wallet.sync();
  const { confirmed, unconfirmed } = wallet.balance();
  if (unconfirmed !== 0n) throw new Error(`${formatPearl(unconfirmed, 'PRL')} is still unconfirmed; run this again after the next block`);
  if (confirmed === 0n) throw new Error('the wallet holds nothing');
  const sent = await wallet.send({ recipients: [{ address: to, amount: 'max' }], from: 'all', feeRate: (await client().getInfo()).relayfee, label: 'return to the funder' });
  console.log(`returned ${formatPearl(confirmed - sent.fee, 'PRL')} to ${to}\ntxid ${sent.txid}, fee ${formatPearl(sent.fee, 'PRL')}, ${sent.inputs.length} inputs`);
} finally {
  await wallet.close();
}
