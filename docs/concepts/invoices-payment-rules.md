# Invoice states and payment rules

An invoice in pearljs asks for an amount at one address before a deadline, and its state says how far that request has got. Each refresh computes the state afresh from the stored record, the chain and the clock, and the payment rules decide which payments count. The tasks are in [Accept payment with an invoice](../guides/invoices.md) and [Persist and watch many invoices](../guides/invoices-many.md).

## States

An invoice is always in one of these nine states:

| State | Meaning |
| --- | --- |
| `awaiting` | Before the deadline, with nothing paid that counts |
| `underpaid` | Before the deadline, with some paid but less than the amount |
| `pending` | Paid in full, and a payment that counts is still unconfirmed |
| `confirming` | Paid in full, with 1 to `requiredConfirmations` - 1 confirmations |
| `confirmed` | Paid exactly the amount, with at least `requiredConfirmations` |
| `overpaid` | Paid more than the amount, with at least `requiredConfirmations` |
| `expired` | Past the deadline, with nothing paid that counts |
| `expired-underpaid` | Past the deadline, with some paid that counts but less than the amount |
| `conflicted` | A payment that counted has disappeared from the chain, because it was double spent or dropped. This state wins over every other |

`confirmed` and `overpaid` both mean the invoice is paid in full, so ship on either. A `conflicted` invoice needs a person to look at it.

An invoice's `confirmations` is that of its least confirmed payment that counts. Every refresh works it out again from the current tip, so a reorganization, where the chain switches to a different branch of recent blocks, can take an invoice from `confirmed` back to `confirming` or `pending`. With a low `requiredConfirmations`, treat `confirmed` as likely rather than final.

## Payment timing

A payment counts toward an invoice when there is evidence that it existed before the deadline, `expiresAt`. Either of two things is enough:

- It is in a block whose header time is before `expiresAt`.
- It was first seen before `expiresAt`, either by this invoice or by the backend, when the backend reports when it first saw a transaction.

The first rule keeps an on-time payment on time even when nobody was watching. If the monitor is down from before the deadline until after it, a payment mined in the meantime still counts, because its block records when it was mined. The second rule covers a payment that was broadcast in time but mined after the deadline, where the customer paid on time and the block came late.

Both times are kept with the payment, as `firstSeenAt` and `firstBlockTime`, and they only ever move earlier. A reorganization that moves an on-time payment into a later block, or back into the mempool, therefore leaves it on time. A payment that disappears altogether makes the invoice `conflicted`.

## Header times

The time used for a block is the one in its header, which a chain view reports with each block at no extra cost. The median time of recent blocks would take more calls, and it lags the clock by design.

The miner sets a block's header time, and consensus bounds it only loosely, so it can differ from the wall clock by an hour or more either way. That is close enough for a deadline that protects a quoted price. When a deadline matters to the minute, judge the cases near the edge by hand, or allow a grace period by setting `expiresAt` later than the time you show the customer.

`pearldChainClient`, `pearldBackend` and `oysterBackend` all report header times. A chain view of your own should set `time` on each `BlockRef`, and it may set `seenAt` on each payment. Without `time`, a confirmed payment is judged only by when it was first seen, so a monitor that was down across the deadline counts it as late.

## Underpayment, overpayment and late payment

Every payment stays on the record. `invoice.payments` lists every transaction that paid the address, whether it counted or not, and the invoice's totals show how it compares with the amount:

```ts
import type { Invoice } from 'pearljs';

declare const invoice: Invoice;
for (const payment of invoice.payments) {
  console.log(payment.txid, payment.amount, payment.status, payment.block?.height ?? 'mempool', payment.counted ? 'counted' : 'late');
}
const shortBy = invoice.amount > invoice.paidAmount ? invoice.amount - invoice.paidAmount : 0n;
const overBy = invoice.paidAmount > invoice.amount ? invoice.paidAmount - invoice.amount : 0n;
console.log({ shortBy, overBy, late: invoice.uncountedAmount });
```

`paidAmount` is the sum of the payments that count, and how it compares with `amount` decides what to do:

- Below `amount`, the invoice is `underpaid`, and after the deadline `expired-underpaid`. Ask the customer for the rest at the same address before the deadline, or refund what was paid.
- Above `amount`, the invoice settles as `overpaid`, and the difference belongs to the customer.
- A late payment has `counted: false` and adds to `uncountedAmount`. It arrives on the record for as long as you keep refreshing, so keep refreshing expired invoices for a while, a day for example, and refund what turns up ([Refund](../guides/invoices.md#refund)).

## Payment status

Each payment also has a `status`, which says where the chain view last saw it. Only the first two count toward the invoice:

| Status | Meaning |
| --- | --- |
| `unconfirmed` | In the mempool |
| `confirmed` | In a block |
| `unlisted` | The address no longer lists it but the node still knows the transaction, as can happen when an index trails a reorganization |
| `vanished` | The node no longer knows it |

## Chain answers

The state is only as good as the chain view's answers. `refreshInvoice` throws `BACKEND_RESPONSE` rather than compute a state from an answer that is malformed in any of these ways:

- a tip or block without an integer height;
- a block time or `seenAt` that is not a whole number of epoch seconds;
- a payment whose amount is not a bigint from 0 to `MAX_GRAIN`;
- two different entries for one txid.

A well-formed answer can still be wrong. A backend that hides a payment keeps an invoice `awaiting`, and one that invents a payment makes it `confirmed`, so point the monitor at a node you run.

Each invoice also needs an address of its own ([Allocate addresses](../guides/invoices-many.md#allocate-addresses)), because two invoices that share an address each count the other's payments.

## The pearld adapter

`pearldChainClient` reads an address's payments from pearld. It pages through the address's confirmed transactions, with a page size set by its `pageSize` option, from 1 to 10000. It reads the address's mempool transactions in a single request of up to 10000, because pearld does not keep those in a stable order between calls. Header times come with each transaction, so they cost no extra call.

The adapter stops with an error, rather than looping, when the server ignores `skip` or after 10000 pages. It reports a transaction as gone only when pearld says it does not know it. A pearld running without `--txindex` gives the same answer, code -5, for every confirmed transaction, so the adapter passes that on as the error it is and does not read it as a vanished payment.

Two pieces of the adapter are exported on their own: `searchAllTransactions(client, address)` does the paging, and `paidTo(tx, address)` sums what a decoded transaction pays an address.
