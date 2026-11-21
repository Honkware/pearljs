// Callers branch on error codes, so the codes are part of the API: each
// family keeps instanceof Error, carries the code for the case named in its
// docs, survives JSON, and holds no secret it was given.

import { bech32 } from 'bech32';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AddressError,
  PearlError,
  PearlRpcError,
  PolicyError,
  XmssError,
  checkStandard,
  createTransaction,
  decodeAddress,
  decodeWif,
  encodeAddress,
  encodeWif,
  generateMnemonic,
  mnemonicToSeed,
  networks,
  parsePearl,
  parsePsbt,
  parseTransaction,
  seedFromInput,
} from '../src/index.js';
import type { PearlErrorCode } from '../src/index.js';

function thrown(run: () => unknown): PearlError {
  try {
    run();
  } catch (err) {
    expect(err).toBeInstanceOf(PearlError);
    expect(err).toBeInstanceOf(Error);
    return err as PearlError;
  }
  throw new Error('nothing was thrown');
}

const program = new Uint8Array(32).fill(7);
const address = encodeAddress({ version: 1, program }, networks.mainnet);

describe('address errors', () => {
  const cases: [string, PearlErrorCode, string][] = [
    ['a damaged checksum', 'ADDRESS_BAD_CHECKSUM', `${address.slice(0, -1)}${address.endsWith('q') ? 'p' : 'q'}`],
    ['a bech32 (v0 checksum) encoding', 'ADDRESS_BAD_CHECKSUM', bech32.encode('prl', [1, ...bech32.toWords(program)])],
    ['text that is not bech32', 'ADDRESS_MALFORMED', 'not an address'],
    ['another network', 'ADDRESS_WRONG_NETWORK', encodeAddress({ version: 1, program }, networks.regtest)],
    ['witness version 3', 'ADDRESS_UNSUPPORTED_VERSION', bech32mWith(3, program)],
    ['a 20-byte program', 'ADDRESS_WRONG_LENGTH', bech32mWith(1, program.slice(0, 20))],
  ];
  for (const [what, code, text] of cases) {
    it(`gives ${code} for ${what}`, () => {
      const err = thrown(() => decodeAddress(text, networks.mainnet));
      expect(err).toBeInstanceOf(AddressError);
      expect(err.code).toBe(code);
    });
  }
});

function bech32mWith(version: number, bytes: Uint8Array): string {
  // encodeAddress refuses these, so they are built by rewriting a valid one.
  return bech32mEncode('prl', [version, ...bech32.toWords(bytes)]);
}

function bech32mEncode(prefix: string, words: number[]): string {
  // bech32m differs from bech32 only in the checksum constant.
  const charset = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  const expand = [...prefix].map((c) => c.charCodeAt(0) >> 5).concat(0, [...prefix].map((c) => c.charCodeAt(0) & 31));
  const polymod = (values: number[]): number => {
    const gen = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
    let chk = 1;
    for (const v of values) {
      const top = chk >>> 25;
      chk = ((chk & 0x1ffffff) << 5) ^ v;
      gen.forEach((g, i) => {
        if ((top >>> i) & 1) chk ^= g;
      });
    }
    return chk;
  };
  const mod = polymod([...expand, ...words, 0, 0, 0, 0, 0, 0]) ^ 0x2bc830a3;
  const checksum = Array.from({ length: 6 }, (_, i) => (mod >>> (5 * (5 - i))) & 31);
  return `${prefix}1${[...words, ...checksum].map((w) => charset[w]).join('')}`;
}

