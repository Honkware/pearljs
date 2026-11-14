import { describe, expect, it } from 'vitest';
import {
  mainnet,
  networks,
  regtest,
  simnet,
  testnet,
  testnet2,
} from '../src/networks.js';

// Expected values from chaincfg/params.go and wire/protocol.go in the
// Pearl source.

describe('networks', () => {
  it('mainnet matches chaincfg MainNetParams', () => {
    expect(mainnet).toMatchObject({
      name: 'mainnet',
      magic: 0x50524c4d,
      defaultPort: 44108,
      bech32Hrp: 'prl',
      wif: 0x80,
      hdPrivateKeyId: 0x04b2430c,
      hdPublicKeyId: 0x04b24746,
      coinType: 808276,
      genesisHash:
        'a18d3093b7ff618f0cdd073fa3d10374e2e0105fe7ef53ff48b55f41c58dadd7',
      messagePrefix: 'Pearl Signed Message:\n',
    });
  });

  it('testnet matches chaincfg TestNetParams', () => {
    expect(testnet).toMatchObject({
      name: 'testnet',
      magic: 0x50524c31,
      defaultPort: 44110,
      bech32Hrp: 'tprl',
      wif: 0xef,
      hdPrivateKeyId: 0x045f18bc,
      hdPublicKeyId: 0x045f1cf6,
      coinType: 1,
      genesisHash:
        '10f0be7be9950f74021d0f7c62989d1e2541c4d46f3c95b74e61679864b43d18',
      messagePrefix: 'Pearl Signed Message:\n',
    });
  });

  it('testnet2 keeps testnet address params with its own magic and genesis', () => {
    expect(testnet2).toMatchObject({
      name: 'testnet2',
      magic: 0x50524c32,
      defaultPort: 44112,
      bech32Hrp: 'tprl',
      wif: 0xef,
      hdPrivateKeyId: 0x045f18bc,
      hdPublicKeyId: 0x045f1cf6,
      coinType: 1,
      genesisHash:
        'b0c86d0cd8825f4d72260d2de46f470429eece413811d5d82b5f2e2ea0336f96',
      messagePrefix: 'Pearl Signed Message:\n',
    });
  });

  it('regtest matches chaincfg RegressionNetParams', () => {
    expect(regtest).toMatchObject({
      name: 'regtest',
      magic: 0x50524c52,
      defaultPort: 18444,
      bech32Hrp: 'rprl',
      wif: 0xef,
      hdPrivateKeyId: 0x045f18bc,
      hdPublicKeyId: 0x045f1cf6,
      coinType: 1,
      genesisHash:
        '78d0ab27df6a51a8e9dbbdefffca1ebbbeb3818cb083ce2c2f43b047247e5832',
      messagePrefix: 'Pearl Signed Message:\n',
    });
  });

  it('simnet matches chaincfg SimNetParams and shares the regtest genesis', () => {
    expect(simnet).toMatchObject({
      name: 'simnet',
      magic: 0x50524c53,
      defaultPort: 18555,
      bech32Hrp: 'rprl',
      wif: 0x64,
      hdPrivateKeyId: 0x0420b900,
      hdPublicKeyId: 0x0420bd3a,
      coinType: 1,
      genesisHash: regtest.genesisHash,
      messagePrefix: 'Pearl Signed Message:\n',
    });
  });

  it('exposes exactly the five networks by name, with no signet', () => {
    expect(Object.keys(networks).sort()).toEqual([
      'mainnet',
      'regtest',
      'simnet',
      'testnet',
      'testnet2',
    ]);
    expect(networks.mainnet).toBe(mainnet);
    expect(networks.testnet).toBe(testnet);
    expect(networks.testnet2).toBe(testnet2);
    expect(networks.regtest).toBe(regtest);
    expect(networks.simnet).toBe(simnet);
  });

  it('has a unique magic per network', () => {
    const magics = Object.values(networks).map((n) => n.magic);
    expect(new Set(magics).size).toBe(magics.length);
  });

  it('does not invent legacy address version bytes', () => {
    for (const n of Object.values(networks)) {
      expect(n).not.toHaveProperty('pubKeyHash');
      expect(n).not.toHaveProperty('scriptHash');
    }
  });
});
