import { describe, expect, it } from 'vitest';
import vectors from '../vectors/pearl-go.json' with { type: 'json' };
import { bytesToHex, hexToBytes } from './vector-helpers.js';
import {
  BASE_LEAF_VERSION,
  LOCKTIME_THRESHOLD,
  MAX_SCRIPT_ELEMENT_SIZE,
  OP_CODES,
  SEQUENCE_LOCKTIME_DISABLED,
  SEQUENCE_LOCKTIME_GRANULARITY,
  SEQUENCE_LOCKTIME_IS_SECONDS,
  SEQUENCE_LOCKTIME_MASK,
  classifyOutputScript,
  encodeScriptNumber,
  extractWitnessProgram,
  scriptPush,
  tapBranchHash,
  tapLeafHash,
} from '../src/script.js';
import type { ScriptClass } from '../src/script.js';

const GO_CLASS_NAMES: Record<string, ScriptClass> = {
  nonstandard: 'nonstandard',
  nulldata: 'nulldata',
  witness_v1_taproot: 'p2tr',
  witness_v2_merkleroot: 'p2mr',
};

function goClassName(name: string): ScriptClass {
  const className = GO_CLASS_NAMES[name];
  if (className === undefined) {
    throw new Error(`unknown Go script class in vectors: ${name}`);
  }
  return className;
}

function bytes(length: number, fill: number): Uint8Array {
  return new Uint8Array(length).fill(fill);
}

function witnessScript(versionOpcode: number, program: Uint8Array): Uint8Array {
  return Uint8Array.from([versionOpcode, program.length, ...program]);
}

describe('opcode and wire constants', () => {
  it('exposes the opcode values Pearl relies on', () => {
    expect(OP_CODES.OP_0).toBe(0x00);
    expect(OP_CODES.OP_1NEGATE).toBe(0x4f);
    expect(OP_CODES.OP_1).toBe(0x51);
    expect(OP_CODES.OP_2).toBe(0x52);
    expect(OP_CODES.OP_16).toBe(0x60);
    expect(OP_CODES.OP_RETURN).toBe(0x6a);
    expect(OP_CODES.OP_CAT).toBe(0x7e);
    expect(OP_CODES.OP_CHECKLOCKTIMEVERIFY).toBe(0xb1);
    expect(OP_CODES.OP_CHECKSEQUENCEVERIFY).toBe(0xb2);
    expect(OP_CODES.OP_CHECKMULTISIG).toBe(0xae);
    expect(OP_CODES.OP_CHECKMULTISIGVERIFY).toBe(0xaf);
    expect(OP_CODES.OP_CHECKSIGADD).toBe(0xba);
  });

  it('exposes the locktime, sequence, size, and leaf version constants', () => {
    expect(LOCKTIME_THRESHOLD).toBe(500000000);
    expect(SEQUENCE_LOCKTIME_DISABLED).toBe(0x80000000);
    expect(SEQUENCE_LOCKTIME_IS_SECONDS).toBe(0x00400000);
    expect(SEQUENCE_LOCKTIME_MASK).toBe(0x0000ffff);
    expect(SEQUENCE_LOCKTIME_GRANULARITY).toBe(9);
    expect(MAX_SCRIPT_ELEMENT_SIZE).toBe(520);
    expect(BASE_LEAF_VERSION).toBe(0xc0);
  });
});

