/**
 * Create an invoice for an address and follow it until it is confirmed,
 * expires or conflicts.
 *
 * Needs a running pearld started with --addrindex. Settings come from the
 * environment (see lib/env.ts), plus:
 *
 *   INVOICE_ADDRESS   the address to watch, one nobody else is paid at
 *   INVOICE_AMOUNT    in PRL, for example 0.5
 *
 *   npm run build && npx tsc -p tsconfig.examples.json
 *   node dist-examples/examples/monitor-invoice.js
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { formatPearl, InvoiceMonitor, parsePearl, PearldClient, pearldChainClient, type Invoice } from 'pearljs';
import { dispatcher, network, pearld, required } from './lib/env.js';

const agent = dispatcher();
const node = new PearldClient({
  ...pearld(),
  ...(agent === undefined ? {} : { init: { dispatcher: agent } }),
  retry: true,
});
const monitor = new InvoiceMonitor(pearldChainClient(node), network());

const now = Math.floor(Date.now() / 1000);
let invoice: Invoice = monitor.createInvoice({
  id: `example-${now}`,
  address: required('INVOICE_ADDRESS'),
  amount: parsePearl(required('INVOICE_AMOUNT')),
  createdAt: now,
  expiresAt: now + 3600,
  requiredConfirmations: 2,
});
console.log(`waiting for ${formatPearl(invoice.amount)} PRL at ${invoice.address}`);

// A real application stores `invoice` after every refresh and can stop and
// resume at any point; the record is all the state there is.
let last = '';
while (!['confirmed', 'overpaid', 'expired', 'expired-underpaid', 'conflicted'].includes(invoice.state)) {
  invoice = await monitor.refreshInvoice(invoice);
  const line = `${invoice.state}: ${formatPearl(invoice.paidAmount)} PRL paid, ${invoice.confirmations} confirmations`;
  if (line !== last) console.log(line);
  last = line;
  await sleep(5000);
}
await agent?.close();
