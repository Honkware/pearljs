# Mining checks

## Template checks

`blockSkeleton` checks the template against itself first, and anything else is `MINING_TEMPLATE_INVALID`:

- Transactions must hash to their ids.
- The witness commitment and target must be the ones computed.
- `coinbasevalue` must not exceed the height's `blockSubsidy` plus the transactions' fees; pearld refuses a block whose coinbase pays more.
- The certificate version must be the one the network needs at that height.
- V4 ancestor headers must chain to the previous block.

## Coinbase

`blockSkeleton` checks the template against itself first and then builds the coinbase as pearld does (`coinbaseTransaction`). The coinbase has version 1 and a script holding the height, the extra nonce and the text (`coinbaseScript`). Its outputs are the payouts, then the witness commitment output (`witnessCommitmentFor`), and its witness is the zero witness nonce. The text is the template's `coinbaseaux.flags` unless `text` is given, and `outputs` in place of `payTo` splits the coinbase value between several scripts. With `payTo` set to pearld's `--miningaddr` and no `text`, the coinbase, merkle root and header are exactly the ones pearld's own miner makes for that template.

## Sealing

`sealBlock` sets the header's proof commitment from the certificate and the certificate's block hash from the header, then runs `checkCertificateBinding` to confirm the two match. `checkBlockWork` adds the work rules: `checkJackpot` against the header's bits and, from the network's rank-penalty height, the rank-penalty rule, with the message pearld's `CheckCertificateRules` gives. `verifyBlockProof` checks the proof with Pearl's verifier and resolves to its verdict and message.

## Certificate checks

### V2 and V3

`checkJackpot` applies the verifier's structure rules (`checkPublicData`) before it compares hash_jackpot with `jackpotBound`:

- the rank is a power of two from 32 to 1024;
- k is between 16r and 4r², and at most 65536;
- the tile has 32 to 256 entries and lies inside the matrices;
- the MoE routing is consistent.

### V4

For V4 it applies the bounds Pearl's decoder applies before it compares with `v4JackpotBound`:

- the rank is 32;
- k is from 1024 to 65536;
- the matrices have 1 to 2^24 rows;
- the lottery tile has 256 to 2048 entries in 16 lanes, inside its matrices;
- the MoE projection and the BLAKE3 witness budget are within bounds.

### V1

A V1 certificate, which mainnet carries below its MoE fork, is read with V1's rules. Its public data must be 164 bytes whose last 32 configuration bytes are all reserved and zero. It is held to the V2 structure rules without the 256-entry cap on the tile, and to the V2 bound.

## Refusals

Refusals use Pearl's words and come in its order, the public data's length first.

| Code | Meaning |
| --- | --- |
| `JACKPOT_ABOVE_TARGET` | A jackpot over its bound |
| `CERTIFICATE_MALFORMED` | Anything malformed |
| `MINING_TEMPLATE_INVALID` | A template that fails its own checks |

## Shares

A proof check costs a verifier call of tens of milliseconds, so a pool should first throw out stale, malformed and under-target submissions with the cheap checks. A certificate that passes `checkCertificateBinding`, `checkCertificateRules` and `checkBlockWork` has passed everything pearld checks except the proof.

