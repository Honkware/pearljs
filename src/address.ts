// Pearl witness addresses. Pearl supports exactly two address types, both
// bech32m per BIP 350: witness v1 P2TR (32-byte tweaked key) and witness
// v2 P2MR (32-byte Merkle root). There is no base58, v0 or v3+ address on
// Pearl, so all of those are rejected on decode.

import { bech32m } from 'bech32';
import type { PearlNetwork } from './networks.js';

export interface WitnessAddress {
  version: number;
  program: Uint8Array;
}

export const WITNESS_PROGRAM_LENGTH = 32;
const MIN_WITNESS_VERSION = 1;
const MAX_WITNESS_VERSION = 2;

/** Encodes a witness v1/v2 address as bech32m for the given network. */
export function encodeAddress(
  address: WitnessAddress,
  network: PearlNetwork,
): string {
  const { version, program } = address;
  if (!Number.isInteger(version) || version < MIN_WITNESS_VERSION || version > MAX_WITNESS_VERSION) {
    throw new Error(`unsupported witness version: ${version}`);
  }
  if (program.length !== WITNESS_PROGRAM_LENGTH) {
    throw new Error(
      `witness program must be ${WITNESS_PROGRAM_LENGTH} bytes, got ${program.length}`,
    );
  }
  return bech32m.encode(network.bech32Hrp, [version, ...bech32m.toWords(program)]);
}

/**
 * Decodes a bech32m address for the given network. Throws on bech32 (v0)
 * checksums, witness versions other than 1 and 2, mixed case, bad padding,
 * wrong program length, and addresses for a different network.
 */
export function decodeAddress(
  address: string,
  network: PearlNetwork,
): WitnessAddress {
  let decoded;
  try {
    decoded = bech32m.decode(address);
  } catch (err) {
    throw new Error(
      `invalid pearl address: ${err instanceof Error ? err.message : err}`,
    );
  }
  if (decoded.prefix !== network.bech32Hrp) {
    throw new Error(
      `address prefix ${decoded.prefix} is not for ${network.name}`,
    );
  }
  const version = decoded.words[0];
  if (version === undefined || version < MIN_WITNESS_VERSION || version > MAX_WITNESS_VERSION) {
    throw new Error(`unsupported witness version: ${version}`);
  }
  let program;
  try {
    program = bech32m.fromWords(decoded.words.slice(1));
  } catch (err) {
    throw new Error(
      `invalid witness program: ${err instanceof Error ? err.message : err}`,
    );
  }
  if (program.length !== WITNESS_PROGRAM_LENGTH) {
    throw new Error(
      `witness program must be ${WITNESS_PROGRAM_LENGTH} bytes, got ${program.length}`,
    );
  }
  return { version, program: Uint8Array.from(program) };
}

/** Builds the output script OP_n <32-byte program> for a Pearl address. */
export function toOutputScript(
  address: string,
  network: PearlNetwork,
): Uint8Array {
  const { version, program } = decodeAddress(address, network);
  // OP_1 is 0x51; witness version n is OP_n = 0x50 + n.
  return Uint8Array.from([0x50 + version, WITNESS_PROGRAM_LENGTH, ...program]);
}

/** Parses a v1/v2 witness output script back into a bech32m address. */
export function fromOutputScript(
  script: Uint8Array,
  network: PearlNetwork,
): string {
  const opcode = script[0];
  if (
    script.length !== WITNESS_PROGRAM_LENGTH + 2 ||
    (opcode !== 0x50 + MIN_WITNESS_VERSION && opcode !== 0x50 + MAX_WITNESS_VERSION) ||
    script[1] !== WITNESS_PROGRAM_LENGTH
  ) {
    throw new Error('output script is not a pearl witness program');
  }
  const program = Uint8Array.from(script.subarray(2));
  return encodeAddress({ version: opcode - 0x50, program }, network);
}
