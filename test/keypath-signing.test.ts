// Key-path signing with a signer that holds its key elsewhere, as a hardware
// wallet does: the account has only an extended public key, the device gets a
// sighash and returns a signature made with the tweaked key. The Go signing
// vectors fix the sighash and the bytes of the signed PSBT; the device must
// not be asked until every check has passed.

import { BIP32Factory } from 'bip32';
import * as ecc from 'tiny-secp256k1';
import { describe, expect, it } from 'vitest';
import {
  PearlError,
  addInputByTxid,
  assembleScriptTree,
  checksigScript,
  createPsbt,
  createTransaction,
  deriveSigningAccountFromSeed,
  finalizePsbt,
  importWatchOnlyAccount,
  keyPathSighash,
  keyPathSignerFromPrivateKey,
  networks,
  p2mr,
  p2tr,
  parsePsbt,
  parseTransaction,
  prepareP2mrScriptPathInput,
  prepareTaprootScriptPathInput,
  serializeTransaction,
  signTaprootKeyPathInputAsync,
  taggedHash,
  toOutputScript,
  verifyFinalizedPsbt,
  verifyInput,
} from '../src/index.js';
import type { KeyPathSignRequest, KeyPathSignerAsync, Psbt } from '../src/index.js';
import vectors from '../vectors/pearl-go.json' with { type: 'json' };
import { bytesToHex, hexToBytes } from './vector-helpers.js';

const network = networks.mainnet;
const seed = hexToBytes(vectors.bip86.seed);
const signing = deriveSigningAccountFromSeed(seed, network);
const exported = signing.watchOnlyAccount();
const origin = { masterFingerprint: exported.masterFingerprint!, path: exported.path! };
const account = importWatchOnlyAccount(exported.extendedPublicKey(), network, origin);
const root = BIP32Factory(ecc).fromSeed(seed, {
  wif: network.wif,
  bip32: { public: network.hdPublicKeyId, private: network.hdPrivateKeyId },
});

type Device = KeyPathSignerAsync & { requests: KeyPathSignRequest[] };

/** A device that holds the seed: it finds the key by the request's path and tweaks it itself. */
function device(): Device {
  return {
    requests: [],
    async signKeyPath(request) {
      this.requests.push(request);
      await new Promise((resolve) => setTimeout(resolve, 1));
      const child = root.derivePath(request.derivation!.path);
      return keyPathSignerFromPrivateKey(child.privateKey!).signKeyPath(request);
    },
  };
}

/** A signer that was handed the tweaked key of account/0/index and reads nothing but the hash. */
function tweakedKeySigner(index: number): Device {
  const child = root.derivePath(`${origin.path}/0/${index}`);
  const internal = child.publicKey.slice(1);
  const even = child.publicKey[0] === 0x03 ? ecc.privateNegate(child.privateKey!) : child.privateKey!;
  const tweaked = ecc.privateAdd(even, taggedHash('TapTweak', internal))!;
  return {
    requests: [],
    signKeyPath(request) {
      this.requests.push(request);
      return Promise.resolve(ecc.signSchnorr(request.hash, tweaked));
    },
  };
}

/** A signer that answers with fixed bytes, for replaying Go's signatures. */
function replay(signature: Uint8Array): Device {
  return {
    requests: [],
    signKeyPath(request) {
      this.requests.push(request);
      return Promise.resolve(signature);
    },
  };
}

async function refusal(run: Promise<unknown>): Promise<PearlError> {
  const err = await run.then(
    () => new Error('nothing was thrown'),
    (thrown: unknown) => thrown,
  );
  expect(err).toBeInstanceOf(PearlError);
  return err as PearlError;
}

/** Two inputs paying children 3 and 4, both prepared by the watch-only account. */
function twoInputs(from = account): Psbt {
  const tx = createTransaction(2);
  addInputByTxid(tx, 'aa'.repeat(32), 0);
  addInputByTxid(tx, 'bb'.repeat(32), 1);
  tx.addOutput(toOutputScript(from.deriveAddress(9), network), 190_000n);
  const psbt = createPsbt(tx);
  from.prepareInput(psbt, 0, { index: 3, value: 100_000n });
  from.prepareInput(psbt, 1, { index: 4, change: true, value: 100_000n });
  return psbt;
}

