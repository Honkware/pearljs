# Invoice storage and allocation reference

## Storing invoices

An invoice holds its amounts as bigints, which `JSON.stringify` cannot write. `invoiceToJson` turns the record into plain JSON, with the amounts as decimal strings and a format version, and `invoiceFromJson` reads it back:

```ts run
import { createInvoice, encodeAddress, invoiceFromJson, invoiceToJson, networks } from 'pearljs';

const network = networks.regtest;
const address = encodeAddress({ version: 1, program: new Uint8Array(32).fill(7) }, network);
const invoice = createInvoice({ id: 'order-7', address, amount: 250_000n, createdAt: 1000, expiresAt: 2000, requiredConfirmations: 2 }, network);

const text = JSON.stringify(invoiceToJson(invoice));
console.log(text.slice(0, 48)); // {"format":"pearljs-invoice","version":1,"id":"or
const restored = invoiceFromJson(JSON.parse(text), network);
console.log(restored.amount === invoice.amount); // true
```

`invoiceFromJson` checks every field, the address against the network, and that the totals match the payments, and it throws `INVOICE_JSON_INVALID` for anything that `invoiceToJson` did not write. To keep payments in a table of your own, `invoicePaymentToJson` and `invoicePaymentFromJson` do the same for a single payment.

The record is the whole of an invoice's state. A process that stores it after each refresh can stop at any point and carry on from the stored copy, and the result is the same as if it had never stopped.

## Refreshing many

`refreshInvoices` refreshes a list of invoices in one pass and returns, for each, what `refreshInvoice` would return:

```ts
import { refreshInvoices, type ChainClient, type Invoice } from 'pearljs';

declare const chain: ChainClient;
declare const open: Invoice[];
const refreshed = await refreshInvoices(open, chain, { concurrency: 4 });
console.log(refreshed.filter((invoice) => invoice.state === 'confirmed' || invoice.state === 'overpaid').map((invoice) => invoice.id));
```

It shares the work between invoices, so the number of calls to the chain stays small. A pass makes one read of the tip, one address search for each distinct address, and one transaction lookup for each recorded payment that its address no longer lists. At most `concurrency` of these are in flight at once, 8 unless you set it. The results follow the rules in [Invoice states and payment rules](../concepts/invoices-payment-rules.md).

## The invoice watcher

Given a `PearlWsClient`, pearld's websocket connection, the watcher loads the invoice addresses into pearld's transaction filter and refreshes an invoice as soon as a `relevanttxaccepted` notification pays it. It refreshes all of them on every new block and after a reconnect, and it wakes at each invoice's deadline. It also polls every `pollInterval`, a minute unless you set it, and without a websocket that polling is all it does. Notifications that arrive while a refresh is running are folded into one more pass. `until` decides when an invoice leaves the set; the example keeps each one for a day past its deadline so that late payments still reach the record.

`onChange` is called for one invoice at a time, in order, and the watcher waits for it to finish. If it throws, the watcher passes the error to `onError` and offers the same change again on the next refresh, so a record is never lost between the chain and your database. Add an invoice to a running watcher with `watcher.add(invoice)`. `stop()` removes the watcher's listeners, clears its timer and waits for any refresh in progress, and no `onChange` call follows it.

## Address allocation

The allocator keeps to these rules:

- It hands out a fresh index only while that index is within `gapLimit`, 250 unless you set it, of the last index it knows was paid. Past that it throws `InvoiceGapError` with code `INVOICE_GAP_LIMIT` rather than hand out an address a restore would miss. With `allowBeyondGap` it hands the address out anyway and sets `beyondGap` on the result.
- It reuses the index of an invoice that expired with nothing paid at all, late payments included, once `reuseAfter` seconds have passed since the deadline, seven days unless you set it. It reuses the index only if the address still shows no payment at that moment, and the result's `reused` says so.
- It learns what happened to each invoice from `track(index, invoice)`. Call that with every refreshed record, for example in the watcher's `onChange`.
- It keeps its state in `toJson()`. Store that after each `allocate` and `track`, and pass the stored state back as `state` when you create the allocator again.
- It remembers when it handed out each index, and an unpaid record of an invoice created before then belongs to an earlier invoice at that index and frees nothing. Give `allocate` and `createInvoice` the same time, as the [first example](../guides/invoices.md#create-an-invoice) does, because an invoice whose `createdAt` is earlier than its allocation never frees its index.

Reusing an address has a cost: a customer who pays a week-old expired invoice pays the new invoice at that address instead. The waiting period makes that rare, and `reuseAfter` sets how long it is.
