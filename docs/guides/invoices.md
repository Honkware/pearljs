# Accept payment with an invoice

A shop or a service that takes payment for an order can ask for it with an invoice: an amount, paid to an address of its own, before a deadline. pearljs follows the invoice through a watch-only view of the chain, so the server that runs it holds no keys.

## Prerequisites

- A pearld node started with `--addrindex` and `--txindex`, because the invoice monitor finds an address's payments with pearld's `searchrawtransactions`. [Node and wallet RPC](rpc.md) covers the connection and its certificate.
- The extended public key (xpub) of an account kept for invoices. The server needs only this key, so keep the recovery phrase somewhere else ([Keys, mnemonics and accounts](keys-and-accounts.md)).

## Connect to the node

`pearldChainClient` gives the monitor its view of the chain, read through a `PearldClient` or a `PearlWsClient`. `InvoiceMonitor` creates and refreshes invoices on one network, and `importWatchOnlyAccount` turns the extended public key into an account that can derive addresses but not sign:

```ts
import { readFileSync } from 'node:fs';
import { pearldFetch } from 'pearljs/tls-fetch';
import { InvoiceIndexAllocator, InvoiceMonitor, PEARLD_RPC_PORTS, PearldClient, importWatchOnlyAccount, networks, parsePearl, pearldChainClient } from 'pearljs';

const network = networks.mainnet;
const node = new PearldClient({
  url: `https://127.0.0.1:${PEARLD_RPC_PORTS.mainnet}`,
  username: process.env.PEARLD_RPC_USER ?? '',
  password: process.env.PEARLD_RPC_PASS ?? '',
  fetch: pearldFetch({ ca: readFileSync('/path/to/pearld/rpc.cert', 'utf8') }),
  retry: true,
});
const chain = pearldChainClient(node);
const monitor = new InvoiceMonitor(chain, network);
const account = importWatchOnlyAccount(process.env.PEARL_XPUB ?? '', network);
```

A [wallet backend](wallet-backends.md) is also a view of the chain, so `pearldBackend(node, { network })` or `oysterBackend` can take the place of `pearldChainClient` here.

## Create an invoice

Give each invoice an address of its own. Take its index in the account from an `InvoiceIndexAllocator` rather than from an order number, because a wallet restored from the phrase finds payments only within 250 addresses of the last paid one, and the allocator keeps every address inside that range ([Allocate addresses](invoices-many.md#allocate-addresses)). Then create the invoice with the amount in grain, the deadline in epoch seconds and the number of confirmations you want before you ship:

```ts continues
const indices = new InvoiceIndexAllocator({ deriveAddress: (index) => account.deriveAddress(index), client: chain });

const now = Math.floor(Date.now() / 1000);
const { index, address } = await indices.allocate(now);
let invoice = monitor.createInvoice({
  id: 'order-1042',
  address,
  amount: parsePearl('12.5'),
  createdAt: now,
  expiresAt: now + 3600,
  requiredConfirmations: 3,
});
console.log(`pay ${invoice.amount} grain to ${invoice.address}`);
```

The invoice is a plain record that you store, and each refresh returns a new record computed from the stored one, the chain and the clock. `createInvoice` throws `INVOICE_INVALID` when a field is out of range:

| Field | Must be |
| --- | --- |
| `address` | A Pearl address on the monitor's network |
| `amount` | A positive bigint, at most `MAX_GRAIN` |
| `expiresAt` | Later than `createdAt` |
| `requiredConfirmations` | A positive integer |
| `refundAddress` | When given, an address on the network |

## Refresh it

Refresh the invoice whenever you want to know where it stands, store the record that comes back, and hand it to the allocator so it learns which addresses were paid:

```ts continues
invoice = await monitor.refreshInvoice(invoice);
indices.track(index, invoice);
console.log(invoice.state, invoice.paidAmount, invoice.confirmations);
```

`invoice.state` is one of the [invoice states](../concepts/invoices-payment-rules.md#states), `paidAmount` is how much has been paid toward it, and `confirmations` is how deeply the payment is confirmed. `confirmed` and `overpaid` both mean the invoice is paid in full, so ship on either. Every refresh recomputes `confirmations` from the current tip, so a reorganization can take an invoice from `confirmed` back to `confirming` or `pending`. The invoice keeps every payment the address receives, including late ones, and [Invoice states and payment rules](../concepts/invoices-payment-rules.md) explains which of them count.

To follow many invoices at once, and to keep them current as blocks arrive, see [Persist and watch many invoices](invoices-many.md).

## Refund

A Pearl transaction carries no sender address, so a refund goes to an address the customer gives you. Checkout is the time to ask for one, and the invoice's `refundAddress` field is the place to keep it.

When you have no refund address, the addresses a payment spent from are a hint. `fetchPayerInputs` lists each input of a payment with the address and value it spent:

```ts
import { fetchPayerInputs, networks, pearldTransactionSource, type Invoice, type PearldClient } from 'pearljs';

