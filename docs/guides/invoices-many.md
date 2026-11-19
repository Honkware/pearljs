# Persist and watch many invoices

Once a shop has more than a few open invoices, it needs to store them, keep them current as blocks arrive and hand out addresses that a wallet restore will still find. These tasks follow on from [Accept payment with an invoice](invoices.md).

## Store and watch invoices

An invoice record is the whole of its state. `invoiceToJson` turns it into plain JSON and `invoiceFromJson` reads it back, so a process that stores the record after each refresh can stop at any point and carry on from the stored copy, and the result is the same as if it had never stopped ([Storing invoices](../reference/invoices-many-options.md#storing-invoices)).

To keep a set of invoices current without polling them yourself, use `watchInvoices`. It refreshes an invoice whenever something may have changed and calls `onChange` with the new record and the previous one:

```ts
import { PearlWsClient, networks, pearldChainClient, watchInvoices, type Invoice } from 'pearljs';

declare function loadOpenInvoices(): Promise<Invoice[]>;
declare function save(invoice: Invoice): Promise<void>;

const ws = new PearlWsClient({ url: 'wss://127.0.0.1:44107/ws', username: 'user', password: 'pass' });
const watcher = watchInvoices({
  client: pearldChainClient(ws),
  network: networks.mainnet,
  ws,
  invoices: await loadOpenInvoices(),
  onChange: async (invoice, previous) => {
    await save(invoice);
    if (invoice.state !== previous.state) console.log(invoice.id, previous.state, 'to', invoice.state);
  },
  onError: (error) => console.error('invoice watch:', error.message),
  // Late payments still reach the record for a day after expiry.
  until: (invoice) => Math.floor(Date.now() / 1000) > invoice.expiresAt + 86_400,
});

// New invoices join with watcher.add(invoice); watcher.stop() ends it cleanly.
process.once('SIGTERM', () => void watcher.stop().then(() => ws.close()));
```

`onChange` is called for one invoice at a time, and if it throws, the watcher passes the error to `onError` and offers the same change again on the next refresh. `until` decides when an invoice leaves the set. [The invoice watcher](../reference/invoices-many-options.md#the-invoice-watcher) has when it refreshes, and `refreshInvoices` refreshes a list in one pass when you poll yourself ([Refreshing many](../reference/invoices-many-options.md#refreshing-many)).

## Allocate addresses

A wallet restored from the account's recovery phrase scans each chain of addresses until it finds 250 in a row with no payment, as Oyster does. An invoice address handed out after 250 unpaid ones lies beyond that scan, so its payment does not show up in the restored wallet. Abandoned checkouts make this common: derive addresses from order numbers or a plain counter, and a quiet week is enough to cause it.

`InvoiceIndexAllocator` hands out address indices so that every payment stays within reach of a restore. Start it after the indices the account has already used, and store its state after each call:

```ts
import { InvoiceGapError, InvoiceIndexAllocator, discoverAccount, importWatchOnlyAccount, networks, pearldBackend, type PearldClient } from 'pearljs';

declare const node: PearldClient;
const network = networks.mainnet;
const account = importWatchOnlyAccount(process.env.PEARL_XPUB ?? '', network);
const backend = pearldBackend(node, { network });

// A fresh allocator starts after what the account has already used.
const found = await discoverAccount(account, backend);
const indices = new InvoiceIndexAllocator({
  deriveAddress: (index) => account.deriveAddress(index),
  client: backend,
  startAt: found.receive.nextIndex,
});
try {
  const { index, address, reused } = await indices.allocate();
  console.log(index, address, reused);
} catch (err) {
  if (!(err instanceof InvoiceGapError)) throw err;
  console.log('250 unpaid invoices are outstanding; an index comes back reuseAfter seconds after the next expiry');
}
console.log(JSON.stringify(indices.toJson()));
```

`allocate` throws `InvoiceGapError` rather than hand out an address that lies more than `gapLimit`, 250 unless you set it, past the last paid index. Pass every refreshed record to `track(index, invoice)`, for example in the watcher's `onChange`, and store `toJson()` after each `allocate` and `track`. [Address allocation](../reference/invoices-many-options.md#address-allocation) has every rule the allocator follows, including when it reuses an index.

Keep the account, or at least its receive chain, for invoices alone, since the allocator assumes nothing else hands out its indices.
