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
