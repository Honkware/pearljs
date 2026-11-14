import { bech32, bech32m } from 'bech32';
import { describe, expect, it } from 'vitest';
import {
  addressInfo,
  decodeAddress,
  encodeAddress,
  fromOutputScript,
  isValidAddress,
  toOutputScript,
} from '../src/address.js';
import { mainnet, regtest, simnet, testnet, testnet2 } from '../src/networks.js';
import vectors from '../vectors/pearl-go.json' with { type: 'json' };

const hex = (u: Uint8Array) => Buffer.from(u).toString('hex');
const unhex = (s: string) => Uint8Array.from(Buffer.from(s, 'hex'));

// Fixed test program: bytes 0x00 through 0x1f.
const program = Uint8Array.from({ length: 32 }, (_, i) => i);

// Self-roundtrip: these addresses were produced by this implementation and
// are pinned as regression guards, not as independent Pearl vectors. The
// lead adds Go-generated vectors separately.
const V1_MAINNET = 'prl1pqqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0ss8729k';
const V2_MAINNET = 'prl1zqqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0sc689ta';

describe('encodeAddress', () => {
  it('encodes a v1 program as bech32m with the network HRP', () => {
    expect(encodeAddress({ version: 1, program }, mainnet)).toBe(V1_MAINNET);
  });

  it('encodes a v2 program as bech32m with the network HRP', () => {
    expect(encodeAddress({ version: 2, program }, mainnet)).toBe(V2_MAINNET);
  });

  it('rejects witness version 0 and versions above 2', () => {
    for (const version of [-1, 0, 3, 16]) {
      expect(() => encodeAddress({ version, program }, mainnet)).toThrow(
        /unsupported witness version/,
      );
    }
  });

  it('rejects programs that are not exactly 32 bytes', () => {
    for (const len of [0, 20, 31, 33, 64]) {
      expect(() =>
        encodeAddress({ version: 1, program: new Uint8Array(len) }, mainnet),
      ).toThrow(/32 bytes/);
    }
  });
});

describe('decodeAddress', () => {
  it('round-trips v1 and v2 on every network HRP (self-roundtrip)', () => {
    const networks = [mainnet, testnet, regtest];
    for (const network of networks) {
      for (const version of [1, 2]) {
        const address = encodeAddress({ version, program }, network);
        const decoded = decodeAddress(address, network);
        expect(decoded.version).toBe(version);
        expect(hex(decoded.program)).toBe(hex(program));
      }
    }
  });

  it('decodes an all-uppercase address per BIP 173', () => {
    const decoded = decodeAddress(V1_MAINNET.toUpperCase(), mainnet);
    expect(decoded.version).toBe(1);
    expect(hex(decoded.program)).toBe(hex(program));
  });

  it('rejects an address from another network', () => {
    expect(() => decodeAddress(V1_MAINNET, testnet)).toThrow(/prefix/);
    const testnetAddr = encodeAddress({ version: 1, program }, testnet);
    expect(() => decodeAddress(testnetAddr, mainnet)).toThrow(/prefix/);
  });

  it('rejects mixed-case addresses', () => {
    const mixed = 'prl1pQqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0ss8729k';
    expect(() => decodeAddress(mixed, mainnet)).toThrow();
  });

  it('rejects a bech32 (not bech32m) v0 address', () => {
    const v0 = bech32.encode('prl', [0, ...bech32.toWords(program.slice(0, 20))]);
    expect(() => decodeAddress(v0, mainnet)).toThrow();
  });

  it('rejects a v0 address even with a bech32m checksum', () => {
    const v0m = bech32m.encode('prl', [0, ...bech32m.toWords(program.slice(0, 20))]);
    expect(() => decodeAddress(v0m, mainnet)).toThrow(
      /unsupported witness version/,
    );
  });

  it('rejects witness versions above 2', () => {
    const v3 = bech32m.encode('prl', [3, ...bech32m.toWords(program)]);
    expect(() => decodeAddress(v3, mainnet)).toThrow(
      /unsupported witness version/,
    );
  });

  it('rejects a corrupted checksum', () => {
    const corrupted = V1_MAINNET.slice(0, -1) + (V1_MAINNET.endsWith('q') ? 'p' : 'q');
    expect(() => decodeAddress(corrupted, mainnet)).toThrow();
  });

  it('rejects witness programs of the wrong length', () => {
    for (const len of [31, 33]) {
      const addr = bech32m.encode('prl', [
        1,
        ...bech32m.toWords(new Uint8Array(len)),
      ]);
      expect(() => decodeAddress(addr, mainnet)).toThrow(/32 bytes/);
    }
  });

  it('rejects invalid 5-bit padding', () => {
    // 31 bytes convert to 50 words; one extra zero word leaves 7 excess
    // bits, which strict fromWords rejects as bad padding.
    const words = [1, ...bech32m.toWords(new Uint8Array(31)), 0];
    const addr = bech32m.encode('prl', words);
    expect(() => decodeAddress(addr, mainnet)).toThrow();
  });

  it('rejects base58 and other non-bech32 strings', () => {
    for (const bad of [
      '1BoatSLRHtKNngkdXEeobR76b53LETtpyT',
      '',
      'prl',
      'prl1',
      'xprl1pqqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0ss8729k',
    ]) {
      expect(() => decodeAddress(bad, mainnet)).toThrow();
    }
  });

  it('returns program bytes that are safe to mutate', () => {
    const decoded = decodeAddress(V1_MAINNET, mainnet);
    decoded.program.fill(0xff);
    const again = decodeAddress(V1_MAINNET, mainnet);
    expect(hex(again.program)).toBe(hex(program));
  });
});

