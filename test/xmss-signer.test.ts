// The one-time index rules of the XMSS signer: it must never sign two
// messages at one index, whatever the store, the caller or a second signer
// for the same key does. Each test uses a key of its own, because signers in
// one process share what they have signed.

import { describe, expect, it } from 'vitest';
import { XMSS_LAST_INDEX, XmssError, createMemoryXmssIndexStore, createXmssSigner, xmssKeygen, xmssSign, xmssVerify } from '../src/index.js';
import type { XmssIndexStore, XmssSigner } from '../src/index.js';
import { bytesToHex } from './vector-helpers.js';

const publicSeed = new Uint8Array(32).fill(0x33);
const seeds = (tag: number) => [new Uint8Array(64).fill(tag), publicSeed] as const;
const message = new Uint8Array(32).fill(7);
const otherMessage = new Uint8Array(32).fill(8);
const indexOf = (signature: Uint8Array): number => new DataView(signature.buffer).getUint32(0);

function signerFor(tag: number, store: XmssIndexStore): XmssSigner {
  return createXmssSigner(...seeds(tag), store);
}

describe('XMSS signer indices', () => {
  it('takes a new index from the store for every signature', async () => {
    const signer = signerFor(1, createMemoryXmssIndexStore());
    const first = await signer.sign(message);
    const second = await signer.sign(message);
    expect(bytesToHex(first.slice(0, 4))).toBe('00000000');
    expect(bytesToHex(second.slice(0, 4))).toBe('00000001');
  });

  it('signs at every index from one cached tree, then refuses', async () => {
    const signer = signerFor(2, createMemoryXmssIndexStore());
    for (let index = 0; index < 31; index += 1) {
      const signature = await signer.sign(message);
      expect(indexOf(signature)).toBe(index);
      expect(xmssVerify(signer.publicKey, message, signature)).toBe(true);
    }
    await expect(signer.sign(message)).rejects.toThrow('used all 31 of its signatures');
    expect(await signer.remaining()).toBe(0);
  });

  it('counts the signatures a key has left from its store, and the store stops at the last index', async () => {
    const store = createMemoryXmssIndexStore();
    const signer = signerFor(12, store);
    expect(await signer.remaining()).toBe(31);
    await signer.sign(message);
    await signer.sign(message);
    expect(await signer.remaining()).toBe(29);
    expect(store.peek(signer.publicKey)).toBe(2);
    for (let index = 2; index <= XMSS_LAST_INDEX; index += 1) store.reserve(signer.publicKey);
    expect(store.peek(signer.publicKey)).toBe(31);
    // A refused reservation records nothing, so the count cannot run away.
    expect(() => store.reserve(signer.publicKey)).toThrow(XmssError);
    expect(() => store.reserve(signer.publicKey)).toThrow('used all 31 of its signatures');
    expect(store.peek(signer.publicKey)).toBe(31);
    expect(await signer.remaining()).toBe(0);
  });

  it('refuses once the key has used its 31 signatures', async () => {
    const signer = signerFor(3, { reserve: () => 31, peek: () => 0 });
    await expect(signer.sign(message)).rejects.toThrow('used all 31 of its signatures');
  });

  it('refuses an index the store did not reserve properly', async () => {
    for (const bad of [-1, 1.5, Number.NaN, '2', null, undefined, 2n]) {
      const signer = signerFor(3, { reserve: () => bad as number, peek: () => 0 });
      await expect(signer.sign(message)).rejects.toThrow(`index store returned ${String(bad)}`);
    }
  });

  it('refuses a store that returns the same index twice', async () => {
    const signer = signerFor(4, { reserve: () => 3, peek: () => 0 });
    expect(indexOf(await signer.sign(message))).toBe(3);
    await expect(signer.sign(otherMessage)).rejects.toThrow('returned index 3 after index 3');
    // Not even for the message it already signed: the store is broken.
    await expect(signer.sign(message)).rejects.toThrow('refusing to reuse a one-time index');
  });

  it('refuses a store that goes backwards', async () => {
    const indices = [5, 2, 6];
    const signer = signerFor(5, { reserve: () => indices.shift()!, peek: () => 0 });
    expect(indexOf(await signer.sign(message))).toBe(5);
    await expect(signer.sign(otherMessage)).rejects.toThrow('returned index 2 after index 5');
    expect(indexOf(await signer.sign(otherMessage))).toBe(6);
  });

  it('serializes concurrent sign calls over a store that reads, waits and writes', async () => {
    let next = 0;
    const racy: XmssIndexStore = {
      peek: () => 0,
      async reserve() {
        const index = next;
        await new Promise((resolve) => setTimeout(resolve, 2));
        next = index + 1;
        return index;
      },
    };
    const signer = signerFor(6, racy);
    const messages = [1, 2, 3, 4].map((byte) => new Uint8Array(32).fill(byte));
    const signatures = await Promise.all(messages.map((item) => signer.sign(item)));
    expect(signatures.map(indexOf)).toEqual([0, 1, 2, 3]);
    signatures.forEach((signature, i) => expect(xmssVerify(signer.publicKey, messages[i]!, signature)).toBe(true));
  });

  it('keeps the queue moving after a failed signature', async () => {
    let calls = 0;
    const flaky: XmssIndexStore = {
      peek: () => 0,
      reserve() {
        calls += 1;
        if (calls === 1) throw new Error('disk full');
        return calls;
      },
    };
    const signer = signerFor(7, flaky);
    const [first, second] = await Promise.allSettled([signer.sign(message), signer.sign(otherMessage)]);
    expect(first.status).toBe('rejected');
    expect(second.status).toBe('fulfilled');
  });

  it('signs the message as it was when sign was called', async () => {
    const signer = signerFor(8, createMemoryXmssIndexStore());
    const mutable = Uint8Array.from(message);
    const pending = signer.sign(mutable);
    mutable.fill(0xff);
    expect(xmssVerify(signer.publicKey, message, await pending)).toBe(true);
  });

  it('refuses a second signer for the same key whose store restarts at a used index', async () => {
    const first = signerFor(9, createMemoryXmssIndexStore());
    const second = signerFor(9, createMemoryXmssIndexStore());
    expect(indexOf(await first.sign(message))).toBe(0);
    await expect(second.sign(otherMessage)).rejects.toThrow('already signed a different message');
    // The same message at the same index is the same signature, which is harmless.
    const third = signerFor(9, createMemoryXmssIndexStore());
    expect(bytesToHex(await third.sign(message))).toBe(bytesToHex(await signerFor(9, { reserve: () => 0, peek: () => 0 }).sign(message)));
  });

  it('burns the index when the caller abandons a reserved signature', async () => {
    // The store recorded index 0, then the process "crashed" before signing.
    const store = createMemoryXmssIndexStore();
    const { publicKey } = xmssKeygen(...seeds(10));
    expect(store.reserve(publicKey)).toBe(0);
    const signer = signerFor(10, store);
    expect(indexOf(await signer.sign(message))).toBe(1);
  });

  it('stops signing and wipes its key once destroyed', async () => {
    const privateSeed = new Uint8Array(64).fill(11);
    const signer = createXmssSigner(privateSeed, publicSeed, createMemoryXmssIndexStore());
    await signer.sign(message);
    const queued = signer.sign(message);
    signer.destroy();
    await expect(queued).rejects.toThrow('has been destroyed');
    await expect(signer.sign(message)).rejects.toThrow('has been destroyed');
    // The caller's seed is the caller's to wipe.
    expect(privateSeed.every((byte) => byte === 11)).toBe(true);
  });
});

describe('xmssSign self-checks', () => {
  it('refuses a secret key whose root does not match its seeds', () => {
    const { secretKey } = xmssKeygen(...seeds(12));
    for (const at of [64, 70, 95]) {
      const forged = Uint8Array.from(secretKey);
      forged[at] = forged[at]! ^ 1;
      expect(() => xmssSign(forged, 0, message)).toThrow('root does not match its seeds');
    }
    const otherSeed = Uint8Array.from(secretKey);
    otherSeed[100] = otherSeed[100]! ^ 1;
    expect(() => xmssSign(otherSeed, 0, message)).toThrow('root does not match its seeds');
  });
});
