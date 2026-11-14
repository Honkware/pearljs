// Network parameters for Pearl, mirroring chaincfg/params.go in the Pearl
// source. Pearl has no signet in operation, so none is defined here. Values
// that Pearl does not use (pubKeyHash, scriptHash) are deliberately absent
// rather than filled with Bitcoin defaults.

export interface PearlNetwork {
  /** Lowercase canonical name, e.g. "mainnet". */
  name: string;
  /** P2P message magic, wire.PearlNet. */
  magic: number;
  /** Default peer-to-peer port. */
  defaultPort: number;
  /** Bech32m human-readable part for witness addresses. */
  bech32Hrp: string;
  /** First byte of a WIF private key. */
  wif: number;
  /** 4-byte version prefix of an HD private key, big-endian. */
  hdPrivateKeyId: number;
  /** 4-byte version prefix of an HD public key, big-endian. */
  hdPublicKeyId: number;
  /** BIP-44 coin type. */
  coinType: number;
  /** Genesis block hash as display-order hex (reversed from wire order). */
  genesisHash: string;
  /**
   * Header used by Pearl's signed-message format, from
   * messageSignatureHeader in rpcserver.go. Present only so callers can
   * build a bitcoinjs-compatible network object; Pearl does not vary it
   * per network.
   */
  messagePrefix: string;
}

const MESSAGE_PREFIX = 'Pearl Signed Message:\n';

export const mainnet: PearlNetwork = {
  name: 'mainnet',
  magic: 0x50524c4d, // "PRLM"
  defaultPort: 44108,
  bech32Hrp: 'prl',
  wif: 0x80,
  hdPrivateKeyId: 0x04b2430c, // zprv
  hdPublicKeyId: 0x04b24746, // zpub
  coinType: 808276,
  genesisHash:
    'a18d3093b7ff618f0cdd073fa3d10374e2e0105fe7ef53ff48b55f41c58dadd7',
  messagePrefix: MESSAGE_PREFIX,
};

export const testnet: PearlNetwork = {
  name: 'testnet',
  magic: 0x50524c31, // "PRL1"
  defaultPort: 44110,
  bech32Hrp: 'tprl',
  wif: 0xef,
  hdPrivateKeyId: 0x045f18bc, // vprv
  hdPublicKeyId: 0x045f1cf6, // vpub
  coinType: 1,
  genesisHash:
    '10f0be7be9950f74021d0f7c62989d1e2541c4d46f3c95b74e61679864b43d18',
  messagePrefix: MESSAGE_PREFIX,
};

// Testnet2 is a fresh chain that keeps the testnet address and HD params.
export const testnet2: PearlNetwork = {
  name: 'testnet2',
  magic: 0x50524c32, // "PRL2"
  defaultPort: 44112,
  bech32Hrp: 'tprl',
  wif: 0xef,
  hdPrivateKeyId: 0x045f18bc, // vprv
  hdPublicKeyId: 0x045f1cf6, // vpub
  coinType: 1,
  genesisHash:
    'b0c86d0cd8825f4d72260d2de46f470429eece413811d5d82b5f2e2ea0336f96',
  messagePrefix: MESSAGE_PREFIX,
};

export const regtest: PearlNetwork = {
  name: 'regtest',
  magic: 0x50524c52, // "PRLR"
  defaultPort: 18444,
  bech32Hrp: 'rprl',
  wif: 0xef,
  hdPrivateKeyId: 0x045f18bc, // vprv
  hdPublicKeyId: 0x045f1cf6, // vpub
  coinType: 1,
  genesisHash:
    '78d0ab27df6a51a8e9dbbdefffca1ebbbeb3818cb083ce2c2f43b047247e5832',
  messagePrefix: MESSAGE_PREFIX,
};

// Simnet shares the regtest genesis block but has its own magic, port,
// WIF byte and HD key IDs (sprv/spub).
export const simnet: PearlNetwork = {
  name: 'simnet',
  magic: 0x50524c53, // "PRLS"
  defaultPort: 18555,
  bech32Hrp: 'rprl',
  wif: 0x64,
  hdPrivateKeyId: 0x0420b900, // sprv
  hdPublicKeyId: 0x0420bd3a, // spub
  coinType: 1,
  genesisHash:
    '78d0ab27df6a51a8e9dbbdefffca1ebbbeb3818cb083ce2c2f43b047247e5832',
  messagePrefix: MESSAGE_PREFIX,
};

export const networks = {
  mainnet,
  testnet,
  testnet2,
  regtest,
  simnet,
} as const;

export type PearlNetworkName = keyof typeof networks;