describe('the key-path sighash', () => {
  it("is Go's for every signing vector, from a transaction and from a PSBT", () => {
    for (const vector of vectors.signing) {
      const tx = parseTransaction(vector.unsignedTxHex);
      const prevouts = [{ script: p2tr({ internalPubkey: hexToBytes(vector.internalPubKey) }).output, value: BigInt(vector.value) }];
      expect(bytesToHex(keyPathSighash(tx, 0, { prevouts, sighashType: vector.hashType })), vector.name).toBe(vector.sighash);
      const psbt = parsePsbt(vector.preparedPsbt);
      expect(bytesToHex(keyPathSighash(psbt, 0, { allowedSighashTypes: [vector.hashType] }))).toBe(vector.sighash);
    }
  });

  it("is Go's for each sighash type of the PSBT vector", () => {
    const tx = parseTransaction(vectors.psbt.unsignedTxHex);
    const prevouts = [{ script: toOutputScript(vectors.addresses.find((a) => a.network === 'mainnet' && a.kind === 'p2tr')!.address, network), value: 200_000_000n }];
    for (const expected of vectors.sighashes) {
      expect(bytesToHex(keyPathSighash(tx, 0, { prevouts, sighashType: expected.hashType }))).toBe(expected.hash);
    }
  });

  it('refuses a PSBT sighash type the caller did not allow, and a PSBT input without its UTXO', () => {
    const vector = vectors.signing.find((item) => item.hashType !== 0)!;
    expect(() => keyPathSighash(parsePsbt(vector.preparedPsbt), 0)).toThrow('not in allowedSighashTypes');
    const psbt = twoInputs();
    delete psbt.data.inputs[1]!.witnessUtxo;
    expect(() => keyPathSighash(psbt, 0)).toThrow('PSBT input 1 is not prepared');
    expect(() => keyPathSighash(psbt, 2)).toThrow(RangeError);
  });

  it('commits to the annex, and the engine accepts the signature only with that annex in the witness', async () => {
    const child = root.derivePath(`${origin.path}/0/3`);
    const internalPubkey = child.publicKey.slice(1);
    const { output } = p2tr({ internalPubkey });
    const tx = createTransaction(2);
    addInputByTxid(tx, 'aa'.repeat(32), 0);
    tx.addOutput(output, 90_000n);
    const prevouts = [{ script: output, value: 100_000n }];
    const annex = Uint8Array.of(0x50, 1, 2, 3);
    const hash = keyPathSighash(tx, 0, { prevouts, annex });
    expect(bytesToHex(hash)).not.toBe(bytesToHex(keyPathSighash(tx, 0, { prevouts })));
    const signature = await keyPathSignerFromPrivateKey(child.privateKey!).signKeyPath({
      hash, internalPubkey, merkleRoot: null, outputKey: output.slice(2), sighashType: 0, inputIndex: 0,
    });
    tx.setWitness(0, [signature, annex]);
    expect(verifyInput(tx, 0, prevouts)).toEqual({ ok: true });
    tx.setWitness(0, [signature]);
    expect(verifyInput(tx, 0, prevouts)).toMatchObject({ ok: false, code: 'ErrTaprootSigInvalid' });
    expect(() => keyPathSighash(tx, 0, { prevouts, annex: Uint8Array.of(0x51) })).toThrow('start with 0x50');
  });
});