describe('classifyOutputScript', () => {
  it('classifies OP_1 with a 32 byte push as p2tr', () => {
    expect(classifyOutputScript(witnessScript(OP_CODES.OP_1, bytes(32, 0x11)))).toBe('p2tr');
  });

  it('classifies OP_2 with a 32 byte push as p2mr', () => {
    expect(classifyOutputScript(witnessScript(OP_CODES.OP_2, bytes(32, 0x22)))).toBe('p2mr');
  });

  it('classifies any OP_RETURN prefix as nulldata regardless of the remainder', () => {
    expect(classifyOutputScript(Uint8Array.from([OP_CODES.OP_RETURN]))).toBe('nulldata');
    expect(classifyOutputScript(Uint8Array.from([OP_CODES.OP_RETURN, 0x01, 0x02]))).toBe(
      'nulldata',
    );
    expect(classifyOutputScript(Uint8Array.from([OP_CODES.OP_RETURN, 0xff, 0xff]))).toBe(
      'nulldata',
    );
  });

  it('classifies legacy pay to pubkey hash scripts as nonstandard', () => {
    const p2pkh = hexToBytes('76a914000000000000000000000000000000000000000088ac');
    expect(classifyOutputScript(p2pkh)).toBe('nonstandard');
  });

  it('classifies legacy pay to script hash scripts as nonstandard', () => {
    const p2sh = hexToBytes('a914000000000000000000000000000000000000000087');
    expect(classifyOutputScript(p2sh)).toBe('nonstandard');
  });

  it('classifies malformed witness scripts as nonstandard', () => {
    expect(classifyOutputScript(witnessScript(OP_CODES.OP_1, bytes(31, 0x11)))).toBe(
      'nonstandard',
    );
    expect(
      classifyOutputScript(Uint8Array.from([OP_CODES.OP_1, 0x20, ...bytes(32, 0x11), 0x00])),
    ).toBe('nonstandard');
    expect(classifyOutputScript(witnessScript(OP_CODES.OP_2, bytes(33, 0x22)))).toBe(
      'nonstandard',
    );
  });

  it('classifies empty scripts and other witness versions as nonstandard', () => {
    expect(classifyOutputScript(new Uint8Array(0))).toBe('nonstandard');
    expect(classifyOutputScript(witnessScript(OP_CODES.OP_0, bytes(20, 0x33)))).toBe(
      'nonstandard',
    );
    expect(classifyOutputScript(witnessScript(0x53, bytes(32, 0x44)))).toBe('nonstandard');
  });
});

describe('extractWitnessProgram', () => {
  it('extracts witness programs for every version from 0 through 16', () => {
    for (let version = 0; version <= 16; version += 1) {
      const opcode = version === 0 ? OP_CODES.OP_0 : OP_CODES.OP_1 + version - 1;
      const program = bytes(32, version);
      const extracted = extractWitnessProgram(witnessScript(opcode, program));
      expect(extracted).not.toBeNull();
      expect(extracted!.version).toBe(version);
      expect(bytesToHex(extracted!.program)).toBe(bytesToHex(program));
    }
  });

  it('extracts the shortest and longest permitted programs', () => {
    for (const length of [2, 40]) {
      const program = bytes(length, 0xaa);
      const extracted = extractWitnessProgram(witnessScript(OP_CODES.OP_0, program));
      expect(extracted).not.toBeNull();
      expect(extracted!.program).toHaveLength(length);
    }
  });

  it('rejects pushes that are too short or too long', () => {
    expect(extractWitnessProgram(witnessScript(OP_CODES.OP_0, bytes(1, 0xaa)))).toBeNull();
    expect(extractWitnessProgram(Uint8Array.from([OP_CODES.OP_0, 41, ...bytes(41, 0xaa)]))).toBeNull();
  });

  it('rejects noncanonical pushes and trailing bytes', () => {
    const program = bytes(20, 0xbb);
    expect(
      extractWitnessProgram(Uint8Array.from([OP_CODES.OP_0, OP_CODES.OP_PUSHDATA1, 20, ...program])),
    ).toBeNull();
    expect(
      extractWitnessProgram(Uint8Array.from([OP_CODES.OP_1, 20, ...program, 0x00])),
    ).toBeNull();
    expect(extractWitnessProgram(Uint8Array.from([OP_CODES.OP_1, 20, ...program.slice(0, 19)]))).toBeNull();
  });

  it('rejects scripts where the version is pushed as data', () => {
    expect(extractWitnessProgram(Uint8Array.from([0x01, 0x00, 0x14, ...bytes(20, 0xcc)]))).toBeNull();
  });

  it('rejects scripts that are not two opcodes and a program', () => {
    expect(extractWitnessProgram(new Uint8Array(0))).toBeNull();
    expect(extractWitnessProgram(Uint8Array.from([OP_CODES.OP_0]))).toBeNull();
    expect(extractWitnessProgram(Uint8Array.from([OP_CODES.OP_16 + 1, 0x02, 0xaa, 0xbb]))).toBeNull();
  });
});

