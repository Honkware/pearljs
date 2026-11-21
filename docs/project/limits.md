# Known limits

- pearljs has not had an independent security audit. [Security model](../concepts/security.md) says what it checks and what it cannot protect.
- No real mining pool has been tried. The gateway protocol and the share checks were tested against Pearl's own pearl-gateway, run locally ([Mining and pearl-gateway](verification-live.md#mining-and-pearl-gateway)).
- The API may change while the version is 0.x. [Stability and versioning](stability.md) says which parts are settled and how a breaking change is recorded.
- FP8 and V4 certificates are checked against Pearl's fp8-scheme branch and its test networks only. That fork is not active on mainnet.
- Signing with a hardware device has not been tested with pearljs itself. External signers are tested with a second process that holds the key.
- On Windows the gateway test and the fp8-scheme node were not run. `npm run check`, the live suite and the browser tests pass there ([Node and packaging](stability.md#node-and-packaging)).

The tests also leave smaller gaps, listed under [Not covered](verification.md#not-covered).
