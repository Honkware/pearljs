// Payment constructors for the output types Pearl supports: P2TR (witness
// v1), P2MR (witness v2, BIP 360) and OP_RETURN data embeds. Pearl has no
// p2pkh, p2sh, p2wpkh, p2wsh or multisig template, so none is offered here.

/**
 * P2TR, P2MR and OP_RETURN output scripts, the only outputs Pearl has.
 *
 * @module
 */

import { initEccLib, payments } from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { WITNESS_PROGRAM_LENGTH } from './address.js';
import { scriptPush } from './script.js';
import { PearlError } from './errors.js';

initEccLib(ecc);

// txscript.MaxDataCarrierSize.
/** The most data bytes embed puts in an OP_RETURN output (txscript.MaxDataCarrierSize). */
export const MAX_EMBED_DATA_SIZE = 80;

const OP_RETURN = 0x6a;
const OP_2 = 0x52;

/** A P2TR output: `output` is the script OP_1 <tweaked key>. */
export interface P2trPayment {
  name: 'p2tr';
  internalPubkey: Uint8Array;
  /** Script tree root, present when the output commits to a tree. */
  merkleRoot?: Uint8Array;
  output: Uint8Array;
}

/** A P2MR output: `output` is the script OP_2 <root>. */
export interface P2mrPayment {
  name: 'p2mr';
  merkleRoot: Uint8Array;
  output: Uint8Array;
}

/** An OP_RETURN output carrying `data`. */
export interface EmbedPayment {
  name: 'embed';
  data: Uint8Array;
  output: Uint8Array;
}

function checkProgram(bytes: Uint8Array, what: string): void {
  if (bytes.length !== WITNESS_PROGRAM_LENGTH) {
    throw new Error(
      `${what} must be ${WITNESS_PROGRAM_LENGTH} bytes, got ${bytes.length}`,
    );
  }
}

/**
 * P2TR from a 32-byte x-only internal key and, for outputs with script
 * paths, the root of a tree from assembleScriptTree. The output script is
 * OP_1 <tweaked key>; the tweak is computed by bitcoinjs with tiny-secp256k1.
 */
export function p2tr(args: { internalPubkey: Uint8Array; merkleRoot?: Uint8Array }): P2trPayment {
  checkProgram(args.internalPubkey, 'internal pubkey');
  if (args.merkleRoot !== undefined) checkProgram(args.merkleRoot, 'merkle root');
  const payment = payments.p2tr(
    args.merkleRoot === undefined
      ? { internalPubkey: args.internalPubkey }
      : { internalPubkey: args.internalPubkey, hash: args.merkleRoot },
  );
  // bitcoinjs computes the tweak lazily, so touch output to surface an
  // invalid internal key here instead of at the call site later.
  const output = payment.output;
  if (output === undefined) {
    throw new PearlError('KEY_INVALID', 'p2tr: could not derive output script');
  }
  return {
    name: 'p2tr',
    internalPubkey: Uint8Array.from(args.internalPubkey),
    ...(args.merkleRoot === undefined ? {} : { merkleRoot: Uint8Array.from(args.merkleRoot) }),
    output: Uint8Array.from(output),
  };
}

/** P2MR from a 32-byte Merkle root. The output script is OP_2 <root>. */
export function p2mr(args: { merkleRoot: Uint8Array }): P2mrPayment {
  checkProgram(args.merkleRoot, 'merkle root');
  return {
    name: 'p2mr',
    merkleRoot: Uint8Array.from(args.merkleRoot),
    output: Uint8Array.from([OP_2, WITNESS_PROGRAM_LENGTH, ...args.merkleRoot]),
  };
}

/**
 * Provably-prunable OP_RETURN output carrying up to 80 bytes of data, the
 * standardness limit in txscript.MaxDataCarrierSize. The script after
 * OP_RETURN is push-only by construction.
 */
export function embed(args: { data: Uint8Array }): EmbedPayment {
  if (args.data.length > MAX_EMBED_DATA_SIZE) {
    throw new PearlError('SCRIPT_INVALID',
      `embed data of ${args.data.length} bytes exceeds ${MAX_EMBED_DATA_SIZE}`,
    );
  }
  return {
    name: 'embed',
    data: Uint8Array.from(args.data),
    output: Uint8Array.from([OP_RETURN, ...scriptPush(args.data)]),
  };
}
