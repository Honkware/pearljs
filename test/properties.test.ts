// Property tests over generated and mutated input: whatever a parser accepts
// it writes back unchanged, whatever it refuses it refuses with an error of
// its own and not one the engine raised, and no mutant verifies or decodes as
// something else. The generator is seeded, so a failure repeats.
//
//   PEARLJS_PROPERTY_RUNS=20000 npm test -- test/properties.test.ts
//   PEARLJS_PROPERTY_SEED=7     another stream of cases

import { describe, expect, it, vi } from 'vitest';
import {
  MAX_GRAIN,
  PearlError,
  assembleScriptTree,
  classifyOutputScript,
  compileScript,
  decodeAddress,
  decodeScriptNumber,
  decodeWif,
  decompileScript,
  encodeAddress,
  encodeScriptNumber,
  encodeWif,
  extractWitnessProgram,
  finalizePsbt,
  formatPearl,
  fromOutputScript,
  isPushOnlyScript,
  keyPathAddress,
  networks,
  p2mr,
  p2mrControlBlock,
  p2tr,
  parseBlock,
  parseBlockHeader,
  parseMultiA,
  parsePearl,
  parsePsbt,
  parseTransaction,
  scriptFromAsm,
  scriptToAsm,
  serializeBlock,
  serializeBlockHeader,
  serializeTransaction,
  signMessage,
  taprootControlBlock,
  toOutputScript,
  verifyMessage,
  verifyP2mrLeafCommitment,
  verifyTaprootLeafCommitment,
  xmssVerify,
} from '../src/index.js';
import { decimalToGrain, parseJson } from '../src/internal/rpc-wire.js';
import vectors from '../vectors/pearl-go.json' with { type: 'json' };
import { bytesToHex as hex, hexToBytes as unhex } from './vector-helpers.js';

const RUNS = Number(process.env.PEARLJS_PROPERTY_RUNS ?? 300);
const SEED = Number(process.env.PEARLJS_PROPERTY_SEED ?? 1);
// Long runs need more than the suite's default, in ms.
const TIMEOUT = Math.max(30_000, RUNS * 40);
vi.setConfig({ testTimeout: TIMEOUT });

