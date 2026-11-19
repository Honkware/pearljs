# Network and address reference

## Networks

| Network | Address prefix | P2P port | pearld RPC | Oyster RPC | BIP44 coin type | WIF byte | Extended keys |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `mainnet` | `prl` | 44108 | 44107 | 44207 | 808276 | 0x80 | `zprv`, `zpub` |
| `testnet` | `tprl` | 44110 | 44109 | 44209 | 1 | 0xef | `vprv`, `vpub` |
| `testnet2` | `tprl` | 44112 | 44111 | 44211 | 1 | 0xef | `vprv`, `vpub` |
| `regtest` | `rprl` | 18444 | 18334 | 18332 | 1 | 0xef | `vprv`, `vpub` |
| `simnet` | `rprl` | 18555 | 18556 | 18554 | 1 | 0x64 | `sprv`, `spub` |

The RPC ports are also in `PEARLD_RPC_PORTS` and `OYSTER_RPC_PORTS`, and the P2P port is each network's `defaultPort`.

## Address types

Pearl has two address types, both bech32m with a 32-byte program (`WITNESS_PROGRAM_LENGTH`):

| Type | Witness version | Output script | Mainnet addresses start with | Commits to |
| --- | --- | --- | --- | --- |
| P2TR | 1 | `OP_1 <32 bytes>` | `prl1p` | A Taproot output key: a key path, and optionally a script tree |
| P2MR | 2 | `OP_2 <32 bytes>` | `prl1z` | The Merkle root of a script tree, with no key path |

These are the only addresses on Pearl. Consensus refuses outputs other than P2TR, P2MR and OP_RETURN, so Pearl has no P2PKH, P2SH, P2WPKH or P2WSH outputs. pearljs rejects Base58 addresses, SegWit v0 addresses (bech32 without the m) and other witness versions, just as pearld does.

`classifyOutputScript` names an output script as `p2tr`, `p2mr`, `nulldata` (anything that starts with OP_RETURN) or `nonstandard`, in the same way as Pearl's `GetScriptClass`.

## Decoding and encoding

`decodeAddress` returns an address's witness version and program, and `encodeAddress` turns them back into an address. `toOutputScript` and `fromOutputScript` convert between an address and the output script a transaction carries:

```ts run
import { decodeAddress, encodeAddress, fromOutputScript, networks, toOutputScript } from 'pearljs';

const network = networks.mainnet;
const address = 'prl1pr6yuq8u2r95wjzzgpdy8cpnncpl7l8zgy6x5q0367pnc53s2famqg7pt74';

const { version, program } = decodeAddress(address, network);
console.log(version, program.length); // 1 32

const script = toOutputScript(address, network); // OP_1 <program>
console.log(fromOutputScript(script, network) === address); // true
console.log(encodeAddress({ version, program }, network) === address); // true

// The same program as a P2MR address.
console.log(encodeAddress({ version: 2, program }, network));
```

When the text isn't an address for the network, `decodeAddress` throws with one of these reasons:

- the checksum is bech32, as SegWit v0 uses, rather than bech32m;
- the witness version is something other than 1 or 2;
- the text mixes upper and lower case;
- the padding is bad;
- the program isn't 32 bytes;
- the prefix belongs to another network.

## Test network forks

Both test networks have taken the FP8 fork to V4 certificates in Pearl's fp8-scheme branch, which their nodes run (pearld 1.6.0-fp8-testnet1): `testnet` from height 67415 and `testnet2` from 150283. A node built from Pearl's master branch stops following either chain at its fork height, and mainnet stays on V3 in both branches ([Parse and check a block](../guides/blocks-and-consensus.md)).

## Network objects

Besides the address and key parameters, each network object carries the consensus data Pearl's source defines for it, which [Parse and check a block](../guides/blocks-and-consensus.md) explains:

| Group | Fields |
| --- | --- |
| The chain and its peers | `genesisHash`, `magic`, `forkHeights`, `checkpoints`, `dnsSeeds` |
| Difficulty | `targetSpacing`, `wtemaHalfLife`, `powNoRetargeting`, `reduceMinDifficulty`, `minDiffReductionTime`, `powLimit`, `powLimitBits` |
| Coinbase | `coinbaseMaturity` |

`PearlNetwork.name` is a `PearlNetworkName`, one of the five names, so it indexes `networks`, `PEARLD_RPC_PORTS` and `OYSTER_RPC_PORTS` directly. The network objects are frozen. For a private chain or a test, `customNetwork(base, changes)` makes a frozen variant, such as a regtest whose coinbases mature sooner. The variant keeps the base's name, so a variant of regtest still uses regtest's ports and addresses.