describe('account.signInputAsync', () => {
  it("reproduces Go's signed PSBT and transaction for every signing vector", async () => {
    for (const vector of vectors.signing) {
      const psbt = parsePsbt(vector.preparedPsbt);
      const signer = replay(hexToBytes(vector.signature).subarray(0, 64));
      await account.signInputAsync(psbt, 0, signer, { allowedSighashTypes: [vector.hashType] });
      expect(signer.requests).toHaveLength(1);
      const request = signer.requests[0]!;
      expect(bytesToHex(request.hash), vector.name).toBe(vector.sighash);
      expect(bytesToHex(request.internalPubkey)).toBe(vector.internalPubKey);
      expect(bytesToHex(request.outputKey)).toBe(vector.tweakedPubKey);
      expect(request.merkleRoot).toBeNull();
      expect(request.sighashType).toBe(vector.hashType);
      expect(request.derivation!.path).toBe(vector.path);
      expect(bytesToHex(request.derivation!.masterFingerprint)).toBe(vector.masterFingerprint);
      expect(psbt.toBase64()).toBe(vector.signedPsbt);
      expect(serializeTransaction(finalizePsbt(psbt))).toBe(vector.finalTxHex);
    }
  });

  it('takes a signature from a device that tweaks the internal key itself', async () => {
    const psbt = twoInputs();
    const signer = device();
    await account.signInputAsync(psbt, 0, signer);
    await account.signInputAsync(psbt, 1, signer);
    expect(signer.requests.map((request) => request.derivation!.path)).toEqual([`${origin.path}/0/3`, `${origin.path}/1/4`]);
    finalizePsbt(psbt);
    expect(verifyFinalizedPsbt(psbt)).toEqual({ ok: true });
  });

  it('takes a signature from a signer that holds the tweaked key and reads only the hash', async () => {
    const vector = vectors.signing.find((item) => item.hashType === 0)!;
    const psbt = parsePsbt(vector.preparedPsbt);
    await account.signInputAsync(psbt, 0, tweakedKeySigner(vector.index));
    expect(serializeTransaction(finalizePsbt(psbt), false)).toBe(vector.unsignedTxHex);
    expect(verifyFinalizedPsbt(psbt)).toEqual({ ok: true });
  });

  it('signs the same message as the signing account does', async () => {
    const auxRand = new Uint8Array(32).fill(9);
    const local = twoInputs();
    signing.signInput(local, 1, { auxRand });
    const remote = twoInputs();
    const child = root.derivePath(`${origin.path}/1/4`);
    await account.signInputAsync(remote, 1, keyPathSignerFromPrivateKey(child.privateKey!, { auxRand }));
    expect(bytesToHex(remote.data.inputs[1]!.tapKeySig!)).toBe(bytesToHex(local.data.inputs[1]!.tapKeySig!));
  });

  it('refuses a signature made with the untweaked key, or of the wrong length, and stores nothing', async () => {
    const child = root.derivePath(`${origin.path}/0/3`);
    const untweaked: KeyPathSignerAsync = { signKeyPath: (request) => Promise.resolve(child.signSchnorr(request.hash)) };
    const psbt = twoInputs();
    expect((await refusal(account.signInputAsync(psbt, 0, untweaked))).code).toBe('SIGNATURE_INVALID');
    const long: KeyPathSignerAsync = {
      signKeyPath: async (request) => Uint8Array.from([...(await device().signKeyPath(request)), 1]),
    };
    expect((await refusal(account.signInputAsync(psbt, 0, long))).code).toBe('SIGNATURE_INVALID');
    expect(psbt.data.inputs[0]!.tapKeySig).toBeUndefined();
  });

  it('does not ask the device about a spend it refuses', async () => {
    const signer = device();
    const unprepared = twoInputs();
    delete unprepared.data.inputs[1]!.witnessUtxo;
    expect((await refusal(account.signInputAsync(unprepared, 0, signer))).code).toBe('INPUT_UNPREPARED');

    const retyped = parsePsbt(vectors.signing.find((item) => item.hashType !== 0)!.preparedPsbt);
    expect((await refusal(account.signInputAsync(retyped, 0, signer))).code).toBe('SIGHASH_NOT_ALLOWED');

    const psbt = twoInputs();
    expect((await refusal(account.signInputAsync(psbt, 0, signer, { index: 4 }))).code).toBe('INPUT_MISMATCH');
    const stranger = importWatchOnlyAccount(deriveSigningAccountFromSeed(seed, network, 1).watchOnlyAccount().extendedPublicKey(), network);
    expect((await refusal(stranger.signInputAsync(psbt, 0, signer))).code).toBe('DERIVATION_NOT_FOUND');

    const tree = assembleScriptTree([checksigScript(account.derivePublicKey(3))]);
    const scriptPath = twoInputs();
    scriptPath.updateInput(0, { tapMerkleRoot: tree.root });
    expect((await refusal(account.signInputAsync(scriptPath, 0, signer, { index: 3 }))).code).toBe('INPUT_MISMATCH');

    await account.signInputAsync(psbt, 0, signer);
    expect((await refusal(account.signInputAsync(psbt, 0, signer))).message).toContain('already has a key-path signature');
    await expect(account.signInputAsync(psbt, 5, signer)).rejects.toThrow(RangeError);
    expect(signer.requests).toHaveLength(1);
  });

  it('is answered by a signing account acting as the device, for either way of naming the child', async () => {
    const auxRand = new Uint8Array(32).fill(9);
    const local = twoInputs();
    signing.signInput(local, 0, { auxRand });
    const remote = twoInputs();
    await account.signInputAsync(remote, 0, signing.keyPathSigner({ auxRand }));
    expect(bytesToHex(remote.data.inputs[0]!.tapKeySig!)).toBe(bytesToHex(local.data.inputs[0]!.tapKeySig!));

    const bare = importWatchOnlyAccount(exported.extendedPublicKey(), network);
    const underAccountKey = twoInputs(bare);
    await bare.signInputAsync(underAccountKey, 1, signing.keyPathSigner());
    finalizePsbt(remote.combine(parsePsbt(underAccountKey.toBase64())));
    expect(verifyFinalizedPsbt(remote)).toEqual({ ok: true });
  });

  it('gets no signature from a signing account for a child that is not its own, or once it is destroyed', async () => {
    const elsewhere = deriveSigningAccountFromSeed(seed, network, 1);
    const psbt = twoInputs();
    expect((await refusal(account.signInputAsync(psbt, 0, elsewhere.keyPathSigner()))).code).toBe('DERIVATION_NOT_FOUND');
    const request = { hash: new Uint8Array(32), outputKey: new Uint8Array(32), merkleRoot: null, sighashType: 0, inputIndex: 0 };
    const signer = elsewhere.keyPathSigner();
    // The path of one child with the key of another.
    const lying = { ...request, internalPubkey: elsewhere.derivePublicKey(1), derivation: { masterFingerprint: hexToBytes(origin.masterFingerprint), path: `${elsewhere.path}/0/0` } };
    expect((await refusal(signer.signKeyPath(lying))).code).toBe('DERIVATION_NOT_FOUND');
    expect((await refusal(signer.signKeyPath({ ...request, internalPubkey: elsewhere.derivePublicKey(1) }))).code).toBe('DERIVATION_NOT_FOUND');
    const honest = { ...lying, internalPubkey: elsewhere.derivePublicKey(0) };
    expect(await signer.signKeyPath(honest)).toHaveLength(64);
    elsewhere.destroy();
    expect((await refusal(signer.signKeyPath(honest))).code).toBe('SIGNER_DESTROYED');
  });

  it('names the child under the account key when the account was imported without its origin', async () => {
    const bare = importWatchOnlyAccount(exported.extendedPublicKey(), network);
    const psbt = twoInputs(bare);
    const signer: Device = {
      requests: [],
      signKeyPath(request) {
        this.requests.push(request);
        const child = root.derivePath(`${origin.path}/${request.derivation!.path.slice(2)}`);
        return keyPathSignerFromPrivateKey(child.privateKey!).signKeyPath(request);
      },
    };
    await bare.signInputAsync(psbt, 1, signer);
    expect(signer.requests[0]!.derivation!.path).toBe('m/1/4');
    expect(bytesToHex(signer.requests[0]!.derivation!.masterFingerprint)).toBe(bytesToHex(bare.node.fingerprint));
  });
});