declare const node: PearldClient;
declare const invoice: Invoice;
const source = pearldTransactionSource(node);
for (const payment of invoice.payments) {
  const inputs = await fetchPayerInputs(payment.txid, source, networks.mainnet);
  console.log(payment.txid, inputs.map((input) => `${input.address ?? 'no address'}: ${input.amount}`));
}
```

Treat an input address with care, because it may not belong to the payer. An exchange or a hosted wallet pays from addresses its customer does not control, and money sent back there may be lost or credited to someone else. Refund to an input address only when you know the payer holds its key, and otherwise ask the customer for an address.

`payerInputs(tx, prevouts, network)` does the same for a transaction and spent outputs you already have. A coinbase has no inputs to list. pearld returns confirmed transactions only when it runs with `--txindex`, and `fetchPayerInputs` throws `INVOICE_PAYER_UNKNOWN` when the source does not know the payment or a transaction it spends.

## Take invoices into a PearlWallet

A shop that keeps a `PearlWallet` can give its invoices an account of their own in that wallet. The allocator hands out the account's receive addresses and the monitor follows them, while the wallet, which scans every account it holds, counts what they were paid and can spend it. A wallet's backend is also a view of the chain, so one object serves all three:

```ts run
import { InvoiceIndexAllocator, InvoiceMonitor, PearlWallet, createMemoryStore, importWatchOnlyAccount } from 'pearljs';
import { SimulatedChain } from 'pearljs/testing';

// A simulated chain here; against a node, the object connectPearld returns.
const chain = new SimulatedChain();
const wallet = await PearlWallet.create({ store: createMemoryStore(), backend: chain, passphrase: 'a long passphrase', kdf: { N: 2 ** 12 } }); // a low scrypt cost, for the example only
const invoicesAccount = await wallet.addAccount(1, { label: 'invoices' });
wallet.lock();

const keys = importWatchOnlyAccount(invoicesAccount.xpub, chain.network);
const indices = new InvoiceIndexAllocator({ deriveAddress: (index) => keys.deriveAddress(index), client: chain });
const monitor = new InvoiceMonitor(chain, chain.network);

const now = chain.time;
const { index, address } = await indices.allocate(now);
let invoice = monitor.createInvoice({ id: 'order-7', address, amount: 400_000n, createdAt: now, expiresAt: now + 3600, requiredConfirmations: 1 });

chain.pay(address, 400_000n);
chain.mine();
invoice = await monitor.refreshInvoice(invoice, now + 600);
indices.track(index, invoice);
await wallet.sync();
console.log(invoice.state, wallet.balance({ account: invoicesAccount.id }).confirmed); // confirmed 400000n
```

The wallet has to be unlocked once to derive the account, and after that only the account's extended public key is used. Leave `wallet.receiveAddress({ account })` uncalled for this account, because the allocator is what hands out its addresses.

## Try it without a node

The monitor needs only a `ChainClient`, an interface with three methods, so a test can drive it with a chain it controls. In this example the monitor is down across the deadline while a payment is mined in time, and then it sees a late payment:

```ts run
import { InvoiceMonitor, encodeAddress, networks, type AddressPayment, type BlockRef, type ChainClient } from 'pearljs';

const network = networks.regtest;
let tip: BlockRef = { height: 100, hash: 'block-100', time: 1000 };
const payments: AddressPayment[] = [];
const chain: ChainClient = {
  getTip: async () => tip,
  getAddressActivity: async () => payments,
  getTransaction: async (txid) => payments.find((payment) => payment.txid === txid) ?? null,
};

const monitor = new InvoiceMonitor(chain, network);
const address = encodeAddress({ version: 1, program: new Uint8Array(32).fill(7) }, network);
let invoice = monitor.createInvoice({ id: 'demo', address, amount: 300_000n, createdAt: 1000, expiresAt: 2000, requiredConfirmations: 2 });
const refresh = async (now: number) => {
  invoice = await monitor.refreshInvoice(invoice, now);
  console.log(invoice.state, invoice.paidAmount, invoice.uncountedAmount, invoice.confirmations);
};

await refresh(1100); // awaiting 0n 0n 0
payments.push({ txid: 'aa'.repeat(32), amount: 100_000n, block: null });
await refresh(1200); // underpaid 100000n 0n 0
tip = { height: 101, hash: 'block-101', time: 1900 };
payments[0] = { ...payments[0]!, block: tip };
payments.push({ txid: 'bb'.repeat(32), amount: 250_000n, block: tip });
tip = { height: 102, hash: 'block-102', time: 2400 };
await refresh(3000); // overpaid 350000n 0n 2
payments.push({ txid: 'cc'.repeat(32), amount: 50_000n, block: null });
await refresh(3100); // overpaid 350000n 50000n 2
```

The monitor first saw the second payment at 3000, after the deadline, and it still counts because the block that holds it has the time 1900. `refreshInvoice` takes the current time as its last argument, in epoch seconds, and reads the clock when it is left out.

For a longer run, `examples/invoice-demo.ts` simulates an underpayment, a reorganization, a late payment and a double spend, and `npm run demo` prints it.
