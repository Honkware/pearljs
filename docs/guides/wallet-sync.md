# Keep a wallet in sync

A wallet that runs for a long time, such as the one behind a shop's checkout, has to see payments as they arrive and confirmations as blocks are mined. The wallet comes from [Create a wallet and receive](wallet-create.md), where it reads the chain through a `PearlWsClient` connected to pearld.

## Watch the chain

`sync()` brings the wallet up to the chain once. `watch()` keeps it there: it runs a full sync on a timer, and when given a notifier it also refreshes on every new block and takes in each payment to the wallet's addresses as pearld reports it.

<!-- check-docs: declare const wallet: import('pearljs').PearlWallet; declare const node: import('pearljs').PearlWsClient; -->
```ts fragment
wallet.on('error', (error) => console.error('wallet sync:', error.message));
const stop = wallet.watch({ notifier: node, pollInterval: 300_000 });

// When the application shuts down:
stop();
```

Syncs that run in the background report their failures as `error` events, so add the listener before calling `watch`. `pollInterval` is the time between full syncs in milliseconds, 60 seconds if left out. With a notifier, the timer only catches what the notifications missed, so it can be as long as the five minutes above. When the websocket reconnects after a drop, the wallet asks for its addresses' notifications again and syncs straight away, which picks up whatever happened while the connection was down. `watch` returns a function that stops it, and `wallet.close()` stops it too.

The events from [Create a wallet and receive](wallet-create.md#receive-the-payment), such as `transaction`, `confirmation` and `balance`, fire from these syncs in the same way as from one you call yourself. [Sync steps](../concepts/wallet.md#sync-steps) describes what a sync does, and [Sync cost](../concepts/wallet.md#sync-cost) how many questions it asks the backend.

## Count confirmations between syncs

When a notifier reports a block holding one of the wallet's transactions, the transaction counts as confirmed at once, without waiting for the next sync. Confirmations are counted from the highest block the wallet has been told of, so the balance is already right when the `confirmation` event fires. `wallet.tip` moves more carefully, only once a sync or a refresh has checked the new tip.

## Follow progress

The first sync of a large wallet can ask about thousands of addresses. The `sync` event reports how far a sync has got while it is still asking the backend, which suits a progress bar:

<!-- check-docs: declare const wallet: import('pearljs').PearlWallet; -->
```ts fragment
wallet.on('sync', ({ phase, addresses, transactions }) => {
  console.log(phase, addresses, 'addresses', transactions, 'transactions');
});
await wallet.sync();
```

`phase` moves from `scanning`, while the wallet asks about addresses, through `fetching`, while it takes in transactions, and `settling`, while it checks spends and pending transactions, to `done` once the result has been applied. `addresses` and `transactions` count what the sync has looked at so far.

## Stop a sync

`sync` and `refresh` take an `AbortSignal`, so a sync that takes too long can be stopped:

<!-- check-docs: declare const wallet: import('pearljs').PearlWallet; -->
```ts fragment
const signal = AbortSignal.timeout(30_000);
try {
  await wallet.sync({ signal });
} catch (err) {
  if (!signal.aborted) throw err;
  console.log('sync stopped after 30 seconds; the wallet is as it was');
}
```

A sync stopped while it is still asking the backend rejects with the signal's reason and leaves the wallet exactly as it was before, because a sync changes the wallet only at its very end, in one write.

## Refresh and rescan

`refresh()` is a lighter sync. It checks the tip and settles pending transactions, which are steps 1 and 5 of a sync, without asking about any addresses, and `watch` runs one on each new block. `sync({ full: true })` goes the other way and asks about every address as far as the gap limit, as the first sync after opening does.

`rescan()` forgets every recorded transaction and scans the chain again from scratch. It rebuilds a history that has gone wrong, for instance after someone edited the store, and keeps the wallet's addresses, labels, locks and XMSS state.