describe('signTaprootKeyPathInputAsync', () => {
  const child = root.derivePath(`${origin.path}/0/5`);
  const internalPubkey = child.publicKey.slice(1);
  const tree = assembleScriptTree([checksigScript(account.derivePublicKey(6))]);

  function treeSpend(): Psbt {
    const tx = createTransaction(2);
    addInputByTxid(tx, 'aa'.repeat(32), 0);
    tx.addOutput(toOutputScript(account.deriveAddress(9), network), 90_000n);
    const psbt = createPsbt(tx);
    prepareTaprootScriptPathInput(psbt, 0, { internalPubkey, tree, leafIndex: 0, value: 100_000n });
    return psbt;
  }

  it('signs the key path of an output with a script tree, handing the signer the Merkle root to tweak with', async () => {
    const psbt = treeSpend();
    const requests: KeyPathSignRequest[] = [];
    const inner = keyPathSignerFromPrivateKey(child.privateKey!);
    await signTaprootKeyPathInputAsync(psbt, 0, {
      signKeyPath(request) {
        requests.push(request);
        return inner.signKeyPath(request);
      },
    });
    expect(bytesToHex(requests[0]!.merkleRoot!)).toBe(bytesToHex(tree.root));
    expect(bytesToHex(requests[0]!.outputKey)).toBe(bytesToHex(p2tr({ internalPubkey, merkleRoot: tree.root }).output.slice(2)));
    expect(finalizePsbt(psbt).ins[0]!.witness).toHaveLength(1);
    expect(verifyFinalizedPsbt(psbt)).toEqual({ ok: true });
  });

  it('refuses a signer that tweaked without the Merkle root', async () => {
    const psbt = treeSpend();
    const inner = keyPathSignerFromPrivateKey(child.privateKey!);
    const forgetful: KeyPathSignerAsync = { signKeyPath: (request) => inner.signKeyPath({ ...request, merkleRoot: null }) };
    expect((await refusal(signTaprootKeyPathInputAsync(psbt, 0, forgetful))).code).toBe('SIGNATURE_INVALID');
  });

  it('checks the internal key against the input and the output before asking', async () => {
    const signer = device();
    const other = account.derivePublicKey(7);
    expect((await refusal(signTaprootKeyPathInputAsync(treeSpend(), 0, signer, { internalPubkey: other }))).code).toBe('INPUT_MISMATCH');
    const wrongRoot = { merkleRoot: new Uint8Array(32).fill(1) };
    expect((await refusal(signTaprootKeyPathInputAsync(treeSpend(), 0, signer, wrongRoot))).code).toBe('INPUT_MISMATCH');

    const p2mrTree = assembleScriptTree([checksigScript(internalPubkey)]);
    const tx = createTransaction(2);
    addInputByTxid(tx, 'aa'.repeat(32), 0);
    tx.addOutput(p2mr({ merkleRoot: p2mrTree.root }).output, 90_000n);
    const psbt = createPsbt(tx);
    prepareP2mrScriptPathInput(psbt, 0, { tree: p2mrTree, leafIndex: 0, value: 100_000n });
    expect((await refusal(signTaprootKeyPathInputAsync(psbt, 0, signer))).code).toBe('INPUT_UNPREPARED');
    expect((await refusal(signTaprootKeyPathInputAsync(psbt, 0, signer, { internalPubkey }))).code).toBe('INPUT_MISMATCH');
    expect(signer.requests).toHaveLength(0);
  });

  it('refuses a request for another key in the in-memory signer', async () => {
    const signer = keyPathSignerFromPrivateKey(child.privateKey!);
    const request = { hash: new Uint8Array(32), outputKey: internalPubkey, merkleRoot: null, sighashType: 0, inputIndex: 0 };
    await expect(signer.signKeyPath({ ...request, internalPubkey: account.derivePublicKey(7) })).rejects.toThrow('another internal key');
    expect(() => keyPathSignerFromPrivateKey(new Uint8Array(32))).toThrow('invalid private key');
  });
});
