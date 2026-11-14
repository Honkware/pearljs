# Write and read scripts

A script is the small program in an output or a leaf that decides who can spend the coins. pearljs writes and reads scripts with Pearl's own opcode table and prints them in the one-line format `decodescript` shows. To run a script, use the [script interpreter](interpreter.md).

## Write and print a script

`compileScript` takes a list of opcodes, as numbers from `OP_CODES`, and data, as byte arrays, and returns the script's bytes. `scriptToAsm` prints it:

```ts run
import { compileScript, decompileScript, OP_CODES, scriptFromAsm, scriptToAsm } from 'pearljs';

const hash = new Uint8Array(32);
const leaf = compileScript([OP_CODES.OP_SHA256, hash, OP_CODES.OP_EQUALVERIFY, OP_CODES.OP_1]);

console.log(scriptToAsm(leaf)); // OP_SHA256 0000...0000 OP_EQUALVERIFY 1
console.log(decompileScript(leaf).length); // 4 chunks: opcodes as numbers, data as bytes

const text = scriptToAsm(leaf, { unambiguous: true });
console.log(scriptFromAsm(text).length === leaf.length); // true
```

`compileScript` pushes each piece of data in the shortest form, `decompileScript` splits a script back into chunks, and `scriptToAsm` matches the format `decodescript` prints. That format loses information, so `scriptFromAsm` refuses words that could mean two scripts, and `{ unambiguous: true }` prints them in a form it reads back. [Script encoding reference](../reference/scripts-encoding.md) has the push rules, the disassembly format, script numbers and output classes.

## Pearl's tapscript

Leaf scripts on Pearl run under tapscript, and Pearl's tapscript differs from Bitcoin's in ways that matter when writing leaves:

- `OP_CAT` is enabled.
- Pearl removed BIP 342's OP_SUCCESS rule. On Bitcoin a reserved or unknown opcode makes a tapscript leaf succeed outright, and on Pearl it makes the leaf fail.
- `OP_CHECKMULTISIG` and `OP_CHECKMULTISIGVERIFY` are disabled, so multisig is a `multi_a` leaf ([Build a multisig vault with timelocks](multisig-and-timelocks.md)). `isDisabledOpcode` reports the 16 opcodes Pearl rejects as disabled in tapscript, those two among them.
- `OP_CHECKXMSSSIG` verifies an XMSS signature ([XMSS](../concepts/xmss.md)).
- Leaves use leaf version 0xc0 (`BASE_LEAF_VERSION`), the only version Pearl executes.

[Script interpreter rules](../reference/interpreter-rules.md) has the full list.

## Hashes

`taggedHash`, `tapLeafHash` and `tapBranchHash` compute the BIP340 and BIP341 tagged hashes. `sha256`, `hash256` (double SHA-256) and `hash160` (RIPEMD-160 of SHA-256) are in `pearljs/crypto`.
