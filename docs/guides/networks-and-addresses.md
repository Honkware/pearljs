# Networks and addresses

Every function in pearljs that touches an address, a key or a chain rule takes a network object, which says which of Pearl's chains it is working on.

## Choose a network

`networks` holds the five networks Pearl defines, with the parameters from Pearl's Go source:

```ts run
import { networks } from 'pearljs';

const { mainnet, testnet2, regtest } = networks;
console.log(mainnet.name, mainnet.bech32Hrp, mainnet.coinType); // mainnet prl 808276
console.log(testnet2.bech32Hrp, regtest.bech32Hrp); // tprl rprl
```

[Networks](../reference/networks-and-addresses-tables.md#networks) lists each network's prefix, ports, coin type and key versions. For testing, use `testnet2` or a local `regtest`, as [Testnets](#testnets) explains.

## Check an address a user typed

`isValidAddress` says whether text is an address on a given network, without throwing. `addressInfo` needs no network: it says what kind of address the text is and which networks it can belong to, or returns null for anything that isn't a Pearl address.

```ts run
import { addressInfo, isValidAddress, networks } from 'pearljs';

const typed = 'tprl1p8wpt9v4frpf3tkn0srd97pksgsxc5hs52lafxwru9kgeephvs7rqm5v93u';

console.log(isValidAddress(typed, networks.testnet2)); // true
console.log(isValidAddress(typed, networks.mainnet)); // false: wrong prefix
console.log(addressInfo(typed)?.type, addressInfo(typed)?.networks); // p2tr [ 'testnet', 'testnet2' ]
console.log(addressInfo('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4')); // null
```

## Make an address

Addresses usually come from an account ([Keys, mnemonics and accounts](keys-and-accounts.md)) or from a script tree ([P2MR](p2mr.md)). When you hold the parts yourself, the payment constructors build the output script directly:

```ts run
import { assembleScriptTree, checksigScript, embed, fromOutputScript, networks, p2mr, p2mrAddress, p2tr, p2trAddress } from 'pearljs';

const key = new Uint8Array(32).fill(2); // an x-only public key
const tree = assembleScriptTree([checksigScript(key)]);

const keyPath = p2tr({ internalPubkey: key }); // key path only, the BIP86 form
const withScripts = p2tr({ internalPubkey: key, merkleRoot: tree.root }); // key path and script tree
const merkleRoot = p2mr({ merkleRoot: tree.root }); // script tree only

for (const payment of [keyPath, withScripts, merkleRoot]) {
  console.log(payment.name, fromOutputScript(payment.output, networks.regtest));
}

// The address alone, from the same arguments.
console.log(p2trAddress({ internalPubkey: key }, networks.regtest), p2mrAddress({ merkleRoot: tree.root }, networks.regtest));

// An OP_RETURN output with up to 80 bytes of data. It has no address.
console.log(embed({ data: new TextEncoder().encode('hello') }).output);
```

Pearl has two address types, P2TR and P2MR ([Address types](../reference/networks-and-addresses-tables.md#address-types)). `embed` stops at 80 bytes, the size Pearl's own tools write. pearld relays an OP_RETURN output of any size, so `embed({ data, allowOversize: true })` takes up to the 520 bytes that one push can hold.

## Testnets

Use `testnet2` for testing against a public network. Pearl calls it the test network v2, and Pearl's desktop wallet starts its wallet with `--testnet2` when set to Testnet. `testnet` is the first test network and is still defined in Pearl's source.

The two test networks share everything an address or key shows: the `tprl` prefix, the WIF byte and the extended key versions. An address, a WIF key or an extended key made for one is valid on the other, and nothing in the text says which chain it was made for. They differ in their genesis block, P2P magic, ports and fork heights. Regtest and simnet share the `rprl` prefix in the same way, and regtest also shares the WIF byte and extended key versions of the testnets, so a testnet WIF key decodes on regtest.

A wallet therefore can't tell from an address which test network a payment request is meant for, so keep the network next to the address in your own records.

[Network and address reference](../reference/networks-and-addresses-tables.md) also covers the address types, decoding and encoding, the test networks' fork heights and the fields of a network object.
