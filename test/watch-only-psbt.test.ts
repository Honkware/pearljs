// A watch-only machine prepares key-path PSBT inputs and the signing machine
// finds each key from the PSBT alone. The prepared PSBTs are compared with the
// ones Pearl's psbt package writes for the same inputs (vectors.signing).

import { describe, expect, it } from 'vitest';
import {
  SigningError,
  addInputByTxid,
  addPearlOutput,
  assembleScriptTree,
  checksigScript,
  createPsbt,
  createTransaction,
  deriveSigningAccountFromSeed,
  embed,
  finalizePsbt,
  importWatchOnlyAccount,
  networks,
  p2mr,
  p2mrAddress,
  p2tr,
  p2trAddress,
  parsePsbt,
  parseTransaction,
  prepareTaprootScriptPathInput,
  psbtOutputs,
  signTaprootScriptPathInput,
  signerFromPrivateKey,
  toOutputScript,
  transactionId,
} from '../src/index.js';
import vectors from '../vectors/pearl-go.json' with { type: 'json' };
import { hexToBytes } from './vector-helpers.js';

const seed = hexToBytes(vectors.bip86.seed);
const network = networks.mainnet;
const signing = deriveSigningAccountFromSeed(seed, network);
const xpub = signing.watchOnlyAccount().extendedPublicKey();
const first = vectors.signing[0]!;
const origin = { masterFingerprint: first.masterFingerprint, path: vectors.bip86.accountPath };

function caught(run: () => void): SigningError {
  try {
    run();
  } catch (err) {
    expect(err).toBeInstanceOf(SigningError);
    return err as SigningError;
  }
  throw new Error('nothing was thrown');
}

describe('preparing inputs from an extended public key', () => {
  it('writes the PSBT Pearl writes when the key comes with its origin, and signs without being told the child', () => {
    const watchOnly = importWatchOnlyAccount(xpub, network, origin);
    expect(watchOnly.path).toBe(vectors.bip86.accountPath);
    expect(watchOnly.masterFingerprint).toBe(first.masterFingerprint);
    for (const expected of vectors.signing) {
      const psbt = createPsbt(parseTransaction(expected.unsignedTxHex));
      watchOnly.prepareInput(psbt, 0, {
        index: expected.index,
        change: expected.change,
        value: BigInt(expected.value),
        sighashType: expected.hashType,
      });
      expect(psbt.toBase64(), expected.name).toBe(expected.preparedPsbt);

      const received = parsePsbt(psbt.toBase64());
      signing.signInput(received, 0, { allowedSighashTypes: [expected.hashType] });
      expect(transactionId(finalizePsbt(received)), expected.name).toBe(expected.txid);
    }
  });

  it('accepts the fingerprint as bytes and refuses an origin that does not fit the key', () => {
    const bytes = importWatchOnlyAccount(xpub, network, { ...origin, masterFingerprint: hexToBytes(first.masterFingerprint) });
    expect(bytes.masterFingerprint).toBe(first.masterFingerprint);
    for (const bad of [
      { ...origin, path: "m/86'/808276'/1'" },
      { ...origin, path: "m/86'/808276'/0'/0" },
      { ...origin, masterFingerprint: 'abcd' },
      { ...origin, masterFingerprint: new Uint8Array(5) },
    ]) {
      expect(() => importWatchOnlyAccount(xpub, network, bad)).toThrow('key origin must be');
    }
  });

  it('records the child under the account key when the origin is unknown, which the signing account also reads', () => {
    const watchOnly = importWatchOnlyAccount(xpub, network);
    expect(watchOnly.path).toBeNull();
    expect(watchOnly.masterFingerprint).toBeNull();
    const psbt = createPsbt(parseTransaction(first.unsignedTxHex));
    watchOnly.prepareInput(psbt, 0, { index: first.index, change: first.change, value: BigInt(first.value) });
    const record = psbt.data.inputs[0]!.tapBip32Derivation![0]!;
    expect(record.path).toBe(`m/${first.change ? 1 : 0}/${first.index}`);
    expect(Uint8Array.from(record.masterFingerprint)).toEqual(Uint8Array.from(watchOnly.node.fingerprint));
    signing.signInput(psbt, 0);
    expect(transactionId(finalizePsbt(psbt))).toBe(first.txid);
  });

  it('says so when the PSBT names no child of the account, and ignores a record whose key is not that child', () => {
    const psbt = createPsbt(parseTransaction(first.unsignedTxHex));
    psbt.updateInput(0, {
      witnessUtxo: { script: toOutputScript(signing.deriveAddress(first.index, first.change), network), value: BigInt(first.value) },
    });
    expect(caught(() => signing.signInput(psbt, 0)).code).toBe('DERIVATION_NOT_FOUND');

    // A record with this account's fingerprint and path but another child's key.
    psbt.updateInput(0, {
      tapBip32Derivation: [
        {
          masterFingerprint: hexToBytes(first.masterFingerprint),
          path: `${vectors.bip86.accountPath}/0/7`,
          pubkey: signing.derivePublicKey(8),
          leafHashes: [],
        },
      ],
    });
    expect(caught(() => signing.signInput(psbt, 0)).code).toBe('DERIVATION_NOT_FOUND');
    // Another account's signer does not take the first account's inputs.
    const prepared = parsePsbt(first.preparedPsbt);
    const other = deriveSigningAccountFromSeed(seed, network, 1);
    expect(caught(() => other.signInput(prepared, 0)).code).toBe('DERIVATION_NOT_FOUND');
  });
});

