# Sign with a hardware or external signer

A hardware wallet, an HSM or a signing service keeps the keys and answers signing requests one at a time. The application holds the account's extended public key and does all the work around the signature, so the device only has to sign a 32-byte hash. Connected to a payment for a BIP86 account, such a signer signs every input.

## Connect the signer

The application talks to the device through a `KeyPathSignerAsync`, an object with a `signKeyPath(request)` method that resolves to a 64-byte signature. In a real application that method sends the request over USB or to a service and returns what comes back. Here a signing account stands in for the device, so the example runs on its own:

```ts run
import {
  buildPayment,
  deriveSigningAccountFromSeed,
  finalizePayment,
  importWatchOnlyAccount,
  mnemonicToSeed,
  networks,
  parsePearl,
  toOutputScript,
  verifyFinalizedPsbt,
  type KeyPathSignerAsync,
} from 'pearljs';

const network = networks.regtest;

// Inside the device: the seed. A signing account stands in for it here;
// its keyPathSigner answers a request the way a device does.
const inside = deriveSigningAccountFromSeed(
  mnemonicToSeed('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'),
  network,
);
const answer = inside.keyPathSigner();
// What the device exported when it was paired: the account key and its origin.
const paired = inside.watchOnlyAccount();
const xpub = paired.extendedPublicKey();
const origin = { masterFingerprint: paired.masterFingerprint!, path: paired.path! };

// In the application: the transport to the device. A real one sends the
// request over USB or to a service and resolves with the 64 bytes that come back.
const device: KeyPathSignerAsync = {
  async signKeyPath(request) {
    console.log('asking the device to sign with', request.derivation?.path);
    return answer.signKeyPath(request);
  },
};
```

When the device is paired, it exports the account's extended public key and its origin, the master fingerprint and path, which is all the application keeps.

## Build and sign the payment

Import the key as a watch-only account, build the payment, prepare its inputs and sign each one with `account.signInputAsync`, passing the device:

```ts continues
const account = importWatchOnlyAccount(xpub, network, origin);
const payment = buildPayment({
  network,
  utxos: [
    {
      txid: '6f1e3c0b5d1a4c0e9b7a2d4f8c6e0a1b3d5f7092a4c6e8f0b1d3f507192b4d6f',
      vout: 1,
      value: parsePearl('2'),
      script: toOutputScript(account.deriveAddress(3), network),
      confirmations: 12,
      index: 3,
    },
  ],
  recipients: [{ address: 'rprl1p8dhv8twyj9ezfvk62vvsfgw39s4dgl9t42y0549dc4d2947jj4cs30wfpz', amount: parsePearl('1.5') }],
  feeRate: 2000n, // grain/kvB
  changeFrom: { account, index: 0 },
});
payment.inputs.forEach((utxo, i) => account.prepareInput(payment.psbt, i, utxo));
for (let i = 0; i < payment.psbt.inputCount; i += 1) await account.signInputAsync(payment.psbt, i, device);

const signed = finalizePayment(payment);
console.log(signed.txid, verifyFinalizedPsbt(payment.psbt).ok); // ... true
```

`signInputAsync` is `signInput` from [Sign a PSBT on an offline machine](psbt.md) for an account without private keys. It makes the same checks, and it makes all of them before the device is asked, so a spend that would be refused never reaches the device:

- every input is prepared;
- the input pays the child that its derivation record names;
- its sighash type is in `allowedSighashTypes` ([Sighash types a signer accepts](../reference/psbt-checks.md#sighash-types-a-signer-accepts)).

It then sends one `KeyPathSignRequest` and verifies the signature that comes back against the output key before storing it. A signature that fails is refused with `SIGNATURE_INVALID`, and the PSBT is left as it was.

## Sign requests

A BIP86 output pays the child key plus a tweak, and since the tweak has to be added to the private key, the signer is the one that applies it. The request carries what either kind of signer needs:

| Field | For |
| --- | --- |
| `hash` | The 32 bytes to sign, from `keyPathSighash` |
| `derivation` | The master fingerprint and path of the child key, for a device that derives from its seed |
| `internalPubkey`, `merkleRoot` | What the tweak is computed from. `merkleRoot` is null for every BIP86 output |
| `outputKey` | The tweaked key the signature must verify under |
| `sighashType`, `inputIndex` | What to show or log |

A device that holds the seed answers in four steps:

1. Derive the child at `derivation.path`.
2. Negate the key if its public key has an odd y.
3. Add `taggedHash('TapTweak', internalPubkey)`, followed by `merkleRoot` when there is one.
4. Sign `hash`.

A signer that was handed the tweaked key in the first place just signs `hash` and ignores the rest. Both kinds return 64 bytes, with no sighash byte. The usual first mistake is signing with the untweaked child key, and that is what `SIGNATURE_INVALID` means here.

## Other key-path signers

`signTaprootKeyPathInputAsync(psbt, i, signer, options)` is the same step without an account, for any P2TR output. It takes the internal key and Merkle root from the PSBT input or from the options, and the input's witness UTXO has to be the output they make.

Two helpers build a signer for code that holds the keys itself. `keyPathSignerFromPrivateKey(privateKey)` signs for one internal key in memory, such as a key decoded from WIF, and `signingAccount.keyPathSigner()` signs for a whole account, which is what a signing service puts behind its transport.

## Raw sighash

`keyPathSighash(tx, inputIndex, { prevouts, sighashType, annex })` returns the hash on its own, and `keyPathSighash(psbt, inputIndex)` reads the prevouts and the sighash type from a PSBT. Use it for a device protocol that does not fit `KeyPathSignerAsync`, or for a key-path spend with an annex, which a PSBT cannot carry; in that case set the witness yourself to the signature followed by the annex. It computes the message as Pearl's consensus code does, and the script interpreter verifies key-path signatures with the same function.

## Script-path leaves

A device signs script-path leaves through `signTaprootScriptPathInputAsync` and `signP2mrScriptPathInputAsync`. There the signer makes a plain signature with the untweaked key that the leaf names ([Sign with a hardware device](p2mr-sign.md#sign-with-a-hardware-device)).