/** A seeded generator (mulberry32), one stream per property so adding a property leaves the others' cases alone. */
function rng(stream: number): () => number {
  let state = (SEED * 0x9e3779b1 + stream) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
type Random = () => number;
const int = (r: Random, n: number): number => Math.floor(r() * n);
const pick = <T>(r: Random, items: readonly T[]): T => items[int(r, items.length)]!;
const bytes = (r: Random, n: number): Uint8Array => Uint8Array.from({ length: n }, () => int(r, 256));

function mutateBytes(r: Random, source: Uint8Array): Uint8Array {
  let b: Uint8Array = Uint8Array.from(source);
  for (let i = 1 + int(r, 3); i > 0; i -= 1) {
    if (b.length === 0) {
      b = bytes(r, 1 + int(r, 8));
      continue;
    }
    const at = int(r, b.length);
    const kind = int(r, 6);
    if (kind === 0) b[at] = b[at]! ^ (1 << int(r, 8));
    else if (kind === 1) b[at] = pick(r, [0, 0xff, 0xfd, 0xfe, 0x7f, 0x80]);
    else if (kind === 2) b = b.slice(0, at);
    else if (kind === 3) b = Uint8Array.from([...b.slice(0, at), ...bytes(r, 1 + int(r, 9)), ...b.slice(at)]);
    else if (kind === 4) b = Uint8Array.from([...b.slice(0, at), ...b.slice(Math.min(b.length, at + 1 + int(r, 5)))]);
    else b = Uint8Array.from([...b, ...bytes(r, 1 + int(r, 5))]);
  }
  return b;
}

function mutateString(r: Random, text: string, alphabet: string): string {
  const chars = [...text];
  for (let i = 1 + int(r, 3); i > 0; i -= 1) {
    const at = int(r, chars.length + 1);
    const kind = int(r, 5);
    const char = alphabet[int(r, alphabet.length)]!;
    if (kind === 0) chars[at] = char;
    else if (kind === 1) chars.splice(at, 0, char);
    else if (kind === 2) chars.splice(at, 1);
    else if (kind === 3 && chars[at] !== undefined) chars[at] = chars[at].toUpperCase();
    else chars.splice(at, 0, pick(r, [' ', '\n', '\0', 'é', '1']));
  }
  return chars.join('');
}

// Messages only the JavaScript engine writes. One of these from a parser means it read past its checks.
const ENGINE =
  /Cannot read properties|is not a function|is not iterable|Invalid typed array length|Invalid array length|Maximum call stack|Cannot mix BigInt|Cannot convert .* to a BigInt|Invalid array buffer length|offset is out of bounds|is not defined|Invalid string length|Start offset .* is outside/;

/** The value, or null when run refused its input in an orderly way. Fails the test on anything else. */
function accepted<T>(run: () => T, input: string): T | null {
  try {
    return run();
  } catch (err) {
    expect(err, input).toBeInstanceOf(Error);
    expect((err as Error).message, input).not.toMatch(ENGINE);
    return null;
  }
}

const nets = Object.values(networks);
const BECH32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

describe(`properties (${RUNS} runs, seed ${SEED})`, () => {
  it('addresses round-trip, and a mutated address decodes to itself or not at all', () => {
    const r = rng(1);
    for (let i = 0; i < RUNS; i += 1) {
      const net = pick(r, nets);
      const version = 1 + int(r, 2);
      const program = bytes(r, 32);
      const address = encodeAddress({ version, program }, net);
      expect(decodeAddress(address, net)).toEqual({ version, program });
      expect(hex(toOutputScript(address, net))).toBe(hex(Uint8Array.from([0x50 + version, 32, ...program])));
      expect(fromOutputScript(toOutputScript(address, net), net)).toBe(address);

      const mutant = i % 3 === 0 ? address.toUpperCase() : mutateString(r, address, `${BECH32}1bio`);
      const decoded = accepted(() => decodeAddress(mutant, net), mutant);
      if (decoded !== null) expect(encodeAddress(decoded, net), mutant).toBe(mutant.toLowerCase());
      for (const other of nets) {
        if (other.bech32Hrp !== net.bech32Hrp) expect(() => decodeAddress(address, other)).toThrow(PearlError);
      }
      const script = mutateBytes(r, toOutputScript(address, net));
      const back = accepted(() => fromOutputScript(script, net), hex(script));
      if (back !== null) expect(hex(toOutputScript(back, net))).toBe(hex(script));
    }
  });

  it('WIF keys round-trip, a mutant decodes to itself or not at all, and no refusal repeats the key', () => {
    const r = rng(2);
    for (let i = 0; i < RUNS; i += 1) {
      const net = pick(r, nets);
      const key = bytes(r, 32);
      key[0] = key[0]! & 0x7f;
      if (key.every((byte) => byte === 0)) key[31] = 1;
      const compressed = r() < 0.7;
      const wif = encodeWif(key, net, compressed);
      expect(decodeWif(wif, net)).toEqual({ privateKey: key, compressed });
      for (const other of nets) {
        if (other.wif !== net.wif) expect(() => decodeWif(wif, other)).toThrow(PearlError);
      }
      const mutant = mutateString(r, wif, `${BASE58}0OIl`);
      try {
        const decoded = decodeWif(mutant, net);
        expect(encodeWif(decoded.privateKey, net, decoded.compressed), mutant).toBe(mutant);
      } catch (err) {
        const { message } = err as Error;
        expect(message).not.toMatch(ENGINE);
        expect(message.includes(wif) || message.includes(mutant) || message.includes(hex(key))).toBe(false);
      }
    }
  });

  it('amounts round-trip through text, and RPC decimals convert exactly', () => {
    const r = rng(3);
    // Round half away from zero at the eighth decimal, in exact arithmetic.
    const reference = (text: string): bigint => {
      const [, sign, whole, frac = '', exp = '0'] = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text)!;
      let numerator = BigInt(whole! + frac);
      let denominator = 10n ** BigInt(frac.length);
      const shift = Number(exp) + 8;
      if (shift >= 0) numerator *= 10n ** BigInt(shift);
      else denominator *= 10n ** BigInt(-shift);
      const grain = numerator / denominator + ((numerator % denominator) * 2n >= denominator ? 1n : 0n);
      return sign === '-' ? -grain : grain;
    };
    for (let i = 0; i < RUNS; i += 1) {
      const grain = (BigInt(int(r, 2 ** 32)) * BigInt(int(r, 2 ** 29))) % (MAX_GRAIN + 1n);
      expect(parsePearl(formatPearl(grain))).toBe(grain);
      expect(decimalToGrain(formatPearl(grain))).toBe(grain);

      const whole = String(int(r, pick(r, [10, 1000, 1e9, 2.2e10])));
      const frac = r() < 0.7 ? `.${Array.from({ length: 1 + int(r, 12) }, () => int(r, 10)).join('')}` : '';
      const exp = r() < 0.4 ? `e${int(r, 25) - 14}` : '';
      const text = `${r() < 0.2 ? '-' : ''}${whole}${frac}${exp}`;
      const want = reference(text);
      if ((want < 0n ? -want : want) <= MAX_GRAIN) expect(decimalToGrain(text), text).toBe(want);
      else expect(() => decimalToGrain(text), text).toThrow(PearlError);
    }
    for (const bad of ['', ' 1', '1 ', '+1', '-1', '1.', '.5', '1e3', '0x10', '1,5', '１', '1.123456789', '1\n', 'NaN', 'Infinity', '00000001', '1_000']) {
      expect(() => parsePearl(bad), JSON.stringify(bad)).toThrow(PearlError);
    }
  });

  it('parseJson agrees with JSON.parse apart from the amounts it is asked to convert', () => {
    const r = rng(4);
    const keys = ['value', 'amount', 'fee', 'result', 'a', 'va"lue', 'x:y', 'value\\', '1', '-', 'e'];
    const strings = ['value', '":1.5', '\\', '"', 'a:1', '1.5', '-', '{"value":2}', ' ', 'é', '\\"value\\":3'];
    const amountKeys = new Set(['value', 'amount', 'fee', 'result']);
    const generate = (depth: number): unknown => {
      const kind = int(r, depth > 3 ? 5 : 8);
      if (kind === 0) return int(r, 1000);
      if (kind === 1) return Number((r() * 100).toFixed(int(r, 9)));
      if (kind === 2) return pick(r, strings);
      if (kind === 3) return pick(r, [null, true, false]);
      // Never -0, which JSON writes as 0.
      if (kind === 4) return -(1 + int(r, 49)) / 8;
      if (kind === 5) return Array.from({ length: int(r, 4) }, () => generate(depth + 1));
      const object: Record<string, unknown> = {};
      for (let i = int(r, 4); i > 0; i -= 1) object[pick(r, keys)] = generate(depth + 1);
      return object;
    };
    let stringUnderAmountKey = false;
    const expected = (value: unknown, key: string): unknown => {
      if (typeof value === 'number' && amountKeys.has(key)) return { grain: String(BigInt(Math.round(value * 1e8))) };
      if (typeof value === 'string' && amountKeys.has(key)) stringUnderAmountKey = true;
      if (Array.isArray(value)) return value.map((item) => expected(item, ''));
      if (value !== null && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([k, item]) => [k, expected(item, k)]));
      }
      return value;
    };
    const normal = (value: unknown): unknown =>
      typeof value === 'bigint'
        ? { grain: String(value) }
        : Array.isArray(value)
          ? value.map(normal)
          : value !== null && typeof value === 'object'
            ? Object.fromEntries(Object.entries(value).map(([k, item]) => [k, normal(item)]))
            : value;
    for (let i = 0; i < RUNS; i += 1) {
      const document = generate(0);
      const text = r() < 0.5 ? JSON.stringify(document) : JSON.stringify(document, null, pick(r, [1, '\t', 2]));
      stringUnderAmountKey = false;
      const want = expected(document, '');
      // A string where an amount belongs is the server's mistake; what parseJson makes of it is not pinned here.
      if (stringUnderAmountKey) continue;
      expect(normal(parseJson(text, amountKeys)), text).toEqual(want);
    }
  });

  const randomScript = (r: Random): Uint8Array => {
    const parts: number[][] = [];
    for (let i = int(r, 8); i >= 0; i -= 1) {
      const kind = int(r, 9);
      const push = (prefix: number[], n: number): number => parts.push([...prefix, ...bytes(r, n)]);
      if (kind === 0) parts.push([int(r, 256)]);
      else if (kind === 1) {
        const n = int(r, 76);
        push([n], n);
      } else if (kind === 2) {
        const n = int(r, 90);
        push([0x4c, n], n);
      } else if (kind === 3) {
        const n = int(r, 300);
        push([0x4d, n & 255, n >> 8], n);
      } else if (kind === 4) {
        const n = int(r, 20);
        push([0x4e, n, 0, 0, 0], n);
      } else if (kind === 5) parts.push([1, int(r, 0x18)]);
      else if (kind === 6) parts.push([0x51 + int(r, 16)]);
      else if (kind === 7) parts.push([32, ...bytes(r, 32), pick(r, [0xac, 0xba])]);
      else parts.push([pick(r, [0xac, 0xba, 0x9c, 0x6a, 0x00, 0x4f, 0xde])]);
    }
    return Uint8Array.from(parts.flat());
  };

  it('scripts never break the tokenizer, and text made from a script pushes the same values back', () => {
    const r = rng(5);
    // What a chunk leaves on the stack, so OP_5 and a push of 0x05 compare equal.
    const pushed = (chunk: number | Uint8Array): string => {
      if (chunk instanceof Uint8Array) return hex(chunk);
      if (chunk === 0) return '';
      if (chunk >= 0x51 && chunk <= 0x60) return hex(Uint8Array.of(chunk - 0x50));
      return chunk === 0x4f ? '81' : `op${chunk}`;
    };
    for (let i = 0; i < RUNS; i += 1) {
      const script = i % 4 === 0 ? bytes(r, int(r, 60)) : i % 4 === 1 ? mutateBytes(r, randomScript(r)) : randomScript(r);
      const input = hex(script);
      const asm = scriptToAsm(script);
      expect(asm, input).not.toContain('undefined');
      isPushOnlyScript(script);
      classifyOutputScript(script);
      extractWitnessProgram(script);
      accepted(() => parseMultiA(script), input);
      const chunks = accepted(() => decompileScript(script), input);
      if (chunks === null) {
        expect(asm.endsWith('[error]'), input).toBe(true);
        continue;
      }
      // compileScript writes a one-byte push of zero as OP_0, as txscript's ScriptBuilder does.
      const compiled = (chunk: number | Uint8Array): string => (chunk instanceof Uint8Array && hex(chunk) === '00' ? '' : pushed(chunk));
      const recompiled = accepted(() => compileScript(chunks), input);
      if (recompiled !== null) expect(decompileScript(recompiled).map(pushed), input).toEqual(chunks.map(compiled));
      // A lone zero-length PUSHDATA prints as nothing, as in Pearl's disassembly, and nothing reads back as the empty script.
      if (asm === '') continue;
      const back = accepted(() => scriptFromAsm(asm), asm);
      if (back !== null) expect(decompileScript(back).map(pushed), asm).toEqual(chunks.map(pushed));
    }
  });

  it('script numbers round-trip, and random bytes decode only when they are the minimal encoding', () => {
    const r = rng(6);
    for (let i = 0; i < RUNS; i += 1) {
      const bits = int(r, 40);
      let value = BigInt(int(r, 2 ** Math.min(bits, 31))) * (bits > 31 ? 2n ** BigInt(bits - 31) : 1n);
      if (r() < 0.5) value = -value;
      expect(decodeScriptNumber(encodeScriptNumber(value), { maxLength: 8 })).toBe(value);
      const raw = bytes(r, int(r, 6));
      const decoded = accepted(() => decodeScriptNumber(raw), hex(raw));
      if (decoded !== null) expect(hex(encodeScriptNumber(decoded)), hex(raw)).toBe(hex(raw));
    }
  });

  it('every leaf of a tree opens its outputs, and a changed control block does not', () => {
    const r = rng(7);
    const internalPubkey = unhex('79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798');
    for (let i = 0; i < Math.ceil(RUNS / 10); i += 1) {
      const scripts = Array.from({ length: 1 + int(r, 9) }, () => randomScript(r));
      const leaves = scripts.filter((script, at) => scripts.findIndex((other) => hex(other) === hex(script)) === at);
      const tree = assembleScriptTree(leaves);
      const taprootProgram = p2tr({ internalPubkey, merkleRoot: tree.root }).output.slice(2);
      const merkleRootProgram = p2mr({ merkleRoot: tree.root }).output.slice(2);
      tree.leaves.forEach((leaf, at) => {
        const forTaproot = taprootControlBlock(internalPubkey, tree, at);
        const forP2mr = p2mrControlBlock(tree, at);
        verifyTaprootLeafCommitment(forTaproot, taprootProgram, leaf.script);
        verifyP2mrLeafCommitment(forP2mr, merkleRootProgram, leaf.script);
        const changedP2mr = mutateBytes(r, forP2mr);
        if (hex(changedP2mr) !== hex(forP2mr)) {
          expect(accepted(() => verifyP2mrLeafCommitment(changedP2mr, merkleRootProgram, leaf.script) ?? true, hex(changedP2mr))).toBeNull();
        }
        const changedTaproot = mutateBytes(r, forTaproot);
        if (hex(changedTaproot) !== hex(forTaproot)) {
          expect(accepted(() => verifyTaprootLeafCommitment(changedTaproot, taprootProgram, leaf.script) ?? true, hex(changedTaproot))).toBeNull();
        }
      });
    }
  });

  it('a mutated transaction parses to the same bytes or not at all, with every output in range', () => {
    const r = rng(8);
    const seeds = [
      ...vectors.transactions.map((item) => item.hex),
      ...vectors.signing.map((item) => item.finalTxHex),
      ...vectors.scriptPathSpends.map((item) => item.finalTxHex),
      ...vectors.tapscriptExtras.map((item) => item.finalTxHex),
    ].map(unhex);
    for (const seed of seeds) expect(serializeTransaction(parseTransaction(hex(seed)))).toBe(hex(seed));
    for (let i = 0; i < RUNS; i += 1) {
      const mutant = hex(i % 10 === 0 ? bytes(r, int(r, 120)) : mutateBytes(r, pick(r, seeds)));
      const tx = accepted(() => parseTransaction(mutant), mutant);
      if (tx === null) continue;
      expect(serializeTransaction(tx), mutant).toBe(mutant);
      expect(tx.outs.every((output) => output.value >= 0n && output.value <= MAX_GRAIN), mutant).toBe(true);
    }
  });

  it('a mutated PSBT is refused or parsed without an engine error, also when finalized', () => {
    const r = rng(9);
    const seeds = [
      vectors.psbt.base64,
      ...vectors.signing.flatMap((item) => [item.preparedPsbt, item.finalPsbt]),
      ...vectors.scriptPathSpends.flatMap((item) => [item.preparedPsbt, item.finalPsbt]).filter((item) => item !== undefined),
    ].map((text) => Uint8Array.from(Buffer.from(text, 'base64')));
    for (const seed of seeds) {
      const text = Buffer.from(seed).toString('base64');
      expect(parsePsbt(text).toBase64()).toBe(text);
    }
    for (let i = 0; i < Math.ceil(RUNS / 2); i += 1) {
      const text = Buffer.from(mutateBytes(r, pick(r, seeds))).toString('base64');
      const psbt = accepted(() => parsePsbt(text), text);
      if (psbt === null) continue;
      psbt.toBase64();
      accepted(() => finalizePsbt(psbt), text);
    }
  });

  it('block headers round-trip, and a mutated block parses to the same bytes or not at all', () => {
    const r = rng(10);
    for (let i = 0; i < RUNS; i += 1) {
      const header = bytes(r, 108);
      expect(hex(serializeBlockHeader(parseBlockHeader(header)))).toBe(hex(header));
      const mutant = mutateBytes(r, header);
      const parsed = accepted(() => parseBlockHeader(mutant), hex(mutant));
      if (parsed !== null) expect(mutant).toHaveLength(108);
    }
    const seeds = vectors.blocks.map((item) => unhex(item.hex));
    for (let i = 0; i < Math.ceil(RUNS / 4); i += 1) {
      const mutant = mutateBytes(r, pick(r, seeds));
      const block = accepted(() => parseBlock(mutant), hex(mutant).slice(0, 80));
      if (block !== null) expect(hex(serializeBlock(block))).toBe(hex(mutant));
    }
  });

  it('a mutated message signature never throws, and never verifies for another address', () => {
    const r = rng(11);
    const net = networks.regtest;
    const key = unhex('0000000000000000000000000000000000000000000000000000000000000001');
    const address = keyPathAddress(key, net);
    for (let i = 0; i < Math.ceil(RUNS / 4); i += 1) {
      const message = Array.from({ length: int(r, 30) }, () => String.fromCharCode(32 + int(r, 90))).join('');
      const signature = signMessage(key, message);
      expect(verifyMessage(address, signature, message, net)).toBe(true);
      const mutant = Buffer.from(mutateBytes(r, Uint8Array.from(Buffer.from(signature, 'base64')))).toString('base64');
      expect(typeof verifyMessage(address, mutant, message, net)).toBe('boolean');
      // About half of random programs are not points on the curve.
      const other = encodeAddress({ version: 1, program: bytes(r, 32) }, net);
      expect(verifyMessage(other, signature, message, net)).toBe(false);
    }
  });

  it('an XMSS signature with any bit flipped or any length change is refused without throwing', () => {
    const r = rng(12);
    const key = vectors.xmss.keys[0]!;
    const publicKey = unhex(key.publicKey);
    const good = vectors.xmss.signatures.filter((item) => item.valid && item.key === key.name);
    for (let i = 0; i < Math.ceil(RUNS / 10); i += 1) {
      const chosen = pick(r, good);
      const signature = unhex(chosen.signature);
      const message = unhex(chosen.message);
      const flipped = Uint8Array.from(signature);
      const at = int(r, flipped.length);
      flipped[at] = flipped[at]! ^ (1 << int(r, 8));
      expect(xmssVerify(publicKey, message, flipped), `byte ${at}`).toBe(false);
      const mutant = mutateBytes(r, signature);
      if (hex(mutant) !== hex(signature)) expect(xmssVerify(publicKey, message, mutant)).toBe(false);
    }
  });
});
