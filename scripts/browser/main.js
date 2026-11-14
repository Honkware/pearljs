// Runs in headless Chrome against Pearl's vectors; scripts/browser-smoke.mjs reads the result.
import * as p from 'pearljs';
import v from 'pearl-vectors';

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
// IndexedDB and Web Locks requests never complete under --virtual-time-budget,
// so the IndexedDB store is only checked to bundle here; it runs against
// fake-indexeddb in test/store-indexeddb.test.ts.
check('indexeddb store bundles', () => typeof p.openIndexedDbStore === 'function' && typeof p.createMemoryStore === 'function');
await checkAsync('keystore under WebCrypto', async () => {
  const keystore = await p.createKeystore('pass', { kdf: { N: 1024 } });
  await keystore.addSecret('seed', 'seed', new Uint8Array(32).fill(7));
  const reopened = p.openKeystore(keystore.toJSON());
  await reopened.unlock('pass');
  return reopened.useSecret('seed', (bytes) => bytes.every((b) => b === 7));
});

window.__pearljs = results;
document.getElementById('out').textContent = JSON.stringify(results, null, 2);