`checkJackpot(certificate, bits)` does what Pearl's verifier does with a certificate before it reads the proof, and a share is judged by passing the share's bits. For V2 and V3 it reads the public data (`parsePublicData`) and compares hash_jackpot with `jackpotBound`, and `{ rankPenalty: true }` adds the rank-penalty rule. For V4 it reads the statement and compares with `v4JackpotBound`. [Certificate checks](#certificate-checks) lists the structure rules it applies first.

The bounds come from the mining configuration, which this example serializes, reads back and uses to compute a bound:

```ts run
import { jackpotBound, jackpotTarget, parseMiningConfiguration, rankPenalizedBound, serializeMiningConfiguration } from 'pearljs/mining';

const config = {
  commonDim: 2048, rank: 128, mmaType: 0,
  rows: [0, 8, 64, 72], cols: [0, 1, 8, 9, 32, 33, 40, 41], moe: null,
};
const bytes = serializeMiningConfiguration(config);
console.log(Buffer.from(bytes.subarray(0, 20)).toString('hex')); // 0008000080000000070103010000000103010101
console.log(parseMiningConfiguration(bytes).rows); // [ 0, 8, 64, 72 ]

const bits = 0x1d00ffff;
console.log(jackpotBound(bits, config) / jackpotTarget(bits)); // 65536n, 32 tile entries times 2048
console.log(rankPenalizedBound(jackpotTarget(bits), { ...config, commonDim: 4096, rank: 256 })! / jackpotTarget(bits)); // 65536n
```

`certificateSeeds` gives the job key and the noise seeds that a V2 or V3 certificate's proof is bound to, computed from its public data and header.

A miner can check its own work further, because it holds the matrices. `matrixCommitment` recomputes hash A and hash B exactly, and `jackpotHash` computes the tile's hash. When a pool and its miners disagree about hash A, the cause is almost always one of these:

- the padding, which is zero bytes up to a multiple of 1024;
- the key, which must be the job key of this header and configuration, not the previous one;
- B hashed without being transposed.

## pearl-gateway

pearl-gateway sits between pearld and the miners. It speaks JSON-RPC 2.0, one object per line, over a Unix socket or loopback TCP. `encodeGatewayRequest` writes a line and `decodeGatewayResponse` reads the answer:

```ts run
import { decodeGatewayResponse, encodeGatewayRequest, GATEWAY_ERROR_CODES } from 'pearljs/gateway';

process.stdout.write(encodeGatewayRequest({ id: 1, method: 'getMiningInfo' })); // {"jsonrpc": "2.0", "method": "getMiningInfo", "id": 1, "params": {}}
const reply = decodeGatewayResponse('{"jsonrpc": "2.0", "error": {"code": -32001, "message": "mining_paused: no block template available"}, "id": 1}\n', 'getMiningInfo');
console.log('error' in reply && reply.error.code === GATEWAY_ERROR_CODES.MINING_PAUSED); // true
```

`getMiningInfo` returns a job, which holds:

- the 76-byte header in base64;
- the target, as a JSON integer of up to 256 bits;
- the certificate version;
- from Pearl's fp8-scheme branch, the base64 headers of the four most recent ancestors.

A miner answers with `submitPlainProof`, which sends its plain proof in base64 together with the job it solves. The gateway answers `"submitted"` straight away and then proves and submits the block by itself. If the job's header is no longer current, the gateway drops the proof without telling the miner. To check a submitted plain proof as a pool checks a share, pass it to `verifyPlainProof` ([Verify a plain proof](../guides/verify-proof.md#verify-a-plain-proof)).

For a V4 job, `ancestorChain(job, ancestor)` gives the headers a certificate must carry for a proof keyed by `ancestor`, or null once that ancestor has left the job's window.

### Line format

pearljs writes lines byte for byte as the gateway's server and its miners' client write them, Python's spacing included. Targets are read as `bigint`, and a target written as a float with an integer value (`1e3`, `123.0`) is read as that integer, as the gateway's schema reads it.

An integer id beyond 2^53 - 1 is kept as a `bigint` and echoed exactly. pearljs refuses an id written as a float with `GATEWAY_MESSAGE_INVALID`, because it could not echo it as written, and refuses `params: null` and anything else the gateway treats as an invalid request in the same way.

## Effort and luck

A share's value is the chance that one attempt meets the block bound, divided by the chance it meets the share bound (`shareValue`). For the same configuration that equals the share target over the block target. A round's effort is the sum of its shares' values (`effort`), so an effort of 1 is one block's worth of work. Over a window of rounds, `luck(found, expected)` is the blocks found over the blocks expected, with the exact Poisson interval at the confidence asked for, 95% unless given:

```ts run
import { luck } from 'pearljs/mining';

const window = luck(10, 11.48);
console.log(window.luck.toFixed(3), window.low.toFixed(3), window.high.toFixed(3)); // 0.871 0.418 1.602
```

Count the effort of the round still open in `expected`, because a window that stops at a block otherwise reads as lucky. [examples/pool-luck.ts](../../examples/pool-luck.ts) walks a simulated chain, finds the pool's blocks by their coinbase, and prints each round's effort and the window's luck.
