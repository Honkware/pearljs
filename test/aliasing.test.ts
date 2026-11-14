// Bytes handed back by parsers and builders must be copies. A Node Buffer's
// slice returns a view where a Uint8Array's returns a copy, so each parser is
// fed a Buffer cut from a larger pool, and builders are checked for results
// that share memory with a script tree, a PSBT or each other.

import { describe, expect, it } from 'vitest';
import {
  assembleScriptTree,
  checksigScript,
  createMemoryXmssIndexStore,
  createPsbt,
  createTransaction,
  createXmssSigner,
  decompileScript,
  deriveSigningAccountFromSeed,
  networks,
  p2mr,
  p2mrControlBlock,
  parseBlockHeader,
  parseP2mrControlBlock,
  parseTaprootControlBlock,
  prepareP2mrScriptPathInput,
  prepareTaprootScriptPathInput,
  scriptPathWitness,
  serializeBlockHeader,
  taprootControlBlock,
  xmssVerify,
} from '../src/index.js';
import vectors from '../vectors/pearl-go.json' with { type: 'json' };
import { bytesToHex, hexToBytes } from './vector-helpers.js';

/** The bytes as a Buffer view at an odd offset inside a larger pool. */
function pooled(bytes: Uint8Array): Buffer {
  const pool = Buffer.alloc(bytes.length + 64, 0xee);
  pool.set(bytes, 37);
  return pool.subarray(37, 37 + bytes.length);
}

function byteArrays(value: unknown, found: Uint8Array[] = []): Uint8Array[] {
  if (value instanceof Uint8Array) found.push(value);
  else if (Array.isArray(value)) value.forEach((item) => byteArrays(item, found));
  else if (value !== null && typeof value === 'object') Object.values(value).forEach((item) => byteArrays(item, found));
  return found;
}

/** Parses a pooled Buffer, wipes the pool, and expects the result unchanged. */
function expectCopies<T>(parse: (bytes: Uint8Array) => T, input: Uint8Array): void {
  const buffer = pooled(input);
  const parsed = parse(buffer);
  const arrays = byteArrays(parsed);
  expect(arrays.length).toBeGreaterThan(0);
  const before = arrays.map(bytesToHex);
  for (const array of arrays) expect(array.buffer).not.toBe(buffer.buffer);
  buffer.fill(0);
  expect(arrays.map(bytesToHex)).toEqual(before);
}

const account = deriveSigningAccountFromSeed(hexToBytes(vectors.bip86.seed), networks.regtest);
const internalPubkey = account.derivePublicKey(0, true);
const scripts = [0, 1, 2].map((i) => checksigScript(account.derivePublicKey(i)));

