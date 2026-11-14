// Async Schnorr signers, as hardware wallets present them, against the same
// vectors as the synchronous signers. The checks must run before the device
// is asked to sign, so a refused spend never prompts the user.

import { describe, expect, it } from 'vitest';
import {
  assembleScriptTree,
  checksigScript,
  createPsbt,
  deriveSigningAccountFromSeed,
  finalizePsbt,
  networks,
  parseTransaction,
  prepareTaprootScriptPathInput,
  serializeTransaction,
  signP2mrInputAsync,
  signTaprootScriptPathInputAsync,
  transactionId,
} from '../src/index.js';
import type { TapscriptSignerAsync } from '../src/index.js';
import { BIP32Factory } from 'bip32';
import * as ecc from 'tiny-secp256k1';
import vectors from '../vectors/pearl-go.json' with { type: 'json' };
import { hexToBytes } from './vector-helpers.js';

const seed = hexToBytes(vectors.bip86.seed);
const account = deriveSigningAccountFromSeed(seed, networks.mainnet);
const root = BIP32Factory(ecc).fromSeed(seed, {
  wif: networks.mainnet.wif,
  bip32: { public: networks.mainnet.hdPublicKeyId, private: networks.mainnet.hdPrivateKeyId },
});

/** An async signer for account/0/index that answers on a later tick and counts calls. */
function deviceSigner(index: number, corrupt = false): TapscriptSignerAsync & { calls: number } {
  const child = root.derivePath(`${vectors.bip86.accountPath}/0/${index}`);
  return {
    calls: 0,
    publicKey: child.publicKey,
    async signSchnorr(hash: Uint8Array) {
      this.calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 1));
      const signature = child.signSchnorr(hash);
      if (corrupt) signature[0] = signature[0]! ^ 1;
      return signature;
    },
  };
}

function keyTree(leafCount: number) {
  return assembleScriptTree(Array.from({ length: leafCount }, (_, i) => checksigScript(account.derivePublicKey(i))));
}

function spend(name: string) {
  return vectors.scriptPathSpends.find((item) => item.name === name)!;
}

describe('async signing', () => {
  it('signs a P2TR script path like the vector', async () => {
    const expected = spend('p2tr-3-leaves-last-default');
    const tree = keyTree(3);
    const psbt = createPsbt(parseTransaction(expected.unsignedTxHex));
    prepareTaprootScriptPathInput(psbt, 0, {
      internalPubkey: hexToBytes(vectors.scriptTrees[0]!.internalPubKey),
      tree,
      leafIndex: 2,
      value: BigInt(expected.value),
    });
    const device = deviceSigner(2);
    await signTaprootScriptPathInputAsync(psbt, 0, device, tree.leaves[2]!.leafHash);
    expect(device.calls).toBe(1);
    expect(transactionId(finalizePsbt(psbt))).toBe(expected.txid);
  });

  it('signs a P2MR input like the vector', async () => {
    const expected = spend('p2mr-3-leaves-middle-all-anyonecanpay');
    const tx = parseTransaction(expected.unsignedTxHex);
    const prevouts = expected.prevouts.map((p) => ({ script: hexToBytes(p.script), value: BigInt(p.value) }));
    await signP2mrInputAsync(tx, 0, deviceSigner(1), {
      prevouts,
      tree: keyTree(3),
      leafIndex: 1,
      sighashType: expected.hashType,
    });
    const goTx = parseTransaction(expected.finalTxHex);
    goTx.setWitness(0, [tx.ins[0]!.witness[0]!, ...goTx.ins[0]!.witness.slice(1)]);
    expect(serializeTransaction(tx)).toBe(serializeTransaction(goTx));
    expect(transactionId(tx)).toBe(expected.txid);
  });

  it('does not ask the device to sign a spend it will refuse', async () => {
    const expected = spend('p2mr-1-leaf-default');
    const tx = parseTransaction(expected.unsignedTxHex);
    const prevouts = expected.prevouts.map((p) => ({ script: hexToBytes(p.script), value: BigInt(p.value) }));
    const device = deviceSigner(0);
    await expect(signP2mrInputAsync(tx, 0, device, { prevouts, tree: keyTree(1), leafIndex: 0 })).rejects.toThrow(
      'previous transactions',
    );
    const wrongKey = deviceSigner(5);
    await expect(
      signP2mrInputAsync(tx, 0, wrongKey, { prevouts, tree: keyTree(1), leafIndex: 0, trustPrevouts: true }),
    ).rejects.toThrow('does not contain the signer key');
    expect(device.calls + wrongKey.calls).toBe(0);
  });

  it('rejects a bad signature from the device', async () => {
    const expected = spend('p2mr-1-leaf-default');
    const tx = parseTransaction(expected.unsignedTxHex);
    const prevouts = expected.prevouts.map((p) => ({ script: hexToBytes(p.script), value: BigInt(p.value) }));
    await expect(
      signP2mrInputAsync(tx, 0, deviceSigner(0, true), { prevouts, tree: keyTree(1), leafIndex: 0, trustPrevouts: true }),
    ).rejects.toThrow('invalid tapscript signature');
    expect(tx.ins[0]!.witness).toHaveLength(0);
  });
});
