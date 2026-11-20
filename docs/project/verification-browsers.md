# Browsers

`npm run test:browser` bundles the packed package with Vite and runs it in headless browsers. Chrome runs over the DevTools protocol, Firefox over WebDriver BiDi and Safari over safaridriver. Each bundler configuration in [Browsers and bundlers](../guides/browsers-and-bundlers.md#configure-your-bundler) was also built from the packed tarball into a test page.

## Options

- `BROWSERS=chrome,firefox,firefox-private,safari` picks the browsers. Chrome runs alone by default.
- `firefox-private` runs Firefox with every window private.
- Safari runs once remote automation is on, which `safaridriver --enable` does. It asks for an administrator password.
- `npm run test:browser -- --serve` builds and serves the page and prints its URL, for a browser driven by hand. The page lists every check, and each must read `pass`.
- `PEARLD=/path/to/pearld node scripts/browser-wallet-live.mjs` runs a `PearlWallet` on the IndexedDB store in headless Chrome against a regtest pearld, through a same-origin proxy the script serves.

## Checks

The browser test runs Pearl's vectors, the IndexedDB store, a wallet kept in it and the proof verifier. For the verifier:

- Mainnet block 200's V1 certificate is accepted as mined, and rejected with one proof byte changed.
- V3 and V4 certificates are checked.
- An accepted and a tampered plain proof are checked in the V2 and V3 format, and in V4's.
- A plain proof over `maxSize` is refused before any file is fetched.
- `loadProofVerifier()` fetches the module and the V2 and V4 caches, and not `v1-cache.bin`, which the first V1 certificate fetches.
- The module's memory stays at one size over 30 verifications.

The live IndexedDB wallet script covers receive, send, reload, lock and unlock, and two tabs. It also covers a tab closed mid-send, site data cleared, a private context and other database versions.

## Bundler test pages

Each bundler's test page does all of this, and each ran in Chrome with every check passing:

- It derives an account from a mnemonic.
- It signs a P2TR payment and a P2MR XMSS spend.
- It unlocks a keystore and signs a message.
- It verifies a V3 and a V4 proof.

The `worker` builds, from esbuild with `conditions: ['worker']` and from webpack with `target: 'webworker'`, ran as an MV3 service worker, unlocking, signing and sending. The esbuild build also ran as a Firefox event page. The session flow ran in a real MV3 extension, through worker restarts and a browser restart ([Recorded runs](verification-runs.md#session-unlock-in-an-extension)).
