// Tapscript trees and control blocks for Pearl script-path spends.
//
// assembleScriptTree pairs leaves the way Pearl's Go
// AssembleTaprootScriptTree does, so the same scripts give the same root and
// inclusion proofs as Pearl. bitcoinjs's nested Taptree arrays describe a tree
// shape explicitly and are not used here.
//
// A Taproot control block is leafVersion|parity, the 32-byte internal key and
// the proof. A P2MR control block has no internal key: it is leafVersion|1
// followed by the proof, and the output commits to the Merkle root directly.

import * as ecc from 'tiny-secp256k1';
import { BASE_LEAF_VERSION, tapBranchHash, tapLeafHash, taggedHash } from './script.js';

const HASH_SIZE = 32;
const MAX_PROOF_NODES = 128;
const TAPROOT_CONTROL_BLOCK_BASE_SIZE = 1 + HASH_SIZE;
const P2MR_CONTROL_BLOCK_BASE_SIZE = 1;
const LEAF_VERSION_MASK = 0xfe;

export interface ScriptTreeLeaf {
  script: Uint8Array;
  leafVersion: number;
  leafHash: Uint8Array;
  /** Sibling hashes from the leaf up to the root, 32 bytes each. */
  proof: Uint8Array;
}

export interface ScriptTree {
  root: Uint8Array;
  leaves: ScriptTreeLeaf[];
}

