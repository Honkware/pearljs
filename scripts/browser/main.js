// Runs in each browser against Pearl's vectors; scripts/browser-smoke.mjs reads the result.
import * as p from 'pearljs';
import { SimulatedChain, testAddress } from 'pearljs/testing';
import { verifyProof } from 'pearljs/verify-proof';
import v from 'pearl-vectors';
import proofs from 'pearl-proof-vectors';

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (text) => Uint8Array.from(text.match(/../g) ?? [], (b) => parseInt(b, 16));
const results = {};
const check = (name, fn) => {
  try {
    results[name] = fn() === true ? 'pass' : 'FAIL';
  } catch (error) {
    results[name] = `ERROR ${error.message}`;
  }
};

const account = p.deriveSigningAccountFromSeed(unhex(v.bip86.seed), p.networks.mainnet);
check('bip86 address', () => account.deriveAddress(0) === v.bip86.children[0].address);
check('message sign and verify', () => {
  const signature = account.signMessage('browser', { index: 0 });
  return p.verifyMessage(account.deriveAddress(0), signature, 'browser', p.networks.mainnet);
});
check('message from Oyster verifies', () => {
  const m = v.messages[1];
  return p.verifyMessage(m.address, m.signature, m.message, p.networks.mainnet) === true;
});
check('xmss keygen matches Pearl', () => {
  const key = v.xmss.keys[1];
  return hex(p.xmssKeygen(unhex(key.privateSeed), unhex(key.publicSeed)).publicKey) === key.publicKey;
});
check('xmss verify', () => {
  const sig = v.xmss.signatures[0];
  const key = v.xmss.keys.find((k) => k.name === sig.key);
  return p.xmssVerify(unhex(key.publicKey), unhex(sig.message), unhex(sig.signature));
});
check('genesis block hash', () => {
  const block = v.blocks[0];
  return p.blockHashHex(p.parseBlock(unhex(block.hex)).header) === block.hash;
});
check('script asm', () => {
  const d = v.scriptToolkit.disasm.find((item) => item.name === 'multi-a');
  return p.scriptToAsm(unhex(d.script)) === d.disasm;
});
check('wif decode', () => {
  const w = v.wif[0];
  return hex(p.decodeWif(w.wif, p.networks.mainnet).privateKey) === w.privateKey;
});
check('p2mr tapscript sighash', () => {
  const s = v.scriptPathSpends.find((item) => item.name === 'p2mr-1-leaf-default');
  const tx = p.parseTransaction(s.unsignedTxHex);
  const prevouts = s.prevouts.map((o) => ({ script: unhex(o.script), value: BigInt(o.value) }));
  return hex(p.tapscriptSighash(tx, 0, { prevouts, leafHash: unhex(s.leafHash), sighashType: s.hashType })) === s.sighash;
});
check('hash256', () => hex(p.hash256(new Uint8Array(0))) === '5df6e0e2761359d30a8275058e299fcc0381534545f55cf43e41983f5d4c9456');

check('no Buffer global', () => typeof globalThis.Buffer === 'undefined');
check('mnemonic seed matches Pearl', () => {
  const abandon = `${'abandon '.repeat(11)}about`;
  return hex(p.mnemonicToSeed(abandon.toUpperCase())) === v.bip86.seed;
});
check('mnemonic generate and parse', () => {
  const m = p.generateMnemonic(24);
  const r = p.parseSeedInput(m);
  return p.validateMnemonic(m) && r.kind === 'mnemonic' && r.seed.length === 64;
});
check('hex seed input', () => p.parseSeedInput('ab'.repeat(32)).kind === 'hex');

const checkAsync = async (name, fn) => {
  try {
    results[name] = (await fn()) === true ? 'pass' : 'FAIL';
  } catch (error) {
    results[name] = `ERROR ${error.message}`;
  }
};
const fresh = (label) => `pearljs-smoke-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
await checkAsync('indexeddb store keeps data, holds the tab lock and compares', async () => {
  const name = fresh('store');
  const store = await p.openIndexedDbStore(name);
  await store.set('xmss:k', { next: 1 });
  const second = await p.openIndexedDbStore(name).then(
    () => 'opened',
    (error) => error.code,
  );
  const stale = await store.compareAndSet([{ key: 'xmss:k', value: { next: 0 } }], [{ type: 'set', key: 'xmss:k', value: { next: 9 } }]);
  const won = await store.compareAndSet([{ key: 'xmss:k', value: { next: 1 } }], [{ type: 'set', key: 'xmss:k', value: { next: 2 } }]);
  await store.close();
  const again = await p.openIndexedDbStore(name);
  const kept = await again.get('xmss:k');
  await again.close();
  globalThis.indexedDB.deleteDatabase(name);
  return second === (globalThis.navigator.locks ? 'STORE_LOCKED' : 'opened') && !stale && won && kept.next === 2;
});
await checkAsync('wallet on indexeddb survives a reopen', async () => {
  const name = fresh('wallet');
  const chain = new SimulatedChain();
  const store = await p.openIndexedDbStore(name);
  const wallet = await p.PearlWallet.create({ store, backend: chain, passphrase: 'smoke', kdf: { N: 1024 } });
  chain.pay(await wallet.receiveAddress(), p.parsePearl('3'));
  chain.mine();
  await wallet.sync();
  const sent = await wallet.send({ recipients: [{ address: testAddress(1), amount: p.parsePearl('1') }] });
  const before = wallet.balance().total;
  // close also closes the store and releases its tab lock.
  await wallet.close();
  const reopenedStore = await p.openIndexedDbStore(name);
  const reopened = await p.PearlWallet.open({ store: reopenedStore, backend: chain });
  const ok = reopened.locked && reopened.balance().total === before && reopened.transaction(sent.txid) !== null;
  await reopened.close();
  globalThis.indexedDB.deleteDatabase(name);
  return ok;
});
await checkAsync('keystore under WebCrypto', async () => {
  const keystore = await p.createKeystore('pass', { kdf: { N: 1024 } });
  await keystore.addSecret('seed', 'seed', new Uint8Array(32).fill(7));
  const reopened = p.openKeystore(keystore.toJSON());
  await reopened.unlock('pass');
  return reopened.useSecret('seed', (bytes) => bytes.every((b) => b === 7));
});

// pearljs/verify-proof fetches its module and caches as the bundler emitted them.
for (const name of ['V3 dense', 'V4 H100', 'V4 B200 with proof byte 22 flipped']) {
  await checkAsync(`verify-proof ${name}`, async () => {
    const c = proofs.cases.find((item) => item.name === name);
    const proof = unhex(proofs.proofs[c.certificate.proof.from]);
    if (c.certificate.proof.flip !== undefined) proof[c.certificate.proof.flip] ^= 1;
    const certificate = { version: c.certificate.version, hash: unhex(c.certificate.hash), publicData: unhex(c.certificate.publicData), proof };
    if (c.certificate.version === 4) certificate.ancestorHeaders = [];
    const verdict = await verifyProof(p.parseBlockHeader(unhex(c.header)), certificate);
    return c.error === null ? verdict.valid : !verdict.valid && c.error === `v4 proof rejected: ${verdict.message.slice(0, 127)}`;
  });
}

globalThis.__pearljs = results;
document.getElementById('out').textContent = JSON.stringify(results, null, 2);