describe('encodeScriptNumber', () => {
  const cases: { value: bigint; hex: string }[] = [
    { value: 0n, hex: '' },
    { value: 1n, hex: '01' },
    { value: -1n, hex: '81' },
    { value: 2n, hex: '02' },
    { value: 127n, hex: '7f' },
    { value: 128n, hex: '8000' },
    { value: -128n, hex: '8080' },
    { value: 255n, hex: 'ff00' },
    { value: -255n, hex: 'ff80' },
    { value: 32767n, hex: 'ff7f' },
    { value: 32768n, hex: '008000' },
    { value: -32768n, hex: '008080' },
    { value: 2147483647n, hex: 'ffffff7f' },
    { value: -2147483648n, hex: '0000008080' },
    { value: 9223372036854775807n, hex: 'ffffffffffffff7f' },
    { value: -9223372036854775807n, hex: 'ffffffffffffffff' },
  ];

  it('encodes script numbers with little-endian signed magnitude', () => {
    for (const { value, hex } of cases) {
      expect(bytesToHex(encodeScriptNumber(value))).toBe(hex);
    }
  });

  it('round trips values through decode as minimal encodings', () => {
    for (const { value } of cases) {
      const encoded = encodeScriptNumber(value);
      const reencoded = encodeScriptNumber(decodeScriptNumber(encoded));
      expect(bytesToHex(reencoded)).toBe(bytesToHex(encoded));
      expect(decodeScriptNumber(encoded)).toBe(value);
    }
  });
});

function decodeScriptNumber(encoded: Uint8Array): bigint {
  if (encoded.length === 0) {
    return 0n;
  }
  const last = encoded[encoded.length - 1]!;
  const negative = (last & 0x80) !== 0;
  const bytesOut = Uint8Array.from(encoded);
  bytesOut[bytesOut.length - 1] = last & 0x7f;
  let result = 0n;
  for (let i = bytesOut.length - 1; i >= 0; i -= 1) {
    result = (result << 8n) | BigInt(bytesOut[i]!);
  }
  return negative ? -result : result;
}

describe('scriptPush', () => {
  it('pushes empty data and a single zero byte as OP_0', () => {
    expect(bytesToHex(scriptPush(new Uint8Array(0)))).toBe('00');
    expect(bytesToHex(scriptPush(Uint8Array.from([0])))).toBe('00');
  });

  it('pushes the values 1 through 16 as their small integer opcodes', () => {
    for (let value = 1; value <= 16; value += 1) {
      const expected = (OP_CODES.OP_1 + value - 1).toString(16).padStart(2, '0');
      expect(bytesToHex(scriptPush(Uint8Array.from([value])))).toBe(expected);
    }
  });

  it('pushes a single 0x81 byte as OP_1NEGATE', () => {
    expect(bytesToHex(scriptPush(Uint8Array.from([0x81])))).toBe('4f');
  });

  it('pushes other single bytes directly', () => {
    expect(bytesToHex(scriptPush(Uint8Array.from([17])))).toBe('0111');
    expect(bytesToHex(scriptPush(Uint8Array.from([0x80])))).toBe('0180');
    expect(bytesToHex(scriptPush(Uint8Array.from([0xff])))).toBe('01ff');
  });

  it('pushes 75 bytes directly and 76 bytes with PUSHDATA1', () => {
    const direct = bytes(75, 0xaa);
    expect(bytesToHex(scriptPush(direct))).toBe(`4b${bytesToHex(direct)}`);
    const pushed = bytes(76, 0xaa);
    expect(bytesToHex(scriptPush(pushed))).toBe(`4c4c${bytesToHex(pushed)}`);
  });

  it('pushes 255 bytes with PUSHDATA1 and 256 bytes with PUSHDATA2', () => {
    const oneByte = bytes(255, 0xbb);
    expect(bytesToHex(scriptPush(oneByte))).toBe(`4cff${bytesToHex(oneByte)}`);
    const twoBytes = bytes(256, 0xbb);
    expect(bytesToHex(scriptPush(twoBytes))).toBe(`4d0001${bytesToHex(twoBytes)}`);
  });

  it('pushes 520 bytes with PUSHDATA2 and rejects 521 bytes', () => {
    const largest = bytes(MAX_SCRIPT_ELEMENT_SIZE, 0xcc);
    expect(bytesToHex(scriptPush(largest))).toBe(`4d0802${bytesToHex(largest)}`);
    expect(() => scriptPush(bytes(MAX_SCRIPT_ELEMENT_SIZE + 1, 0xcc))).toThrow(
      /MAX_SCRIPT_ELEMENT_SIZE/,
    );
  });
});

