// Two ways coins move without the wallet's own keystore signing: a key from
// outside the wallet, as a WIF, swept into it; and a payment the wallet
// prepares as a PSBT, signed by a separate process that checks it first, and
// submitted back.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { encodeWif, keyPathAddress, type PearlWallet } from '../src/index.js';
import { confirmed, describeTestnet, feeRate, fundsOrSkip, home, network, node, openWallet, record, walletDir } from './env.js';

const VALUE = 200_000n;
let wallet: PearlWallet;
let skip: string | null = null;
let rate = 0n;

/** Runs scripts/testnet/external-signer.mjs on one request and returns what it writes. */
function externalSigner(request: unknown): Promise<{ hex: string; sent: string; change: string; fee: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../scripts/testnet/external-signer.mjs', import.meta.url))], {
      env: { ...process.env, PEARL_SIGNER_SECRETS: join(walletDir, 'secrets.json') },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()));
    child.on('close', (code) => (code === 0 ? resolve(JSON.parse(out) as Awaited<ReturnType<typeof externalSigner>>) : reject(new Error(`signer exited ${code}: ${err}`))));
    child.stdin.end(JSON.stringify(request));
  });
}

describeTestnet('sweeping a WIF key and signing a PSBT in another process', () => {
  beforeAll(async () => {
    wallet = await openWallet();
    skip = await fundsOrSkip(wallet, 3n * VALUE);
    rate = await feeRate();
  });
  afterAll(async () => {
    await wallet?.close();
  });

  it('sweeps everything a WIF key holds into the wallet', async (context) => {
    if (skip !== null) context.skip(skip);
    const key = Uint8Array.from(randomBytes(32));
    const wif = encodeWif(key, network);
    const source = keyPathAddress(key, network);
    const funding = await wallet.send({ recipients: [{ address: source, amount: VALUE }], feeRate: rate, label: 'sweep: fund the key' });
    record('f sweep', 'fund the outside key', funding.txid);
    await confirmed(funding.txid);

    const swept = await wallet.sweep({ wif, feeRate: rate, label: 'sweep' });
    record('f sweep', 'sweep the WIF key', swept.txid, { fee: String(swept.fee) });
    expect(swept.inputs).toEqual([{ txid: funding.txid, vout: expect.any(Number) as number, value: VALUE }]);
    await confirmed(swept.txid);
    expect(await node.getTxOut(funding.txid, swept.inputs[0]!.vout)).toBeNull();
    await wallet.sync();
    const entry = wallet.transaction(swept.txid)!;
    expect(entry).toMatchObject({ status: 'confirmed', direction: 'incoming', received: VALUE - swept.fee, fee: swept.fee });
  });

  it('prepares a payment, has another process check and sign the PSBT, and submits what it signed', async (context) => {
    if (skip !== null) context.skip(skip);
    const recipients = [{ address: home(), amount: VALUE }];
    const nextChangeIndex = wallet.accounts().find((entry) => entry.id === '0')!.nextChangeIndex;
    const prepared = await wallet.prepareSend({ recipients, feeRate: rate, label: 'psbt: external signer' });
    const signed = await externalSigner({
      network: network.name,
      psbt: prepared.psbt,
      recipients: recipients.map(({ address, amount }) => ({ address, amount: String(amount) })),
      maxFee: String(prepared.fee),
      nextChangeIndex,
    });
    expect(signed).toMatchObject({ sent: String(VALUE), change: String(prepared.change), fee: String(prepared.fee) });
    const sent = await wallet.submitSigned(signed.hex);
    record('f psbt', 'PSBT signed in another process', sent.txid, { fee: String(sent.fee) });
    expect(sent.txid).toBe(prepared.txid);
    expect(wallet.preparedSends()).toEqual([]);
    await confirmed(sent.txid);
    await wallet.sync();
    expect(wallet.transaction(sent.txid)!.status).toBe('confirmed');
  });
});
