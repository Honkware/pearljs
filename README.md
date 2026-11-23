# pearljs

A TypeScript library for the [Pearl](https://github.com/pearl-research-labs/pearl) blockchain (PRL), for Node.js and browsers.

## Features

pearljs holds keys, builds and signs transactions, and reads the chain. It is the client side of Pearl, for wallets, pools and explorers.

- Accounts and addresses derive from a recovery phrase exactly as Oyster's do.
- The payment builder turns unspent outputs into a signed transaction pearld will relay.
- Script trees cover P2TR and P2MR, including post-quantum XMSS leaves.
- PSBTs carry a payment to cold, hardware and co-signers on either spend path.
- Typed clients reach pearld, Oyster and Blockbook over HTTP and websocket.
- An encrypted wallet stays in step with the chain through reorgs, restarts and restores.
- Blocks parse with their V1 to V4 certificates, and block templates become blocks.
- Pearl's own ZK verifier, compiled to WebAssembly, checks proofs in Node and browsers.
- A simulated chain, node and Blockbook stand in for a server in tests.

Expected values come from Pearl's own Go and Rust code, and a live suite runs against pearld. The funded tests have also run on testnet2 and on mainnet, and further checks read every mainnet block and Pearl's public servers.

pearljs is at version 0.1 and has not had an independent security audit. [Known limits](docs/project/limits.md) lists what is untested.

## Installation

```sh
npm install pearljs
```

pearljs needs Node.js 20.19+ or 22.12+ and is ESM only.

Browsers need a bundler that loads WebAssembly. See [Browsers and bundlers](docs/guides/browsers-and-bundlers.md).

## Usage

```ts
import { PearldClient, deriveSigningAccountFromSeed, generateMnemonic, mnemonicToSeed, networks } from 'pearljs';

const account = deriveSigningAccountFromSeed(mnemonicToSeed(generateMnemonic()), networks.mainnet);
console.log(account.deriveAddress(0));

const node = new PearldClient({
  url: 'https://127.0.0.1:44107',
  username: process.env.PEARLD_RPC_USER ?? '',
  password: process.env.PEARLD_RPC_PASS ?? '',
});
console.log(await node.getBlockCount());
```

[Getting started](docs/start/getting-started.md) continues from here to a sent payment.

## Documentation

- [Getting started](docs/start/getting-started.md)
- [Send a payment](docs/guides/send-a-payment.md)
- [Choosing a backend](docs/start/choosing-a-backend.md)
- [Frequently asked questions](docs/start/faq.md)
- [Troubleshooting](docs/reference/troubleshooting.md)
- [API reference](docs/reference/api.md), generated with `npm run docs`

The [documentation index](docs/README.md) lists every page, and the same docs are online at [pearljs.gitbook.io/pearljs](https://pearljs.gitbook.io/pearljs).

## Examples

The [examples](examples) directory has programs that run as they are:

```sh
npm run examples
```

They cover addresses, payments, P2MR and XMSS spends, a wallet's life and more. Four more need a running node.

## Testing

```sh
npm run check        # lint, typecheck, build, tests, examples and the code in the docs
npm run test:live    # against a real pearld and Oyster on regtest
npm run test:browser # the packed package in headless Chrome, Firefox or Safari
```

The live suite has pearld mine what pearljs builds. [Compatibility verification](docs/project/verification.md) describes every check.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Report security issues privately, as [SECURITY.md](SECURITY.md) describes.

## License

MIT. See [NOTICE](NOTICE) for upstream licenses.