describe('tapLeafHash', () => {
  it('defaults to the base leaf version', () => {
    const script = Uint8Array.from([OP_CODES.OP_1]);
    expect(bytesToHex(tapLeafHash(script))).toBe(bytesToHex(tapLeafHash(script, BASE_LEAF_VERSION)));
  });

  it('rejects leaf versions that do not fit in a single byte', () => {
    const script = Uint8Array.from([OP_CODES.OP_1]);
    expect(() => tapLeafHash(script, -1)).toThrow(/leaf version/);
    expect(() => tapLeafHash(script, 256)).toThrow(/leaf version/);
    expect(() => tapLeafHash(script, 0.5)).toThrow(/leaf version/);
  });
});

describe('tapBranchHash', () => {
  it('is independent of child order', () => {
    const left = bytes(32, 0x01);
    const right = bytes(32, 0x02);
    expect(bytesToHex(tapBranchHash(left, right))).toBe(bytesToHex(tapBranchHash(right, left)));
  });

  it('rejects children that are not 32 bytes', () => {
    const valid = bytes(32, 0x01);
    expect(() => tapBranchHash(bytes(31, 0x01), valid)).toThrow(/32 bytes/);
    expect(() => tapBranchHash(valid, bytes(33, 0x01))).toThrow(/32 bytes/);
  });
});

describe('Pearl Go script vectors', () => {
  it('matches Go script classifications', () => {
    for (const expected of vectors.scripts.classifications) {
      expect(
        classifyOutputScript(hexToBytes(expected.hex)),
        expected.name,
      ).toBe(goClassName(expected.className));
    }
  });

  it('matches Go ScriptBuilder data pushes', () => {
    for (const expected of vectors.scripts.pushes) {
      expect(
        bytesToHex(scriptPush(hexToBytes(expected.data))),
        expected.name,
      ).toBe(expected.script);
    }
  });

  it('matches Go ScriptBuilder integer pushes', () => {
    for (const expected of vectors.scripts.scriptNumbers) {
      expect(
        bytesToHex(scriptPush(encodeScriptNumber(BigInt(expected.value)))),
        expected.name,
      ).toBe(expected.script);
    }
  });

  it('matches Go tapleaf hashes', () => {
    for (const expected of vectors.scripts.tapLeaves) {
      expect(
        bytesToHex(tapLeafHash(hexToBytes(expected.script))),
        expected.name,
      ).toBe(expected.hash);
    }
  });

  it('matches Go tapbranch hashes', () => {
    for (const expected of vectors.scripts.tapBranches) {
      expect(
        bytesToHex(tapBranchHash(hexToBytes(expected.left), hexToBytes(expected.right))),
        expected.name,
      ).toBe(expected.hash);
    }
  });
});
