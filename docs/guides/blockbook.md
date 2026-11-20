# Run a wallet over a Blockbook

A wallet that runs no node of its own can read the chain through a Blockbook server instead, using `blockbookBackend` from `pearljs/backend-blockbook`.

`PearlWallet`, `discoverAccount`, invoices and sweeps all run over a Blockbook as they do over pearld. The server is a third party, so the backend checks its answers against the transactions and blocks themselves, and [Blockbook trust](../concepts/blockbook-trust.md) sets out what those checks catch and what they leave to the server. To use the Blockbook client on its own, see [Use the Blockbook client](blockbook-client.md), and to run the same code in a test with no server, see [Simulated Blockbook](../reference/blockbook-api.md#simulated-blockbook).

## Open the wallet

Create a `BlockbookClient` for the server and network, wrap it in a backend, and give the backend to the wallet:

```ts fragment
import { BlockbookClient, PearlWallet, blockbookBackend, createMemoryStore, networks } from 'pearljs';

const client = new BlockbookClient({ url: 'https://blockbook.pearlresearch.ai', network: networks.mainnet });
const backend = blockbookBackend(client);
const wallet = await PearlWallet.open({ store: createMemoryStore(), backend });
await wallet.sync();
```

The backend is both a `WalletChain` and an `ActivityScanner`, so the one object serves as the wallet's `backend` and as its source of transactions, for `discoverAccount` and for the invoice monitor alike.

## Check the server against others

`crossCheck` holds the server to other Blockbooks, ideally ones that other people run:

```ts run
import { BlockbookClient, blockbookBackend, networks } from 'pearljs';

const network = networks.mainnet;
const backend = blockbookBackend(new BlockbookClient({ url: 'https://blockbook.example', network }), {
  crossCheck: [new BlockbookClient({ url: 'https://another-blockbook.example', network })],
});
```

Each cross-check server must be on a host different from the main server's and from each other's, because a server checked against itself checks nothing. A client for the same host is rejected with a `TypeError`. [Cross-checking](../concepts/blockbook-trust.md#cross-checking) lists what the servers must agree on.

Without `crossCheck`, the backend is as honest as the server and everything on the network path to it. For anything that decides whether you were paid, run a pearld of your own ([Choosing a backend](../start/choosing-a-backend.md)).

## Ask by account key

By default the backend asks the server about each address separately, which for a new wallet's first sync means hundreds of requests. `PearlWallet` and `discoverAccount` tell the backend which of the addresses they ask about belong to a BIP86 account, by passing the account's extended public key and each address's chain and index (`AccountAddresses`, given to `findUsed` and `getActivitySince`). With `useXpub: true`, the backend uses that to ask Blockbook's xpub query once per account instead of once per address:

```ts run
import { BlockbookClient, blockbookBackend, networks } from 'pearljs';

const backend = blockbookBackend(new BlockbookClient({ url: 'https://blockbook.pearlresearch.ai', network: networks.mainnet }), { useXpub: true });
```

The server's reply is only a hint about which indices are used ([Account-key hints](../concepts/blockbook-trust.md#account-key-hints)). Some addresses can't be derived from an account key, so the backend still asks about them one by one: P2MR and XMSS addresses, imported keys, and watch-only accounts given to `discoverAccount` without an extended public key.

### Privacy

`useXpub` is off by default because of what the account key reveals. An extended public key gives whoever holds it every address of the account, past and future. Anyone who also learns the private key of one of the account's children can work out the private keys of all the others. Sending the key to a server shares all of that with the server's operator, and with everyone the operator shares logs with, for good: the key can't be taken back, and payments to addresses the wallet hasn't used yet are tied to it the moment they happen.

Per-address queries tell the server which addresses a sync asks about and, from their timing, that they belong together. They reveal nothing about addresses past the scan and nothing about keys. Turn `useXpub` on for a server you run yourself or trust with the account's whole history, or when a first sync of hundreds of requests is the bigger problem.