describe('codes of the other families', () => {
  it('names the amount, WIF, transaction and PSBT failures', () => {
    expect(thrown(() => parsePearl('1.123456789')).code).toBe('AMOUNT_INVALID');
    expect(thrown(() => parsePearl('21000000001')).code).toBe('AMOUNT_OUT_OF_RANGE');
    const wif = encodeWif(new Uint8Array(32).fill(1), networks.mainnet);
    expect(thrown(() => decodeWif(wif, networks.regtest)).code).toBe('WIF_WRONG_NETWORK');
    expect(thrown(() => decodeWif(`${wif.slice(0, -1)}${wif.endsWith('1') ? '2' : '1'}`, networks.mainnet)).code).toBe('WIF_BAD_CHECKSUM');
    expect(thrown(() => decodeWif('abc', networks.mainnet)).code).toBe('WIF_MALFORMED');
    expect(thrown(() => parseTransaction('zz')).code).toBe('TX_MALFORMED');
    expect(thrown(() => parsePsbt('AAAA')).code).toBe('PSBT_MALFORMED');
    expect(thrown(() => mnemonicToSeed('not a mnemonic')).code).toBe('MNEMONIC_INVALID');
  });

  it('gives a policy refusal a reason code and keeps pearld\'s text as the message', () => {
    const err = thrown(() => checkStandard(createTransaction()));
    expect(err).toBeInstanceOf(PolicyError);
    expect(err.code).toBe('POLICY_NO_WITNESS');
    expect(err.message).toBe('transaction has no witness data');
  });

  it('derives the code of an RPC error from its kind and keeps the server\'s number apart', () => {
    const err = new PearlRpcError('rpc', 'getblock', 'Block not found (code -5)', { rpcCode: -5 });
    expect(err).toMatchObject({ code: 'RPC_ERROR', rpcCode: -5, kind: 'rpc', method: 'getblock', name: 'PearlRpcError' });
    expect(new PearlRpcError('network', 'getblock', 'no reply').code).toBe('RPC_NETWORK');
    expect(err).toBeInstanceOf(PearlError);
  });
});

describe('serialization', () => {
  it('keeps the name, code and message through JSON and back', () => {
    const err = thrown(() => decodeAddress('nope', networks.mainnet));
    const json = JSON.parse(JSON.stringify(err)) as { name: string; code: PearlErrorCode; message: string };
    expect(json).toEqual({ name: 'AddressError', code: 'ADDRESS_MALFORMED', message: err.message });
    const back = PearlError.fromJSON(json);
    expect(back).toBeInstanceOf(PearlError);
    expect(back).toMatchObject({ code: 'ADDRESS_MALFORMED', message: err.message });
  });

  it('keeps the message through structuredClone, which drops the code', () => {
    const clone = structuredClone(new XmssError('XMSS_INDEX_EXHAUSTED', 'used up'));
    expect(clone).toBeInstanceOf(Error);
    expect(clone.message).toBe('used up');
    expect(structuredClone(new XmssError('XMSS_INDEX_EXHAUSTED', 'used up').toJSON()).code).toBe('XMSS_INDEX_EXHAUSTED');
  });
});

describe('secrets', () => {
  it('leaves the WIF and a mistyped mnemonic word out of what it throws', () => {
    const wif = encodeWif(new Uint8Array(32).fill(1), networks.mainnet);
    const damaged = `${wif.slice(0, -1)}${wif.endsWith('1') ? '2' : '1'}`;
    expect(JSON.stringify(thrown(() => decodeWif(damaged, networks.mainnet)))).not.toContain(damaged.slice(0, 20));
    const words = generateMnemonic().split(' ');
    const typo = [...words.slice(0, 11), 'zzzzsecret'].join(' ');
    const err = thrown(() => seedFromInput(typo));
    expect(err.code).toBe('SEED_INVALID');
    expect(err.message).toBe('invalid seed: a word is not in the BIP39 list');
    expect(thrown(() => mnemonicToSeed(typo)).message).toBe('invalid BIP39 mnemonic');
  });
});

describe('documentation', () => {
  it('lists every code in docs/reference/errors.md, and no code that does not exist', () => {
    const source = readFileSync(new URL('../src/errors.ts', import.meta.url), 'utf8');
    const union = source.slice(source.indexOf('export type PearlErrorCode'), source.indexOf('/** What toJSON returns'));
    const codes = [...union.matchAll(/'([A-Z0-9_]+)'/g)].map((m) => m[1]!).sort();
    const page = readFileSync(new URL('../docs/reference/errors.md', import.meta.url), 'utf8');
    const documented = [...new Set([...page.matchAll(/^\| `([A-Z0-9_]+)` \|/gm)].map((m) => m[1]!))].sort();
    expect(documented).toEqual(codes);
  });
});
