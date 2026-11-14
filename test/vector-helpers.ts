import vectors from '../vectors/pearl-go.json' with { type: 'json' };
import { networks, toOutputScript } from '../src/index.js';
import type { PearlNetwork } from '../src/index.js';

export function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}

export function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

export function networkNamed(name: string): PearlNetwork {
  const network = (networks as Record<string, PearlNetwork>)[name];
  if (network === undefined) throw new Error(`unknown vector network: ${name}`);
  return network;
}

export function scriptFromVectors(name: string, kind: string): Uint8Array {
  const vector = vectors.addresses.find(
    (item) => item.network === name && item.kind === kind,
  );
  if (vector === undefined) throw new Error(`missing ${kind} vector for ${name}`);
  return toOutputScript(vector.address, networkNamed(name));
}
