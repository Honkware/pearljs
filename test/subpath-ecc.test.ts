// The package is marked side-effect free, so nothing may depend on a module
// being evaluated for its side effects. bitcoinjs's Taproot code needs a curve
// library handed to it first; each program below imports one subpath alone,
// is bundled with tree shaking on, and runs in a fresh process, where it only
// works if the functions it calls set that library up themselves.

import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, describe, expect, it } from 'vitest';
import { deriveSigningAccountFromSeed, networks, parsePsbt } from '../src/index.js';
import vectors from '../vectors/pearl-go.json' with { type: 'json' };
import { hexToBytes } from './vector-helpers.js';

const root = fileURLToPath(new URL('..', import.meta.url));
// Inside node_modules so the bundle resolves bitcoinjs-lib and tiny-secp256k1 from the repo.
const out = fileURLToPath(new URL('../node_modules/.cache/pearljs-subpath-ecc/', import.meta.url));
mkdirSync(out, { recursive: true });
afterAll(() => rmSync(out, { recursive: true, force: true }));

const seed = vectors.bip86.seed;
const signing = vectors.signing[0]!;
// A PSBT with its key-path signature in place and not yet finalized.
const signedPsbt = ((): string => {
  const psbt = parsePsbt(signing.preparedPsbt);
  deriveSigningAccountFromSeed(hexToBytes(seed), networks.mainnet).signInput(psbt, 0, { allowedSighashTypes: [signing.hashType] });
  return psbt.toBase64();
})();
const bytes = (hex: string): string => `Uint8Array.from(${JSON.stringify(hex)}.match(/../g), (b) => parseInt(b, 16))`;

const programs: Record<string, string> = {
  payments: `
    import { p2tr } from './src/payments.ts';
    console.log(p2tr({ internalPubkey: ${bytes(signing.internalPubKey)} }).output.length);`,
  keys: `
    import { deriveAccountFromSeed } from './src/keys.ts';
    import { mainnet } from './src/networks.ts';
    console.log(deriveAccountFromSeed(${bytes(seed)}, mainnet).deriveAddress(0));`,
  'keys, signing a PSBT it did not prepare': `
    import { Psbt } from 'bitcoinjs-lib';
    import { deriveSigningAccountFromSeed } from './src/keys.ts';
    import { mainnet } from './src/networks.ts';
    const psbt = Psbt.fromBase64(${JSON.stringify(signing.preparedPsbt)});
    deriveSigningAccountFromSeed(${bytes(seed)}, mainnet).signInput(psbt, 0, { allowedSighashTypes: [${signing.hashType}] });
    console.log(psbt.data.inputs[0].tapKeySig.length);`,
  // Checking a key-path signature tweaks the internal key inside bitcoinjs.
  'transaction, for a caller who uses the Psbt class directly': `
    import * as ecc from 'tiny-secp256k1';
    import { parsePsbt } from './src/transaction.ts';
    const psbt = parsePsbt(${JSON.stringify(signedPsbt)});
    console.log(psbt.validateSignaturesOfInput(0, (pubkey, hash, signature) => ecc.verifySchnorr(hash, pubkey, signature)));`,
  scriptpath: `
    import { prepareTaprootScriptPathInput } from './src/scriptpath.ts';
    import { assembleScriptTree } from './src/scripttree.ts';
    import { createPsbt, parseTransaction } from './src/transaction.ts';
    const key = ${bytes(signing.internalPubKey)};
    const tree = assembleScriptTree([Uint8Array.from([32, ...key, 0xac])]);
    const psbt = createPsbt(parseTransaction(${JSON.stringify(signing.unsignedTxHex)}));
    prepareTaprootScriptPathInput(psbt, 0, { internalPubkey: key, tree, leafIndex: 0, value: 1000n });
    console.log(psbt.data.inputs[0].tapLeafScript.length);`,
  builder: `
    import { toOutputScript } from './src/address.ts';
    import { payFromAccount } from './src/builder.ts';
    import { deriveSigningAccountFromSeed } from './src/keys.ts';
    import { regtest } from './src/networks.ts';
    const account = deriveSigningAccountFromSeed(${bytes(seed)}, regtest);
    const utxo = { txid: '11'.repeat(32), vout: 0, value: 100000n, script: toOutputScript(account.deriveAddress(0), regtest), confirmations: 1, index: 0 };
    const paid = payFromAccount(account, { network: regtest, utxos: [utxo], recipients: [{ address: account.deriveAddress(1), amount: 'max' }], feeRate: 1000n });
    console.log(paid.txid);`,
  // A wallet that syncs one payment and spends it, signing through a PSBT, from the wallet subpath alone.
  wallet: `
    import { addInputByTxid } from './src/builder.ts';
    import { deriveAccountFromSeed } from './src/keys.ts';
    import { regtest } from './src/networks.ts';
    import { createMemoryStore } from './src/store.ts';
    import { createTransaction } from './src/transaction.ts';
    import { toOutputScript } from './src/address.ts';
    import { PearlWallet } from './src/wallet.ts';
    const seed = ${bytes(seed)};
    const address = deriveAccountFromSeed(seed, regtest).deriveAddress(0);
    const funding = createTransaction(2);
    addInputByTxid(funding, '22'.repeat(32), 0);
    funding.addOutput(toOutputScript(address, regtest), 100000n);
    const txid = funding.getId();
    const block = { height: 1, hash: '33'.repeat(32) };
    const backend = {
      network: regtest,
      getTip: async () => block,
      getHistory: async (a) => (a === address ? [{ txid, block, received: 100000n }] : []),
      getAddressActivity: async () => [],
      getTransaction: async (id) => (id === txid ? { txid, block } : null),
      getRawTransaction: async (id) => (id === txid ? funding.toHex() : null),
      getUtxos: async () => [{ txid, vout: 0, value: 100000n, script: toOutputScript(address, regtest), address, confirmations: 1, coinbase: false }],
      getBalance: async () => ({ confirmed: 100000n, unconfirmed: 0n, immature: 0n }),
      getSpendStatus: async () => ({ status: 'unspent', confirmations: 1 }),
      estimateFeeRate: async () => 1000n,
      broadcast: async () => 'ok',
    };
    const wallet = await PearlWallet.create({ store: createMemoryStore(), backend, transactions: backend, seed, passphrase: 'p', kdf: { N: 1024 }, gapLimit: 5 });
    await wallet.sync();
    const sent = await wallet.send({ recipients: [{ address: deriveAccountFromSeed(seed, regtest).deriveAddress(9), amount: 'max' }] });
    console.log(sent.txid);`,
};

describe('subpaths that reach bitcoinjs Taproot code', () => {
  for (const [name, contents] of Object.entries(programs)) {
    it(`${name} works when it is the only thing imported, bundled and run in a fresh process`, async () => {
      const outfile = `${out}${name.replace(/\W+/g, '-')}.mjs`;
      await build({
        stdin: { contents, resolveDir: root, loader: 'ts' },
        outfile,
        bundle: true,
        treeShaking: true,
        format: 'esm',
        platform: 'node',
        packages: 'external',
        logLevel: 'silent',
      });
      const printed = execFileSync(process.execPath, [outfile], { encoding: 'utf8' });
      expect(printed.trim()).not.toBe('');
    });
  }
});