describe('toOutputScript', () => {
  it('builds OP_1 <program> for a v1 address', () => {
    const script = toOutputScript(V1_MAINNET, mainnet);
    expect(hex(script)).toBe(`5120${hex(program)}`);
  });

  it('builds OP_2 <program> for a v2 address', () => {
    const script = toOutputScript(V2_MAINNET, mainnet);
    expect(hex(script)).toBe(`5220${hex(program)}`);
  });

  it('returns a fresh copy on each call', () => {
    const a = toOutputScript(V1_MAINNET, mainnet);
    a.fill(0);
    const b = toOutputScript(V1_MAINNET, mainnet);
    expect(hex(b)).toBe(`5120${hex(program)}`);
  });

  it('rejects addresses from another network', () => {
    expect(() => toOutputScript(V1_MAINNET, testnet)).toThrow(/prefix/);
  });
});

describe('fromOutputScript', () => {
  it('parses v1 and v2 witness scripts back to addresses', () => {
    expect(fromOutputScript(unhex(`5120${hex(program)}`), mainnet)).toBe(
      V1_MAINNET,
    );
    expect(fromOutputScript(unhex(`5220${hex(program)}`), mainnet)).toBe(
      V2_MAINNET,
    );
  });

  it('round-trips through toOutputScript (self-roundtrip)', () => {
    for (const address of [V1_MAINNET, V2_MAINNET]) {
      expect(fromOutputScript(toOutputScript(address, mainnet), mainnet)).toBe(
        address,
      );
    }
  });

  it('rejects scripts that are not v1/v2 witness programs', () => {
    const prog = hex(program);
    for (const script of [
      `0020${prog}`, // v0
      `5320${prog}`, // v4
      `511f${prog.slice(0, 62)}`, // v1 with a 31-byte push
      `5121${prog}00`, // v1 with a 33-byte push
      `6a20${prog}`, // OP_RETURN push
      `5120${prog}00`, // trailing byte
      '51', // truncated
      '',
    ]) {
      expect(() => fromOutputScript(unhex(script), mainnet)).toThrow(
        /not a pearl witness program/,
      );
    }
  });
});

describe('isValidAddress', () => {
  it('accepts every address Go encoded, on its own network', () => {
    const byName = { mainnet, testnet, testnet2, regtest, simnet };
    for (const vector of vectors.addresses) {
      const network = byName[vector.network as keyof typeof byName];
      expect(isValidAddress(vector.address, network)).toBe(true);
      expect(isValidAddress(vector.address, network === mainnet ? regtest : mainnet)).toBe(false);
    }
  });

  it('returns false where decodeAddress throws', () => {
    const v0 = bech32.encode('prl', [0, ...bech32.toWords(program)]);
    const v3 = bech32m.encode('prl', [3, ...bech32m.toWords(program)]);
    const short = bech32m.encode('prl', [1, ...bech32m.toWords(program.slice(0, 20))]);
    for (const bad of ['', 'prl1', 'not an address', V1_MAINNET.toUpperCase().replace('PRL1', 'prl1'), `${V1_MAINNET.slice(0, -1)}q`, v0, v3, short]) {
      expect(isValidAddress(bad, mainnet)).toBe(false);
    }
    expect(isValidAddress(undefined as unknown as string, mainnet)).toBe(false);
  });
});

describe('addressInfo', () => {
  it('names the type and network of a mainnet address', () => {
    expect(addressInfo(V1_MAINNET)).toEqual({ type: 'p2tr', networks: ['mainnet'], program });
    expect(addressInfo(V2_MAINNET)).toEqual({ type: 'p2mr', networks: ['mainnet'], program });
  });

  it('names both networks that share a prefix', () => {
    expect(addressInfo(encodeAddress({ version: 1, program }, testnet))?.networks).toEqual(['testnet', 'testnet2']);
    expect(addressInfo(encodeAddress({ version: 2, program }, testnet2))?.networks).toEqual(['testnet', 'testnet2']);
    expect(addressInfo(encodeAddress({ version: 1, program }, regtest))?.networks).toEqual(['regtest', 'simnet']);
    expect(addressInfo(encodeAddress({ version: 1, program }, simnet))?.networks).toEqual(['regtest', 'simnet']);
  });

  it('agrees with Go on the type of every vector address', () => {
    for (const vector of vectors.addresses) {
      const info = addressInfo(vector.address);
      expect(info?.type).toBe(vector.kind);
      expect(info?.networks).toContain(vector.network);
      expect(hex(info!.program)).toBe(vector.program);
    }
  });

  it('returns null for anything that is not a Pearl address', () => {
    const bitcoin = bech32m.encode('bc', [1, ...bech32m.toWords(program)]);
    const v0 = bech32.encode('prl', [0, ...bech32.toWords(program)]);
    for (const bad of ['', 'hello', bitcoin, v0, `${V1_MAINNET}x`]) {
      expect(addressInfo(bad)).toBeNull();
    }
  });
});
