/**
 * Create an invoice for an address and follow it with the invoice watcher,
 * printing every change, until it is paid, expires or conflicts.
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
import { formatPearl, InvoiceMonitor, invoiceToJson, parsePearl, PearldClient, pearldChainClient, watchInvoices, type Invoice } from 'pearljs';
import { dispatcher, network, pearld, required } from './lib/env.js';

const agent = dispatcher();
const node = new PearldClient({
  ...pearld(),
  ...(agent === undefined ? {} : { init: { dispatcher: agent } }),
  retry: true,
});
const chain = pearldChainClient(node);
const monitor = new InvoiceMonitor(chain, network());

const now = Math.floor(Date.now() / 1000);
const invoice: Invoice = monitor.createInvoice({
  id: `example-${now}`,
  address: required('INVOICE_ADDRESS'),
  amount: parsePearl(required('INVOICE_AMOUNT')),
  createdAt: now,
  expiresAt: now + 3600,
  requiredConfirmations: 2,
});
console.log(`waiting for ${formatPearl(invoice.amount)} PRL at ${invoice.address}`);

const final = new Set(['confirmed', 'overpaid', 'expired', 'expired-underpaid', 'conflicted']);
let done!: () => void;
const finished = new Promise<void>((resolve) => (done = resolve));

// Polling only; pass a PearlWsClient as `ws` to hear of payments and blocks at once.
const watcher = watchInvoices({
  client: chain,
  network: network(),
  invoices: [invoice],
  pollInterval: 5000,
  onChange: (next) => {
    // A real application stores this record; it is all the state there is.
    const record = JSON.stringify(invoiceToJson(next));
    console.log(`${next.state}: ${formatPearl(next.paidAmount)} PRL counted, ${formatPearl(next.uncountedAmount)} late, ${next.confirmations} confirmations (${record.length} bytes stored)`);
    for (const payment of next.payments) console.log(`  ${payment.txid} ${formatPearl(payment.amount)} ${payment.status}${payment.counted ? '' : ', not counted'}`);
    if (final.has(next.state)) done();
  },
  onError: (error) => console.error(`refresh failed: ${error.message}`),
});

await finished;
await watcher.stop();
await agent?.close();