describe('signing before every input is prepared', () => {
  it('names the unprepared input', () => {
    const tx = createTransaction();
    addInputByTxid(tx, '11'.repeat(32), 0);
    addInputByTxid(tx, '22'.repeat(32), 1);
    tx.addOutput(toOutputScript(signing.deriveAddress(5), network), 1000n);
    const psbt = createPsbt(tx);
    signing.prepareInput(psbt, 0, { index: 0, value: 2000n });
    const err = caught(() => signing.signInput(psbt, 0));
    expect(err.code).toBe('INPUT_UNPREPARED');
    expect(err.message).toBe('PSBT input 1 is not prepared: it has no witness UTXO. Prepare every input before signing any');
    signing.prepareInput(psbt, 1, { index: 1, value: 2000n });
    signing.signInput(psbt, 0);
    signing.signInput(psbt, 1);
    expect(finalizePsbt(psbt).ins.every((input) => input.witness.length === 1)).toBe(true);
  });
});

describe('script-path signers from a key or an account child', () => {
  const expected = vectors.scriptPathSpends.find((item) => item.kind === 'p2tr')!;
  const tree = assembleScriptTree(
    Array.from({ length: expected.leafCount }, (_, i) => checksigScript(signing.derivePublicKey(i))),
  );
  const prepared = () => {
    const psbt = createPsbt(parseTransaction(expected.unsignedTxHex));
    prepareTaprootScriptPathInput(psbt, 0, {
      internalPubkey: hexToBytes(vectors.scriptTrees[0]!.internalPubKey),
      tree,
      leafIndex: expected.leafIndex,
      value: BigInt(expected.value),
      sighashType: expected.hashType,
    });
    return psbt;
  };
  const leafHash = tree.leaves[expected.leafIndex]!.leafHash;
  const options = { leafHash, allowedSighashTypes: [expected.hashType] };

  it('signs through account.tapscriptSigner, which stops with the account', () => {
    const account = deriveSigningAccountFromSeed(Uint8Array.from(seed), network);
    const signer = account.tapscriptSigner({ index: expected.leafIndex });
    expect(signer.publicKey).toEqual(account.derivePublicKey(expected.leafIndex));
    const psbt = prepared();
    signTaprootScriptPathInput(psbt, 0, signer, options);
    expect(transactionId(finalizePsbt(psbt))).toBe(expected.txid);
    account.destroy();
    expect(caught(() => signTaprootScriptPathInput(prepared(), 0, signer, options)).code).toBe('SIGNER_DESTROYED');
  });

  it('signs through signerFromPrivateKey and refuses bytes that are not a key', () => {
    const key = new Uint8Array(32).fill(9);
    const signer = signerFromPrivateKey(key);
    const single = assembleScriptTree([checksigScript(signer.publicKey)]);
    const internalPubkey = signing.derivePublicKey(0);
    const tx = createTransaction();
    addInputByTxid(tx, '33'.repeat(32), 0);
    tx.addOutput(toOutputScript(signing.deriveAddress(1), network), 900n);
    const psbt = createPsbt(tx);
    prepareTaprootScriptPathInput(psbt, 0, { internalPubkey, tree: single, leafIndex: 0, value: 2000n });
    signTaprootScriptPathInput(psbt, 0, signer, { leafHash: single.leaves[0]!.leafHash });
    expect(finalizePsbt(psbt).ins[0]!.witness).toHaveLength(3);
    expect(() => signerFromPrivateKey(new Uint8Array(32))).toThrow('invalid private key');
  });
});

describe('addresses of outputs', () => {
  it('reads Pearl addresses from a PSBT, and null for an output without one', () => {
    const tx = createTransaction();
    addInputByTxid(tx, '44'.repeat(32), 0);
    const psbt = createPsbt(tx);
    const address = signing.deriveAddress(2);
    addPearlOutput(psbt, address, 5000n, network);
    psbt.addOutput({ script: embed({ data: new Uint8Array(4) }).output, value: 0n });
    expect(psbtOutputs(psbt, network)).toEqual([
      { address, script: toOutputScript(address, network), value: 5000n },
      { address: null, script: embed({ data: new Uint8Array(4) }).output, value: 0n },
    ]);
    expect(psbt.txOutputs[0]!.address).not.toBe(address);
  });

  it('gives the address of a P2TR and a P2MR payment', () => {
    const internalPubkey = signing.derivePublicKey(0);
    expect(p2trAddress({ internalPubkey }, network)).toBe(signing.deriveAddress(0));
    const tree = assembleScriptTree([checksigScript(internalPubkey)]);
    const address = p2mrAddress({ merkleRoot: tree.root }, network);
    expect(toOutputScript(address, network)).toEqual(p2mr({ merkleRoot: tree.root }).output);
    expect(toOutputScript(p2trAddress({ internalPubkey, merkleRoot: tree.root }, network), network)).toEqual(
      p2tr({ internalPubkey, merkleRoot: tree.root }).output,
    );
  });
});