interface TreeNode {
  hash: Uint8Array;
  leafIndices: number[];
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

/**
 * Builds a tapscript tree from leaf scripts in Pearl's order. Leaves are
 * paired left to right; an odd last leaf joins the previous pair; the pairs
 * are then merged as a queue until one root remains. All leaves use the base
 * leaf version 0xc0, the only version Pearl executes.
 *
 * Duplicate scripts are rejected: Pearl indexes proofs by leaf hash, so a
 * repeated leaf would get the wrong proof there.
 */
export function assembleScriptTree(scripts: readonly Uint8Array[]): ScriptTree {
  if (scripts.length === 0) {
    throw new Error('a script tree needs at least one leaf');
  }
  const leafHashes = scripts.map((script) => tapLeafHash(script));
  const seen = new Set<string>();
  for (const hash of leafHashes) {
    const key = toHex(hash);
    if (seen.has(key)) {
      throw new Error('script tree leaves must be distinct');
    }
    seen.add(key);
  }

  const proofs: Uint8Array[][] = scripts.map(() => []);
  const leafHash = (index: number): Uint8Array => leafHashes[index]!;
  let root: Uint8Array;

  if (scripts.length === 1) {
    root = leafHash(0);
  } else {
    const branches: TreeNode[] = [];
    for (let i = 0; i < scripts.length; i += 2) {
      if (i === scripts.length - 1) {
        const last = branches[branches.length - 1]!;
        proofs[i]!.push(last.hash);
        for (const index of last.leafIndices) {
          proofs[index]!.push(leafHash(i));
        }
        branches[branches.length - 1] = {
          hash: tapBranchHash(last.hash, leafHash(i)),
          leafIndices: [...last.leafIndices, i],
        };
        continue;
      }
      proofs[i]!.push(leafHash(i + 1));
      proofs[i + 1]!.push(leafHash(i));
      branches.push({
        hash: tapBranchHash(leafHash(i), leafHash(i + 1)),
        leafIndices: [i, i + 1],
      });
    }
    while (branches.length > 1) {
      const left = branches.shift()!;
      const right = branches.shift()!;
      for (const index of left.leafIndices) proofs[index]!.push(right.hash);
      for (const index of right.leafIndices) proofs[index]!.push(left.hash);
      branches.push({
        hash: tapBranchHash(left.hash, right.hash),
        leafIndices: [...left.leafIndices, ...right.leafIndices],
      });
    }
    root = branches[0]!.hash;
  }

  return {
    root,
    leaves: scripts.map((script, index) => {
      const proof = concat(proofs[index]!);
      if (proof.length > MAX_PROOF_NODES * HASH_SIZE) {
        throw new Error(`script tree is deeper than ${MAX_PROOF_NODES} levels`);
      }
      return {
        script: Uint8Array.from(script),
        leafVersion: BASE_LEAF_VERSION,
        leafHash: leafHash(index),
        proof,
      };
    }),
  };
}

function treeLeaf(tree: ScriptTree, leafIndex: number): ScriptTreeLeaf {
  const leaf = Number.isInteger(leafIndex) ? tree.leaves[leafIndex] : undefined;
  if (leaf === undefined) {
    throw new RangeError(`script tree has no leaf ${leafIndex}`);
  }
  return leaf;
}

/**
 * Taproot output key for an internal key and optional script tree root,
 * with the parity bit a control block needs. Without a root this is the
 * BIP86 key-path tweak.
 */
export function taprootOutputKey(
  internalPubkey: Uint8Array,
  merkleRoot?: Uint8Array,
): { outputKey: Uint8Array; parity: 0 | 1 } {
  if (internalPubkey.length !== HASH_SIZE || !ecc.isXOnlyPoint(internalPubkey)) {
    throw new Error('internal pubkey must be a valid 32-byte x-only key');
  }
  if (merkleRoot !== undefined && merkleRoot.length !== HASH_SIZE) {
    throw new Error(`merkle root must be ${HASH_SIZE} bytes, got ${merkleRoot.length}`);
  }
  const tweak = taggedHash(
    'TapTweak',
    concat(merkleRoot === undefined ? [internalPubkey] : [internalPubkey, merkleRoot]),
  );
  const tweaked = ecc.xOnlyPointAddTweak(internalPubkey, tweak);
  if (tweaked === null) {
    throw new Error('taproot tweak produced an invalid output key');
  }
  return { outputKey: Uint8Array.from(tweaked.xOnlyPubkey), parity: tweaked.parity };
}

/** Control block for spending one leaf of a P2TR output by script path. */
export function taprootControlBlock(
  internalPubkey: Uint8Array,
  tree: ScriptTree,
  leafIndex: number,
): Uint8Array {
  const leaf = treeLeaf(tree, leafIndex);
  const { parity } = taprootOutputKey(internalPubkey, tree.root);
  return concat([Uint8Array.of(leaf.leafVersion | parity), internalPubkey, leaf.proof]);
}

/** Control block for spending one leaf of a P2MR output. */
export function p2mrControlBlock(tree: ScriptTree, leafIndex: number): Uint8Array {
  const leaf = treeLeaf(tree, leafIndex);
  return concat([Uint8Array.of(leaf.leafVersion | 1), leaf.proof]);
}

export interface TaprootControlBlock {
  leafVersion: number;
  outputKeyYIsOdd: boolean;
  internalPubkey: Uint8Array;
  proof: Uint8Array;
}

export interface P2mrControlBlock {
  leafVersion: number;
  proof: Uint8Array;
}

function checkControlBlockSize(bytes: Uint8Array, baseSize: number, what: string): void {
  const maxSize = baseSize + MAX_PROOF_NODES * HASH_SIZE;
  if (bytes.length < baseSize) {
    throw new Error(`${what} control block is ${bytes.length} bytes, min is ${baseSize}`);
  }
  if (bytes.length > maxSize) {
    throw new Error(`${what} control block is ${bytes.length} bytes, max is ${maxSize}`);
  }
  if ((bytes.length - baseSize) % HASH_SIZE !== 0) {
    throw new Error(`${what} control block proof is not a multiple of ${HASH_SIZE} bytes`);
  }
}

/** Parses a Taproot control block with the checks of Pearl's ParseControlBlock. */
export function parseTaprootControlBlock(bytes: Uint8Array): TaprootControlBlock {
  checkControlBlockSize(bytes, TAPROOT_CONTROL_BLOCK_BASE_SIZE, 'taproot');
  const internalPubkey = bytes.slice(1, TAPROOT_CONTROL_BLOCK_BASE_SIZE);
  if (!ecc.isXOnlyPoint(internalPubkey)) {
    throw new Error('taproot control block internal key is not a valid x-only key');
  }
  return {
    leafVersion: bytes[0]! & LEAF_VERSION_MASK,
    outputKeyYIsOdd: (bytes[0]! & 1) === 1,
    internalPubkey,
    proof: bytes.slice(TAPROOT_CONTROL_BLOCK_BASE_SIZE),
  };
}

/**
 * Parses a P2MR control block with the checks of Pearl's
 * ParseMerkleRootControlBlock, including the required parity bit of 1.
 */
export function parseP2mrControlBlock(bytes: Uint8Array): P2mrControlBlock {
  checkControlBlockSize(bytes, P2MR_CONTROL_BLOCK_BASE_SIZE, 'P2MR');
  if ((bytes[0]! & 1) !== 1) {
    throw new Error('P2MR control block parity bit must be 1');
  }
  return {
    leafVersion: bytes[0]! & LEAF_VERSION_MASK,
    proof: bytes.slice(P2MR_CONTROL_BLOCK_BASE_SIZE),
  };
}

/** Merkle root reached by hashing a revealed leaf up through its proof. */
export function rootFromProof(
  leafVersion: number,
  proof: Uint8Array,
  script: Uint8Array,
): Uint8Array {
  if (proof.length % HASH_SIZE !== 0) {
    throw new Error(`proof length must be a multiple of ${HASH_SIZE} bytes`);
  }
  let node = tapLeafHash(script, leafVersion);
  for (let offset = 0; offset < proof.length; offset += HASH_SIZE) {
    node = tapBranchHash(node, proof.slice(offset, offset + HASH_SIZE));
  }
  return node;
}

/**
 * Checks that a control block and leaf script open a P2TR output, as Pearl's
 * VerifyTaprootLeafCommitment does: the derived output key must equal the
 * witness program and its parity must match the control block.
 */
export function verifyTaprootLeafCommitment(
  controlBlock: Uint8Array,
  witnessProgram: Uint8Array,
  script: Uint8Array,
): void {
  const parsed = parseTaprootControlBlock(controlBlock);
  const root = rootFromProof(parsed.leafVersion, parsed.proof, script);
  const { outputKey, parity } = taprootOutputKey(parsed.internalPubkey, root);
  if (!equalBytes(outputKey, witnessProgram)) {
    throw new Error('taproot merkle proof does not match the witness program');
  }
  if (parsed.outputKeyYIsOdd !== (parity === 1)) {
    throw new Error('taproot control block output key parity does not match');
  }
}

/**
 * Checks that a control block and leaf script open a P2MR output, as Pearl's
 * VerifyMerkleRootLeafCommitment does: the computed root must equal the
 * witness program.
 */
export function verifyP2mrLeafCommitment(
  controlBlock: Uint8Array,
  witnessProgram: Uint8Array,
  script: Uint8Array,
): void {
  const parsed = parseP2mrControlBlock(controlBlock);
  const root = rootFromProof(parsed.leafVersion, parsed.proof, script);
  if (!equalBytes(root, witnessProgram)) {
    throw new Error('P2MR merkle proof does not match the witness program');
  }
}
