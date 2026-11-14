# Script encoding reference

## Pushes and chunks

`compileScript` pushes data the way Pearl's `ScriptBuilder.AddData` does, choosing the shortest form for each piece:

- An empty array or `[0x00]` becomes `OP_0`.
- The single bytes 1 to 16 become `OP_1` to `OP_16`.
- `[0x81]` becomes `OP_1NEGATE`.
- Up to 75 bytes are pushed directly.
- Larger data uses `PUSHDATA1` or `PUSHDATA2`.
- A push above 520 bytes (`MAX_SCRIPT_ELEMENT_SIZE`) is refused.

`scriptPush` gives that encoding for one piece of data. `decompileScript` splits a script back into chunks, opcodes as numbers and data as bytes, and throws on a push that runs past the end of the script.

`OP_CODES` is Pearl's full table of 260 names, including `OP_CHECKXMSSSIG` (0xde) and the aliases `OP_TRUE`, `OP_FALSE`, `OP_NOP2` and `OP_NOP3`, and `OPCODE_NAMES` maps bytes back to names.

## Disassembly format

`scriptToAsm` matches Pearl's `DisasmString`, the format `decodescript` prints. Pushed data is shown as hex, `OP_0` to `OP_16` and `OP_1NEGATE` as numbers, and other opcodes by name, with single spaces between words. A push that runs past the end ends the output with `[error]`.

This format loses information. `10` to `16` stand both for `OP_10` to `OP_16` and for a one-byte push of 0x10 to 0x16, and a zero-length PUSHDATA prints as an empty word. Rather than guess which script was meant, `scriptFromAsm` refuses those words. It reads `OP_10` or `0x10` for the two meanings and `0x` alone for an empty push, and `scriptToAsm(script, { unambiguous: true })` prints them that way, with the rest of the text unchanged:

```ts run
import { OP_CODES, compileScript, scriptFromAsm, scriptToAsm } from 'pearljs';

const script = compileScript([OP_CODES.OP_12, OP_CODES.OP_ADD]);
console.log(scriptToAsm(script)); // "12 OP_ADD": could also be a push of the byte 0x12
console.log(scriptToAsm(script, { unambiguous: true })); // "OP_12 OP_ADD"

try {
  scriptFromAsm('12 OP_ADD');
} catch (err) {
  console.log((err as Error).message);
}
console.log(scriptFromAsm('OP_12 OP_ADD').length, scriptFromAsm('0x12 OP_ADD').length); // 2 3
```

`scriptFromAsm` returns a script that pushes the same values as the one printed, using the shortest push opcode for each, which is not always the push opcode the original used. Numbers from -1 to 9 become their opcodes, a `0x` prefix marks a word as data whatever it looks like, and the empty string is the empty script.

## Script numbers

Scripts encode integers as little-endian sign-magnitude in as few bytes as possible. `encodeScriptNumber` takes a bigint and `decodeScriptNumber` returns one. Decoding follows Pearl's `MakeScriptNum`, so it accepts at most `maxLength` bytes, which is 4 by default and 5 for lock times, and requires the minimal encoding unless `requireMinimal` is false:

```ts run
import { decodeScriptNumber, encodeScriptNumber } from 'pearljs';

console.log(encodeScriptNumber(1008n)); // Uint8Array [ 0xf0, 0x03 ]
console.log(decodeScriptNumber(encodeScriptNumber(-5n))); // -5n
console.log(decodeScriptNumber(encodeScriptNumber(2n ** 40n), { maxLength: 8 })); // 1099511627776n
```

## Output classes

`classifyOutputScript` names the type of an output script as Pearl's `GetScriptClass` does:

| Class | Script |
| --- | --- |
| `p2tr` | Exactly `OP_1 <32 bytes>` |
| `p2mr` | Exactly `OP_2 <32 bytes>` |
| `nulldata` | Anything beginning with `OP_RETURN` |
| `nonstandard` | Everything else, legacy Bitcoin templates included |

`extractWitnessProgram` returns the version and program of any witness program (versions 0 to 16, 2 to 40 bytes), or null for a script that is not one. `isPushOnlyScript` is Pearl's `IsPushOnlyScript`.

```ts run
import { classifyOutputScript, embed, extractWitnessProgram, p2mr, p2tr } from 'pearljs';

const key = new Uint8Array(32).fill(2);
console.log(classifyOutputScript(p2tr({ internalPubkey: key }).output)); // p2tr
console.log(classifyOutputScript(p2mr({ merkleRoot: key }).output)); // p2mr
console.log(classifyOutputScript(embed({ data: Uint8Array.of(1, 2, 3) }).output)); // nulldata
console.log(classifyOutputScript(Uint8Array.of(0x00, 0x14, ...new Uint8Array(20)))); // nonstandard: a P2WPKH script
console.log(extractWitnessProgram(Uint8Array.of(0x00, 0x14, ...new Uint8Array(20)))?.version); // 0
```
