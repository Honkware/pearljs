# Build a browser extension

A wallet built as a Manifest V3 browser extension keeps its keys in the extension rather than in a web page. pearljs runs in the extension's service worker, its popup and its other pages, and the content script needs no part of it: a content script that relays a page's request to the worker with `chrome.runtime.sendMessage` is enough. [Keys in a page](../concepts/browsers-and-bundlers-keys.md) applies to every part of the extension that holds keys.

pearljs fits inside a service worker, and [Extensions](../reference/browsers-and-bundlers-modules.md#extensions) lists the browser APIs it uses.

## Allow WebAssembly

Extension pages and the worker run WebAssembly only when the extension's content security policy includes `'wasm-unsafe-eval'`. Add it in `manifest.json`:

```json
{
  "background": { "service_worker": "background.js", "type": "module" },
  "content_security_policy": { "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'" }
}
```

## Build with the worker condition

A service worker allows neither top-level await nor `import()`, and a bundler turns tiny-secp256k1's WebAssembly import into a top-level await. pearljs therefore ships a second build of that module for workers, which the `worker` resolution condition selects ([The worker condition](../reference/browsers-and-bundlers-modules.md#the-worker-condition)). With esbuild, set the condition, and no WebAssembly plugin is needed:

```js
// esbuild: no WebAssembly plugin needed
await build({ entryPoints: ['src/background.js'], bundle: true, format: 'esm', conditions: ['worker'], outdir: 'dist' });
```

webpack sets the `worker` condition itself for `target: 'webworker'`, so a worker built that way needs nothing more. If the worker verifies proofs, copy the verifier's files beside its bundle ([Serve the verifier's files](browsers-and-bundlers.md#serve-the-verifiers-files)).

## Keep the worker alive while waiting

Chrome stops an idle worker 30 seconds after its last event, and everything the worker held goes with it, so an unlocked keystore or wallet starts out locked again in the next worker.

Websocket messages count as activity. A worker holding a `BlockbookWsClient`, which pings every 20 seconds, stays up, and so does one holding a `PearlWsClient` with `keepAlive` set ([Receive websocket notifications](websocket.md)). A socket on which nothing arrives does not keep the worker alive.

A worker kept running this way costs battery for as long as it runs, so keep it up only while the extension is waiting for something. Keep what must outlive the worker in `chrome.storage.session`, which lives in memory until the browser exits, and unlock again when a new worker starts, as the next section shows.

## Unlock a new worker from a session

`PearlWallet.unlock` takes the passphrase and runs scrypt, which takes most of a second in a worker at the default N = 2^18. Rather than keep the passphrase to run it again in every new worker, unlock once with `allowSessionExport`, store the session that `exportSession` returns, and let each new worker unlock from it, which skips scrypt and takes about 1 ms in the worker:

<!-- check-docs: declare const backend: Parameters<typeof PearlWallet.open>[0]['backend']; declare const chrome: any; -->
```ts fragment
import { PearlWallet, openIndexedDbStore } from 'pearljs';

const toHex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (text: string) => Uint8Array.from(text.match(/../g) ?? [], (b) => parseInt(b, 16));

async function openWallet() {
  return PearlWallet.open({ store: await openIndexedDbStore('wallet'), backend });
}

// When the user types the passphrase.
async function unlock(wallet: PearlWallet, passphrase: string) {
  await wallet.unlock(passphrase, { allowSessionExport: true });
  const session = await wallet.exportSession({ keyFormat: 'bytes' });
  await chrome.storage.session.set({ session: { ...session, key: toHex(session.key) } });
  session.key.fill(0);
}

// When a new worker gets a request and the wallet is locked.
async function resume(wallet: PearlWallet) {
  const { session } = await chrome.storage.session.get('session');
  if (session === undefined) return false;
  try {
    await wallet.unlockWithSession({ ...session, key: fromHex(session.key) });
    return true;
  } catch (error) {
    // KEYSTORE_SESSION_STALE after a passphrase change, KEYSTORE_SESSION_INVALID for a damaged one.
    await chrome.storage.session.remove('session');
    return false;
  }
}

// When the user locks the wallet.
async function lock(wallet: PearlWallet) {
  wallet.lock();
  await chrome.storage.session.remove('session');
}
```

`chrome.storage.session` keeps only JSON, so the example asks for the session key as bytes, stores it as hex and overwrites the bytes afterwards. That storage forgets everything when the browser exits.

The alternative is IndexedDB. `exportSession()` without `keyFormat` gives the session key as a non-extractable `CryptoKey`, which IndexedDB stores as it is (`objectStore.put(session, 'session')`) and whose bytes no script can read. A session kept there survives the browser exiting, and the browser writes the key to disk in the profile. [Sessions](../concepts/security.md#sessions) compares what each choice exposes and to whom.

In both cases the session opens the wallet until its passphrase changes, so delete the stored session when the user locks, as `lock` does above. `changePassphrase` still asks for the old passphrase, and after it every earlier session fails with `KEYSTORE_SESSION_STALE`.
