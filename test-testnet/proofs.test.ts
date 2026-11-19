// Blocks of the public testnet2 chain whose proofs pearld accepted, both while
// syncing and through zkpow.VerifyCertificate run alone, and that
// verify-proof does not accept. The blocks are kept in fixtures/, so this
// file needs no node. Until the verifier is fixed these tests fail.

import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { blockHashHex, parseBlock } from '../src/index.js';
import { verifyBlockProof } from '../src/verify-proof.js';

const block = (height: number) => parseBlock(Buffer.from(readFileSync(new URL(`fixtures/testnet2-${height}.hex`, import.meta.url), 'utf8').trim(), 'hex'));

it('accepts the V2 proof of testnet2 block 73396, which pearld accepts', async () => {
  const b = block(73396);
  expect(blockHashHex(b.header)).toBe('d7d46b48214f40721622179ae6d027b1036cb0ceffd40ac3f050b866d58589e5');
  expect(await verifyBlockProof(b)).toMatchObject({ valid: true, outcome: 'accepted' });
});

it('accepts the V3 proof of testnet2 block 101914, which pearld accepts', async () => {
  const b = block(101914);
  expect(blockHashHex(b.header)).toBe('d6035faee6a59387873672d86ef761270223e33db460b0e331d2dfe5704e5c50');
  expect(await verifyBlockProof(b)).toMatchObject({ valid: true, outcome: 'accepted' });
});

it('verifies the V3 proof of testnet2 block 94500 without overflowing the stack, and accepts it as pearld does', async () => {
  const b = block(94500);
  expect(blockHashHex(b.header)).toBe('ca31c4238f405dac32da0d75adb7b0e9c7a4ccb5678061ed7c76723c974ede44');
  expect(await verifyBlockProof(b)).toMatchObject({ valid: true, outcome: 'accepted' });
});