describe('returned bytes are copies', () => {
  it('parseBlockHeader copies its hashes out of a Buffer', () => {
    const bytes = hexToBytes(vectors.blockHeaders[0]!.hex);
    expectCopies(parseBlockHeader, bytes);
    const header = parseBlockHeader(bytes);
    header.prevBlock.fill(0xff);
    expect(bytesToHex(bytes)).toBe(vectors.blockHeaders[0]!.hex);
    expect(bytesToHex(serializeBlockHeader(parseBlockHeader(pooled(bytes))))).toBe(vectors.blockHeaders[0]!.hex);
  });

  it('control block parsers copy the key and proof out of a Buffer', () => {
    const tree = assembleScriptTree(scripts);
    expectCopies(parseTaprootControlBlock, taprootControlBlock(internalPubkey, tree, 0));
    expectCopies(parseP2mrControlBlock, p2mrControlBlock(tree, 0));
    expect(() => parseP2mrControlBlock('c1' as unknown as Uint8Array)).toThrow(TypeError);
  });

  it('decompileScript copies pushed data out of a Buffer', () => {
    expectCopies(decompileScript, scripts[0]!);
  });

  it('a one-leaf tree does not share its root with its leaf hash', () => {
    const tree = assembleScriptTree([scripts[0]!]);
    expect(tree.root).not.toBe(tree.leaves[0]!.leafHash);
    expect(tree.root).toEqual(tree.leaves[0]!.leafHash);
    const root = bytesToHex(tree.root);
    tree.leaves[0]!.leafHash.fill(0);
    expect(bytesToHex(tree.root)).toBe(root);
  });

  it('a prepared PSBT input does not share the leaf script with the tree', () => {
    const tree = assembleScriptTree(scripts);
    const tx = createTransaction(2);
    tx.addInput(new Uint8Array(32).fill(1), 0);
    tx.addInput(new Uint8Array(32).fill(2), 0);
    tx.addOutput(p2mr({ merkleRoot: tree.root }).output, 1_000n);
    const psbt = createPsbt(tx);
    prepareTaprootScriptPathInput(psbt, 0, { internalPubkey, tree, leafIndex: 1, value: 2_000n });
    prepareP2mrScriptPathInput(psbt, 1, { tree, leafIndex: 1, value: 2_000n });
    for (const input of psbt.data.inputs) {
      const inPsbt = input.tapLeafScript![0]!.script;
      expect(inPsbt).not.toBe(tree.leaves[1]!.script);
      inPsbt.fill(0);
    }
    expect(bytesToHex(tree.leaves[1]!.script)).toBe(bytesToHex(scripts[1]!));
  });

  it('prepareInput gives each PSBT input its own fingerprint and key bytes', () => {
    const tx = createTransaction(2);
    tx.addInput(new Uint8Array(32).fill(1), 0);
    tx.addInput(new Uint8Array(32).fill(2), 0);
    const psbt = createPsbt(tx);
    account.prepareInput(psbt, 0, { index: 0, value: 1_000n });
    const first = psbt.data.inputs[0]!;
    const fingerprint = bytesToHex(first.tapBip32Derivation![0]!.masterFingerprint);
    expect(first.tapInternalKey).not.toBe(first.tapBip32Derivation![0]!.pubkey);
    first.tapBip32Derivation![0]!.masterFingerprint.fill(0);
    account.prepareInput(psbt, 1, { index: 1, value: 1_000n });
    expect(bytesToHex(psbt.data.inputs[1]!.tapBip32Derivation![0]!.masterFingerprint)).toBe(fingerprint);
  });

  it('scriptPathWitness copies every item', () => {
    const tree = assembleScriptTree(scripts);
    const signature = new Uint8Array(64).fill(5);
    const controlBlock = p2mrControlBlock(tree, 0);
    const witness = scriptPathWitness([signature], tree.leaves[0]!.script, controlBlock);
    expect(witness).toEqual([signature, tree.leaves[0]!.script, controlBlock]);
    witness.forEach((item) => item.fill(0));
    expect(bytesToHex(tree.leaves[0]!.script)).toBe(bytesToHex(scripts[0]!));
    expect(signature[0]).toBe(5);
  });

  it('an XMSS signer keeps its own public key', async () => {
    const seen: Uint8Array[] = [];
    const memory = createMemoryXmssIndexStore();
    const signer = createXmssSigner(new Uint8Array(64).fill(0x61), new Uint8Array(32).fill(0x62), {
      reserve(publicKey) {
        seen.push(publicKey);
        const index = memory.reserve(publicKey);
        publicKey.fill(0);
        return index;
      },
    });
    const publicKey = Uint8Array.from(signer.publicKey);
    await signer.sign(new Uint8Array(32).fill(1));
    // The store wiped the key it was handed, and the caller wipes the one it can see.
    signer.publicKey.fill(0);
    const message = new Uint8Array(32).fill(2);
    expect(xmssVerify(publicKey, message, await signer.sign(message))).toBe(true);
    expect(seen[0]).not.toBe(seen[1]);
    expect(bytesToHex(seen[1]!)).toBe('00'.repeat(64));
  });
});
